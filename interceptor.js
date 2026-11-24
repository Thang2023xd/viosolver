/**
 * VioEdu Ultra-Low-Memory Interceptor (MAIN World)
 * Zero memory retention. No storage arrays. Bypasses 100% of static/media assets.
 */

(function () {
  'use strict';

  // Only run in top window to prevent RAM multiplication across iframes
  if (window !== window.top) return;

  const IGNORED = /\.(js|css|png|jpg|jpeg|gif|webp|svg|ico|woff|woff2|ttf|wasm|data|unityweb|bundle|mp3|mp4|webm)(\?.*)?$/i;

  function broadcastQuestion(data, source) {
    if (!data) return;
    try {
      window.dispatchEvent(
        new CustomEvent('__VIO_QUESTION_EVENT__', {
          detail: { source, data }
        })
      );
    } catch (e) {}
  }

  function shallowInspect(obj, depth = 0) {
    if (!obj || depth > 2 || typeof obj !== 'object') return null;

    if (
      (obj.content || obj.question || obj.title || obj.cau_hoi) &&
      (obj.answers || obj.options || obj.list_answer || obj.dap_an)
    ) {
      return {
        question: obj.content || obj.question || obj.title || obj.cau_hoi,
        answers: obj.answers || obj.options || obj.list_answer || obj.dap_an
      };
    }

    if (Array.isArray(obj)) {
      for (let i = 0; i < Math.min(obj.length, 5); i++) {
        const found = shallowInspect(obj[i], depth + 1);
        if (found) return found;
      }
    } else {
      const keys = Object.keys(obj);
      for (let i = 0; i < Math.min(keys.length, 10); i++) {
        const k = keys[i].toLowerCase();
        if (k.includes('question') || k.includes('quiz') || k.includes('data')) {
          const found = shallowInspect(obj[keys[i]], depth + 1);
          if (found) return found;
        }
      }
    }
    return null;
  }

  // Hook Fetch
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    try {
      const response = await originalFetch.apply(this, args);
      const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');

      if (!url || IGNORED.test(url)) return response;

      const contentType = response.headers ? response.headers.get('content-type') : '';
      if (contentType && contentType.includes('application/json')) {
        response.clone().json().then(data => {
          const q = shallowInspect(data);
          if (q) broadcastQuestion(q, 'fetch');
        }).catch(() => {});
      }

      return response;
    } catch (err) {
      // Preserve the page's original rejection; don't issue the failed request twice.
      throw err;
    }
  };

  // Hook XHR
  const originalXhrOpen = XMLHttpRequest.prototype.open;
  const originalXhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._skip = !url || typeof url !== 'string' || IGNORED.test(url);
    return originalXhrOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (!this._skip) {
      this.addEventListener('load', function () {
        try {
          if (this.responseType === '' || this.responseType === 'text') {
            if (this.responseText.length < 50000 && this.responseText.includes('question')) {
              const data = JSON.parse(this.responseText);
              const q = shallowInspect(data);
              if (q) broadcastQuestion(q, 'xhr');
            }
          }
        } catch (e) {}
      });
    }
    return originalXhrSend.apply(this, args);
  };
})();
