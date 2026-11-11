import http from 'node:http';
import https from 'node:https';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { checkedDirectUrl as publicSourceUrl, directLookup } from './direct-stream.mjs';
const publicSourceLookup = directLookup();

const CHUNK = 1024 * 1024;
export class RemoteError extends Error {
  constructor(code, message) { super(message); this.name = 'RemoteError'; this.code = code; }
}
const fail = (code, message) => new RemoteError(code, message);
const fingerprint = b => createHash('sha256').update(b).digest('hex');
const READ_PHASES = Object.freeze({ head: '文件头检查', middle: '文件中段检查', tail: '文件尾检查', recheck: '来源复核', media: '媒体读取' });
const TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_HTTP_CONTENT_LENGTH_MISMATCH']);
const transportCode = error => TRANSPORT_CODES.has(error?.code) ? error.code : null;
const boundedInteger = (value, max = Number.MAX_SAFE_INTEGER) => Number.isFinite(value) ? Math.max(0, Math.min(max, Math.trunc(value))) : 0;

const telemetryMeters = new WeakMap();
const RATE_WINDOW_MS = 5000;
const READ_TIMING_LIMIT = 32;
const READ_TIMING_FAILURE_CODES = new Set(['CANCELLED', 'TIMEOUT', 'SOURCE_CHANGED', 'RANGE_UNSUPPORTED',
  'RANGE_INVALID', 'AUTH_REQUIRED', 'REMOTE_HTTP', 'BUDGET_EXCEEDED', 'RESUME_WRITE_FAILED']);
function telemetryStart(metrics) {
  try {
    const state = telemetryMeters.get(metrics);
    if (!state) return null;
    const now = performance.now();
    if (state.rateStartedAt === null || (!state.active.size && state.lastIdleAt !== null && now - state.lastIdleAt >= RATE_WINDOW_MS)) state.rateStartedAt = now;
    const request = { state, sequence: state.requestsStarted + 1, startedAt: now,
      headersAt: null, headersVerified: false, firstByteAt: null, lastByteAt: null,
      receivedBytes: 0, failureCode: null, terminalStage: null, finished: false };
    state.requestsStarted++;
    state.active.add(request);
    return request;
  } catch { return null; }
}
function telemetryHeaders(request) {
  try { if (request && !request.finished && request.headersAt === null) request.headersAt = performance.now(); } catch { /* Telemetry never changes a transfer. */ }
}
function telemetryValidated(request) {
  try { if (request && !request.finished) request.headersVerified = true; } catch { /* Observation only. */ }
}
function telemetryFailure(request, code) {
  try {
    if (!request || request.finished) return;
    request.failureCode = READ_TIMING_FAILURE_CODES.has(code) ? code : null;
    request.terminalStage = request.headersAt === null ? 'waiting_response'
      : !request.headersVerified ? 'response_validation'
        : request.firstByteAt === null ? 'waiting_first_data' : 'body';
  } catch { /* Observation only. */ }
}
function telemetryBytes(request, length) {
  try {
    if (!request || request.finished || !(length > 0)) return;
    const now = performance.now(), state = request.state;
    if (request.firstByteAt === null) request.firstByteAt = now;
    request.receivedBytes += length;
    request.lastByteAt = state.lastByteAt = now;
    const bucketAt = Math.floor(now / 100) * 100;
    const previous = state.samples.at(-1);
    if (previous?.at === bucketAt) previous.bytes += length;
    else state.samples.push({ at: bucketAt, bytes: length });
    while (state.samples.length && state.samples[0].at <= now - RATE_WINDOW_MS) state.samples.shift();
  } catch { /* Telemetry never changes a transfer. */ }
}
function telemetryFinish(request, completed) {
  try {
    if (!request || request.finished) return;
    const now = performance.now(), state = request.state;
    request.finished = true;
    state.responseWaitMs += (request.headersAt ?? now) - request.startedAt;
    if (request.headersAt !== null) state.responseBodyMs += now - request.headersAt;
    if (completed) state.requestsCompleted++; else state.requestsFailed++;
    state.active.delete(request);
    if (!state.active.size) state.lastIdleAt = now;
    // Keep only scalar observations. Never retain request, response, header,
    // source, media or credential objects in the bounded completed-read ring.
    state.readTimings.push(Object.freeze({
      sequence: boundedInteger(request.sequence), outcome: completed ? 'completed' : 'failed',
      failureCode: completed ? null : request.failureCode,
      terminalStage: completed ? 'completed' : request.terminalStage || (request.headersAt === null
        ? 'waiting_response' : !request.headersVerified ? 'response_validation'
          : request.firstByteAt === null ? 'waiting_first_data' : 'body'),
      headersReceived: request.headersAt !== null, headersVerified: request.headersVerified,
      receivedBytes: boundedInteger(request.receivedBytes), elapsedMs: boundedInteger(now - request.startedAt),
      responseWaitMs: boundedInteger((request.headersAt ?? now) - request.startedAt),
      firstDataWaitMs: request.headersAt === null ? null : boundedInteger((request.firstByteAt ?? now) - request.headersAt),
      bodyTransferMs: request.firstByteAt === null ? null : boundedInteger(now - request.firstByteAt),
    }));
    if (state.readTimings.length > READ_TIMING_LIMIT) { state.readTimings.shift(); state.droppedReadTimings++; }
  } catch { /* Telemetry never changes a transfer. */ }
}

