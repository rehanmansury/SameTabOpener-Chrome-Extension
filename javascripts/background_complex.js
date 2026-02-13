// SameTabOpener V1.2 Background Service Worker
// Combines V1.0 Zendesk routing/search + domain grouping + per-domain auto-refresh + close protection settings plumbing
// Plus debug logging functionality

// IMMEDIATE TEST - This should show up in console
console.error('!!! BACKGROUND SCRIPT IS RUNNING !!!');
console.trace('Background script stack trace');

// Simple debug logger implementation (inline for now)
const debugLogger = {
  logs: [],
  maxLogs: 500,
  debugEnabled: true,
  
  log(...args) {
    if (!this.debugEnabled) return;
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    this.logs.push({ timestamp, message, level: 'log' });
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    console.log(`[${timestamp}] ${message}`);
  },
  
  error(...args) {
    const timestamp = new Date().toISOString();
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg, null, 2) : String(arg)
    ).join(' ');
    this.logs.push({ timestamp, message, level: 'error' });
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    console.error(`[${timestamp}] ${message}`);
  },
  
  getLogs() {
    return this.logs;
  },
  
  clear() {
    this.logs = [];
  },
  
  setDebugEnabled(enabled) {
    this.debugEnabled = enabled;
  },
  
  isDebugEnabled() {
    return this.debugEnabled;
  }
};

// Log extension configuration on startup
(async () => {
  try {
    const settings = await chrome.storage.sync.get({ 
      highlightEnabled: true, 
      refreshRules: [], 
      protectDomains: [] 
    });
    
    debugLogger.log('=== EXTENSION CONFIGURATION (Startup) ===');
    debugLogger.log(`Highlight Enabled: ${settings.highlightEnabled}`);
    debugLogger.log(`Protected Domains (${settings.protectDomains?.length || 0}):`, settings.protectDomains);
    debugLogger.log(`Refresh Rules (${settings.refreshRules?.length || 0}):`, settings.refreshRules);
    debugLogger.log('========================================');
  } catch (e) {
    debugLogger.error('Failed to load configuration on startup:', e);
  }
})();

// Also log to console for verification
console.log('DEBUG: Background script is running!');

// Test periodic logging to verify the script is active (commented out to reduce noise)
// setInterval(() => {
//   debugLogger.log('Background heartbeat: ' + new Date().toISOString());
// }, 5000);

// ========================
// Zendesk routing/search (from V1.0)
// ========================
const LOTUS_ROUTE = /^https?:\/\/(.*)\.zendesk\.com\/agent\/(?!chat|voice)\#?\/?(.*)$/;
const TICKET_ROUTE = /^https?:\/\/(.*)\.zendesk\.com\/(?:agent\/)?(tickets|twickets|requests|hc\/requests)\/?(\d+)(?:\/|\?|#|$)/;
const HASH_TICKET_ROUTE = /^https?:\/\/(.*)\.zendesk\.com\/agent\/#\/(tickets|twickets|requests|hc\/requests)\/(\d+)/;
const RESTRICTED_ROUTE = /^https?:\/\/(.*)\.zendesk\.com\/(agent\/(chat|talk|admin\/voice)\/?(.*)|tickets\/\d*\/print)/;

function isRestrictedZendeskUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (!/\.zendesk\.com$/i.test(u.hostname)) return false;
    const p = (u.pathname || '').toLowerCase();
    const h = (u.hash || '').toLowerCase();
    if (p.includes('/agent/chat') || p.includes('/agent/talk') || p.includes('/agent/voice') || p.includes('/agent/admin/voice')) return true;
    if (h.includes('/agent/chat') || h.includes('/agent/talk') || h.includes('/agent/voice') || h.includes('/agent/admin/voice')) return true;
    if (/\/tickets\/\d+\/print/i.test(u.pathname)) return true;
    return false;
  } catch {
    return RESTRICTED_ROUTE.test(rawUrl);
  }
}

function extractZendeskSubdomain(rawUrl) {
  try {
    const u = new URL(rawUrl);
    const host = (u.hostname || '').toLowerCase();
    if (!host.endsWith('.zendesk.com')) return null;
    const parts = host.split('.');
    return parts.length >= 3 ? parts[0] : null;
  } catch {
    return null;
  }
}

// Track new tabs to know which ones we can close as duplicates
const recentNewTabs = new Map(); // tabId -> timestamp
const NEW_TAB_WINDOW_MS = 8000;

function markTabNew(tabId) { recentNewTabs.set(tabId, Date.now()); }
function isTabRecentlyNew(tabId) {
  const ts = recentNewTabs.get(tabId);
  if (!ts) return false;
  if (Date.now() - ts <= NEW_TAB_WINDOW_MS) return true;
  recentNewTabs.delete(tabId);
  return false;
}

