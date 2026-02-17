const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3.0;
const BROWSER_ZOOM_MIN = 0.25;
const BROWSER_ZOOM_MAX = 5.0;
const DEFAULT_METHOD = 'browser-zoom';
const DEFAULT_LEVEL = 1.0;
const STEP_MIN = 0.01;
const STEP_MAX = 0.5;
const DEFAULT_ZOOM_STEP = 0.05;
const DEFAULT_FINE_ZOOM_STEP = 0.01;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ZOOM_MIN,
    ZOOM_MAX,
    BROWSER_ZOOM_MIN,
    BROWSER_ZOOM_MAX,
    DEFAULT_METHOD,
    DEFAULT_LEVEL,
    STEP_MIN,
    STEP_MAX,
    DEFAULT_ZOOM_STEP,
    DEFAULT_FINE_ZOOM_STEP
  };
}
