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

  const { isDomainExcluded, resolveZoomCommand } = TextZoomUtils;
  const normalizeMethod = (method) => TextZoomUtils.normalizeMethod(method, DEFAULT_METHOD);

  const IS_MAC = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '');
  const IS_TOP_FRAME = window === window.top;
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
  let pendingWheelDelta = 0;
  let pendingKeySteps = 0;
  let pendingReset = false;
  let stepFlushTimer = null;
  let stepFlushInProgress = false;
  let lastWheelIntentAt = 0;
  let lastKeyIntentAt = 0;
  let hudHost = null;
  let hudPill = null;
  let hudHideTimer = null;
  let knownDefaultMethod = DEFAULT_METHOD;
  let knownSiteMethod;

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

  const sendZoomInputIntent = (kind, command) => {
    void chrome.runtime.sendMessage({ action: 'recordZoomInputIntent', kind, command }).catch(() => {});
  };

  const removeLegacyTransformStyle = () => {
    const legacyStyle = document.getElementById('fine-zoom-transform-style');
    if (legacyStyle) legacyStyle.remove();
  };

  const hasContentZoomApplied = () => currentMethod !== 'browser-zoom' && currentLevel !== 1.0;

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

  const HUD_HOST_STYLES = [
    ['all', 'initial'],
    ['position', 'fixed'],
    ['left', '50%'],
    ['bottom', '24px'],
    ['transform', 'translateX(-50%)'],
    ['z-index', '2147483647'],
    ['pointer-events', 'none'],
    ['display', 'block'],
    ['zoom', '1']
  ];

  const HUD_SHADOW_CSS = `
    .pill {
      background: rgba(17, 17, 17, .88);
      color: #fff;
      font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      font-variant-numeric: tabular-nums;
      padding: 8px 12px;
      border-radius: 999px;
      white-space: nowrap;
      opacity: 0;
      transition: opacity 120ms ease-out;
      box-shadow: 0 2px 8px rgba(0, 0, 0, .25);
    }
    .pill.visible { opacity: 1; }
    @media (prefers-reduced-motion: reduce) { .pill { transition: none; } }
  `;

  const removeHud = () => {
    if (hudHideTimer) {
      clearTimeout(hudHideTimer);
      hudHideTimer = null;
    }
    if (hudHost) hudHost.remove();
    hudHost = null;
    hudPill = null;
  };

  // A closed shadow root keeps page CSS from restyling the indicator, and
  // building it with DOM APIs keeps it working under Trusted Types CSPs.
  const ensureHud = () => {
    if (!IS_TOP_FRAME || !isHudEnabled || !document.documentElement) return null;
    if (hudHost && hudHost.isConnected && hudPill) return hudPill;

    removeHud();
    const host = document.createElement('fine-zoom-hud');
    host.setAttribute('aria-hidden', 'true');
    HUD_HOST_STYLES.forEach(([property, value]) => host.style.setProperty(property, value, 'important'));

    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = HUD_SHADOW_CSS;
    const pill = document.createElement('div');
    pill.className = 'pill';
    root.append(style, pill);

    document.documentElement.appendChild(host);
    hudHost = host;
    hudPill = pill;
    return pill;
  };

  // `scale` is how much the page is currently magnified (browser zoom or CSS
  // zoom on <html>); the host cancels it so the indicator keeps one size.
  const showZoomHud = (level, scale) => {
    if (!isHudEnabled || typeof level !== 'number' || !Number.isFinite(level)) return;

    const pill = ensureHud();
    if (!pill) return;

    const counterZoom = Number.isFinite(scale) && scale > 0 ? 1 / scale : 1;
    hudHost.style.setProperty('zoom', String(counterZoom), 'important');
    pill.textContent = `${Math.round(level * 100)}%`;
    pill.classList.add('visible');

    if (hudHideTimer) clearTimeout(hudHideTimer);
    hudHideTimer = setTimeout(() => {
      hudHideTimer = null;
      if (hudPill) hudPill.classList.remove('visible');
    }, HUD_VISIBLE_MS);
  };

  const flushPendingSteps = async () => {
    if (stepFlushInProgress) return;
    stepFlushInProgress = true;

    try {
      while (pendingKeySteps !== 0 || pendingWheelDelta !== 0 || pendingReset) {
        let payload;

        if (pendingKeySteps !== 0) {
          payload = { action: 'adjustZoomByDelta', deltaSteps: pendingKeySteps, source: 'key-hijack' };
          pendingKeySteps = 0;
        } else if (pendingWheelDelta !== 0) {
          payload = { action: 'adjustZoomByDelta', wheelDelta: pendingWheelDelta, source: 'wheel-hijack' };
          pendingWheelDelta = 0;
        } else {
          pendingReset = false;
          payload = { action: 'adjustZoomByCommand', command: 'zoom-reset' };
        }

        try {
          const response = await chrome.runtime.sendMessage(payload);
          // The background worker shows the indicator in the top frame.
          if (response?.success && typeof response.level === 'number') {
            currentLevel = response.level;
          }
        } catch (error) {
          pendingWheelDelta = 0;
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

    // Raw deltas go to the background worker, which knows the real browser
    // zoom: Chromium reports wheel deltas in CSS pixels, so the same wheel
    // notch shrinks as the page zooms in and must be scaled back.
    pendingWheelDelta += TextZoomUtils.normalizeWheelDelta(event.deltaY, event.deltaMode, window.innerHeight);

    if (pendingWheelDelta !== 0) {
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

    // Zoom shortcuts have no editing meaning, so text fields are handled too;
    // editors that bind them call preventDefault() and are skipped above.
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

      if (!isHudEnabled) {
        removeHud();
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

    if (changes.defaultMethod) {
      knownDefaultMethod = normalizeMethod(changes.defaultMethod.newValue ?? DEFAULT_METHOD);
    }

    // When stored settings switch this site to native zoom, drop the content
    // scaling here; the background worker does not clear it on every step.
    if ((changes.perSiteZoom || changes.defaultMethod) && hasContentZoomApplied()) {
      const siteConfig = changes.perSiteZoom
        ? changes.perSiteZoom.newValue?.[currentDomain]
        : undefined;
      const siteMethod = changes.perSiteZoom ? siteConfig?.method : knownSiteMethod;
      if (changes.perSiteZoom) knownSiteMethod = siteMethod;
      const effectiveMethod = normalizeMethod(siteMethod ?? knownDefaultMethod);
      if (effectiveMethod === 'browser-zoom') {
        applyZoom(1.0, 'browser-zoom');
      }
    }
  };

  const handleMessage = (request, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id) return;

    if (request.action === 'setZoom') {
      const success = applyZoom(request.level, normalizeMethod(request.method));
      sendResponse({ success });
      return;
    }

    if (request.action === 'showZoomHud') {
      showZoomHud(request.level, request.scale);
      sendResponse({ success: true });
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

      removeHud();

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
    // Let the background worker apply stored native zoom right away instead
    // of waiting for the whole page (images included) to finish loading.
    if (IS_TOP_FRAME) {
      void chrome.runtime.sendMessage({ action: 'documentStarted' }).catch(() => {});
    }

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

      knownDefaultMethod = normalizeMethod(data.defaultMethod ?? DEFAULT_METHOD);
      knownSiteMethod = data.perSiteZoom?.[domain]?.method;

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
