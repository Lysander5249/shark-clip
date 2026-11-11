import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { createDirectObserver } from './direct-stream-telemetry.mjs';

const MiB = 1024 * 1024;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const ALLOWED_HEADERS = new Set(['user-agent', 'referer', 'accept']);
const MESSAGES = Object.freeze({
  OPTIONS_INVALID: '流式读取参数无效。',
  UNSAFE_URL: '来源地址不安全，已停止读取。',
  HEADERS_INVALID: '来源请求头无效，已停止读取。',
  STRONG_ETAG_REQUIRED: '此来源缺少可核对的强文件版本，请使用原有读取方式。',
  RANGE_INVALID: '来源返回的文件区间或长度不一致，已停止读取。',
  RANGE_UNSUPPORTED: '来源没有返回指定区间，已停止以避免读取整片。',
  SOURCE_CHANGED: '来源文件版本发生变化，已停止读取。',
  BUDGET_EXCEEDED: '已达到本工具的读取预算，任务已停止。',
  AUTH_REQUIRED: '来源访问已失效，请重新选择文件。',
  REDIRECT_LIMIT: '来源重定向次数过多，已停止读取。',
  REMOTE_HTTP: '来源连接或读取失败，请重新选择文件后重试。',
  TIMEOUT: '来源读取超时，已停止。',
  CANCELLED: '读取已取消。',
});

export class DirectStreamError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'REMOTE_HTTP';
    super(MESSAGES[safeCode]);
    this.name = 'DirectStreamError'; this.code = safeCode;
  }
}
const fail = code => new DirectStreamError(code);
const hostText = hostname => hostname.toLowerCase().replace(/^\[|\]$/g, '');
const loopback = address => address === '127.0.0.1' || address === '::1';
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
const specialV6 = new BlockList();
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  specialV6.addSubnet(address, prefix, 'ipv6');
}

function publicAddress(value) {
  const address = hostText(value), family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254
      || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && [0, 2].includes(c))
      || a === 192 && b === 88 && c === 99
      || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
      || a === 203 && b === 0 && c === 113);
  }
  if (family !== 6) return false;
  try { return globalV6.check(address, 'ipv6') && !specialV6.check(address, 'ipv6'); }
  catch { return false; }
}

/** Validate a destination without resolving it. directLookup also validates every socket's DNS answers. */
export function checkedDirectUrl(value, { allowLoopbackHttp = false } = {}) {
  if (typeof value !== 'string' || !value || value.length > 32768 || /[\u0000-\u0020\u007f]/.test(value)) throw fail('UNSAFE_URL');
  let url;
  try { url = new URL(value); } catch { throw fail('UNSAFE_URL'); }
  const host = hostText(url.hostname), exception = allowLoopbackHttp === true && loopback(host);
  if (!host || url.username || url.password || url.hash
      || url.protocol !== 'https:' && !(exception && url.protocol === 'http:')
      || host === 'localhost' || host.endsWith('.localhost')
      || isIP(host) && !publicAddress(host) && !exception) throw fail('UNSAFE_URL');
  return url;
}

/** Reject mixed public/private DNS answers and pin the socket to an approved address. */
export function directLookup({ allowLoopbackHttp = false, lookup = dnsLookup } = {}) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const host = hostText(hostname), literal = isIP(host);
    const complete = records => {
      if (!Array.isArray(records) || !records.length || records.some(record => !record
          || typeof record.address !== 'string' || !isIP(record.address) || record.family !== isIP(record.address)
          || !publicAddress(record.address) && !(literal && allowLoopbackHttp === true && loopback(host)))) {
        callback(fail('UNSAFE_URL')); return;
      }
      const family = typeof options === 'number' ? options : options?.family;
      const selected = family === 4 || family === 6 ? records.filter(record => record.family === family) : records;
      if (!selected.length) { callback(fail('REMOTE_HTTP')); return; }
      if (options?.all) callback(null, selected.map(({ address, family }) => ({ address, family })));
      else callback(null, selected[0].address, selected[0].family);
    };
    if (literal) { complete([{ address: host, family: literal }]); return; }
    if (host === 'localhost' || host.endsWith('.localhost')) { callback(fail('UNSAFE_URL')); return; }
    try {
      lookup(host, { all: true, verbatim: true }, (error, records) => {
        if (error) callback(fail('REMOTE_HTTP')); else complete(records);
      });
    } catch { callback(fail('REMOTE_HTTP')); }
  };
}