/** A fresh, nonpersistent numeric snapshot. It never exposes request objects. */
export function remoteTelemetry(metrics) {
  try {
    const state = telemetryMeters.get(metrics);
    if (!state) return null;
    const now = performance.now();
    let wait = state.responseWaitMs, body = state.responseBodyMs, receiving = false, hasHeaders = false;
    let waitingResponseRequests = 0, waitingFirstDataRequests = 0, receivingRequests = 0, waitingMoreDataRequests = 0;
    for (const request of state.active) {
      wait += (request.headersAt ?? now) - request.startedAt;
      if (request.headersAt === null) waitingResponseRequests++;
      else if (request.firstByteAt === null) waitingFirstDataRequests++;
      else if (now - request.lastByteAt < 1000) receivingRequests++;
      else waitingMoreDataRequests++;
      if (request.headersAt !== null) {
        hasHeaders = true; body += now - request.headersAt;
        if (request.lastByteAt !== null && now - request.lastByteAt < 1000) receiving = true;
      }
    }
    while (state.samples.length && state.samples[0].at <= now - RATE_WINDOW_MS) state.samples.shift();
    const rateElapsed = state.rateStartedAt === null ? 0 : now - state.rateStartedAt;
    const bytes = state.samples.reduce((total, sample) => total + sample.bytes, 0);
    const ageAt = state.active.size ? now : state.lastIdleAt;
    return {
      schemaVersion: 1,
      requestsStarted: boundedInteger(state.requestsStarted), requestsCompleted: boundedInteger(state.requestsCompleted),
      requestsFailed: boundedInteger(state.requestsFailed), activeRequests: state.active.size,
      waitingResponseRequests, waitingFirstDataRequests, receivingRequests, waitingMoreDataRequests,
      responseWaitMs: boundedInteger(wait), responseBodyMs: boundedInteger(body),
      lastByteAgeMs: state.lastByteAt === null || ageAt === null ? null : boundedInteger(ageAt - state.lastByteAt),
      state: !state.active.size ? 'idle' : receiving ? 'receiving' : hasHeaders ? 'waiting_data' : 'waiting_response',
      currentBytesPerSecond: state.active.size && rateElapsed >= 1000
        ? boundedInteger(bytes * 1000 / Math.min(RATE_WINDOW_MS, rateElapsed)) : null,
    };
  } catch { return null; }
}

