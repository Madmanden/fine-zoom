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
  const normalizeMethod = (method) => TextZoomUtils.normalizeMethod(method, DEFAULT_METHOD);

  const normalizeLevel = (value) => Math.round(value * 100) / 100;

  const getMethodBounds = (method, popupButtonStep) => {
    if (isNativeZoomMethod(method)) {
      return {
        min: BROWSER_ZOOM_MIN,
        max: BROWSER_ZOOM_MAX,
        sliderStep: ZOOM_STEP,
        buttonStep: popupButtonStep
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

  let perSiteZoom = data.perSiteZoom ?? {};
  const defaultLevel = data.defaultLevel ?? DEFAULT_LEVEL;
  const siteConfig = perSiteZoom[domain];
  let currentMethod = normalizeMethod(siteConfig?.method ?? data.defaultMethod ?? DEFAULT_METHOD);

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
      files: ['shared/constants.js', 'shared/utils.js', 'content/zoom-methods.js', 'content/content.js']
    });

    await chrome.tabs.sendMessage(tab.id, message);
    return true;
  };

  let latestApplyToken = 0;

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

  const applyZoomOnly = async (level, method) => {
    const normalizedMethod = normalizeMethod(method);
    const clampedLevel = clampForMethod(level, normalizedMethod, popupButtonStep);
    const applyToken = ++latestApplyToken;

    currentMethod = normalizedMethod;
    currentLevel = clampedLevel;

    applySliderBounds(currentMethod);
    zoomSlider.value = currentLevel;
    zoomLevel.textContent = currentLevel.toFixed(2) + 'x';
    zoomMethod.value = currentMethod;

    let appliedLevel = clampedLevel;

    try {
      if (isNativeZoomMethod(normalizedMethod)) {
        appliedLevel = await applyNativeZoom(clampedLevel);
      } else {
        appliedLevel = await applyContentZoom(clampedLevel, normalizedMethod);
      }
    } catch (error) {
      console.error('Text Zoom: Failed to apply zoom', error);
      showError('Zoom could not be applied on this page.');
      return { success: false };
    }

    if (applyToken !== latestApplyToken) {
      return { success: false, stale: true };
    }

    currentLevel = appliedLevel;
    zoomSlider.value = currentLevel;
    zoomLevel.textContent = currentLevel.toFixed(2) + 'x';

    return { success: true, level: appliedLevel, method: currentMethod };
  };

  const persistZoom = async (level, method) => {
    const normalizedMethod = normalizeMethod(method);
    const clampedLevel = clampForMethod(level, normalizedMethod, popupButtonStep);

    const newPerSiteZoom = {
      ...perSiteZoom,
      [domain]: { level: clampedLevel, method: normalizedMethod }
    };

    try {
      await chrome.storage.local.set({ perSiteZoom: newPerSiteZoom });
      perSiteZoom = newPerSiteZoom;
    } catch (error) {
      console.error('Text Zoom: Failed to save zoom', error);
      showError('Failed to save zoom');
      return false;
    }

    return true;
  };

  const applyAndPersist = async (level, method) => {
    const applyResult = await applyZoomOnly(level, method);
    if (!applyResult.success) return;
    await persistZoom(applyResult.level, applyResult.method);
  };

  zoomSlider.addEventListener('input', async (e) => {
    const level = parseFloat(e.target.value);
    await applyZoomOnly(level, currentMethod);
  });

  zoomSlider.addEventListener('change', async (e) => {
    const level = parseFloat(e.target.value);
    const applyResult = await applyZoomOnly(level, currentMethod);
    if (!applyResult.success) return;
    await persistZoom(applyResult.level, applyResult.method);
  });

  zoomIn.addEventListener('click', () => {
    const bounds = getMethodBounds(currentMethod, popupButtonStep);
    const newLevel = normalizeLevel(Math.min(bounds.max, currentLevel + bounds.buttonStep));
    applyAndPersist(newLevel, currentMethod);
  });

  zoomOut.addEventListener('click', () => {
    const bounds = getMethodBounds(currentMethod, popupButtonStep);
    const newLevel = normalizeLevel(Math.max(bounds.min, currentLevel - bounds.buttonStep));
    applyAndPersist(newLevel, currentMethod);
  });

  resetBtn.addEventListener('click', () => {
    const resetLevel = isNativeZoomMethod(currentMethod)
      ? clampForMethod(defaultLevel, 'browser-zoom', popupButtonStep)
      : clampForMethod(defaultLevel, currentMethod, popupButtonStep);
    applyAndPersist(resetLevel, currentMethod);
  });

  zoomMethod.addEventListener('change', (e) => {
    const method = normalizeMethod(e.target.value);
    const nextLevel = clampForMethod(currentLevel, method, popupButtonStep);
    applyAndPersist(nextLevel, method);
  });

  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});