function checkedHeaders(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail('HEADERS_INVALID');
  const result = {};
  for (const [name, content] of Object.entries(value)) {
    const key = name.toLowerCase();
    if (!ALLOWED_HEADERS.has(key) || Object.hasOwn(result, key) || typeof content !== 'string'
        || !content || content.length > 8192 || /[^\x20-\x7e\x80-\xff]/.test(content)) throw fail('HEADERS_INVALID');
    if (key === 'referer') {
      let referer;
      try { referer = new URL(content); } catch { throw fail('HEADERS_INVALID'); }
      if (referer.protocol !== 'https:' || referer.username || referer.password || referer.hash) throw fail('HEADERS_INVALID');
    }
    result[key] = content;
  }
  return result;
}

function parseRange(value, size) {
  if (typeof value !== 'string') return null;
  const match = /^bytes=(\d+)-(\d*)$/.exec(value);
  if (!match) return null;
  const start = Number(match[1]), end = match[2] ? Number(match[2]) : size - 1;
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 0 && start <= end && end < size
    ? { start, end } : null;
}

function validateResponse(response, start, end, size, etag) {
  if ([401, 403].includes(response.statusCode)) throw fail('AUTH_REQUIRED');
  if (response.statusCode === 412) throw fail('SOURCE_CHANGED');
  if (response.statusCode === 200) throw fail('RANGE_UNSUPPORTED');
  if (response.statusCode !== 206) throw fail('REMOTE_HTTP');
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers['content-range'] || '');
  const length = response.headers['content-length'], encoding = response.headers['content-encoding'];
  if (!match || match.slice(1).some(value => !Number.isSafeInteger(Number(value)))
      || Number(match[1]) !== start || Number(match[2]) !== end || Number(match[3]) !== size
      || typeof length !== 'string' || !/^\d+$/.test(length) || Number(length) !== end - start + 1
      || response.headers['transfer-encoding'] || encoding !== undefined && encoding.toLowerCase() !== 'identity') throw fail('RANGE_INVALID');
  if (response.headers.etag !== etag) throw fail('SOURCE_CHANGED');
}

function waitForDrain(response, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.removeListener('drain', onDrain); response.removeListener('close', onAbort);
      signal.removeEventListener('abort', onAbort);
    };
    const onDrain = () => { cleanup(); resolve(); };
    const onAbort = () => { cleanup(); reject(fail('CANCELLED')); };
    response.once('drain', onDrain); response.once('close', onAbort);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted || response.destroyed) onAbort();
  });
}

/**
 * A private, non-caching FFmpeg source. Every upstream request is a bounded Range;
 * bytes flow immediately after header checks. The caller owns the random local URL.
 * No URL, credentials, raw network errors or upstream headers enter public metrics.
 */