/**
 * A private copy of at most 32 settled Range read-attempt observations, matching
 * metrics.requests. A redirect chain is one attempt, not multiple HTTP records;
 * it belongs to that attempt's wait for final response headers. Durations include
 * local processing and waits; they do not measure the cloud's upstream network.
 * When no body arrived, firstDataWaitMs ends at termination. In validation
 * failures that interval is validation time, not proof of waiting for data.
 */
export function remoteReadTimings(metrics) {
  try {
    const state = telemetryMeters.get(metrics);
    if (!state) return null;
    return { schemaVersion: 1, limit: READ_TIMING_LIMIT, requestsRecorded: state.readTimings.length,
      droppedRequests: boundedInteger(state.droppedReadTimings),
      requests: state.readTimings.map(record => ({ ...record })).sort((a, b) => a.sequence - b.sequence) };
  } catch { return null; }
}

function readDiagnostic(phase, start, expected, received, startedAt, state) {
  // Only fixed labels, bounded numbers and known transport codes may leave this module.
  return Object.freeze({
    phase: Object.hasOwn(READ_PHASES, phase) ? phase : 'media',
    offset: boundedInteger(start), expectedBytes: boundedInteger(expected), receivedBytes: boundedInteger(received),
    elapsedMs: boundedInteger(Date.now() - startedAt, 24 * 60 * 60 * 1000), timedOut: state.timedOut === true,
    ...(TRANSPORT_CODES.has(state.transportCode) ? { transportCode: state.transportCode } : {}),
  });
}

function readFailureMessage(phase, reason, received, expected) {
  return `${READ_PHASES[phase] || READ_PHASES.media}失败：${reason}，已收到 ${boundedInteger(received)} / ${boundedInteger(expected)} 字节。`;
}

const previousRequestEnds = new WeakMap();
// Recovery state is private: diagnostics/API responses never contain media
// buffers. A prefix is retained only after the full strict Range header checks.
const recoverableReadErrors = new WeakSet();
const partialReadPrefixes = new WeakMap();
const BODY_INTERRUPTION_CODES = new Set(['ECONNRESET', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_HTTP_CONTENT_LENGTH_MISMATCH']);

function recoveryDelay(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = error => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolve();
    };
    const abort = () => finish(fail('CANCELLED', '读取已取消。'));
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => finish(), milliseconds);
    timer.unref?.();
  });
}

function meter(limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) throw fail('BUDGET_INVALID', '读取预算必须大于零。');
  const metrics = {
    budgetBytes: limit, receivedBytes: 0, reservedBytes: 0, requests: 0, upstreamBytes: null,
    positioning: { firstOffset: null, lastOffset: null, maxOffset: null, seekCount: 0 },
  };
  try {
    telemetryMeters.set(metrics, { requestsStarted: 0, requestsCompleted: 0, requestsFailed: 0, responseWaitMs: 0, responseBodyMs: 0,
      active: new Set(), lastByteAt: null, lastIdleAt: null, rateStartedAt: null, samples: [], readTimings: [], droppedReadTimings: 0 });
  } catch { /* Metrics creation remains available even if telemetry cannot start. */ }
  return metrics;
}

function traceRequest(m, start, end) {
  // Offsets describe bounded upstream request starts in dispatch order, not
  // downloaded byte coverage. No source address or request headers are retained.
  const positioning = m.positioning;
  const previousEnd = previousRequestEnds.get(m);
  if (positioning.firstOffset === null) positioning.firstOffset = start;
  if (previousEnd !== undefined && start !== previousEnd + 1) {
    positioning.seekCount = boundedInteger(positioning.seekCount + 1);
  }
  positioning.lastOffset = start;
  positioning.maxOffset = Math.max(positioning.maxOffset ?? start, start);
  previousRequestEnds.set(m, end);
}

