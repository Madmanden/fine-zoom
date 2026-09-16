document.addEventListener('DOMContentLoaded', async () => {
  const zoomSlider = document.getElementById('zoomSlider');
  const zoomLevel = document.getElementById('zoomLevel');
  const zoomIn = document.getElementById('zoomIn');
  const zoomOut = document.getElementById('zoomOut');
  const fineZoomIn = document.getElementById('fineZoomIn');
  const fineZoomOut = document.getElementById('fineZoomOut');
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

  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  const setControlsEnabled = (enabled) => {
    zoomSlider.disabled = !enabled;
    zoomIn.disabled = !enabled;
    zoomOut.disabled = !enabled;
    fineZoomIn.disabled = !enabled;
    fineZoomOut.disabled = !enabled;
    resetBtn.disabled = !enabled;
    zoomMethod.disabled = !enabled;
  };

  const isNativeZoomMethod = (method) => method === 'browser-zoom';
  const normalizeMethod = (method) => TextZoomUtils.normalizeMethod(method, DEFAULT_METHOD);
  const clampStep = (value, fallback = DEFAULT_ZOOM_STEP) => {
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(STEP_MIN, Math.min(STEP_MAX, parsed));
  };

  const normalizeLevel = (value) => Math.round(value * 100) / 100;

  const getMethodBounds = (method) => {
    if (isNativeZoomMethod(method)) {
      return {
        min: BROWSER_ZOOM_MIN,
        max: BROWSER_ZOOM_MAX
      };
    }

    return {
      min: ZOOM_MIN,
      max: ZOOM_MAX
    };
  };

  const clampForMethod = (level, method) => {
    const bounds = getMethodBounds(method);
    const parsed = parseFloat(level);
    if (!Number.isFinite(parsed)) return DEFAULT_LEVEL;
    return normalizeLevel(Math.max(bounds.min, Math.min(bounds.max, parsed)));
  };

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];

  if (!tab?.url) {
    setControlsEnabled(false);
    return;
  }

  let url;
  try {
    url = new URL(tab.url);
  } catch {
    setControlsEnabled(false);
    return;
  }

  if (!/^https?:$/.test(url.protocol)) {
    setControlsEnabled(false);
    return;
  }

  setControlsEnabled(true);

  const domain = url.hostname;

  let data;
  try {
    data = await chrome.storage.local.get([
      'perSiteZoom',
      'defaultLevel',
      'defaultMethod',
      'defaultZoomStep',
      'defaultFineZoomStep'
    ]);
  } catch (error) {
    console.error('Fine Zoom: Failed to load settings', error);
    showError('Failed to load settings');
    return;
  }

  let perSiteZoom = data.perSiteZoom ?? {};
  const defaultLevel = data.defaultLevel ?? DEFAULT_LEVEL;
  const defaultMethod = normalizeMethod(data.defaultMethod ?? DEFAULT_METHOD);
  const siteConfig = perSiteZoom[domain];
  let currentMethod = normalizeMethod(siteConfig?.method ?? defaultMethod);

  const zoomStep = clampStep(data.defaultZoomStep, DEFAULT_ZOOM_STEP);
  const fineZoomStep = clampStep(data.defaultFineZoomStep, DEFAULT_FINE_ZOOM_STEP);
  let currentLevel = clampForMethod(siteConfig?.level ?? defaultLevel, currentMethod);

  const applySliderBounds = (method) => {
    const bounds = getMethodBounds(method);
    zoomSlider.min = String(bounds.min);
    zoomSlider.max = String(bounds.max);
    zoomSlider.step = String(zoomStep);
  };

  fineZoomOut.textContent = `-${fineZoomStep.toFixed(2)}`;
  fineZoomIn.textContent = `+${fineZoomStep.toFixed(2)}`;
  fineZoomOut.setAttribute('aria-label', `Fine zoom out (${fineZoomStep.toFixed(2)})`);
  fineZoomIn.setAttribute('aria-label', `Fine zoom in (${fineZoomStep.toFixed(2)})`);

  applySliderBounds(currentMethod);
  const syncLevelDisplay = () => {
    zoomSlider.value = currentLevel;
    zoomLevel.textContent = currentLevel.toFixed(2) + 'x';
    zoomMethod.value = currentMethod;
  };
  syncLevelDisplay();

  let latestApplyToken = 0;
  let latestPersistToken = 0;

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

  const getNativeZoom = async () => {
    const response = await chrome.runtime.sendMessage({
      action: 'getNativeZoom',
      tabId: tab.id
    });
    if (!response?.success) {
      throw new Error(response?.error || 'Native zoom read failed');
    }
    return normalizeLevel(response.level);
  };

  const applyContentZoom = async (level, method) => {
    const response = await chrome.runtime.sendMessage({
      action: 'applyContentZoom',
      tabId: tab.id,
      level,
      method
    });
    if (!response?.success) {
      throw new Error(response?.error || 'Content zoom failed');
    }
    return response.level;
  };

  const applyZoomOnly = async (level, method) => {
    const normalizedMethod = normalizeMethod(method);
    const clampedLevel = clampForMethod(level, normalizedMethod);
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
      console.error('Fine Zoom: Failed to apply zoom', error);
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
    const clampedLevel = clampForMethod(level, normalizedMethod);
    const newPerSiteZoom = TextZoomUtils.buildUpdatedPerSiteZoom({
      perSiteZoom,
      domain,
      level: clampedLevel,
      method: normalizedMethod,
      defaultLevel,
      defaultMethod
    });

    if (!newPerSiteZoom) return true;

    try {
      await chrome.storage.local.set({ perSiteZoom: newPerSiteZoom });
      perSiteZoom = newPerSiteZoom;
    } catch (error) {
      console.error('Fine Zoom: Failed to save zoom', error);
      showError('Failed to save zoom');
      return false;
    }

    return true;
  };

  const applyAndPersist = async (level, method) => {
    const persistToken = ++latestPersistToken;
    const applyResult = await applyZoomOnly(level, method);
    if (!applyResult.success) return;
    if (persistToken !== latestPersistToken) return;
    await persistZoom(applyResult.level, applyResult.method);
  };

  if (isNativeZoomMethod(currentMethod)) {
    try {
      const nativeLevel = clampForMethod(await getNativeZoom(), currentMethod);
      if (nativeLevel !== currentLevel) {
        currentLevel = nativeLevel;
        syncLevelDisplay();
      }
    } catch (error) {
      console.error('Fine Zoom: Failed to read native zoom', error);
    }
  }

  zoomSlider.addEventListener('input', (e) => {
    const level = parseFloat(e.target.value);
    void applyZoomOnly(level, currentMethod);
  });

  zoomSlider.addEventListener('change', (e) => {
    const level = parseFloat(e.target.value);
    const persistToken = ++latestPersistToken;
    void (async () => {
      const applyResult = await applyZoomOnly(level, currentMethod);
      if (!applyResult.success) return;
      if (persistToken !== latestPersistToken) return;
      await persistZoom(applyResult.level, applyResult.method);
    })();
  });

  zoomIn.addEventListener('click', () => {
    const bounds = getMethodBounds(currentMethod);
    const newLevel = normalizeLevel(Math.min(bounds.max, currentLevel + zoomStep));
    void applyAndPersist(newLevel, currentMethod);
  });

  zoomOut.addEventListener('click', () => {
    const bounds = getMethodBounds(currentMethod);
    const newLevel = normalizeLevel(Math.max(bounds.min, currentLevel - zoomStep));
    void applyAndPersist(newLevel, currentMethod);
  });

  fineZoomIn.addEventListener('click', () => {
    const bounds = getMethodBounds(currentMethod);
    const newLevel = normalizeLevel(Math.min(bounds.max, currentLevel + fineZoomStep));
    void applyAndPersist(newLevel, currentMethod);
  });

  fineZoomOut.addEventListener('click', () => {
    const bounds = getMethodBounds(currentMethod);
    const newLevel = normalizeLevel(Math.max(bounds.min, currentLevel - fineZoomStep));
    void applyAndPersist(newLevel, currentMethod);
  });

  resetBtn.addEventListener('click', () => {
    const resetLevel = clampForMethod(defaultLevel, defaultMethod);
    void applyAndPersist(resetLevel, defaultMethod);
  });

  zoomMethod.addEventListener('change', (e) => {
    const method = normalizeMethod(e.target.value);
    const nextLevel = clampForMethod(currentLevel, method);
    void applyAndPersist(nextLevel, method);
  });

});
