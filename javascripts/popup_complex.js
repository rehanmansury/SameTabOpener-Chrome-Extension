// Popup logic for SameTabOpener V1.2
// Manage: highlight toggle, refresh rules (domain+seconds), protect domains, and manual refresh
// Plus debug logging functionality

// Simple debug logger implementation (inline for now)
const debugLogger = {
  logs: [],
  maxLogs: 500,
  debugEnabled: true,
  observers: new Set(),
  
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
    console.error(`[${timestamp}] ${message}`);
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
  debugLogger.log(`Refresh Rules (${result.refreshRules?.length || 0}):`, result.refreshRules);
  debugLogger.log('===============================');
  
  return result;
}

async function setSettings(patch) {
  debugLogger.log('Popup: Setting settings:', patch);
  const result = await rpc('setSettingsV11', { payload: patch });
  debugLogger.log('Popup: Settings saved result:', result);
  return result;
}

async function refreshNowForDomains(domains) {
  return rpc('refreshNowForDomains', { domains });
}

async function getDuplicateGroups() {
  return rpc('getDuplicateGroups');
}

async function focusTab(tabId, windowId) {
  return rpc('focusTab', { tabId, windowId });
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
  document.querySelectorAll('.tab-button').forEach(button => {
    button.addEventListener('click', () => {
      // Hide all tab contents
      document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
      });
      
      // Deactivate all buttons
      document.querySelectorAll('.tab-button').forEach(btn => {
        btn.classList.remove('active');
      });
      
      // Show selected tab
      const tabId = button.getAttribute('data-tab');
      document.getElementById(tabId).classList.add('active');
      button.classList.add('active');

      // Store the last active tab
      chrome.storage.local.set({ lastActiveTab: tabId });
    });
  });

  // Restore the last active tab
  chrome.storage.local.get('lastActiveTab', (result) => {
    const tabId = result.lastActiveTab || 'settings';
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
  document.getElementById('clearLogs').addEventListener('click', () => {
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
  debugToggleButton.addEventListener('click', () => {
    const isEnabled = debugLogger.isDebugEnabled();
    debugLogger.setDebugEnabled(!isEnabled);
    debugToggleButton.textContent = isEnabled ? 'Enable Debug' : 'Disable Debug';
    debugToggleButton.classList.toggle('debug-toggle', !isEnabled);
  });

  // Initialize button state
  debugToggleButton.textContent = debugLogger.isDebugEnabled() ? 'Disable Debug' : 'Enable Debug';

  // Subscribe to new logs
  debugLogger.addObserver(() => {
    renderLogs();
  });

  // Initial render
  renderLogs();
}

function renderRefreshList(listEl, rules, onEdit, onDelete) {
  listEl.innerHTML = '';
  (rules || []).forEach((rule, idx) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = `${rule.domain} — every ${rule.seconds}s`;

    const actions = document.createElement('span');
    actions.className = 'actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => onEdit(idx, rule));

    const delBtn = document.createElement('button');
    delBtn.className = 'small';
    delBtn.textContent = 'Delete';
    delBtn.addEventListener('click', () => onDelete(idx));

    actions.appendChild(editBtn);
    actions.appendChild(delBtn);
    li.appendChild(span);
    li.appendChild(actions);
    listEl.appendChild(li);
  });
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

  groups.forEach(group => {
    const li = document.createElement('li');
    const container = document.createElement('div');
    container.style.width = '100%';

    const header = document.createElement('div');
    header.style.fontWeight = '500';
    header.style.marginBottom = '4px';
    header.textContent = `${group.key} (${group.tabs.length} tabs)`;

    container.appendChild(header);

    group.tabs.forEach(tab => {
      const tabDiv = document.createElement('div');
      tabDiv.className = 'small';
      tabDiv.style.cursor = 'pointer';
      tabDiv.style.paddingLeft = '12px';
      tabDiv.style.marginTop = '2px';
      tabDiv.textContent = `${tab.title || 'Untitled'} — ${tab.url || ''}`;
      tabDiv.addEventListener('click', () => onFocusTab(tab.id, tab.windowId));
      container.appendChild(tabDiv);
    });

    li.appendChild(container);
    listEl.appendChild(li);
  });
}

// Initialize the popup
document.addEventListener('DOMContentLoaded', async () => {
  console.log('DOM Content Loaded - Popup initializing...');
  
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
  
  // Request logs from background script
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_LOGS' });
    if (response && response.logs) {
      debugLogger.log('Received logs from background:', response.logs.length);
      response.logs.forEach(log => {
        debugLogger.log(log.message);
      });
    }
  } catch (e) {
    debugLogger.error('Failed to get logs from background:', e);
  }
  
  // Get initial settings
  const settings = await getSettings();
  
  // Highlight toggle
  const highlightCheckbox = document.getElementById('highlightEnabled');
  highlightCheckbox.checked = settings.highlightEnabled;
  highlightCheckbox.addEventListener('change', async () => {
    await setSettings({ highlightEnabled: highlightCheckbox.checked });
  });

  // Refresh rules
  const refreshList = document.getElementById('refreshList');
  const refreshDomain = document.getElementById('refreshDomain');
  const refreshSeconds = document.getElementById('refreshSeconds');
  const refreshAdd = document.getElementById('refreshAdd');

  function renderRefreshRules() {
    renderRefreshList(refreshList, settings.refreshRules, 
      async (idx, rule) => {
        const newDomain = prompt('Domain:', rule.domain);
        if (newDomain === null) return;
        const newSeconds = parseInt(prompt('Seconds:', rule.seconds), 10);
        if (isNaN(newSeconds)) return;
        settings.refreshRules[idx] = { domain: newDomain, seconds: newSeconds };
        await setSettings({ refreshRules: settings.refreshRules });
        renderRefreshRules();
      },
      async (idx) => {
        settings.refreshRules.splice(idx, 1);
        await setSettings({ refreshRules: settings.refreshRules });
        renderRefreshRules();
      }
    );
  }

  renderRefreshRules();

  refreshAdd.addEventListener('click', async () => {
    const domain = refreshDomain.value.trim();
    const seconds = parseInt(refreshSeconds.value, 10);
    if (!domain || isNaN(seconds) || seconds < 15) {
      alert('Please enter a valid domain and seconds (minimum 15)');
      return;
    }
    settings.refreshRules = settings.refreshRules || [];
    settings.refreshRules.push({ domain, seconds });
    await setSettings({ refreshRules: settings.refreshRules });
    renderRefreshRules();
    refreshDomain.value = '';
    refreshSeconds.value = '';
  });

  // Refresh now
  document.getElementById('refreshNow').addEventListener('click', async () => {
    const domainsText = document.getElementById('refreshNowDomains').value.trim();
    const domains = domainsText ? domainsText.split(',').map(d => d.trim()).filter(d => d) : undefined;
    await refreshNowForDomains(domains);
    alert('Refresh triggered for ' + (domains ? domains.join(', ') : 'all domains'));
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

  // Duplicate tabs
  const dupGroups = document.getElementById('dupGroups');
  const dupRefresh = document.getElementById('dupRefresh');
  const dupAlignAll = document.getElementById('dupAlignAll');
  const dupAuto = document.getElementById('dupAuto');

  dupAuto.checked = settings.dupAuto;

  async function renderDupGroups() {
    const groups = await getDuplicateGroups();
    renderDuplicateGroups(dupGroups, groups, async (tabId, windowId) => {
      await focusTab(tabId, windowId);
      window.close();
    });
  }

  renderDupGroups();

  dupRefresh.addEventListener('click', renderDupGroups);
  dupAlignAll.addEventListener('click', async () => {
    await rpc('alignAllByHostname');
    renderDupGroups();
  });

  dupAuto.addEventListener('change', async () => {
    await setSettings({ dupAuto: dupAuto.checked });
  });

  // Auto refresh if enabled
  if (settings.dupAuto) {
    setInterval(renderDupGroups, 5000);
  }
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

// Also set up a periodic poll for logs
setInterval(async () => {
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