chrome.webNavigation.onCreatedNavigationTarget.addListener((d)=>{ if (d.tabId) markTabNew(d.tabId); });
chrome.tabs.onCreated.addListener((tab)=>{ if (tab && typeof tab.id === 'number') markTabNew(tab.id); });
// Monitor tab responsiveness
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    debugLogger.log(`Tab ${tabId} completed loading: ${tab.url}`);
  }
  
  // Check for unresponsive tabs
  if (changeInfo.status) {
    debugLogger.log(`Tab ${tabId} status update:`, {
      status: changeInfo.status,
      url: tab.url,
      title: tab.title,
      discarded: tab.discarded,
      autoDiscardable: tab.autoDiscardable
    });
  }
});

// Track tab removal for debugging
chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  debugLogger.log(`Tab removed: ${tabId}`, removeInfo);
  recentNewTabs.delete(tabId);
});

const storage = {
  async get(key) { const r = await chrome.storage.sync.get(key); return r[key]; },
  async set(key, val) { await chrome.storage.sync.set({ [key]: val }); },
  async sanitize() { if (!(await this.get('urlDetection'))) await this.set('urlDetection','ticketUrls'); }
};

function extractMatches(url, urlDetection) {
  if (isRestrictedZendeskUrl(url)) return null;

  // Check if this is a Zendesk ticket URL (regular format)
  const ticketMatch = url.match(TICKET_ROUTE);
  debugLogger.log(`Ticket match for ${url}:`, ticketMatch);
  if (ticketMatch) {
    const subdomain = ticketMatch[1];
    const ticketType = ticketMatch[2];
    const ticketNumber = ticketMatch[3];
    return { subdomain, path: `${ticketType}/${ticketNumber}` };
  }

  // Check if this is a Zendesk ticket URL (hash format)
  const hashTicketMatch = url.match(HASH_TICKET_ROUTE);
  debugLogger.log(`Hash ticket match for ${url}:`, hashTicketMatch);
  if (hashTicketMatch) {
    const subdomain = hashTicketMatch[1];
    const ticketType = hashTicketMatch[2];
    const ticketNumber = hashTicketMatch[3];
    return { subdomain, path: `${ticketType}/${ticketNumber}` };
  }

  debugLogger.log(`Not a ticket URL, ignoring`);
  return null;
}
function extractTicketNumberFromPath(path) { if (!path) return null; const m = path.match(/(\d{3,})/); return m? m[1]: null; }
async function tabExists(tabId){ try{ await chrome.tabs.get(tabId); return true;}catch{return false;} }

