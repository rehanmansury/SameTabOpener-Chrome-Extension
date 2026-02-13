// Content script bridge for SameTabOpener V1.1 (copied from V1.0)
// - Handles 'route' by forwarding to page via window.postMessage
// - Handles 'search' by opening Zendesk search dialog, typing, and pressing Enter

(function() {
  function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

  function setValueAndEnter(input, value) {
    try {
      input.focus();
      input.value = value;
      const inputEvent = new Event('input', { bubbles: true });
      input.dispatchEvent(inputEvent);

      // Keydown/keyup Enter to trigger search
      const kd = new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true });
      const ku = new KeyboardEvent('keyup',   { key: 'Enter', code: 'Enter', which: 13, keyCode: 13, bubbles: true });
      input.dispatchEvent(kd);
      input.dispatchEvent(ku);

      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  }

  function tryFindSearchInput() {
    let el = document.querySelector('input[data-test-id="search-dialog-input"]');
    if (el) return el;
    el = document.querySelector('input[placeholder*="search Zendesk" i]');
    if (el) return el;
    el = document.querySelector('input[role="combobox"][aria-controls="search-dialog-matches"]');
    if (el) return el;
    try {
      const xp = '/html/body/div[2]/div[5]/header/div[2]/div/div/div[2]/div/div/div/div/div/input';
      const r = document.evaluate(xp, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
      if (r && r.singleNodeValue) return r.singleNodeValue;
    } catch {}
    return null;
  }

  async function openSearchDialogIfNeeded() {
    if (tryFindSearchInput()) return true;

    // Strategy 1: Send '/' to open global search
    const slashDown = new KeyboardEvent('keydown', { key: '/', code: 'Slash', which: 191, keyCode: 191, bubbles: true });
    const slashUp   = new KeyboardEvent('keyup',   { key: '/', code: 'Slash', which: 191, keyCode: 191, bubbles: true });
    document.activeElement?.dispatchEvent(slashDown);
    document.activeElement?.dispatchEvent(slashUp);

    for (let i = 0; i < 10; i++) {
      const el = tryFindSearchInput(); if (el) return true; await sleep(100);
    }

    // Strategy 2: try focusing header then sending '/'
    const header = document.querySelector('header') || document.body;
    header.focus?.();
    header.dispatchEvent(slashDown);
    header.dispatchEvent(slashUp);

    for (let i = 0; i < 10; i++) {
      const el = tryFindSearchInput(); if (el) return true; await sleep(100);
    }

    return false;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	if (message.target === 'pressKey') {
    try {
        const event = new KeyboardEvent('keydown', {
            key: message.key,
            code: message.key === '/' ? 'Slash' : message.key,
            keyCode: message.key.charCodeAt(0),
            which: message.key.charCodeAt(0),
            ctrlKey: message.ctrlKey || false,
            metaKey: message.metaKey || false,
            shiftKey: message.shiftKey || false,
            altKey: message.altKey || false,
            bubbles: true,
            cancelable: true
        });
        document.dispatchEvent(event);
        sendResponse({ ok: true });
    } catch (e) {
        console.error('Error in pressKey:', e);
        sendResponse({ ok: false, error: String(e) });
    }
    return true;
}
 
if (message.target === 'typeAndSubmit') {
    try {
        // Find the search input field
        const searchInput = document.querySelector('input[data-test-id="search-dialog-input"]') ||
                          document.querySelector('input[placeholder*="search" i]') ||
                          document.querySelector('input[role="combobox"]') ||
                          document.activeElement;
        
        if (searchInput) {
            // Type the text
            searchInput.value = message.text;
            
            // Trigger input events
            const inputEvent = new Event('input', { bubbles: true });
            searchInput.dispatchEvent(inputEvent);
            
            // Press Enter
            const enterEvent = new KeyboardEvent('keydown', {
                key: 'Enter',
                code: 'Enter',
                keyCode: 13,
                which: 13,
                bubbles: true,
                cancelable: true
            });
            searchInput.dispatchEvent(enterEvent);
            sendResponse({ ok: true });
        } else {
            sendResponse({ ok: false, error: 'Search input not found' });
        }
    } catch (e) {
        console.error('Error in typeAndSubmit:', e);
        sendResponse({ ok: false, error: String(e) });
    }
    return true;
    }  
	  
	  
	  
    if (!message || !message.__quicktab) return;

    if (message.target === 'route') {
      try {
        window.postMessage(JSON.stringify(message), '*');
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return true;
    }

    if (message.target === 'navigateHash') {
      try {
        const hash = typeof message.hash === 'string' ? message.hash : '';
        if (!hash) { sendResponse({ ok: false, error: 'hash missing' }); return true; }
        const next = hash.startsWith('#') ? hash : ('#' + hash);

        // Avoid unnecessary route churn
        if (location.hash === next) { sendResponse({ ok: true, same: true }); return true; }

        // Ensure we are on /agent/ base path before applying hash.
        // Otherwise we can end up with URLs like /agent/tickets/123#/tickets/456
        const desiredPath = '/agent/';
        if (location.pathname.toLowerCase() !== desiredPath) {
          try {
            history.replaceState(history.state, '', desiredPath + next);
          } catch {
            // If replaceState fails, fallback to hash-only.
          }
        }

        // Apply hash navigation (SPA-friendly, no page unload)
        location.hash = next;

        // Some routers respond better to popstate/hashchange
        try { window.dispatchEvent(new PopStateEvent('popstate')); } catch { try { window.dispatchEvent(new Event('popstate')); } catch {} }
        try { window.dispatchEvent(new HashChangeEvent('hashchange')); } catch { try { window.dispatchEvent(new Event('hashchange')); } catch {} }
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return true;
    }

    if (message.target === 'search') {
      (async () => {
        const opened = await openSearchDialogIfNeeded();
        if (!opened) { sendResponse({ ok: false, error: 'search dialog not opened' }); return; }
        await sleep(50);
        const el = tryFindSearchInput();
        if (!el) { sendResponse({ ok: false, error: 'search input not found' }); return; }
        const res = setValueAndEnter(el, message.query || '');
        sendResponse(res);
      })();
      return true; // async response
    }
  });
})();
