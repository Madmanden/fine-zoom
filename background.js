importScripts('shared/constants.js');

const isDomainExcluded = (domain, excludedSites) => {
  return excludedSites.some(site => domain === site || domain.endsWith('.' + site));
};

const normalizeMethod = (method) => {
  if (method === 'transform') return 'browser-zoom';
  if (method === 'browser-zoom' || method === 'font-size' || method === 'css-zoom') return method;
  return DEFAULT_METHOD;
};

const isNativeZoomMethod = (method) => method === 'browser-zoom';

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
  await chrome.tabs.setZoom(tabId, clamped);
  const applied = await chrome.tabs.getZoom(tabId);
  return clampNativeZoom(applied);
};

const applyContentZoom = async (tabId, level, method) => {
  const clamped = clampContentZoom(level);
  await chrome.tabs.setZoom(tabId, 1.0);
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
    files: ['shared/constants.js', 'content/zoom-methods.js', 'content/content.js']
  });

  await chrome.tabs.sendMessage(tabId, message);
  return true;
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
    await chrome.tabs.setZoom(tabId, 1.0);
    await clearContentZoom(tabId);
    return;
  }

  const siteConfig = data.perSiteZoom?.[domain];
  const level = siteConfig?.level ?? data.defaultLevel ?? DEFAULT_LEVEL;
  const method = normalizeMethod(siteConfig?.method ?? data.defaultMethod ?? DEFAULT_METHOD);

  await applyMethodZoom(tabId, level, method);
};

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get([
    'defaultMethod',
    'defaultLevel',
    'perSiteZoom',
    'excludedSites',
    'didMigrateToFontSizeDefault',
    'didMigrateToBrowserZoomDefault',
    'debugHighlightScaledText'
  ]);

  const defaults = {
    defaultMethod: DEFAULT_METHOD,
    defaultLevel: DEFAULT_LEVEL,
    defaultPopupButtonStep: DEFAULT_POPUP_BUTTON_STEP,
    perSiteZoom: {},
    excludedSites: ['youtube.com', 'docs.google.com', 'drive.google.com'],
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
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;

  try {
    await applyStoredZoomForTab(tabId, tab.url);
  } catch (error) {
    console.error('Text Zoom: Failed to apply stored zoom on tab update', error);
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