export function createDirectStream({ url: value, headers = {}, size, etag, budgetBytes, signal,
  allowLoopbackHttp = false, windowBytes = 8 * MiB, requestTimeoutMs = 30000 } = {}) {
  if (![size, budgetBytes, windowBytes, requestTimeoutMs].every(Number.isSafeInteger)
      || size < 1 || budgetBytes < 1 || windowBytes < 1 || windowBytes > 8 * MiB
      || requestTimeoutMs < 1 || requestTimeoutMs > 300000
      || typeof allowLoopbackHttp !== 'boolean' || signal !== undefined && !(signal instanceof AbortSignal)) throw fail('OPTIONS_INVALID');
  let sourceUrl = checkedDirectUrl(value, { allowLoopbackHttp }), sourceHeaders = checkedHeaders(headers);
  if (typeof etag !== 'string' || etag.length > 4096 || !/^"[\x21\x23-\x7e\x80-\xff]*"$/.test(etag)) throw fail('STRONG_ETAG_REQUIRED');
  const own = new AbortController(), combined = signal ? AbortSignal.any([own.signal, signal]) : own.signal;
  const cancellationReason = () => signal?.aborted ? 'task_cancelled' : combined.aborted ? 'lease_closed' : 'consumer_closed';
  const metrics = { budgetBytes, receivedBytes: 0, reservedBytes: 0, requests: 0, upstreamBytes: null };
  const observer = createDirectObserver(metrics);
  const pending = new Set(), active = new Map();
  const lookup = directLookup({ allowLoopbackHttp });
  const agentOptions = { keepAlive: true, maxSockets: 2, maxTotalSockets: 2, maxFreeSockets: 2, lookup };
  const httpAgent = new http.Agent(agentOptions), httpsAgent = new https.Agent(agentOptions);
  let firstError = null, readers = 0;

  function close() {
    own.abort();
    for (const request of active.keys()) request.destroy();
    httpAgent.destroy(); httpsAgent.destroy();
    sourceUrl = null; sourceHeaders = {};
  }
  function fatal(error) {
    firstError ||= error instanceof DirectStreamError ? error : fail('REMOTE_HTTP');
    close(); return firstError;
  }
  const lease = {
    metrics,
    get error() { return firstError; },
    close,
    async settle() {
      close();
      while (pending.size) await Promise.allSettled([...pending]);
      while (active.size) await Promise.allSettled([...active.values()]);
    },
    serve(req, res) {
      const operation = serveRequest(req, res);
      pending.add(operation);
      operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    },
  };

  function exchange(url, selectedHeaders, start, end, operationSignal) {
    return new Promise((resolve, reject) => {
      if (operationSignal.aborted) { reject(fail('CANCELLED')); return; }
      const transport = url.protocol === 'https:' ? https : http;
      let request, observation, timer, timedOut = false, responseDelivered = false, expectedClose = false;
      try {
        request = transport.request(url, {
          method: 'GET', agent: url.protocol === 'https:' ? httpsAgent : httpAgent, signal: operationSignal,
          headers: { 'user-agent': 'ClipFetcher-DirectStream/1', accept: 'application/octet-stream', ...selectedHeaders,
            'accept-encoding': 'identity', range: `bytes=${start}-${end}`, 'if-match': etag },
        });
        const closed = new Promise(done => request.once('close', done));
        active.set(request, closed); metrics.requests++; observation = observer.start();
        request.once('close', () => { clearTimeout(timer); active.delete(request); });
        request.once('response', response => {
          clearTimeout(timer); responseDelivered = true;
          observer.headers(observation, response.statusCode);
          resolve({ request, response, closed, observation, timedOut: () => timedOut, expectClose: () => { expectedClose = true; } });
        });
        request.once('error', error => {
          const failure = operationSignal.aborted ? fail('CANCELLED') : timedOut ? fail('TIMEOUT')
            : error instanceof DirectStreamError ? error : fail('REMOTE_HTTP');
          if (!expectedClose || operationSignal.aborted) observer.failure(observation, failure.code, error,
            operationSignal.aborted ? cancellationReason() : null);
          if (!responseDelivered) observer.finish(observation, false);
          // Parser/socket errors can arrive after response headers (including an
          // overlong fixed-length message); a resolved headers promise must not
          // discard those errors. Our own rejected-body cleanup is intentional.
          if (responseDelivered && !expectedClose && !operationSignal.aborted) fatal(failure);
          reject(failure);
        });
        const timeout = () => { timedOut = true; request.destroy(fail('TIMEOUT')); };
        timer = setTimeout(timeout, requestTimeoutMs); timer.unref?.();
        request.setTimeout(requestTimeoutMs, timeout);
        request.end();
      } catch (error) {
        observer.failure(observation, 'REMOTE_HTTP', error); observer.finish(observation, false);
        request?.destroy(); reject(fail('REMOTE_HTTP'));
      }
    });
  }

  async function openWindow(start, end, operationSignal) {
    let current = sourceUrl, selectedHeaders = sourceHeaders;
    for (let hops = 0; ; hops++) {
      if (operationSignal.aborted || !current) throw fail('CANCELLED');
      const opened = await exchange(current, selectedHeaders, start, end, operationSignal);
      const { response, closed } = opened;
      if (!REDIRECTS.has(response.statusCode)) return opened;
      const location = response.headers.location;
      opened.expectClose(); response.destroy(); await closed;
      try {
        if (hops >= 3) throw fail('REDIRECT_LIMIT');
        if (typeof location !== 'string' || !location) throw fail('UNSAFE_URL');
        let next;
        try { next = checkedDirectUrl(new URL(location, current).href, { allowLoopbackHttp }); }
        catch { throw fail('UNSAFE_URL'); }
        if (current.protocol === 'https:' && next.protocol !== 'https:') throw fail('UNSAFE_URL');
        if (next.origin !== current.origin) { selectedHeaders = { ...selectedHeaders }; delete selectedHeaders.referer; }
        current = next;
        observer.validated(opened.observation); observer.finish(opened.observation, true);
      } catch (error) {
        observer.failure(opened.observation, error.code, error); observer.finish(opened.observation, false); throw error;
      }
    }
  }

  async function forwardWindow(start, end, response, responseHeaders, operationSignal) {
    const expected = end - start + 1;
    if (expected > metrics.budgetBytes - metrics.receivedBytes - metrics.reservedBytes) throw fail('BUDGET_EXCEEDED');
    metrics.reservedBytes += expected;
    let remaining = expected, received = 0, opened, completed = false;
    try {
      opened = await openWindow(start, end, operationSignal);
      validateResponse(opened.response, start, end, size, etag);
      observer.validated(opened.observation);
      if (operationSignal.aborted) throw fail('CANCELLED');
      if (!response.headersSent) response.writeHead(206, responseHeaders);
      for await (const chunk of opened.response) {
        metrics.receivedBytes += chunk.length; received += chunk.length;
        observer.bytes(opened.observation, chunk.length);
        const charged = Math.min(remaining, chunk.length); remaining -= charged; metrics.reservedBytes -= charged;
        if (received > expected || metrics.receivedBytes > metrics.budgetBytes) throw fail('RANGE_INVALID');
        if (operationSignal.aborted || response.destroyed) throw fail('CANCELLED');
        if (!response.write(chunk)) await waitForDrain(response, operationSignal);
      }
      if (received !== expected || !opened.response.complete) throw fail('RANGE_INVALID');
      completed = true;
    } catch (error) {
      const failure = operationSignal.aborted ? fail('CANCELLED') : opened?.timedOut() ? fail('TIMEOUT')
        : error instanceof DirectStreamError ? error : fail('REMOTE_HTTP');
      observer.failure(opened?.observation, failure.code, error,
        operationSignal.aborted ? cancellationReason() : null);
      throw failure;
    } finally {
      metrics.reservedBytes -= remaining;
      if (opened) {
        // complete means the HTTP parser received the message, even if its body
        // is still unread. A rejected buffered response must also close now.
        if (!opened.response.readableEnded) { opened.expectClose(); opened.response.destroy(); }
        await opened.closed;
        observer.finish(opened.observation, completed);
      }
    }
  }

  async function serveRequest(req, res) {
    if (combined.aborted) { res.writeHead(410); res.end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const range = req.method === 'HEAD' && req.headers.range === undefined ? { start: 0, end: size - 1 } : parseRange(req.headers.range, size);
    if (!range) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
    const responseHeaders = { 'Accept-Ranges': 'bytes', 'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`, ETag: etag,
      'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' };
    if (req.method === 'HEAD') {
      if (req.headers.range === undefined) delete responseHeaders['Content-Range'];
      res.writeHead(req.headers.range === undefined ? 200 : 206, responseHeaders); res.end(); return;
    }
    if (readers >= 2) { res.writeHead(503, { 'Retry-After': '1' }); res.end(); return; }
    if (req.aborted || res.destroyed) return;
    readers++;
    const client = new AbortController(), operationSignal = AbortSignal.any([combined, client.signal]);
    const onClose = () => { if (!res.writableFinished) client.abort(); };
    const onAborted = () => client.abort();
    res.once('close', onClose); req.once('aborted', onAborted);
    try {
      let position = range.start;
      while (position <= range.end) {
        if (operationSignal.aborted) throw fail('CANCELLED');
        const available = metrics.budgetBytes - metrics.receivedBytes - metrics.reservedBytes;
        if (available < 1) throw fail('BUDGET_EXCEEDED');
        const end = position + Math.min(windowBytes, range.end - position + 1, available) - 1;
        await forwardWindow(position, end, res, responseHeaders, operationSignal);
        position = end + 1;
      }
      if (!res.destroyed) res.end();
    } catch (error) {
      const cancelled = operationSignal.aborted;
      const failure = cancelled ? fail('CANCELLED') : fatal(error);
      if (!res.destroyed && !res.headersSent) {
        res.writeHead(cancelled ? 410 : 502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(failure.message);
      } else if (!res.destroyed) res.destroy();
    } finally {
      res.removeListener('close', onClose); req.removeListener('aborted', onAborted); readers--;
    }
  }
  return lease;
}
