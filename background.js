importScripts('shared/constants.js', 'shared/utils.js', 'shared/messaging.js');

const {
  accumulateCtrlWheelSteps,
  accumulateZoomActionSteps,
  applyPendingSiteUpdates,
  areZoomLevelsEqual,
  buildUpdatedPerSiteZoom,
  isDomainExcluded,
  isScriptablePageUrl,
  matchesExpectedZoomLevel,
  normalizeDeltaSteps,
  recordExpectedZoomLevel,
  shouldApplyFallbackForIntent
} = TextZoomUtils;
const { ensureContentScriptAndSend } = TextZoomMessaging;
const normalizeMethod = (method) => TextZoomUtils.normalizeMethod(method, DEFAULT_METHOD);

const isNativeZoomMethod = (method) => method === 'browser-zoom';
const tabTaskQueues = new Map();
const expectedNativeZoomBySite = new Map();
const recentZoomInputIntentByTab = new Map();
const nativeDeltaAccumulatorByTab = new Map();
const navigatingTabs = new Map();
const pendingSiteUpdates = new Map();
const EXPECTED_NATIVE_ZOOM_TTL_MS = 1000;
const RECENT_INPUT_INTENT_WINDOW_MS = 500;
// The input-intent message and the browser's zoom event travel different
// paths, so the intent can arrive a little after the zoom change.
const INPUT_INTENT_GRACE_MS = 60;
const NAVIGATION_WINDOW_MS = 15000;
const PERSIST_THROTTLE_MS = 300;
const MAX_DELTA_STEPS_PER_REQUEST = 20;
// Device pixels of Ctrl/Cmd+wheel movement per zoom step (one mouse notch is
// roughly 100). Partial movement is forgotten after a pause.
const CTRL_WHEEL_DELTA_THRESHOLD = 70;
const WHEEL_ACCUMULATOR_IDLE_MS = 600;
const wheelAccumulatorByTab = new Map();
// Chromium page-zoom actions move roughly 5% or more. Used to translate
// streamed fractional gesture deltas into fine steps.
const NATIVE_ZOOM_ACTION_STEP = 0.05;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const clampContentZoom = (level) => {
  const normalized = Number.parseFloat(level);
  if (!Number.isFinite(normalized)) return DEFAULT_LEVEL;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, normalized));
};

const clampNativeZoom = (level) => {
  const normalized = Number.parseFloat(level);
  if (!Number.isFinite(normalized)) return DEFAULT_LEVEL;
  return Math.max(BROWSER_ZOOM_MIN, Math.min(BROWSER_ZOOM_MAX, normalized));
};

const clampStep = (value, fallback = DEFAULT_ZOOM_STEP) => {
  const normalized = Number.parseFloat(value);
  if (!Number.isFinite(normalized)) return fallback;
  return Math.max(STEP_MIN, Math.min(STEP_MAX, normalized));
};

const toDomain = (tabUrl) => {
  if (!tabUrl) return null;
  try {
    const url = new URL(tabUrl);
    if (!/^https?:$/.test(url.protocol)) return null;
    return url.hostname;
  } catch {
    return null;
  }
};

const getTabDomain = async (tabId) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  return toDomain(tab?.url);
};

// --- Settings cache and throttled per-site persistence ---------------------

let settingsCache = null;
let settingsGeneration = 0;

const invalidateSettingsCache = () => {
  settingsCache = null;
  settingsGeneration += 1;
};

const withPendingSiteUpdates = (perSiteZoom, defaults) => {
  if (pendingSiteUpdates.size === 0) return perSiteZoom;
  return applyPendingSiteUpdates({
    perSiteZoom,
    pendingUpdates: pendingSiteUpdates,
    defaultLevel: defaults.defaultLevel,
    defaultMethod: defaults.defaultMethod
  }).perSiteZoom;
};