function open(url, headers, signal, active, state, requestTimeoutMs, hops = 0, networkPolicy = 'default') {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(fail('CANCELLED', '读取已取消。'));
    if (hops > 5) return reject(fail('REMOTE_HTTP', '远程重定向次数过多。'));
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method: 'GET', headers, signal, timeout: requestTimeoutMs,
      ...(networkPolicy === 'public-https' ? { lookup: publicSourceLookup, agent: false } : {}) }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const location = res.headers.location;
        res.destroy();
        if (!location) return reject(fail('REMOTE_HTTP', '远程重定向没有目标。'));
        let next;
        try { next = new URL(location, url); } catch { return reject(fail('REMOTE_HTTP', '重定向地址无效。')); }
        if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password || (url.protocol === 'https:' && next.protocol !== 'https:')) {
          return reject(fail('REMOTE_HTTP', '拒绝不安全的远程重定向。'));
        }
        if (networkPolicy === 'public-https') {
          try { publicSourceUrl(next.href); } catch { return reject(fail('SOURCE_NETWORK_INVALID', '浏览器来源重定向到了不允许访问的地址。')); }
        }
        const nextHeaders = { ...headers };
        if (next.origin !== url.origin) delete nextHeaders.Authorization;
        resolve(open(next, nextHeaders, signal, active, state, requestTimeoutMs, hops + 1, networkPolicy));
      } else resolve(res);
    });
    active.add(req);
    req.once('close', () => active.delete(req));
    req.once('timeout', () => {
      // The response promise may already be resolved; retain timeout identity for its body reader.
      state.timedOut = true;
      req.destroy(fail('TIMEOUT', '远程连接空闲超时。'));
    });
    req.once('error', e => {
      state.transportCode = transportCode(e) || state.transportCode;
      reject(e.name === 'AbortError' ? fail('CANCELLED', '读取已取消。') : e instanceof RemoteError ? e : fail('REMOTE_HTTP', '远程连接失败，请检查服务和访问权限。'));
    });
    req.end();
  });
}

