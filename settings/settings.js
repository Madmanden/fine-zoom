document.addEventListener('DOMContentLoaded', async () => {
  const defaultMethodRadios = document.querySelectorAll('input[name="defaultMethod"]');
  const defaultLevel = document.getElementById('defaultLevel');
  const defaultLevelDisplay = document.getElementById('defaultLevelDisplay');
  const defaultPopupButtonStep = document.getElementById('defaultPopupButtonStep');
  const siteList = document.getElementById('siteList');
  const clearAllSites = document.getElementById('clearAllSites');
  const excludedSites = document.getElementById('excludedSites');
  const saveExcluded = document.getElementById('saveExcluded');
  const debugHighlightScaledText = document.getElementById('debugHighlightScaledText');
  const enableCtrlWheelHijack = document.getElementById('enableCtrlWheelHijack');
  const enableCtrlKeyHijack = document.getElementById('enableCtrlKeyHijack');
  const resetAll = document.getElementById('resetAll');
  const toast = document.getElementById('toast');
  const clampPopupButtonStep = (value) => {
    if (!Number.isFinite(value)) return DEFAULT_POPUP_BUTTON_STEP;
    const clamped = Math.max(POPUP_BUTTON_STEP_MIN, Math.min(POPUP_BUTTON_STEP_MAX, value));
    return Math.round(clamped * 100) / 100;
  };

  const escapeHtml = (str) => {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };

  const showToast = (message) => {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
      toast.classList.remove('show');
    }, 3000);
  };

  const loadSettings = async () => {
    const data = await chrome.storage.local.get([
      'defaultMethod',
      'defaultLevel',
      'defaultPopupButtonStep',
      'perSiteZoom',
      'excludedSites',
      'debugHighlightScaledText',
      'enableCtrlWheelHijack',
      'enableCtrlKeyHijack'
    ]);
    
    const method = data.defaultMethod ?? DEFAULT_METHOD;
    const radio = document.querySelector(`input[value="${method}"]`);
    if (radio) radio.checked = true;

    const level = data.defaultLevel ?? DEFAULT_LEVEL;
    defaultLevel.value = level;
    defaultLevelDisplay.textContent = level.toFixed(2) + 'x';

    const popupStep = clampPopupButtonStep(parseFloat(data.defaultPopupButtonStep));
    defaultPopupButtonStep.value = popupStep.toFixed(2);

    renderSiteList(data.perSiteZoom ?? {});

    const excluded = data.excludedSites ?? [];
    excludedSites.value = excluded.join('\n');

    debugHighlightScaledText.checked = data.debugHighlightScaledText ?? DEFAULT_DEBUG_HIGHLIGHT;
    enableCtrlWheelHijack.checked = data.enableCtrlWheelHijack ?? true;
    enableCtrlKeyHijack.checked = data.enableCtrlKeyHijack ?? true;
  };
  
  const renderSiteList = (perSiteZoom) => {
    const sites = Object.entries(perSiteZoom);
    
    if (sites.length === 0) {
      siteList.innerHTML = '<p class="empty-state">No custom zoom levels set yet</p>';
      return;
    }
    
    siteList.innerHTML = sites.map(([domain, config]) => `
      <div class="site-item" data-domain="${escapeHtml(domain)}">
        <div class="site-info">
          <span class="site-domain">${escapeHtml(domain)}</span>
          <span class="site-details">${config.level.toFixed(2)}x · ${escapeHtml(getMethodLabel(config.method))}</span>
        </div>
        <button class="remove-site" title="Remove">×</button>
      </div>
    `).join('');
    
    document.querySelectorAll('.remove-site').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const domain = e.target.closest('.site-item').dataset.domain;
        const data = await chrome.storage.local.get('perSiteZoom');
        const perSiteZoom = data.perSiteZoom ?? {};
        delete perSiteZoom[domain];
        await chrome.storage.local.set({ perSiteZoom });
        renderSiteList(perSiteZoom);
      });
    });
  };
  
  const getMethodLabel = (method) => {
    const labels = {
      'browser-zoom': 'Browser Zoom (Native)',
      'css-zoom': 'CSS Zoom (Page Scale)',
      'font-size': 'Font Size (Text Only)'
    };
    return labels[method] || method;
  };
  
  defaultMethodRadios.forEach(radio => {
    radio.addEventListener('change', async () => {
      await chrome.storage.local.set({ defaultMethod: radio.value });
    });
  });
  
  defaultLevel.addEventListener('input', (e) => {
    defaultLevelDisplay.textContent = parseFloat(e.target.value).toFixed(2) + 'x';
  });
  
  defaultLevel.addEventListener('change', async (e) => {
    const level = parseFloat(e.target.value);
    await chrome.storage.local.set({ defaultLevel: level });
  });

  defaultPopupButtonStep.addEventListener('change', async (e) => {
    const value = clampPopupButtonStep(parseFloat(e.target.value));
    defaultPopupButtonStep.value = value.toFixed(2);
    await chrome.storage.local.set({ defaultPopupButtonStep: value });
    showToast('Popup button step saved');
  });
  
  clearAllSites.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all site-specific zoom settings?')) {
      await chrome.storage.local.set({ perSiteZoom: {} });
      renderSiteList({});
    }
  });
  
  saveExcluded.addEventListener('click', async () => {
    const sites = excludedSites.value
      .split('\n')
      .map(s => s.trim())
      .filter(s => s);
    await chrome.storage.local.set({ excludedSites: sites });
    showToast('Excluded sites saved!');
  });

  debugHighlightScaledText.addEventListener('change', async (e) => {
    await chrome.storage.local.set({ debugHighlightScaledText: e.target.checked });
    showToast('Debug highlight updated');
  });

  enableCtrlWheelHijack.addEventListener('change', async (e) => {
    await chrome.storage.local.set({ enableCtrlWheelHijack: e.target.checked });
    showToast('Ctrl+Wheel hijack updated');
  });

  enableCtrlKeyHijack.addEventListener('change', async (e) => {
    await chrome.storage.local.set({ enableCtrlKeyHijack: e.target.checked });
    showToast('Ctrl key hijack updated');
  });
  
  resetAll.addEventListener('click', async () => {
    if (confirm('Are you sure you want to reset all settings to defaults?')) {
      await chrome.storage.local.set({
        defaultMethod: DEFAULT_METHOD,
        defaultLevel: DEFAULT_LEVEL,
        defaultPopupButtonStep: DEFAULT_POPUP_BUTTON_STEP,
        perSiteZoom: {},
        excludedSites: ['youtube.com', 'docs.google.com', 'drive.google.com'],
        debugHighlightScaledText: DEFAULT_DEBUG_HIGHLIGHT,
        enableCtrlWheelHijack: true,
        enableCtrlKeyHijack: true
      });
      loadSettings();
    }
  });
  
  loadSettings();
});
