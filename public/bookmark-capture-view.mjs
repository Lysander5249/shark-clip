const PROVIDERS = new Set(['xunlei', 'baidu']);
const OFFICIAL_ORIGINS = Object.freeze({ xunlei: 'https://pan.xunlei.com', baidu: 'https://pan.baidu.com' });
const HEX32 = /^[a-f0-9]{32}$/;
const RECEIVER_MESSAGES = Object.freeze({
  INVALID_MESSAGE: '未能识别本次候选，请回到网盘重新点击抓链书签。',
  IMPORT_FAILED: '未收到可用文件，请回到网盘重新点击抓链书签。',
  LOCAL_UNAVAILABLE: '无法连接本机工具。请保持片段取材运行，再重新点击抓链书签。',
  TIMEOUT: '本机收件超时，请保持工具运行后重新点击抓链书签。',
});

export function bookmarkCaptureState(payload) {
  const bookmarklet = typeof payload?.bookmarklet === 'string' && /^javascript:/i.test(payload.bookmarklet)
    && payload.bookmarklet.length <= 131072 ? payload.bookmarklet : '';
  const candidates = [], seen = new Set();
  for (const item of Array.isArray(payload?.candidates) ? payload.candidates.slice(0, 50) : []) {
    if (!item || !HEX32.test(item.id) || seen.has(item.id) || !PROVIDERS.has(item.provider)
        || typeof item.sourceHost !== 'string' || item.sourceHost.length > 253
        || !/^[a-z0-9.:[\]-]+$/i.test(item.sourceHost)) continue;
    seen.add(item.id);
    const name = typeof item.name === 'string' && !/(?:https?:\/\/|blob:|data:)/i.test(item.name)
      ? item.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256).trim() : '';
    candidates.push({ id: item.id, provider: item.provider, name: name || '网盘原文件候选', sourceHost: item.sourceHost,
      ...(Number.isSafeInteger(item.size) && item.size > 0 ? { size: item.size } : {}),
      receivedAt: Number.isSafeInteger(item.receivedAt) && item.receivedAt >= 0 ? item.receivedAt : 0 });
  }
  return { available: payload?.available === true && Boolean(bookmarklet), bookmarklet, candidates,
    receiptSequence: Number.isSafeInteger(payload?.receiptSequence) && payload.receiptSequence >= 0 ? payload.receiptSequence : 0,
    lastReceivedAt: Number.isSafeInteger(payload?.lastReceivedAt) && payload.lastReceivedAt >= 0 ? payload.lastReceivedAt : 0 };
}

/** Consume each receipt once, including receipts arriving while the current source is protected. */
export function createBookmarkInboxView() {
  let sequence = null, lastReceivedAt = 0;
  const seen = new Set();
  return {
    receive(snapshot, { active = true, ready = true, locked = false, hasDraft = false } = {}) {
      if (sequence === null) {
        sequence = snapshot.receiptSequence; lastReceivedAt = snapshot.lastReceivedAt;
        for (const candidate of snapshot.candidates) seen.add(candidate.id);
        return { action: 'baseline' };
      }
      if (snapshot.receiptSequence < sequence || snapshot.lastReceivedAt < lastReceivedAt) return { action: 'stale' };
      if (snapshot.receiptSequence === sequence) return { action: 'unchanged' };
      sequence = snapshot.receiptSequence; lastReceivedAt = snapshot.lastReceivedAt;
      const fresh = snapshot.candidates.filter(candidate => !seen.has(candidate.id));
      for (const candidate of snapshot.candidates) seen.add(candidate.id);
      if (!fresh.length) return { action: 'unchanged' };
      if (locked) return { action: 'received-busy', count: fresh.length };
      if (!active || hasDraft || !ready) return { action: 'received-draft', count: fresh.length };
      const only = fresh[0];
      if (fresh.length === 1 && only.name && !['网盘原文件候选', '书签捕获的媒体', '浏览器捕获的媒体'].includes(only.name)
          && Number.isSafeInteger(only.size) && only.size > 0
          && only.receivedAt > 0 && only.receivedAt <= snapshot.lastReceivedAt) {
        return { action: 'select', candidate: only };
      }
      return { action: 'choose', count: fresh.length };
    },
  };
}

