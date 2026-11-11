import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeJobDiagnostics, createDiagnosticReport, formatJobDiagnostics, formatDiagnosticDuration } from '../public/job-diagnostics.mjs';

function job(changes = {}) {
  return { id: 'clip-diagnostic-test', status: 'running', stage: 'fetch',
    metrics: { budgetBytes: 4 * 1024 ** 3, receivedBytes: 1024 ** 3, requests: 1024, upstreamBytes: null },
    diagnostics: { schemaVersion: 1, status: 'running', sourceKind: 'remote', elapsedMs: 15000,
      stages: { checking: 200, positioning: 800, fetch: 14000, probe: 0, extract: 0, validate: 0, compatible: 0, other: 0 }, recoveryAttempts: 1,
      transfer: { schemaVersion: 1, requestsStarted: 10, requestsCompleted: 8, requestsFailed: 1, activeRequests: 1,
        responseWaitMs: 1000, responseBodyMs: 12000, lastByteAgeMs: 2000, state: 'waiting_data', currentBytesPerSecond: 2 * 1024 ** 2 } },
    ...changes };
}

test('the running display names the recent tool receive speed, waiting state and cumulative timings', () => {
  const value = formatJobDiagnostics(job());
  assert.match(value.summary, /本工具近 5 秒接收：2\.00 MiB\/s/);
  assert.match(value.summary, /等待更多数据.*距上次接收 2 秒/);
  assert.match(value.networkTiming, /累计请求响应等待 1 秒.*响应读取 12 秒.*已完成 8\/10 个请求.*失败 1 次/);
  assert.match(value.stageTiming, /来源复核 200 毫秒.*索引定位 800 毫秒.*目标读取 14 秒/);
  assert(!value.stageTiming.includes('MP4'));
});

test('zero and unavailable speeds remain distinct and do not become an average bitrate', () => {
  const value = job(); value.diagnostics.transfer.currentBytesPerSecond = 0;
  assert.match(formatJobDiagnostics(value).summary, /0 B\/s/);
  value.diagnostics.transfer.currentBytesPerSecond = null;
  assert.match(formatJobDiagnostics(value).summary, /近 5 秒接收：待测/);
  value.diagnostics.transfer = null;
  assert.equal(formatJobDiagnostics(value).summary, '读取状态与接收速度暂不可用');
});

test('terminal history and local processing never advertise an old sample as current network speed', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const value = job({ status });
    value.diagnostics.status = status;
    const view = formatJobDiagnostics(value), report = createDiagnosticReport(value, { version: '0.3.6' });
    assert.equal(view.summary, '网络读取已结束');
    assert(!view.summary.includes('/s'));
    assert.equal(report.diagnostics.transfer.currentBytesPerSecond, null);
    assert.equal(report.diagnostics.transfer.activeRequests, 0);
    assert.equal(report.diagnostics.transfer.state, 'idle');
  }
  const local = job(); local.diagnostics.sourceKind = 'local';
  assert.equal(sanitizeJobDiagnostics(local.diagnostics).transfer, null);
  assert.equal(formatJobDiagnostics(local).networkTiming, null);
  assert.match(formatJobDiagnostics(local).summary, /^本地处理/);
  assert.equal(formatJobDiagnostics(job({ status: 'queued' })).summary, '等待开始 · 暂无当前接收速度');
  assert.match(formatJobDiagnostics(job({ type: 'compatible' })).summary, /^本地处理/);
});

test('remote gateway media phases show active reads instead of claiming that cloud reading has stopped', () => {
  for (const stage of ['probe', 'extract', 'validate', 'compatible']) {
    const value = job({ stage });
    assert.match(formatJobDiagnostics(value).summary, /本工具近 5 秒接收：2\.00 MiB\/s.*等待更多数据/);
    value.diagnostics.transfer.activeRequests = 0;
    assert.equal(formatJobDiagnostics(value).summary, '媒体处理中 · 当前无读取请求');
    value.diagnostics.transfer = null;
    assert.equal(formatJobDiagnostics(value).summary, '读取状态与接收速度暂不可用');
    value.diagnostics.sourceKind = 'local';
    assert.match(formatJobDiagnostics(value).summary, /^本地处理/);
  }
});

test('a terminal job normalizes stale in-flight diagnostics and preserves only a known failure phase', () => {
  const value = job({ status: 'failed', stage: 'failed', error: { code: 'TIMEOUT', stage: 'fetch', message: 'private details' } });
  const report = createDiagnosticReport(value, { version: '0.3.6' });
  assert.deepEqual(report.error, { code: 'TIMEOUT', stage: 'fetch' });
  assert.equal(report.diagnostics.transfer.activeRequests, 0);
  assert.equal(report.diagnostics.transfer.state, 'idle');
  assert.equal(report.diagnostics.transfer.currentBytesPerSecond, null);
  value.error.stage = 'https://private.example/secret';
  assert.deepEqual(createDiagnosticReport(value).error, { code: 'TIMEOUT' });
});

test('older histories and unknown diagnostics schemas have no diagnostic section', () => {
  for (const diagnostics of [undefined, null, [], {}, { schemaVersion: 2 }, { schemaVersion: 1, status: 'running', elapsedMs: -1 }]) {
    assert.equal(formatJobDiagnostics(job({ diagnostics })), null);
    assert.equal(createDiagnosticReport(job({ diagnostics })), null);
  }
});

