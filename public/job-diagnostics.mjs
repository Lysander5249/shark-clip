const STATUSES = new Set(['queued', 'running', 'completed', 'failed', 'cancelled']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const STAGES = Object.freeze({ checking: '来源复核', positioning: '索引定位', fetch: '目标读取', probe: '本地检查', extract: '原码裁切', validate: '输出核验', compatible: 'MP4 派生', other: '其他' });
const READ_STATES = Object.freeze({ idle: '当前无读取请求', waiting_response: '等待上游响应', receiving: '正在接收数据', waiting_data: '等待更多数据' });
const LOCAL_STAGES = new Set(['probe', 'extract', 'validate', 'compatible']);
const count = value => Number.isSafeInteger(value) && value >= 0;
const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
const record = value => value && typeof value === 'object' && !Array.isArray(value);
const READ_TIMING_LIMIT = 32;
const READ_TIMING_MAX_MS = 7 * 24 * 60 * 60 * 1000;
const READ_FAILURES = new Set(['CANCELLED', 'TIMEOUT', 'SOURCE_CHANGED', 'RANGE_UNSUPPORTED', 'RANGE_INVALID',
  'AUTH_REQUIRED', 'REMOTE_HTTP', 'BUDGET_EXCEEDED', 'RESUME_WRITE_FAILED', 'REDIRECT_LIMIT', 'UNSAFE_URL']);
const TRANSPORT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'EPIPE', 'ETIMEDOUT',
  'ENOTFOUND', 'EAI_AGAIN', 'ERR_STREAM_PREMATURE_CLOSE', 'ERR_HTTP_CONTENT_LENGTH_MISMATCH',
  'HPE_INVALID_CONSTANT', 'HPE_UNEXPECTED_CONTENT_LENGTH', 'HPE_INVALID_HEADER_TOKEN',
  'HPE_INVALID_CONTENT_LENGTH', 'HPE_INVALID_CHUNK_SIZE', 'HPE_INVALID_EOF_STATE']);
const READ_STAGES = new Set(['waiting_response', 'response_validation', 'waiting_first_data', 'body']);
const REQUEST_CLASSES = ['waitingResponseRequests', 'waitingFirstDataRequests', 'receivingRequests', 'waitingMoreDataRequests'];
const boundedReadValue = (value, limit = READ_TIMING_MAX_MS) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(limit, Math.floor(value)) : 0;

// Revalidate the bounded server ring before display or clipboard export. This
// whitelist intentionally accepts no request objects, URLs, headers or errors.
function sanitizeReadTimings(value) {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.requests)) return null;
  const requests = [], seen = new Set();
  for (const item of value.requests.slice(-READ_TIMING_LIMIT)) {
    if (!record(item) || !Number.isSafeInteger(item.sequence) || item.sequence < 1 || item.sequence > 1_000_000_000
        || !['completed', 'failed'].includes(item.outcome) || seen.has(item.sequence)) continue;
    seen.add(item.sequence);
    const headersReceived = item.headersReceived === true, headersVerified = headersReceived && item.headersVerified === true;
    const receivedBytes = boundedReadValue(item.receivedBytes, 65536 * 1024 * 1024);
    const elapsedMs = boundedReadValue(item.elapsedMs);
    const responseWaitMs = Math.min(elapsedMs, boundedReadValue(item.responseWaitMs));
    const firstDataWaitMs = headersReceived ? Math.min(elapsedMs - responseWaitMs, boundedReadValue(item.firstDataWaitMs)) : null;
    const bodyTransferMs = receivedBytes > 0 ? Math.min(elapsedMs - responseWaitMs - (firstDataWaitMs ?? 0), boundedReadValue(item.bodyTransferMs)) : null;
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
    droppedRequests: boundedReadValue(boundedReadValue(value.droppedRequests, 1_000_000_000) + Math.max(0, value.requests.length - READ_TIMING_LIMIT), 1_000_000_000), requests };
}

