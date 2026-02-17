document.addEventListener('DOMContentLoaded', async () => {
  const zoomSlider = document.getElementById('zoomSlider');
  const zoomLevel = document.getElementById('zoomLevel');
  const zoomIn = document.getElementById('zoomIn');
  const zoomOut = document.getElementById('zoomOut');
  const resetBtn = document.getElementById('resetBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const zoomMethod = document.getElementById('zoomMethod');

  const showError = (message) => {
    const errorDiv = document.getElementById('errorMessage') || document.createElement('div');
    errorDiv.id = 'errorMessage';
    errorDiv.style.cssText = 'background: #fee; color: #c33; padding: 8px; border-radius: 4px; margin-top: 12px; font-size: 12px; text-align: center;';
    errorDiv.textContent = message;
    if (!document.getElementById('errorMessage')) {
      document.querySelector('.container').appendChild(errorDiv);
    }
    setTimeout(() => errorDiv.remove(), 3000);
  };

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab?.url) {
    showError('Cannot zoom this page');
    return;
  }

  let url;
  try {
    url = new URL(tab.url);
  } catch {
    showError('Cannot zoom this page');
    return;
  }

  if (!/^https?:$/.test(url.protocol)) {
    showError('Zoom only works on web pages');
    return;
  }

  const domain = url.hostname;

  let data;
  try {
    data = await chrome.storage.local.get([
      'perSiteZoom',
      'defaultLevel',
      'defaultMethod',
      'defaultPopupButtonStep'
    ]);
  } catch (error) {
    console.error('Text Zoom: Failed to load settings', error);
    showError('Failed to load settings');
    return;
  }

  const defaultLevel = data.defaultLevel ?? DEFAULT_LEVEL;
  const siteConfig = data.perSiteZoom?.[domain];
  let currentLevel = siteConfig?.level ?? defaultLevel;
  let currentMethod = siteConfig?.method ?? data.defaultMethod ?? DEFAULT_METHOD;
  const parsedButtonStep = parseFloat(data.defaultPopupButtonStep);
  const buttonStep = Number.isFinite(parsedButtonStep)
    ? Math.max(POPUP_BUTTON_STEP_MIN, Math.min(POPUP_BUTTON_STEP_MAX, parsedButtonStep))
    : DEFAULT_POPUP_BUTTON_STEP;

  zoomSlider.value = currentLevel;
  zoomLevel.textContent = currentLevel.toFixed(2) + 'x';
  zoomMethod.value = currentMethod;

  const normalizeLevel = (value) => Math.round(value * 100) / 100;

  const ensureContentScriptAndSend = async (message) => {
    try {
      await chrome.tabs.sendMessage(tab.id, message);
      return true;
    } catch (error) {
      const messageText = error?.message || String(error);
      if (!messageText.includes('Receiving end does not exist')) {
        throw error;
      }
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['shared/constants.js', 'content/zoom-methods.js', 'content/content.js']
    });

    await chrome.tabs.sendMessage(tab.id, message);
    return true;
  };

  const updateZoom = async (level, method) => {
    currentLevel = level;
    currentMethod = method;

    zoomSlider.value = level;
    zoomLevel.textContent = level.toFixed(2) + 'x';

    const newPerSiteZoom = {
      ...data.perSiteZoom,
      [domain]: { level, method }
    };

    try {
      await chrome.storage.local.set({ perSiteZoom: newPerSiteZoom });
    } catch (error) {
      console.error('Text Zoom: Failed to save zoom', error);
      showError('Failed to save zoom');
      return;
    }

    try {
      await ensureContentScriptAndSend({
        action: 'setZoom',
        level: level,
        method: method
      });
    } catch (error) {
      console.error('Text Zoom: Failed to apply zoom', error);
      showError('Zoom saved but could not be applied on this page.');
    }
  };

  zoomSlider.addEventListener('input', (e) => {
    const level = parseFloat(e.target.value);
    zoomLevel.textContent = level.toFixed(2) + 'x';
  });

  zoomSlider.addEventListener('change', (e) => {
    const level = parseFloat(e.target.value);
    updateZoom(level, currentMethod);
  });

  zoomIn.addEventListener('click', () => {
    const newLevel = Math.min(ZOOM_MAX, normalizeLevel(currentLevel + buttonStep));
    updateZoom(newLevel, currentMethod);
  });

  zoomOut.addEventListener('click', () => {
    const newLevel = Math.max(ZOOM_MIN, normalizeLevel(currentLevel - buttonStep));
    updateZoom(newLevel, currentMethod);
  });

  resetBtn.addEventListener('click', () => {
    updateZoom(defaultLevel, currentMethod);
  });

  zoomMethod.addEventListener('change', (e) => {
    const method = e.target.value;
    updateZoom(currentLevel, method);
  });

  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