const getSettings = async () => {
  if (settingsCache) return settingsCache;

  const generation = settingsGeneration;
  const data = await chrome.storage.local.get([
    'perSiteZoom',
    'defaultLevel',
    'defaultMethod',
    'defaultZoomStep',
    'excludedSites',
    'enableCtrlWheelHijack',
    'enableCtrlKeyHijack'
  ]);

  const settings = {
    perSiteZoom: data.perSiteZoom ?? {},
    defaultLevel: clampContentZoom(data.defaultLevel),
    defaultMethod: normalizeMethod(data.defaultMethod),
    defaultZoomStep: clampStep(data.defaultZoomStep, DEFAULT_ZOOM_STEP),
    excludedSites: data.excludedSites ?? [],
    enableCtrlWheelHijack: data.enableCtrlWheelHijack ?? true,
    enableCtrlKeyHijack: data.enableCtrlKeyHijack ?? true
  };
  settings.perSiteZoom = withPendingSiteUpdates(settings.perSiteZoom, settings);

  // Only cache when storage did not change while the read was in flight.
  if (generation === settingsGeneration) {
    settingsCache = settings;
  }
  return settings;
};

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;

  const configKeys = [
    'defaultLevel',
    'defaultMethod',
    'defaultZoomStep',
    'excludedSites',
    'enableCtrlWheelHijack',
    'enableCtrlKeyHijack'
  ];
  if (configKeys.some((key) => key in changes)) {
    invalidateSettingsCache();
    return;
  }

  if (changes.perSiteZoom) {
    if (settingsCache) {
      settingsCache.perSiteZoom = withPendingSiteUpdates(changes.perSiteZoom.newValue ?? {}, settingsCache);
    } else {
      settingsGeneration += 1;
    }
  }
});

let persistTimer = null;
let persistChain = Promise.resolve();

const flushPendingSiteUpdates = () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }

  persistChain = persistChain
    .catch(() => {})
    .then(async () => {
      if (pendingSiteUpdates.size === 0) return;

      const updates = new Map(pendingSiteUpdates);
      // Merge into the latest stored map so edits made elsewhere (popup,
      // settings page) for other sites are never overwritten.
      const data = await chrome.storage.local.get(['perSiteZoom', 'defaultLevel', 'defaultMethod']);
      const { perSiteZoom, changed } = applyPendingSiteUpdates({
        perSiteZoom: data.perSiteZoom ?? {},
        pendingUpdates: updates,
        defaultLevel: clampContentZoom(data.defaultLevel),
        defaultMethod: normalizeMethod(data.defaultMethod)
      });

      if (changed) {
        await chrome.storage.local.set({ perSiteZoom });
      }

      for (const [domain, update] of updates) {
        if (pendingSiteUpdates.get(domain) === update) {
          pendingSiteUpdates.delete(domain);
        }
      }
    })
    .catch((error) => {
      console.error('Fine Zoom: Failed to persist zoom levels', error);
    });

  return persistChain;
};

// Every storage write is broadcast to every frame of every tab, so streamed
// zoom input is written at most once per throttle window.
const persistZoomForDomain = (settings, domain, level, method) => {
  const nextPerSiteZoom = buildUpdatedPerSiteZoom({
    perSiteZoom: settings.perSiteZoom,
    domain,
    level,
    method,
    defaultLevel: settings.defaultLevel,
    defaultMethod: settings.defaultMethod
  });

  if (!nextPerSiteZoom && !pendingSiteUpdates.has(domain)) return;

  pendingSiteUpdates.set(domain, { level, method });
  if (nextPerSiteZoom) {
    settings.perSiteZoom = nextPerSiteZoom;
  }
  if (settingsCache && settingsCache !== settings) {
    settingsCache.perSiteZoom = withPendingSiteUpdates(settingsCache.perSiteZoom, settingsCache);
  }

  if (!persistTimer) {
    persistTimer = setTimeout(() => {
      persistTimer = null;
      void flushPendingSiteUpdates();
    }, PERSIST_THROTTLE_MS);
  }
};

