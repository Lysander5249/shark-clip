// Passive scalar observations only. Nothing here can dispatch or stop a request.
const meters = new WeakMap();
const WINDOW_MS = 5000, LIMIT = 32;
const FAILURE_CODES = new Set(['CANCELLED', 'TIMEOUT', 'SOURCE_CHANGED', 'RANGE_UNSUPPORTED',
  'RANGE_INVALID', 'AUTH_REQUIRED', 'REMOTE_HTTP', 'BUDGET_EXCEEDED', 'REDIRECT_LIMIT', 'UNSAFE_URL']);
const TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_HTTP_CONTENT_LENGTH_MISMATCH',
  'HPE_INVALID_CONSTANT', 'HPE_UNEXPECTED_CONTENT_LENGTH', 'HPE_INVALID_HEADER_TOKEN',
  'HPE_INVALID_CONTENT_LENGTH', 'HPE_INVALID_CHUNK_SIZE', 'HPE_INVALID_EOF_STATE']);
const integer = value => Number.isFinite(value) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))) : 0;
const observed = action => { try { return action(); } catch { return null; } };

export function createDirectObserver(metrics) {
  const state = { started: 0, completed: 0, failed: 0, cancelled: 0, consumerClosed: 0, wait: 0, body: 0, active: new Set(),
    lastByteAt: null, idleAt: null, rateAt: null, samples: [], records: [], dropped: 0 };
  observed(() => meters.set(metrics, state));
  return {
    start: () => observed(() => {
      const now = performance.now();
      if (state.rateAt === null || (!state.active.size && state.idleAt !== null && now - state.idleAt >= WINDOW_MS)) state.rateAt = now;
      const entry = { sequence: ++state.started, start: now, headersAt: null, verified: false,
        firstByteAt: null, lastByteAt: null, bytes: 0, httpStatus: null, transportCode: null,
        failureCode: null, terminalStage: null, cancellationReason: null, finished: false };
      state.active.add(entry); return entry;
    }),
    headers: (entry, status) => observed(() => {
      if (!entry || entry.finished) return;
      entry.headersAt ??= performance.now();
      entry.httpStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
    }),
    validated: entry => observed(() => { if (entry && !entry.finished) entry.verified = true; }),
    bytes: (entry, length) => observed(() => {
      if (!entry || entry.finished || !(length > 0)) return;
      const now = performance.now(); entry.firstByteAt ??= now; entry.lastByteAt = state.lastByteAt = now;
      entry.bytes += length;
      const at = Math.floor(now / 100) * 100, previous = state.samples.at(-1);
      if (previous?.at === at) previous.bytes += length; else state.samples.push({ at, bytes: length });
      while (state.samples.length && state.samples[0].at <= now - WINDOW_MS) state.samples.shift();
    }),
    failure: (entry, code, error, cancellationReason) => observed(() => {
      if (!entry || entry.finished) return;
      entry.transportCode ||= TRANSPORT_CODES.has(error?.code) ? error.code : null;
      if (!entry.failureCode) {
        entry.failureCode = FAILURE_CODES.has(code) ? code : null;
        entry.cancellationReason = code === 'CANCELLED' && ['consumer_closed', 'task_cancelled', 'lease_closed'].includes(cancellationReason) ? cancellationReason : null;
        entry.terminalStage = entry.headersAt === null ? 'waiting_response' : !entry.verified
          ? 'response_validation' : entry.firstByteAt === null ? 'waiting_first_data' : 'body';
      }
    }),
    finish: (entry, completed) => observed(() => {
      if (!entry || entry.finished) return;
      completed = completed && !entry.failureCode;
      const now = performance.now(); entry.finished = true;
      state.wait += (entry.headersAt ?? now) - entry.start;
      if (entry.headersAt !== null) state.body += now - entry.headersAt;
      if (completed) state.completed++; else state.failed++;
      if (!completed && entry.failureCode === 'CANCELLED') {
        state.cancelled++; if (entry.cancellationReason === 'consumer_closed') state.consumerClosed++;
      }
      state.active.delete(entry); if (!state.active.size) state.idleAt = now;
      state.records.push(Object.freeze({ sequence: integer(entry.sequence), outcome: completed ? 'completed' : 'failed',
        failureCode: completed ? null : entry.failureCode, terminalStage: completed ? 'completed' : entry.terminalStage ||
          (entry.headersAt === null ? 'waiting_response' : !entry.verified ? 'response_validation' : entry.firstByteAt === null ? 'waiting_first_data' : 'body'),
        headersReceived: entry.headersAt !== null, headersVerified: entry.verified,
        httpStatus: entry.httpStatus, transportCode: completed ? null : entry.transportCode,
        cancellationReason: completed ? null : entry.cancellationReason,
        receivedBytes: integer(entry.bytes), elapsedMs: integer(now - entry.start),
        responseWaitMs: integer((entry.headersAt ?? now) - entry.start),
        firstDataWaitMs: entry.headersAt === null ? null : integer((entry.firstByteAt ?? now) - entry.headersAt),
        bodyTransferMs: entry.firstByteAt === null ? null : integer(now - entry.firstByteAt) }));
      if (state.records.length > LIMIT) { state.records.shift(); state.dropped++; }
    }),
  };
}

export function directTelemetry(metrics) {
  return observed(() => {
    const state = meters.get(metrics); if (!state) return null;
    const now = performance.now(); let wait = state.wait, body = state.body;
    let waitingResponseRequests = 0, waitingFirstDataRequests = 0, receivingRequests = 0, waitingMoreDataRequests = 0;
    for (const entry of state.active) {
      wait += (entry.headersAt ?? now) - entry.start;
      if (entry.headersAt === null) waitingResponseRequests++;
      else {
        body += now - entry.headersAt;
        if (entry.firstByteAt === null) waitingFirstDataRequests++;
        else if (now - entry.lastByteAt < 1000) receivingRequests++;
        else waitingMoreDataRequests++;
      }
    }
    while (state.samples.length && state.samples[0].at <= now - WINDOW_MS) state.samples.shift();
    const rateElapsed = state.rateAt === null ? 0 : now - state.rateAt;
    const bytes = state.samples.reduce((n, sample) => n + sample.bytes, 0), ageAt = state.active.size ? now : state.idleAt;
    return { schemaVersion: 1, requestsStarted: integer(state.started), requestsCompleted: integer(state.completed),
      requestsFailed: integer(state.failed), activeRequests: state.active.size,
      requestsCancelled: integer(state.cancelled), requestsConsumerClosed: integer(state.consumerClosed),
      waitingResponseRequests, waitingFirstDataRequests, receivingRequests, waitingMoreDataRequests,
      responseWaitMs: integer(wait), responseBodyMs: integer(body),
      lastByteAgeMs: state.lastByteAt === null || ageAt === null ? null : integer(ageAt - state.lastByteAt),
      state: !state.active.size ? 'idle' : receivingRequests ? 'receiving' : waitingFirstDataRequests || waitingMoreDataRequests ? 'waiting_data' : 'waiting_response',
      currentBytesPerSecond: state.active.size && rateElapsed >= 1000 ? integer(bytes * 1000 / Math.min(WINDOW_MS, rateElapsed)) : null };
  });
}

/** One record per physical HTTP request, including each redirect hop. */
export function directReadTimings(metrics) {
  return observed(() => {
    const state = meters.get(metrics); if (!state) return null;
    return { schemaVersion: 1, limit: LIMIT, requestsRecorded: state.records.length,
      droppedRequests: integer(state.dropped), requests: state.records.map(item => ({ ...item })).sort((a, b) => a.sequence - b.sequence) };
  });
}
