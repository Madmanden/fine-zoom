(function(root) {
  const isDomainExcluded = (domain, excludedSites) => {
    if (typeof domain !== 'string' || domain.length === 0) return false;
    const normalizedDomain = domain.toLowerCase();

    const sourceSites = Array.isArray(excludedSites)
      ? excludedSites
      : typeof excludedSites === 'string'
        ? excludedSites.split(/\r?\n|,/)
        : [];

    return sourceSites.some((site) => {
      const normalizedSite = String(site || '').trim().toLowerCase();
      if (!normalizedSite) return false;
      return normalizedDomain === normalizedSite || normalizedDomain.endsWith('.' + normalizedSite);
    });
  };

  const normalizeMethod = (method, defaultMethod) => {
    if (method === 'transform') return 'browser-zoom';
    if (method === 'browser-zoom' || method === 'font-size' || method === 'css-zoom') return method;
    return defaultMethod;
  };

  const areZoomLevelsEqual = (a, b, epsilon = 0.001) => {
    const first = Number(a);
    const second = Number(b);
    if (!Number.isFinite(first) || !Number.isFinite(second)) return false;
    return Math.abs(first - second) < epsilon;
  };

  const normalizeStoredLevel = (level) => {
    const parsed = Number.parseFloat(level);
    if (!Number.isFinite(parsed)) return null;
    return Number(parsed.toFixed(2));
  };

  const accumulateZoomActionSteps = ({
    accumulated = 0,
    delta,
    threshold = 0.05,
    maxSteps = 20
  } = {}) => {
    const stepSize = Number.isFinite(threshold) && threshold > 0 ? threshold : 0.05;
    const max = Number.isFinite(maxSteps) && maxSteps > 0 ? Math.floor(maxSteps) : 20;
    const total = (Number.isFinite(accumulated) ? accumulated : 0) + (Number.isFinite(delta) ? delta : 0);
    const steps = Math.floor(Math.abs(total) / stepSize);

    if (steps < 1) {
      return { steps: 0, remainder: total };
    }

    const capped = Math.min(steps, max);
    const remainder = total - Math.sign(total) * capped * stepSize;
    return { steps: capped, remainder };
  };

  const buildUpdatedPerSiteZoom = ({
    perSiteZoom,
    domain,
    level,
    method,
    defaultLevel = 1.0,
    defaultMethod = 'browser-zoom'
  }) => {
    if (typeof domain !== 'string' || domain.length === 0) return null;

    const normalizedLevel = normalizeStoredLevel(level);
    if (!Number.isFinite(normalizedLevel)) return null;

    const current = perSiteZoom ?? {};
    const normalizedMethod = normalizeMethod(method, defaultMethod);
    const normalizedDefaultLevel = normalizeStoredLevel(defaultLevel) ?? 1.0;
    const normalizedDefaultMethod = normalizeMethod(defaultMethod, 'browser-zoom');
    const isDefault = areZoomLevelsEqual(normalizedLevel, normalizedDefaultLevel)
      && normalizedMethod === normalizedDefaultMethod;

    if (isDefault) {
      if (!(domain in current)) return null;
      const next = { ...current };
      delete next[domain];
      return next;
    }

    const existing = current[domain];
    if (existing) {
      const existingLevel = normalizeStoredLevel(existing.level);
      const existingMethod = normalizeMethod(existing.method, defaultMethod);
      if (existingMethod === normalizedMethod && areZoomLevelsEqual(existingLevel, normalizedLevel)) {
        return null;
      }
    }

    return {
      ...current,
      [domain]: { level: normalizedLevel, method: normalizedMethod }
    };
  };

  const normalizeWheelDelta = (deltaY, deltaMode, viewportHeight) => {
    if (!Number.isFinite(deltaY)) return 0;
    if (deltaMode === 1) return deltaY * 16;
    if (deltaMode === 2) return deltaY * Math.max(1, viewportHeight || 1);
    return deltaY;
  };

  const accumulateCtrlWheelSteps = ({
    accumulator,
    deltaY,
    deltaMode,
    viewportHeight,
    threshold
  }) => {
    const nextThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : 100;
    let nextAccumulator = (Number.isFinite(accumulator) ? accumulator : 0)
      + normalizeWheelDelta(deltaY, deltaMode, viewportHeight);

    let steps = 0;
    if (nextAccumulator <= -nextThreshold) {
      steps = Math.floor(Math.abs(nextAccumulator) / nextThreshold);
      nextAccumulator += steps * nextThreshold;
    } else if (nextAccumulator >= nextThreshold) {
      steps = -Math.floor(nextAccumulator / nextThreshold);
      nextAccumulator -= Math.abs(steps) * nextThreshold;
    }

    return { accumulator: nextAccumulator, steps };
  };

  const normalizeDeltaSteps = (steps, maxSteps = 20) => {
    const normalized = Number.parseInt(steps, 10);
    const normalizedMax = Number.isFinite(maxSteps) && maxSteps > 0 ? Math.floor(maxSteps) : 20;
    if (!Number.isFinite(normalized) || normalized === 0) return null;
    return Math.max(-normalizedMax, Math.min(normalizedMax, normalized));
  };

  const shouldApplyFallbackForIntent = (intentKind, enableCtrlWheelHijack, enableCtrlKeyHijack) => {
    const wheelEnabled = enableCtrlWheelHijack ?? true;
    const keyEnabled = enableCtrlKeyHijack ?? true;

    if (intentKind === 'wheel') return wheelEnabled;
    if (intentKind === 'key') return keyEnabled;
    return wheelEnabled || keyEnabled;
  };

  const isScriptablePageUrl = (url) => {
    if (typeof url !== 'string' || url.length === 0) return false;

    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
      return false;
    }
  };

  // Chromium binds its zoom accelerators to virtual key codes, which the DOM
  // exposes as `keyCode`. Matching on the same codes intercepts exactly the
  // keys the browser would zoom with on every keyboard layout (for example
  // `+` on Danish/German layouts, and never `ß` or Ctrl+Insert).
  const ZOOM_KEY_CODES = {
    187: 'zoom-in', // VKEY_OEM_PLUS
    107: 'zoom-in', // VKEY_ADD
    61: 'zoom-in', // '=' on some platforms
    189: 'zoom-out', // VKEY_OEM_MINUS
    109: 'zoom-out', // VKEY_SUBTRACT
    173: 'zoom-out', // '-' on some platforms
    48: 'zoom-reset', // VKEY_0
    96: 'zoom-reset' // VKEY_NUMPAD0
  };

  const resolveZoomCommand = ({ keyCode, key } = {}) => {
    // 229 is reported while an IME is composing; 0 for synthetic events.
    if (Number.isInteger(keyCode) && keyCode !== 0 && keyCode !== 229) {
      return ZOOM_KEY_CODES[keyCode] ?? null;
    }

    if (key === '+' || key === '=' || key === 'Add') return 'zoom-in';
    if (key === '-' || key === '_' || key === 'Subtract') return 'zoom-out';
    if (key === '0') return 'zoom-reset';
    return null;
  };

  // Levels this extension asked the browser to apply, keyed by site. Native
  // zoom is per-origin, so one setZoom() fires onZoomChange in every tab of
  // that site, and rapid sequences fire one event per level. Matching is
  // therefore non-consuming and checks every recent level, not just the last.
  const MAX_EXPECTED_ZOOM_ENTRIES = 32;

  const pruneExpectedZoomLevels = (entries, now) => {
    if (!Array.isArray(entries)) return [];
    return entries.filter((entry) => entry && Number.isFinite(entry.expiresAt) && entry.expiresAt > now);
  };

  const recordExpectedZoomLevel = (entries, level, now, ttlMs) => {
    const next = pruneExpectedZoomLevels(entries, now)
      .filter((entry) => !areZoomLevelsEqual(entry.level, level));
    next.push({ level, expiresAt: now + ttlMs });
    return next.slice(-MAX_EXPECTED_ZOOM_ENTRIES);
  };

  const matchesExpectedZoomLevel = (entries, level, now) => {
    return pruneExpectedZoomLevels(entries, now)
      .some((entry) => areZoomLevelsEqual(entry.level, level));
  };

  // Applies the not-yet-persisted per-site levels on top of a stored map so a
  // debounced write never loses changes and never clobbers unrelated edits.
  const applyPendingSiteUpdates = ({
    perSiteZoom,
    pendingUpdates,
    defaultLevel,
    defaultMethod
  }) => {
    let current = perSiteZoom ?? {};
    let changed = false;

    for (const [domain, update] of pendingUpdates ?? []) {
      const next = buildUpdatedPerSiteZoom({
        perSiteZoom: current,
        domain,
        level: update.level,
        method: update.method,
        defaultLevel,
        defaultMethod
      });
      if (next) {
        current = next;
        changed = true;
      }
    }

    return { perSiteZoom: current, changed };
  };

  const utils = {
    isDomainExcluded,
    normalizeMethod,
    areZoomLevelsEqual,
    normalizeStoredLevel,
    accumulateZoomActionSteps,
    buildUpdatedPerSiteZoom,
    accumulateCtrlWheelSteps,
    normalizeWheelDelta,
    normalizeDeltaSteps,
    shouldApplyFallbackForIntent,
    isScriptablePageUrl,
    resolveZoomCommand,
    recordExpectedZoomLevel,
    matchesExpectedZoomLevel,
    applyPendingSiteUpdates
  };

  root.TextZoomUtils = utils;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = utils;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