const resolveSiteConfig = (settings, domain) => {
  const siteConfig = settings.perSiteZoom[domain];
  return {
    level: siteConfig?.level ?? settings.defaultLevel,
    method: normalizeMethod(siteConfig?.method ?? settings.defaultMethod)
  };
};

// --- Per-tab bookkeeping ----------------------------------------------------

const enqueueTabTask = (tabId, task) => {
  const previous = tabTaskQueues.get(tabId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task);

  tabTaskQueues.set(tabId, next.finally(() => {
    if (tabTaskQueues.get(tabId) === next) {
      tabTaskQueues.delete(tabId);
    }
  }));

  return next;
};

const markRecentZoomInputIntent = (tabId, kind, command) => {
  if (kind !== 'wheel' && kind !== 'key') return;
  recentZoomInputIntentByTab.set(tabId, {
    kind,
    command: typeof command === 'string' ? command : null,
    timestamp: Date.now()
  });
};

const getRecentZoomInputIntent = (tabId) => {
  const intent = recentZoomInputIntentByTab.get(tabId);
  if (!intent) return null;

  if (Date.now() - intent.timestamp > RECENT_INPUT_INTENT_WINDOW_MS) {
    recentZoomInputIntentByTab.delete(tabId);
    return null;
  }

  return intent;
};

const markTabNavigating = (tabId) => {
  navigatingTabs.set(tabId, Date.now() + NAVIGATION_WINDOW_MS);
};

const isTabNavigating = (tabId) => {
  const expiresAt = navigatingTabs.get(tabId);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    navigatingTabs.delete(tabId);
    return false;
  }
  return true;
};

const rememberExpectedNativeZoom = (domain, level) => {
  if (!domain) return;
  expectedNativeZoomBySite.set(domain, recordExpectedZoomLevel(
    expectedNativeZoomBySite.get(domain),
    clampNativeZoom(level),
    Date.now(),
    EXPECTED_NATIVE_ZOOM_TTL_MS
  ));
};

const isExpectedNativeZoom = (domain, level) => {
  const entries = expectedNativeZoomBySite.get(domain);
  if (!entries) return false;

  const now = Date.now();
  const matched = matchesExpectedZoomLevel(entries, clampNativeZoom(level), now);
  if (!entries.some((entry) => entry.expiresAt > now)) {
    expectedNativeZoomBySite.delete(domain);
  }
  return matched;
};

// --- Applying zoom ----------------------------------------------------------

const isExpectedContentScriptError = (error) => {
  const message = String(error?.message || error || '');
  return (
    message.includes('showing error page') ||
    message.includes('cannot be scripted due to an ExtensionsSettings policy') ||
    message.includes('Cannot access contents of url')
  );
};

const clearContentZoom = async (tabId) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  const tabUrl = tab?.url;

  if (!isScriptablePageUrl(tabUrl)) {
    return false;
  }

  try {
    await ensureContentScriptAndSend(tabId, {
      action: 'setZoom',
      level: 1.0,
      method: 'font-size'
    });
    return true;
  } catch (error) {
    if (!isExpectedContentScriptError(error)) {
      console.error('Fine Zoom: Failed to clear content zoom', error);
    }
    return false;
  }
};

const setNativeZoom = async (tabId, domain, level) => {
  rememberExpectedNativeZoom(domain, level);
  await chrome.tabs.setZoom(tabId, level);
};

const applyNativeZoom = async (tabId, domain, level, knownCurrentLevel) => {
  const clamped = clampNativeZoom(level);
  const current = Number.isFinite(knownCurrentLevel)
    ? clampNativeZoom(knownCurrentLevel)
    : clampNativeZoom(await chrome.tabs.getZoom(tabId));
  if (areZoomLevelsEqual(current, clamped)) {
    return current;
  }
  await setNativeZoom(tabId, domain, clamped);
  return clamped;
};

