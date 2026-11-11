import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { performance } from 'node:perf_hooks';
import { createRemoteSource, remoteTelemetry, remoteReadTimings } from '../src/remote.mjs';

const bytes = Buffer.from(Array.from({ length: 128 * 1024 }, (_, i) => i % 251));
const OPTIONS = { timeout: 10000 };
const RECORD_KEYS = ['sequence', 'outcome', 'failureCode', 'terminalStage', 'headersReceived', 'headersVerified',
  'receivedBytes', 'elapsedMs', 'responseWaitMs', 'firstDataWaitMs', 'bodyTransferMs'];
const CLASS_KEYS = ['waitingResponseRequests', 'waitingFirstDataRequests', 'receivingRequests', 'waitingMoreDataRequests'];
const STAGES = new Set(['completed', 'waiting_response', 'response_validation', 'waiting_first_data', 'body']);
const FAILURE_CODES = new Set([null, 'CANCELLED', 'TIMEOUT', 'SOURCE_CHANGED', 'RANGE_UNSUPPORTED',
  'RANGE_INVALID', 'AUTH_REQUIRED', 'REMOTE_HTTP', 'BUDGET_EXCEEDED', 'RESUME_WRITE_FAILED']);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const value = predicate(); if (value) return value;
    await wait(5);
  }
  assert.fail('local timing fixture did not reach expected state');
}

