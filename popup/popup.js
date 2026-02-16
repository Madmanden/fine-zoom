document.addEventListener('DOMContentLoaded', async () => {
  const zoomSlider = document.getElementById('zoomSlider');
  const zoomLevel = document.getElementById('zoomLevel');
  const zoomIn = document.getElementById('zoomIn');
  const zoomOut = document.getElementById('zoomOut');
  const resetBtn = document.getElementById('resetBtn');
  const settingsBtn = document.getElementById('settingsBtn');
  const zoomMethod = document.getElementById('zoomMethod');
  
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = new URL(tab.url);
  const domain = url.hostname;
  
  const data = await chrome.storage.local.get([
    'perSiteZoom', 
    'defaultLevel', 
    'defaultMethod'
  ]);
  
  const siteConfig = data.perSiteZoom?.[domain];
  let currentLevel = siteConfig?.level || data.defaultLevel || 1.0;
  let currentMethod = siteConfig?.method || data.defaultMethod || 'css-zoom';
  
  zoomSlider.value = currentLevel;
  zoomLevel.textContent = currentLevel.toFixed(2) + 'x';
  zoomMethod.value = currentMethod;
  
  const updateZoom = async (level, method) => {
    currentLevel = level;
    currentMethod = method;
    
    zoomSlider.value = level;
    zoomLevel.textContent = level.toFixed(2) + 'x';
    
    const newPerSiteZoom = {
      ...data.perSiteZoom,
      [domain]: { level, method }
    };
    
    await chrome.storage.local.set({ perSiteZoom: newPerSiteZoom });
    
    await chrome.tabs.sendMessage(tab.id, {
      action: 'setZoom',
      level: level,
      method: method
    });
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
    const newLevel = Math.min(3.0, currentLevel + 0.05);
    updateZoom(newLevel, currentMethod);
  });
  
  zoomOut.addEventListener('click', () => {
    const newLevel = Math.max(0.5, currentLevel - 0.05);
    updateZoom(newLevel, currentMethod);
  });
  
  resetBtn.addEventListener('click', () => {
    updateZoom(1.0, currentMethod);
  });
  
  zoomMethod.addEventListener('change', (e) => {
    const method = e.target.value;
    updateZoom(currentLevel, method);
  });
  
  settingsBtn.addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
});