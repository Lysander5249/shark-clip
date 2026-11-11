import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRemoteSource } from '../src/remote.mjs';
import { finishJobLease, jobTransferTelemetry } from '../src/job-metrics.mjs';
import { createTaskDiagnostics, mergeTransferTelemetry, sanitizeReadTimings, sanitizeTransferTelemetry } from '../src/task-diagnostics.mjs';
import { createHistoryStore } from '../src/history.mjs';
import { createDiagnosticReport, formatJobDiagnostics } from '../public/job-diagnostics.mjs';

const SECRET = 'PRIVATE_READ_TIMING_SECRET';
const RECORD_KEYS = ['sequence', 'outcome', 'failureCode', 'terminalStage', 'headersReceived', 'headersVerified',
  'receivedBytes', 'elapsedMs', 'responseWaitMs', 'firstDataWaitMs', 'bodyTransferMs'].sort();
const CLASS_KEYS = ['waitingResponseRequests', 'waitingFirstDataRequests', 'receivingRequests', 'waitingMoreDataRequests'];
function request(sequence = 1, changes = {}) {
  return { sequence, outcome: 'completed', failureCode: null, terminalStage: 'completed', headersReceived: true,
    headersVerified: true, receivedBytes: 4096, elapsedMs: 1000, responseWaitMs: 200, firstDataWaitMs: 300, bodyTransferMs: 500, ...changes };
}
function ring(requests, droppedRequests = 0) {
  return { schemaVersion: 1, limit: 32, requestsRecorded: requests.length, droppedRequests, requests };
}
function transfer(changes = {}) {
  return { schemaVersion: 1, requestsStarted: 1, requestsCompleted: 1, requestsFailed: 0, activeRequests: 0,
    responseWaitMs: 200, responseBodyMs: 800, lastByteAgeMs: null, state: 'idle', currentBytesPerSecond: null, ...changes };
}
function diagnosticJob(observation, changes = {}) {
  return { id: 'read-timings-job', status: 'running', stage: 'fetch', metrics: { receivedBytes: 4096, requests: 1 },
    diagnostics: createTaskDiagnostics({ sourceKind: 'remote', now: () => 0 }).snapshot({ transfer: observation }), ...changes };
}
function assertPrivateFree(value) {
  const text = JSON.stringify(value);
  for (const forbidden of [SECRET, 'Authorization', 'Cookie', 'http:', 'https:', '127.0.0.1', 'private-name', 'Basic '])
    assert(!text.includes(forbidden), `unexpected private value ${forbidden}`);
}

test('read timing sanitizers rebuild only bounded values and fixed enums before persistence and clipboard export', () => {
  const raw = ring([request(1, { url: `https://private-name/?token=${SECRET}`, headers: { Authorization: SECRET, Cookie: SECRET },
    error: new Error(SECRET), failureCode: SECRET, terminalStage: SECRET, label: SECRET, range: { start: 2, end: 10 } }),
  request(2, { outcome: 'failed', headersReceived: false, headersVerified: true, receivedBytes: -1,
    elapsedMs: Infinity, responseWaitMs: -10, firstDataWaitMs: SECRET, bodyTransferMs: NaN, failureCode: SECRET, terminalStage: SECRET }),
  request(2), request(3, { outcome: SECRET }), request(-1), request(4.5), request(1_000_000_001)]);
  raw.url = SECRET; raw.limit = SECRET; raw.requestsRecorded = SECRET;
  const safe = sanitizeReadTimings(raw);
  assert.equal(safe.limit, 32); assert.equal(safe.requestsRecorded, 2); assert.equal(safe.droppedRequests, 0);
  assert.deepEqual(safe.requests.map(item => item.sequence), [1, 2]);
  assert.deepEqual(safe.requests[0], request(1));
  assert.deepEqual(safe.requests[1], request(2, { outcome: 'failed', failureCode: null, terminalStage: 'waiting_response',
    headersReceived: false, headersVerified: false, receivedBytes: 0, elapsedMs: 0, responseWaitMs: 0, firstDataWaitMs: null, bodyTransferMs: null }));
  for (const item of safe.requests) assert.deepEqual(Object.keys(item).sort(), RECORD_KEYS);
  const observed = transfer({ readTimings: raw, waitingFirstDataRequests: Infinity, waitingResponseRequests: SECRET,
    receivingRequests: -1, waitingMoreDataRequests: 99999999, request: raw });
  const backend = sanitizeTransferTelemetry(observed);
  assert.deepEqual(CLASS_KEYS.map(key => backend[key]), [0, 0, 0, 1024]);
  const job = diagnosticJob(observed, { readMode: 'parallel' });
  const report = createDiagnosticReport(job, { version: '0.3.15' });
  assert.deepEqual(report.diagnostics.transfer.readTimings, safe);
  assert.equal(report.readMode, 'parallel');
  assertPrivateFree(backend); assertPrivateFree(report);
  job.diagnostics.transfer.readTimings.requests[0].elapsedMs = 999999;
  assert.equal(report.diagnostics.transfer.readTimings.requests[0].elapsedMs, 1000, 'exports own private measurement copies');
});

