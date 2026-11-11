const MAX_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_COUNT = 1_000_000_000;
const STAGES = ['checking', 'positioning', 'fetch', 'probe', 'extract', 'validate', 'compatible', 'other'];
const STATES = new Set(['idle', 'waiting_response', 'receiving', 'waiting_data']);
const STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const READ_TIMING_LIMIT = 32;
const READ_STAGES = new Set(['waiting_response', 'response_validation', 'waiting_first_data', 'body']);
const READ_FAILURES = new Set(['CANCELLED', 'TIMEOUT', 'SOURCE_CHANGED', 'RANGE_UNSUPPORTED', 'RANGE_INVALID',
  'AUTH_REQUIRED', 'REMOTE_HTTP', 'BUDGET_EXCEEDED', 'RESUME_WRITE_FAILED', 'REDIRECT_LIMIT', 'UNSAFE_URL']);
const TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_HTTP_CONTENT_LENGTH_MISMATCH',
  'HPE_INVALID_CONSTANT', 'HPE_UNEXPECTED_CONTENT_LENGTH', 'HPE_INVALID_HEADER_TOKEN',
  'HPE_INVALID_CONTENT_LENGTH', 'HPE_INVALID_CHUNK_SIZE', 'HPE_INVALID_EOF_STATE']);
const REQUEST_CLASSES = ['waitingResponseRequests', 'waitingFirstDataRequests', 'receivingRequests', 'waitingMoreDataRequests'];
const bounded = (value, limit = MAX_MS) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(limit, Math.floor(value)) : 0;
const record = value => value && typeof value === 'object' && !Array.isArray(value);

// Request/response objects, ranges, URLs, headers and errors must never enter this
// ring. Every exported value is rebuilt from measurements and fixed enums.
export function sanitizeReadTimings(value) {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.requests)) return null;
  const requests = [];
  const seen = new Set();
  for (const item of value.requests.slice(-READ_TIMING_LIMIT)) {
    if (!record(item) || !Number.isSafeInteger(item.sequence) || item.sequence < 1 || item.sequence > MAX_COUNT
        || !['completed', 'failed'].includes(item.outcome) || seen.has(item.sequence)) continue;
    seen.add(item.sequence);
    const headersReceived = item.headersReceived === true;
    const headersVerified = headersReceived && item.headersVerified === true;
    const receivedBytes = bounded(item.receivedBytes, 65536 * 1024 * 1024);
    const elapsedMs = bounded(item.elapsedMs);
    const responseWaitMs = Math.min(elapsedMs, bounded(item.responseWaitMs));
    const firstDataWaitMs = headersReceived ? Math.min(elapsedMs - responseWaitMs, bounded(item.firstDataWaitMs)) : null;
    const bodyTransferMs = receivedBytes > 0 ? Math.min(elapsedMs - responseWaitMs - (firstDataWaitMs ?? 0), bounded(item.bodyTransferMs)) : null;
    const completed = item.outcome === 'completed';
    requests.push({ sequence: item.sequence, outcome: item.outcome,
      failureCode: !completed && READ_FAILURES.has(item.failureCode) ? item.failureCode : null,
      terminalStage: completed ? 'completed' : READ_STAGES.has(item.terminalStage) ? item.terminalStage
        : !headersReceived ? 'waiting_response' : !headersVerified ? 'response_validation' : receivedBytes > 0 ? 'body' : 'waiting_first_data',
      ...(Object.hasOwn(item, 'httpStatus') ? { httpStatus: Number.isInteger(item.httpStatus) && item.httpStatus >= 100 && item.httpStatus <= 599 ? item.httpStatus : null } : {}),
      ...(Object.hasOwn(item, 'transportCode') ? { transportCode: !completed && TRANSPORT_CODES.has(item.transportCode) ? item.transportCode : null } : {}),
      ...(Object.hasOwn(item, 'cancellationReason') ? { cancellationReason: !completed && item.failureCode === 'CANCELLED' && ['consumer_closed', 'task_cancelled', 'lease_closed'].includes(item.cancellationReason) ? item.cancellationReason : null } : {}),
      headersReceived, headersVerified, receivedBytes, elapsedMs, responseWaitMs, firstDataWaitMs, bodyTransferMs });
  }
  requests.sort((a, b) => a.sequence - b.sequence);
  return { schemaVersion: 1, limit: READ_TIMING_LIMIT, requestsRecorded: requests.length,
    droppedRequests: bounded(bounded(value.droppedRequests, MAX_COUNT) + Math.max(0, value.requests.length - READ_TIMING_LIMIT), MAX_COUNT), requests };
}

