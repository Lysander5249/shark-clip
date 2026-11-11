/* Bookmark capture template. Replace the two JSON literal placeholders when
 * generating a bookmark; no platform credentials or stored browser data read. */
(() => {
  'use strict';
  const ORIGIN = __CAPTURE_ORIGIN__;
  const TOKEN = __CAPTURE_TOKEN__;
  const SLOT = '__clipFetcherBookmarkCaptureV1', VERSION = 4;
  const provider = location.protocol === 'https:' && !location.port
    ? ({ 'pan.xunlei.com': 'xunlei', 'pan.baidu.com': 'baidu' })[location.hostname] : null;
  if (!provider) { alert('请在 Chrome / Edge 的迅雷云盘或百度网盘页面使用此书签。'); return; }
  let local;
  try { local = new URL(ORIGIN); } catch { return; }
  if (local.origin !== ORIGIN || local.protocol !== 'http:' || local.hostname !== '127.0.0.1'
      || !local.port || !/^[a-f0-9]{64}$/.test(TOKEN)) return;
  const previous = window[SLOT];
  if (previous?.origin === ORIGIN && previous?.version === VERSION && previous?.restart instanceof Function) { previous.restart(TOKEN); return; }
  try { previous?.stop?.(); } catch {}
  if (previous) document.getElementById('clip-fetcher-bookmark-capture')?.remove();

  const MAX_BODY = 2 * 1024 * 1024, MAX_NODES = 600, MAX_BATCH = 12, MAX_SEEN = 100;
  const LINK_KEYS = new Set(['web_content_link', 'dlink', 'download_url', 'download_link', 'file_url', 'file_download_url', 'original_url', 'origin_url']);
  const EXTENSION = /\.(?:mkv|mp4|m4v|mov|avi|webm|m2ts)$/i;
  const nonce = () => [...crypto.getRandomValues(new Uint8Array(16))].map(n => n.toString(16).padStart(2, '0')).join('');
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const text = value => typeof value === 'string' && !/(?:https?:\/\/|blob:|data:)/i.test(value)
    ? value.slice(0, 1024).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 256) : '';
  const size = value => {
    if (typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value)) value = Number(value);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  };
  function fileUrl(value) {
    if (typeof value !== 'string' || !value || value.length > 8192 || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443'
          || ['localhost', 'api-pan.xunlei.com', 'pan.baidu.com', 'pan.xunlei.com'].includes(url.hostname)
          || url.hostname.endsWith('.localhost') || url.hostname.endsWith('.local') || url.hostname.includes(':')
          || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) return null;
      const path = decodeURIComponent(url.pathname);
      if (/\.(?:m3u8|mpd|m4s|ts|aac|mp3|m4a|png|jpe?g|gif|webp|svg|ico|css|[cm]?js|woff2?|ttf|json|html?|xml|vtt|srt|ass|ssa)(?:$|\/)/i.test(path)
          || /(?:^|\/)streaming(?:\/|$)/i.test(path) || /^m3u8/i.test(url.searchParams.get('type') || '')
          || url.searchParams.get('method') === 'streaming') return null;
      return url.href;
    } catch { return null; }
  }
  const pageUrl = () => { const url = new URL(location.href); url.search = ''; url.hash = ''; return url.href; };
  let current = null, panel, status, stopButton, dismissTimer;
  function dismiss() {
    clearTimeout(dismissTimer); dismissTimer = undefined;
    if (current?.active) cleanup(current);
    try { if (current?.receiver && !current.receiver.closed) current.receiver.close(); } catch {}
    panel?.remove();
  }
  function mount() {
    if (panel?.isConnected) return;
    panel = document.createElement('div'); panel.id = 'clip-fetcher-bookmark-capture';
    Object.assign(panel.style, { position: 'fixed', right: '18px', bottom: '18px', zIndex: '2147483647', width: '290px',
      padding: '14px', borderRadius: '12px', background: '#f5f7f3', color: '#203b33', border: '1px solid #c4d0c5',
      boxShadow: '0 8px 28px #0003', font: '13px/1.7 system-ui,sans-serif' });
    const title = document.createElement('strong');
    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    icon.setAttribute('viewBox', '0 0 100 100');
    icon.setAttribute('aria-hidden', 'true');
    Object.assign(icon.style, { display: 'inline-block', width: '14px', height: '14px', marginRight: '6px', verticalAlign: '-2px' });
    const fin = document.createElementNS(icon.namespaceURI, 'path');
    fin.setAttribute('fill', '#000');
    fin.setAttribute('d', 'M0 100 C10 54 29 15 62.5 0 C61 14 62 29 66.5 45.7 L42.6 63.8 L71 59.7 C77 77 86.4 90.6 100 100 Z');
    icon.append(fin);
    title.append(icon, '片段取材 · 书签抓链');
    const closeButton = document.createElement('button'); closeButton.type = 'button'; closeButton.textContent = '×';
    closeButton.setAttribute('aria-label', '关闭并停止本次识别'); closeButton.title = '关闭并停止本次识别';
    Object.assign(closeButton.style, { float: 'right', border: 'none', background: 'transparent', color: '#203b33',
      font: '22px/1 system-ui,sans-serif', padding: '0 4px', cursor: 'pointer' });
    closeButton.addEventListener('click', dismiss);
    status = document.createElement('p'); status.setAttribute('role', 'status'); status.style.margin = '8px 0';
    stopButton = document.createElement('button'); stopButton.textContent = '停止识别';
    Object.assign(stopButton.style, { border: '1px solid #aabbaa', borderRadius: '7px', background: '#fff', padding: '5px 10px', color: '#203b33', cursor: 'pointer' });
    stopButton.addEventListener('click', () => { const run = current; if (run) finish(run, '已停止识别。需要继续时再点一次书签。'); });
    panel.append(closeButton, title, status, stopButton); (document.body || document.documentElement).appendChild(panel);
  }
  const active = run => current === run && run.active;
  function setStatus(value) { mount(); status.textContent = value; }
  const cancelReader = reader => { try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch {} };
  function cleanup(run) {
    if (!run?.active) return;
    run.active = false;
    for (const timer of run.timers) clearTimeout(timer); run.timers.clear();
    for (const reader of run.readers) cancelReader(reader); run.readers.clear();
    for (const item of run.xhrListeners) item.xhr.removeEventListener('load', item.listener); run.xhrListeners.clear();
    run.observer?.disconnect();
    window.removeEventListener('message', run.onMessage);
    document.removeEventListener('click', run.onClick, true);
    if (window.fetch === run.fetchWrapper) window.fetch = run.oldFetch;
    if (window.open === run.openWrapper) window.open = run.oldOpen;
    if (XMLHttpRequest.prototype.open === run.xhrOpenWrapper) XMLHttpRequest.prototype.open = run.oldXhrOpen;
    if (XMLHttpRequest.prototype.send === run.xhrSendWrapper) XMLHttpRequest.prototype.send = run.oldXhrSend;
    run.pending.clear(); run.seen.clear(); run.sentCount = 0;
  }
  function finish(run, message, { success = false, closeReceiver = true } = {}) {
    if (!active(run)) return;
    cleanup(run); setStatus(message); stopButton.disabled = true;
    if (closeReceiver) try { if (run.receiver && !run.receiver.closed) run.receiver.close(); } catch {}
    if (success) dismissTimer = setTimeout(() => { dismissTimer = undefined; if (current === run) panel?.remove(); }, 1200);
  }
  function later(run, callback, delay) {
    const id = setTimeout(() => { run.timers.delete(id); if (active(run)) callback(); }, delay);
    run.timers.add(id); return id;
  }
  function resource(run, value, label) {
    const url = fileUrl(value); if (!url || !EXTENSION.test(new URL(url).pathname)) return;
    let name = text(label); if (!name) { try { name = text(decodeURIComponent(new URL(url).pathname.split('/').at(-1))); } catch {} }
    add(run, { url, ...(name ? { name } : {}) }, false);
  }
  function add(run, candidate, metadata) {
    if (!active(run) || run.sent || !candidate || run.seen.size >= MAX_SEEN && !run.seen.has(candidate.url)) return;
    const existing = run.pending.get(candidate.url);
    if (run.seen.has(candidate.url) && (!metadata || existing?.metadata)) return;
    run.seen.add(candidate.url); run.pending.set(candidate.url, { ...candidate, metadata });
    if (!run.flushTimer) run.flushTimer = later(run, () => { run.flushTimer = null; flush(run); }, 350);
  }
  function scan(run, payload) {
    let visited = 0;
    function walk(value, depth, inherited) {
      if (!active(run) || ++visited > MAX_NODES || depth > 8) return;
      if (Array.isArray(value)) { for (const item of value.slice(0, 100)) walk(item, depth + 1, inherited); return; }
      if (!record(value)) return;
      const name = text(value.name ?? value.file_name ?? value.server_filename ?? inherited.name);
      const fileSize = size(value.size ?? value.file_size ?? inherited.size);
      const hints = { ...(name ? { name } : {}), ...(fileSize ? { size: fileSize } : {}) };
      for (const [key, child] of Object.entries(value).slice(0, 100)) {
        if (LINK_KEYS.has(key.toLowerCase())) {
          const url = fileUrl(typeof child === 'string' ? child : record(child) ? child.url : null);
          if (url) add(run, { url, ...hints }, true);
        }
        if (child && typeof child === 'object') walk(child, depth + 1, hints);
      }
    }
    walk(payload, 0, {});
  }
  async function inspectResponse(run, response) {
    if (!active(run) || response.status < 200 || response.status >= 300 || !/json|text/i.test(response.headers.get('content-type') || '')) return;
    if (Number(response.headers.get('content-length')) > MAX_BODY) return;
    let reader;
    try {
      reader = response.clone().body?.getReader(); if (!reader) return;
      run.readers.add(reader);
      const chunks = []; let received = 0;
      while (active(run)) {
        const next = await reader.read(); if (next.done) break;
        if (!(next.value instanceof Uint8Array) || next.value.byteLength > MAX_BODY - received) return;
        chunks.push(next.value); received += next.value.byteLength;
      }
      if (!active(run)) return;
      const bytes = new Uint8Array(received); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      scan(run, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    } catch { /* Capturing must never change the webpage's request result. */ }
    finally { run.readers.delete(reader); if (reader) cancelReader(reader); }
  }
  function flush(run) {
    if (!active(run) || run.sent || !run.pending.size || !run.receiverNonce) return;
    const all = [...run.pending.values()];
    const precise = all.filter(item => item.metadata && item.name && item.size);
    if (!precise.length && !all.some(item => item.metadata) && !run.resourceGraceElapsed) {
      if (!run.resourceDelayTimer) run.resourceDelayTimer = later(run, () => { run.resourceGraceElapsed = true; flush(run); }, 1200);
      return;
    }
    // A known file's metadata wins over unrelated cached player resources.
    // Do not burden the user with a candidate list when identity is unambiguous.
    const pool = precise.length ? precise : all.filter(item => item.metadata).length ? all.filter(item => item.metadata) : all;
    const candidates = pool.sort((a, b) => Number(b.metadata) - Number(a.metadata)).slice(0, MAX_BATCH)
      .map(({ metadata, ...candidate }) => ({ ...candidate, headers: {
        ...(typeof navigator.userAgent === 'string' && /^[\x20-\x7e]{1,512}$/.test(navigator.userAgent) ? { 'User-Agent': navigator.userAgent } : {}), Referer: pageUrl() } }));
    const payload = { schemaVersion: 1, provider, pageUrl: pageUrl(), candidates };
    while (new TextEncoder().encode(JSON.stringify(payload)).byteLength > 60000 && payload.candidates.length) payload.candidates.pop();
    if (!payload.candidates.length) { finish(run, '文件入口信息过长，未发送。请使用原工具的旧路径。'); return; }
    run.sent = true; run.sentCount = payload.candidates.length;
    setStatus('已找到文件入口，正在返回片段取材…');
    try { run.receiver.postMessage({ type: 'clip-fetcher:bookmark-candidates', schemaVersion: 1,
      runId: run.id, receiverNonce: run.receiverNonce, payload }, ORIGIN); }
    catch { finish(run, '无法发送给原工具，请打开片段取材后重新点书签。'); return; }
    later(run, () => finish(run, '原工具尚未确认收到入口，请检查工具窗口后重新点书签。'), 15000);
  }
  function start(token) {
    if (!/^[a-f0-9]{64}$/.test(token)) return;
    clearTimeout(dismissTimer); dismissTimer = undefined;
    if (current?.active) cleanup(current);
    mount(); stopButton.disabled = false;
    const run = { id: nonce(), active: true, receiver: null, receiverNonce: null, sent: false, sentCount: 0,
      timers: new Set(), readers: new Set(), xhrListeners: new Set(), seen: new Set(), pending: new Map(), xhrRequests: new WeakMap() };
    current = run;
    run.onMessage = event => {
      if (!active(run) || event.source !== run.receiver || event.origin !== ORIGIN || !record(event.data)) return;
      const data = event.data;
      if (data.schemaVersion !== 1 || !/^[a-f0-9]{32}$/.test(data.receiverNonce || '')) return;
      if (data.type === 'clip-fetcher:bookmark-ready' && data.runId === run.id && !run.sent) {
        run.receiverNonce = data.receiverNonce; setStatus('已准备，请点击播放。视频无法播出时，只要返回原文件入口仍可识别。');
        flush(run);
      } else if (data.type === 'clip-fetcher:bookmark-closed' && data.runId === run.id && run.receiverNonce && data.receiverNonce === run.receiverNonce) {
        dismiss();
      } else if (data.type === 'clip-fetcher:bookmark-result' && run.sent && data.runId === run.id && data.receiverNonce === run.receiverNonce
          && Number.isSafeInteger(data.accepted) && data.accepted >= 0 && data.accepted <= run.sentCount) {
        finish(run, data.accepted > 0 ? '已发送到片段取材。请在工具中输入时间，开始取片。'
          : '原工具未接受可用原文件入口，请查看工具中的提示，或使用旧路径。', { success: data.accepted > 0, closeReceiver: data.accepted > 0 });
      }
    };
    window.addEventListener('message', run.onMessage);
    setStatus('正在连接片段取材…');
    // This call stays inside the bookmark click gesture. No deferred network
    // request or second user click is required to create the receiver window.
    try { run.receiver = window.open(`${ORIGIN}/bookmark/receive#${token}.${run.id}`, 'clip-fetcher-capture', 'width=420,height=360,menubar=no,toolbar=no,location=no,status=no,resizable=yes'); }
    catch {}
    if (!run.receiver) { finish(run, '接收窗口被浏览器拦截。请允许本次弹窗后重新点书签。'); return; }
    const watchReceiver = () => {
      if (run.receiver.closed) { dismiss(); return; }
      later(run, watchReceiver, 500);
    };
    later(run, watchReceiver, 500);
    later(run, () => { if (!run.receiverNonce) finish(run, '未连接到片段取材。请先打开原工具，再重新点书签。'); }, 10000);
    later(run, () => finish(run, '本次未识别到可用原文件入口。可重新点书签，或使用原工具的旧路径。'), 90000);

    run.oldFetch = window.fetch;
    if (typeof run.oldFetch === 'function') {
      run.fetchWrapper = async function(...args) {
        const response = await run.oldFetch.apply(this, args);
        if (active(run)) { resource(run, response.url); void inspectResponse(run, response); }
        return response;
      };
      window.fetch = run.fetchWrapper;
    }
    run.oldXhrOpen = XMLHttpRequest.prototype.open; run.oldXhrSend = XMLHttpRequest.prototype.send;
    run.xhrOpenWrapper = function(method, url, ...args) { run.xhrRequests.set(this, { method, url }); return run.oldXhrOpen.apply(this, [method, url, ...args]); };
    run.xhrSendWrapper = function(...args) {
      if (active(run)) {
        const xhr = this, item = { xhr, listener: null };
        item.listener = () => {
          run.xhrListeners.delete(item);
          if (!active(run) || xhr.status < 200 || xhr.status >= 300) return;
          try {
            resource(run, xhr.responseURL);
            if (xhr.responseType === 'json') scan(run, xhr.response);
            else if ((!xhr.responseType || xhr.responseType === 'text') && typeof xhr.responseText === 'string' && xhr.responseText.length <= MAX_BODY)
              scan(run, JSON.parse(xhr.responseText));
          } catch {}
        };
        run.xhrListeners.add(item); xhr.addEventListener('load', item.listener, { once: true });
      }
      return run.oldXhrSend.apply(this, args);
    };
    XMLHttpRequest.prototype.open = run.xhrOpenWrapper; XMLHttpRequest.prototype.send = run.xhrSendWrapper;
    run.oldOpen = window.open;
    run.openWrapper = function(url, ...args) { if (typeof url === 'string') resource(run, url); return run.oldOpen.apply(this, [url, ...args]); };
    window.open = run.openWrapper;
    run.onClick = event => { try { const link = event.target?.closest?.('a[href]'); if (link) resource(run, link.href, link.download || link.textContent); } catch {} };
    document.addEventListener('click', run.onClick, true);
    try {
      run.observer = new PerformanceObserver(list => { for (const entry of list.getEntries().slice(0, 200)) resource(run, entry.name); });
      run.observer.observe({ type: 'resource', buffered: true });
    } catch {}
    try { for (const item of performance.getEntriesByType('resource').slice(-200)) resource(run, item.name); } catch {}
    try {
      const elements = document.querySelectorAll('a[href],video[src],source[src]');
      for (let i = 0; i < Math.min(elements.length, 200); i++) resource(run, elements[i].href || elements[i].src, elements[i].download);
    } catch {}
  }
  Object.defineProperty(window, SLOT, { configurable: true, value: Object.freeze({ origin: ORIGIN, version: VERSION,
    restart: start, stop() { if (current?.active) finish(current, '已停止识别。'); } }) });
  start(TOKEN);
})();
