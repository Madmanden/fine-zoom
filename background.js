importScripts('shared/constants.js', 'shared/utils.js', 'shared/messaging.js');

const {
  accumulateZoomActionSteps,
  areZoomLevelsEqual,
  buildUpdatedPerSiteZoom,
  isDomainExcluded,
  isScriptablePageUrl
} = TextZoomUtils;
const { ensureContentScriptAndSend } = TextZoomMessaging;
const normalizeMethod = (method) => TextZoomUtils.normalizeMethod(method, DEFAULT_METHOD);

const isNativeZoomMethod = (method) => method === 'browser-zoom';
const tabDeltaQueues = new Map();
const expectedNativeZoomByTab = new Map();
const recentWheelHijackByTab = new Map();
const recentZoomInputIntentByTab = new Map();
const nativeDeltaAccumulatorByTab = new Map();
const EXPECTED_NATIVE_ZOOM_TTL_MS = 1500;
const RECENT_WHEEL_HIJACK_WINDOW_MS = 120;
const RECENT_INPUT_INTENT_WINDOW_MS = 500;
const MAX_DELTA_STEPS_PER_REQUEST = 20;
// Chromium page-zoom actions move roughly 5% (newer builds use a uniform 5%
// grid, older builds use coarser presets). Used to translate streamed
// fractional gesture deltas into fine steps.
const NATIVE_ZOOM_ACTION_STEP = 0.05;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let settingsCache = null;

const invalidateSettingsCache = () => {
  settingsCache = null;
};

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

const getSettings = async () => {
  if (settingsCache) return settingsCache;

  const data = await chrome.storage.local.get([
    'perSiteZoom',
    'defaultLevel',
    'defaultMethod',
    'defaultZoomStep',
    'excludedSites',
    'enableCtrlWheelHijack',
    'enableCtrlKeyHijack'
  ]);

  settingsCache = {
    perSiteZoom: data.perSiteZoom ?? {},
    defaultLevel: clampContentZoom(data.defaultLevel),
    defaultMethod: normalizeMethod(data.defaultMethod),
    defaultZoomStep: clampStep(data.defaultZoomStep, DEFAULT_ZOOM_STEP),
    excludedSites: data.excludedSites ?? [],
    enableCtrlWheelHijack: data.enableCtrlWheelHijack ?? true,
    enableCtrlKeyHijack: data.enableCtrlKeyHijack ?? true
  };

  return settingsCache;
};

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local' || !settingsCache) return;

  if (changes.perSiteZoom) {
    settingsCache.perSiteZoom = changes.perSiteZoom.newValue ?? {};
  }

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
  }
});

const persistPerSiteZoom = async (perSiteZoom) => {
  if (settingsCache) {
    settingsCache.perSiteZoom = perSiteZoom;
  }
  await chrome.storage.local.set({ perSiteZoom });
};

const persistZoomForDomain = async (settings, domain, level, method) => {
  const nextPerSiteZoom = buildUpdatedPerSiteZoom({
    perSiteZoom: settings.perSiteZoom,
    domain,
    level,
    method,
    defaultLevel: settings.defaultLevel,
    defaultMethod: settings.defaultMethod
  });

  if (!nextPerSiteZoom) return;
  await persistPerSiteZoom(nextPerSiteZoom);
};

const markRecentWheelHijack = (tabId) => {
  recentWheelHijackByTab.set(tabId, Date.now());
};