async function tryNavigateZendeskTicketInTab(tabId, ticketNumber) {
  debugLogger.log(`Attempting search injection for ticket ${ticketNumber} in tab ${tabId}`);
  
  // Only use Zendesk search injection method
  if (chrome.scripting?.executeScript) {
    try {
      debugLogger.log(`Executing script to find search input...`);
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: (ticket) => {
          // Block any beforeunload that might be triggered
          const blockBeforeUnload = () => {
            console.log('Setting up aggressive beforeunload blocking');
            
            // Override the event dispatcher
            const originalDispatchEvent = EventTarget.prototype.dispatchEvent;
            EventTarget.prototype.dispatchEvent = function(event) {
              if (event.type === 'beforeunload') {
                console.log('Blocked beforeunload event dispatch');
                event.preventDefault();
                event.stopImmediatePropagation();
                return false;
              }
              return originalDispatchEvent.call(this, event);
            };
            
            // Block at window level
            window.addEventListener('beforeunload', (e) => {
              console.log('Blocked beforeunload at window level');
              e.preventDefault();
              e.stopImmediatePropagation();
              e.returnValue = '';
              return false;
            }, true);
            
            // Override confirm for leave site messages
            const originalConfirm = window.confirm;
            window.confirm = function(message) {
              if (message && (message.toLowerCase().includes('leave') || message.toLowerCase().includes('changes'))) {
                console.log('Blocked confirmation:', message);
                return true;
              }
              return originalConfirm.call(this, message);
            };
            
            // Also override the prompt function
            const originalPrompt = window.prompt;
            window.prompt = function(message, defaultValue) {
              if (message && (message.toLowerCase().includes('leave') || message.toLowerCase().includes('changes'))) {
                console.log('Blocked prompt:', message);
                return defaultValue || '';
              }
              return originalPrompt.call(this, message, defaultValue);
            };
          };
          
          // Block beforeunload immediately
          blockBeforeUnload();
          
          // The specific selector for Zendesk search input
          const searchInput = document.querySelector('input[data-test-id="search-dialog-field-input"]');
          
          if (searchInput) {
            console.log('Found Zendesk search input');
            
            // Focus the input
            searchInput.focus();
            
            // Clear any existing value
            searchInput.value = '';
            
            // Type the ticket number
            searchInput.value = ticket;
            
            // Dispatch events to ensure Zendesk recognizes the input
            searchInput.dispatchEvent(new Event('input', { bubbles: true }));
            searchInput.dispatchEvent(new Event('change', { bubbles: true }));
            
            // Block beforeunload again before navigating
            blockBeforeUnload();
            
            // Override window.location to block beforeunload during navigation
            const originalAssign = window.location.assign;
            const originalReplace = window.location.replace;
            const originalHref = window.location.href;
            
            const safeNavigate = (url) => {
              console.log('Navigating to:', url);
              blockBeforeUnload();
              return originalAssign.call(window.location, url);
            };
            
            window.location.assign = safeNavigate;
            window.location.replace = safeNavigate;
            
            // Try pressing Enter
            searchInput.dispatchEvent(new KeyboardEvent('keydown', { 
              key: 'Enter', 
              code: 'Enter', 
              which: 13, 
              keyCode: 13, 
              bubbles: true 
            }));
            searchInput.dispatchEvent(new KeyboardEvent('keyup', { 
              key: 'Enter', 
              code: 'Enter', 
              which: 13, 
              keyCode: 13, 
              bubbles: true 
            }));
            
            console.log('Search completed successfully');
            return true;
          } else {
            console.log('Search input not found, trying to open search dialog first');
            
            // Try to open search dialog with keyboard shortcuts
            document.dispatchEvent(new KeyboardEvent('keydown', { 
              key: '/', 
              code: 'Slash', 
              ctrlKey: false, 
              metaKey: false, 
              bubbles: true 
            }));
            
            // Wait and try again
            setTimeout(() => {
              const searchInputAfter = document.querySelector('input[data-test-id="search-dialog-field-input"]');
              if (searchInputAfter) {
                console.log('Found search input after opening dialog');
                blockBeforeUnload(); // Block beforeunload again
                searchInputAfter.focus();
                searchInputAfter.value = ticket;
                searchInputAfter.dispatchEvent(new Event('input', { bubbles: true }));
                searchInputAfter.dispatchEvent(new KeyboardEvent('keydown', { 
                  key: 'Enter', 
                  code: 'Enter', 
                  which: 13, 
                  keyCode: 13, 
                  bubbles: true 
                }));
              } else {
                // Fallback to direct navigation
                console.log('Still no search input, using direct navigation');
                blockBeforeUnload(); // Block beforeunload before direct navigation
                const currentUrl = window.location.href;
                const subdomain = window.location.hostname.split('.')[0];
                const ticketUrl = `https://${subdomain}.zendesk.com/agent/tickets/${ticket}`;
                if (currentUrl !== ticketUrl) {
                  // Use replace instead of href to avoid beforeunload
                  window.location.replace(ticketUrl);
                }
              }
            }, 500);
            
            return true;
          }
        },
        args: [ticketNumber]
      });
      const ok = Array.isArray(results) ? !!results[0]?.result : false;
      debugLogger.log(`Search injection result: ${ok}`);
      if (ok) return true;
    } catch (e) {
      debugLogger.error(`Search injection failed:`, e);
    }
  } else {
    debugLogger.error(`chrome.scripting not available`);
  }
  return false;
}

