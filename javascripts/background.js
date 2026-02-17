// Simple, non-intrusive tab reuse for Zendesk tickets
// This version doesn't inject scripts or block events

// Debug logger - DISABLED by default, only logs Zendesk activities
const debugLogger = {
  logs: [],
  maxLogs: 500,
  debugEnabled: false, // Will check storage on init
  storageKey: 'debugEnabled',
  
  async init() {
    // Load debug state from storage
    const stored = await chrome.storage.local.get(this.storageKey);
    this.debugEnabled = stored[this.storageKey] || false;
    if (this.debugEnabled) {
      this.log('=== DEBUG PERSISTED FROM PREVIOUS SESSION ===');
    }
  },
  
  async enable() {
    this.debugEnabled = true;
    await chrome.storage.local.set({ [this.storageKey]: true });
    this.log('=== DEBUG ENABLED ===');
    this.log('Now monitoring Zendesk tab activities');
  },
  
  async disable() {
    this.debugEnabled = false;
    await chrome.storage.local.set({ [this.storageKey]: false });
    this.logs = []; // Clear logs when disabled
  },
  
  log(...args) {
    if (!this.debugEnabled) return;
    
    const message = args.map(arg => 
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');
    
    this.logs.push({
      timestamp: new Date().toISOString(),
      message
    });
    
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    
    console.log(`[Zendesk Debug] ${message}`);
  },
  
  error(...args) {
    this.log('ERROR:', ...args);
  },
  
  getLogs() {
    return this.logs;
  },
  
  clearLogs() {
    this.logs = [];
    if (this.debugEnabled) {
      this.log('=== LOGS CLEARED ===');
    }
  }
};

// Constants
const NEW_TAB_WINDOW_MS = 5000; // Increased to 5 seconds to handle redirects
const TICKET_ROUTE = /^https?:\/\/([^.]+)\.zendesk\.com\/agent\/(tickets|views)\/(\d+)/;
const HASH_TICKET_ROUTE = /^https?:\/\/([^.]+)\.zendesk\.com\/agent\/#\/(tickets|views)\/(\d+)/;
const ZENDESK_DOMAIN = 'nexthink.zendesk.com';
const TEAMS_SAFEURL = /^https?:\/\/statics\.teams\.cdn\.office\.net\/evergreen-assets\/safelinks/;

// Storage helpers
const storage = {
  async get(key) { 
    const r = await chrome.storage.sync.get(key); 
    return r[key]; 
  },
  async set(key, val) { 
    await chrome.storage.sync.set({ [key]: val }); 
  },
  async sanitize() { 
    if (!(await this.get('urlDetection'))) 
      await this.set('urlDetection', 'ticketUrls'); 
  },
  
  // Get all settings for popup
  async getAllSettings() {
    const defaults = {
      highlightEnabled: true,
      protectDomains: ['nexthink.zendesk.com'],
      refreshRules: [],
      urlDetection: 'ticketUrls',
      dupAuto: false,
      noReloadNavigation: true // Default to ENABLED for testing
    };
    
    const stored = await chrome.storage.sync.get(defaults);
    return stored;
  },
  
  // Update settings
  async updateSettings(patch) {
    await chrome.storage.sync.set(patch);
    if (debugLogger.debugEnabled) {
      debugLogger.log('Settings updated:', patch);
    }
  }
};

// Tab tracking
const recentNewTabs = new Map();
const navigationTabs = new Set(); // Track tabs created for navigation

// Refresh timers storage
const refreshTimers = new Map();

// Track ongoing navigation attempts to prevent loops
const ongoingNavigations = new Set();

// Debounce tracking for the same URL
const lastNavigationTime = new Map();
const NAVIGATION_DEBOUNCE_MS = 100; // Reduced to 100ms

// Global navigation lock to prevent any loops
let isNavigating = false;

function markTabNew(tabId) {
  recentNewTabs.set(tabId, Date.now());
  debugLogger.log(`Marked tab ${tabId} as new`);
}

function isTabRecentlyNew(tabId) {
  // Ignore internal navigation-target tabs created by the browser/extension
  if (navigationTabs.has(tabId)) {
    debugLogger.log(`Tab ${tabId} is a navigation tab, ignoring`);
    return false;
  }
  
  const ts = recentNewTabs.get(tabId);
  if (!ts) {
    debugLogger.log(`Tab ${tabId} not in recent tabs map`);
    return false;
  }
  const age = Date.now() - ts;
  const isRecent = age <= NEW_TAB_WINDOW_MS;
  debugLogger.log(`Tab ${tabId} age: ${age}ms, recent: ${isRecent}`);
  if (!isRecent) {
    recentNewTabs.delete(tabId);
  }
  return isRecent;
}

// Clean up navigation tabs after successful reuse
function clearNavigationTab(tabId) {
  navigationTabs.delete(tabId);
  recentNewTabs.delete(tabId);
  debugLogger.log(`Cleared navigation tab ${tabId}`);
}

function extractTicketNumber(url) {
  const match = url.match(TICKET_ROUTE) || url.match(HASH_TICKET_ROUTE);
  return match ? match[3] : null;
}

function extractSubdomain(url) {
  const match = url.match(/^https?:\/\/([^.]+)\.zendesk\.com/);
  return match ? match[1] : null;
}

function extractZendeskUrlFromTeams(url) {
  if (!TEAMS_SAFEURL.test(url)) return null;
  
  try {
    const urlParams = new URLSearchParams(url.split('?')[1]);
    const encodedUrl = urlParams.get('url');
    if (encodedUrl) {
      return decodeURIComponent(encodedUrl);
    }
  } catch (e) {
    debugLogger.error('Failed to extract URL from Teams safelink:', e);
  }
  return null;
}

function isZendeskUrl(url) {
  return url && url.includes('zendesk.com');
}

function isZendeskTab(tab) {
  return tab && tab.url && tab.url.includes(ZENDESK_DOMAIN);
}

async function tabExists(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab && tab.id === tabId;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Monitor all Zendesk tab activities
async function monitorZendeskTab(tabId, changeInfo, tabInfo) {
  if (!debugLogger.debugEnabled) return;
  
  if (isZendeskTab(tabInfo)) {
    debugLogger.log(`=== ZENDESK TAB UPDATE ===`);
    debugLogger.log(`Tab ID: ${tabId}`);
    debugLogger.log(`URL: ${tabInfo.url}`);
    debugLogger.log(`Title: ${tabInfo.title}`);
    debugLogger.log(`Status: ${tabInfo.status}`);
    debugLogger.log(`Active: ${tabInfo.active}`);
    debugLogger.log(`Window ID: ${tabInfo.windowId}`);
    debugLogger.log(`Changes:`, changeInfo);
    
    // Extract ticket info if it's a ticket URL
    if (tabInfo.url) {
      const ticketNumber = extractTicketNumber(tabInfo.url);
      if (ticketNumber) {
        debugLogger.log(`Ticket Number: ${ticketNumber}`);
      }
    }
    debugLogger.log(`========================`);
  }
}

// Main tab reuse function - SIMPLE APPROACH
async function reuseZendeskTab(newTabId, ticketUrl) {
  debugLogger.log(`=== TAB REUSE START ===`);
  debugLogger.log(`New Tab ID: ${newTabId}`);
  debugLogger.log(`Ticket URL: ${ticketUrl}`);
  
  // Set the global navigation lock
  isNavigating = true;
  
  // Failsafe: release lock after 3 seconds in case something goes wrong
  setTimeout(() => {
    isNavigating = false;
    debugLogger.log(`Global navigation lock released by timeout`);
  }, 3000);
  
  try {
    // Get settings to check if no-reload is enabled
    const settings = await storage.getAllSettings();
    const useNoReload = settings.noReloadNavigation;
    
    debugLogger.log(`No-reload navigation: ${useNoReload ? 'ENABLED' : 'DISABLED'}`);
    
    // Extract info from URL
    const subdomain = extractSubdomain(ticketUrl);
    const ticketNumber = extractTicketNumber(ticketUrl);
    
    if (!subdomain || !ticketNumber) {
      debugLogger.log('Could not extract subdomain or ticket number');
      return;
    }
    
    // Create a unique navigation key
    const navigationKey = `${subdomain}-${ticketNumber}`;
    
    // Check if we're already processing this navigation to prevent loops
    if (ongoingNavigations.has(navigationKey)) {
      debugLogger.log(`⚠️ Navigation already in progress for ${navigationKey}, skipping to prevent loop`);
      return;
    }
    
    debugLogger.log(`Looking for existing tabs for subdomain: ${subdomain}`);
    
    // Mark this navigation as in progress
    ongoingNavigations.add(navigationKey);
    
    // Set a timeout to clear the navigation key after 5 seconds (failsafe)
    setTimeout(() => {
      ongoingNavigations.delete(navigationKey);
    }, 5000);
    
    // Find all Zendesk tabs for this subdomain
    const allTabs = await chrome.tabs.query({
      url: `*://${subdomain}.zendesk.com/*`
    });
    
    debugLogger.log(`Found ${allTabs.length} total Zendesk tabs for ${subdomain}`);
    allTabs.forEach(tab => {
      debugLogger.log(`  Tab ${tab.id}: ${tab.url} (active: ${tab.active}, window: ${tab.windowId})`);
    });
    
    // Filter out the new tab and find the best candidate
    const candidates = allTabs.filter(tab => 
      tab.id !== newTabId && 
      tab.url.includes('/agent/')
    );
    
    debugLogger.log(`Found ${candidates.length} candidate tabs after filtering`);
    
    if (candidates.length === 0) {
      debugLogger.log('No existing Zendesk agent tabs found');
      return;
    }
    
    // Choose the most recently accessed tab
    const targetTab = candidates.reduce((a, b) => 
      (a.lastAccessed || 0) > (b.lastAccessed || 0) ? a : b
    );
    
    debugLogger.log(`Selected target tab: ${targetTab.id} (${targetTab.url})`);
    debugLogger.log(`Target tab last accessed: ${new Date(targetTab.lastAccessed).toISOString()}`);
    
    // Create the clean ticket URL
    const cleanUrl = `https://${subdomain}.zendesk.com/agent/tickets/${ticketNumber}`;
    debugLogger.log(`Clean ticket URL: ${cleanUrl}`);
    
    // Focus the target tab first
    debugLogger.log(`Focusing tab ${targetTab.id}`);
    await chrome.tabs.update(targetTab.id, { active: true });
    await chrome.windows.update(targetTab.windowId, { focused: true });
    
    // Check if the target tab already has the exact same URL
    if (targetTab.url === cleanUrl) {
      debugLogger.log(`Target tab already has the same URL, no navigation needed`);
      debugLogger.log('=== TAB REUSE COMPLETED ===');
      
      // Close the new tab after a short delay
      setTimeout(async () => {
        if (await tabExists(newTabId)) {
          debugLogger.log(`Closing duplicate tab ${newTabId}`);
          await chrome.tabs.remove(newTabId);
        }
        clearNavigationTab(newTabId); // Clear from tracking
      }, 100);
      
      // Clear the navigation tracking
      ongoingNavigations.delete(navigationKey);
      
      // Release the global lock
      isNavigating = false;
      debugLogger.log(`Global navigation lock released`);
      
      return;
    }
    
    // Navigate to the new ticket
    if (useNoReload) {
      debugLogger.log(`Attempting no-reload navigation...`);
      debugLogger.log(`Target tab URL: ${targetTab.url}`);
      debugLogger.log(`Target tab path: ${new URL(targetTab.url).pathname}`);
      
      try {
        // Try to navigate without reload using script injection
        const results = await chrome.scripting.executeScript({
          target: { tabId: targetTab.id },
          func: (url) => {
            const logs = [];
            
            function log(msg) {
              console.log('[No-Reload]', msg);
              logs.push(msg);
            }
            
            // Check if we're already on a Zendesk ticket page
            log(`Current URL: ${window.location.href}`);
            log(`Target URL: ${url}`);
            log(`Pathname: ${window.location.pathname}`);
            
            if (window.location.pathname.includes('/agent/tickets/')) {
              log('Already on a Zendesk ticket page, attempting SPA navigation');
              
              // Method 1: Try to find and use Zendesk's router
              try {
                log('Checking for Zendesk router...');
                const app = window.app || window.Zendesk || window.Ember || null;
                log(`Found app object: ${!!app}`);
                
                if (app && app._router && typeof app._router.navigate === 'function') {
                  log('Found Zendesk router, using internal navigation');
                  app._router.navigate(url);
                  return { success: true, method: 'zendesk-router', logs };
                }
                
                // Try Ember router (Zendesk uses Ember.js)
                if (app && app.__container__) {
                  const router = app.__container__.lookup('router:main');
                  if (router && typeof router.transitionTo === 'function') {
                    log('Found Ember router, using transitionTo');
                    const routeName = `ticket`;
                    const ticketId = url.split('/agent/tickets/')[1];
                    router.transitionTo(routeName, ticketId);
                    return { success: true, method: 'ember-router', logs };
                  }
                }
              } catch (e) {
                log(`Zendesk router method failed: ${e.message}`);
              }
              
              // Method 2: Use history API with additional events (preferred: stays in same tab)
              try {
                log('Using history API with events');
                const ticketId = url.split('/agent/tickets/')[1];
                window.history.pushState({ ticketId }, '', url);
                
                // Dispatch multiple events to ensure Zendesk detects the change
                window.dispatchEvent(new PopStateEvent('popstate', { state: { ticketId } }));
                window.dispatchEvent(new CustomEvent('route', { detail: { url } }));
                
                // Try to trigger Ember's route change
                if (window.app && window.app.__container__) {
                  const router = window.app.__container__.lookup('router:main');
                  if (router) {
                    router.handleURL(url);
                  }
                }
                
                return { success: true, method: 'history-api-with-events', logs };
              } catch (e) {
                log(`History API method failed: ${e.message}`);
              }

              // Method 3: Try to trigger click on internal link (risk: some links open new tab)
              try {
                log('Looking for internal links...');
                const links = document.querySelectorAll('a[href*="/agent/tickets/"]');
                log(`Found ${links.length} ticket links`);
                
                const targetTicketId = url.split('/agent/tickets/')[1];
                for (const link of links) {
                  if (!link.href || !link.href.includes(targetTicketId)) continue;

                  // Avoid links that are explicitly meant to open a new tab/window
                  const targetAttr = (link.getAttribute('target') || '').toLowerCase();
                  if (targetAttr === '_blank') {
                    log('Found matching link but it has target=_blank; skipping');
                    continue;
                  }

                  // Best-effort: ensure click is an in-page navigation
                  log('Found matching internal link, triggering click');
                  link.click();
                  return { success: true, method: 'internal-link-click', logs };
                }
              } catch (e) {
                log(`Internal link click method failed: ${e.message}`);
              }
              
              return { success: false, method: 'all-methods-failed', error: 'No navigation method succeeded', logs };
            }
            log('Not on a Zendesk ticket page, SPA navigation not possible');
            return { success: false, method: 'not-on-ticket-page', logs };
          },
          args: [cleanUrl]
        });
        
        const result = results[0]?.result;
        if (result && result.success) {
          debugLogger.log(`✓ No-reload navigation succeeded using: ${result.method}`);
          if (result.logs) {
            result.logs.forEach(log => debugLogger.log(`  ${log}`));
          }
        } else {
          debugLogger.log(`✗ No-reload navigation failed: ${result?.method || 'unknown'}`);
          if (result?.error) {
            debugLogger.error(`Error details: ${result.error}`);
          }
          if (result.logs) {
            result.logs.forEach(log => debugLogger.log(`  ${log}`));
          }
          // Fall back to URL update
          debugLogger.log(`Falling back to URL update...`);
          await chrome.tabs.update(targetTab.id, { url: cleanUrl });
        }
      } catch (error) {
        debugLogger.error('No-reload navigation failed:', error);
        // Fall back to URL update
        debugLogger.log(`Falling back to URL update...`);
        await chrome.tabs.update(targetTab.id, { url: cleanUrl });
      }
    } else {
      // Standard URL update (with reload)
      debugLogger.log(`Updating tab ${targetTab.id} to ${cleanUrl} (with reload)`);
      await chrome.tabs.update(targetTab.id, { url: cleanUrl });
    }
    
    // Close the new tab after a short delay
    setTimeout(async () => {
      if (await tabExists(newTabId)) {
        debugLogger.log(`Closing duplicate tab ${newTabId}`);
        await chrome.tabs.remove(newTabId);
      }
      clearNavigationTab(newTabId); // Clear from tracking
    }, 100); // Reduced from 300ms to 100ms
    
    debugLogger.log('=== TAB REUSE COMPLETED ===');
    
    // Clear the navigation tracking
    ongoingNavigations.delete(navigationKey);
    
  } catch (error) {
    debugLogger.error('Error in reuseZendeskTab:', error);
    // Make sure to clear on error too
    ongoingNavigations.delete(navigationKey);
  } finally {
    // Always release the global lock
    isNavigating = false;
    debugLogger.log(`Global navigation lock released`);
  }
}

// Navigation handler
async function handleNavigation(details) {
  // Global lock check - if we're already navigating, skip everything
  if (isNavigating) {
    if (debugLogger.debugEnabled && isZendeskUrl(details.url)) {
      debugLogger.log(`⚠️ GLOBAL LOCK: Already navigating, skipping Zendesk navigation`);
    }
    return;
  }
  
  // Only log Zendesk navigations if debug is enabled
  if (debugLogger.debugEnabled && isZendeskUrl(details.url)) {
    debugLogger.log(`=== ZENDESK NAVIGATION ===`);
    debugLogger.log(`Tab ID: ${details.tabId}`);
    debugLogger.log(`URL: ${details.url}`);
    debugLogger.log(`Frame ID: ${details.frameId}`);
    debugLogger.log(`Transition Type: ${details.transitionType || 'N/A'}`);
    debugLogger.log(`Time: ${new Date().toISOString()}`);
  }
  
  // Only process main frame navigations
  if (details.frameId !== 0) {
    if (debugLogger.debugEnabled) {
      debugLogger.log(`Ignoring sub-frame navigation: frameId=${details.frameId}`);
    }
    return;
  }
  
  // Early loop prevention - check if this is a Zendesk URL and add immediate checks
  if (isZendeskUrl(details.url)) {
    const subdomain = extractSubdomain(details.url);
    const ticketNumber = extractTicketNumber(details.url);
    
    if (subdomain && ticketNumber) {
      const navigationKey = `${subdomain}-${ticketNumber}`;
      
      // Check if we're already processing this navigation
      if (ongoingNavigations.has(navigationKey)) {
        debugLogger.log(`⚠️ EARLY LOOP DETECTION: Navigation already in progress for ${navigationKey}, skipping`);
        return;
      }
    }
  }
  
  // Check for Teams safelinks to Zendesk
  if (TEAMS_SAFEURL.test(details.url)) {
    const zendeskUrl = extractZendeskUrlFromTeams(details.url);
    if (zendeskUrl && TICKET_ROUTE.test(zendeskUrl)) {
      if (debugLogger.debugEnabled) {
        debugLogger.log(`Detected Teams safelink to Zendesk ticket`);
        debugLogger.log(`Extracted Zendesk URL: ${zendeskUrl}`);
      }
      // Process as if it were the Zendesk URL
      await processZendeskNavigation(details.tabId, zendeskUrl);
      return;
    }
  }
  
  // Check if this is a Zendesk ticket URL
  const isTicketUrl = TICKET_ROUTE.test(details.url) || HASH_TICKET_ROUTE.test(details.url);
  
  if (!isTicketUrl) {
    return;
  }
  
  // Process Zendesk navigation
  await processZendeskNavigation(details.tabId, details.url);
}

async function processZendeskNavigation(tabId, url) {
  // Extract ticket info for debugging
  const subdomain = extractSubdomain(url);
  const ticketNumber = extractTicketNumber(url);
  
  if (debugLogger.debugEnabled) {
    debugLogger.log(`Is Zendesk ticket URL: true`);
    debugLogger.log(`Extracted - Subdomain: ${subdomain}, Ticket: ${ticketNumber}`);
  }
  
  // Create navigation key to check for ongoing operations
  const navigationKey = `${subdomain}-${ticketNumber}`;
  
  // Check if we're already processing this navigation to prevent loops
  if (ongoingNavigations.has(navigationKey)) {
    debugLogger.log(`⚠️ Navigation already in progress for ${navigationKey}, skipping to prevent loop`);
    return;
  }
  
  // Only process new tabs
  const isNew = isTabRecentlyNew(tabId);
  
  if (!isNew) {
    if (debugLogger.debugEnabled) {
      debugLogger.log('Not a new tab, ignoring navigation');
    }
    return;
  }
  
  // Reuse existing tab
  debugLogger.log('Proceeding with tab reuse...');
  await reuseZendeskTab(tabId, url);
}

// Event listeners
chrome.webNavigation.onCompleted.addListener(handleNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(handleNavigation);

// Update badge with duplicate count
async function updateBadge() {
  const settings = await storage.getAllSettings();
  if (!settings.highlightEnabled) {
    // Clear badge if highlighting is disabled
    chrome.action.setBadgeText({ text: '' });
    if (debugLogger.debugEnabled) {
      debugLogger.log('Badge cleared: highlightEnabled is false');
    }
    return;
  }
  
  try {
    // Get the active tab
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    
    if (!activeTab || !activeTab.url) {
      chrome.action.setBadgeText({ text: '' });
      return;
    }
    
    // Extract hostname from active tab
    const activeUrl = new URL(activeTab.url);
    const activeHostname = activeUrl.hostname;
    
    // Count tabs with the same hostname
    const allTabs = await chrome.tabs.query({});
    let sameDomainCount = 0;
    
    allTabs.forEach(tab => {
      if (!tab.url) return;
      try {
        const tabUrl = new URL(tab.url);
        if (tabUrl.hostname === activeHostname) {
          sameDomainCount++;
        }
      } catch (e) {
        // Ignore invalid URLs
      }
    });
    
    // Update badge (show count if more than 1 tab)
    if (sameDomainCount > 1) {
      chrome.action.setBadgeText({ text: sameDomainCount.toString() });
      chrome.action.setBadgeBackgroundColor({ color: '#4285F4' });
      if (debugLogger.debugEnabled) {
        debugLogger.log(`Badge updated: ${sameDomainCount} tabs for domain ${activeHostname}`);
      }
    } else {
      chrome.action.setBadgeText({ text: '' });
      if (debugLogger.debugEnabled) {
        debugLogger.log(`Badge cleared: only 1 tab for domain ${activeHostname}`);
      }
    }
  } catch (e) {
    if (debugLogger.debugEnabled) {
      debugLogger.error('Failed to update badge:', e);
    }
  }
}

// Refresh functionality
async function startRefreshTimers(refreshRules) {
  // Clear existing timers
  refreshTimers.forEach(timer => clearInterval(timer));
  refreshTimers.clear();
  
  if (!refreshRules || refreshRules.length === 0) return;
  
  refreshRules.forEach(rule => {
    const timer = setInterval(async () => {
      await refreshTabsForDomain(rule.domain);
    }, rule.interval * 1000);
    
    refreshTimers.set(rule.domain, timer);
    debugLogger.log(`Started refresh timer for ${rule.domain} every ${rule.interval}s`);
  });
}

async function refreshTabsForDomain(domain) {
  try {
    const tabs = await chrome.tabs.query({});
    const domainTabs = tabs.filter(tab => {
      if (!tab.url) return false;
      try {
        const url = new URL(tab.url);
        return url.hostname === domain || url.hostname.endsWith('.' + domain);
      } catch (e) {
        return false;
      }
    });
    
    // Refresh all matching tabs
    for (const tab of domainTabs) {
      try {
        await chrome.tabs.reload(tab.id);
        debugLogger.log(`Refreshed tab ${tab.id} for domain ${domain}`);
      } catch (e) {
        debugLogger.error(`Failed to refresh tab ${tab.id}:`, e);
      }
    }
  } catch (e) {
    debugLogger.error(`Error refreshing tabs for domain ${domain}:`, e);
  }
}

// Initialize refresh timers on startup
(async () => {
  const settings = await storage.getAllSettings();
  if (settings.refreshRules && settings.refreshRules.length > 0) {
    await startRefreshTimers(settings.refreshRules);
  }
})();

// Monitor tab changes to update badge
chrome.tabs.onCreated.addListener(tab => {
  if (debugLogger.debugEnabled && isZendeskTab(tab)) {
    debugLogger.log(`=== ZENDESK TAB CREATED ===`);
    debugLogger.log(`Tab ID: ${tab.id}`);
    debugLogger.log(`URL: ${tab.url}`);
    debugLogger.log(`Window ID: ${tab.windowId}`);
    debugLogger.log(`Active: ${tab.active}`);
    debugLogger.log(`========================`);
  }
  if (tab.id) markTabNew(tab.id);
  updateBadge(); // Update badge when tabs are created
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (debugLogger.debugEnabled) {
    debugLogger.log(`Tab ${tabId} removed`);
  }
  updateBadge();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (debugLogger.debugEnabled && isZendeskTab(tab)) {
    if (changeInfo.status === 'complete') {
      debugLogger.log(`=== ZENDESK TAB UPDATED ===`);
      debugLogger.log(`Tab ID: ${tabId}`);
      debugLogger.log(`URL: ${tab.url}`);
      debugLogger.log(`Title: ${tab.title}`);
      debugLogger.log(`Status: ${changeInfo.status}`);
      debugLogger.log(`=========================`);
    }
  }
  if (changeInfo.url || changeInfo.status === 'complete') {
    updateBadge(); // Update badge when tabs are updated
  }
});

chrome.tabs.onActivated.addListener(activeInfo => {
  if (debugLogger.debugEnabled) {
    chrome.tabs.get(activeInfo.tabId).then(tab => {
      if (isZendeskTab(tab)) {
        debugLogger.log(`=== ZENDESK TAB ACTIVATED ===`);
        debugLogger.log(`Tab ID: ${tab.id}`);
        debugLogger.log(`URL: ${tab.url}`);
        debugLogger.log(`Window ID: ${activeInfo.windowId}`);
        debugLogger.log(`========================`);
      }
    }).catch(() => {});
  }
  updateBadge(); // Update badge when active tab changes
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  if (debugLogger.debugEnabled) {
    debugLogger.log(`=== TAB REMOVED ===`);
    debugLogger.log(`Tab ID: ${tabId}`);
    debugLogger.log(`Window ID: ${removeInfo.windowId}`);
    debugLogger.log(`Window Closing: ${removeInfo.isWindowClosing}`);
    debugLogger.log(`==================`);
  }
  navigationTabs.delete(tabId);
  recentNewTabs.delete(tabId);
});

chrome.webNavigation.onCreatedNavigationTarget.addListener(details => {
  if (debugLogger.debugEnabled && isZendeskUrl(details.url)) {
    debugLogger.log(`=== ZENDESK NAVIGATION TARGET CREATED ===`);
    debugLogger.log(`Source Tab ID: ${details.sourceTabId}`);
    debugLogger.log(`New Tab ID: ${details.tabId}`);
    debugLogger.log(`URL: ${details.url}`);
    debugLogger.log(`Window ID: ${details.windowId}`);
    debugLogger.log(`========================`);
  }
  // If this was triggered during our tab reuse/navigation, prevent Zendesk from spawning a new tab.
  // Close the created tab and force the navigation in the source tab instead.
  if (isNavigating && details.sourceTabId && details.tabId && details.url && (TICKET_ROUTE.test(details.url) || HASH_TICKET_ROUTE.test(details.url))) {
    debugLogger.log(`⚠️ Preventing navigation-target tab ${details.tabId}; forcing navigation in source tab ${details.sourceTabId}`);
    setTimeout(async () => {
      try {
        await chrome.tabs.update(details.sourceTabId, { url: details.url });
      } catch (e) {
        debugLogger.error('Failed to force navigation in source tab:', e);
      }
      try {
        if (await tabExists(details.tabId)) {
          await chrome.tabs.remove(details.tabId);
          debugLogger.log(`Closed navigation-target tab ${details.tabId}`);
        }
      } catch (e) {
        debugLogger.error('Failed to close navigation-target tab:', e);
      }
    }, 0);

    navigationTabs.add(details.tabId);
    debugLogger.log(`Marked tab ${details.tabId} as navigation tab`);
    return;
  }
  if (details.tabId) {
    // This tab is an internal navigation target; do not treat it as a user-created “new tab”.
    navigationTabs.add(details.tabId);
    debugLogger.log(`Marked tab ${details.tabId} as navigation tab`);
  }
});

// Monitor URL changes in Zendesk tabs
chrome.webNavigation.onBeforeNavigate.addListener(details => {
  if (debugLogger.debugEnabled && details.frameId === 0 && isZendeskUrl(details.url)) {
    debugLogger.log(`=== ZENDESK BEFORE NAVIGATE ===`);
    debugLogger.log(`Tab ID: ${details.tabId}`);
    debugLogger.log(`From: ${details.url || 'N/A'}`);
    debugLogger.log(`Time: ${new Date().toISOString()}`);
    debugLogger.log(`==========================`);
  }
  
  // Early detection of Teams safelinks
  if (details.frameId === 0 && TEAMS_SAFEURL.test(details.url)) {
    const zendeskUrl = extractZendeskUrlFromTeams(details.url);
    if (zendeskUrl && TICKET_ROUTE.test(zendeskUrl)) {
      if (debugLogger.debugEnabled) {
        debugLogger.log(`=== TEAMS SAFEURL DETECTED (Early) ===`);
        debugLogger.log(`Tab ID: ${details.tabId}`);
        debugLogger.log(`Teams URL: ${details.url.substring(0, 100)}...`);
        debugLogger.log(`Zendesk URL: ${zendeskUrl}`);
        debugLogger.log(`===================================`);
      }
    }
  }
});

// Clean up old tab references
setInterval(async () => {
  const now = Date.now();
  
  // Clean old recent tabs
  for (const [tabId, timestamp] of recentNewTabs.entries()) {
    if (now - timestamp > NEW_TAB_WINDOW_MS * 2) {
      recentNewTabs.delete(tabId);
      navigationTabs.delete(tabId); // Also clean from navigation tabs
    }
  }
  
  // Clean up navigation tabs for tabs that no longer exist
  for (const tabId of navigationTabs) {
    try {
      await chrome.tabs.get(tabId);
    } catch {
      // Tab doesn't exist, remove from tracking
      navigationTabs.delete(tabId);
      recentNewTabs.delete(tabId);
    }
  }
}, NEW_TAB_WINDOW_MS);

// Message handlers for popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getLogs') {
    sendResponse({ logs: debugLogger.getLogs() });
  } else if (message.type === 'clearLogs') {
    debugLogger.clearLogs();
    sendResponse({ success: true });
  } else if (message.type === 'PING') {
    sendResponse('PONG');
  } else if (message.type === 'getSettingsV11') {
    // Handle settings request from popup
    storage.getAllSettings().then(settings => {
      sendResponse(settings);
    });
    return true; // Keep message channel open for async response
  } else if (message.type === 'setSettingsV11') {
    // Handle settings update from popup
    storage.updateSettings(message.payload).then(() => {
      // Notify all tabs about the settings change
      if (message.payload.protectDomains) {
        chrome.tabs.query({}, (tabs) => {
          tabs.forEach(tab => {
            try {
              chrome.tabs.sendMessage(tab.id, {
                type: 'settingsUpdated',
                protectDomains: message.payload.protectDomains
              });
            } catch (e) {
              // Ignore errors for tabs that don't have content script
            }
          });
        });
      }
      sendResponse({ success: true });
    });
    return true; // Keep message channel open for async response
  } else if (message.type === 'GET_LOGS') {
    sendResponse({ logs: debugLogger.getLogs() });
  } else if (message.type === 'enableDebug') {
    debugLogger.enable();
    console.log('[Zendesk Debug] Debug enabled by user');
    sendResponse({ success: true });
  } else if (message.type === 'disableDebug') {
    debugLogger.disable();
    console.log('[Zendesk Debug] Debug disabled by user');
    sendResponse({ success: true });
  } else if (message.type === 'isDebugEnabled') {
    sendResponse({ enabled: debugLogger.debugEnabled });
  } else if (message.type === 'getDuplicateGroups') {
    getDuplicateGroups().then(groups => {
      sendResponse({ groups });
    });
    return true; // Keep message channel open for async response
  } else if (message.type === 'alignAllByHostname') {
    alignAllByHostname().then(() => {
      sendResponse({ success: true });
    });
    return true; // Keep message channel open for async response
  } else if (message.type === 'focusTab') {
    focusTab(message.tabId, message.windowId).then(() => {
      sendResponse({ success: true });
    });
    return true; // Keep message channel open for async response
  } else if (message.type === 'protectCloseStatus') {
    // Log close protection status from content script
    if (debugLogger.debugEnabled) {
      debugLogger.log(`=== CLOSE PROTECTION STATUS ===`);
      debugLogger.log(`Hostname: ${message.hostname}`);
      debugLogger.log(`Protected: ${message.protected ? 'YES' : 'NO'}`);
      debugLogger.log(`Protected Domains: ${JSON.stringify(message.domains)}`);
      debugLogger.log(`===============================`);
    }
    sendResponse({ success: true });
  } else if (message.type === 'protectCloseInstalled') {
    // Log when protection is installed
    if (debugLogger.debugEnabled) {
      debugLogger.log(`=== CLOSE PROTECTION INSTALLED ===`);
      debugLogger.log(`Hostname: ${message.hostname}`);
      debugLogger.log(`Tab ID: ${sender.tab?.id}`);
      debugLogger.log(`URL: ${sender.tab?.url}`);
      debugLogger.log(`================================`);
    }
    sendResponse({ success: true });
  } else if (message.type === 'protectCloseDomainsChanged') {
    // Log when protection domains change
    if (debugLogger.debugEnabled) {
      debugLogger.log(`=== CLOSE PROTECTION DOMAINS CHANGED ===`);
      debugLogger.log(`Hostname: ${message.hostname}`);
      debugLogger.log(`Old domains: ${JSON.stringify(message.oldDomains)}`);
      debugLogger.log(`New domains: ${JSON.stringify(message.newDomains)}`);
      debugLogger.log(`Now protected: ${message.nowProtected ? 'YES' : 'NO'}`);
      debugLogger.log(`Tab ID: ${sender.tab?.id}`);
      debugLogger.log(`=======================================`);
    }
    sendResponse({ success: true });
  } else if (message.type === 'updateBadge') {
    // Manual badge update request
    updateBadge();
    sendResponse({ success: true });
  } else if (message.type === 'updateRefreshRules') {
    // Update refresh timers
    startRefreshTimers(message.refreshRules);
    sendResponse({ success: true });
  }
});