const resetNativeZoom = async (tabId, domain, knownCurrentLevel) => {
  const current = Number.isFinite(knownCurrentLevel)
    ? clampNativeZoom(knownCurrentLevel)
    : clampNativeZoom(await chrome.tabs.getZoom(tabId));
  if (!areZoomLevelsEqual(current, 1.0)) {
    await setNativeZoom(tabId, domain, 1.0);
  }
};

const applyContentZoom = async (tabId, domain, level, method, knownNativeLevel) => {
  const clamped = clampContentZoom(level);
  await resetNativeZoom(tabId, domain, knownNativeLevel);
  await ensureContentScriptAndSend(tabId, {
    action: 'setZoom',
    level: clamped,
    method
  });
  return clamped;
};

// Content zoom is only cleared when the user switches method (popup) or by
// the content script itself when stored settings switch to native zoom, so
// streamed native steps skip that per-step broadcast to every frame.
const applyMethodZoom = (tabId, domain, level, method, knownNativeLevel) => {
  const normalizedMethod = normalizeMethod(method);

  if (isNativeZoomMethod(normalizedMethod)) {
    return applyNativeZoom(tabId, domain, level, knownNativeLevel);
  }

  return applyContentZoom(tabId, domain, level, normalizedMethod, knownNativeLevel);
};

// The indicator lives in the top frame so it is centered on the page even
// when the input happened inside an iframe. `scale` lets it cancel out the
// page scaling that would otherwise resize the indicator itself.
const notifyZoomHud = (tabId, level, method) => {
  const scale = isNativeZoomMethod(method) || method === 'css-zoom' ? level : 1;
  chrome.tabs.sendMessage(tabId, { action: 'showZoomHud', level, scale }, { frameId: 0 })
    .catch(() => {});
};

const runZoomAdjustment = async (tabId, domain, computeTarget) => {
  const settings = await getSettings();

  if (isDomainExcluded(domain, settings.excludedSites)) {
    return { success: true, level: 1.0, excluded: true };
  }

  nativeDeltaAccumulatorByTab.delete(tabId);

  const { level: storedLevel, method } = resolveSiteConfig(settings, domain);
  const isNative = isNativeZoomMethod(method);
  const clamp = isNative ? clampNativeZoom : clampContentZoom;
  const nativeLevel = isNative ? clampNativeZoom(await chrome.tabs.getZoom(tabId)) : undefined;
  const currentZoom = isNative ? nativeLevel : clampContentZoom(storedLevel);

  const target = computeTarget(currentZoom, settings, { tabId, isNative });
  if (target === null) {
    return { success: false, error: 'Invalid command' };
  }
  if (target === undefined) {
    return { success: true, level: currentZoom };
  }

  const newZoom = clamp(target);
  if (areZoomLevelsEqual(newZoom, currentZoom)) {
    notifyZoomHud(tabId, currentZoom, method);
    return { success: true, level: currentZoom };
  }

  const appliedLevel = await applyMethodZoom(tabId, domain, newZoom, method, nativeLevel);
  persistZoomForDomain(settings, domain, appliedLevel, method);
  notifyZoomHud(tabId, appliedLevel, method);

  return { success: true, level: appliedLevel };
};

const targetForCommand = (command) => (currentZoom, settings) => {
  switch (command) {
    case 'zoom-in':
      return currentZoom + settings.defaultZoomStep;
    case 'zoom-out':
      return currentZoom - settings.defaultZoomStep;
    case 'zoom-reset':
      return settings.defaultLevel;
    default:
      return null;
  }
};

const targetForSteps = (steps) => (currentZoom, settings) => currentZoom + settings.defaultZoomStep * steps;