test('index reuse is explained separately from actual HTTP bytes and excludes private fields', () => {
  const value = job();
  value.diagnostics.indexCache = { enabled: true, hitBytes: 8192, hitReads: 4, url: 'PRIVATE', etag: 'PRIVATE' };
  const report = createDiagnosticReport(value);
  assert.deepEqual(report.diagnostics.indexCache, { enabled: true, hitBytes: 8192, hitReads: 4 });
  assert.equal(report.metrics.receivedBytes, value.metrics.receivedBytes);
  assert(!JSON.stringify(report).includes('PRIVATE'));
  assert.match(formatJobDiagnostics(value).indexReuse, /复用.*8\.0 KiB.*目标位置仍重新核对/);
  value.diagnostics.indexCache.hitBytes = 0;
  assert.match(formatJobDiagnostics(value).indexReuse, /本次未复用/);
  value.diagnostics.indexCache.enabled = false;
  assert.match(formatJobDiagnostics(value).indexReuse, /未启用/);
});

test('copied reports include only known download modes and keep legacy reports unchanged', () => {
  for (const readMode of ['standard', 'continuous']) assert.equal(createDiagnosticReport(job({ readMode })).readMode, readMode);
  for (const readMode of [undefined, null, 'private-url', { password: 'secret' }]) {
    assert.equal(Object.hasOwn(createDiagnosticReport(job({ readMode })), 'readMode'), false);
  }
});

test('the copied report contains only bounded known values and never job/source/result/error payloads', () => {
  const secret = 'https://private.example/film?token=SECRET';
  const value = job({ sourceLabel: secret, source: { url: secret, password: secret }, result: { candidatePath: '/private/movie.mkv', token: secret },
    sessionToken: secret, error: { code: 'TIMEOUT', message: secret, diagnostic: { url: secret } } });
  value.metrics.url = secret; value.metrics.password = secret;
  value.diagnostics.path = '/private/movie.mkv'; value.diagnostics.token = secret;
  value.diagnostics.stages[secret] = 999;
  value.diagnostics.transfer.password = secret; value.diagnostics.transfer.url = secret;
  const report = createDiagnosticReport(value, { version: '0.3.6' });
  const serialized = JSON.stringify(report);
  for (const forbidden of [secret, '/private/movie.mkv', 'sourceLabel', 'candidatePath', 'password', 'sessionToken', 'message']) assert(!serialized.includes(forbidden), forbidden);
  assert.equal(report.appVersion, '0.3.6'); assert.equal(report.jobId, value.id);
  assert.deepEqual(report.error, { code: 'TIMEOUT' });
  assert.deepEqual(Object.keys(report.metrics).sort(), ['budgetBytes', 'receivedBytes', 'requests', 'upstreamBytes'].sort());
  assert.equal(report.diagnostics.transfer.schemaVersion, 1);
});

test('invalid numbers and unsafe free-form names cannot enter a shared report', () => {
  const value = job({ id: '/private/movie.mkv', stage: 'https://private.example/', error: { code: 'bad code SECRET' },
    metrics: { budgetBytes: Infinity, receivedBytes: '12', requests: -1, upstreamBytes: NaN } });
  value.diagnostics.stages.fetch = NaN; value.diagnostics.stages.other = -5;
  value.diagnostics.transfer.responseWaitMs = Infinity; value.diagnostics.transfer.requestsStarted = 1.5;
  value.diagnostics.transfer.lastByteAgeMs = -1; value.diagnostics.transfer.currentBytesPerSecond = '23';
  const report = createDiagnosticReport(value, { version: 'https://private.example/' });
  assert.equal(report.appVersion, null); assert.equal(report.jobId, null); assert.equal(report.stage, 'other');
  assert.deepEqual(report.metrics, {}); assert(!report.error);
  assert(!Object.hasOwn(report.diagnostics.stages, 'fetch'));
  assert(!Object.hasOwn(report.diagnostics.transfer, 'responseWaitMs'));
  assert(!Object.hasOwn(report.diagnostics.transfer, 'requestsStarted'));
  assert.equal(report.diagnostics.transfer.lastByteAgeMs, null); assert.equal(report.diagnostics.transfer.currentBytesPerSecond, null);
  value.diagnostics.transfer.state = 'SECRET';
  assert.equal(sanitizeJobDiagnostics(value.diagnostics).transfer, null);
  value.diagnostics.transfer.state = { toString: 'not a callable' };
  value.stage = { toString: 'not a callable' };
  assert.equal(createDiagnosticReport(value).stage, 'other');
  assert.equal(sanitizeJobDiagnostics(value.diagnostics).transfer, null);
});

test('stage durations handle zero, subsecond and hour values without losing a minute at rounding boundaries', () => {
  assert.equal(formatDiagnosticDuration(0), '0 毫秒');
  assert.equal(formatDiagnosticDuration(123), '123 毫秒');
  assert.equal(formatDiagnosticDuration(59999), '1 分 0 秒');
  assert.equal(formatDiagnosticDuration(3661000), '1 小时 1 分 1 秒');
  assert.equal(formatDiagnosticDuration(null), '未知');
});
