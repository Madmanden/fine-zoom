window.ZoomMethods = (function() {
  const validateZoomLevel = (level) => {
    const num = parseFloat(level);
    if (!isFinite(num) || isNaN(num)) return 1.0;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, num));
  };

  const FONT_SIZE_STYLE_ID = 'fine-zoom-font-style';
  const FONT_SIZE_SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'IFRAME',
    'SVG',
    'PATH',
    'META',
    'LINK',
    'HEAD',
    'HTML'
  ]);

  const fontSizeState = {
    scaledElements: new WeakMap(),
    activeElements: []
  };

  const hasDirectText = (element) => {
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
        return true;
      }
    }
    return false;
  };

  const getScalableTextElements = () => {
    const root = document.body || document.documentElement;
    if (!root) return [];

    const elements = [];
    if (!(root instanceof Element)) return elements;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, {
      acceptNode: (node) => {
        if (!(node instanceof Element)) return NodeFilter.FILTER_SKIP;
        if (FONT_SIZE_SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
        return hasDirectText(node) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
      }
    });

    let current = walker.currentNode;
    if (current instanceof Element && !FONT_SIZE_SKIP_TAGS.has(current.tagName) && hasDirectText(current)) {
      elements.push(current);
    }

    while (walker.nextNode()) {
      if (walker.currentNode instanceof Element) {
        elements.push(walker.currentNode);
      }
    }

    return elements;
  };

  const removeFontSizeInlineOverrides = () => {
    fontSizeState.activeElements.forEach((element) => {
      const entry = fontSizeState.scaledElements.get(element);
      if (!entry) return;
      if (!element.isConnected) return;
      if (entry.inlineFontSizeValue) {
        element.style.setProperty('font-size', entry.inlineFontSizeValue, entry.inlineFontSizePriority);
      } else {
        element.style.removeProperty('font-size');
      }
    });
    fontSizeState.activeElements = [];
  };

  return {
    'browser-zoom': {
      apply: () => {},
      remove: () => {}
    },

    'css-zoom': {
      apply: (level) => {
        const validLevel = validateZoomLevel(level);
        let style = document.getElementById('fine-zoom-style');
        if (!style) {
          style = document.createElement('style');
          style.id = 'fine-zoom-style';
          document.documentElement.appendChild(style);
        }
        style.textContent = `
          html {
            zoom: ${validLevel} !important;
          }
        `;
      },
      remove: () => {
        const style = document.getElementById('fine-zoom-style');
        if (style) style.remove();
      }
    },

    'font-size': {
      apply: (level) => {
        const validLevel = validateZoomLevel(level);

        removeFontSizeInlineOverrides();

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
        `;

        const textElements = getScalableTextElements();
        const activeElements = [];
        textElements.forEach((element) => {
          const currentFontSize = parseFloat(getComputedStyle(element).fontSize);
          if (!isFinite(currentFontSize) || currentFontSize <= 0) return;

          fontSizeState.scaledElements.set(element, {
            baseFontSize: currentFontSize,
            inlineFontSizeValue: element.style.getPropertyValue('font-size'),
            inlineFontSizePriority: element.style.getPropertyPriority('font-size')
          });
          activeElements.push(element);
        });

        fontSizeState.activeElements = activeElements;
        fontSizeState.activeElements.forEach((element) => {
          const entry = fontSizeState.scaledElements.get(element);
          if (!entry) return;
          if (!element.isConnected) return;
          element.style.setProperty('font-size', `${entry.baseFontSize * validLevel}px`, 'important');
        });
      },
      remove: () => {
        removeFontSizeInlineOverrides();
        const style = document.getElementById(FONT_SIZE_STYLE_ID);
        if (style) style.remove();
      }
    }
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = window.ZoomMethods;
}