// `wheelDelta` is in CSS pixels; browser zoom shrinks those, so scale back to
// device-independent movement to keep one notch = one step at every level.
const targetForWheelDelta = (wheelDelta) => (currentZoom, settings, { tabId, isNative }) => {
  const now = Date.now();
  const previous = wheelAccumulatorByTab.get(tabId);
  const accumulator = previous && now - previous.at <= WHEEL_ACCUMULATOR_IDLE_MS ? previous.value : 0;

  const update = accumulateCtrlWheelSteps({
    accumulator,
    deltaY: wheelDelta * (isNative ? currentZoom : 1),
    deltaMode: 0,
    viewportHeight: 0,
    threshold: CTRL_WHEEL_DELTA_THRESHOLD
  });
  wheelAccumulatorByTab.set(tabId, { value: update.accumulator, at: now });

  if (update.steps === 0) return undefined;
  const steps = Math.max(-MAX_DELTA_STEPS_PER_REQUEST, Math.min(MAX_DELTA_STEPS_PER_REQUEST, update.steps));
  return currentZoom + settings.defaultZoomStep * steps;
};

const applyStoredZoomForTab = async (tabId, tabUrl) => {
  const domain = toDomain(tabUrl);
  if (!domain) return;

  const settings = await getSettings();
  if (isDomainExcluded(domain, settings.excludedSites)) return;

  const { level, method } = resolveSiteConfig(settings, domain);

  // A document that was just loaded cannot contain zoom styles from an
  // earlier content-zoom session, so native mode can skip the cleanup
  // message that would otherwise hit every frame on each navigation.
  if (isNativeZoomMethod(method)) {
    await applyNativeZoom(tabId, domain, level);
    return;
  }

  await applyContentZoom(tabId, domain, level, method);
};

// Runs as soon as the top-level document starts, well before the load
// `complete` event, so stored native zoom is in place before first paint
// whenever possible. Content methods are applied by the content script.
const applyStoredNativeZoomForDocument = async (tabId, domain) => {
  if (!domain) return;

  const settings = await getSettings();
  if (isDomainExcluded(domain, settings.excludedSites)) return;

  const { level, method } = resolveSiteConfig(settings, domain);
  if (isNativeZoomMethod(method)) {
    await applyNativeZoom(tabId, domain, level);
  } else {
    await resetNativeZoom(tabId, domain);
  }
};

// --- Reacting to zoom changes made outside the extension -------------------

const syncNativeZoomToStorage = async (tabId, domain, settings, nativeLevel) => {
  const { method } = resolveSiteConfig(settings, domain);

  if (!isNativeZoomMethod(method)) {
    // Content methods own the scaling on this site; browser zoom must not
    // stack on top of them (for example when the Chrome menu was used).
    await resetNativeZoom(tabId, domain, nativeLevel);
    return;
  }

  persistZoomForDomain(settings, domain, nativeLevel, method);
};

// During navigation the browser restores its own per-origin zoom memory,
// which can be out of date (for example after editing a site on the
// settings page). The extension's stored level is the source of truth.
const reassertStoredZoom = async (tabId, domain, settings, nativeLevel) => {
  const { level, method } = resolveSiteConfig(settings, domain);

  if (isNativeZoomMethod(method)) {
    await applyNativeZoom(tabId, domain, level, nativeLevel);
  } else {
    await resetNativeZoom(tabId, domain, nativeLevel);
  }
};

