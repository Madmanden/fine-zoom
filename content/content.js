(function() {
  'use strict';

  if (typeof ZoomMethods === 'undefined') {
    console.error('Fine Zoom: ZoomMethods not loaded');
    return;
  }

  const previousInstance = window.__fineZoomInstance;
  if (previousInstance) {
    let isAlive = false;
    try {
      isAlive = previousInstance.isAlive();
    } catch {
      isAlive = false;
    }

    if (isAlive) return;

    try {
      previousInstance.teardown();
    } catch {
      // The previous instance belongs to a dead extension context; ignore.
    }
  }

  const { isDomainExcluded } = TextZoomUtils;
  const normalizeMethod = (method) => TextZoomUtils.normalizeMethod(method, DEFAULT_METHOD);

  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  const CTRL_WHEEL_DELTA_THRESHOLD = 70;
  const INPUT_INTENT_THROTTLE_MS = 80;
  const STEP_FLUSH_DELAY_MS = 40;
  const HUD_VISIBLE_MS = 900;

  let currentLevel = 1.0;
  let currentMethod = DEFAULT_METHOD;
  let currentDomain = '';
  let isCurrentDomainExcluded = false;
  let isCtrlWheelEnabled = false;
  let isCtrlKeyEnabled = false;
  let isHudEnabled = true;
  let didInitializeSettings = false;
  let ctrlWheelAccumulator = 0;
  let pendingWheelSteps = 0;
  let pendingKeySteps = 0;
  let pendingReset = false;
  let stepFlushTimer = null;
  let stepFlushInProgress = false;
  let lastWheelIntentAt = 0;
  let lastKeyIntentAt = 0;
  let hudElement = null;
  let hudHideTimer = null;

  const isRuntimeAlive = () => {
    try {
      return typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.id != null;
    } catch {
      return false;
    }
  };

  const hasZoomModifier = (event) => {
    if (event.altKey) return false;
    if (IS_MAC) return event.ctrlKey || event.metaKey;
    return event.ctrlKey && !event.metaKey;
  };

  const resolveZoomCommand = (event) => {
    const key = event.key;
    const code = event.code;

    if (key === '+' || key === '=' || key === 'Add' || code === 'Equal' || code === 'NumpadAdd') {
      return 'zoom-in';
    }
    if (key === '-' || key === '_' || key === 'Subtract' || code === 'Minus' || code === 'NumpadSubtract') {
      return 'zoom-out';
    }
    if (key === '0' || code === 'Digit0' || code === 'Numpad0') {
      return 'zoom-reset';
    }
    return null;
  };

  const isEditableTarget = (target) => {
    if (!(target instanceof Element)) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  };

  const sendZoomInputIntent = (kind, command) => {
    void chrome.runtime.sendMessage({ action: 'recordZoomInputIntent', kind, command }).catch(() => {});
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

  const ensureHudElement = () => {
    if (!isHudEnabled || !document.documentElement) return null;
    if (hudElement && hudElement.isConnected) return hudElement;

    hudElement = document.createElement('div');
    hudElement.setAttribute('aria-hidden', 'true');
    hudElement.style.cssText = [
      'position:fixed',
      'left:50%',
      'bottom:24px',
      'transform:translateX(-50%)',
      'z-index:2147483647',
      'pointer-events:none',
      'background:rgba(17,17,17,.88)',
      'color:#fff',
      'font:600 13px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif',
      'padding:8px 12px',
      'border-radius:999px',
      'opacity:0',
      'transition:opacity 120ms ease-out',
      'box-shadow:0 2px 8px rgba(0,0,0,.25)'
    ].join(';');
    document.documentElement.appendChild(hudElement);
    return hudElement;
  };

  const showZoomHud = (level) => {
    if (!isHudEnabled || typeof level !== 'number' || !Number.isFinite(level)) return;

    const hud = ensureHudElement();
    if (!hud) return;

    hud.textContent = `${Math.round(level * 100)}%`;
    hud.style.opacity = '1';

    if (hudHideTimer) clearTimeout(hudHideTimer);
    hudHideTimer = setTimeout(() => {
      if (hudElement) hudElement.style.opacity = '0';
    }, HUD_VISIBLE_MS);
  };

  const flushPendingSteps = async () => {
    if (stepFlushInProgress) return;
    stepFlushInProgress = true;

    try {
      while (pendingKeySteps !== 0 || pendingWheelSteps !== 0 || pendingReset) {
        let payload;

        if (pendingKeySteps !== 0) {
          payload = { action: 'adjustZoomByDelta', deltaSteps: pendingKeySteps, source: 'key-hijack' };
          pendingKeySteps = 0;
        } else if (pendingWheelSteps !== 0) {
          payload = { action: 'adjustZoomByDelta', deltaSteps: pendingWheelSteps, source: 'wheel-hijack' };
          pendingWheelSteps = 0;
        } else {
          pendingReset = false;
          payload = { action: 'adjustZoomByCommand', command: 'zoom-reset' };
        }

        try {
          const response = await chrome.runtime.sendMessage(payload);
          if (response?.success && typeof response.level === 'number') {
            currentLevel = response.level;
            showZoomHud(response.level);
          }
        } catch (error) {
          pendingWheelSteps = 0;
          pendingKeySteps = 0;
          pendingReset = false;

          if (!isRuntimeAlive()) {
            teardown();
            return;
          }

          console.error('Fine Zoom: Failed to adjust zoom from hijacked input', error);
        }
      }
    } finally {
      stepFlushInProgress = false;
    }
  };

  const scheduleStepFlush = () => {
    if (stepFlushTimer) return;
    stepFlushTimer = setTimeout(() => {
      stepFlushTimer = null;
      void flushPendingSteps();
    }, STEP_FLUSH_DELAY_MS);
  };

  // Capture phase: observe zoom input so the background worker can remap
  // browser-handled zoom changes even when a page consumes the event.
  const handleWheelIntent = (event) => {
    if (!hasZoomModifier(event)) return;
    if (!didInitializeSettings || !isCtrlWheelEnabled) return;

    if (Date.now() - lastWheelIntentAt > INPUT_INTENT_THROTTLE_MS) {
      lastWheelIntentAt = Date.now();
      sendZoomInputIntent('wheel');
    }
  };

  // Bubble phase: only hijack when the page did not handle the gesture.
  const handleWheelHijack = (event) => {
    if (!hasZoomModifier(event)) return;
    if (!didInitializeSettings || !isCtrlWheelEnabled) return;
    if (event.defaultPrevented || !event.cancelable) return;

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
      void flushPendingSteps();
    }
  };

  const handleKeyIntent = (event) => {
    if (!hasZoomModifier(event)) return;
    if (!didInitializeSettings || !isCtrlKeyEnabled) return;

    const command = resolveZoomCommand(event);
    if (!command) return;

    if (Date.now() - lastKeyIntentAt > INPUT_INTENT_THROTTLE_MS) {
      lastKeyIntentAt = Date.now();
      sendZoomInputIntent('key', command);
    }
  };

  const handleKeyHijack = (event) => {
    if (!hasZoomModifier(event)) return;
    if (!didInitializeSettings || !isCtrlKeyEnabled) return;
    if (event.defaultPrevented) return;

    const command = resolveZoomCommand(event);
    if (!command) return;

    // Text fields and editors keep their own behavior. The intent recorded
    // above still lets the background worker fine-tune the resulting native
    // zoom instead of relying on browser presets.
    if (isEditableTarget(event.target)) return;

    event.preventDefault();

    if (command === 'zoom-reset') {
      pendingReset = true;
      void flushPendingSteps();
      return;
    }

    pendingKeySteps += command === 'zoom-in' ? 1 : -1;
    scheduleStepFlush();
  };

  const handleKeyUp = (event) => {
    if (pendingKeySteps === 0) return;

    const command = resolveZoomCommand(event);
    if (!command || command === 'zoom-reset') return;

    if (stepFlushTimer) {
      clearTimeout(stepFlushTimer);
      stepFlushTimer = null;
    }
    void flushPendingSteps();
  };

  const refreshSettings = async () => {
    try {
      const data = await chrome.storage.local.get([
        'enableCtrlWheelHijack',
        'enableCtrlKeyHijack',
        'enableZoomHud'
      ]);
      const enabledForPage = !isCurrentDomainExcluded;
      isCtrlWheelEnabled = enabledForPage && (data.enableCtrlWheelHijack ?? true);
      isCtrlKeyEnabled = enabledForPage && (data.enableCtrlKeyHijack ?? true);
      isHudEnabled = data.enableZoomHud ?? true;

      if (!isHudEnabled && hudElement) {
        hudElement.remove();
        hudElement = null;
      }
    } catch {
      isCtrlWheelEnabled = false;
      isCtrlKeyEnabled = false;
    }
  };

  const handleStorageChange = (changes, areaName) => {
    if (areaName !== 'local') return;

    if (changes.excludedSites && currentDomain) {
      const excludedSites = changes.excludedSites.newValue ?? [];
      isCurrentDomainExcluded = isDomainExcluded(currentDomain, excludedSites);
    }

    if (changes.excludedSites || changes.enableCtrlWheelHijack || changes.enableCtrlKeyHijack || changes.enableZoomHud) {
      void refreshSettings();
    }
  };

  const handleMessage = (request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;

    if (request.action === 'setZoom') {
      const success = applyZoom(request.level, normalizeMethod(request.method));
      sendResponse({ success });
    }
  };

  const teardown = () => {
    try {
      if (stepFlushTimer) {
        clearTimeout(stepFlushTimer);
        stepFlushTimer = null;
      }
      if (hudHideTimer) {
        clearTimeout(hudHideTimer);
        hudHideTimer = null;
      }

      window.removeEventListener('wheel', handleWheelIntent, true);
      window.removeEventListener('wheel', handleWheelHijack);
      window.removeEventListener('keydown', handleKeyIntent, true);
      window.removeEventListener('keydown', handleKeyHijack);
      window.removeEventListener('keyup', handleKeyUp, true);

      if (isRuntimeAlive()) {
        chrome.storage.onChanged.removeListener(handleStorageChange);
        chrome.runtime.onMessage.removeListener(handleMessage);
      }

      if (typeof ZoomMethods !== 'undefined') {
        Object.values(ZoomMethods).forEach((zoomMethod) => zoomMethod.remove());
      }

      if (hudElement) {
        hudElement.remove();
        hudElement = null;
      }

      if (window.__fineZoomInstance === instance) {
        delete window.__fineZoomInstance;
      }
    } catch (error) {
      console.error('Fine Zoom: Failed to tear down content script', error);
    }
  };

  const instance = { isAlive: isRuntimeAlive, teardown };
  window.__fineZoomInstance = instance;

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
      await refreshSettings();

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

  window.addEventListener('wheel', handleWheelIntent, { capture: true, passive: true });
  window.addEventListener('wheel', handleWheelHijack, { passive: false });
  window.addEventListener('keydown', handleKeyIntent, { capture: true });
  window.addEventListener('keydown', handleKeyHijack);
  window.addEventListener('keyup', handleKeyUp, { capture: true });
  chrome.storage.onChanged.addListener(handleStorageChange);
  chrome.runtime.onMessage.addListener(handleMessage);

  // Run immediately. Since run_at is document_start, document.documentElement
  // might not be available yet, but initializeZoom handles that.
  initializeZoom();
})();
