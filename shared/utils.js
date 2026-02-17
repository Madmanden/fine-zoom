(function(root) {
  const isDomainExcluded = (domain, excludedSites) => {
    return excludedSites.some(site => domain === site || domain.endsWith('.' + site));
  };

  const normalizeMethod = (method, defaultMethod) => {
    if (method === 'transform') return 'browser-zoom';
    if (method === 'browser-zoom' || method === 'font-size' || method === 'css-zoom') return method;
    return defaultMethod;
  };

  const utils = {
    isDomainExcluded,
    normalizeMethod
  };

  root.TextZoomUtils = utils;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = utils;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
