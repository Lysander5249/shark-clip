import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

const PAIR_PATH = '/api/browser-helper/pair';
const CANDIDATES_PATH = '/api/browser-helper/candidates';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_BATCH = 20;
const MAX_INBOX = 50;
const MAX_TTL_MS = 30 * 60_000;
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
const PAGE_HOSTS = Object.freeze({ xunlei: 'pan.xunlei.com', baidu: 'pan.baidu.com' });
const ASSET_EXTENSION = /\.(?:m3u8|mpd|m4s|ts|aac|mp3|m4a|png|jpe?g|gif|webp|avif|svg|ico|css|[cm]?js|woff2?|ttf|otf|eot|json|html?|xml|map|vtt|srt|ass|ssa|torrent)(?:$|[/?#])/i;
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;

function privateLiteral(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || /\.(?:localhost|local|internal)$/.test(host)) return true;
  if (isIP(host) === 4) {
    const [a, b, c] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2))))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113);
  }
  // Only globally routed unicast IPv6 literals are candidates. This also rejects
  // IPv4-mapped/compatible loopback and private addresses after URL normalization.
  if (isIP(host) === 6) return !/^[23][0-9a-f]{3}:/.test(host) || /^2001:db8:/.test(host);
  return false;
}

function httpsUrl(value, maxLength = 8192) {
  if (typeof value !== 'string' || !value || value.length > maxLength
      || value !== value.trim() || /[\x00-\x20\x7f\\#]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname
        || value.slice(value.indexOf('//') + 2).split('/')[0].includes('@')
        || privateLiteral(url.hostname)) return undefined;
    return url;
  } catch { return undefined; }
}

function officialPage(value, provider) {
  const url = httpsUrl(value, 2048);
  if (!url || url.hostname !== PAGE_HOSTS[provider] || url.port || value.includes('?')) return undefined;
  try {
    if (/[\x00-\x1f\x7f\\]/.test(decodeURIComponent(url.pathname))) return undefined;
  } catch { return undefined; }
  return url.href;
}

function filename(value) {
  if (typeof value !== 'string' || /(?:https?:\/\/|blob:|data:|[?&#](?:token|sign(?:ature)?|auth|key)=)/i.test(value)) return undefined;
  const name = value.replace(/[\x00-\x1f\x7f]/g, '').trim().split(/[\\/]/).pop();
  return name && name !== '.' && name !== '..' ? name.slice(0, 256) : undefined;
}

function contextHeaders(value, provider) {
  const headers = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return headers;
  const seen = new Set();
  for (const key of Object.keys(value).slice(0, 32)) {
    const lower = key.toLowerCase();
    if (lower !== 'user-agent' && lower !== 'referer') continue;
    const canonical = lower === 'user-agent' ? 'User-Agent' : 'Referer';
    if (seen.has(canonical)) { delete headers[canonical]; continue; }
    seen.add(canonical);
    const field = own(value, key);
    if (typeof field !== 'string') continue;
    if (canonical === 'User-Agent') {
      if (field && field.length <= 512 && /^[\x20-\x7e]+$/.test(field)) headers[canonical] = field;
    } else {
      const page = officialPage(field, provider);
      if (page) headers[canonical] = page;
    }
  }
  return headers;
}

function normalizeCandidate(candidate, provider, pageUrl) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return undefined;
  const url = httpsUrl(own(candidate, 'url'));
  if (!url) return undefined;
  let path;
  try { path = decodeURIComponent(url.pathname); } catch { return undefined; }
  if (/[\x00-\x1f\x7f\\]/.test(path)) return undefined;
  const name = filename(own(candidate, 'name'));
  if (ASSET_EXTENSION.test(path) || (name && ASSET_EXTENSION.test(name))) return undefined;
  const headers = contextHeaders(own(candidate, 'headers'), provider);
  const size = own(candidate, 'size');
  return { provider, name: name || '浏览器捕获的媒体', sourceHost: url.hostname,
    ...(Number.isSafeInteger(size) && size > 0 ? { size } : {}),
    hasContext: Object.keys(headers).length > 0, url: url.href, headers, pageUrl };
}

function publicCandidate(candidate) {
  return { id: candidate.id, provider: candidate.provider, name: candidate.name,
    sourceHost: candidate.sourceHost, ...(candidate.size === undefined ? {} : { size: candidate.size }),
    receivedAt: candidate.receivedAt, hasContext: candidate.hasContext };
}

function routeOf(input) {
  const raw = typeof input === 'string' ? input : input?.url;
  if (typeof raw !== 'string' || !raw.startsWith('/')) return undefined;
  const path = raw.split(/[?#]/, 1)[0];
  return path === PAIR_PATH || path === CANDIDATES_PATH ? path : undefined;
}

function duplicateHeader(req, name) {
  if (!Array.isArray(req.rawHeaders)) return false;
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === name && ++count > 1) return true;
  }
  return false;
}

function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(JSON.stringify(value));
}

function readJson(req, signal) {
  return new Promise((resolve, reject) => {
    let chunks = [], bytes = 0, settled = false;
    const fail = code => finish(Object.assign(new Error(code), { code }));
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // IncomingMessage can emit ECONNRESET after its 'aborted' event. Keep a
      // harmless listener through close after removing the active reader.
      const ignoreLateError = () => {};
      req.on('error', ignoreLateError);
      req.once('close', () => req.off('error', ignoreLateError));
      req.off('data', onData); req.off('end', onEnd); req.off('error', onError);
      req.off('aborted', onAbort); signal.removeEventListener('abort', onAbort);
      chunks = [];
      error ? reject(error) : resolve(value);
    };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) { req.pause(); fail('BODY_TOO_LARGE'); return; }
      chunks.push(chunk);
    };
    const onEnd = () => {
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes));
        finish(null, JSON.parse(text));
      } catch { fail('INVALID_JSON'); }
    };
    const onError = () => fail('INVALID_BODY');
    const onAbort = () => fail('REQUEST_CANCELLED');
    const timer = setTimeout(() => { req.pause(); fail('BODY_TIMEOUT'); }, 10_000);
    timer.unref?.();
    req.on('data', onData); req.once('end', onEnd); req.once('error', onError);
    req.once('aborted', onAbort); signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) { onAbort(); return; }
    const length = req.headers['content-length'];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_BYTES)) {
      req.pause(); fail('BODY_TOO_LARGE');
    }
  });
}