test('read timing normalization rejects unknown rings and bounds all supplied durations and body bytes', () => {
  for (const invalid of [null, undefined, [], {}, 'text', { schemaVersion: 2, requests: [] }, { schemaVersion: 1, requests: {} }]) {
    assert.equal(sanitizeReadTimings(invalid), null);
    assert(!Object.hasOwn(sanitizeTransferTelemetry(transfer({ readTimings: invalid })), 'readTimings'));
    assert(!Object.hasOwn(createDiagnosticReport(diagnosticJob(transfer({ readTimings: invalid }))).diagnostics.transfer, 'readTimings'));
  }
  const safe = sanitizeReadTimings(ring([request(1, { elapsedMs: 1e100, responseWaitMs: 1e100, firstDataWaitMs: 1e100,
    bodyTransferMs: 1e100, receivedBytes: 1e100 })], 1e100));
  assert.equal(safe.requests[0].elapsedMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(safe.requests[0].responseWaitMs, safe.requests[0].elapsedMs);
  assert.equal(safe.requests[0].firstDataWaitMs, 0); assert.equal(safe.requests[0].bodyTransferMs, 0);
  assert.equal(safe.requests[0].receivedBytes, 65536 * 1024 * 1024);
  assert.equal(safe.droppedRequests, 1_000_000_000);
});

test('sequential merge offsets dispatch numbers by all prior requests, even when earlier observations are legacy', () => {
  const earlier = transfer({ requestsStarted: 5, requestsCompleted: 3, requestsFailed: 2 });
  const later = transfer({ requestsStarted: 3, requestsCompleted: 2, requestsFailed: 1,
    readTimings: ring([request(1), request(3)], 1) });
  const merged = mergeTransferTelemetry(earlier, later);
  assert.equal(merged.requestsStarted, 8);
  assert.deepEqual(merged.readTimings.requests.map(item => item.sequence), [6, 8]);
  assert.equal(merged.readTimings.droppedRequests, 1);
  assert.deepEqual(later.readTimings.requests.map(item => item.sequence), [1, 3], 'merging does not rewrite the active lease');
  const legacy = mergeTransferTelemetry(earlier, transfer());
  assert(!Object.hasOwn(legacy, 'readTimings'));
  assert(CLASS_KEYS.every(key => !Object.hasOwn(legacy, key)), 'legacy objects keep their original optional field set');
});

test('real task leases keep at most 32 timings, count all evictions and cannot be committed twice', { timeout: 10000 }, async t => {
  const data = Buffer.alloc(65536, 17);
  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) { res.writeHead(400).end(); return; }
    const start = Number(match[1]), end = Number(match[2]);
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1,
      ETag: `"${SECRET}"`, 'X-Private-Header': SECRET });
    res.end(data.subarray(start, end + 1));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const source = await createRemoteSource({ url: `http://127.0.0.1:${server.address().port}/private-name?token=${SECRET}`, initialRanges: 'head' });
  const job = { params: { budgetBytes: 64 } };
  let completed = 0;
  for (const count of [40, 12]) {
    const original = source.createLease({ budgetBytes: 64 - completed });
    const lease = { ...original, async release() { original.close(); await original.settle(); } };
    job.lease = lease;
    for (let index = 0; index < count; index++) {
      await lease.read(20000 + completed, 1); completed++;
      const first = jobTransferTelemetry(job), repeated = jobTransferTelemetry(job);
      assert.deepEqual(repeated, first, 'polling is passive and never merges a live lease into saved state');
      assert.equal(first.requestsStarted, completed);
      assert.equal(first.readTimings.requestsRecorded, Math.min(completed, 32));
      assert.equal(first.readTimings.droppedRequests, Math.max(0, completed - 32));
      assert.equal(first.readTimings.requests.at(-1).sequence, completed);
      assertPrivateFree(first);
    }
    await finishJobLease(job, lease);
    const settled = jobTransferTelemetry(job);
    await finishJobLease(job, lease);
    assert.deepEqual(jobTransferTelemetry(job), settled, 'settling the same lease twice does not double-count timings');
  }
  const final = jobTransferTelemetry(job);
  assert.equal(final.requestsStarted, 52); assert.equal(final.requestsCompleted, 52);
  assert.equal(final.readTimings.requestsRecorded, 32); assert.equal(final.readTimings.droppedRequests, 20);
  assert.deepEqual(final.readTimings.requests.map(item => item.sequence), Array.from({ length: 32 }, (_, index) => index + 21));
  assert.equal(source.metrics.requests, 1, 'source bootstrap requests are not silently mixed into task timings');
});

