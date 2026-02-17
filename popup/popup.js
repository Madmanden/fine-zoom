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

  const isNativeZoomMethod = (method) => method === 'browser-zoom';

  const normalizeLevel = (value) => Math.round(value * 100) / 100;

  const getMethodBounds = (method, popupButtonStep) => {
    if (isNativeZoomMethod(method)) {
      return {
        min: BROWSER_ZOOM_MIN,
        max: BROWSER_ZOOM_MAX,
        sliderStep: BROWSER_ZOOM_STEP,
        buttonStep: BROWSER_ZOOM_STEP
      };
    }

    return {
      min: ZOOM_MIN,
      max: ZOOM_MAX,
      sliderStep: ZOOM_STEP,
      buttonStep: popupButtonStep
    };
  };

  const clampForMethod = (level, method, popupButtonStep) => {
    const bounds = getMethodBounds(method, popupButtonStep);
    const parsed = parseFloat(level);
    if (!Number.isFinite(parsed)) return DEFAULT_LEVEL;
    return normalizeLevel(Math.max(bounds.min, Math.min(bounds.max, parsed)));
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

  const perSiteZoom = data.perSiteZoom ?? {};
  const defaultLevel = data.defaultLevel ?? DEFAULT_LEVEL;
  const siteConfig = perSiteZoom[domain];
  let currentMethod = siteConfig?.method ?? data.defaultMethod ?? DEFAULT_METHOD;

  const parsedButtonStep = parseFloat(data.defaultPopupButtonStep);
  const popupButtonStep = Number.isFinite(parsedButtonStep)
    ? Math.max(POPUP_BUTTON_STEP_MIN, Math.min(POPUP_BUTTON_STEP_MAX, parsedButtonStep))
    : DEFAULT_POPUP_BUTTON_STEP;

  let currentLevel = clampForMethod(siteConfig?.level ?? defaultLevel, currentMethod, popupButtonStep);

  const applySliderBounds = (method) => {
    const bounds = getMethodBounds(method, popupButtonStep);
    zoomSlider.min = String(bounds.min);
    zoomSlider.max = String(bounds.max);
    zoomSlider.step = String(bounds.sliderStep);
  };

  applySliderBounds(currentMethod);
  zoomSlider.value = currentLevel;
  zoomLevel.textContent = currentLevel.toFixed(2) + 'x';
  zoomMethod.value = currentMethod;

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

  const applyNativeZoom = async (level) => {
    const response = await chrome.runtime.sendMessage({
      action: 'applyNativeZoom',
      tabId: tab.id,
      level
    });

    if (!response?.success) {
      throw new Error(response?.error || 'Native zoom failed');
    }

    return normalizeLevel(response.level);
  };

  const applyContentZoom = async (level, method) => {
    await chrome.tabs.setZoom(tab.id, 1.0);
    await ensureContentScriptAndSend({
      action: 'setZoom',
      level,
      method
    });

    return level;
  };

  const updateZoom = async (level, method) => {
    const clampedLevel = clampForMethod(level, method, popupButtonStep);
    currentMethod = method;
    currentLevel = clampedLevel;

    applySliderBounds(method);
    zoomSlider.value = currentLevel;
    zoomLevel.textContent = currentLevel.toFixed(2) + 'x';
    zoomMethod.value = currentMethod;

    let appliedLevel = clampedLevel;

    try {
      if (isNativeZoomMethod(method)) {
        appliedLevel = await applyNativeZoom(clampedLevel);
      } else {
        appliedLevel = await applyContentZoom(clampedLevel, method);
      }
    } catch (error) {
      console.error('Text Zoom: Failed to apply zoom', error);
      showError('Zoom could not be applied on this page.');
      return;
    }

    currentLevel = appliedLevel;
    zoomSlider.value = currentLevel;
    zoomLevel.textContent = currentLevel.toFixed(2) + 'x';

    const newPerSiteZoom = {
      ...perSiteZoom,
      [domain]: { level: appliedLevel, method }
    };

    try {
      await chrome.storage.local.set({ perSiteZoom: newPerSiteZoom });
      perSiteZoom[domain] = { level: appliedLevel, method };
    } catch (error) {
      console.error('Text Zoom: Failed to save zoom', error);
      showError('Failed to save zoom');
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
    const bounds = getMethodBounds(currentMethod, popupButtonStep);
    const newLevel = normalizeLevel(Math.min(bounds.max, currentLevel + bounds.buttonStep));
    updateZoom(newLevel, currentMethod);
  });

  zoomOut.addEventListener('click', () => {
    const bounds = getMethodBounds(currentMethod, popupButtonStep);
    const newLevel = normalizeLevel(Math.max(bounds.min, currentLevel - bounds.buttonStep));
    updateZoom(newLevel, currentMethod);
  });

  resetBtn.addEventListener('click', () => {
    const resetLevel = isNativeZoomMethod(currentMethod)
      ? clampForMethod(defaultLevel, 'browser-zoom', popupButtonStep)
      : clampForMethod(defaultLevel, currentMethod, popupButtonStep);
    updateZoom(resetLevel, currentMethod);
  });

  zoomMethod.addEventListener('change', (e) => {
    const method = e.target.value;
    const nextLevel = clampForMethod(currentLevel, method, popupButtonStep);
    updateZoom(nextLevel, method);
  });

  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
