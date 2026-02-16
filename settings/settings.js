document.addEventListener('DOMContentLoaded', async () => {
  const defaultMethodRadios = document.querySelectorAll('input[name="defaultMethod"]');
  const defaultLevel = document.getElementById('defaultLevel');
  const defaultLevelDisplay = document.getElementById('defaultLevelDisplay');
  const siteList = document.getElementById('siteList');
  const clearAllSites = document.getElementById('clearAllSites');
  const excludedSites = document.getElementById('excludedSites');
  const saveExcluded = document.getElementById('saveExcluded');
  const resetAll = document.getElementById('resetAll');
  const toast = document.getElementById('toast');

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
      'perSiteZoom',
      'excludedSites'
    ]);
    
    const method = data.defaultMethod ?? DEFAULT_METHOD;
    const radio = document.querySelector(`input[value="${method}"]`);
    if (radio) radio.checked = true;

    const level = data.defaultLevel ?? DEFAULT_LEVEL;
    defaultLevel.value = level;
    defaultLevelDisplay.textContent = level.toFixed(2) + 'x';

    renderSiteList(data.perSiteZoom ?? {});

    const excluded = data.excludedSites ?? [];
    excludedSites.value = excluded.join('\n');
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
      'css-zoom': 'CSS Zoom',
      'font-size': 'Font Size',
      'transform': 'Transform'
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
  
  resetAll.addEventListener('click', async () => {
    if (confirm('Are you sure you want to reset all settings to defaults?')) {
      await chrome.storage.local.set({
        defaultMethod: DEFAULT_METHOD,
        defaultLevel: DEFAULT_LEVEL,
        perSiteZoom: {},
        excludedSites: ['youtube.com', 'docs.google.com', 'drive.google.com']
      });
      loadSettings();
    }
  });
  
  loadSettings();
});