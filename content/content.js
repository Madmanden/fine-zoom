(function() {
  'use strict';

  if (typeof ZoomMethods === 'undefined') {
    console.error('Text Zoom: ZoomMethods not loaded');
    return;
  }

  const isDomainExcluded = (domain, excludedSites) => {
    return excludedSites.some(site => domain === site || domain.endsWith('.' + site));
  };

  const applyZoom = (level, method) => {
    if (!ZoomMethods[method]) {
      console.warn(`Text Zoom: Unknown zoom method: ${method}`);
      return;
    }

    Object.values(ZoomMethods).forEach(m => m.remove());

    if (level !== 1.0) {
      ZoomMethods[method].apply(level);
    }
  };

  const initializeZoom = async () => {
    try {
      const url = new URL(window.location.href);
      const domain = url.hostname;

      const data = await chrome.storage.local.get(['perSiteZoom', 'defaultMethod', 'defaultLevel', 'excludedSites']);

      const excludedSites = data.excludedSites ?? [];
      if (isDomainExcluded(domain, excludedSites)) return;

      const siteConfig = data.perSiteZoom?.[domain];
      const level = siteConfig?.level ?? data.defaultLevel ?? DEFAULT_LEVEL;
      const method = siteConfig?.method ?? data.defaultMethod ?? DEFAULT_METHOD;

      if (level !== 1.0) {
        // Ensure document.documentElement exists before applying
        if (document.documentElement) {
          applyZoom(level, method);
        } else {
          // Fallback for very early execution
          const observer = new MutationObserver(() => {
            if (document.documentElement) {
              applyZoom(level, method);
              observer.disconnect();
            }
          });
          observer.observe(document, { childList: true, subtree: true });
        }
      }
    } catch (e) {
      console.error('Text Zoom: Failed to initialize', e);
    }
  };

  // Run immediately. Since run_at is document_start, document.documentElement
  // might not be available yet, but initializeZoom handles that.
  initializeZoom();

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;

    if (request.action === 'setZoom') {
      applyZoom(request.level, request.method);
      sendResponse({ success: true });
    } else if (request.action === 'getZoom') {
      const url = new URL(window.location.href);
      const domain = url.hostname;

      chrome.storage.local.get(['perSiteZoom', 'defaultLevel', 'defaultMethod'], (data) => {
        const siteConfig = data.perSiteZoom?.[domain];
        sendResponse({
          level: siteConfig?.level ?? data.defaultLevel ?? DEFAULT_LEVEL,
          method: siteConfig?.method ?? data.defaultMethod ?? DEFAULT_METHOD
        });
      });
    }
    return true;
  });
})();