const applyFallbackForBrowserZoom = async ({ tabId, domain, settings, intent, oldLevel, newLevel }) => {
  const { level: storedLevel, method } = resolveSiteConfig(settings, domain);
  const isNative = isNativeZoomMethod(method);
  const configuredStep = settings.defaultZoomStep;

  if (intent.kind === 'key' && intent.command === 'zoom-reset') {
    nativeDeltaAccumulatorByTab.delete(tabId);
    const appliedLevel = await applyMethodZoom(tabId, domain, settings.defaultLevel, method, newLevel);
    persistZoomForDomain(settings, domain, appliedLevel, method);
    notifyZoomHud(tabId, appliedLevel, method);
    return true;
  }

  const direction = Math.sign(newLevel - oldLevel);
  if (direction === 0) return false;

  let stepCount = 1;

  // Keyboard zoom shortcuts produce one native zoom action per event, so a
  // single fine step is the correct remap regardless of how large the
  // browser's own step is. Non-cancelable gestures (trackpad pinch) stream
  // fractional deltas instead; accumulate those and translate a full browser
  // action into one fine step.
  if (intent.kind === 'wheel') {
    const accumulated = accumulateZoomActionSteps({
      accumulated: nativeDeltaAccumulatorByTab.get(tabId) ?? 0,
      delta: newLevel - oldLevel,
      threshold: NATIVE_ZOOM_ACTION_STEP,
      maxSteps: MAX_DELTA_STEPS_PER_REQUEST
    });

    nativeDeltaAccumulatorByTab.set(tabId, accumulated.remainder);
    if (accumulated.steps < 1) return false;
    stepCount = accumulated.steps;
  } else {
    nativeDeltaAccumulatorByTab.delete(tabId);
  }

  let appliedLevel;
  if (isNative) {
    const remappedLevel = clampNativeZoom(oldLevel + direction * configuredStep * stepCount);
    appliedLevel = await applyNativeZoom(tabId, domain, remappedLevel, newLevel);
  } else {
    const currentLevel = clampContentZoom(storedLevel);
    const remappedLevel = clampContentZoom(currentLevel + direction * configuredStep * stepCount);
    if (areZoomLevelsEqual(remappedLevel, currentLevel)) return false;
    appliedLevel = await applyContentZoom(tabId, domain, remappedLevel, method, newLevel);
  }

  persistZoomForDomain(settings, domain, appliedLevel, method);
  notifyZoomHud(tabId, appliedLevel, method);
  return true;
};

