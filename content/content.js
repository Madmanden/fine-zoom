(function() {
  'use strict';

  if (typeof ZoomMethods === 'undefined') {
    console.error('Text Zoom: ZoomMethods not loaded');
    return;
  }

  const { isDomainExcluded } = TextZoomUtils;
  const normalizeMethod = (method) => TextZoomUtils.normalizeMethod(method, DEFAULT_METHOD);

  let currentLevel = 1.0;
  let currentMethod = DEFAULT_METHOD;
  let debugHighlightScaledText = DEFAULT_DEBUG_HIGHLIGHT;
  let currentDomain = '';
  let isCurrentDomainExcluded = false;
  let didInitializeSettings = false;
  let ctrlWheelAccumulator = 0;
  let pendingWheelSteps = 0;
  let wheelFlushInProgress = false;
  const CTRL_WHEEL_STEP = ZOOM_STEP;
  const CTRL_WHEEL_DELTA_THRESHOLD = 100;
  const removeLegacyTransformStyle = () => {
    const legacyStyle = document.getElementById('text-zoom-transform-style');
    if (legacyStyle) legacyStyle.remove();
  };

  const applyDebugFlag = () => {
    if (!document.documentElement) return;
    document.documentElement.setAttribute(
      'data-text-zoom-debug-highlight',
      debugHighlightScaledText ? '1' : '0'
    );
  };

  const applyZoom = (level, method) => {
    if (!ZoomMethods[method]) {
      console.warn(`Text Zoom: Unknown zoom method: ${method}`);
      return;
    }

    currentLevel = level;
    currentMethod = method;

    removeLegacyTransformStyle();
    Object.values(ZoomMethods).forEach(m => m.remove());

    if (level !== 1.0) {
      ZoomMethods[method].apply(level);
    }
  };

  const flushPendingWheelSteps = async () => {
    if (wheelFlushInProgress) return;
    wheelFlushInProgress = true;

    while (pendingWheelSteps !== 0) {
      const direction = pendingWheelSteps > 0 ? 1 : -1;
      pendingWheelSteps -= direction;

      try {
        const response = await chrome.runtime.sendMessage({
          action: 'adjustZoomByDelta',
          delta: direction * CTRL_WHEEL_STEP
        });
        if (response?.success && typeof response.level === 'number') {
          currentLevel = response.level;
        }
      } catch (error) {
        console.error('Text Zoom: Failed to adjust zoom from Ctrl+Wheel', error);
        pendingWheelSteps = 0;
      }
    }

    wheelFlushInProgress = false;
  };

  const setupCtrlWheelHijack = () => {
    window.addEventListener('wheel', (event) => {
      if (!event.ctrlKey || !event.cancelable) return;
      if (!didInitializeSettings || isCurrentDomainExcluded) return;

      event.preventDefault();

      const unitScale = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? window.innerHeight : 1);
      ctrlWheelAccumulator += event.deltaY * unitScale;

      if (ctrlWheelAccumulator <= -CTRL_WHEEL_DELTA_THRESHOLD) {
        const steps = Math.floor(Math.abs(ctrlWheelAccumulator) / CTRL_WHEEL_DELTA_THRESHOLD);
        pendingWheelSteps += steps;
        ctrlWheelAccumulator += steps * CTRL_WHEEL_DELTA_THRESHOLD;
      } else if (ctrlWheelAccumulator >= CTRL_WHEEL_DELTA_THRESHOLD) {
        const steps = Math.floor(ctrlWheelAccumulator / CTRL_WHEEL_DELTA_THRESHOLD);
        pendingWheelSteps -= steps;
        ctrlWheelAccumulator -= steps * CTRL_WHEEL_DELTA_THRESHOLD;
      }

      if (pendingWheelSteps !== 0) {
        void flushPendingWheelSteps();
      }
    }, { capture: true, passive: false });
  };

  const initializeZoom = async () => {
    try {
      const url = new URL(window.location.href);
      const domain = url.hostname;
      currentDomain = domain;

      const data = await chrome.storage.local.get([
        'perSiteZoom',
        'defaultMethod',
        'defaultLevel',
        'excludedSites',
        'debugHighlightScaledText'
      ]);

      const excludedSites = data.excludedSites ?? [];
      isCurrentDomainExcluded = isDomainExcluded(domain, excludedSites);
      if (isCurrentDomainExcluded) return;

      const siteConfig = data.perSiteZoom?.[domain];
      const level = siteConfig?.level ?? data.defaultLevel ?? DEFAULT_LEVEL;
      const method = normalizeMethod(siteConfig?.method ?? data.defaultMethod ?? DEFAULT_METHOD);
      debugHighlightScaledText = data.debugHighlightScaledText ?? DEFAULT_DEBUG_HIGHLIGHT;
      applyDebugFlag();

      if (level !== 1.0) {
        // Ensure document.documentElement exists before applying
        if (document.documentElement) {
          applyZoom(level, method);
        } else {
          // Fallback for very early execution
          const observer = new MutationObserver(() => {
            if (document.documentElement) {
              applyDebugFlag();
              applyZoom(level, method);
              observer.disconnect();
            }
          });
          observer.observe(document, { childList: true, subtree: true });
        }
      }
    } catch (e) {
      console.error('Text Zoom: Failed to initialize', e);
    } finally {
      didInitializeSettings = true;
    }
  };

  setupCtrlWheelHijack();

  // Run immediately. Since run_at is document_start, document.documentElement
  // might not be available yet, but initializeZoom handles that.
  initializeZoom();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.excludedSites && currentDomain) {
      const excludedSites = changes.excludedSites.newValue ?? [];
      isCurrentDomainExcluded = isDomainExcluded(currentDomain, excludedSites);
    }
    if (!changes.debugHighlightScaledText) return;
    debugHighlightScaledText = changes.debugHighlightScaledText.newValue ?? DEFAULT_DEBUG_HIGHLIGHT;
    applyDebugFlag();
    if (currentMethod === 'font-size' && currentLevel !== 1.0) {
      applyZoom(currentLevel, currentMethod);
    }
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;

    if (request.action === 'setZoom') {
      applyZoom(request.level, normalizeMethod(request.method));
      sendResponse({ success: true });
    } else if (request.action === 'getZoom') {
      const url = new URL(window.location.href);
      const domain = url.hostname;

      chrome.storage.local.get(['perSiteZoom', 'defaultLevel', 'defaultMethod'], (data) => {
        const siteConfig = data.perSiteZoom?.[domain];
        sendResponse({
          level: siteConfig?.level ?? data.defaultLevel ?? DEFAULT_LEVEL,
          method: normalizeMethod(siteConfig?.method ?? data.defaultMethod ?? DEFAULT_METHOD)
        });
      });
    }
    return true;
  });
})();