async function fixture(t, { redirect = false, tick = () => {}, requestTimeoutMs = 1000 } = {}) {
  let handle = ({ res, headers, start, end }) => res.writeHead(206, headers).end(bytes.subarray(start, end + 1));
  const calls = [];
  const server = http.createServer((req, res) => {
    calls.push({ url: req.url, range: req.headers.range, authorization: req.headers.authorization });
    if (req.url.startsWith('/redirect')) {
      tick(75);
      res.writeHead(302, { Location: '/private-timing-name.mkv?token=PRIVATE_TIMING_TOKEN' }).end();
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) { res.writeHead(400).end(); return; }
    const start = Number(match[1]), end = Number(match[2]);
    if (start < 0 || end >= bytes.length || start > end) { res.writeHead(416).end(); return; }
    const headers = { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      'Content-Length': end - start + 1, ETag: '"PRIVATE_TIMING_ETAG"', 'X-Private-Fixture': 'PRIVATE_TIMING_HEADER' };
    if (start === 0 && end === 16383) {
      tick(125); res.writeHead(206, headers).end(bytes.subarray(0, 16384)); return;
    }
    handle({ req, res, start, end, headers });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/${redirect ? 'redirect' : 'private-timing-name.mkv'}?token=PRIVATE_TIMING_TOKEN`;
  const source = await createRemoteSource({ url, username: 'PRIVATE_TIMING_USER', password: 'PRIVATE_TIMING_PASSWORD',
    initialRanges: 'head', requestTimeoutMs });
  return { source, calls, url, handle(next) { handle = next; } };
}

function safeSnapshot(metrics) {
  const snapshot = remoteReadTimings(metrics);
  assert(snapshot);
  assert.deepEqual(Object.keys(snapshot).sort(), ['schemaVersion', 'limit', 'requestsRecorded', 'droppedRequests', 'requests'].sort());
  assert.equal(snapshot.schemaVersion, 1); assert.equal(snapshot.limit, 32);
  assert.equal(snapshot.requestsRecorded, snapshot.requests.length); assert(snapshot.requests.length <= 32);
  assert(Number.isSafeInteger(snapshot.droppedRequests) && snapshot.droppedRequests >= 0);
  for (const record of snapshot.requests) {
    assert.deepEqual(Object.keys(record).sort(), RECORD_KEYS.slice().sort());
    for (const key of ['sequence', 'receivedBytes', 'elapsedMs', 'responseWaitMs']) assert(Number.isSafeInteger(record[key]) && record[key] >= 0);
    assert(record.sequence >= 1); assert(['completed', 'failed'].includes(record.outcome));
    assert(FAILURE_CODES.has(record.failureCode)); assert(STAGES.has(record.terminalStage));
    assert.equal(typeof record.headersReceived, 'boolean'); assert.equal(typeof record.headersVerified, 'boolean');
    assert(!record.headersVerified || record.headersReceived);
    for (const key of ['firstDataWaitMs', 'bodyTransferMs']) assert(record[key] === null || Number.isSafeInteger(record[key]) && record[key] >= 0);
    assert.equal(record.firstDataWaitMs === null, !record.headersReceived);
    assert.equal(record.bodyTransferMs === null, record.receivedBytes === 0);
    const parts = record.responseWaitMs + (record.firstDataWaitMs ?? 0) + (record.bodyTransferMs ?? 0);
    assert(parts <= record.elapsedMs && record.elapsedMs - parts <= 2, 'timing parts reconcile apart from truncation');
    if (record.outcome === 'completed') { assert.equal(record.failureCode, null); assert.equal(record.terminalStage, 'completed'); }
  }
  const serialized = JSON.stringify(snapshot);
  for (const secret of ['PRIVATE_TIMING', 'Authorization', 'private-timing-name', 'http:', 'https:', 'Basic ', '127.0.0.1']) assert(!serialized.includes(secret));
  return snapshot;
}
function classes(metrics) {
  const live = remoteTelemetry(metrics);
  for (const key of CLASS_KEYS) assert(Number.isSafeInteger(live[key]) && live[key] >= 0);
  assert.equal(CLASS_KEYS.reduce((sum, key) => sum + live[key], 0), live.activeRequests);
  return CLASS_KEYS.map(key => live[key]);
}

test('per-attempt timings split final-header wait, first-data wait and body interval without exposing private data', OPTIONS, async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const f = await fixture(t), lease = f.source.createLease({ budgetBytes: 8192, requireStrongValidator: true });
  t.after(() => lease.settle());
  const meterFields = Object.keys(lease.metrics).sort();
  assert.deepEqual(safeSnapshot(lease.metrics).requests, []);
  let pending; f.handle(value => { pending = value; });
  const reading = lease.read(20000, 4096);
  await until(() => pending);
  now = 100;
  assert.deepEqual(classes(lease.metrics), [1, 0, 0, 0]);
  assert.equal(safeSnapshot(lease.metrics).requestsRecorded, 0, 'active attempts are not archived prematurely');
  now = 200; pending.res.writeHead(206, pending.headers); pending.res.flushHeaders();
  await until(() => remoteTelemetry(lease.metrics).waitingFirstDataRequests === 1);
  assert.deepEqual(classes(lease.metrics), [0, 1, 0, 0]);
  now = 1000; pending.res.write(bytes.subarray(pending.start, pending.start + 1024));
  await until(() => lease.metrics.receivedBytes === 1024);
  assert.deepEqual(classes(lease.metrics), [0, 0, 1, 0]);
  now = 1200; pending.res.end(bytes.subarray(pending.start + 1024, pending.end + 1));
  assert.deepEqual(await reading, bytes.subarray(20000, 24096));
  const snapshot = safeSnapshot(lease.metrics);
  assert.deepEqual(snapshot.requests, [{ sequence: 1, outcome: 'completed', failureCode: null, terminalStage: 'completed',
    headersReceived: true, headersVerified: true, receivedBytes: 4096, elapsedMs: 1200,
    responseWaitMs: 200, firstDataWaitMs: 800, bodyTransferMs: 200 }]);
  assert.deepEqual(classes(lease.metrics), [0, 0, 0, 0]);
  now = 10000;
  assert.deepEqual(remoteReadTimings(lease.metrics), snapshot, 'settled timings do not keep growing');
  snapshot.requests[0].failureCode = 'PRIVATE_TIMING_MUTATION'; snapshot.requests[0].elapsedMs = 999999;
  snapshot.requests.push({}); snapshot.droppedRequests = 999;
  assert.equal(safeSnapshot(lease.metrics).requests[0].failureCode, null);
  assert.equal(safeSnapshot(lease.metrics).requests[0].elapsedMs, 1200);
  assert.equal(safeSnapshot(lease.metrics).requestsRecorded, 1);
  assert.equal(safeSnapshot(lease.metrics).droppedRequests, 0);
  assert.deepEqual(Object.keys(lease.metrics).sort(), meterFields, 'passive records add no enumerable meter fields');
  assert.equal(safeSnapshot(f.source.metrics).requestsRecorded, 1, 'bootstrap and lease meters remain isolated');
});

test('four mutually exclusive live request classes distinguish missing headers, first data, recent data and a body pause', OPTIONS, async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const f = await fixture(t), controller = new AbortController();
  const lease = f.source.createLease({ budgetBytes: 32768, signal: controller.signal });
  t.after(() => lease.settle());
  const pending = []; f.handle(value => pending.push(value));
  const readings = [20000, 30000, 40000, 50000].map(start => lease.read(start, 4096).then(value => ({ value }), error => ({ error })));
  await until(() => pending.length === 4);
  pending.sort((a, b) => a.start - b.start);
  assert.deepEqual(classes(lease.metrics), [4, 0, 0, 0]);
  now = 100;
  for (const item of pending.slice(1)) { item.res.writeHead(206, item.headers); item.res.flushHeaders(); }
  await until(() => remoteTelemetry(lease.metrics).waitingFirstDataRequests === 3);
  now = 200; pending[3].res.write(bytes.subarray(pending[3].start, pending[3].start + 128));
  await until(() => lease.metrics.receivedBytes === 128);
  now = 1500;
  assert.deepEqual(classes(lease.metrics), [1, 2, 0, 1]);
  pending[2].res.write(bytes.subarray(pending[2].start, pending[2].start + 128));
  await until(() => lease.metrics.receivedBytes === 256);
  assert.deepEqual(classes(lease.metrics), [1, 1, 1, 1]);
  assert.equal(remoteTelemetry(lease.metrics).state, 'receiving', 'the prior aggregate state remains compatible');
  controller.abort(); await lease.settle();
  assert((await Promise.all(readings)).every(result => result.error.code === 'CANCELLED'));
  const records = safeSnapshot(lease.metrics).requests.slice().sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(records.map(record => record.terminalStage), ['waiting_response', 'waiting_first_data', 'body', 'body']);
  assert(records.every(record => record.failureCode === 'CANCELLED' && record.outcome === 'failed'));
  assert.equal(records[0].headersReceived, false); assert.equal(records[0].firstDataWaitMs, null);
  assert.equal(records[1].headersVerified, true); assert.equal(records[1].receivedBytes, 0); assert.equal(records[1].bodyTransferMs, null);
  assert.deepEqual(records.slice(2).map(record => record.receivedBytes), [128, 128]);
  assert.deepEqual(classes(lease.metrics), [0, 0, 0, 0]);
  assert.equal(lease.metrics.reservedBytes, 0);
});

test('idle timeouts retain the actual stopped phase with no retry or invented body bytes', OPTIONS, async t => {
  for (const [phase, headersReceived, receivedBytes] of [['waiting_response', false, 0], ['waiting_first_data', true, 0], ['body', true, 128]]) {
    await t.test(phase, async t => {
      const f = await fixture(t, { requestTimeoutMs: 50 });
      f.handle(({ res, headers, start }) => {
        if (!headersReceived) return;
        res.writeHead(206, headers); res.flushHeaders();
        if (receivedBytes) res.write(bytes.subarray(start, start + receivedBytes));
      });
      const lease = f.source.createLease({ budgetBytes: 8192, requireStrongValidator: true });
      t.after(() => lease.settle());
      await assert.rejects(lease.read(20000, 4096), { code: 'TIMEOUT' });
      await lease.settle();
      const snapshot = safeSnapshot(lease.metrics), record = snapshot.requests[0];
      assert.equal(snapshot.requestsRecorded, 1); assert.equal(f.calls.length, 2, 'bootstrap plus one attempt, with no retry');
      assert.equal(record.outcome, 'failed'); assert.equal(record.failureCode, 'TIMEOUT');
      assert.equal(record.terminalStage, phase); assert.equal(record.headersReceived, headersReceived);
      assert.equal(record.headersVerified, headersReceived); assert.equal(record.receivedBytes, receivedBytes);
      assert.equal(record.bodyTransferMs === null, receivedBytes === 0);
      assert.equal(record.firstDataWaitMs === null, !headersReceived);
      assert.equal(lease.metrics.reservedBytes, 0); assert.equal(remoteTelemetry(lease.metrics).activeRequests, 0);
    });
  }
});

test('range and source-version failures are response validation, not waiting for body data', OPTIONS, async t => {
  for (const [mode, code] of [['wrong-range', 'RANGE_INVALID'], ['version-changed', 'SOURCE_CHANGED'],
    ['missing-etag', 'SOURCE_CHANGED'], ['ignore-range', 'RANGE_UNSUPPORTED'], ['unauthorized', 'AUTH_REQUIRED']]) {
    await t.test(mode, async t => {
      const f = await fixture(t);
      f.handle(({ res, headers, start, end }) => {
        if (mode === 'ignore-range') { res.writeHead(200).end(bytes); return; }
        if (mode === 'unauthorized') { res.writeHead(401).end('PRIVATE_TIMING_MESSAGE'); return; }
        const changed = { ...headers };
        if (mode === 'wrong-range') changed['Content-Range'] = `bytes ${start + 1}-${end}/${bytes.length}`;
        if (mode === 'version-changed') changed.ETag = '"PRIVATE_TIMING_OTHER_VERSION"';
        if (mode === 'missing-etag') delete changed.ETag;
        res.writeHead(206, changed).end(bytes.subarray(start, end + 1));
      });
      const lease = f.source.createLease({ budgetBytes: 8192, requireStrongValidator: true });
      t.after(() => lease.settle());
      await assert.rejects(lease.read(20000, 4096), { code }); await lease.settle();
      const record = safeSnapshot(lease.metrics).requests[0];
      assert.equal(record.outcome, 'failed'); assert.equal(record.failureCode, code);
      assert.equal(record.terminalStage, 'response_validation'); assert.equal(record.headersReceived, true);
      assert.equal(record.headersVerified, false); assert.equal(record.receivedBytes, 0);
      assert.notEqual(record.firstDataWaitMs, null); assert.equal(record.bodyTransferMs, null);
      assert.equal(f.calls.length, 2);
    });
  }
});

test('pre-dispatch budget, invalid-range and cancellation rejections do not fabricate timing records', OPTIONS, async t => {
  const f = await fixture(t), beforeCalls = f.calls.length;
  for (const [kind, expectedCode] of [['budget', 'BUDGET_EXCEEDED'], ['range', 'RANGE_INVALID'], ['cancelled', 'CANCELLED']]) {
    const controller = new AbortController(); if (kind === 'cancelled') controller.abort();
    const lease = f.source.createLease({ budgetBytes: kind === 'budget' ? 1 : 8192, signal: controller.signal });
    await assert.rejects(lease.read(kind === 'range' ? bytes.length : 20000, 4096), { code: expectedCode });
    await lease.settle();
    assert.equal(lease.metrics.requests, 0); assert.equal(lease.metrics.reservedBytes, 0);
    assert.deepEqual(safeSnapshot(lease.metrics), { schemaVersion: 1, limit: 32, requestsRecorded: 0, droppedRequests: 0, requests: [] });
    assert.deepEqual(classes(lease.metrics), [0, 0, 0, 0]);
  }
  assert.equal(f.calls.length, beforeCalls);
});

test('a redirect chain remains one Range attempt and waits for the final non-redirect headers', OPTIONS, async t => {
  let now = 0; t.mock.method(performance, 'now', () => now);
  const f = await fixture(t, { redirect: true, tick: amount => { now += amount; } });
  assert.equal(f.calls.length, 2, 'the local fixture received two physical HTTP hops');
  assert.equal(f.source.metrics.requests, 1, 'the existing Range-attempt counter does not count redirect hops');
  const snapshot = safeSnapshot(f.source.metrics);
  assert.equal(snapshot.requestsRecorded, 1);
  assert.deepEqual(snapshot.requests[0], { sequence: 1, outcome: 'completed', failureCode: null, terminalStage: 'completed',
    headersReceived: true, headersVerified: true, receivedBytes: 16384, elapsedMs: 200,
    responseWaitMs: 200, firstDataWaitMs: 0, bodyTransferMs: 0 });
  assert(f.calls.every(call => call.authorization?.startsWith('Basic ')), 'same-origin authentication behavior is unchanged');
});

test('concurrent attempts returned in reverse completion order are exported by dispatch sequence', OPTIONS, async t => {
  const f = await fixture(t), lease = f.source.createLease({ budgetBytes: 8192 });
  t.after(() => lease.settle());
  const pending = new Map(); f.handle(value => pending.set(value.start, value));
  const first = lease.read(20000, 4096), second = lease.read(30000, 4096);
  await until(() => pending.size === 2);
  const later = pending.get(30000);
  later.res.writeHead(206, later.headers).end(bytes.subarray(later.start, later.end + 1));
  assert.deepEqual(await second, bytes.subarray(30000, 34096));
  assert.deepEqual(safeSnapshot(lease.metrics).requests.map(record => record.sequence), [2]);
  const earlier = pending.get(20000);
  earlier.res.writeHead(206, earlier.headers).end(bytes.subarray(earlier.start, earlier.end + 1));
  assert.deepEqual(await first, bytes.subarray(20000, 24096));
  await lease.settle();
  const snapshot = safeSnapshot(lease.metrics);
  assert.deepEqual(snapshot.requests.map(record => record.sequence), [1, 2]);
  assert(snapshot.requests.every(record => record.outcome === 'completed' && record.receivedBytes === 4096));
  snapshot.requests.reverse();
  assert.deepEqual(safeSnapshot(lease.metrics).requests.map(record => record.sequence), [1, 2], 'sorting and mutations affect only the exported private copy');
});

test('truncated bodies retain received bytes and a body-stage protocol failure', OPTIONS, async t => {
  const f = await fixture(t);
  f.handle(({ res, headers, start }) => {
    res.writeHead(206, headers); res.flushHeaders();
    res.write(bytes.subarray(start, start + 128)); setTimeout(() => res.destroy(), 10);
  });
  const lease = f.source.createLease({ budgetBytes: 8192 });
  t.after(() => lease.settle());
  await assert.rejects(lease.read(20000, 4096), { code: 'RANGE_INVALID' }); await lease.settle();
  const record = safeSnapshot(lease.metrics).requests[0];
  assert.equal(record.terminalStage, 'body'); assert.equal(record.failureCode, 'RANGE_INVALID');
  assert.equal(record.headersVerified, true); assert.equal(record.receivedBytes, 128);
  assert.notEqual(record.bodyTransferMs, null); assert.equal(f.calls.length, 2);
});

test('the settled timing ring keeps only 32 private copies and reports exactly how many older attempts were dropped', OPTIONS, async t => {
  const f = await fixture(t), lease = f.source.createLease({ budgetBytes: 64 });
  t.after(() => lease.settle());
  for (let index = 0; index < 40; index++) assert.deepEqual(await lease.read(20000 + index, 1), bytes.subarray(20000 + index, 20001 + index));
  await lease.settle();
  const snapshot = safeSnapshot(lease.metrics);
  assert.equal(snapshot.requestsRecorded, 32); assert.equal(snapshot.droppedRequests, 8);
  assert.deepEqual(snapshot.requests.map(record => record.sequence), Array.from({ length: 32 }, (_, i) => i + 9));
  assert(snapshot.requests.every(record => record.outcome === 'completed' && record.receivedBytes === 1));
  assert.equal(lease.metrics.requests, 40);
  assert.equal(remoteTelemetry(lease.metrics).requestsCompleted, 40, 'ring eviction does not truncate prior aggregate counters');
  snapshot.requests.splice(0, 32); snapshot.limit = 1000;
  assert.equal(safeSnapshot(lease.metrics).requestsRecorded, 32);
  for (const unknown of [null, undefined, {}, { receivedBytes: 42 }, 'metrics', []]) assert.equal(remoteReadTimings(unknown), null);
});
