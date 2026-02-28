(function() {
  'use strict';

  if (typeof ZoomMethods === 'undefined') {
    console.error('Fine Zoom: ZoomMethods not loaded');
    return;
  }

  if (window.__fineZoomLoaded) return;
  window.__fineZoomLoaded = true;

  const { isDomainExcluded } = TextZoomUtils;
  const normalizeMethod = (method) => TextZoomUtils.normalizeMethod(method, DEFAULT_METHOD);

  let currentLevel = 1.0;
  let currentMethod = DEFAULT_METHOD;
  let currentDomain = '';
  let isCurrentDomainExcluded = false;
  let isCtrlWheelEnabled = false;
  let isCtrlKeyEnabled = false;
  let didInitializeSettings = false;
  let ctrlWheelAccumulator = 0;
  let pendingWheelSteps = 0;
  let wheelFlushInProgress = false;
  const CTRL_WHEEL_DELTA_THRESHOLD = 70;
  const hasZoomModifier = (event) => {
    return (event.ctrlKey || event.metaKey) && !event.altKey;
  };
  const removeLegacyTransformStyle = () => {
    const legacyStyle = document.getElementById('fine-zoom-transform-style');
    if (legacyStyle) legacyStyle.remove();
  };

  const applyZoom = (level, method) => {
    if (!ZoomMethods[method]) {
      console.warn(`Fine Zoom: Unknown zoom method: ${method}`);
      return false;
    }

    const previousLevel = currentLevel;
    const previousMethod = currentMethod;
    currentLevel = level;
    currentMethod = method;

    try {
      removeLegacyTransformStyle();
      Object.values(ZoomMethods).forEach(m => m.remove());

      if (level !== 1.0) {
        ZoomMethods[method].apply(level);
      }
      return true;
    } catch (error) {
      currentLevel = previousLevel;
      currentMethod = previousMethod;
      console.error('Fine Zoom: Failed to apply zoom method', error);
      return false;
    }
  };

  const flushPendingWheelSteps = async () => {
    if (wheelFlushInProgress) return;
    wheelFlushInProgress = true;

    while (pendingWheelSteps !== 0) {
      const deltaSteps = pendingWheelSteps;
      pendingWheelSteps = 0;

      try {
        const response = await chrome.runtime.sendMessage({
          action: 'adjustZoomByDelta',
          deltaSteps,
          source: 'wheel-hijack'
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
      const data = await chrome.storage.local.get(['enableCtrlWheelHijack', 'enableCtrlKeyHijack']);
      const enabledForPage = !isCurrentDomainExcluded;
      isCtrlWheelEnabled = enabledForPage && (data.enableCtrlWheelHijack ?? true);
      isCtrlKeyEnabled = enabledForPage && (data.enableCtrlKeyHijack ?? true);
    } catch {
      isCtrlWheelEnabled = false;
      isCtrlKeyEnabled = false;
    }
  };

  const setupCtrlWheelHijack = () => {
    window.addEventListener('wheel', (event) => {
      if (!hasZoomModifier(event) || !event.cancelable) return;
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
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  };

  const setupCtrlKeyHijack = () => {
    window.addEventListener('keydown', (event) => {
      if (!hasZoomModifier(event)) return;
      if (!didInitializeSettings || !isCtrlKeyEnabled) return;
      if (isEditableTarget(event.target)) return;

      let command = null;
      const key = event.key;
      const code = event.code;

      if (key === '+' || key === '=' || key === 'Add' || code === 'Equal' || code === 'NumpadAdd') {
        command = 'zoom-in';
      } else if (key === '-' || key === '_' || key === 'Subtract' || code === 'Minus' || code === 'NumpadSubtract') {
        command = 'zoom-out';
      } else if (key === '0' || code === 'Digit0' || code === 'Numpad0') {
        command = 'zoom-reset';
      }

      if (!command) return;

      event.preventDefault();
      event.stopImmediatePropagation();
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
        'excludedSites'
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

      if (level !== 1.0) {
        if (document.documentElement) {
          applyZoom(level, method);
        } else {
          let didApply = false;
          const runApply = () => {
            if (didApply || !document.documentElement) return;
            didApply = true;
            applyZoom(level, method);
            observer.disconnect();
            document.removeEventListener('readystatechange', runApply);
            document.removeEventListener('DOMContentLoaded', runApply);
          };

          const observer = new MutationObserver(runApply);
          observer.observe(document, { childList: true, subtree: true });
          document.addEventListener('readystatechange', runApply);
          document.addEventListener('DOMContentLoaded', runApply);
          setTimeout(() => {
            runApply();
            observer.disconnect();
          }, 3000);
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
  });

  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;

    if (request.action === 'setZoom') {
      const success = applyZoom(request.level, normalizeMethod(request.method));
      sendResponse({ success });
      return;
    } else if (request.action === 'getZoom') {
      chrome.storage.local.get(['perSiteZoom', 'defaultLevel', 'defaultMethod'], (data) => {
        const siteConfig = data.perSiteZoom?.[currentDomain];
        sendResponse({
          level: siteConfig?.level ?? data.defaultLevel ?? DEFAULT_LEVEL,
          method: normalizeMethod(siteConfig?.method ?? data.defaultMethod ?? DEFAULT_METHOD)
        });
      });
      return true;
    }
  });
})();