export async function createRemoteSource({ url: value, username = '', password = '', requestHeaders = {}, networkPolicy = 'default', budgetBytes = 64 * CHUNK, signal, requestTimeoutMs = 30000, initialRanges = 'separated' } = {}) {
  if (!['default', 'public-https'].includes(networkPolicy)) throw fail('SOURCE_NETWORK_INVALID', '来源网络限制无效。');
  if (!['separated', 'head'].includes(initialRanges)) throw fail('INITIAL_RANGES_INVALID', '来源检查模式无效。');
  // A bounded transport override is reserved for local test fixtures, not exposed by the server/UI.
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 25 || requestTimeoutMs > 30000) throw fail('TIMEOUT_INVALID', '远程空闲超时设置无效。');
  let url;
  try { url = new URL(value); } catch { throw fail('SOURCE_INVALID', '请输入原文件的 HTTP 或 WebDAV 文件地址。'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw fail('SOURCE_INVALID', '只接受 HTTP / HTTPS 原文件地址。');
  if (url.username || url.password) throw fail('SOURCE_INVALID', '请在单独的用户名和密码栏填写凭据，不要放入链接。');
  if (networkPolicy === 'public-https') publicSourceUrl(url.href);
  const headers = { 'Accept-Encoding': 'identity', 'User-Agent': 'ClipFetcher/0.1' };
  if (!requestHeaders || typeof requestHeaders !== 'object' || Array.isArray(requestHeaders)
      || Object.keys(requestHeaders).length > 2) throw fail('SOURCE_HEADERS_INVALID', '原文件请求信息无效。');
  const suppliedHeaderNames = new Set();
  for (const [key, contents] of Object.entries(requestHeaders)) {
    const name = { 'user-agent': 'User-Agent', referer: 'Referer' }[key.toLowerCase()];
    if (!name || suppliedHeaderNames.has(name) || typeof contents !== 'string' || !contents || contents.length > 8192 || /[^\x20-\x7e]/.test(contents))
      throw fail('SOURCE_HEADERS_INVALID', '原文件请求信息无效。');
    suppliedHeaderNames.add(name);
    headers[name] = contents;
  }
  if (username || password) headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const metrics = meter(budgetBytes);
  let size = null, validator = null, firstFingerprint = null;

  async function slice(start, wantedEnd, m, readSignal, active, phase, allowRecovery = false, persistent) {
    const startedAt = Date.now();
    const state = { timedOut: false, transportCode: null };
    let res, reservation = 0, remainingReservation = 0, expected = 0, length = 0, telemetryRequest, completed = false;
    let headersVerified = false, bodyInterrupted = false, durableTicket;
    const chunks = [];
    try {
      if (readSignal?.aborted) throw fail('CANCELLED', '读取已取消。');
      const end = size === null ? wantedEnd : Math.min(wantedEnd, size - 1);
      reservation = end - start + 1;
      expected = reservation;
      if (reservation < 1) throw fail('RANGE_INVALID', '请求区间超出文件范围。');
      if (m.receivedBytes + m.reservedBytes + reservation > m.budgetBytes) throw fail('BUDGET_EXCEEDED', '已达到本工具的读取预算，任务已停止。');
      m.reservedBytes += reservation;
      remainingReservation = reservation;
      // Persist the maximum possible new bytes before dispatch. If the process
      // dies during a response, reopening conservatively charges this range.
      if (persistent?.accounting) {
        try { durableTicket = await persistent.accounting.reserve(reservation); }
        catch (e) { throw fail(e.code === 'BUDGET_EXCEEDED' ? 'BUDGET_EXCEEDED' : 'RESUME_WRITE_FAILED',
          e.code === 'BUDGET_EXCEEDED' ? '本任务的累计读取预算已用完，续传缓存仍保留。' : '无法保存续传预算记录，请检查磁盘空间和目录权限。'); }
      }
      if (readSignal?.aborted) throw fail('CANCELLED', '读取已取消。');
      m.requests++;
      const h = { ...headers, Range: `bytes=${start}-${end}` };
      if (validator?.etag && !validator.etag.startsWith('W/')) h['If-Match'] = validator.etag;
      traceRequest(m, start, end);
      telemetryRequest = telemetryStart(m);
      res = await open(url, h, readSignal, active, state, requestTimeoutMs, 0, networkPolicy);
      telemetryHeaders(telemetryRequest);
      if (res.statusCode === 412) throw fail('SOURCE_CHANGED', '远程文件版本已经改变，请重新检查来源。');
      if (res.statusCode === 200) throw fail('RANGE_UNSUPPORTED', '服务没有按区间返回数据；已停止，避免读取整片。');
      if ([401, 403].includes(res.statusCode)) throw fail('AUTH_REQUIRED', '原文件访问授权失效，请检查连接和凭据。');
      if (res.statusCode !== 206) throw fail('REMOTE_HTTP', `原文件读取失败（HTTP ${res.statusCode}）。`);
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(res.headers['content-range'] || '');
      if (!match) throw fail('RANGE_INVALID', '服务返回的 Content-Range 不正确。');
      const [, a, b, n] = match.map(Number);
      const actualEnd = Math.min(end, n - 1);
      if (![a, b, n].every(Number.isSafeInteger) || a !== start || b !== actualEnd || n < 1 || (size !== null && n !== size)) {
        throw fail(size !== null && n !== size ? 'SOURCE_CHANGED' : 'RANGE_INVALID', '服务返回的文件范围或文件大小不一致。');
      }
      expected = b - a + 1;
      if (res.headers['content-encoding'] && res.headers['content-encoding'] !== 'identity') throw fail('RANGE_INVALID', '不能对压缩后的 HTTP 响应可靠定位。');
      if (res.headers['content-length'] !== undefined && Number(res.headers['content-length']) !== expected) throw fail('RANGE_INVALID', '服务返回的数据长度与范围不一致。');
      const current = { etag: res.headers.etag || null, lastModified: res.headers['last-modified'] || null };
      if (persistent?.requireStrongValidator && (!session.resumeIdentity || current.etag !== validator.etag)) {
        throw fail('SOURCE_CHANGED', '来源未返回一致的文件版本标识，已停止续传。');
      }
      if (validator && ((validator.etag && current.etag && validator.etag !== current.etag) || (validator.lastModified && current.lastModified && validator.lastModified !== current.lastModified))) {
        throw fail('SOURCE_CHANGED', '远程文件版本已经改变，请重新检查来源。');
      }
      if (size === null) { size = n; validator = current; }
      headersVerified = true;
      telemetryValidated(telemetryRequest);
      try {
        for await (const data of res) {
          length += data.length;
          m.receivedBytes += data.length;
          // The in-memory meter reserves only bytes still to arrive. Moving
          // each accepted byte out of its own reservation keeps concurrent
          // responses from charging it twice. Durable reservations deliberately
          // remain whole until settlement, preserving conservative crash fees.
          const receivedReservation = Math.min(remainingReservation, data.length);
          remainingReservation -= receivedReservation;
          m.reservedBytes -= receivedReservation;
          telemetryBytes(telemetryRequest, data.length);
          if (length > expected || m.receivedBytes + m.reservedBytes > m.budgetBytes) throw fail('RANGE_INVALID', '服务返回了超过请求范围的数据。');
          chunks.push(data);
        }
      } catch (e) {
        if (e instanceof RemoteError) throw e;
        state.transportCode = transportCode(e) || state.transportCode;
        bodyInterrupted = BODY_INTERRUPTION_CODES.has(state.transportCode);
        throw fail(readSignal?.aborted ? 'CANCELLED' : state.timedOut ? 'TIMEOUT' : 'RANGE_INVALID', readSignal?.aborted ? '读取已取消。' : readFailureMessage(phase, state.timedOut ? '上游连接空闲超时' : '上游连接中断，分段响应未完整返回', length, expected));
      }
      if (length !== expected) throw fail('RANGE_INVALID', readFailureMessage(phase, '分段响应长度不足', length, expected));
      const result = Buffer.concat(chunks, length);
      completed = true;
      return result;
    } catch (e) {
      const failure = e instanceof RemoteError ? e : fail('REMOTE_HTTP', '受控分段读取失败。');
      telemetryFailure(telemetryRequest, failure.code);
      state.transportCode = transportCode(e) || state.transportCode;
      if (failure.code === 'TIMEOUT') {
        state.timedOut = true;
        failure.message = readFailureMessage(phase, '上游连接空闲超时', length, expected);
      } else if (!failure.message.startsWith(`${READ_PHASES[phase] || READ_PHASES.media}失败：`)) {
        failure.message = readFailureMessage(phase, failure.message.replace(/[。！]$/, ''), length, expected);
      }
      failure.diagnostic = readDiagnostic(phase, start, expected, length, startedAt, state);
      // A clean but short response, an invalid header, an overlong body, an
      // authorization/version/budget error, and cancellation are never retried.
      // Before headers only a socket TIMEOUT can be retried from the same byte.
      if (allowRecovery && !readSignal?.aborted && length < expected
          && (failure.code === 'TIMEOUT' || (headersVerified && bodyInterrupted))) {
        recoverableReadErrors.add(failure);
        if (headersVerified && length > 0) partialReadPrefixes.set(failure, Buffer.concat(chunks, length));
      }
      throw failure;
    } finally {
      m.reservedBytes -= remainingReservation;
      res?.destroy();
      telemetryFinish(telemetryRequest, completed);
      if (durableTicket !== undefined && durableTicket !== null) {
        try { await persistent.accounting.settle(durableTicket, length); }
        catch { throw fail('RESUME_WRITE_FAILED', '无法结算续传预算记录，任务已停止。未确认的请求将按保守用量计入。'); }
      }
    }
  }

  const initialActive = new Set();
  const first = await slice(0, 16383, metrics, signal, initialActive, 'head');
  firstFingerprint = fingerprint(first.subarray(0, Math.min(first.length, 128)));
  // Head-only bootstrap verifies Range response semantics and source identity at
  // the entry point. Every subsequently needed index/media read is still fully
  // checked by slice(); an unrelated midpoint is not a prerequisite for it.
  if (initialRanges === 'separated') {
    if (size > 32768) await slice(Math.floor(size / 2), Math.min(size - 1, Math.floor(size / 2) + 16383), metrics, signal, initialActive, 'middle');
    if (size > 16384) await slice(Math.max(0, size - 16384), size - 1, metrics, signal, initialActive, 'tail');
  }

  let label;
  try { label = decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || '远程视频'); } catch { label = '远程视频'; }
  label = label.replace(/[\u0000-\u001f]/g, '').slice(0, 160);
  const session = {
    id: randomUUID(), size, label, validator, metrics, initialRanges,
    resumeIdentity: typeof validator?.etag === 'string' && /^"[\x21\x23-\x7e\x80-\xff]*"$/.test(validator.etag)
      ? Object.freeze({ size, etagSha256: fingerprint(Buffer.from(validator.etag)), headSha256: fingerprint(first) }) : null,
    async check(checkSignal) {
      const data = await slice(0, Math.min(size - 1, 127), metrics, checkSignal, new Set(), 'recheck');
      if (fingerprint(data) !== firstFingerprint) throw fail('SOURCE_CHANGED', '原文件内容已改变，请重新检查来源。');
      return true;
    },
    createLease({ budgetBytes: limit = 2048 * CHUNK, signal: leaseSignal, serveChunkBytes = CHUNK, readChunkBytes = CHUNK, accounting, requireStrongValidator = false } = {}) {
      if (accounting !== undefined && (!accounting || typeof accounting.reserve !== 'function' || typeof accounting.settle !== 'function')) throw fail('READ_OPTIONS_INVALID', '续传预算记录配置无效。');
      if (requireStrongValidator && !session.resumeIdentity) throw fail('RESUME_IDENTITY_UNAVAILABLE', '来源没有可核对的强版本标识，无法安全续传。');
      const persistent = { accounting, requireStrongValidator };
      if (!Number.isSafeInteger(serveChunkBytes) || serveChunkBytes < 1024 || serveChunkBytes > CHUNK) throw fail('SERVE_CHUNK_INVALID', '媒体转发分段大小无效。');
      // Opt in only for callers that already have a bounded contiguous target
      // range. Bootstrap checks and forwarded media retain independent limits.
      if (![CHUNK, 2 * CHUNK, 4 * CHUNK].includes(readChunkBytes)) throw fail('READ_CHUNK_INVALID', '直接读取分段大小无效。');
      const own = new AbortController();
      const combined = leaseSignal ? AbortSignal.any([own.signal, leaseSignal]) : own.signal;
      const active = new Set();
      const pending = new Set();
      const m = meter(limit);
      const lease = {
        metrics: m, error: null,
        read(start, length, readSignal, options) {
          const operation = (async () => {
            if (options !== undefined && (!options || typeof options !== 'object' || Array.isArray(options))) throw fail('READ_OPTIONS_INVALID', '分段读取重试配置无效。');
            const { maxAttempts = 1, onRetry } = options || {};
            if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3
                || (onRetry !== undefined && typeof onRetry !== 'function')) throw fail('READ_OPTIONS_INVALID', '分段读取重试配置无效。');
            if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 1 || length > 4 * CHUNK || start + length > size) throw fail('RANGE_INVALID', '索引读取范围无效。');
            const parts = [];
            try {
              const currentSignal = readSignal ? AbortSignal.any([combined, readSignal]) : combined;
              for (let p = start; p < start + length; p += readChunkBytes) {
                const end = Math.min(start + length - 1, p + readChunkBytes - 1), chunkParts = [];
                let cursor = p, attempt = 1;
                while (cursor <= end) {
                  try {
                    chunkParts.push(await slice(cursor, end, m, currentSignal, active, 'media', maxAttempts > 1, persistent));
                    cursor = end + 1;
                  } catch (failure) {
                    const prefix = partialReadPrefixes.get(failure);
                    partialReadPrefixes.delete(failure);
                    const recoverable = recoverableReadErrors.has(failure);
                    recoverableReadErrors.delete(failure);
                    if (currentSignal.aborted || attempt >= maxAttempts || !recoverable) throw failure;
                    if (prefix) { chunkParts.push(prefix); cursor += prefix.length; }
                    const delayMs = attempt === 1 ? 250 : 1000;
                    attempt++;
                    if (onRetry) {
                      const event = Object.freeze({ attempt, maxAttempts, remainingBytes: end - cursor + 1, receivedBytes: cursor - p, delayMs });
                      try { Promise.resolve(onRetry(event)).catch(() => {}); } catch { /* UI callbacks cannot change recovery or cleanup. */ }
                    }
                    await recoveryDelay(delayMs, currentSignal);
                  }
                }
                parts.push(Buffer.concat(chunkParts, end - p + 1));
              }
              return Buffer.concat(parts, length);
            } catch (e) { lease.error ||= e; throw e; }
          })();
          pending.add(operation);
          operation.then(() => pending.delete(operation), () => pending.delete(operation));
          return operation;
        },
        close() { own.abort(); for (const req of active) req.destroy(); active.clear(); },
        async settle() {
          lease.close();
          await Promise.allSettled([...pending]);
        },
        serve(req, res) {
          const operation = serveRequest(req, res);
          pending.add(operation);
          operation.then(() => pending.delete(operation), () => pending.delete(operation));
          return operation;
        },
      };
      async function serveRequest(req, res) {
          if (own.signal.aborted) { res.writeHead(410); res.end(); return; }
          if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
          let start = 0, end = size - 1;
          const range = req.headers.range;
          if (range) {
            const match = /^bytes=(\d+)-(\d*)$/.exec(range);
            if (!match) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
            start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
            if (!Number.isSafeInteger(start) || start < 0 || start > end || start >= size) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }); res.end(); return; }
          }
          const responseHeaders = { 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1), 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' };
          if (range) responseHeaders['Content-Range'] = `bytes ${start}-${end}/${size}`;
          if (req.method === 'HEAD') { res.writeHead(range ? 206 : 200, responseHeaders); res.end(); return; }
          const clientAbort = new AbortController();
          const streamSignal = AbortSignal.any([combined, clientAbort.signal]);
          const close = () => { if (!res.writableFinished) clientAbort.abort(); };
          res.once('close', close);
          try {
            let position = start;
            while (position <= end && !streamSignal.aborted && !res.destroyed) {
              const remainingBudget = m.budgetBytes - m.receivedBytes - m.reservedBytes;
              if (remainingBudget < 1) {
                const failure = fail('BUDGET_EXCEEDED', '已达到本工具的读取预算，任务已停止。');
                failure.diagnostic = readDiagnostic('media', position, 0, 0, Date.now(), { timedOut: false });
                throw failure;
              }
              const part = await slice(position, Math.min(end, position + serveChunkBytes - 1, position + remainingBudget - 1), m, streamSignal, active, 'media', false, persistent);
              if (streamSignal.aborted || res.destroyed) break;
              if (!res.headersSent) res.writeHead(range ? 206 : 200, responseHeaders);
              position += part.length;
              if (!res.write(part)) await new Promise(resolve => {
                function done() {
                  res.removeListener('drain', done); res.removeListener('close', done);
                  streamSignal.removeEventListener('abort', done); resolve();
                }
                res.once('drain', done); res.once('close', done);
                streamSignal.addEventListener('abort', done, { once: true });
                if (streamSignal.aborted) done();
              });
            }
            if (!res.destroyed) res.end();
          } catch (e) {
            if (!clientAbort.signal.aborted) lease.error = e instanceof RemoteError ? e : fail('REMOTE_HTTP', '受控分段读取失败。');
            if (!res.headersSent && !res.destroyed) { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(lease.error?.message || '读取已取消'); }
            else res.destroy();
          } finally { res.removeListener('close', close); }
      }
      return lease;
    }
  };
  return session;
}
