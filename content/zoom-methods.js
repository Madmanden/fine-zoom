window.ZoomMethods = (function() {
  const validateZoomLevel = (level) => {
    const num = parseFloat(level);
    if (!isFinite(num) || isNaN(num)) return 1.0;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, num));
  };

  const FONT_SIZE_STYLE_ID = 'text-zoom-font-style';
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
    scaledElements: new Map()
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
    if (root instanceof Element && !FONT_SIZE_SKIP_TAGS.has(root.tagName) && hasDirectText(root)) {
      elements.push(root);
    }

    root.querySelectorAll('*').forEach((element) => {
      if (FONT_SIZE_SKIP_TAGS.has(element.tagName)) return;
      if (hasDirectText(element)) {
        elements.push(element);
      }
    });

    return elements;
  };

  const removeFontSizeInlineOverrides = () => {
    fontSizeState.scaledElements.forEach((entry, element) => {
      if (!element.isConnected) return;
      if (entry.inlineFontSizeValue) {
        element.style.setProperty('font-size', entry.inlineFontSizeValue, entry.inlineFontSizePriority);
      } else {
        element.style.removeProperty('font-size');
      }
    });
    fontSizeState.scaledElements.clear();
  };

  return {
    'browser-zoom': {
      apply: () => {},
      remove: () => {}
    },

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
        textElements.forEach((element) => {
          const currentFontSize = parseFloat(getComputedStyle(element).fontSize);
          if (!isFinite(currentFontSize) || currentFontSize <= 0) return;

          fontSizeState.scaledElements.set(element, {
            baseFontSize: currentFontSize,
            inlineFontSizeValue: element.style.getPropertyValue('font-size'),
            inlineFontSizePriority: element.style.getPropertyPriority('font-size')
          });
        });

        fontSizeState.scaledElements.forEach((entry, element) => {
          if (!element.isConnected) return;
          element.style.setProperty('font-size', `${entry.baseFontSize * validLevel}px`, 'important');
        });
      },
      remove: () => {
        removeFontSizeInlineOverrides();
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