export function renderBookmarkCandidates(container, candidates, { selectedId = '', disabled = false, onSelect,
  document = globalThis.document } = {}) {
  container.replaceChildren();
  for (const candidate of candidates) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'browser-candidate';
    button.dataset.browserCandidate = candidate.id; button.disabled = disabled;
    button.setAttribute('aria-pressed', String(candidate.id === selectedId));
    button.textContent = candidate.name;
    button.addEventListener('click', () => { if (!button.disabled) onSelect?.(candidate); });
    container.append(button);
  }
}

function checkedPayload(value, origin) {
  if (!value || value.schemaVersion !== 1 || OFFICIAL_ORIGINS[value.provider] !== origin
      || typeof value.pageUrl !== 'string' || value.pageUrl.length > 2048 || /[\x00-\x20\x7f]/.test(value.pageUrl)
      || !Array.isArray(value.candidates) || !value.candidates.length || value.candidates.length > 20) return null;
  let page;
  try { page = new URL(value.pageUrl); } catch { return null; }
  if (page.origin !== origin || page.search || page.hash || page.username || page.password) return null;
  const candidates = [];
  for (const item of value.candidates) {
    if (!item || typeof item.url !== 'string' || !item.url || item.url.length > 32768 || /[\x00-\x20\x7f]/.test(item.url)) return null;
    let url;
    try { url = new URL(item.url); } catch { return null; }
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) return null;
    if (item.size !== undefined && (!Number.isSafeInteger(item.size) || item.size < 1)) return null;
    const headers = {};
    if (item.headers !== undefined) {
      if (!item.headers || typeof item.headers !== 'object' || Array.isArray(item.headers)) return null;
      for (const [key, contents] of Object.entries(item.headers)) {
        if (!['User-Agent', 'Referer'].includes(key) || typeof contents !== 'string' || !contents
            || contents.length > 8192 || /[^\x20-\x7e]/.test(contents)) return null;
        if (key === 'Referer') {
          let referer;
          try { referer = new URL(contents); } catch { return null; }
          if (referer.origin !== origin || referer.search || referer.hash || referer.username || referer.password) return null;
        }
        headers[key] = contents;
      }
    }
    candidates.push({ url: item.url, ...(typeof item.name === 'string' ? { name: item.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256) } : {}),
      ...(item.size !== undefined ? { size: item.size } : {}), headers });
  }
  const payload = { schemaVersion: 1, provider: value.provider, pageUrl: page.href, candidates };
  return new TextEncoder().encode(JSON.stringify(payload)).byteLength <= 65536 ? payload : null;
}