async function tryDisableBeforeUnload(tabId) {
  debugLogger.log(`Attempting to disable beforeunload for tab ${tabId}`);
  
  if (!chrome.scripting?.executeScript) {
    debugLogger.error(`chrome.scripting not available for tab ${tabId}`);
    return;
  }
  
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        console.log('=== DISABLING BEFOREUNLOAD PROMPTS (SameTabOpener Extension) ===');
        
        // Add visual indicator that our extension is active
        if (!document.getElementById('sametabopener-indicator')) {
          const indicator = document.createElement('div');
          indicator.id = 'sametabopener-indicator';
          indicator.style.cssText = `
            position: fixed;
            top: 10px;
            right: 10px;
            background: #4CAF50;
            color: white;
            padding: 5px 10px;
            border-radius: 4px;
            font-size: 12px;
            font-family: Arial, sans-serif;
            z-index: 999999;
            box-shadow: 0 2px 4px rgba(0,0,0,0.2);
          `;
          indicator.textContent = 'SameTabOpener Active';
          document.body.appendChild(indicator);
          
          // Remove after 3 seconds
          setTimeout(() => {
            if (indicator.parentNode) {
              indicator.parentNode.removeChild(indicator);
            }
          }, 3000);
        }
        
        // Track if we've already handled this
        if (window._sameTabOpenerBeforeUnloadDisabled) {
          console.log('Beforeunload already disabled for this page');
          return true;
        }
        window._sameTabOpenerBeforeUnloadDisabled = true;
        
        let blockedCount = 0;
        
        // Method 1: Clear direct handlers
        if (window.onbeforeunload) {
          console.log('Clearing window.onbeforeunload');
          window.onbeforeunload = null;
          blockedCount++;
        }
        if (window.onunload) {
          console.log('Clearing window.onunload');
          window.onunload = null;
          blockedCount++;
        }
        
        // Method 2: Override the event property setters
        let beforeUnloadHandler = null;
        Object.defineProperty(window, 'onbeforeunload', {
          get: () => null,
          set: (value) => {
            console.log('Blocked attempt to set onbeforeunload:', value);
            blockedCount++;
            return null;
          }
        });
        
        // Method 3: Block event listeners
        const originalAddEventListener = EventTarget.prototype.addEventListener;
        EventTarget.prototype.addEventListener = function(type, listener, options) {
          if (type === 'beforeunload' || type === 'unload') {
            console.log(`Blocked ${type} event listener`);
            blockedCount++;
            return;
          }
          return originalAddEventListener.call(this, type, listener, options);
        };
        
        // Method 4: Add capturing handlers that prevent the default
        const blockEvent = (e) => {
          if (e.type === 'beforeunload' || e.type === 'unload') {
            console.log(`Blocking ${e.type} event`);
            e.stopImmediatePropagation();
            e.stopPropagation();
            e.preventDefault();
            e.returnValue = '';
            delete e.returnValue;
            blockedCount++;
            return false;
          }
        };
        
        window.addEventListener('beforeunload', blockEvent, true);
        window.addEventListener('unload', blockEvent, true);
        
        // Method 5: Try to remove existing listeners (Chrome DevTools method)
        try {
          const listeners = window.getEventListeners?.(window);
          if (listeners) {
            ['beforeunload', 'unload'].forEach(eventType => {
              if (listeners[eventType]) {
                listeners[eventType].forEach(listener => {
                  console.log(`Removing existing ${eventType} listener`);
                  window.removeEventListener(eventType, listener.listener);
                  blockedCount++;
                });
              }
            });
          }
        } catch (e) {
          console.log('Could not access event listeners:', e);
        }
        
        // Method 6: Override confirm/alert if they're used
        const originalConfirm = window.confirm;
        window.confirm = function(message) {
          console.log('Confirm dialog called with message:', message);
          
          // Create custom styled dialog for our extension vs Zendesk
          if (message && message.toLowerCase().includes('leave')) {
            console.log('Blocked leave site confirmation:', message);
            
            // Show our custom notification
            const notification = document.createElement('div');
            notification.style.cssText = `
              position: fixed;
              top: 50px;
              right: 10px;
              background: #2196F3;
              color: white;
              padding: 10px 15px;
              border-radius: 4px;
              font-size: 14px;
              font-family: Arial, sans-serif;
              z-index: 999999;
              box-shadow: 0 2px 8px rgba(0,0,0,0.3);
              max-width: 300px;
            `;
            notification.innerHTML = `
              <div style="font-weight: bold; margin-bottom: 5px;">SameTabOpener</div>
              <div>Blocked navigation prompt</div>
            `;
            document.body.appendChild(notification);
            
            setTimeout(() => {
              if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
              }
            }, 2000);
            
            blockedCount++;
            return true;
          }
          return originalConfirm.call(this, message);
        };
        
        // Method 7: Override alert
        const originalAlert = window.alert;
        window.alert = function(message) {
          console.log('Alert called with message:', message);
          
          if (message && (message.toLowerCase().includes('leave') || message.toLowerCase().includes('changes'))) {
            console.log('Blocked alert:', message);
            blockedCount++;
            return;
          }
          return originalAlert.call(this, message);
        };
        
        // Method 8: Block any remaining modal dialogs
        const observer = new MutationObserver((mutations) => {
          mutations.forEach((mutation) => {
            mutation.addedNodes.forEach((node) => {
              if (node.nodeType === Node.ELEMENT_NODE) {
                // Check for common dialog patterns
                if (node.tagName === 'DIALOG' || 
                    node.getAttribute('role') === 'dialog' ||
                    node.classList?.contains('modal') ||
                    node.classList?.contains('popup')) {
                  
                  const text = node.textContent || '';
                  if (text.toLowerCase().includes('leave') || 
                      text.toLowerCase().includes('changes') ||
                      text.toLowerCase().includes('saved')) {
                    
                    console.log('Found and blocked modal dialog:', node);
                    
                    // Show our notification instead
                    const notification = document.createElement('div');
                    notification.style.cssText = `
                      position: fixed;
                      top: 90px;
                      right: 10px;
                      background: #FF9800;
                      color: white;
                      padding: 10px 15px;
                      border-radius: 4px;
                      font-size: 14px;
                      font-family: Arial, sans-serif;
                      z-index: 999999;
                      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
                      max-width: 300px;
                    `;
                    notification.innerHTML = `
                      <div style="font-weight: bold; margin-bottom: 5px;">SameTabOpener</div>
                      <div>Blocked modal dialog</div>
                    `;
                    document.body.appendChild(notification);
                    
                    setTimeout(() => {
                      if (notification.parentNode) {
                        notification.parentNode.removeChild(notification);
                      }
                    }, 2000);
                    
                    // Remove the dialog
                    node.remove();
                  }
                }
              }
            });
          });
        });
        
        observer.observe(document.body, {
          childList: true,
          subtree: true
        });
        
        console.log(`=== Beforeunload blocking complete. Blocked ${blockedCount} handlers ===`);
        return blockedCount > 0;
      }
    });
    
    const success = results?.[0]?.result;
    debugLogger.log(`Beforeunload disable result for tab ${tabId}:`, success);
    
  } catch (e) {
    debugLogger.error(`Failed to disable beforeunload for tab ${tabId}:`, e);
  }
}