test('the existing diagnostic line distinguishes header, first-data and body times without adding overlapping requests', () => {
  const value = diagnosticJob(transfer({ readTimings: ring([request(4)]) }));
  assert.match(formatJobDiagnostics(value).networkTiming, /最近读取 #4：响应头等待 200 毫秒.*首段等待 300 毫秒.*正文传输 500 毫秒/);
  assert.match(formatJobDiagnostics(value).networkTiming, /并发请求用时可能重叠，不能相加作为任务耗时/);
  value.diagnostics.transfer.readTimings = ring([request(5, { outcome: 'failed', failureCode: 'TIMEOUT', terminalStage: 'waiting_response',
    headersReceived: false, headersVerified: false, receivedBytes: 0, firstDataWaitMs: null, bodyTransferMs: null })]);
  assert.match(formatJobDiagnostics(value).networkTiming, /首段等待 未收到响应头.*正文传输 不适用（响应头未核对）.*未完成/);
  value.diagnostics.transfer.readTimings = ring([request(6, { outcome: 'failed', failureCode: 'RANGE_INVALID', terminalStage: 'response_validation',
    headersVerified: false, receivedBytes: 0, firstDataWaitMs: 300, bodyTransferMs: null })]);
  assert.match(formatJobDiagnostics(value).networkTiming, /首段等待 不适用（响应头未核对）.*正文传输 不适用（响应头未核对）/);
  assert(!formatJobDiagnostics(value).networkTiming.includes('首段等待 300 毫秒'), 'response validation time is not valid first-data waiting');
});

test('history restart retains only whitelisted timing measurements and resets all active request classes', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-job-read-timings-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const raw = transfer({ activeRequests: 4, currentBytesPerSecond: 32, state: 'receiving',
    ...Object.fromEntries(CLASS_KEYS.map(key => [key, 1])),
    readTimings: ring([request(1, { url: SECRET, request: { headers: { Authorization: SECRET } } }),
      request(2, { outcome: 'failed', failureCode: 'TIMEOUT', terminalStage: 'body', error: SECRET })], 5) });
  const job = diagnosticJob(raw, { status: 'failed', stage: 'failed' });
  const store = await createHistoryStore(directory); await store.save([job]);
  const [loaded] = await (await createHistoryStore(directory)).load();
  assert.equal(loaded.diagnostics.status, 'failed');
  assert.deepEqual(loaded.diagnostics.transfer.readTimings, sanitizeReadTimings(raw.readTimings));
  assert.equal(loaded.diagnostics.transfer.activeRequests, 0); assert.equal(loaded.diagnostics.transfer.currentBytesPerSecond, null);
  assert.deepEqual(CLASS_KEYS.map(key => loaded.diagnostics.transfer[key]), [0, 0, 0, 0]);
  const saved = await readFile(path.join(directory, 'tasks.json'), 'utf8');
  assert(!saved.includes(SECRET)); assert(!saved.includes('Authorization'));
  const report = createDiagnosticReport(loaded, { version: '0.3.15' }); assertPrivateFree(report);
  await store.save([loaded]);
  assert.deepEqual(await (await createHistoryStore(directory)).load(), [loaded], 'reloading and re-saving does not accumulate dropped counts');
});
