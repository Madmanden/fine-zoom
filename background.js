importScripts('shared/constants.js', 'shared/utils.js', 'shared/messaging.js');

const { isDomainExcluded } = TextZoomUtils;
const { ensureContentScriptAndSend } = TextZoomMessaging;
const normalizeMethod = (method) => TextZoomUtils.normalizeMethod(method, DEFAULT_METHOD);

const isNativeZoomMethod = (method) => method === 'browser-zoom';
const tabDeltaQueues = new Map();
const expectedNativeZoomByTab = new Map();
const ZOOM_COMPARE_EPSILON = 0.001;
const EXPECTED_NATIVE_ZOOM_TTL_MS = 1500;

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

const areZoomLevelsEqual = (a, b) => {
  return Math.abs(Number(a) - Number(b)) < ZOOM_COMPARE_EPSILON;
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

const normalizeStoredLevel = (level) => {
  const parsed = Number.parseFloat(level);
  if (!Number.isFinite(parsed)) return DEFAULT_LEVEL;
  return Number(parsed.toFixed(2));
};

const buildUpdatedPerSiteZoom = (perSiteZoom, domain, level, method) => {
  const current = perSiteZoom ?? {};
  const shouldDelete = areZoomLevelsEqual(level, 1.0);

  if (shouldDelete) {
    if (!(domain in current)) return null;
    const next = { ...current };
    delete next[domain];
    return next;
  }

  const normalizedMethod = normalizeMethod(method);
  const normalizedLevel = normalizeStoredLevel(level);
  const existing = current[domain];
  const existingMethod = normalizeMethod(existing?.method);
  const existingLevel = normalizeStoredLevel(existing?.level);

  if (existing && existingMethod === normalizedMethod && areZoomLevelsEqual(existingLevel, normalizedLevel)) {
    return null;
  }

  return {
    ...current,
    [domain]: { level: normalizedLevel, method: normalizedMethod }
  };
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

const clearContentZoom = async (tabId) => {
  try {
    await ensureContentScriptAndSend(tabId, {
      action: 'setZoom',
      level: 1.0,
      method: 'font-size'
    });
  } catch (error) {
    console.error('Fine Zoom: Failed to clear content zoom', error);
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
  const data = await chrome.storage.local.get([
    'perSiteZoom',
    'defaultLevel',
    'defaultMethod',
    'defaultZoomStep',
    'excludedSites'
  ]);

  const excludedSites = data.excludedSites ?? [];
  if (isDomainExcluded(domain, excludedSites)) {
    return { success: true, level: 1.0, excluded: true };
  }

  const perSiteZoom = data.perSiteZoom || {};
  const defaultLevel = data.defaultLevel ?? DEFAULT_LEVEL;
  const defaultMethod = data.defaultMethod ?? DEFAULT_METHOD;
  const method = normalizeMethod(perSiteZoom[domain]?.method ?? defaultMethod);

  let currentZoom;
  if (isNativeZoomMethod(method)) {
    currentZoom = clampNativeZoom(await chrome.tabs.getZoom(tabId));
  } else {
    currentZoom = clampContentZoom(perSiteZoom[domain]?.level ?? defaultLevel);
  }

  const configuredStep = clampStep(data.defaultZoomStep, DEFAULT_ZOOM_STEP);
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
        ? clampNativeZoom(defaultLevel)
        : clampContentZoom(defaultLevel);
      break;
    default:
      return { success: false, error: 'Invalid command' };
  }

  if (newZoom === currentZoom) {
    return { success: true, level: currentZoom };
  }

  const appliedLevel = await applyMethodZoom(tabId, newZoom, method);
  const nextPerSiteZoom = buildUpdatedPerSiteZoom(perSiteZoom, domain, appliedLevel, method);
  if (nextPerSiteZoom) {
    await chrome.storage.local.set({ perSiteZoom: nextPerSiteZoom });
  }

  return { success: true, level: appliedLevel };
};

const applyStoredZoomForTab = async (tabId, tabUrl) => {
  const domain = toDomain(tabUrl);
  if (!domain) return;

  const data = await chrome.storage.local.get([
    'perSiteZoom',
    'defaultLevel',
    'defaultMethod',
    'excludedSites'
  ]);

  const excludedSites = data.excludedSites ?? [];
  if (isDomainExcluded(domain, excludedSites)) {
    return;
  }

  const siteConfig = data.perSiteZoom?.[domain];
  const level = siteConfig?.level ?? data.defaultLevel ?? DEFAULT_LEVEL;
  const method = normalizeMethod(siteConfig?.method ?? data.defaultMethod ?? DEFAULT_METHOD);

  await applyMethodZoom(tabId, level, method);
};

const syncNativeZoomToStorageIfNeeded = async (tabId, tabUrl, nativeLevel) => {
  const domain = toDomain(tabUrl);
  if (!domain) return;

  const data = await chrome.storage.local.get([
    'perSiteZoom',
    'defaultMethod',
    'excludedSites'
  ]);

  const excludedSites = data.excludedSites ?? [];
  if (isDomainExcluded(domain, excludedSites)) return;

  const perSiteZoom = data.perSiteZoom || {};
  const defaultMethod = data.defaultMethod ?? DEFAULT_METHOD;
  const effectiveMethod = normalizeMethod(perSiteZoom[domain]?.method ?? defaultMethod);
  if (!isNativeZoomMethod(effectiveMethod)) return;

  const clampedLevel = clampNativeZoom(nativeLevel);
  const nextPerSiteZoom = buildUpdatedPerSiteZoom(perSiteZoom, domain, clampedLevel, effectiveMethod);
  if (!nextPerSiteZoom) return;

  await chrome.storage.local.set({ perSiteZoom: nextPerSiteZoom });
};

const maybeApplyShortcutHijackFallbackStep = async (zoomChangeInfo, tabUrl) => {
  const domain = toDomain(tabUrl);
  if (!domain) return false;

  const data = await chrome.storage.local.get([
    'perSiteZoom',
    'defaultMethod',
    'defaultLevel',
    'defaultZoomStep',
    'excludedSites',
    'enableCtrlWheelHijack',
    'enableCtrlKeyHijack'
  ]);

  const excludedSites = data.excludedSites ?? [];
  if (isDomainExcluded(domain, excludedSites)) return false;

  const perSiteZoom = data.perSiteZoom || {};
  const defaultMethod = data.defaultMethod ?? DEFAULT_METHOD;
  const defaultLevel = data.defaultLevel ?? DEFAULT_LEVEL;
  const method = normalizeMethod(perSiteZoom[domain]?.method ?? defaultMethod);

  const ctrlWheelEnabled = data.enableCtrlWheelHijack ?? true;
  const ctrlKeyEnabled = data.enableCtrlKeyHijack ?? true;
  if (!ctrlWheelEnabled && !ctrlKeyEnabled) return false;

  const oldLevel = clampNativeZoom(zoomChangeInfo.oldZoomFactor);
  const newLevel = clampNativeZoom(zoomChangeInfo.newZoomFactor);
  const direction = Math.sign(newLevel - oldLevel);
  if (direction === 0) return false;

  const configuredStep = clampStep(data.defaultZoomStep, DEFAULT_ZOOM_STEP);
  let appliedLevel;
  if (isNativeZoomMethod(method)) {
    const remappedLevel = clampNativeZoom(oldLevel + direction * configuredStep);
    if (areZoomLevelsEqual(remappedLevel, newLevel)) return false;
    appliedLevel = await applyNativeZoom(zoomChangeInfo.tabId, remappedLevel);
  } else {
    const currentLevel = clampContentZoom(perSiteZoom[domain]?.level ?? defaultLevel);
    const remappedLevel = clampContentZoom(currentLevel + direction * configuredStep);
    appliedLevel = await applyMethodZoom(zoomChangeInfo.tabId, remappedLevel, method);
  }

  const nextPerSiteZoom = buildUpdatedPerSiteZoom(perSiteZoom, domain, appliedLevel, method);
  if (nextPerSiteZoom) {
    await chrome.storage.local.set({ perSiteZoom: nextPerSiteZoom });
  }

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
    const latest = await chrome.storage.local.get('perSiteZoom');
    const perSiteZoom = latest.perSiteZoom ?? {};
    const cleanedPerSiteZoom = {};
    let hasChanges = false;

    Object.entries(perSiteZoom).forEach(([domain, config]) => {
      if (areZoomLevelsEqual(config?.level, 1.0)) {
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
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;

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

    const requestedDelta = Number.parseFloat(request.delta);
    if (!Number.isFinite(requestedDelta) || requestedDelta === 0) {
      sendResponse({ success: false, error: 'Invalid delta' });
      return;
    }

    enqueueTabDeltaTask(tabId, async () => {
      const data = await chrome.storage.local.get([
        'perSiteZoom',
        'defaultLevel',
        'defaultMethod',
        'defaultZoomStep',
        'excludedSites'
      ]);

      const excludedSites = data.excludedSites ?? [];
      if (isDomainExcluded(domain, excludedSites)) {
        return { success: true, level: 1.0, excluded: true };
      }

      const perSiteZoom = data.perSiteZoom || {};
      const defaultLevel = data.defaultLevel ?? DEFAULT_LEVEL;
      const defaultMethod = data.defaultMethod ?? DEFAULT_METHOD;
      const method = normalizeMethod(perSiteZoom[domain]?.method ?? defaultMethod);

      let currentZoom;
      if (isNativeZoomMethod(method)) {
        currentZoom = clampNativeZoom(await chrome.tabs.getZoom(tabId));
      } else {
        currentZoom = clampContentZoom(perSiteZoom[domain]?.level ?? defaultLevel);
      }

      const configuredStep = clampStep(data.defaultZoomStep, DEFAULT_ZOOM_STEP);
      const delta = Math.sign(requestedDelta) * configuredStep;
      let newZoom;
      if (isNativeZoomMethod(method)) {
        newZoom = clampNativeZoom(currentZoom + delta);
      } else {
        newZoom = clampContentZoom(currentZoom + delta);
      }

      if (newZoom === currentZoom) {
        return { success: true, level: currentZoom };
      }

      const appliedLevel = await applyMethodZoom(tabId, newZoom, method);

      const nextPerSiteZoom = buildUpdatedPerSiteZoom(perSiteZoom, domain, appliedLevel, method);
      if (nextPerSiteZoom) {
        await chrome.storage.local.set({ perSiteZoom: nextPerSiteZoom });
      }

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

chrome.commands.onCommand.addListener(async (command) => {
  if (!['zoom-in', 'zoom-out', 'zoom-reset'].includes(command)) return;

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const domain = toDomain(tab?.url);
  if (!domain) return;

  enqueueTabDeltaTask(tab.id, () => runZoomCommand(tab.id, domain, command)).catch((error) => {
    console.error('Fine Zoom: Failed to apply zoom from command', error);
  });
});