// Rebuild each object from known fields. Never serialize the job, its source,
// error message or output result, even when a future server adds extra fields.
export function sanitizeJobDiagnostics(value) {
  if (!record(value) || value.schemaVersion !== 1 || !STATUSES.has(value.status) || !amount(value.elapsedMs)) return null;
  const stages = {};
  for (const key of Object.keys(STAGES)) if (amount(value.stages?.[key])) stages[key] = value.stages[key];
  const result = { schemaVersion: 1, elapsedMs: value.elapsedMs, stages, transfer: null,
    recoveryAttempts: count(value.recoveryAttempts) ? value.recoveryAttempts : 0, status: value.status };
  if (['local', 'remote'].includes(value.sourceKind)) result.sourceKind = value.sourceKind;
  if (value.sourceKind === 'remote' && record(value.indexCache) && typeof value.indexCache.enabled === 'boolean')
    result.indexCache = { enabled: value.indexCache.enabled,
      hitBytes: count(value.indexCache.hitBytes) && value.indexCache.hitBytes <= 64 * 1024 * 1024 ? value.indexCache.hitBytes : 0,
      hitReads: count(value.indexCache.hitReads) && value.indexCache.hitReads <= 1_000_000_000 ? value.indexCache.hitReads : 0 };
  const transfer = value.transfer;
  if (value.sourceKind !== 'local' && record(transfer) && typeof transfer.state === 'string' && Object.hasOwn(READ_STATES, transfer.state)
      && (transfer.schemaVersion === undefined || transfer.schemaVersion === 1)) {
    const safe = { state: transfer.state };
    if (transfer.schemaVersion === 1) safe.schemaVersion = 1;
    for (const key of ['requestsStarted', 'requestsCompleted', 'requestsFailed', 'activeRequests']) {
      if (count(transfer[key])) safe[key] = transfer[key];
    }
    if (Object.hasOwn(transfer, 'requestsCancelled')) {
      safe.requestsCancelled = Math.min(boundedReadValue(transfer.requestsFailed, 1_000_000_000), boundedReadValue(transfer.requestsCancelled, 1_000_000_000));
      safe.requestsConsumerClosed = Math.min(safe.requestsCancelled, boundedReadValue(transfer.requestsConsumerClosed, 1_000_000_000));
    }
    for (const key of ['responseWaitMs', 'responseBodyMs']) if (amount(transfer[key])) safe[key] = transfer[key];
    safe.lastByteAgeMs = amount(transfer.lastByteAgeMs) ? transfer.lastByteAgeMs : null;
    safe.currentBytesPerSecond = value.status === 'running' && amount(transfer.currentBytesPerSecond) ? transfer.currentBytesPerSecond : null;
    if (TERMINAL_STATUSES.has(value.status)) { safe.activeRequests = 0; safe.state = 'idle'; }
    for (const key of REQUEST_CLASSES) {
      if (Object.hasOwn(transfer, key)) safe[key] = TERMINAL_STATUSES.has(value.status) ? 0 : boundedReadValue(transfer[key], 1024);
    }
    const readTimings = sanitizeReadTimings(transfer.readTimings);
    if (readTimings) safe.readTimings = readTimings;
    result.transfer = safe;
  }
  return result;
}

export function createDiagnosticReport(job, { version } = {}) {
  const diagnostics = sanitizeJobDiagnostics(job?.diagnostics);
  if (!diagnostics) return null;
  const status = STATUSES.has(job.status) ? job.status : diagnostics.status;
  if (status !== 'running' && diagnostics.transfer) diagnostics.transfer.currentBytesPerSecond = null;
  if (TERMINAL_STATUSES.has(status) && diagnostics.transfer) {
    diagnostics.transfer.activeRequests = 0; diagnostics.transfer.state = 'idle';
    for (const key of REQUEST_CLASSES) if (Object.hasOwn(diagnostics.transfer, key)) diagnostics.transfer[key] = 0;
  }
  const metrics = {};
  for (const key of ['budgetBytes', 'receivedBytes', 'requests']) if (count(job.metrics?.[key])) metrics[key] = job.metrics[key];
  if (job.metrics?.upstreamBytes === null || count(job.metrics?.upstreamBytes)) metrics.upstreamBytes = job.metrics.upstreamBytes;
  const report = { schemaVersion: 1, type: 'clip-fetcher-job-diagnostics',
    appVersion: typeof version === 'string' && /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) && version.length <= 60 ? version : null,
    jobId: typeof job.id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(job.id) ? job.id : null,
    status, stage: typeof job.stage === 'string' && (Object.hasOwn(STAGES, job.stage) || STATUSES.has(job.stage)) ? job.stage : 'other', metrics, diagnostics };
  if (['standard', 'continuous', 'parallel'].includes(job.readMode)) report.readMode = job.readMode;
  if (typeof job.error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(job.error.code)) {
    report.error = { code: job.error.code };
    if (typeof job.error.stage === 'string' && Object.hasOwn(STAGES, job.error.stage)) report.error.stage = job.error.stage;
  }
  return report;
}

