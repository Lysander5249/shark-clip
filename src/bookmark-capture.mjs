import { randomBytes, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, link, unlink } from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';

const ROUTE = '/api/bookmark-capture/import';
const BODY_LIMIT = 64 * 1024, CONFIG_LIMIT = 1024, TTL = 30 * 60_000;
const PAGE_HOSTS = Object.freeze({ xunlei: 'pan.xunlei.com', baidu: 'pan.baidu.com' });
const ASSET = /\.(?:m3u8|mpd|m4s|ts|aac|mp3|m4a|png|jpe?g|gif|webp|avif|svg|ico|css|[cm]?js|woff2?|ttf|otf|eot|json|html?|xml|map|vtt|srt|ass|ssa|torrent)(?:$|[/?#])/i;
const own = (object, key) => Object.hasOwn(object, key) ? object[key] : undefined;
const portNumber = value => Number.isInteger(value) && value > 0 && value <= 65535;
const failure = code => Object.assign(new Error(code), { code });

function unsafeHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || /\.(?:localhost|local|internal)$/.test(host)) return true;
  if (isIP(host) === 4) {
    const [a, b, c] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && [0, 2].includes(c))
      || a === 192 && b === 88 && c === 99 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113;
  }
  if (isIP(host) === 6) return !/^[23][0-9a-f]{3}:/.test(host)
    || /^(?:2001:(?:db8|0):|2002:|3fff:)/.test(host);
  return false;
}

function httpsUrl(value, limit = 8192) {
  if (typeof value !== 'string' || !value || value.length > limit
      || /[\x00-\x20\x7f\\#]/.test(value)) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || !url.hostname
        || value.slice(value.indexOf('//') + 2).split('/')[0].includes('@') || unsafeHost(url.hostname)) return undefined;
    if (/[\x00-\x1f\x7f\\]/.test(decodeURIComponent(url.pathname))) return undefined;
    return url;
  } catch { return undefined; }
}

function officialPage(value, provider) {
  const url = httpsUrl(value, 2048);
  return url && url.hostname === PAGE_HOSTS[provider] && !url.port && !value.includes('?') ? url.href : undefined;
}

function safeName(value) {
  if (typeof value !== 'string' || /(?:https?:\/\/|blob:|data:|[?&#])/i.test(value)) return undefined;
  const name = value.replace(/[\x00-\x1f\x7f]/g, '').trim().split(/[\\/]/).pop();
  return name && name !== '.' && name !== '..' ? name.slice(0, 256) : undefined;
}

function safeHeaders(value, provider) {
  const headers = {}, seen = new Set();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return headers;
  for (const key of Object.keys(value).slice(0, 32)) {
    const lower = key.toLowerCase();
    if (lower !== 'user-agent' && lower !== 'referer') continue;
    const name = lower === 'user-agent' ? 'User-Agent' : 'Referer';
    if (seen.has(name)) { delete headers[name]; continue; }
    seen.add(name);
    const content = own(value, key);
    if (typeof content !== 'string') continue;
    if (name === 'User-Agent') {
      if (content && content.length <= 512 && /^[\x20-\x7e]+$/.test(content)) headers[name] = content;
    } else {
      const page = officialPage(content, provider);
      if (page) headers[name] = page;
    }
  }
  return headers;
}

function normalizeCandidate(value, provider, pageUrl) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const url = httpsUrl(own(value, 'url'));
  if (!url) return undefined;
  const name = safeName(own(value, 'name'));
  if (ASSET.test(decodeURIComponent(url.pathname)) || name && ASSET.test(name)) return undefined;
  const headers = safeHeaders(own(value, 'headers'), provider), size = own(value, 'size');
  return { provider, name: name || '书签捕获的媒体', sourceHost: url.hostname, url: url.href, pageUrl, headers,
    ...(Number.isSafeInteger(size) && size > 0 ? { size } : {}), hasContext: Object.keys(headers).length > 0 };
}

function publicCandidate(value) {
  return { id: value.id, provider: value.provider, name: value.name, sourceHost: value.sourceHost,
    ...(value.size === undefined ? {} : { size: value.size }), receivedAt: value.receivedAt, hasContext: value.hasContext };
}

function matches(value) {
  const url = typeof value === 'string' ? value : value?.url;
  return typeof url === 'string' && url.split(/[?#]/, 1)[0] === ROUTE;
}
function duplicate(req, name) {
  if (!Array.isArray(req.rawHeaders)) return false;
  let count = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === name && ++count > 1) return true;
  return false;
}
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer'); res.end(JSON.stringify(value));
}

function readJson(req, signal) {
  return new Promise((resolve, reject) => {
    let chunks = [], bytes = 0, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      const ignoreLateError = () => {};
      req.on('error', ignoreLateError); req.once('close', () => req.off('error', ignoreLateError));
      req.off('data', data); req.off('end', end); req.off('error', failed); req.off('aborted', aborted);
      signal.removeEventListener('abort', aborted); chunks = [];
      error ? reject(error) : resolve(value);
    };
    const rejectCode = code => finish(failure(code));
    const data = chunk => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) { req.pause(); rejectCode('BODY_TOO_LARGE'); return; }
      chunks.push(chunk);
    };
    const end = () => {
      try { finish(null, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes)))); }
      catch { rejectCode('INVALID_JSON'); }
    };
    const failed = () => rejectCode('INVALID_BODY'), aborted = () => rejectCode('REQUEST_CANCELLED');
    const timer = setTimeout(() => { req.pause(); rejectCode('BODY_TIMEOUT'); }, 10_000); timer.unref?.();
    req.on('data', data); req.once('end', end); req.once('error', failed); req.once('aborted', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    if (signal.aborted) { aborted(); return; }
    const length = req.headers['content-length'];
    if (length !== undefined && (typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) > BODY_LIMIT)) {
      req.pause(); rejectCode('BODY_TOO_LARGE');
    }
  });
}

