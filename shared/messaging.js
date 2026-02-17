(function(root) {
  const ensureContentScriptAndSend = async (tabId, message) => {
    try {
      await chrome.tabs.sendMessage(tabId, message);
      return true;
    } catch (error) {
      const messageText = error?.message || String(error);
      if (!messageText.includes('Receiving end does not exist')) {
        throw error;
      }
    }

    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['shared/constants.js', 'shared/utils.js', 'content/zoom-methods.js', 'content/content.js']
    });

    await chrome.tabs.sendMessage(tabId, message);
    return true;
  };

  const api = { ensureContentScriptAndSend };
  root.TextZoomMessaging = api;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
