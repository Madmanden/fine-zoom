window.ZoomMethods = (function() {
  const validateZoomLevel = (level) => {
    const num = parseFloat(level);
    if (!isFinite(num) || isNaN(num)) return 1.0;
    return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, num));
  };

  const FONT_SIZE_STYLE_ID = 'text-zoom-font-style';

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

        let style = document.getElementById(FONT_SIZE_STYLE_ID);
        if (!style) {
          style = document.createElement('style');
          style.id = FONT_SIZE_STYLE_ID;
          document.documentElement.appendChild(style);
        }

        style.textContent = `
          :root {
            --text-zoom-scale: ${validLevel};
          }

          html {
            font-size: calc(100% * var(--text-zoom-scale)) !important;
          }

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
      },
      remove: () => {
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