async function readConfig(filename) {
  const file = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > CONFIG_LIMIT) throw failure('CONFIG_INVALID');
    const value = JSON.parse(await file.readFile({ encoding: 'utf8' }));
    if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1
        || Object.keys(value).sort().join(',') !== 'preferredPort,schemaVersion,token'
        || typeof value.token !== 'string' || !/^[a-f0-9]{64}$/.test(value.token) || !portNumber(value.preferredPort)) throw failure('CONFIG_INVALID');
    await file.chmod(0o600);
    return { token: value.token, preferredPort: value.preferredPort };
  } finally { await file.close(); }
}

/** Persist only the local receiver capability and its fixed port. Candidate URLs never leave RAM. */
export async function createBookmarkCapture({ dataDir, origin, onCandidates, now = Date.now, signal, providerIds = Object.keys(PAGE_HOSTS) } = {}) {
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || dataDir.includes('\0')
      || typeof origin !== 'function' || typeof now !== 'function' || onCandidates !== undefined && typeof onCandidates !== 'function') throw new TypeError('INVALID_BOOKMARK_CAPTURE_OPTIONS');
  const filename = path.join(dataDir, 'bookmark-capture.json');
  let token = randomBytes(32).toString('hex'), preferredPort = null, boundPort = null, storeFailed = false, closed = false;
  const inbox = new Map(), pending = new Set();
  try {
    await mkdir(dataDir, { recursive: true, mode: 0o700 });
    const saved = await readConfig(filename); ({ token, preferredPort } = saved);
  } catch (error) { if (error?.code !== 'ENOENT') storeFailed = true; }
  const clock = () => { const value = now(); return Number.isFinite(value) ? value : Date.now(); };
  const purge = () => { const time = clock(); for (const [id, item] of inbox) if (item.expiresAt <= time) inbox.delete(id); };
  function currentOrigin() {
    try {
      const value = origin(), url = new URL(value);
      return typeof value === 'string' && value === url.origin && url.protocol === 'http:'
        && url.hostname === '127.0.0.1' && Number(url.port) === boundPort ? url : undefined;
    } catch { return undefined; }
  }
  function state() {
    if (closed) return { available: false, message: '工具已关闭，书签接收已停止。' };
    if (storeFailed) return { available: false, message: '本机书签配置无法安全保存或读取，请检查工具数据目录的权限。' };
    if (preferredPort !== null && boundPort !== null && preferredPort !== boundPort)
      return { available: false, message: '书签原端口被占用，本次无法接收。请关闭占用后重新打开工具，原书签保留。' };
    const local = currentOrigin();
    return preferredPort !== null && preferredPort === boundPort && local
      ? { available: true, origin: local.origin }
      : { available: false, message: '正在准备本机书签接收入口。' };
  }
  async function bindPort(port) {
    if (!portNumber(port)) throw new TypeError('INVALID_BOOKMARK_CAPTURE_PORT');
    if (closed) return state();
    boundPort = port;
    if (storeFailed || preferredPort !== null) return state();
    const initialToken = token;
    const temporary = path.join(dataDir, `.bookmark-capture-${randomBytes(12).toString('hex')}.tmp`);
    let file;
    try {
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(JSON.stringify({ schemaVersion: 1, token: initialToken, preferredPort: port }) + '\n');
      await file.sync(); await file.close(); file = undefined;
      if (closed) return state();
      try { await link(temporary, filename); preferredPort = port; }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const saved = await readConfig(filename);
        if (!closed) ({ token, preferredPort } = saved);
      }
      let directory;
      try { directory = await open(dataDir, 'r'); await directory.sync(); }
      catch (error) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(error?.code)) throw error; }
      finally { await directory?.close(); }
    } catch { storeFailed = true; }
    finally { await file?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
    return state();
  }
  function config() {
    const ready = state();
    if (!ready.available) throw failure('BOOKMARK_CAPTURE_UNAVAILABLE');
    return { token, origin: ready.origin };
  }
  function listCandidates() { purge(); return [...inbox.values()].reverse().map(publicCandidate); }
  async function handle(req, res) {
    if (!matches(req)) return false;
    let controller;
    try {
      const ready = state(), local = currentOrigin();
      if (!ready.available || !local) { json(res, 503, { error: { code: 'BOOKMARK_CAPTURE_UNAVAILABLE' } }); return true; }
      const supplied = req.headers['x-bookmark-token'];
      if (req.headers.host !== local.host || req.headers.origin !== local.origin
          || req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'
          || ['host', 'origin', 'x-bookmark-token'].some(name => duplicate(req, name))
          || typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)
          || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(token, 'hex'))) {
        json(res, 403, { error: { code: 'FORBIDDEN' } }); return true;
      }
      if (req.url !== ROUTE) { json(res, 400, { error: { code: 'INVALID_ROUTE' } }); return true; }
      if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); json(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } }); return true; }
      if (typeof req.headers['content-type'] !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers['content-type'])) {
        json(res, 415, { error: { code: 'JSON_REQUIRED' } }); return true;
      }
      controller = new AbortController(); pending.add(controller);
      const payload = await readJson(req, controller.signal);
      if (closed || !state().available) { json(res, 503, { error: { code: 'BOOKMARK_CAPTURE_UNAVAILABLE' } }); return true; }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) || own(payload, 'schemaVersion') !== 1) {
        json(res, 400, { error: { code: 'INVALID_SCHEMA' } }); return true;
      }
      const provider = own(payload, 'provider');
      const pageUrl = typeof provider === 'string' && providerIds.includes(provider) && Object.hasOwn(PAGE_HOSTS, provider)
        && officialPage(own(payload, 'pageUrl'), provider);
      const candidates = own(payload, 'candidates');
      if (!pageUrl || !Array.isArray(candidates) || candidates.length > 20) {
        json(res, 400, { error: { code: 'INVALID_CANDIDATES' } }); return true;
      }
      purge();
      const accepted = new Set();
      for (const candidate of candidates) {
        const value = normalizeCandidate(candidate, provider, pageUrl);
        if (!value) continue;
        const previous = [...inbox.values()].find(item => item.provider === provider && item.url === value.url);
        const id = previous?.id || randomBytes(16).toString('hex'), time = clock();
        inbox.delete(id); inbox.set(id, { ...value, id, receivedAt: time, expiresAt: time + TTL }); accepted.add(id);
        while (inbox.size > 50) inbox.delete(inbox.keys().next().value);
      }
      if (accepted.size && onCandidates) { try { Promise.resolve(onCandidates(listCandidates())).catch(() => {}); } catch {} }
      json(res, 200, { ok: true, accepted: accepted.size }); return true;
    } catch (error) {
      const code = ['BODY_TOO_LARGE', 'INVALID_JSON', 'BODY_TIMEOUT', 'REQUEST_CANCELLED'].includes(error?.code) ? error.code : 'INVALID_BODY';
      if (!req.complete) {
        res.shouldKeepAlive = false; res.setHeader('Connection', 'close');
        res.once('finish', () => { if (!req.complete) req.destroy(); });
      }
      json(res, code === 'BODY_TOO_LARGE' ? 413 : code === 'BODY_TIMEOUT' ? 408 : 400, { error: { code } });
      return true;
    } finally { if (controller) pending.delete(controller); }
  }
  function close() {
    if (closed) return;
    closed = true; token = undefined; inbox.clear(); signal?.removeEventListener('abort', close);
    for (const controller of pending) controller.abort();
  }
  signal?.addEventListener('abort', close, { once: true }); if (signal?.aborted) close();
  return Object.freeze({ get preferredPort() { return preferredPort; }, bindPort, state, config, matches, handle, listCandidates,
    getCandidate(id) { purge(); const value = inbox.get(id); return value ? { ...publicCandidate(value),
      url: value.url, pageUrl: value.pageUrl, headers: { ...value.headers } } : undefined; },
    forget(id) { purge(); return inbox.delete(id); }, close });
}
