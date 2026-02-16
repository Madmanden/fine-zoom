chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get([
    'defaultMethod',
    'defaultLevel',
    'perSiteZoom',
    'excludedSites'
  ]);

  const defaults = {
    defaultMethod: 'css-zoom',
    defaultLevel: 1.0,
    perSiteZoom: {},
    excludedSites: ['youtube.com', 'docs.google.com', 'drive.google.com']
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
});

const ZOOM_STEP = 0.05;
const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;

chrome.commands.onCommand.addListener(async (command) => {
  if (!['zoom-in', 'zoom-out', 'zoom-reset'].includes(command)) {
    return;
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  if (!tab.url) return;

  let url;
  try {
    url = new URL(tab.url);
  } catch {
    return;
  }

  if (!/^https?:$/.test(url.protocol)) return;

  const domain = url.hostname;

  const data = await chrome.storage.local.get([
    'perSiteZoom',
    'defaultLevel',
    'defaultMethod',
    'excludedSites'
  ]);

  const excludedSites = data.excludedSites || [];
  if (excludedSites.some(site => domain.endsWith(site))) return;

  const perSiteZoom = data.perSiteZoom || {};
  const defaultLevel = data.defaultLevel ?? 1.0;
  const defaultMethod = data.defaultMethod ?? 'css-zoom';

  const currentZoom = perSiteZoom[domain]?.level ?? defaultLevel;

  let newZoom = currentZoom;

  switch (command) {
    case 'zoom-in':
      newZoom = Math.min(ZOOM_MAX, currentZoom + ZOOM_STEP);
      break;
    case 'zoom-out':
      newZoom = Math.max(ZOOM_MIN, currentZoom - ZOOM_STEP);
      break;
    case 'zoom-reset':
      newZoom = defaultLevel;
      break;
    default:
      return;
  }

  if (newZoom !== currentZoom) {
    const method = perSiteZoom[domain]?.method ?? defaultMethod;

    await chrome.storage.local.set({
      perSiteZoom: {
        ...perSiteZoom,
        [domain]: { level: newZoom, method }
      }
    });

    try {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'setZoom',
        level: newZoom,
        method: method
      });
    } catch (error) {
      console.error('Text Zoom: Failed to apply zoom via keyboard shortcut', error);
    }
  }
});