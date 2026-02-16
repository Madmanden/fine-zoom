const ZoomMethods = {
  'css-zoom': {
    apply: (level) => {
      let style = document.getElementById('text-zoom-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'text-zoom-style';
        document.documentElement.appendChild(style);
      }
      style.textContent = `
        html {
          zoom: ${level} !important;
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
      let style = document.getElementById('text-zoom-font-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'text-zoom-font-style';
        document.documentElement.appendChild(style);
      }
      const percentage = level * 100;
      style.textContent = `
        html {
          font-size: ${percentage}% !important;
        }
        
        body, body * {
          max-width: 100vw !important;
          overflow-x: hidden !important;
        }
        
        p, span, h1, h2, h3, h4, h5, h6, div, a, li, td, th, label, button {
          word-wrap: break-word !important;
          overflow-wrap: break-word !important;
          hyphens: auto !important;
        }
        
        img, video, svg, canvas, iframe {
          max-width: 100% !important;
          height: auto !important;
        }
        
        table {
          table-layout: fixed !important;
          width: 100% !important;
        }
        
        pre, code {
          white-space: pre-wrap !important;
          word-wrap: break-word !important;
        }
      `;
    },
    remove: () => {
      const style = document.getElementById('text-zoom-font-style');
      if (style) style.remove();
    }
  },
  
  'transform': {
    apply: (level) => {
      let style = document.getElementById('text-zoom-transform-style');
      if (!style) {
        style = document.createElement('style');
        style.id = 'text-zoom-transform-style';
        document.documentElement.appendChild(style);
      }
      style.textContent = `
        html {
          transform: scale(${level}) !important;
          transform-origin: top left !important;
          width: ${100 / level}% !important;
          height: ${100 / level}% !important;
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

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ZoomMethods;
}