// Only fixed enums and bounded measurements may enter history or support reports.
export function sanitizeTransferTelemetry(value, { terminal = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const speed = value.currentBytesPerSecond;
  const readTimings = sanitizeReadTimings(value.readTimings);
  return {
    schemaVersion: 1,
    requestsStarted: bounded(value.requestsStarted, MAX_COUNT),
    requestsCompleted: bounded(value.requestsCompleted, MAX_COUNT),
    requestsFailed: bounded(value.requestsFailed, MAX_COUNT),
    ...(Object.hasOwn(value, 'requestsCancelled') ? { requestsCancelled: Math.min(bounded(value.requestsFailed, MAX_COUNT), bounded(value.requestsCancelled, MAX_COUNT)),
      requestsConsumerClosed: Math.min(bounded(value.requestsFailed, MAX_COUNT), bounded(value.requestsCancelled, MAX_COUNT), bounded(value.requestsConsumerClosed, MAX_COUNT)) } : {}),
    activeRequests: terminal ? 0 : bounded(value.activeRequests, 1024),
    responseWaitMs: bounded(value.responseWaitMs),
    responseBodyMs: bounded(value.responseBodyMs),
    lastByteAgeMs: value.lastByteAgeMs === null || value.lastByteAgeMs === undefined ? null : bounded(value.lastByteAgeMs),
    state: terminal ? 'idle' : STATES.has(value.state) ? value.state : 'idle',
    currentBytesPerSecond: !terminal && typeof speed === 'number' && Number.isFinite(speed) && speed >= 0 ? Math.min(speed, 1024 ** 4) : null,
    ...Object.fromEntries(REQUEST_CLASSES.filter(key => Object.hasOwn(value, key)).map(key => [key, terminal ? 0 : bounded(value[key], 1024)])),
    ...(readTimings ? { readTimings } : {}),
  };
}

/** Normalize saved diagnostics; there are no URLs, paths, labels or errors here. */
export function sanitizeTaskDiagnostics(value, { terminal = false } = {}) {
  if (!value || typeof value !== 'object' || value.schemaVersion !== 1 || Array.isArray(value)) return null;
  const status = STATUSES.has(value.status) ? value.status : 'queued';
  return {
    schemaVersion: 1,
    sourceKind: value.sourceKind === 'remote' ? 'remote' : 'local',
    elapsedMs: bounded(value.elapsedMs),
    stages: Object.fromEntries(STAGES.map(stage => [stage, bounded(value.stages?.[stage])])),
    transfer: sanitizeTransferTelemetry(value.transfer, { terminal: terminal || TERMINAL.has(status) }),
    recoveryAttempts: bounded(value.recoveryAttempts, 1_000_000),
    status,
    ...(value.sourceKind === 'remote' && value.indexCache && typeof value.indexCache.enabled === 'boolean'
      ? { indexCache: { enabled: value.indexCache.enabled,
        hitBytes: bounded(value.indexCache.hitBytes, 64 * 1024 * 1024),
        hitReads: bounded(value.indexCache.hitReads, MAX_COUNT) } } : {}),
  };
}

/** Passive observations: polling and progress callbacks cannot extend timeouts. */
export function createTaskDiagnostics({ now = () => performance.now(), sourceKind = 'local' } = {}) {
  let highWater = 0;
  function clock() {
    let value;
    try { value = now(); } catch { return highWater; }
    if (typeof value === 'number' && Number.isFinite(value) && value >= highWater) highWater = value;
    return highWater;
  }
  const started = clock(), stages = Object.fromEntries(STAGES.map(stage => [stage, 0]));
  let current = null, enteredAt = started, finishedAt = null;
  return Object.freeze({
    enter(stage) {
      if (finishedAt !== null) return;
      const next = stage === 'queued' ? null : STAGES.includes(stage) ? stage : 'other';
      if (next === current) return;
      const time = clock();
      if (current) stages[current] = Math.min(MAX_MS, stages[current] + time - enteredAt);
      current = next; enteredAt = time;
    },
    snapshot({ status = 'running', transfer = null, recoveryAttempts = 0, indexCache } = {}) {
      const time = finishedAt ?? clock();
      const measured = { ...stages };
      if (current && finishedAt === null) measured[current] += time - enteredAt;
      return sanitizeTaskDiagnostics({ schemaVersion: 1, sourceKind, elapsedMs: time - started,
        stages: measured, transfer, recoveryAttempts, status, indexCache });
    },
    finish() {
      if (finishedAt !== null) return;
      finishedAt = clock();
      if (current) stages[current] = Math.min(MAX_MS, stages[current] + finishedAt - enteredAt);
    },
  });
}

/** Sequential leases (e.g. positioning, then gateway extraction) share one job. */
export function mergeTransferTelemetry(previous, active) {
  const first = sanitizeTransferTelemetry(previous), last = sanitizeTransferTelemetry(active);
  if (!first) return last;
  if (!last) return first;
  const earlier = first.readTimings, later = last.readTimings;
  let readTimings;
  if (earlier || later) {
    const requests = [...(earlier?.requests || []), ...(later?.requests || []).map(item => ({
      ...item, sequence: item.sequence + first.requestsStarted,
    }))];
    readTimings = { schemaVersion: 1, requests,
      droppedRequests: (earlier?.droppedRequests || 0) + (later?.droppedRequests || 0) };
  }
  return sanitizeTransferTelemetry({
    requestsStarted: first.requestsStarted + last.requestsStarted,
    requestsCompleted: first.requestsCompleted + last.requestsCompleted,
    requestsFailed: first.requestsFailed + last.requestsFailed,
    ...(Object.hasOwn(first, 'requestsCancelled') || Object.hasOwn(last, 'requestsCancelled') ? {
      requestsCancelled: (first.requestsCancelled || 0) + (last.requestsCancelled || 0),
      requestsConsumerClosed: (first.requestsConsumerClosed || 0) + (last.requestsConsumerClosed || 0),
    } : {}),
    activeRequests: last.activeRequests,
    responseWaitMs: first.responseWaitMs + last.responseWaitMs,
    responseBodyMs: first.responseBodyMs + last.responseBodyMs,
    lastByteAgeMs: last.lastByteAgeMs,
    state: last.state,
    currentBytesPerSecond: last.currentBytesPerSecond,
    ...Object.fromEntries(REQUEST_CLASSES.filter(key => Object.hasOwn(first, key) || Object.hasOwn(last, key)).map(key => [key, last[key] || 0])),
    ...(readTimings ? { readTimings } : {}),
  });
}