const handleNativeZoomChange = async ({ tabId, oldZoomFactor, newZoomFactor }) => {
  const oldLevel = clampNativeZoom(oldZoomFactor);
  const newLevel = clampNativeZoom(newZoomFactor);

  const domain = await getTabDomain(tabId);
  if (!domain) return;

  // Our own setZoom() calls, including the echo in other tabs of the site.
  if (isExpectedNativeZoom(domain, newLevel)) return;

  let intent = getRecentZoomInputIntent(tabId);
  if (!intent && !isTabNavigating(tabId)) {
    await sleep(INPUT_INTENT_GRACE_MS);
    intent = getRecentZoomInputIntent(tabId);
  }

  await enqueueTabTask(tabId, async () => {
    const settings = await getSettings();
    if (isDomainExcluded(domain, settings.excludedSites)) return;

    if (intent) {
      const fallbackEnabled = shouldApplyFallbackForIntent(
        intent.kind,
        settings.enableCtrlWheelHijack,
        settings.enableCtrlKeyHijack
      );
      if (fallbackEnabled && await applyFallbackForBrowserZoom({
        tabId,
        domain,
        settings,
        intent,
        oldLevel,
        newLevel
      })) {
        return;
      }
    }

    // Drop stale events before adopting the browser's level: if the tab has
    // moved on (a later step, a remap in another tab of the same site),
    // whoever moved it already persisted the result.
    const liveLevel = clampNativeZoom(await chrome.tabs.getZoom(tabId));
    if (!areZoomLevelsEqual(liveLevel, newLevel)) return;

    if (!intent && isTabNavigating(tabId)) {
      await reassertStoredZoom(tabId, domain, settings, newLevel);
      return;
    }

    await syncNativeZoomToStorage(tabId, domain, settings, newLevel);
  });
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get([
    'defaultMethod',
    'defaultLevel',
    'enableCtrlWheelHijack',
    'enableCtrlKeyHijack',
    'perSiteZoom',
    'excludedSites',
    'didMigrateToBrowserZoomDefault',
    'didMigrateMainButtonStepTo005',
    'didMigrateRemovePerSite100'
  ]);

  const defaults = {
    defaultMethod: DEFAULT_METHOD,
    defaultLevel: DEFAULT_LEVEL,
    defaultZoomStep: DEFAULT_ZOOM_STEP,
    defaultFineZoomStep: DEFAULT_FINE_ZOOM_STEP,
    enableCtrlWheelHijack: true,
    enableCtrlKeyHijack: true,
    enableZoomHud: true,
    perSiteZoom: {},
    excludedSites: []
  };

  const toSet = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in existing)) {
      if (key === 'defaultZoomStep') {
        toSet[key] = clampStep(existing.defaultPopupButtonStep, DEFAULT_ZOOM_STEP);
      } else {
        toSet[key] = value;
      }
    }
  }

  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }

  if (!existing.didMigrateToBrowserZoomDefault) {
    const updates = { didMigrateToBrowserZoomDefault: true };
    const existingDefaultMethod = existing.defaultMethod;
    if (!existingDefaultMethod || existingDefaultMethod === 'font-size' || existingDefaultMethod === 'transform') {
      updates.defaultMethod = 'browser-zoom';
    }

    const perSiteZoom = existing.perSiteZoom ?? {};
    const migratedPerSiteZoom = {};
    let hasPerSiteChanges = false;

    Object.entries(perSiteZoom).forEach(([domain, config]) => {
      const normalizedMethod = normalizeMethod(config?.method);
      if (normalizedMethod !== config?.method) {
        migratedPerSiteZoom[domain] = { ...config, method: normalizedMethod };
        hasPerSiteChanges = true;
      } else {
        migratedPerSiteZoom[domain] = config;
      }
    });

    if (hasPerSiteChanges) {
      updates.perSiteZoom = migratedPerSiteZoom;
    }

    await chrome.storage.local.set(updates);
  }

  if (!existing.didMigrateMainButtonStepTo005) {
    const updates = { didMigrateMainButtonStepTo005: true };
    const existingStep = Number.parseFloat(existing.defaultPopupButtonStep);
    if (!Number.isFinite(existingStep) || existingStep === 0.01) {
      updates.defaultPopupButtonStep = 0.05;
    }
    await chrome.storage.local.set(updates);
  }

  if (!existing.didMigrateRemovePerSite100) {
    const updates = { didMigrateRemovePerSite100: true };
    const latest = await chrome.storage.local.get(['perSiteZoom', 'defaultLevel']);
    const defaultLevel = clampContentZoom(latest.defaultLevel);
    const perSiteZoom = latest.perSiteZoom ?? {};
    const cleanedPerSiteZoom = {};
    let hasChanges = false;

    Object.entries(perSiteZoom).forEach(([domain, config]) => {
      // Entries at 1.0 are only redundant when the default level is 1.0.
      // With a custom default level they mean "no zoom on this site".
      if (areZoomLevelsEqual(defaultLevel, 1.0) && areZoomLevelsEqual(config?.level, 1.0)) {
        hasChanges = true;
        return;
      }
      cleanedPerSiteZoom[domain] = config;
    });

    if (hasChanges) {
      updates.perSiteZoom = cleanedPerSiteZoom;
    }

    await chrome.storage.local.set(updates);
  }

  invalidateSettingsCache();
});

