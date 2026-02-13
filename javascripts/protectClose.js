// Content script for SameTabOpener V1.1
// Purpose: prevent accidental close/reload on configured domains using beforeunload
// Note: Chrome only shows beforeunload prompts after a user gesture on the page.
// To make behavior consistent after refresh, we install the handler after the first user gesture.

(function() {
  let userInteracted = false;
  let protectInstalled = false;

  function getSettings() {
    return new Promise(resolve => {
      try {
        chrome.storage.sync.get({ protectDomains: [] }, resolve);
      } catch (e) {
        resolve({ protectDomains: [] });
      }
    });
  }

  function hostnameMatches(hostname, domain) {
    if (!domain) return false;
    const d = domain.trim().toLowerCase();
    if (!d) return false;
    const h = (hostname || '').toLowerCase();
    return h === d || h.endsWith('.' + d);
  }

  function shouldProtect(hostname, protectDomains) {
    return Array.isArray(protectDomains) && protectDomains.some(d => hostnameMatches(hostname, d));
  }

  function installBeforeUnload() {
    if (window.__sto_protect_installed) return;
    window.__sto_protect_installed = true;
    protectInstalled = true;
    
    // Notify background script
    try {
      chrome.runtime.sendMessage({
        type: 'protectCloseInstalled',
        hostname: location.hostname
      });
    } catch (e) {
      // Ignore if background is not available
    }
    
    window.addEventListener('beforeunload', function(e) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    });
  }

  function ensureInstalledIfAllowed(protectDomains) {
    const host = location.hostname;
    if (!shouldProtect(host, protectDomains)) return;

    // Chrome requires a user gesture for beforeunload prompts to appear.
    if (userInteracted) {
      installBeforeUnload();
    }
  }

  function markInteractedAndInstall(protectDomains) {
    if (userInteracted) return;
    userInteracted = true;
    console.log('[ProtectClose] User interacted, installing protection if needed');
    ensureInstalledIfAllowed(protectDomains);
  }

  // Manual check function that can be called from console
  window.checkCloseProtection = async function() {
    try {
      const settings = await getSettings();
      const domains = settings.protectDomains || [];
      const protected = shouldProtect(location.hostname, domains);
      
      console.log('[ProtectClose] Manual check:');
      console.log('  Hostname:', location.hostname);
      console.log('  Domains:', domains);
      console.log('  Protected:', protected);
      console.log('  User interacted:', userInteracted);
      console.log('  Protection installed:', window.__sto_protect_installed);
      
      if (protected && !window.__sto_protect_installed && userInteracted) {
        console.log('[ProtectClose] Installing protection now...');
        installBeforeUnload();
      }
    } catch (e) {
      console.error('[ProtectClose] Manual check failed:', e);
    }
  };

  (async () => {
    try {
      // Try multiple times to get settings in case of sync issues
      let { protectDomains = [] } = await getSettings();
      
      // Log initial attempt
      console.log('[ProtectClose] Initial settings load:', protectDomains);
      
      // If empty, retry multiple times with increasing delays
      if (protectDomains.length === 0) {
        const delays = [500, 1000, 2000];
        for (const delay of delays) {
          console.log(`[ProtectClose] Retrying settings load after ${delay}ms...`);
          await new Promise(resolve => setTimeout(resolve, delay));
          const retry = await getSettings();
          if (retry.protectDomains && retry.protectDomains.length > 0) {
            protectDomains = retry.protectDomains;
            console.log('[ProtectClose] Settings loaded after retry:', protectDomains);
            break;
          }
        }
      }
      
      // Final check - also try direct storage access
      if (protectDomains.length === 0) {
        try {
          const direct = await chrome.storage.sync.get('protectDomains');
          protectDomains = direct.protectDomains || [];
          console.log('[ProtectClose] Direct storage access:', protectDomains);
        } catch (e) {
          console.error('[ProtectClose] Direct storage access failed:', e);
        }
      }
      
      // Log current state
      try {
        chrome.runtime.sendMessage({
          type: 'protectCloseStatus',
          hostname: location.hostname,
          protected: shouldProtect(location.hostname, protectDomains),
          domains: protectDomains
        });
      } catch (e) {
        // Ignore if background is not available
      }

      // If user has already interacted by the time we run, try install.
      ensureInstalledIfAllowed(protectDomains);

      // Listen for the first user gesture after load/refresh, then install.
      const onFirstGesture = () => markInteractedAndInstall(protectDomains);
      ['click', 'keydown', 'touchstart', 'pointerdown'].forEach(evt => {
        document.addEventListener(evt, onFirstGesture, { once: true, capture: true });
      });

      // React live to domain list changes
      try {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'sync' || !changes.protectDomains) return;
          const next = changes.protectDomains.newValue || [];
          
          console.log('[ProtectClose] Storage changed:', next);
          
          // Log domain change
          try {
            chrome.runtime.sendMessage({
              type: 'protectCloseDomainsChanged',
              hostname: location.hostname,
              oldDomains: changes.protectDomains.oldValue || [],
              newDomains: next,
              nowProtected: shouldProtect(location.hostname, next)
            });
          } catch (e) {
            // Ignore if background is not available
          }
          
          ensureInstalledIfAllowed(next);
        });
        
        // Also listen for direct messages from background
        chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
          if (message.type === 'settingsUpdated' && message.protectDomains) {
            console.log('[ProtectClose] Settings updated via message:', message.protectDomains);
            
            // Log domain change
            try {
              chrome.runtime.sendMessage({
                type: 'protectCloseDomainsChanged',
                hostname: location.hostname,
                oldDomains: [], // We don't know the old value
                newDomains: message.protectDomains,
                nowProtected: shouldProtect(location.hostname, message.protectDomains)
              });
            } catch (e) {
              // Ignore if background is not available
            }
            
            ensureInstalledIfAllowed(message.protectDomains);
          }
        });
      } catch {}
    } catch (e) {
      console.error('[ProtectClose] Error initializing:', e);
    }
  })();
})();
