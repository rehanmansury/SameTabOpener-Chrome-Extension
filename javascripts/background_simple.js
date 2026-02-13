// Simple, non-intrusive tab reuse for Zendesk tickets
// This version doesn't inject scripts or block events

// Debug logger
const debugLogger = {
  logs: [],
  maxLogs: 500,
  
  log(...args) {
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
    
    console.log(`[SameTabOpener] ${message}`);
  },
  
  error(...args) {
    this.log('ERROR:', ...args);
  },
  
  getLogs() {
    return this.logs;
  },
  
  clearLogs() {
    this.logs = [];
  }
};

// Constants
const NEW_TAB_WINDOW_MS = 2000;
const TICKET_ROUTE = /^https?:\/\/([^.]+)\.zendesk\.com\/agent\/(tickets|views)\/(\d+)/;
const HASH_TICKET_ROUTE = /^https?:\/\/([^.]+)\.zendesk\.com\/agent\/#\/(tickets|views)\/(\d+)/;

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
  }
};

// Tab tracking
const recentNewTabs = new Map();

function markTabNew(tabId) {
  recentNewTabs.set(tabId, Date.now());
}

function isTabRecentlyNew(tabId) {
  const ts = recentNewTabs.get(tabId);
  if (!ts) return false;
  if (Date.now() - ts <= NEW_TAB_WINDOW_MS) return true;
  recentNewTabs.delete(tabId);
  return false;
}

function extractTicketNumber(url) {
  const match = url.match(TICKET_ROUTE) || url.match(HASH_TICKET_ROUTE);
  return match ? match[3] : null;
}

function extractSubdomain(url) {
  const match = url.match(/^https?:\/\/([^.]+)\.zendesk\.com/);
  return match ? match[1] : null;
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

// Main tab reuse function - SIMPLE APPROACH
async function reuseZendeskTab(newTabId, ticketUrl) {
  debugLogger.log(`reuseZendeskTab: newTabId=${newTabId}, ticketUrl=${ticketUrl}`);
  
  try {
    // Extract info from URL
    const subdomain = extractSubdomain(ticketUrl);
    const ticketNumber = extractTicketNumber(ticketUrl);
    
    if (!subdomain || !ticketNumber) {
      debugLogger.log('Could not extract subdomain or ticket number');
      return;
    }
    
    // Find all Zendesk tabs for this subdomain
    const allTabs = await chrome.tabs.query({
      url: `*://${subdomain}.zendesk.com/*`
    });
    
    debugLogger.log(`Found ${allTabs.length} Zendesk tabs for ${subdomain}`);
    
    // Filter out the new tab and find the best candidate
    const candidates = allTabs.filter(tab => 
      tab.id !== newTabId && 
      tab.url.includes('/agent/')
    );
    
    if (candidates.length === 0) {
      debugLogger.log('No existing Zendesk agent tabs found');
      return;
    }
    
    // Choose the most recently accessed tab
    const targetTab = candidates.reduce((a, b) => 
      (a.lastAccessed || 0) > (b.lastAccessed || 0) ? a : b
    );
    
    debugLogger.log(`Selected target tab: ${targetTab.id} (${targetTab.url})`);
    
    // Create the clean ticket URL
    const cleanUrl = `https://${subdomain}.zendesk.com/agent/tickets/${ticketNumber}`;
    
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
    }, 300);
    
    debugLogger.log('Tab reuse completed successfully');
    
  } catch (error) {
    debugLogger.error('Error in reuseZendeskTab:', error);
  }
}

// Navigation handler
async function handleNavigation(details) {
  // Only process main frame navigations
  if (details.frameId !== 0) return;
  
  debugLogger.log(`Navigation: ${details.url}`);
  
  // Check if this is a Zendesk ticket URL
  if (!TICKET_ROUTE.test(details.url) && !HASH_TICKET_ROUTE.test(details.url)) {
    return;
  }
  
  // Only process new tabs
  if (!isTabRecentlyNew(details.tabId)) {
    debugLogger.log('Not a new tab, ignoring');
    return;
  }
  
  // Reuse existing tab
  await reuseZendeskTab(details.tabId, details.url);
}

// Event listeners
chrome.webNavigation.onCompleted.addListener(handleNavigation);
chrome.webNavigation.onHistoryStateUpdated.addListener(handleNavigation);

chrome.tabs.onCreated.addListener(tab => {
  if (tab.id) markTabNew(tab.id);
});

chrome.webNavigation.onCreatedNavigationTarget.addListener(details => {
  if (details.tabId) markTabNew(details.tabId);
});

// Clean up old tab references
setInterval(() => {
  const now = Date.now();
  for (const [tabId, timestamp] of recentNewTabs.entries()) {
    if (now - timestamp > NEW_TAB_WINDOW_MS * 2) {
      recentNewTabs.delete(tabId);
    }
  }
}, NEW_TAB_WINDOW_MS);

// Message handlers
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getLogs') {
    sendResponse(debugLogger.getLogs());
  } else if (message.type === 'clearLogs') {
    debugLogger.clearLogs();
    sendResponse({ success: true });
  } else if (message.type === 'PING') {
    sendResponse('PONG');
  }
});

// Extension initialization
chrome.runtime.onInstalled.addListener(async () => {
  debugLogger.log('Extension installed/updated');
  await storage.sanitize();
});

// Initial log
debugLogger.log('Background script initialized');