const replyWith = (promise, sendResponse) => {
  promise
    .then((result) => sendResponse(result))
    .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
  return true;
};

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

  if (request.action === 'recordZoomInputIntent') {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Missing tab context' });
      return;
    }

    markRecentZoomInputIntent(tabId, request.kind, request.command);
    sendResponse({ success: true });
    return;
  }

  if (request.action === 'documentStarted') {
    const tabId = sender.tab?.id;
    sendResponse({ success: true });

    const isActiveTopFrame = sender.frameId === 0
      && (!sender.documentLifecycle || sender.documentLifecycle === 'active');
    if (typeof tabId !== 'number' || !isActiveTopFrame) return;

    enqueueTabTask(tabId, () => applyStoredNativeZoomForDocument(tabId, toDomain(sender.url)))
      .catch((error) => console.error('Fine Zoom: Failed to apply stored zoom on document start', error));
    return;
  }

  if (request.action === 'applyNativeZoom') {
    const tabId = request.tabId ?? sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Missing tab id' });
      return;
    }

    return replyWith((async () => {
      const domain = await getTabDomain(tabId);
      await clearContentZoom(tabId);
      const level = await applyNativeZoom(tabId, domain, request.level);
      return { success: true, level };
    })(), sendResponse);
  }

  if (request.action === 'getNativeZoom') {
    const tabId = request.tabId ?? sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Missing tab id' });
      return;
    }

    return replyWith(
      chrome.tabs.getZoom(tabId).then((level) => ({ success: true, level: clampNativeZoom(level) })),
      sendResponse
    );
  }

  if (request.action === 'applyContentZoom') {
    const tabId = request.tabId ?? sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Missing tab id' });
      return;
    }

    return replyWith((async () => {
      const domain = await getTabDomain(tabId);
      const level = await applyContentZoom(tabId, domain, request.level, normalizeMethod(request.method));
      return { success: true, level };
    })(), sendResponse);
  }

  if (request.action === 'adjustZoomByDelta') {
    const tabId = sender.tab?.id;
    const domain = toDomain(sender.tab?.url);

    if (typeof tabId !== 'number' || !domain) {
      sendResponse({ success: false, error: 'Missing tab context' });
      return;
    }

    const wheelDelta = Number.parseFloat(request.wheelDelta);
    if (Number.isFinite(wheelDelta) && wheelDelta !== 0) {
      return replyWith(
        enqueueTabTask(tabId, () => runZoomAdjustment(tabId, domain, targetForWheelDelta(wheelDelta))),
        sendResponse
      );
    }

    let requestedSteps = normalizeDeltaSteps(request.deltaSteps, MAX_DELTA_STEPS_PER_REQUEST);
    if (requestedSteps === null) {
      const requestedDelta = Number.parseFloat(request.delta);
      if (!Number.isFinite(requestedDelta) || requestedDelta === 0) {
        sendResponse({ success: false, error: 'Invalid delta' });
        return;
      }
      requestedSteps = Math.sign(requestedDelta);
    }

    return replyWith(
      enqueueTabTask(tabId, () => runZoomAdjustment(tabId, domain, targetForSteps(requestedSteps))),
      sendResponse
    );
  }

  if (request.action === 'adjustZoomByCommand') {
    const tabId = sender.tab?.id;
    const domain = toDomain(sender.tab?.url);

    if (typeof tabId !== 'number' || !domain) {
      sendResponse({ success: false, error: 'Missing tab context' });
      return;
    }

    const command = request.command;
    if (!['zoom-in', 'zoom-out', 'zoom-reset'].includes(command)) {
      sendResponse({ success: false, error: 'Invalid command' });
      return;
    }

    return replyWith(
      enqueueTabTask(tabId, () => runZoomAdjustment(tabId, domain, targetForCommand(command))),
      sendResponse
    );
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    markTabNavigating(tabId);
    // The new document reads stored levels on start; make sure they are
    // current.
    void flushPendingSiteUpdates();
    return;
  }

  if (changeInfo.status !== 'complete') return;

  try {
    await enqueueTabTask(tabId, () => applyStoredZoomForTab(tabId, tab.url));
  } catch (error) {
    console.error('Fine Zoom: Failed to apply stored zoom on tab update', error);
  } finally {
    navigatingTabs.delete(tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabTaskQueues.delete(tabId);
  recentZoomInputIntentByTab.delete(tabId);
  nativeDeltaAccumulatorByTab.delete(tabId);
  wheelAccumulatorByTab.delete(tabId);
  navigatingTabs.delete(tabId);
});

chrome.tabs.onZoomChange.addListener((zoomChangeInfo) => {
  handleNativeZoomChange(zoomChangeInfo).catch((error) => {
    console.error('Fine Zoom: Failed to sync native zoom change', error);
  });
});