/** The receiver never persists or renders its capability, signed URLs or request headers. */
export function startBookmarkReceiver({ window = globalThis.window, fetch = globalThis.fetch, crypto = globalThis.crypto,
  setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout } = {}) {
  const status = window.document.getElementById('bookmark-receive-state');
  const closeButton = window.document.getElementById('bookmark-receive-close');
  const closeHint = window.document.getElementById('bookmark-receive-close-hint');
  const say = message => { status.textContent = message; };
  let token = '', firstRunId = '', completed = null, processing = false, disposed = false, timer;
  let opener, receiverNonce, sourceOrigin = '', closeNotified = false;
  const operation = new AbortController();
  const notifyClosed = () => {
    if (disposed || closeNotified || completed?.accepted > 0 || !receiverNonce || !opener || opener !== window.opener) return;
    closeNotified = true;
    for (const origin of sourceOrigin ? [sourceOrigin] : Object.values(OFFICIAL_ORIGINS)) {
      try { opener.postMessage({ type: 'clip-fetcher:bookmark-closed', schemaVersion: 1, receiverNonce, ...(firstRunId ? { runId: firstRunId } : {}) }, origin); } catch {}
    }
  };
  const closeReceiver = () => {
    notifyClosed(); dispose();
    if (!(completed?.accepted > 0)) say('本次抓链已关闭。已交回工具的来源和下载不受影响。');
    if (closeHint) closeHint.hidden = false;
    try { window.close(); } catch { /* The visible hint also covers browser refusal without an exception. */ }
  };
  const pagehide = () => { notifyClosed(); dispose(); };
  closeButton?.addEventListener('click', closeReceiver);
  const dispose = () => {
    disposed = true; token = ''; operation.abort(); clearTimer(timer);
    window.removeEventListener('message', receive); window.removeEventListener('pagehide', pagehide);
  };
  let local;
  try {
    local = new URL(window.location.href);
    // New bookmarks bind the receiver to this capture before any message arrives.
    // Token-only fragments remain valid for bookmarks saved by earlier versions.
    const fragment = /^#([a-f0-9]{64})(?:\.([a-f0-9]{32}))?$/.exec(local.hash);
    token = fragment?.[1] || ''; firstRunId = fragment?.[2] || '';
    window.history.replaceState(null, '', local.pathname);
  } catch { say(RECEIVER_MESSAGES.LOCAL_UNAVAILABLE); return { dispose }; }
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.username || local.password || !/^(?:\?__trace_id__=[a-f0-9]{32})?$/.test(local.search) || !token) {
    token = ''; say('此收件窗口无效，请从网盘抓链书签重新打开。'); return { dispose };
  }
  opener = window.opener;
  if (!opener || typeof opener.postMessage !== 'function') {
    token = ''; say('请从网盘页面点击抓链书签打开此窗口。'); return { dispose };
  }
  try { receiverNonce = [...crypto.getRandomValues(new Uint8Array(16))].map(value => value.toString(16).padStart(2, '0')).join(''); }
  catch { token = ''; say(RECEIVER_MESSAGES.LOCAL_UNAVAILABLE); return { dispose }; }
  const ack = (target, origin, result) => {
    try { target.postMessage(result, origin); } catch { /* The source page may already have closed. */ }
  };
  async function receive(event) {
    if (disposed || event.source !== opener || event.source !== window.opener || !Object.values(OFFICIAL_ORIGINS).includes(event.origin)) return;
    const data = event.data;
    if (!data || data.type !== 'clip-fetcher:bookmark-candidates' || data.schemaVersion !== 1
        || !HEX32.test(data.runId) || data.receiverNonce !== receiverNonce) return;
    if (firstRunId && data.runId !== firstRunId) return;
    if (completed) { ack(event.source, event.origin, completed); return; }
    if (processing) return;
    firstRunId = data.runId; sourceOrigin = event.origin;
    const payload = checkedPayload(data.payload, event.origin);
    if (!payload) {
      completed = { type: 'clip-fetcher:bookmark-result', schemaVersion: 1, runId: firstRunId,
        receiverNonce, accepted: 0, code: 'INVALID_MESSAGE' };
      token = ''; ack(event.source, event.origin, completed);
      say(RECEIVER_MESSAGES.INVALID_MESSAGE); return;
    }
    processing = true; say('正在交回片段取材…');
    let expired = false, code = 'IMPORT_FAILED', accepted = 0;
    timer = setTimer(() => { expired = true; operation.abort(); }, 10000);
    try {
      // Keep the browser's Origin header on the local POST. Only the loopback
      // origin is sent as a referrer, without the receiver path or fragment.
      const response = await fetch('/api/bookmark-capture/import', { method: 'POST', mode: 'same-origin', credentials: 'omit',
        cache: 'no-store', redirect: 'error', referrerPolicy: 'origin', signal: operation.signal,
        headers: { 'Content-Type': 'application/json', 'X-Bookmark-Token': token }, body: JSON.stringify(payload) });
      const result = await response.json();
      if (response.ok && result?.ok === true && Number.isSafeInteger(result.accepted) && result.accepted >= 0
          && result.accepted <= payload.candidates.length && result.accepted <= 20) accepted = result.accepted;
    } catch { code = expired ? 'TIMEOUT' : 'LOCAL_UNAVAILABLE'; }
    finally { clearTimer(timer); processing = false; }
    if (disposed) return;
    if (expired) { accepted = 0; code = 'TIMEOUT'; }
    completed = { type: 'clip-fetcher:bookmark-result', schemaVersion: 1, runId: firstRunId, receiverNonce, accepted,
      ...(accepted > 0 ? {} : { code }) };
    token = '';
    ack(event.source, event.origin, completed);
    if (accepted > 0) {
      say('候选已交回片段取材，此窗口将自动关闭。');
      timer = setTimer(() => { if (!disposed) closeReceiver(); }, 100);
    } else say(RECEIVER_MESSAGES[code]);
  }
  window.addEventListener('message', receive); window.addEventListener('pagehide', pagehide);
  const ready = { type: 'clip-fetcher:bookmark-ready', schemaVersion: 1, receiverNonce, ...(firstRunId ? { runId: firstRunId } : {}) };
  for (const origin of Object.values(OFFICIAL_ORIGINS)) ack(opener, origin, ready);
  say('等待网盘发送候选文件…');
  return { dispose };
}
