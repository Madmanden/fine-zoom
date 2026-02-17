importScripts('shared/constants.js', 'shared/utils.js');

const { isDomainExcluded } = TextZoomUtils;
const normalizeMethod = (method) => TextZoomUtils.normalizeMethod(method, DEFAULT_METHOD);

const isNativeZoomMethod = (method) => method === 'browser-zoom';
const tabDeltaQueues = new Map();
const ZOOM_COMPARE_EPSILON = 0.001;

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

const areZoomLevelsEqual = (a, b) => {
  return Math.abs(Number(a) - Number(b)) < ZOOM_COMPARE_EPSILON;
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
    console.error('Text Zoom: Failed to clear content zoom', error);
  }
};

const applyNativeZoom = async (tabId, level) => {
  const clamped = clampNativeZoom(level);
  const current = clampNativeZoom(await chrome.tabs.getZoom(tabId));
  if (areZoomLevelsEqual(current, clamped)) {
    return current;
  }
  await chrome.tabs.setZoom(tabId, clamped);
  const applied = await chrome.tabs.getZoom(tabId);
  return clampNativeZoom(applied);
};

const applyContentZoom = async (tabId, level, method) => {
  const clamped = clampContentZoom(level);
  const currentNativeZoom = clampNativeZoom(await chrome.tabs.getZoom(tabId));
  if (!areZoomLevelsEqual(currentNativeZoom, 1.0)) {
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

const ensureContentScriptAndSend = async (tabId, message) => {
  try {
    await chrome.tabs.sendMessage(tabId, message);
    return true;
  } catch (error) {
    const messageText = error?.message || String(error);
    if (!messageText.includes('Receiving end does not exist')) {
      throw error;
    }
  }

  await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    files: ['shared/constants.js', 'shared/utils.js', 'content/zoom-methods.js', 'content/content.js']
  });

  await chrome.tabs.sendMessage(tabId, message);
  return true;
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
    const currentNativeZoom = clampNativeZoom(await chrome.tabs.getZoom(tabId));
    if (!areZoomLevelsEqual(currentNativeZoom, 1.0)) {
      await chrome.tabs.setZoom(tabId, 1.0);
    }
    await clearContentZoom(tabId);
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
  const storedLevel = perSiteZoom[domain]?.level;
  const storedMethod = normalizeMethod(perSiteZoom[domain]?.method ?? effectiveMethod);

  if (storedMethod === 'browser-zoom' && areZoomLevelsEqual(storedLevel, clampedLevel)) {
    return;
  }

  await chrome.storage.local.set({
    perSiteZoom: {
      ...perSiteZoom,
      [domain]: { level: clampedLevel, method: 'browser-zoom' }
    }
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
    'didMigrateToFontSizeDefault',
    'didMigrateToBrowserZoomDefault',
    'didMigrateMainButtonStepTo005',
    'debugHighlightScaledText'
  ]);

  const defaults = {
    defaultMethod: DEFAULT_METHOD,
    defaultLevel: DEFAULT_LEVEL,
    defaultPopupButtonStep: DEFAULT_POPUP_BUTTON_STEP,
    enableCtrlWheelHijack: true,
    enableCtrlKeyHijack: true,
    perSiteZoom: {},
    excludedSites: [],
    debugHighlightScaledText: DEFAULT_DEBUG_HIGHLIGHT
  };

  const toSet = {};
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in existing)) {
      toSet[key] = value;
    }
  }

  if (Object.keys(toSet).length > 0) {
    await chrome.storage.local.set(toSet);
  }

  if (!existing.didMigrateToFontSizeDefault) {
    await chrome.storage.local.set({ didMigrateToFontSizeDefault: true });
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

  if (request.action === 'getHijackEligibility') {
    const tabUrl = sender.tab?.url;
    const domain = toDomain(tabUrl);

    if (!domain) {
      sendResponse({ success: true, enabledForPage: false, ctrlWheelEnabled: false, ctrlKeyEnabled: false });
      return;
    }

    chrome.storage.local.get(['excludedSites', 'enableCtrlWheelHijack', 'enableCtrlKeyHijack'])
      .then((data) => {
        const excludedSites = data.excludedSites ?? [];
        const enabledForPage = !isDomainExcluded(domain, excludedSites);
        sendResponse({
          success: true,
          enabledForPage,
          ctrlWheelEnabled: enabledForPage && (data.enableCtrlWheelHijack ?? true),
          ctrlKeyEnabled: enabledForPage && (data.enableCtrlKeyHijack ?? true)
        });
      })
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

      const delta = Math.sign(requestedDelta) * ZOOM_STEP;
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

      await chrome.storage.local.set({
        perSiteZoom: {
          ...perSiteZoom,
          [domain]: { level: appliedLevel, method }
        }
      });

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

    enqueueTabDeltaTask(tabId, async () => {
      const data = await chrome.storage.local.get([
        'perSiteZoom',
        'defaultLevel',
        'defaultMethod',
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

      let newZoom;
      switch (command) {
        case 'zoom-in':
          newZoom = isNativeZoomMethod(method)
            ? clampNativeZoom(currentZoom + ZOOM_STEP)
            : clampContentZoom(currentZoom + ZOOM_STEP);
          break;
        case 'zoom-out':
          newZoom = isNativeZoomMethod(method)
            ? clampNativeZoom(currentZoom - ZOOM_STEP)
            : clampContentZoom(currentZoom - ZOOM_STEP);
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

      await chrome.storage.local.set({
        perSiteZoom: {
          ...perSiteZoom,
          [domain]: { level: appliedLevel, method }
        }
      });

      return { success: true, level: appliedLevel };
    })
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
    console.error('Text Zoom: Failed to apply stored zoom on tab update', error);
  }
});

chrome.tabs.onZoomChange.addListener(async (zoomChangeInfo) => {
  try {
    const tab = await chrome.tabs.get(zoomChangeInfo.tabId);
    await syncNativeZoomToStorageIfNeeded(zoomChangeInfo.tabId, tab?.url, zoomChangeInfo.newZoomFactor);
  } catch (error) {
    console.error('Text Zoom: Failed to sync native zoom change', error);
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (!['zoom-in', 'zoom-out', 'zoom-reset'].includes(command)) {
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  const domain = toDomain(tab?.url);
  if (!domain) return;

  const data = await chrome.storage.local.get([
    'perSiteZoom',
    'defaultLevel',
    'defaultMethod',
    'excludedSites'
  ]);

  const excludedSites = data.excludedSites ?? [];
  if (isDomainExcluded(domain, excludedSites)) return;

  const perSiteZoom = data.perSiteZoom || {};
  const defaultLevel = data.defaultLevel ?? DEFAULT_LEVEL;
  const defaultMethod = data.defaultMethod ?? DEFAULT_METHOD;
  const method = normalizeMethod(perSiteZoom[domain]?.method ?? defaultMethod);

  let currentZoom;
  if (isNativeZoomMethod(method)) {
    currentZoom = clampNativeZoom(await chrome.tabs.getZoom(tab.id));
  } else {
    currentZoom = clampContentZoom(perSiteZoom[domain]?.level ?? defaultLevel);
  }

  let newZoom = currentZoom;

  switch (command) {
    case 'zoom-in':
      newZoom = isNativeZoomMethod(method)
        ? Math.min(BROWSER_ZOOM_MAX, currentZoom + BROWSER_ZOOM_STEP)
        : Math.min(ZOOM_MAX, currentZoom + ZOOM_STEP);
      break;
    case 'zoom-out':
      newZoom = isNativeZoomMethod(method)
        ? Math.max(BROWSER_ZOOM_MIN, currentZoom - BROWSER_ZOOM_STEP)
        : Math.max(ZOOM_MIN, currentZoom - ZOOM_STEP);
      break;
    case 'zoom-reset':
      newZoom = isNativeZoomMethod(method)
        ? clampNativeZoom(defaultLevel)
        : clampContentZoom(defaultLevel);
      break;
    default:
      return;
  }

  newZoom = Number(newZoom.toFixed(2));
  if (newZoom === currentZoom) return;

  const appliedLevel = await applyMethodZoom(tab.id, newZoom, method);

  await chrome.storage.local.set({
    perSiteZoom: {
      ...perSiteZoom,
      [domain]: { level: appliedLevel, method: normalizeMethod(method) }
    }
  });
});
