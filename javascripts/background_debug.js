// Simple, non-intrusive tab reuse for Zendesk tickets
// This version doesn't inject scripts or block events

// Debug logger - DISABLED by default, only logs Zendesk activities
const debugLogger = {
  logs: [],
  maxLogs: 500,
  debugEnabled: false, // Disabled by default
  
  enable() {
    this.debugEnabled = true;
    this.log('=== DEBUG ENABLED ===');
    this.log('Now monitoring Zendesk tab activities');
  },
  
  disable() {
    this.debugEnabled = false;
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
      dupAuto: false
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

function markTabNew(tabId) {
  recentNewTabs.set(tabId, Date.now());
  navigationTabs.add(tabId); // Also mark as navigation tab
  debugLogger.log(`Marked tab ${tabId} as new`);
}

function isTabRecentlyNew(tabId) {
  // First check if it's a navigation tab
  if (navigationTabs.has(tabId)) {
    debugLogger.log(`Tab ${tabId} is a navigation tab, treating as new`);
    return true;
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
  
  try {
    // Extract info from URL
    const subdomain = extractSubdomain(ticketUrl);
    const ticketNumber = extractTicketNumber(ticketUrl);
    
    if (!subdomain || !ticketNumber) {
      debugLogger.log('Could not extract subdomain or ticket number');
      return;
    }
    
    debugLogger.log(`Looking for existing tabs for subdomain: ${subdomain}`);
    
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
    
    // Update the target tab
    debugLogger.log(`Updating tab ${targetTab.id} to ${cleanUrl}`);
    await chrome.tabs.update(targetTab.id, { url: cleanUrl });
    
    // Focus the target tab
    debugLogger.log(`Focusing tab ${targetTab.id}`);
    await chrome.tabs.update(targetTab.id, { active: true });
    await chrome.windows.update(targetTab.windowId, { focused: true });
    
    // Close the new tab after a short delay
    setTimeout(async () => {
      if (await tabExists(newTabId)) {
        debugLogger.log(`Closing duplicate tab ${newTabId}`);
        await chrome.tabs.remove(newTabId);
      }
      clearNavigationTab(newTabId); // Clear from tracking
    }, 300);
    
    debugLogger.log('=== TAB REUSE COMPLETED ===');
    
  } catch (error) {
    debugLogger.error('Error in reuseZendeskTab:', error);
  }
}

// Navigation handler
async function handleNavigation(details) {
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
  
  // Check if this is a Zendesk ticket URL
  const isTicketUrl = TICKET_ROUTE.test(details.url) || HASH_TICKET_ROUTE.test(details.url);
  
  if (!isTicketUrl) {
    return;
  }
  
  // Extract ticket info for debugging
  const subdomain = extractSubdomain(details.url);
  const ticketNumber = extractTicketNumber(details.url);
  
  if (debugLogger.debugEnabled) {
    debugLogger.log(`Is Zendesk ticket URL: ${isTicketUrl}`);
    debugLogger.log(`Extracted - Subdomain: ${subdomain}, Ticket: ${ticketNumber}`);
  }
  
  // Only process new tabs
  const isNew = isTabRecentlyNew(details.tabId);
  
  if (!isNew) {
    if (debugLogger.debugEnabled) {
      debugLogger.log('Not a new tab, ignoring navigation');
    }
    return;
  }
  
  // Reuse existing tab
  debugLogger.log('Proceeding with tab reuse...');
  await reuseZendeskTab(details.tabId, details.url);
}

// Event listeners
chrome.webNavigation.onCompleted.addListener(handleNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(handleNavigation);

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
});

chrome.tabs.onUpdated.addListener(monitorZendeskTab);

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
  if (details.tabId) markTabNew(details.tabId);
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
      sendResponse({ success: true });
    });
    return true; // Keep message channel open for async response
  } else if (message.type === 'GET_LOGS') {
    sendResponse({ logs: debugLogger.getLogs() });
  } else if (message.type === 'enableDebug') {
    debugLogger.enable();
    sendResponse({ success: true });
  } else if (message.type === 'disableDebug') {
    debugLogger.disable();
    sendResponse({ success: true });
  }
});

// Extension initialization
chrome.runtime.onInstalled.addListener(async () => {
  console.log('Extension installed/updated');
  await storage.sanitize();
});

// Initial log
console.log('Background script initialized - Debug DISABLED by default');
