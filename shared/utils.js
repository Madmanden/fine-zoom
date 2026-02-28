(function(root) {
  const isDomainExcluded = (domain, excludedSites) => {
    if (typeof domain !== 'string' || domain.length === 0) return false;
    const normalizedDomain = domain.toLowerCase();

    const sourceSites = Array.isArray(excludedSites)
      ? excludedSites
      : typeof excludedSites === 'string'
        ? excludedSites.split(/\r?\n|,/)
        : [];

    return sourceSites.some((site) => {
      const normalizedSite = String(site || '').trim().toLowerCase();
      if (!normalizedSite) return false;
      return normalizedDomain === normalizedSite || normalizedDomain.endsWith('.' + normalizedSite);
    });
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

  const estimateNativeZoomStepCount = (nativeDelta, baseStep = 0.1, maxSteps = 20) => {
    const delta = Math.abs(Number.parseFloat(nativeDelta));
    const normalizedBase = Number.isFinite(baseStep) && baseStep > 0 ? baseStep : 0.1;
    const normalizedMax = Number.isFinite(maxSteps) && maxSteps > 0 ? Math.floor(maxSteps) : 20;

    if (!Number.isFinite(delta) || delta <= 0) return 1;
    const stepCount = Math.max(1, Math.round(delta / normalizedBase));
    return Math.min(normalizedMax, stepCount);
  };

  const utils = {
    isDomainExcluded,
    normalizeMethod,
    accumulateCtrlWheelSteps,
    estimateNativeZoomStepCount
  };

  root.TextZoomUtils = utils;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = utils;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
