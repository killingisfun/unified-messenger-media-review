
/*! cache-logger.js */
(function(){
  if (window.__CACHE_LOGGER_INSTALLED__) return;
  window.__CACHE_LOGGER_INSTALLED__ = true;

  const ORIG_FETCH = window.fetch;
  window.DEBUG_MEDIA_CACHE = window.DEBUG_MEDIA_CACHE ?? true; // default on; set to false to silence

  window.fetch = async function(resource, init){
    const url = (typeof resource === 'string') ? resource : (resource && resource.url) || '';
    const isPrefetch = /(?:^|\/)prefetch\.php\b/.test(url);
    const isProxy = /(?:^|\/)media_proxy\.php\b/.test(url);
    const t0 = (isPrefetch || isProxy) ? performance.now() : 0;

    try {
      const resp = await ORIG_FETCH.apply(this, arguments);
      if (isPrefetch || isProxy) {
        const dt = (performance.now() - t0).toFixed(0);
        const xcache = resp.headers.get('X-Cache-Status') || '-';
        if (window.DEBUG_MEDIA_CACHE) {
          console.info('[MEDIA]['+(isPrefetch?'prefetch':'proxy')+']', xcache, 'ms='+dt, url);
        }
      }
      return resp;
    } catch (e) {
      if (isPrefetch || isProxy) {
        const dt = (performance.now() - t0).toFixed(0);
        if (window.DEBUG_MEDIA_CACHE) {
          console.warn('[MEDIA][error]', 'ms='+dt, url, e);
        }
      }
      throw e;
    }
  };
})();