/** A session-only inbox. It never fetches a candidate or persists credentials. */
export function createBrowserHelper({ origin, signal, now = Date.now, ttlMs = MAX_TTL_MS } = {}) {
  if (typeof origin !== 'function' || typeof now !== 'function') throw new TypeError('INVALID_BROWSER_HELPER_OPTIONS');
  const lifetime = Number.isFinite(ttlMs) && ttlMs >= 1 ? Math.min(ttlMs, MAX_TTL_MS) : MAX_TTL_MS;
  let token = randomBytes(32).toString('hex'), extensionOrigin, closed = false, epoch = 0;
  const inbox = new Map(), pending = new Set();
  const clock = () => { const value = now(); return Number.isFinite(value) ? value : Date.now(); };
  const purge = () => { const time = clock(); for (const [id, item] of inbox) if (item.expiresAt <= time) inbox.delete(id); };
  function localOrigin() {
    try {
      const value = origin(), url = new URL(value);
      if (typeof value !== 'string' || value !== url.origin || !/^https?:$/.test(url.protocol)
          || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)) return undefined;
      return url;
    } catch { return undefined; }
  }
  function pairingInfo() {
    const local = localOrigin();
    if (closed || !local) throw new Error(closed ? 'BROWSER_HELPER_CLOSED' : 'BROWSER_HELPER_NOT_READY');
    return { url: `${local.origin}/browser-pair#${token}` };
  }
  function validToken(req) {
    const value = req.headers['x-browser-pairing'];
    return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)
      && token !== undefined && timingSafeEqual(Buffer.from(value, 'hex'), Buffer.from(token, 'hex'));
  }
  function allowedOrigin(req) {
    const value = req.headers.origin;
    return typeof value === 'string' && EXTENSION_ORIGIN.test(value)
      && (!extensionOrigin || value === extensionOrigin);
  }
  function cors(res, value) {
    res.setHeader('Access-Control-Allow-Origin', value);
    res.setHeader('Vary', 'Origin');
  }
  async function handle(req, res) {
    const route = routeOf(req);
    if (!route) return false;
    let bodyController;
    try {
      if (closed) { json(res, 503, { error: { code: 'BROWSER_HELPER_CLOSED' } }); return true; }
      const local = localOrigin();
      if (!local || req.headers.host !== local.host || duplicateHeader(req, 'host')
          || duplicateHeader(req, 'origin') || duplicateHeader(req, 'x-browser-pairing') || !allowedOrigin(req)) {
        json(res, 403, { error: { code: 'FORBIDDEN' } }); return true;
      }
      if (req.url !== route) { json(res, 400, { error: { code: 'INVALID_ROUTE' } }); return true; }
      if (req.method === 'OPTIONS') {
        const method = req.headers['access-control-request-method'];
        const headers = req.headers['access-control-request-headers'];
        const requested = typeof headers === 'string' ? headers.toLowerCase().split(',').map(value => value.trim()) : [];
        if (method !== 'POST' || requested.some(value => !['content-type', 'x-browser-pairing'].includes(value))) {
          json(res, 403, { error: { code: 'FORBIDDEN' } }); return true;
        }
        cors(res, req.headers.origin);
        res.statusCode = 204;
        res.setHeader('Access-Control-Allow-Methods', 'POST');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Browser-Pairing');
        res.setHeader('Cache-Control', 'no-store');
        res.end(); return true;
      }
      if (!validToken(req) || (route === CANDIDATES_PATH && !extensionOrigin)) {
        json(res, 403, { error: { code: 'FORBIDDEN' } }); return true;
      }
      cors(res, req.headers.origin);
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST, OPTIONS');
        json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } }); return true;
      }
      if (typeof req.headers['content-type'] !== 'string'
          || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) {
        json(res, 415, { error: { code: 'JSON_REQUIRED' } }); return true;
      }
      const requestEpoch = epoch;
      bodyController = new AbortController(); pending.add(bodyController);
      const payload = await readJson(req, bodyController.signal);
      if (closed || requestEpoch !== epoch || !allowedOrigin(req) || !validToken(req)) {
        json(res, 403, { error: { code: 'FORBIDDEN' } }); return true;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || own(payload, 'schemaVersion') !== 1) {
        json(res, 400, { error: { code: 'INVALID_SCHEMA' } }); return true;
      }
      if (route === PAIR_PATH) {
        extensionOrigin = req.headers.origin;
        json(res, 200, { ok: true, schemaVersion: 1, providers: ['xunlei', 'baidu'] }); return true;
      }
      const provider = own(payload, 'provider');
      const pageUrl = Object.hasOwn(PAGE_HOSTS, provider) && officialPage(own(payload, 'pageUrl'), provider);
      const candidates = own(payload, 'candidates');
      if (!pageUrl || !Array.isArray(candidates) || candidates.length > MAX_BATCH) {
        json(res, 400, { error: { code: 'INVALID_CANDIDATES' } }); return true;
      }
      purge();
      const accepted = new Set();
      for (const candidate of candidates) {
        const normalized = normalizeCandidate(candidate, provider, pageUrl);
        if (!normalized) continue;
        const existing = [...inbox.values()].find(item => item.provider === provider && item.url === normalized.url);
        const id = existing?.id || randomBytes(16).toString('hex');
        const time = clock();
        inbox.delete(id);
        inbox.set(id, { ...normalized, id, receivedAt: time, expiresAt: time + lifetime });
        accepted.add(id);
        while (inbox.size > MAX_INBOX) inbox.delete(inbox.keys().next().value);
      }
      json(res, 200, { ok: true, accepted: accepted.size }); return true;
    } catch (error) {
      // No exception text, body, source URL or header is exposed or logged.
      const code = ['BODY_TOO_LARGE', 'INVALID_JSON', 'BODY_TIMEOUT', 'REQUEST_CANCELLED'].includes(error?.code)
        ? error.code : 'INVALID_BODY';
      if (!req.complete) {
        res.shouldKeepAlive = false;
        res.setHeader('Connection', 'close');
        res.once('finish', () => { if (!req.complete) req.destroy(); });
      }
      json(res, code === 'BODY_TOO_LARGE' ? 413 : code === 'BODY_TIMEOUT' ? 408 : 400, { error: { code } });
      return true;
    } finally { if (bodyController) pending.delete(bodyController); }
  }
  function reset() {
    if (closed) throw new Error('BROWSER_HELPER_CLOSED');
    epoch++; token = randomBytes(32).toString('hex'); extensionOrigin = undefined; inbox.clear();
    for (const controller of pending) controller.abort();
    return pairingInfo();
  }
  function close() {
    if (closed) return;
    closed = true; epoch++; token = undefined; extensionOrigin = undefined; inbox.clear();
    signal?.removeEventListener('abort', close);
    for (const controller of pending) controller.abort();
  }
  signal?.addEventListener('abort', close, { once: true });
  if (signal?.aborted) close();
  return Object.freeze({ matches: input => Boolean(routeOf(input)), handle, pairingInfo,
    listCandidates() { purge(); return [...inbox.values()].reverse().map(publicCandidate); },
    getCandidate(id) { purge(); const candidate = inbox.get(id); return candidate ? { ...publicCandidate(candidate),
      url: candidate.url, headers: { ...candidate.headers }, pageUrl: candidate.pageUrl } : undefined; },
    forget(id) { purge(); return inbox.delete(id); }, reset, close });
}