// Extension initialization
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Extension installed/updated');
  await storage.sanitize();
  updateBadge(); // Initial badge update on install/update
});

// Initialize debug logger
debugLogger.init();

// Also update badge when the background script first loads
(async () => {
  // Wait a bit for tabs to be ready
  setTimeout(() => {
    updateBadge();
  }, 1000);
})();

// Additional functions for duplicate tabs and focus
async function getDuplicateGroups() {
  const tabs = await chrome.tabs.query({});
  const groups = {};
  
  tabs.forEach(tab => {
    if (!tab.url) return;
    try {
      const url = new URL(tab.url);
      const key = url.hostname;
      
      if (!groups[key]) {
        groups[key] = { key, tabs: [] };
      }
      groups[key].tabs.push(tab);
    } catch (e) {
      // Ignore invalid URLs
    }
  });
  
  // Only return groups with duplicates
  return Object.values(groups).filter(group => group.tabs.length > 1);
}

async function alignAllByHostname() {
  if (debugLogger.debugEnabled) {
    debugLogger.log('=== ALIGNING TABS BY HOSTNAME ===');
  }
  
  const tabs = await chrome.tabs.query({});
  const groups = {};
  
  // Group tabs by hostname
  tabs.forEach(tab => {
    if (!tab.url) return;
    try {
      const url = new URL(tab.url);
      const hostname = url.hostname;
      if (!groups[hostname]) groups[hostname] = [];
      groups[hostname].push(tab);
    } catch (e) {
      // Ignore invalid URLs
    }
  });
  
  // Get all windows to know where to place tabs
  const windows = await chrome.windows.getAll({ populate: true });
  const allTabs = [];
  
  // Create a sorted list of tabs by hostname
  const sortedHostnames = Object.keys(groups).sort();
  
  for (const hostname of sortedHostnames) {
    const group = groups[hostname];
    // Sort tabs within each hostname by URL
    group.sort((a, b) => {
      if (!a.url) return 1;
      if (!b.url) return -1;
      return a.url.localeCompare(b.url);
    });
    allTabs.push(...group);
  }
  
  // Now move tabs to their new positions
  // We'll move them window by window to avoid issues
  let currentIndex = 0;
  for (const window of windows) {
    const windowTabs = allTabs.filter(tab => tab.windowId === window.id);
    
    for (let i = 0; i < windowTabs.length; i++) {
      try {
        await chrome.tabs.move(windowTabs[i].id, { 
          index: i,
          windowId: window.id 
        });
        if (debugLogger.debugEnabled) {
          debugLogger.log(`Moved tab ${windowTabs[i].id} to index ${i} in window ${window.id}`);
        }
      } catch (e) {
        if (debugLogger.debugEnabled) {
          debugLogger.error(`Failed to move tab ${windowTabs[i].id}:`, e);
        }
      }
    }
  }
  
  if (debugLogger.debugEnabled) {
    debugLogger.log('=== TAB ALIGNMENT COMPLETE ===');
  }
}

async function focusTab(tabId, windowId) {
  try {
    // First make sure the window is focused
    await chrome.windows.update(windowId, { focused: true });
    // Then activate the tab
    await chrome.tabs.update(tabId, { active: true });
  } catch (e) {
    console.error('Failed to focus tab:', e);
  }
}

// Initialize debug logger on startup
chrome.runtime.onStartup.addListener(async () => {
  await debugLogger.init();
  updateBadge(); // Initial badge update
});

// Also initialize on first load if already running
(async () => {
  await debugLogger.init();
  updateBadge(); // Initial badge update
})();

// Initial log
console.log('Background script initialized - Debug DISABLED by default');