async function openTicketViaSearch({ id: newTabId, subdomain, ticketNumber, isNew }) {
  debugLogger.log(`openTicketViaSearch: newTabId=${newTabId}, subdomain=${subdomain}, ticketNumber=${ticketNumber}, isNew=${isNew}`);
  
  try {
    // Find existing Zendesk tabs
    let tabs;
    try { 
      const query = { 
        url: [
          `*://${subdomain}.zendesk.com/agent*`,
      };
      tabs = await chrome.tabs.query(query);
    } catch (e) {
      debugLogger.error('Failed to query tabs:', e);
      return;
    }
    
    debugLogger.log(`Found ${tabs.length} total Zendesk tabs`);
    
    if (!tabs.length) {
      debugLogger.log('No existing Zendesk tabs found');
      return;
    }
    
    // Filter tabs for the specific subdomain
    const subdomainTabs = tabs.filter(t => {
      const url = new URL(t.url || '');
      const hostname = url.hostname || '';
      return hostname.includes(`${subdomain}.zendesk.com`) || hostname.includes('zendesk.com');
    });
    
    debugLogger.log(`Found ${subdomainTabs.length} tabs for subdomain ${subdomain}`);
    
    // Filter out the new tab we just opened
    const existingTabs = subdomainTabs.filter(t => t.id !== newTabId);
    debugLogger.log(`Found ${existingTabs.length} existing tabs after filtering`);
    
    if (!existingTabs.length) {
      debugLogger.log('No suitable existing tab found');
      return;
    }
    
    // Find the most recently accessed tab
    const target = existingTabs.reduce((a, b) => (a.lastAccessed || 0) > (b.lastAccessed || 0) ? a : b);
    debugLogger.log(`Target tab: id=${target.id}, url=${target.url}, window=${target.windowId}`);
    
    if (!(await tabExists(target.id))) {
      debugLogger.log(`Target tab ${target.id} no longer exists`);
      return;
    }

    // Simple approach: Just update the URL directly
    try { 
      debugLogger.log(`Updating tab ${target.id} to ticket ${ticketNumber}`);
      
      // Build the ticket URL
      const ticketUrl = `https://${subdomain}.zendesk.com/agent/tickets/${ticketNumber}`;
      
      // Update the tab URL directly
      await chrome.tabs.update(target.id, { 
        url: ticketUrl,
        active: false // Don't activate yet to avoid focus issues
      });
      
      // Wait a moment for the update to start
      await sleep(100);
      
      // Now focus the tab and window
      await chrome.windows.update(target.windowId, { focused: true });
      await chrome.tabs.update(target.id, { active: true });
      
      debugLogger.log(`Successfully updated and focused tab ${target.id}`);
      
      // Close the new tab after a short delay
      if (isNew) {
        setTimeout(async () => {
          try {
            if (await tabExists(newTabId)) {
              await chrome.tabs.remove(newTabId);
              debugLogger.log(`Closed duplicate tab ${newTabId}`);
            }
          } catch (e) {
            debugLogger.error('Failed to close duplicate tab:', e);
      debugLogger.error('openTicketViaSearch error:', e);
    } else {
      debugLogger.log(`Tab was closed during operation:`, errorMsg);
    }
  }
}

async function handleNavigation(details) {
  try {
    debugLogger.log(`handleNavigation:`, {
      url: details.url,
      tabId: details.tabId,
      frameId: details.frameId,
      transitionType: details.transitionType
    });
    
    if (details.frameId !== 0) {
      debugLogger.log(`Ignoring non-main frame navigation`);
      return; // Only process main frame navigations
    }
    const urlDetection = await storage.get('urlDetection');
    debugLogger.log(`URL detection mode: ${urlDetection}`);
    if (urlDetection === 'noUrls') {
      debugLogger.log(`URL detection disabled`);
      return;
    }
    const matches = extractMatches(details.url, urlDetection);
    debugLogger.log(`Extracted matches:`, matches);
    if (!matches) {
      debugLogger.log(`No matches found for URL`);
      return;
    }
    const isNew = isTabRecentlyNew(details.tabId);
    debugLogger.log(`Tab is ${isNew ? 'new' : 'existing'}`);
    const ticketNumber = extractTicketNumberFromPath(matches.path);
    debugLogger.log(`Extracted ticket number: ${ticketNumber}`);
    
    // Only reroute tickets for newly created navigation target tabs.
    // Otherwise SPA hash navigation inside the existing Zendesk tab can retrigger this handler and accidentally close the working tab.
    if (ticketNumber) {
      if (!isNew) {
        debugLogger.log(`Not a new tab, skipping ticket routing`);
        return;
      }
      debugLogger.log(`Attempting to open ticket ${ticketNumber} in existing tab`);
      await openTicketViaSearch({ id:details.tabId, subdomain:matches.subdomain, ticketNumber, isNew });
      return;
    }
    if (isNew) {
    // legacy path
    const { subdomain, path } = matches;
    let tabs;
    try { 
      tabs = await chrome.tabs.query({ url:[`*://${subdomain}.zendesk.com/agent/*`] });
      debugLogger.log(`Found ${tabs.length} tabs for subdomain ${subdomain}`);
    } catch (e) { 
      debugLogger.log(`Error querying tabs:`, e);
      const all = await chrome.tabs.query({}); 
      tabs = all.filter(t => t.url && new RegExp(`^https?://${subdomain}\.zendesk\.com/agent/`).test(t.url));
      debugLogger.log(`Found ${tabs.length} tabs using fallback method`);
    }
    
    for (const tab of tabs) {
      if (tab.id !== details.tabId && tab.url && LOTUS_ROUTE.test(tab.url)) {
        debugLogger.log(`Found matching tab ${tab.id} for legacy path, updating...`);
        try { 
          await chrome.tabs.update(tab.id, { active:true });
          await sleep(150);
          await updateLotusRoute(tab.id, path);
          await sleep(300);
          debugLogger.log(`Removing duplicate tab ${details.tabId}`);
          await chrome.tabs.remove(details.tabId);
        } catch (e) {
      debugLogger.error(`Error updating/removing tab:`, e);
        }
        break;
      }
    }
    }
  } catch (e) {
    debugLogger.error('handleNavigation error:', e);
  }
}

chrome.runtime.onInstalled.addListener(async (d) => { 
  debugLogger.log('Extension installed/updated:', { reason: d.reason });
  
  // Try to migrate settings from V1.1 if this is a fresh install
  if (d.reason === 'install') {
    try {
      // Check if we have any settings (might be a fresh install)
      const existing = await chrome.storage.sync.get(null);
      const hasSettings = Object.keys(existing).length > 0;
      
      if (!hasSettings) {
        debugLogger.log('No existing settings found, checking for V1.1 settings...');
        
        // Try common V1.1 storage keys
        const v11Keys = ['highlightEnabled', 'refreshRules', 'protectDomains', 'urlDetection'];
        const v11Settings = {};
        
        for (const key of v11Keys) {
          const value = await chrome.storage.sync.get(key);
          if (value[key] !== undefined) {
            v11Settings[key] = value[key];
          }
        }
        
        if (Object.keys(v11Settings).length > 0) {
          debugLogger.log('Found V1.1 settings, migrating:', v11Settings);
          await chrome.storage.sync.set(v11Settings);
          debugLogger.log('Settings migrated successfully');
        } else {
          debugLogger.log('No V1.1 settings found');
        }
      }
    } catch (e) {
      debugLogger.error('Error during settings migration:', e);
    }
  }
  
  try {
    await storage.sanitize(); 
    debugLogger.log('Storage sanitized successfully');
  } catch (e) {
    debugLogger.error('Error in onInstalled:', e);
  }
});
chrome.webNavigation.onCompleted.addListener(handleNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(handleNavigation);

// Tab event listeners for debugging
chrome.tabs.onCreated.addListener(tab => {
  debugLogger.log('Tab created:', { id: tab.id, url: tab.url, windowId: tab.windowId });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete') {
    debugLogger.log('Tab updated:', { id: tabId, url: tab.url, status: 'complete' });
  }
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  debugLogger.log('Tab removed:', { id: tabId, windowId: removeInfo.windowId });
});

chrome.tabs.onActivated.addListener(activeInfo => {
  debugLogger.log('Tab activated:', { tabId: activeInfo.tabId, windowId: activeInfo.windowId });
});

// ========================
// Highlight duplicates by origin+pathname using action badge (no tab groups)
// ========================
const GROUP_COLORS = ['#9e9e9e','#42a5f5','#ef5350','#ffca28','#66bb6a','#ec407a','#ab47bc','#26c6da','#ff7043'];
function colorForKey(key){ let h=0; for (let i=0;i<key.length;i++) h=(h*31+key.charCodeAt(i))>>>0; return GROUP_COLORS[h%GROUP_COLORS.length]; }
function hostnameOf(url){ try{ return new URL(url).hostname; }catch{return null;} }
function keyForDup(url){
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`.replace(/\/$/, ''); // origin+path, trim trailing slash
  } catch { return null; }
}

async function highlightDuplicatesByBadge(){
  const { highlightEnabled=true } = await chrome.storage.sync.get({ highlightEnabled:true });
  const tabs = await chrome.tabs.query({});
  const buckets = new Map(); // key -> [tab]
  for (const t of tabs){ const key = t.url && keyForDup(t.url); if (!key) continue; if (!buckets.has(key)) buckets.set(key,[]); buckets.get(key).push(t); }

  for (const t of tabs){
    const key = t.url && keyForDup(t.url);
    const list = key ? buckets.get(key) : null;
    if (key && list && list.length > 1){
      const color = colorForKey(key);
      try { await chrome.action.setBadgeBackgroundColor({ tabId: t.id, color }); } catch {}
      try { await chrome.action.setBadgeText({ tabId: t.id, text: String(list.length) }); } catch {}
    } else {
      try { await chrome.action.setBadgeText({ tabId: t.id, text: '' }); } catch {}
    }
  }
}

let badgeTimer=null; function scheduleBadges(){ if (badgeTimer) clearTimeout(badgeTimer); badgeTimer=setTimeout(highlightDuplicatesByBadge, 300); }
chrome.tabs.onCreated.addListener(scheduleBadges);
chrome.tabs.onUpdated.addListener((id,info)=>{ if (info.status==='complete'||info.url) scheduleBadges(); });
chrome.tabs.onRemoved.addListener(scheduleBadges);
chrome.tabs.onMoved.addListener(scheduleBadges);
chrome.tabs.onAttached.addListener(scheduleBadges);
chrome.tabs.onDetached.addListener(scheduleBadges);
chrome.runtime.onInstalled.addListener(()=>{ scheduleBadges(); });

// ========================
// Per-domain auto-refresh using chrome.alarms
// ========================
// storage model: { refreshRules: [{ domain:"example.com", seconds: 300 }, ...] }
async function getRefreshRules(){ const r = await chrome.storage.sync.get({ refreshRules: [] }); return r.refreshRules || []; }
async function setRefreshRules(rules){ await chrome.storage.sync.set({ refreshRules: rules }); await rebuildAlarms(rules); }

function alarmNameFor(domain){ return `refresh:${domain}`; }
async function rebuildAlarms(rules){
  const all = await chrome.alarms.getAll();
  for (const a of all) { if (a.name.startsWith('refresh:')) chrome.alarms.clear(a.name); }
  for (const rule of rules) {
    const seconds = Math.max(15, Number(rule.seconds)||0); // minimum 15s
    if (!rule.domain || !seconds) continue;
    chrome.alarms.create(alarmNameFor(rule.domain), { periodInMinutes: seconds/60 });
  }
}

chrome.runtime.onInstalled.addListener(async ()=>{ await rebuildAlarms(await getRefreshRules()); });
chrome.alarms.onAlarm.addListener(async (alarm)=>{
  if (!alarm.name.startsWith('refresh:')) return;
  const domain = alarm.name.slice('refresh:'.length);
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    if (!t.url) continue; try{
      const host = hostnameOf(t.url); if (!host) continue;
      if (host===domain || host.endsWith('.'+domain)) { try{ await chrome.tabs.reload(t.id);}catch{} }
    }catch{}
  }
});

// ========================
// Messaging API for popup (manage settings)
// ========================
chrome.runtime.onMessage.addListener((message, sender, sendResponse)=>{
  console.log('Received message:', message);
  (async()=>{
    if (message?.type==='PING') {
      console.log('PING received, sending PONG');
      sendResponse({ pong: true, timestamp: Date.now() });
      return;
    }
    if (message?.type==='getSettingsV11'){
      const base = await chrome.storage.sync.get({ highlightEnabled:true, refreshRules:[], protectDomains:[] });
      debugLogger.log('Retrieved settings:', base);
      sendResponse(base); return;
    }
    if (message?.type==='setSettingsV11'){
      debugLogger.log('Saving settings:', message.payload);
      await chrome.storage.sync.set(message.payload);
      debugLogger.log('Settings saved successfully');
      sendResponse({ ok:true }); return;
    }
    if (message?.type==='refreshNowForDomains'){
      const rules = await getRefreshRules();
      const domains = message.domains || rules.map(r=>r.domain);
      for (const d of domains){
        const tabs = await chrome.tabs.query({url:`*://${d}/*`});
        for (const t of tabs){
          if (t.id) { try{ await chrome.tabs.reload(t.id); }catch{} }
        }
      }
      sendResponse({ ok:true, refreshed:domains.length }); return;
    }
    if (message?.type==='getDuplicateGroups'){
      const allTabs = await chrome.tabs.query({});
      const buckets = new Map(); // key -> [tab]
      for (const t of allTabs){ const key = t.url && keyForDup(t.url); if (!key) continue; if (!buckets.has(key)) buckets.set(key,[]); buckets.get(key).push(t); }
      const groups = [];
      for (const [key,tabs] of buckets.entries()){
        if (tabs.length > 1){
          groups.push({ key, tabs });
        }
      }
      sendResponse(groups); return;
    }
    if (message?.type==='focusTab'){
      try {
        await chrome.windows.update(message.windowId, { focused:true });
        await chrome.tabs.update(message.tabId, { active:true });
        sendResponse({ ok:true });
      } catch (e) {
        sendResponse({ ok:false, error:e.message });
      }
      return;
    }
    if (message?.type==='alignAllByHostname'){
      const allTabs = await chrome.tabs.query({});
      const buckets = new Map(); // host -> [tab]
      for (const t of allTabs){ const host = hostnameOf(t.url||''); if (!host) continue; if (!buckets.has(host)) buckets.set(host,[]); buckets.get(host).push(t); }

      for (const [host,tabs] of buckets.entries()){
        if (tabs.length < 2) continue;
        // Sort by URL ascending
        const sorted = tabs.slice().sort((a,b)=>(a.url||'').localeCompare(b.url||''));
        // Move tabs to match sorted order, but keep first tab in place
        for (let i=1;i<sorted.length;i++){
          const target = sorted[i];
          const targetWindow = target.windowId;
          const targetIndex = target.index;
          const desiredIndex = sorted[i-1].index + 1;
          if (targetIndex !== desiredIndex){
            try {
              await chrome.tabs.move(target.id, {windowId:targetWindow,index:desiredIndex});
            } catch {}
          }
        }
      }
      sendResponse({ ok:true }); return;
    }
    if (message?.type==='alignDuplicatesByKey' && typeof message.key === 'string'){
      const allTabs = await chrome.tabs.query({});
      const groupTabs = allTabs.filter(t => keyForDup(t.url || '') === message.key);
      if (groupTabs.length < 2) { sendResponse({ ok:true, moved: 0 }); return; }

      // Filter to tabs that are on the same Zendesk instance and have a ticket number in URL
      const ticketTabs = groupTabs.filter(t => {
        const match = (t.url || '').match(TICKET_ROUTE);
        const isTicketTab = match && match[3] && match[3].match(/^\d+$/);
        debugLogger.log(`Tab ${t.id} (${t.url}): isTicketTab=${isTicketTab}, match=`, match);
        return isTicketTab;
      });

      // Sort by URL ascending (case-insensitive)
      const sorted = groupTabs.slice().sort((a, b) => {
        const ua = (a.url || '').toLowerCase();
        const ub = (b.url || '').toLowerCase();
        return ua.localeCompare(ub);
      });

      // Move tabs to match sorted order, but keep first tab in place
      let moved = 0;
      for (let i=1;i<sorted.length;i++){
        const target = sorted[i];
        const targetWindow = target.windowId;
        const targetIndex = target.index;
        const desiredIndex = sorted[i-1].index + 1;
        if (targetIndex !== desiredIndex){
          try {
            await chrome.tabs.move(target.id, {windowId:targetWindow,index:desiredIndex});
            moved++;
          } catch {}
        }
        break;
      }
      sendResponse({ ok:true, moved }); return;
    }
    if (message?.type==='getRefreshRules'){
      sendResponse(await getRefreshRules()); return;
    }
    if (message?.type==='setRefreshRules'){
      await setRefreshRules(message.rules);
      sendResponse({ ok:true }); return;
    }
    if (message?.type==='GET_LOGS'){
      sendResponse({ logs: debugLogger.getLogs() });
      return;
    }
    if (message?.type==='CLEAR_LOGS'){
      debugLogger.clear();
      sendResponse({ ok:true });
      return;
    }
    if (message?.type==='SET_DEBUG_ENABLED'){
      debugLogger.setDebugEnabled(message.enabled);
      sendResponse({ ok:true });
      return;
    }
  })();
  return true;
});

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }
