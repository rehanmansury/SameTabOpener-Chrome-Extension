// Popup logic for SameTabOpener V1.3 - Simplified version without refresh functionality

// Simple debug logger implementation (inline for now)
const debugLogger = {
  logs: [],
  maxLogs: 500,
  debugEnabled: false, // Will sync with background
  observers: new Set(),
  
  async syncWithBackground() {
    // Get debug state from background
    const response = await chrome.runtime.sendMessage({ type: 'isDebugEnabled' });
    this.debugEnabled = response && response.enabled || false;
  },
  
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
    console.log(`[Popup Debug] ${message}`);
    this.notifyObservers();
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
    console.error(`[Popup Debug] ${message}`);
    this.notifyObservers();
  },
  
  getLogs() {
    return this.logs;
  },
  
  clear() {
    this.logs = [];
    this.notifyObservers();
  },
  
  setDebugEnabled(enabled) {
    this.debugEnabled = enabled;
  },
  
  isDebugEnabled() {
    return this.debugEnabled;
  },
  
  addObserver(callback) {
    this.observers.add(callback);
  },
  
  removeObserver(callback) {
    this.observers.delete(callback);
  },
  
  notifyObservers() {
    this.observers.forEach(callback => callback());
  }
};

// Test debug logger in popup
console.log('Popup script loaded');
debugLogger.log('Popup script initialized');

async function rpc(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...(payload || {}) }, resolve);
  });
}

async function getSettings() {
  debugLogger.log('Popup: Getting settings...');
  const result = await rpc('getSettingsV11');
  debugLogger.log('Popup: Retrieved settings:', result);
  
  // Log configuration summary
  debugLogger.log('=== EXTENSION CONFIGURATION ===');
  debugLogger.log(`Highlight Enabled: ${result.highlightEnabled}`);
  debugLogger.log(`Protected Domains (${result.protectDomains?.length || 0}):`, result.protectDomains);
  debugLogger.log('===============================');
  
  return result;
}

async function getDuplicateGroups() {
  const response = await rpc('getDuplicateGroups');
  return response.groups || [];
}

async function focusTab(tabId, windowId) {
  await rpc('focusTab', { tabId, windowId });
}

async function alignAllByHostname() {
  await rpc('alignAllByHostname');
}

async function setSettings(patch) {
  debugLogger.log('Popup: Setting settings:', patch);
  const result = await rpc('setSettingsV11', { payload: patch });
  debugLogger.log('Popup: Settings saved result:', result);
  return result;
}

// Helper function to escape HTML
function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

// Tab switching functionality
function setupTabs() {
  const tabButtons = document.querySelectorAll('.tab-button');
  const tabContents = document.querySelectorAll('.tab-content');
  
  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const tabName = button.dataset.tab;
      
      // Update active states
      tabButtons.forEach(btn => btn.classList.remove('active'));
      tabContents.forEach(content => content.classList.remove('active'));
      
      button.classList.add('active');
      document.getElementById(tabName).classList.add('active');

      // Store the last active tab
      chrome.storage.local.set({ lastActiveTab: tabName });
    });
  });

  // Restore the last active tab
  chrome.storage.local.get('lastActiveTab', (result) => {
    const tabId = result.lastActiveTab || 'duplicate';
    const tabButton = document.querySelector(`.tab-button[data-tab="${tabId}"]`);
    if (tabButton) tabButton.click();
  });
}

// Debug log functionality
function setupDebugLogs() {
  const debugLogsElement = document.getElementById('debugLogs');
  const autoScrollCheckbox = document.getElementById('autoScroll');
  const debugToggleButton = document.getElementById('debugToggle');
  let shouldAutoScroll = true;

  function renderLogs() {
    const logs = debugLogger.getLogs();
    if (logs.length === 0) {
      debugLogsElement.innerHTML = '<div style="color: #888; padding: 20px; text-align: center;">Debug is disabled. Enable debug to start monitoring Zendesk activities.</div>';
      return;
    }
    
    debugLogsElement.innerHTML = logs
      .map(log => {
        const time = log.timestamp.split('T')[1].split('.')[0];
        return `<div class="log-entry" data-level="${log.level}">
          <span class="log-time">[${time}]</span> 
          <span class="log-message">${escapeHtml(log.message)}</span>
        </div>`;
      })
      .join('');

    if (shouldAutoScroll) {
      debugLogsElement.scrollTop = 0;
    }
  }

  // Handle auto-scroll toggle
  autoScrollCheckbox.addEventListener('change', (e) => {
    shouldAutoScroll = e.target.checked;
  });

  // Clear logs button
  document.getElementById('clearLogs').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'clearLogs' });
    debugLogger.clear();
    renderLogs();
  });

  // Copy logs button
  document.getElementById('copyLogs').addEventListener('click', async () => {
    const logs = debugLogger.getLogs()
      .map(log => `[${log.timestamp}] ${log.message}`)
      .join('\n');
    
    try {
      await navigator.clipboard.writeText(logs);
      const button = document.getElementById('copyLogs');
      const originalText = button.textContent;
      button.textContent = 'Copied!';
      setTimeout(() => {
        button.textContent = originalText;
      }, 2000);
    } catch (err) {
      debugLogger.error('Failed to copy logs:', err);
    }
  });

  // Debug toggle button
  debugToggleButton.addEventListener('click', async () => {
    const isEnabled = debugLogger.isDebugEnabled();
    
    if (isEnabled) {
      // Disable debug
      await chrome.runtime.sendMessage({ type: 'disableDebug' });
      debugLogger.setDebugEnabled(false);
      debugLogger.clear();
      debugToggleButton.textContent = 'Enable Debug';
      debugToggleButton.classList.remove('debug-toggle');
    } else {
      // Enable debug
      await chrome.runtime.sendMessage({ type: 'enableDebug' });
      debugLogger.setDebugEnabled(true);
      debugToggleButton.textContent = 'Disable Debug';
      debugToggleButton.classList.add('debug-toggle');
    }
    
    renderLogs();
  });

  // Test button
  document.getElementById('testDebug').addEventListener('click', async () => {
    if (!debugLogger.isDebugEnabled()) {
      alert('Please enable debug first!');
      return;
    }
    
    // Get current Zendesk tabs
    const tabs = await chrome.tabs.query({ url: '*://nexthink.zendesk.com/*' });
    debugLogger.log(`=== TEST: Found ${tabs.length} Zendesk tabs ===`);
    tabs.forEach(tab => {
      debugLogger.log(`Tab ${tab.id}: ${tab.url} (active: ${tab.active})`);
    });
    debugLogger.log('=====================================');
  });

  // Initialize button state
  debugToggleButton.textContent = debugLogger.isDebugEnabled() ? 'Disable Debug' : 'Enable Debug';
  if (debugLogger.isDebugEnabled()) {
    debugToggleButton.classList.add('debug-toggle');
  }

  // Subscribe to new logs
  debugLogger.addObserver(() => {
    renderLogs();
  });

  // Initial render
  renderLogs();
}

function renderProtectList(listEl, domains, onDelete) {
  listEl.innerHTML = '';
  (domains || []).forEach((domain, idx) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = domain;

    const delBtn = document.createElement('button');
    delBtn.className = 'small';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => onDelete(idx));

    li.appendChild(span);
    li.appendChild(delBtn);
    listEl.appendChild(li);
  });
}

function renderDuplicateGroups(listEl, groups, onFocusTab) {
  listEl.innerHTML = '';
  if (!groups || groups.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'No duplicate tabs found';
    listEl.appendChild(li);
    return;
  }

  // Get the current active tab to highlight it
  chrome.tabs.query({ active: true, currentWindow: true }, ([activeTab]) => {
    groups.forEach(group => {
      const li = document.createElement('li');
      const container = document.createElement('div');
      container.style.width = '100%';

      // Extract hostname from the key for cleaner display
      let hostname = group.key;
      try {
        const url = new URL(group.key.split(' ')[0]);
        hostname = url.hostname;
      } catch (e) {
        // Use original key if parsing fails
      }

      const header = document.createElement('div');
      header.style.fontWeight = '500';
      header.style.marginBottom = '4px';
      header.style.display = 'flex';
      header.style.justifyContent = 'space-between';
      header.style.alignItems = 'center';
      
      const headerText = document.createElement('span');
      headerText.textContent = `${hostname} (${group.tabs.length} tabs)`;
      header.appendChild(headerText);
      
      // Add close group button
      const closeGroupBtn = document.createElement('button');
      closeGroupBtn.textContent = '×';
      closeGroupBtn.style.fontSize = '16px';
      closeGroupBtn.style.fontWeight = 'bold';
      closeGroupBtn.style.color = '#dc3545';
      closeGroupBtn.style.background = 'none';
      closeGroupBtn.style.border = 'none';
      closeGroupBtn.style.cursor = 'pointer';
      closeGroupBtn.style.padding = '0 4px';
      closeGroupBtn.title = 'Close all tabs in this group';
      closeGroupBtn.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (confirm(`Close all ${group.tabs.length} tabs for ${hostname}?`)) {
          for (const tab of group.tabs) {
            try {
              await chrome.tabs.remove(tab.id);
            } catch (e) {
              console.error('Failed to close tab:', e);
            }
          }
          renderDupGroups();
        }
      });
      header.appendChild(closeGroupBtn);

      container.appendChild(header);

      group.tabs.forEach(tab => {
        const tabDiv = document.createElement('div');
        tabDiv.className = 'small';
        tabDiv.style.cursor = 'pointer';
        tabDiv.style.paddingLeft = '12px';
        tabDiv.style.marginTop = '2px';
        tabDiv.style.display = 'flex';
        tabDiv.style.alignItems = 'center';
        tabDiv.style.justifyContent = 'space-between';
        
        // Highlight if this is the active tab
        if (activeTab && tab.id === activeTab.id) {
          tabDiv.style.backgroundColor = '#e8f0fe';
          tabDiv.style.color = '#1967d2';
          tabDiv.style.fontWeight = '500';
        }
        
        // Create a more compact display
        const titleSpan = document.createElement('div');
        titleSpan.textContent = `> ${tab.title || 'Untitled'}`;
        titleSpan.style.whiteSpace = 'nowrap';
        titleSpan.style.overflow = 'hidden';
        titleSpan.style.textOverflow = 'ellipsis';
        titleSpan.style.flex = '1';
        
        // Add close tab button
        const closeTabBtn = document.createElement('button');
        closeTabBtn.textContent = '×';
        closeTabBtn.style.fontSize = '14px';
        closeTabBtn.style.fontWeight = 'bold';
        closeTabBtn.style.color = '#dc3545';
        closeTabBtn.style.background = 'none';
        closeTabBtn.style.border = 'none';
        closeTabBtn.style.cursor = 'pointer';
        closeTabBtn.style.padding = '0 4px';
        closeTabBtn.style.marginLeft = '8px';
        closeTabBtn.title = 'Close this tab';
        closeTabBtn.addEventListener('click', async (e) => {
          e.stopPropagation();
          try {
            await chrome.tabs.remove(tab.id);
            renderDupGroups();
          } catch (e) {
            console.error('Failed to close tab:', e);
          }
        });
        
        tabDiv.appendChild(titleSpan);
        tabDiv.appendChild(closeTabBtn);
        tabDiv.addEventListener('click', (e) => {
          if (!e.target.closest('button')) {
            onFocusTab(tab.id, tab.windowId);
          }
        });
        container.appendChild(tabDiv);
      });

      li.appendChild(container);
      listEl.appendChild(li);
    });
  });
}

// Initialize the popup
document.addEventListener('DOMContentLoaded', async () => {
  console.log('DOM Content Loaded - Popup initializing...');
  
  // Sync debug state with background first
  await debugLogger.syncWithBackground();
  
  // Request badge update
  try {
    await chrome.runtime.sendMessage({ type: 'updateBadge' });
  } catch (e) {
    console.error('Failed to update badge:', e);
  }
  
  // Test background communication immediately
  try {
    console.log('Testing background communication...');
    const response = await chrome.runtime.sendMessage({ type: 'PING' });
    console.log('Background response:', response);
  } catch (e) {
    console.error('No response from background:', e);
    debugLogger.error('Background script is not responding!');
  }
  
  setupTabs();
  setupDebugLogs();
  
  // Request logs from background script only if debug is enabled
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
    if (response && response.logs && response.logs.length > 0) {
      debugLogger.log('Received logs from background:', response.logs.length);
      response.logs.forEach(log => {
        debugLogger.log(log.message);
      });
    }
  } catch (e) {
    // Only log error if debug is enabled
    if (debugLogger.isDebugEnabled()) {
      debugLogger.error('Failed to get logs from background:', e);
    }
  }
  
  // Get initial settings
  const settings = await getSettings();
  
  // Highlight toggle
  const highlightCheckbox = document.getElementById('highlightEnabled');
  highlightCheckbox.checked = settings.highlightEnabled;
  highlightCheckbox.addEventListener('change', async () => {
    await setSettings({ highlightEnabled: highlightCheckbox.checked });
  });

  // No-reload navigation toggle
  const noReloadCheckbox = document.getElementById('noReloadNavigation');
  noReloadCheckbox.checked = settings.noReloadNavigation || false;
  noReloadCheckbox.addEventListener('change', async () => {
    await setSettings({ noReloadNavigation: noReloadCheckbox.checked });
    // Also update background to ensure consistency
    try {
      await chrome.runtime.sendMessage({
        type: 'setSettingsV11',
        payload: { noReloadNavigation: noReloadCheckbox.checked }
      });
    } catch (e) {
      console.error('Failed to sync no-reload setting with background:', e);
    }
  });

  // Protect domains
  const protectList = document.getElementById('protectList');
  const protectDomain = document.getElementById('protectDomain');
  const protectAdd = document.getElementById('protectAdd');

  function renderProtectDomains() {
    renderProtectList(protectList, settings.protectDomains, async (idx) => {
      settings.protectDomains.splice(idx, 1);
      await setSettings({ protectDomains: settings.protectDomains });
      renderProtectDomains();
    });
  }

  renderProtectDomains();

  protectAdd.addEventListener('click', async () => {
    const domain = protectDomain.value.trim();
    if (!domain) return;
    settings.protectDomains = settings.protectDomains || [];
    if (!settings.protectDomains.includes(domain)) {
      settings.protectDomains.push(domain);
      await setSettings({ protectDomains: settings.protectDomains });
      renderProtectDomains();
    }
    protectDomain.value = '';
  });

  // Refresh rules
  const refreshRulesList = document.getElementById('refreshRulesList');
  const refreshDomain = document.getElementById('refreshDomain');
  const refreshInterval = document.getElementById('refreshInterval');
  const refreshAdd = document.getElementById('refreshAdd');

  function renderRefreshRules() {
    refreshRulesList.innerHTML = '';
    if (!settings.refreshRules || settings.refreshRules.length === 0) {
      const li = document.createElement('li');
      li.className = 'muted';
      li.textContent = 'No refresh rules configured';
      refreshRulesList.appendChild(li);
      return;
    }

    settings.refreshRules.forEach((rule, idx) => {
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.alignItems = 'center';
      li.style.gap = '8px';
      
      const span = document.createElement('span');
      span.style.flex = '1';
      span.textContent = `${rule.domain} - every ${rule.interval}s`;

      const editBtn = document.createElement('button');
      editBtn.className = 'small';
      editBtn.textContent = 'Edit';
      editBtn.addEventListener('click', () => {
        // Populate the form with existing values
        refreshDomain.value = rule.domain;
        refreshInterval.value = rule.interval;
        refreshAdd.textContent = 'Update Rule';
        refreshAdd.onclick = async () => {
          const newDomain = refreshDomain.value.trim();
          const newInterval = parseInt(refreshInterval.value);
          
          if (!newDomain) {
            alert('Please enter a domain');
            return;
          }
          
          if (newInterval < 10) {
            alert('Minimum interval is 10 seconds');
            return;
          }
          
          settings.refreshRules[idx] = { domain: newDomain, interval: newInterval };
          await setSettings({ refreshRules: settings.refreshRules });
          renderRefreshRules();
          
          // Reset button
          refreshAdd.textContent = 'Add Rule';
          refreshAdd.onclick = null;
          refreshDomain.value = '';
          refreshInterval.value = 60;
          
          // Notify background
          try {
            await chrome.runtime.sendMessage({
              type: 'updateRefreshRules',
              refreshRules: settings.refreshRules
            });
          } catch (e) {
            console.error('Failed to update refresh rules:', e);
          }
        };
      });

      const delBtn = document.createElement('button');
      delBtn.className = 'small';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async () => {
        settings.refreshRules.splice(idx, 1);
        await setSettings({ refreshRules: settings.refreshRules });
        renderRefreshRules();
        
        // Notify background
        try {
          await chrome.runtime.sendMessage({
            type: 'updateRefreshRules',
            refreshRules: settings.refreshRules
          });
        } catch (e) {
          console.error('Failed to update refresh rules:', e);
        }
      });

      li.appendChild(span);
      li.appendChild(editBtn);
      li.appendChild(delBtn);
      refreshRulesList.appendChild(li);
    });
  }

  renderRefreshRules();

  refreshAdd.addEventListener('click', async () => {
    const domain = refreshDomain.value.trim();
    const interval = parseInt(refreshInterval.value);
    
    if (!domain) {
      alert('Please enter a domain');
      return;
    }
    
    if (interval < 10) {
      alert('Minimum interval is 10 seconds');
      return;
    }
    
    settings.refreshRules = settings.refreshRules || [];
    
    // Check if rule already exists
    const existing = settings.refreshRules.findIndex(r => r.domain === domain);
    if (existing >= 0) {
      settings.refreshRules[existing].interval = interval;
    } else {
      settings.refreshRules.push({ domain, interval });
    }
    
    await setSettings({ refreshRules: settings.refreshRules });
    renderRefreshRules();
    
    // Reset form
    refreshDomain.value = '';
    refreshInterval.value = 60;
    refreshAdd.textContent = 'Add Rule';
    refreshAdd.onclick = null;
    
    // Notify background to start/stop refresh timers
    try {
      await chrome.runtime.sendMessage({
        type: 'updateRefreshRules',
        refreshRules: settings.refreshRules
      });
    } catch (e) {
      console.error('Failed to update refresh rules:', e);
    }
  });

  // Duplicate tabs
  const dupGroups = document.getElementById('dupGroups');
  const dupRefresh = document.getElementById('dupRefresh');
  const dupAlignAll = document.getElementById('dupAlignAll');

  async function renderDupGroups() {
    const groups = await getDuplicateGroups();
    renderDuplicateGroups(dupGroups, groups, async (tabId, windowId) => {
      await focusTab(tabId, windowId);
      // Don't close the popup - remove window.close()
    });
  }

  renderDupGroups();

  dupRefresh.addEventListener('click', renderDupGroups);
  dupAlignAll.addEventListener('click', async () => {
    await alignAllByHostname();
    renderDupGroups();
  });
});

// Listen for logs from background script
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'DEBUG_LOG') {
    debugLogger.log(message.text);
  } else if (message.type === 'DEBUG_LOGS_UPDATE') {
    // Bulk update of logs
    if (message.logs && Array.isArray(message.logs)) {
      message.logs.forEach(log => {
        debugLogger.log(log.message);
      });
    }
  }
});

// Also set up a periodic poll for logs (only when debug is enabled)
setInterval(async () => {
  if (!debugLogger.isDebugEnabled()) return; // Skip if debug is disabled
  
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
    if (response && response.logs) {
      // Only add new logs (simple implementation)
      const currentLogs = debugLogger.getLogs();
      if (response.logs.length > currentLogs.length) {
        const newLogs = response.logs.slice(currentLogs.length);
        newLogs.forEach(log => {
          debugLogger.log(log.message);
        });
      }
    }
  } catch (e) {
    // Ignore errors during polling
  }
}, 1000); // Check every second
