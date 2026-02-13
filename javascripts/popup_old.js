// Popup logic for SameTabOpener V1.1
// Manage: highlight toggle, refresh rules (domain+seconds), protect domains, and manual refresh

async function rpc(type, payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...(payload || {}) }, resolve);
  });
}

async function getSettings() {
  return rpc('getSettingsV11');
}

async function setSettings(patch) {
  return rpc('setSettingsV11', { payload: patch });
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

function renderDomainList(listEl, items, onEdit, onDelete) {
  listEl.innerHTML = '';
  (items || []).forEach((item, idx) => {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = item;

    const actions = document.createElement('span');
    actions.className = 'actions';

    const editBtn = document.createElement('button');
    editBtn.className = 'small';
    editBtn.textContent = 'Edit';
    editBtn.addEventListener('click', () => onEdit(idx, item));

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

function renderDupGroups(container, groups) {
  container.innerHTML = '';
  (groups || []).forEach(g => {
    const li = document.createElement('li');

    const headerRow = document.createElement('div');
    headerRow.style.display = 'flex';
    headerRow.style.justifyContent = 'space-between';
    headerRow.style.alignItems = 'center';

    const header = document.createElement('div');
    header.textContent = `${g.key} (${g.count})`;
    header.style.fontWeight = '600';
    headerRow.appendChild(header);

    const actions = document.createElement('div');
    const closeBtn = document.createElement('button');
    closeBtn.className = 'small';
    closeBtn.textContent = 'Close all except one';
    closeBtn.addEventListener('click', async () => {
      // Prefer to keep the active tab in this group if present
      const active = g.tabs.find(t => t.active) || g.tabs[0];
      await rpc('closeDuplicatesExceptOne', { key: g.key, keepTabId: active?.id });
      // Refresh the list after closing
      const res = await getDuplicateGroups();
      if (res && res.ok) renderDupGroups(container, res.groups);
    });
    actions.appendChild(closeBtn);
    headerRow.appendChild(actions);

    li.appendChild(headerRow);

    const ul = document.createElement('ul');
    ul.style.listStyle = 'none';
    ul.style.paddingLeft = '8px';

    g.tabs.forEach(t => {
      const ti = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'small';
      btn.textContent = t.title || t.url;
      btn.title = t.url;
      btn.style.maxWidth = '320px';
      btn.style.overflow = 'hidden';
      btn.style.textOverflow = 'ellipsis';
      btn.style.whiteSpace = 'nowrap';
      btn.addEventListener('click', async () => {
        await focusTab(t.id, t.windowId);
        window.close();
      });
      ti.appendChild(btn);
      ul.appendChild(ti);
    });

    li.appendChild(ul);
    container.appendChild(li);
  });
}

function cleanDomain(val) {
  return (val || '').trim().toLowerCase();
}

function clampSeconds(s) {
  const n = Math.max(15, Math.floor(Number(s) || 0));
  return n;
}

async function init() {
  const els = {
    highlightEnabled: document.getElementById('highlightEnabled'),

    refreshDomain: document.getElementById('refreshDomain'),
    refreshSeconds: document.getElementById('refreshSeconds'),
    refreshAdd: document.getElementById('refreshAdd'),
    refreshList: document.getElementById('refreshList'),
    refreshNowDomains: document.getElementById('refreshNowDomains'),
    refreshNow: document.getElementById('refreshNow'),

    protectDomain: document.getElementById('protectDomain'),
    protectAdd: document.getElementById('protectAdd'),
    protectList: document.getElementById('protectList'),

    dupAlignAll: document.getElementById('dupAlignAll'),
    dupRefresh: document.getElementById('dupRefresh'),
    dupGroups: document.getElementById('dupGroups'),
    dupAuto: document.getElementById('dupAuto'),
  };

  let settings = await getSettings();
  if (!settings) settings = { highlightEnabled: true, refreshRules: [], protectDomains: [] };
  settings.refreshRules = settings.refreshRules || [];
  settings.protectDomains = settings.protectDomains || [];

  // Highlight toggle
  els.highlightEnabled.checked = !!settings.highlightEnabled;
  els.highlightEnabled.addEventListener('change', async (e) => {
    settings.highlightEnabled = e.target.checked;
    await setSettings({ highlightEnabled: settings.highlightEnabled });
  });

  // Render Refresh Rules
  async function onEditRefreshRule(idx, oldRule) {
    const d = prompt('Domain', oldRule?.domain || '');
    if (d == null) return;
    const domain = cleanDomain(d);
    if (!domain) return;
    const s = prompt('Interval (seconds, min 15)', String(oldRule?.seconds || 60));
    if (s == null) return;
    const seconds = clampSeconds(s);
    const next = [...settings.refreshRules];
    next[idx] = { domain, seconds };
    settings.refreshRules = next;
    await setSettings({ refreshRules: next });
    renderRefreshList(els.refreshList, next, onEditRefreshRule, onDeleteRefreshRule);
  }
  async function onDeleteRefreshRule(idx) {
    const next = [...settings.refreshRules];
    next.splice(idx, 1);
    settings.refreshRules = next;
    await setSettings({ refreshRules: next });
    renderRefreshList(els.refreshList, next, onEditRefreshRule, onDeleteRefreshRule);
  }
  renderRefreshList(els.refreshList, settings.refreshRules, onEditRefreshRule, onDeleteRefreshRule);

  els.refreshAdd.addEventListener('click', async () => {
    const domain = cleanDomain(els.refreshDomain.value);
    const seconds = clampSeconds(els.refreshSeconds.value);
    if (!domain || !seconds) return;
    const next = [...settings.refreshRules];
    const existingIdx = next.findIndex(r => r.domain === domain);
    if (existingIdx >= 0) next[existingIdx] = { domain, seconds }; else next.push({ domain, seconds });
    settings.refreshRules = next;
    await setSettings({ refreshRules: next });
    renderRefreshList(els.refreshList, next, onEditRefreshRule, onDeleteRefreshRule);
    els.refreshDomain.value = '';
    els.refreshSeconds.value = '';
  });

  els.refreshNow.addEventListener('click', async () => {
    const raw = els.refreshNowDomains.value.trim();
    const domains = raw ? raw.split(',').map(cleanDomain).filter(Boolean) : settings.refreshRules.map(r => r.domain);
    await refreshNowForDomains(domains);
    window.close();
  });

  // Render Protect Domains
  async function onEditProtect(idx, oldValue) {
    const v = prompt('Edit domain', oldValue || '');
    if (v == null) return;
    const domain = cleanDomain(v);
    if (!domain) return;
    const next = [...settings.protectDomains];
    next[idx] = domain;
    settings.protectDomains = next;
    await setSettings({ protectDomains: next });
    renderDomainList(els.protectList, next, onEditProtect, onDeleteProtect);
  }
  async function onDeleteProtect(idx) {
    const next = [...settings.protectDomains];
    next.splice(idx, 1);
    settings.protectDomains = next;
    await setSettings({ protectDomains: next });
    renderDomainList(els.protectList, next, onEditProtect, onDeleteProtect);
  }
  renderDomainList(els.protectList, settings.protectDomains, onEditProtect, onDeleteProtect);

  els.protectAdd.addEventListener('click', async () => {
    const domain = cleanDomain(els.protectDomain.value);
    if (!domain) return;
    const next = Array.from(new Set([...(settings.protectDomains || []), domain]));
    settings.protectDomains = next;
    await setSettings({ protectDomains: next });
    renderDomainList(els.protectList, next, onEditProtect, onDeleteProtect);
    els.protectDomain.value = '';
  });

  async function refreshDuplicatesUI(){
    const res = await getDuplicateGroups();
    if (res && res.ok) renderDupGroups(els.dupGroups, res.groups);
  }

  els.dupRefresh.addEventListener('click', refreshDuplicatesUI);

  els.dupAlignAll.addEventListener('click', async () => {
    await rpc('alignAllByHostname');
    await refreshDuplicatesUI();
  });

  // Auto refresh toggle (session-scoped)
  let dupTimer = null;
  els.dupAuto.addEventListener('change', (e)=>{
    if (dupTimer) { clearInterval(dupTimer); dupTimer = null; }
    if (e.target.checked){
      refreshDuplicatesUI();
      dupTimer = setInterval(refreshDuplicatesUI, 5000);
    }
  });

  // Optional: pre-load once when popup opens
  refreshDuplicatesUI();
}

window.addEventListener('DOMContentLoaded', init);
