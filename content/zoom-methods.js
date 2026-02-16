window.ZoomMethods = (function() {
  const validateZoomLevel = (level) => {
    const num = parseFloat(level);
    if (!isFinite(num) || isNaN(num)) return 1.0;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, num));
  };

  const FONT_SIZE_STYLE_ID = 'text-zoom-font-style';
  const FONT_SIZE_ORIGINAL_VALUE_ATTR = 'data-text-zoom-font-original-value';
  const FONT_SIZE_ORIGINAL_PRIORITY_ATTR = 'data-text-zoom-font-original-priority';
  const FONT_SIZE_HAD_ORIGINAL_ATTR = 'data-text-zoom-font-had-original';
  const FONT_SIZE_SCALED_ATTR = 'data-text-zoom-font-scaled';

  const EXCLUDED_FONT_SIZE_TAGS = new Set([
    'AREA', 'AUDIO', 'BUTTON', 'CANVAS', 'CODE', 'DATALIST', 'EMBED',
    'IFRAME', 'IMG', 'INPUT', 'KBD', 'MATH', 'NOSCRIPT', 'OBJECT', 'OPTION',
    'PRE', 'SAMP', 'SCRIPT', 'SELECT', 'STYLE', 'SVG', 'TEXTAREA', 'VIDEO'
  ]);

  const modifiedFontElements = new Set();
  let fontSizeObserver = null;
  let fontSizeQueue = new Set();
  let fontSizeFrame = null;
  let activeFontScale = 1.0;

  const hasReadableDirectText = (element) => {
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent && node.textContent.trim().length > 0) {
        return true;
      }
    }
    return false;
  };

  const shouldScaleFontForElement = (element) => {
    if (!(element instanceof Element)) return false;
    const tagName = element.tagName;
    if (EXCLUDED_FONT_SIZE_TAGS.has(tagName)) return false;
    if (element.isContentEditable || element.getAttribute('contenteditable') === 'true') return false;
    if (element.getAttribute('aria-hidden') === 'true') return false;
    if (!hasReadableDirectText(element)) return false;

    if (element.childElementCount > 0) {
      return false;
    }

    const computed = window.getComputedStyle(element);
    if (computed.display === 'none' || computed.visibility === 'hidden') return false;
    const computedSize = parseFloat(computed.fontSize);
    if (!isFinite(computedSize) || computedSize <= 0) return false;

    return true;
  };

  const storeOriginalInlineFontSize = (element) => {
    if (element.hasAttribute(FONT_SIZE_HAD_ORIGINAL_ATTR)) return;
    const originalValue = element.style.getPropertyValue('font-size');
    const originalPriority = element.style.getPropertyPriority('font-size');
    if (originalValue) {
      element.setAttribute(FONT_SIZE_HAD_ORIGINAL_ATTR, '1');
      element.setAttribute(FONT_SIZE_ORIGINAL_VALUE_ATTR, originalValue);
      element.setAttribute(FONT_SIZE_ORIGINAL_PRIORITY_ATTR, originalPriority || '');
    } else {
      element.setAttribute(FONT_SIZE_HAD_ORIGINAL_ATTR, '0');
    }
  };

  const scaleElementFontSize = (element, scale) => {
    const computedSize = parseFloat(window.getComputedStyle(element).fontSize);
    if (!isFinite(computedSize) || computedSize <= 0) return;
    storeOriginalInlineFontSize(element);
    element.style.setProperty('font-size', `${computedSize * scale}px`, 'important');
    element.setAttribute(FONT_SIZE_SCALED_ATTR, '1');
    modifiedFontElements.add(element);
  };

  const collectInitialFontTargets = (root) => {
    const targets = [];
    if (!root) return targets;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let node = walker.currentNode;
    while (node) {
      const element = node;
      if (shouldScaleFontForElement(element)) {
        targets.push(element);
      }
      node = walker.nextNode();
    }
    return targets;
  };

  const queueFontScalingForNode = (node) => {
    if (!node) return;
    if (node.nodeType === Node.ELEMENT_NODE) {
      fontSizeQueue.add(node);
    } else if (node.nodeType === Node.TEXT_NODE && node.parentElement) {
      fontSizeQueue.add(node.parentElement);
    }
  };

  const processQueuedFontTargets = () => {
    fontSizeFrame = null;
    if (activeFontScale === 1.0 || fontSizeQueue.size === 0) return;
    const pendingRoots = Array.from(fontSizeQueue);
    fontSizeQueue.clear();

    pendingRoots.forEach((root) => {
      if (!(root instanceof Element)) return;
      if (!root.hasAttribute(FONT_SIZE_SCALED_ATTR) && shouldScaleFontForElement(root)) {
        scaleElementFontSize(root, activeFontScale);
      }
      const nestedTargets = collectInitialFontTargets(root);
      nestedTargets.forEach((target) => {
        if (!target.hasAttribute(FONT_SIZE_SCALED_ATTR)) {
          scaleElementFontSize(target, activeFontScale);
        }
      });
    });
  };

  const scheduleFontQueueProcessing = () => {
    if (fontSizeFrame !== null) return;
    fontSizeFrame = window.requestAnimationFrame(processQueuedFontTargets);
  };

  const startFontSizeObserver = () => {
    if (fontSizeObserver) return;
    fontSizeObserver = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(queueFontScalingForNode);
        } else if (mutation.type === 'characterData') {
          queueFontScalingForNode(mutation.target);
        }
      });
      scheduleFontQueueProcessing();
    });

    const observeRoot = document.body || document.documentElement;
    if (observeRoot) {
      fontSizeObserver.observe(observeRoot, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }
  };

  const stopFontSizeObserver = () => {
    if (fontSizeObserver) {
      fontSizeObserver.disconnect();
      fontSizeObserver = null;
    }
    if (fontSizeFrame !== null) {
      window.cancelAnimationFrame(fontSizeFrame);
      fontSizeFrame = null;
    }
    fontSizeQueue.clear();
  };

  const removeFontSizeScaling = () => {
    stopFontSizeObserver();
    modifiedFontElements.forEach((element) => {
      if (!(element instanceof Element)) return;
      const hadOriginal = element.getAttribute(FONT_SIZE_HAD_ORIGINAL_ATTR) === '1';
      if (hadOriginal) {
        const originalValue = element.getAttribute(FONT_SIZE_ORIGINAL_VALUE_ATTR) || '';
        const originalPriority = element.getAttribute(FONT_SIZE_ORIGINAL_PRIORITY_ATTR) || '';
        element.style.setProperty('font-size', originalValue, originalPriority);
      } else {
        element.style.removeProperty('font-size');
      }
      element.removeAttribute(FONT_SIZE_ORIGINAL_VALUE_ATTR);
      element.removeAttribute(FONT_SIZE_ORIGINAL_PRIORITY_ATTR);
      element.removeAttribute(FONT_SIZE_HAD_ORIGINAL_ATTR);
      element.removeAttribute(FONT_SIZE_SCALED_ATTR);
    });
    modifiedFontElements.clear();
    activeFontScale = 1.0;
  };

  return {
    'css-zoom': {
      apply: (level) => {
        const validLevel = validateZoomLevel(level);
        let style = document.getElementById('text-zoom-style');
        if (!style) {
          style = document.createElement('style');
          style.id = 'text-zoom-style';
          document.documentElement.appendChild(style);
        }
        style.textContent = `
          html {
            zoom: ${validLevel} !important;
          }
        `;
      },
      remove: () => {
        const style = document.getElementById('text-zoom-style');
        if (style) style.remove();
      }
    },
    
    'font-size': {
      apply: (level) => {
        const validLevel = validateZoomLevel(level);
        removeFontSizeScaling();

        let style = document.getElementById(FONT_SIZE_STYLE_ID);
        if (!style) {
          style = document.createElement('style');
          style.id = FONT_SIZE_STYLE_ID;
          document.documentElement.appendChild(style);
        }
        style.textContent = `
          body {
            overflow-x: hidden !important;
          }

          p, span, a, li, td, th, label, h1, h2, h3, h4, h5, h6 {
            overflow-wrap: break-word !important;
          }

          pre, code {
            overflow-wrap: anywhere !important;
          }

          ${document.documentElement?.getAttribute('data-text-zoom-debug-highlight') === '1' ? `
          [${FONT_SIZE_SCALED_ATTR}="1"] {
            outline: 1px dashed #ff4d4f !important;
            outline-offset: 1px !important;
            background-image: linear-gradient(
              to bottom,
              rgba(255, 77, 79, 0.12),
              rgba(255, 77, 79, 0.12)
            ) !important;
          }
          ` : ''}
        `;

        if (validLevel === 1.0) {
          activeFontScale = 1.0;
          return;
        }

        activeFontScale = validLevel;
        const targets = collectInitialFontTargets(document.documentElement);
        targets.forEach((element) => scaleElementFontSize(element, activeFontScale));
        startFontSizeObserver();
      },
      remove: () => {
        removeFontSizeScaling();
        const style = document.getElementById(FONT_SIZE_STYLE_ID);
        if (style) style.remove();
      }
    },
    
    'transform': {
      apply: (level) => {
        const validLevel = validateZoomLevel(level);
        let style = document.getElementById('text-zoom-transform-style');
        if (!style) {
          style = document.createElement('style');
          style.id = 'text-zoom-transform-style';
          document.documentElement.appendChild(style);
        }
        style.textContent = `
          html {
            transform: scale(${validLevel}) !important;
            transform-origin: top left !important;
            width: ${100 / validLevel}% !important;
            height: ${100 / validLevel}% !important;
            overflow-x: hidden !important;
          }
          
          body {
            overflow-x: hidden !important;
          }
        `;
      },
      remove: () => {
        const style = document.getElementById('text-zoom-transform-style');
        if (style) style.remove();
      }
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = window.ZoomMethods;
}
