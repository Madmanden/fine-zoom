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

chrome.commands.onCommand.addListener(async (command) => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  
  const url = new URL(tab.url);
  const domain = url.hostname;
  
  const data = await chrome.storage.local.get(['perSiteZoom', 'defaultLevel']);
  const currentZoom = data.perSiteZoom[domain]?.level || data.defaultLevel;
  
  let newZoom = currentZoom;
  
  switch (command) {
    case 'zoom-in':
      newZoom = Math.min(3.0, currentZoom + 0.05);
      break;
    case 'zoom-out':
      newZoom = Math.max(0.5, currentZoom - 0.05);
      break;
    case 'zoom-reset':
      newZoom = 1.0;
      break;
  }
  
  if (newZoom !== currentZoom) {
    const method = data.perSiteZoom[domain]?.method || 'css-zoom';
    
    await chrome.storage.local.set({
      perSiteZoom: {
        ...data.perSiteZoom,
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