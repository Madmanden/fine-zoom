(function() {
  'use strict';
  
  const applyZoom = (level, method) => {
    Object.values(ZoomMethods).forEach(m => m.remove());
    
    if (level !== 1.0 && ZoomMethods[method]) {
      ZoomMethods[method].apply(level);
    }
  };
  
  const initializeZoom = async () => {
    try {
      const url = new URL(window.location.href);
      const domain = url.hostname;
      
      const data = await new Promise((resolve) => {
        chrome.storage.local.get(['perSiteZoom', 'defaultMethod', 'defaultLevel', 'excludedSites'], resolve);
      });
      
      const excludedSites = data.excludedSites || [];
      const isExcluded = excludedSites.some(site => domain.includes(site));
      
      if (isExcluded) return;
      
      const siteConfig = data.perSiteZoom?.[domain];
      const level = siteConfig?.level || data.defaultLevel || 1.0;
      const method = siteConfig?.method || data.defaultMethod || 'css-zoom';
      
      if (level !== 1.0) {
        applyZoom(level, method);
      }
    } catch (e) {
      console.error('Text Zoom: Failed to initialize', e);
    }
  };
  
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeZoom);
  } else {
    initializeZoom();
  }
  
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === 'setZoom') {
      applyZoom(request.level, request.method);
      sendResponse({ success: true });
    } else if (request.action === 'getZoom') {
      const url = new URL(window.location.href);
      const domain = url.hostname;
      
      chrome.storage.local.get(['perSiteZoom', 'defaultLevel', 'defaultMethod'], (data) => {
        const siteConfig = data.perSiteZoom?.[domain];
        sendResponse({
          level: siteConfig?.level || data.defaultLevel || 1.0,
          method: siteConfig?.method || data.defaultMethod || 'css-zoom'
        });
      });
    }
    return true;
  });
})();