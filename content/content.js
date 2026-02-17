(function() {
  'use strict';

  if (typeof ZoomMethods === 'undefined') {
    console.error('Fine Zoom: ZoomMethods not loaded');
    return;
  }

  const { isDomainExcluded } = TextZoomUtils;
  const normalizeMethod = (method) => TextZoomUtils.normalizeMethod(method, DEFAULT_METHOD);

  let currentLevel = 1.0;
  let currentMethod = DEFAULT_METHOD;
  let debugHighlightScaledText = DEFAULT_DEBUG_HIGHLIGHT;
  let currentDomain = '';
  let isCurrentDomainExcluded = false;
  let isCtrlWheelEnabled = false;
  let isCtrlKeyEnabled = false;
  let didInitializeSettings = false;
  let ctrlWheelAccumulator = 0;
  let pendingWheelSteps = 0;
  let wheelFlushInProgress = false;
  const CTRL_WHEEL_STEP = ZOOM_STEP;
  const CTRL_WHEEL_DELTA_THRESHOLD = 100;
  const removeLegacyTransformStyle = () => {
    const legacyStyle = document.getElementById('fine-zoom-transform-style');
    if (legacyStyle) legacyStyle.remove();
  };

  const applyDebugFlag = () => {
    if (!document.documentElement) return;
    document.documentElement.setAttribute(
      'data-fine-zoom-debug-highlight',
      debugHighlightScaledText ? '1' : '0'
    );
  };

  const applyZoom = (level, method) => {
    if (!ZoomMethods[method]) {
      console.warn(`Fine Zoom: Unknown zoom method: ${method}`);
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
        console.error('Fine Zoom: Failed to adjust zoom from Ctrl+Wheel', error);
        pendingWheelSteps = 0;
      }
    }

    wheelFlushInProgress = false;
  };

  const refreshHijackEligibility = async () => {
    try {
      const response = await chrome.runtime.sendMessage({ action: 'getHijackEligibility' });
      isCtrlWheelEnabled = Boolean(response?.success && response?.ctrlWheelEnabled);
      isCtrlKeyEnabled = Boolean(response?.success && response?.ctrlKeyEnabled);
    } catch {
      isCtrlWheelEnabled = false;
      isCtrlKeyEnabled = false;
    }
  };

  const setupCtrlWheelHijack = () => {
    window.addEventListener('wheel', (event) => {
      if (!event.ctrlKey || !event.cancelable) return;
      if (!didInitializeSettings || !isCtrlWheelEnabled) return;

      event.preventDefault();

      const wheelUpdate = TextZoomUtils.accumulateCtrlWheelSteps({
        accumulator: ctrlWheelAccumulator,
        deltaY: event.deltaY,
        deltaMode: event.deltaMode,
        viewportHeight: window.innerHeight,
        threshold: CTRL_WHEEL_DELTA_THRESHOLD
      });
      ctrlWheelAccumulator = wheelUpdate.accumulator;
      pendingWheelSteps += wheelUpdate.steps;

      if (pendingWheelSteps !== 0) {
        void flushPendingWheelSteps();
      }
    }, { capture: true, passive: false });
  };

  const isEditableTarget = (target) => {
    if (!(target instanceof Element)) return false;
    if (target.closest('[contenteditable="true"]')) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  };

  const setupCtrlKeyHijack = () => {
    window.addEventListener('keydown', (event) => {
      if (!event.ctrlKey || event.altKey) return;
      if (!didInitializeSettings || !isCtrlKeyEnabled) return;
      if (isEditableTarget(event.target)) return;

      let command = null;
      const key = event.key;
      const code = event.code;

      if (key === '+' || key === '=' || code === 'NumpadAdd') {
        command = 'zoom-in';
      } else if (key === '-' || key === '_' || code === 'NumpadSubtract') {
        command = 'zoom-out';
      } else if (key === '0' || code === 'Digit0' || code === 'Numpad0') {
        command = 'zoom-reset';
      }

      if (!command) return;

      event.preventDefault();
      void chrome.runtime.sendMessage({ action: 'adjustZoomByCommand', command })
        .then((response) => {
          if (response?.success && typeof response.level === 'number') {
            currentLevel = response.level;
          }
        })
        .catch((error) => {
          console.error('Fine Zoom: Failed to adjust zoom from Ctrl+key', error);
        });
    }, { capture: true });
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
      await refreshHijackEligibility();

      if (isCurrentDomainExcluded) {
        didInitializeSettings = true;
        return;
      }

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

      didInitializeSettings = true;
    } catch (e) {
      console.error('Fine Zoom: Failed to initialize', e);
    }
  };

  setupCtrlWheelHijack();
  setupCtrlKeyHijack();

  // Run immediately. Since run_at is document_start, document.documentElement
  // might not be available yet, but initializeZoom handles that.
  initializeZoom();

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (changes.excludedSites && currentDomain) {
      const excludedSites = changes.excludedSites.newValue ?? [];
      isCurrentDomainExcluded = isDomainExcluded(currentDomain, excludedSites);
      void refreshHijackEligibility();
    }
    if (changes.enableCtrlWheelHijack || changes.enableCtrlKeyHijack) {
      void refreshHijackEligibility();
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