const hasRecentWheelHijack = (tabId) => {
  const timestamp = recentWheelHijackByTab.get(tabId);
  if (!timestamp) return false;

  if (Date.now() - timestamp > RECENT_WHEEL_HIJACK_WINDOW_MS) {
    recentWheelHijackByTab.delete(tabId);
    return false;
  }

  return true;
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

const rememberExpectedNativeZoom = (tabId, level) => {
  expectedNativeZoomByTab.set(tabId, {
    level: clampNativeZoom(level),
    expiresAt: Date.now() + EXPECTED_NATIVE_ZOOM_TTL_MS
  });
};

const consumeExpectedNativeZoom = (tabId, observedLevel) => {
  const expected = expectedNativeZoomByTab.get(tabId);
  if (!expected) return false;

  if (Date.now() > expected.expiresAt) {
    expectedNativeZoomByTab.delete(tabId);
    return false;
  }

  if (!areZoomLevelsEqual(expected.level, clampNativeZoom(observedLevel))) {
    return false;
  }

  expectedNativeZoomByTab.delete(tabId);
  return true;
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

const applyNativeZoom = async (tabId, level) => {
  const clamped = clampNativeZoom(level);
  const current = clampNativeZoom(await chrome.tabs.getZoom(tabId));
  if (areZoomLevelsEqual(current, clamped)) {
    return current;
  }
  rememberExpectedNativeZoom(tabId, clamped);
  await chrome.tabs.setZoom(tabId, clamped);
  const applied = await chrome.tabs.getZoom(tabId);
  return clampNativeZoom(applied);
};

const applyContentZoom = async (tabId, level, method) => {
  const clamped = clampContentZoom(level);
  const currentNativeZoom = clampNativeZoom(await chrome.tabs.getZoom(tabId));
  if (!areZoomLevelsEqual(currentNativeZoom, 1.0)) {
    rememberExpectedNativeZoom(tabId, 1.0);
    await chrome.tabs.setZoom(tabId, 1.0);
  }
  await ensureContentScriptAndSend(tabId, {
    action: 'setZoom',
    level: clamped,
    method
  });
  return clamped;
};

const applyMethodZoom = async (tabId, level, method) => {
  const normalizedMethod = normalizeMethod(method);

  if (isNativeZoomMethod(normalizedMethod)) {
    await clearContentZoom(tabId);
    return applyNativeZoom(tabId, level);
  }

  return applyContentZoom(tabId, level, normalizedMethod);
};

const enqueueTabDeltaTask = (tabId, task) => {
  const previous = tabDeltaQueues.get(tabId) ?? Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(task);

  tabDeltaQueues.set(tabId, next.finally(() => {
    if (tabDeltaQueues.get(tabId) === next) {
      tabDeltaQueues.delete(tabId);
    }
  }));

  return next;
};

const runZoomCommand = async (tabId, domain, command) => {
  const settings = await getSettings();

  if (isDomainExcluded(domain, settings.excludedSites)) {
    return { success: true, level: 1.0, excluded: true };
  }

  nativeDeltaAccumulatorByTab.delete(tabId);

  const perSiteZoom = settings.perSiteZoom;
  const method = normalizeMethod(perSiteZoom[domain]?.method ?? settings.defaultMethod);

  let currentZoom;
  if (isNativeZoomMethod(method)) {
    currentZoom = clampNativeZoom(await chrome.tabs.getZoom(tabId));
  } else {
    currentZoom = clampContentZoom(perSiteZoom[domain]?.level ?? settings.defaultLevel);
  }

  const configuredStep = settings.defaultZoomStep;
  let newZoom;
  switch (command) {
    case 'zoom-in':
      newZoom = isNativeZoomMethod(method)
        ? clampNativeZoom(currentZoom + configuredStep)
        : clampContentZoom(currentZoom + configuredStep);
      break;
    case 'zoom-out':
      newZoom = isNativeZoomMethod(method)
        ? clampNativeZoom(currentZoom - configuredStep)
        : clampContentZoom(currentZoom - configuredStep);
      break;
    case 'zoom-reset':
      newZoom = isNativeZoomMethod(method)
        ? clampNativeZoom(settings.defaultLevel)
        : clampContentZoom(settings.defaultLevel);
      break;
    default:
      return { success: false, error: 'Invalid command' };
  }

  if (areZoomLevelsEqual(newZoom, currentZoom)) {
    return { success: true, level: currentZoom };
  }

  const appliedLevel = await applyMethodZoom(tabId, newZoom, method);
  await persistZoomForDomain(settings, domain, appliedLevel, method);

  return { success: true, level: appliedLevel };
};

const applyStoredZoomForTab = async (tabId, tabUrl) => {
  const domain = toDomain(tabUrl);
  if (!domain) return;

  const settings = await getSettings();
  if (isDomainExcluded(domain, settings.excludedSites)) return;

  const siteConfig = settings.perSiteZoom[domain];
  const level = siteConfig?.level ?? settings.defaultLevel;
  const method = normalizeMethod(siteConfig?.method ?? settings.defaultMethod);

  // A document that was just loaded cannot contain zoom styles from an
  // earlier content-zoom session, so native mode can skip the cleanup
  // message that would otherwise hit every frame on each navigation.
  if (isNativeZoomMethod(method)) {
    await applyNativeZoom(tabId, level);
    return;
  }

  await applyContentZoom(tabId, level, method);
};

const syncNativeZoomToStorageIfNeeded = async (tabId, tabUrl, nativeLevel) => {
  const domain = toDomain(tabUrl);
  if (!domain) return;

  const settings = await getSettings();
  if (isDomainExcluded(domain, settings.excludedSites)) return;

  const effectiveMethod = normalizeMethod(settings.perSiteZoom[domain]?.method ?? settings.defaultMethod);

  if (!isNativeZoomMethod(effectiveMethod)) {
    // Content methods own the scaling on this site; browser zoom must not
    // stack on top of them (for example when the Chrome menu was used).
    if (!areZoomLevelsEqual(clampNativeZoom(nativeLevel), 1.0)) {
      rememberExpectedNativeZoom(tabId, 1.0);
      await chrome.tabs.setZoom(tabId, 1.0);
    }
    return;
  }

  await persistZoomForDomain(settings, domain, clampNativeZoom(nativeLevel), effectiveMethod);
};

const maybeApplyShortcutHijackFallbackStep = async (zoomChangeInfo, tabUrl) => {
  const tabId = zoomChangeInfo.tabId;
  const recentIntent = getRecentZoomInputIntent(tabId);
  if (!recentIntent) return false;

  // Give the content script a moment to route the input through the regular
  // hijack path before treating this native zoom change as a page/browser
  // handled action that needs remapping.
  await sleep(RECENT_WHEEL_HIJACK_WINDOW_MS);
  if (hasRecentWheelHijack(tabId)) return false;

  const domain = toDomain(tabUrl);
  if (!domain) return false;

  const settings = await getSettings();
  if (isDomainExcluded(domain, settings.excludedSites)) return false;

  if (!TextZoomUtils.shouldApplyFallbackForIntent(
    recentIntent.kind,
    settings.enableCtrlWheelHijack,
    settings.enableCtrlKeyHijack
  )) {
    return false;
  }

  const perSiteZoom = settings.perSiteZoom;
  const method = normalizeMethod(perSiteZoom[domain]?.method ?? settings.defaultMethod);
  const configuredStep = settings.defaultZoomStep;

  if (recentIntent.kind === 'key' && recentIntent.command === 'zoom-reset') {
    const appliedLevel = await applyMethodZoom(tabId, settings.defaultLevel, method);
    await persistZoomForDomain(settings, domain, appliedLevel, method);
    return true;
  }

  const oldLevel = clampNativeZoom(zoomChangeInfo.oldZoomFactor);
  const newLevel = clampNativeZoom(zoomChangeInfo.newZoomFactor);
  const direction = Math.sign(newLevel - oldLevel);
  if (direction === 0) return false;

  let stepCount = 1;

  // Keyboard zoom shortcuts produce one native zoom action per event, so a
  // single fine step is the correct remap regardless of how large the
  // browser's own step is. Non-cancelable gestures (trackpad pinch) stream
  // fractional deltas instead; accumulate those and translate a full browser
  // action into one fine step.
  if (recentIntent.kind === 'wheel') {
    const accumulated = accumulateZoomActionSteps({
      accumulated: nativeDeltaAccumulatorByTab.get(tabId) ?? 0,
      delta: newLevel - oldLevel,
      threshold: NATIVE_ZOOM_ACTION_STEP,
      maxSteps: MAX_DELTA_STEPS_PER_REQUEST
    });

    if (accumulated.steps < 1) {
      nativeDeltaAccumulatorByTab.set(tabId, accumulated.remainder);
      return false;
    }

    nativeDeltaAccumulatorByTab.set(tabId, accumulated.remainder);
    stepCount = accumulated.steps;
  } else {
    nativeDeltaAccumulatorByTab.delete(tabId);
  }

  let appliedLevel;
  if (isNativeZoomMethod(method)) {
    const remappedLevel = clampNativeZoom(oldLevel + direction * configuredStep * stepCount);
    if (areZoomLevelsEqual(remappedLevel, newLevel)) return false;
    appliedLevel = await applyNativeZoom(tabId, remappedLevel);
  } else {
    const currentLevel = clampContentZoom(perSiteZoom[domain]?.level ?? settings.defaultLevel);
    const remappedLevel = clampContentZoom(currentLevel + direction * configuredStep * stepCount);
    if (areZoomLevelsEqual(remappedLevel, currentLevel)) return false;
    appliedLevel = await applyMethodZoom(tabId, remappedLevel, method);
  }

  await persistZoomForDomain(settings, domain, appliedLevel, method);
  return true;
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

  if (request.action === 'applyNativeZoom') {
    const tabId = request.tabId ?? sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Missing tab id' });
      return;
    }

    clearContentZoom(tabId)
      .then(() => applyNativeZoom(tabId, request.level))
      .then((level) => sendResponse({ success: true, level }))
      .catch((error) => {
        sendResponse({ success: false, error: error?.message || String(error) });
      });
    return true;
  }

  if (request.action === 'getNativeZoom') {
    const tabId = request.tabId ?? sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Missing tab id' });
      return;
    }

    chrome.tabs.getZoom(tabId)
      .then((level) => sendResponse({ success: true, level: clampNativeZoom(level) }))
      .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
  }

  if (request.action === 'applyContentZoom') {
    const tabId = request.tabId ?? sender.tab?.id;
    if (typeof tabId !== 'number') {
      sendResponse({ success: false, error: 'Missing tab id' });
      return;
    }

    applyContentZoom(tabId, request.level, request.method)
      .then((level) => sendResponse({ success: true, level }))
      .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
  }

  if (request.action === 'adjustZoomByDelta') {
    const tabId = sender.tab?.id;
    const domain = toDomain(sender.tab?.url);

    if (typeof tabId !== 'number' || !domain) {
      sendResponse({ success: false, error: 'Missing tab context' });
      return;
    }

    let requestedSteps = TextZoomUtils.normalizeDeltaSteps(request.deltaSteps, MAX_DELTA_STEPS_PER_REQUEST);
    if (requestedSteps === null) {
      const requestedDelta = Number.parseFloat(request.delta);
      if (!Number.isFinite(requestedDelta) || requestedDelta === 0) {
        sendResponse({ success: false, error: 'Invalid delta' });
        return;
      }
      requestedSteps = Math.sign(requestedDelta);
    }

    if (request.source === 'wheel-hijack') {
      markRecentWheelHijack(tabId);
    }

    enqueueTabDeltaTask(tabId, async () => {
      const settings = await getSettings();

      if (isDomainExcluded(domain, settings.excludedSites)) {
        return { success: true, level: 1.0, excluded: true };
      }

      nativeDeltaAccumulatorByTab.delete(tabId);

      const perSiteZoom = settings.perSiteZoom;
      const method = normalizeMethod(perSiteZoom[domain]?.method ?? settings.defaultMethod);

      let currentZoom;
      if (isNativeZoomMethod(method)) {
        currentZoom = clampNativeZoom(await chrome.tabs.getZoom(tabId));
      } else {
        currentZoom = clampContentZoom(perSiteZoom[domain]?.level ?? settings.defaultLevel);
      }

      const delta = settings.defaultZoomStep * requestedSteps;
      let newZoom;
      if (isNativeZoomMethod(method)) {
        newZoom = clampNativeZoom(currentZoom + delta);
      } else {
        newZoom = clampContentZoom(currentZoom + delta);
      }

      if (areZoomLevelsEqual(newZoom, currentZoom)) {
        return { success: true, level: currentZoom };
      }

      const appliedLevel = await applyMethodZoom(tabId, newZoom, method);
      await persistZoomForDomain(settings, domain, appliedLevel, method);

      return { success: true, level: appliedLevel };
    })
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
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

    enqueueTabDeltaTask(tabId, () => runZoomCommand(tabId, domain, command))
      .then((result) => sendResponse(result))
      .catch((error) => sendResponse({ success: false, error: error?.message || String(error) }));
    return true;
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;

  try {
    await applyStoredZoomForTab(tabId, tab.url);
  } catch (error) {
    console.error('Fine Zoom: Failed to apply stored zoom on tab update', error);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabDeltaQueues.delete(tabId);
  expectedNativeZoomByTab.delete(tabId);
  recentWheelHijackByTab.delete(tabId);
  recentZoomInputIntentByTab.delete(tabId);
  nativeDeltaAccumulatorByTab.delete(tabId);
});

chrome.tabs.onZoomChange.addListener(async (zoomChangeInfo) => {
  try {
    const tab = await chrome.tabs.get(zoomChangeInfo.tabId);
    if (consumeExpectedNativeZoom(zoomChangeInfo.tabId, zoomChangeInfo.newZoomFactor)) {
      await syncNativeZoomToStorageIfNeeded(zoomChangeInfo.tabId, tab?.url, zoomChangeInfo.newZoomFactor);
      return;
    }

    const didApplyFallbackStep = await maybeApplyShortcutHijackFallbackStep(zoomChangeInfo, tab?.url);
    if (!didApplyFallbackStep) {
      await syncNativeZoomToStorageIfNeeded(zoomChangeInfo.tabId, tab?.url, zoomChangeInfo.newZoomFactor);
    }
  } catch (error) {
    console.error('Fine Zoom: Failed to sync native zoom change', error);
  }
});
