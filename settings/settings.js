document.addEventListener('DOMContentLoaded', async () => {
  const defaultMethodRadios = document.querySelectorAll('input[name="defaultMethod"]');
  const defaultLevel = document.getElementById('defaultLevel');
  const defaultLevelDisplay = document.getElementById('defaultLevelDisplay');
  const defaultZoomStep = document.getElementById('defaultZoomStep');
  const defaultFineZoomStep = document.getElementById('defaultFineZoomStep');
  const siteList = document.getElementById('siteList');
  const clearAllSites = document.getElementById('clearAllSites');
  const excludedSites = document.getElementById('excludedSites');
  const saveExcluded = document.getElementById('saveExcluded');
  const enableCtrlWheelHijack = document.getElementById('enableCtrlWheelHijack');
  const enableCtrlKeyHijack = document.getElementById('enableCtrlKeyHijack');
  const resetAll = document.getElementById('resetAll');
  const toast = document.getElementById('toast');

  const clampStep = (value, fallback = DEFAULT_ZOOM_STEP) => {
    if (!Number.isFinite(value)) return fallback;
    const clamped = Math.max(STEP_MIN, Math.min(STEP_MAX, value));
    return Math.round(clamped * 100) / 100;
  };

  const clampLevel = (value) => {
    if (!Number.isFinite(value)) return DEFAULT_LEVEL;
    const clamped = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, value));
    return Math.round(clamped * 100) / 100;
  };

  const escapeHtml = (str) => {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  };

  const isValidExcludedSite = (value) => {
    if (!value || value.includes('/')) return false;
    if (value.startsWith('chrome:') || value.startsWith('chrome-extension:')) return false;
    return /^[a-z0-9.-]+$/i.test(value);
  };

  const parseExcludedSites = (rawValue) => {
    const lines = rawValue
      .split('\n')
      .map((site) => site.trim().toLowerCase())
      .filter(Boolean);

    const seen = new Set();
    const valid = [];
    const invalid = [];

    lines.forEach((site) => {
      if (!isValidExcludedSite(site)) {
        invalid.push(site);
        return;
      }
      if (seen.has(site)) return;
      seen.add(site);
      valid.push(site);
    });

    return { valid, invalid };
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
      'defaultZoomStep',
      'defaultFineZoomStep',
      'defaultPopupButtonStep',
      'perSiteZoom',
      'excludedSites',
      'enableCtrlWheelHijack',
      'enableCtrlKeyHijack'
    ]);

    const method = data.defaultMethod ?? DEFAULT_METHOD;
    const radio = document.querySelector(`input[value="${method}"]`);
    if (radio) radio.checked = true;

    const level = clampLevel(Number.parseFloat(data.defaultLevel));
    defaultLevel.value = level;
    defaultLevelDisplay.textContent = level.toFixed(2) + 'x';

    const mainStep = clampStep(
      Number.parseFloat(data.defaultZoomStep),
      clampStep(Number.parseFloat(data.defaultPopupButtonStep), DEFAULT_ZOOM_STEP)
    );
    const fineStep = clampStep(Number.parseFloat(data.defaultFineZoomStep), DEFAULT_FINE_ZOOM_STEP);

    defaultZoomStep.value = mainStep.toFixed(2);
    defaultFineZoomStep.value = fineStep.toFixed(2);

    renderSiteList(data.perSiteZoom ?? {});

    const excluded = data.excludedSites ?? [];
    excludedSites.value = excluded.join('\n');

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

    document.querySelectorAll('.remove-site').forEach((btn) => {
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

  defaultMethodRadios.forEach((radio) => {
    radio.addEventListener('change', async () => {
      await chrome.storage.local.set({ defaultMethod: radio.value });
    });
  });

  defaultLevel.addEventListener('input', (e) => {
    defaultLevelDisplay.textContent = clampLevel(parseFloat(e.target.value)).toFixed(2) + 'x';
  });

  defaultLevel.addEventListener('change', async (e) => {
    const level = clampLevel(parseFloat(e.target.value));
    defaultLevel.value = level;
    defaultLevelDisplay.textContent = level.toFixed(2) + 'x';
    await chrome.storage.local.set({ defaultLevel: level });
  });

  defaultZoomStep.addEventListener('change', async (e) => {
    const value = clampStep(parseFloat(e.target.value), DEFAULT_ZOOM_STEP);
    defaultZoomStep.value = value.toFixed(2);
    await chrome.storage.local.set({
      defaultZoomStep: value,
      defaultPopupButtonStep: value
    });
    showToast('Main zoom step saved');
  });

  defaultFineZoomStep.addEventListener('change', async (e) => {
    const value = clampStep(parseFloat(e.target.value), DEFAULT_FINE_ZOOM_STEP);
    defaultFineZoomStep.value = value.toFixed(2);
    await chrome.storage.local.set({ defaultFineZoomStep: value });
    showToast('Fine zoom step saved');
  });

  clearAllSites.addEventListener('click', async () => {
    if (confirm('Are you sure you want to clear all site-specific zoom settings?')) {
      await chrome.storage.local.set({ perSiteZoom: {} });
      renderSiteList({});
    }
  });

  saveExcluded.addEventListener('click', async () => {
    const { valid, invalid } = parseExcludedSites(excludedSites.value);
    excludedSites.value = valid.join('\n');
    await chrome.storage.local.set({ excludedSites: valid });
    if (invalid.length > 0) {
      showToast(`Saved with ${invalid.length} invalid entr${invalid.length === 1 ? 'y' : 'ies'} skipped`);
      return;
    }
    showToast('Excluded sites saved!');
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
        defaultZoomStep: DEFAULT_ZOOM_STEP,
        defaultFineZoomStep: DEFAULT_FINE_ZOOM_STEP,
        defaultPopupButtonStep: DEFAULT_ZOOM_STEP,
        perSiteZoom: {},
        excludedSites: [],
        enableCtrlWheelHijack: true,
        enableCtrlKeyHijack: true
      });
      await loadSettings();
    }
  });

  await loadSettings();
});
