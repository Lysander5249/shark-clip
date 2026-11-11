/* Observe ordinary page activity. A separate explicit user command may ask the
 * current official Xunlei store for DISPLAY metadata; its own service owns
 * authorization. No cookie/token read, signing, playback, or direct API fetch. */
(() => {
  const SLOT = '__clipFetcherCaptureV1';
  if (window[SLOT]) return;
  const core = globalThis.ClipFetcherCaptureCore;
  if (!core || !core.providerForPage(location.href)) return;
  const MAX_BODY = 2 * 1024 * 1024, DETAIL_TIMEOUT_MS = 20000;
  let enabled = false, currentSession = '', timer, listTimer, observer, detailOperation = null;
  const seen = new Set(), pending = new Map(), readers = new Set(), xhrRequests = new WeakMap();
  let oldFetch, fetchWrapper, oldOpen, openWrapper, oldXhrOpen, xhrOpenWrapper, oldXhrSend, xhrSendWrapper;
  const emit = (source, data) => window.postMessage({ source, sessionId: currentSession, ...data }, location.origin);
  const send = () => {
    timer = undefined;
    if (!enabled || !pending.size) return;
    const candidates = [...pending.values()].slice(0, core.MAX_CANDIDATES); pending.clear();
    emit('clip-fetcher:candidates:v1', { candidates });
  };
  function add(candidate) {
    if (!enabled || !candidate || seen.has(candidate.url) || seen.size >= 100) return;
    seen.add(candidate.url); pending.set(candidate.url, candidate);
    if (timer === undefined) timer = setTimeout(send, 200);
  }
  const resource = (url, name) => { if (enabled) add(core.resourceCandidate(url, name)); };
  function store() {
    try {
      if (core.providerForPage(location.href) !== 'xunlei') return null;
      const value = window.$nuxt?.$store;
      if (!value || typeof value.dispatch !== 'function' || !value.state?.drive?.all || value.state.safebox?.isIn === true) return null;
      return value;
    } catch { return null; }
  }
  function storedFile(value, id) {
    try {
      if (!value || !Object.hasOwn(value.state.drive.all, id)) return null;
      const file = core.xunleiFile(value.state.drive.all[id]);
      return file?.id === id ? file : null;
    } catch { return null; }
  }
  function publishFiles() {
    listTimer = undefined;
    if (!enabled || core.providerForPage(location.href) !== 'xunlei') return;
    const currentStore = store(), files = [];
    if (currentStore) {
      try {
        for (const id of Object.keys(currentStore.state.drive.all).slice(0, 2000)) {
          const file = storedFile(currentStore, id); if (file) files.push(file);
          if (files.length >= 50) break;
        }
      } catch {}
    }
    emit('clip-fetcher:files:v1', { available: Boolean(currentStore), files });
  }
  function scheduleFiles() {
    if (enabled && listTimer === undefined) listTimer = setTimeout(publishFiles, 0);
  }
  function scan(payload) {
    if (enabled) { for (const candidate of core.metadataCandidates(payload)) add(candidate); scheduleFiles(); }
  }
  function currentDetail(op) {
    return enabled && detailOperation === op && currentSession === op.sessionId && store() === op.store
      && core.sameXunleiFile(storedFile(op.store, op.file.id), op.file);
  }
  function detailResult(op, code) {
    if (detailOperation !== op) return;
    detailOperation = null; clearTimeout(op.timer);
    for (const reader of op.readers) { try { void reader.cancel().catch(() => {}); } catch {} }
    op.readers.clear();
    if (!enabled || currentSession !== op.sessionId) return;
    emit('clip-fetcher:detail-result:v1', { operationId: op.id, fileId: op.file.id, code });
  }
  function observeDetail(payload, op, status) {
    if (!currentDetail(op)) return;
    op.sawResponse = true; op.lastStatus = status;
    if (status !== 200) return;
    const file = core.xunleiFile(payload);
    if (!core.sameXunleiFile(file, op.file)) { op.invalidResponse = true; return; }
    const rawLink = payload.web_content_link;
    const url = core.originalUrl(typeof rawLink === 'string' ? rawLink : rawLink?.url);
    if (url) op.freshCandidate = { url, name: file.name, size: file.size };
  }
  function requestDetail(urlValue, method = 'GET') {
    const op = detailOperation;
    // Even when identity has changed, keep a matching late request bound to its
    // operation so that its response cannot fall back into passive capture.
    if (!op || !enabled || currentSession !== op.sessionId || String(method).toUpperCase() !== 'GET') return null;
    try {
      const url = new URL(urlValue, location.href);
      return url.origin === 'https://api-pan.xunlei.com' && url.pathname === `/drive/v1/files/${op.file.id}`
        && url.searchParams.get('usage') === 'DISPLAY' ? op : null;
    } catch { return null; }
  }
  async function responseBody(response, sessionId, op = null) {
    if (!enabled || sessionId !== currentSession || !/json|text/.test(response.headers.get('content-type') || '')) return;
    const declared = Number(response.headers.get('content-length'));
    if (declared > MAX_BODY) return;
    let reader;
    try {
      reader = response.clone().body?.getReader(); if (!reader) return;
      readers.add(reader); op?.readers.add(reader);
      const parts = []; let received = 0;
      while (enabled && sessionId === currentSession) {
        const next = await reader.read(); if (next.done) break;
        if (next.value.byteLength > MAX_BODY - received) return;
        received += next.value.byteLength; parts.push(next.value);
      }
      if (!enabled || sessionId !== currentSession) return;
      const bytes = new Uint8Array(received); let offset = 0;
      for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
      const payload = JSON.parse(new TextDecoder().decode(bytes));
      if (op) observeDetail(payload, op, response.status); else scan(payload);
    } catch { /* Never disrupt the website or expose raw errors/payloads. */ }
    finally {
      readers.delete(reader); op?.readers.delete(reader);
      try { await reader?.cancel(); } catch {}
    }
  }
  function beginDetail(message) {
    const requested = message.file, currentStore = store();
    const file = typeof requested?.id === 'string' ? storedFile(currentStore, requested.id) : null;
    const operationId = message.operationId;
    if (typeof operationId !== 'string' || !/^[a-f0-9-]{20,80}$/.test(operationId)) return;
    const reject = code => emit('clip-fetcher:detail-result:v1', { operationId, fileId: requested?.id, code });
    if (detailOperation) { reject('DETAIL_BUSY'); return; }
    if (!file || !core.sameXunleiFile(file, requested)) { reject('DETAIL_CHANGED'); return; }
    const op = { id: operationId, sessionId: currentSession, store: currentStore, file,
      reads: new Set(), readers: new Set(), freshCandidate: null, invalidResponse: false, sawResponse: false };
    detailOperation = op;
    op.timer = setTimeout(() => detailResult(op, 'DETAIL_TIMEOUT'), DETAIL_TIMEOUT_MS);
    let dispatched;
    try { dispatched = currentStore.dispatch('drive/getFileInfo', { id: file.id, usage: 'DISPLAY' }); }
    catch { detailResult(op, 'DETAIL_REQUEST_FAILED'); return; }
    Promise.resolve(dispatched).then(async result => {
      if (detailOperation !== op) return;
      await Promise.allSettled([...op.reads]);
      if (detailOperation !== op) return;
      if (!currentDetail(op) || op.invalidResponse) { detailResult(op, 'DETAIL_CHANGED'); return; }
      if (result !== 'success') { detailResult(op, 'DETAIL_REQUEST_FAILED'); return; }
      if (!op.freshCandidate) { detailResult(op, op.lastStatus && op.lastStatus !== 200 ? 'DETAIL_REQUEST_FAILED' : 'DETAIL_ORIGINAL_UNAVAILABLE'); return; }
      // Only a newly observed response can supply this value. Never read the
      // store's old/merged web_content_link as a fallback or change API usage.
      add(op.freshCandidate); send(); detailResult(op, 'DETAIL_READY'); scheduleFiles();
    }).catch(() => detailResult(op, 'DETAIL_REQUEST_FAILED'));
  }
  function onClick(event) {
    const anchor = event.target?.closest?.('a[href]'); if (anchor) resource(anchor.href, anchor.download || anchor.textContent);
  }
  function install() {
    oldFetch = window.fetch;
    if (typeof oldFetch === 'function') {
      const baseFetch = oldFetch;
      fetchWrapper = async function(...args) {
        const requestSession = currentSession;
        const op = requestDetail(typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0]?.url,
          args[1]?.method || args[0]?.method || 'GET');
        const response = await baseFetch.apply(this, args);
        if (enabled && requestSession === currentSession) {
          if (!op) resource(response.url);
          const reading = responseBody(response, requestSession, op);
          if (op) { op.reads.add(reading); void reading.finally(() => op.reads.delete(reading)).catch(() => {}); }
          else void reading.catch(() => {});
        }
        return response;
      };
      window.fetch = fetchWrapper;
    }
    oldXhrOpen = XMLHttpRequest.prototype.open; oldXhrSend = XMLHttpRequest.prototype.send;
    const baseXhrOpen = oldXhrOpen, baseXhrSend = oldXhrSend;
    xhrOpenWrapper = function(method, url, ...args) { xhrRequests.set(this, { method, url }); return baseXhrOpen.apply(this, [method, url, ...args]); };
    xhrSendWrapper = function(...args) {
      if (enabled) {
        const sessionId = currentSession, request = xhrRequests.get(this), op = requestDetail(request?.url, request?.method);
        this.addEventListener('load', () => {
          if (!enabled || sessionId !== currentSession) return;
          try {
            if (!op) resource(this.responseURL);
            let payload;
            if (this.responseType === 'json') payload = this.response;
            else if ((!this.responseType || this.responseType === 'text') && this.responseText?.length <= MAX_BODY)
              payload = JSON.parse(this.responseText);
            if (op) observeDetail(payload, op, this.status); else scan(payload);
          } catch {}
        }, { once: true });
      }
      return baseXhrSend.apply(this, args);
    };
    XMLHttpRequest.prototype.open = xhrOpenWrapper; XMLHttpRequest.prototype.send = xhrSendWrapper;
    oldOpen = window.open;
    const baseOpen = oldOpen;
    openWrapper = function(url, ...args) { if (typeof url === 'string') resource(url); return baseOpen.apply(this, [url, ...args]); };
    window.open = openWrapper;
    document.addEventListener('click', onClick, true);
    try {
      observer = new PerformanceObserver(list => { for (const item of list.getEntries()) resource(item.name); });
      observer.observe({ type: 'resource', buffered: true });
    } catch {}
    try {
      performance.getEntriesByType('resource').slice(-300).forEach(item => resource(item.name));
      document.querySelectorAll('a[href],video[src],source[src]').forEach(element => resource(element.href || element.src, element.download));
    } catch {}
    publishFiles();
  }
  function stop() {
    if (detailOperation) detailResult(detailOperation, 'DETAIL_CANCELLED');
    enabled = false; pending.clear(); seen.clear(); currentSession = '';
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    if (listTimer !== undefined) { clearTimeout(listTimer); listTimer = undefined; }
    for (const reader of readers) { try { void reader.cancel().catch(() => {}); } catch {} } readers.clear();
    observer?.disconnect(); observer = undefined;
    if (window.fetch === fetchWrapper) window.fetch = oldFetch;
    if (window.open === openWrapper) window.open = oldOpen;
    if (XMLHttpRequest.prototype.open === xhrOpenWrapper) XMLHttpRequest.prototype.open = oldXhrOpen;
    if (XMLHttpRequest.prototype.send === xhrSendWrapper) XMLHttpRequest.prototype.send = oldXhrSend;
    document.removeEventListener('click', onClick, true);
  }
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.source !== window || event.origin !== location.origin || data?.source !== 'clip-fetcher:command:v1') return;
    if (data.command === 'stop' && data.sessionId === currentSession) stop();
    if (data.command === 'start' && typeof data.sessionId === 'string' && /^[a-f0-9-]{20,80}$/.test(data.sessionId)) {
      stop(); currentSession = data.sessionId; enabled = true; install();
    } else if (enabled && data.sessionId === currentSession) {
      if (data.command === 'list') publishFiles();
      if (data.command === 'detail' && core.providerForPage(location.href) === 'xunlei') beginDetail(data);
    }
  });
  Object.defineProperty(window, SLOT, { value: Object.freeze({ stop }), configurable: false });
})();