export function formatDiagnosticDuration(milliseconds) {
  if (!amount(milliseconds)) return '未知';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`;
  const seconds = Math.round(milliseconds / 1000);
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60), rest = seconds % 60;
  if (minutes < 60) return `${minutes} 分 ${rest} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分 ${rest} 秒`;
}

function speedLabel(value) {
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s', 'TiB/s'];
  let unit = 0, speed = value;
  while (speed >= 1024 && unit < units.length - 1) { speed /= 1024; unit++; }
  return `${speed.toFixed(unit ? 2 : 0)} ${units[unit]}`;
}

export function formatJobDiagnostics(job) {
  const data = sanitizeJobDiagnostics(job?.diagnostics);
  if (!data) return null;
  const status = STATUSES.has(job.status) ? job.status : data.status;
  const local = data.sourceKind === 'local' || job.type === 'compatible';
  const transfer = local ? null : data.transfer;
  let summary;
  if (status === 'queued') summary = '等待开始 · 暂无当前接收速度';
  else if (status !== 'running') summary = transfer ? '网络读取已结束' : '本次处理已结束';
  else if (local) summary = '本地处理 · 当前不读取云端数据';
  else if (data.sourceKind === 'remote' && LOCAL_STAGES.has(job.stage) && transfer?.activeRequests === 0) summary = '媒体处理中 · 当前无读取请求';
  else if (!transfer) summary = '读取状态与接收速度暂不可用';
  else {
    const speed = transfer.currentBytesPerSecond === null ? '待测' : speedLabel(transfer.currentBytesPerSecond);
    summary = `本工具近 5 秒接收：${speed} · ${READ_STATES[transfer.state]}`;
    if (transfer.state === 'waiting_data' && transfer.lastByteAgeMs !== null) summary += `（距上次接收 ${formatDiagnosticDuration(transfer.lastByteAgeMs)}）`;
  }
  const requests = [];
  if (count(transfer?.requestsCompleted) && count(transfer?.requestsStarted)) requests.push(`已完成 ${transfer.requestsCompleted}/${transfer.requestsStarted} 个请求`);
  if (transfer?.requestsFailed > 0) {
    const failures = Math.max(0, transfer.requestsFailed - (transfer.requestsCancelled || 0));
    if (failures) requests.push(`失败 ${failures} 次`);
    if (transfer.requestsConsumerClosed) requests.push(`读取端提前结束 ${transfer.requestsConsumerClosed} 次`);
    const cancelled = (transfer.requestsCancelled || 0) - (transfer.requestsConsumerClosed || 0);
    if (cancelled > 0) requests.push(`取消或清理 ${cancelled} 次`);
  }
  const latestRead = transfer?.readTimings?.requests.at(-1);
  if (latestRead) {
    const firstData = !latestRead.headersReceived ? '未收到响应头' : !latestRead.headersVerified
      ? '不适用（响应头未核对）' : formatDiagnosticDuration(latestRead.firstDataWaitMs);
    const body = !latestRead.headersVerified ? '不适用（响应头未核对）'
      : latestRead.bodyTransferMs === null ? '未收到正文' : formatDiagnosticDuration(latestRead.bodyTransferMs);
    requests.push(`最近读取 #${latestRead.sequence}：响应头等待 ${formatDiagnosticDuration(latestRead.responseWaitMs)} · 首段等待 ${firstData} · 正文传输 ${body}${latestRead.outcome === 'failed' ? '（未完成）' : ''}`);
    const outcome = [latestRead.httpStatus ? `HTTP ${latestRead.httpStatus}` : '', latestRead.transportCode || '',
      latestRead.failureCode === 'TIMEOUT' ? '上游请求超时' : latestRead.cancellationReason === 'consumer_closed' ? '读取端已结束本次请求'
        : latestRead.cancellationReason === 'task_cancelled' ? '任务已取消' : latestRead.cancellationReason === 'lease_closed' ? '读取已清理' : ''].filter(Boolean);
    if (outcome.length) requests.push(outcome.join(' · '));
    requests.push('并发请求用时可能重叠，不能相加作为任务耗时');
  }
  const networkTiming = transfer ? [
    `累计请求响应等待 ${formatDiagnosticDuration(transfer.responseWaitMs)}`,
    `响应读取 ${formatDiagnosticDuration(transfer.responseBodyMs)}`,
    ...requests,
  ].join(' · ') : null;
  const phases = Object.entries(STAGES).filter(([key]) => amount(data.stages[key]) && (data.stages[key] > 0 || key === job.stage));
  const indexCache = data.indexCache;
  const indexReuse = indexCache ? indexCache.hitBytes > 0
    ? `已复用本次运行的影片索引 ${(indexCache.hitBytes / 1024).toFixed(1)} KiB；目标位置仍重新核对。`
    : indexCache.enabled ? '本次未复用影片索引；后续同一影片取材可自动复用已验证的索引。' : '本任务未启用索引复用。' : null;
  return { summary, networkTiming, ...(indexReuse ? { indexReuse } : {}),
    stageTiming: phases.length ? `阶段用时：${phases.map(([key, label]) => `${label} ${formatDiagnosticDuration(data.stages[key])}`).join(' · ')}` : null };
}
