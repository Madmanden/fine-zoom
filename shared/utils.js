(function(root) {
  const isDomainExcluded = (domain, excludedSites) => {
    return excludedSites.some(site => domain === site || domain.endsWith('.' + site));
  };

  const normalizeMethod = (method, defaultMethod) => {
    if (method === 'transform') return 'browser-zoom';
    if (method === 'browser-zoom' || method === 'font-size' || method === 'css-zoom') return method;
    return defaultMethod;
  };

  const normalizeWheelDelta = (deltaY, deltaMode, viewportHeight) => {
    if (!Number.isFinite(deltaY)) return 0;
    if (deltaMode === 1) return deltaY * 16;
    if (deltaMode === 2) return deltaY * Math.max(1, viewportHeight || 1);
    return deltaY;
  };

  const accumulateCtrlWheelSteps = ({
    accumulator,
    deltaY,
    deltaMode,
    viewportHeight,
    threshold
  }) => {
    const nextThreshold = Number.isFinite(threshold) && threshold > 0 ? threshold : 100;
    let nextAccumulator = (Number.isFinite(accumulator) ? accumulator : 0)
      + normalizeWheelDelta(deltaY, deltaMode, viewportHeight);

    let steps = 0;
    if (nextAccumulator <= -nextThreshold) {
      steps = Math.floor(Math.abs(nextAccumulator) / nextThreshold);
      nextAccumulator += steps * nextThreshold;
    } else if (nextAccumulator >= nextThreshold) {
      steps = -Math.floor(nextAccumulator / nextThreshold);
      nextAccumulator -= Math.abs(steps) * nextThreshold;
    }

    return { accumulator: nextAccumulator, steps };
  };

  const utils = {
    isDomainExcluded,
    normalizeMethod,
    accumulateCtrlWheelSteps
  };

  root.TextZoomUtils = utils;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = utils;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
