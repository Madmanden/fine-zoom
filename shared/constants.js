const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const ZOOM_STEP = 0.05;
const DEFAULT_METHOD = 'css-zoom';
const DEFAULT_LEVEL = 1.0;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ZOOM_MIN, ZOOM_MAX, ZOOM_STEP, DEFAULT_METHOD, DEFAULT_LEVEL };
}
