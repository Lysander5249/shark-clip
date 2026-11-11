import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { performance } from 'node:perf_hooks';
import { createRemoteSource, remoteTelemetry } from '../src/remote.mjs';

const bytes = Buffer.alloc(128 * 1024, 0x32);
const keys = ['schemaVersion', 'requestsStarted', 'requestsCompleted', 'requestsFailed', 'activeRequests', 'responseWaitMs', 'responseBodyMs', 'lastByteAgeMs', 'state', 'currentBytesPerSecond',
  'waitingResponseRequests', 'waitingFirstDataRequests', 'receivingRequests', 'waitingMoreDataRequests'];
async function eventually(check) {
  for (let count = 0; count < 200; count++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('controlled HTTP fixture did not reach the expected state');
}
async function fixture(t, { redirect = false, tick = () => {} } = {}) {
  let handler;
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/redirect')) { tick(125); res.writeHead(302, { Location: '/private-name.mkv?token=private-fixture-token' }).end(); return; }
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range) || [];
    const start = Number(a), end = Math.min(Number(b), bytes.length - 1);
    if (!Number.isInteger(start) || start > end) { res.writeHead(416).end(); return; }
    const headers = { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1, ETag: '"telemetry-fixture"', 'X-Private-Fixture': 'private-header-value' };
    if (start === 0 && end === 16383) { tick(75); res.writeHead(206, headers).end(bytes.subarray(start, end + 1)); return; }
    handler({ req, res, start, end, headers });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/${redirect ? 'redirect' : 'private-name.mkv'}?token=private-fixture-token`;
  const source = await createRemoteSource({ url, username: 'private-fixture-user', password: 'private-fixture-password', initialRanges: 'head', requestTimeoutMs: 1000 });
  return { source, url, handle(value) { handler = value; } };
}

test('live telemetry separates response wait from body time and rate decays during a body pause', { timeout: 10000 }, async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const f = await fixture(t);
  const lease = f.source.createLease({ budgetBytes: 8192 });
  t.after(() => lease.settle());
  const originalFields = Object.keys(lease.metrics).sort();
  assert.deepEqual(remoteTelemetry(lease.metrics), { schemaVersion: 1, requestsStarted: 0, requestsCompleted: 0, requestsFailed: 0, activeRequests: 0,
    responseWaitMs: 0, responseBodyMs: 0, lastByteAgeMs: null, state: 'idle', currentBytesPerSecond: null,
    waitingResponseRequests: 0, waitingFirstDataRequests: 0, receivingRequests: 0, waitingMoreDataRequests: 0 });
  let pending;
  f.handle(request => { pending = request; });
  const reading = lease.read(20000, 4096);
  await eventually(() => Boolean(pending));
  now = 100;
  let snapshot = remoteTelemetry(lease.metrics);
  assert.equal(snapshot.state, 'waiting_response');
  assert.equal(snapshot.activeRequests, 1);
  assert.equal(snapshot.requestsStarted, 1);
  assert.equal(snapshot.responseWaitMs, 100);
  assert.equal(snapshot.currentBytesPerSecond, null);
  now = 200;
  pending.res.writeHead(206, pending.headers); pending.res.flushHeaders();
  await eventually(() => remoteTelemetry(lease.metrics).state === 'waiting_data');
  assert.equal(remoteTelemetry(lease.metrics).responseWaitMs, 200);
  now = 1000;
  pending.res.write(bytes.subarray(pending.start, pending.start + 1024));
  await eventually(() => lease.metrics.receivedBytes === 1024);
  snapshot = remoteTelemetry(lease.metrics);
  assert.equal(snapshot.state, 'receiving');
  assert.equal(snapshot.lastByteAgeMs, 0);
  assert.equal(snapshot.currentBytesPerSecond, 1024);
  now = 3000;
  snapshot = remoteTelemetry(lease.metrics);
  assert.equal(snapshot.state, 'waiting_data');
  assert.equal(snapshot.responseBodyMs, 2800);
  assert.equal(snapshot.lastByteAgeMs, 2000);
  assert(snapshot.currentBytesPerSecond > 0 && snapshot.currentBytesPerSecond < 1024);
  now = 6100;
  assert.equal(remoteTelemetry(lease.metrics).currentBytesPerSecond, 0);
  now = 6200;
  pending.res.end(bytes.subarray(pending.start + 1024, pending.end + 1));
  assert.deepEqual(await reading, bytes.subarray(20000, 24096));
  const finished = remoteTelemetry(lease.metrics);
  assert.equal(finished.state, 'idle');
  assert.equal(finished.activeRequests, 0);
  assert.equal(finished.requestsStarted, 1);
  assert.equal(finished.requestsCompleted, 1);
  assert.equal(finished.requestsFailed, 0);
  assert.equal(finished.responseWaitMs, 200);
  assert.equal(finished.responseBodyMs, 6000);
  assert.equal(finished.currentBytesPerSecond, null);
  assert.deepEqual(Object.keys(finished).sort(), keys.slice().sort());
  now = 50000;
  assert.deepEqual(remoteTelemetry(lease.metrics), finished, 'settled timings and age must remain stable');
  finished.requestsCompleted = 999;
  assert.equal(remoteTelemetry(lease.metrics).requestsCompleted, 1, 'a returned snapshot cannot mutate private counters');
  assert.deepEqual(Object.keys(lease.metrics).sort(), originalFields, 'telemetry must not add enumerable meter fields');
});

test('telemetry includes redirects in final-header wait and exposes no source or authentication details', { timeout: 10000 }, async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const f = await fixture(t, { redirect: true, tick: value => { now += value; } });
  const snapshot = remoteTelemetry(f.source.metrics);
  assert.equal(snapshot.requestsStarted, 1, 'one Range request chain can include redirects');
  assert.equal(snapshot.requestsCompleted, 1);
  assert.equal(snapshot.responseWaitMs, 200);
  const serialized = JSON.stringify(snapshot);
  for (const secret of ['private-name', 'private-fixture-token', 'private-fixture-user', 'private-fixture-password', 'private-header-value', 'Authorization', f.url]) assert(!serialized.includes(secret));
  assert(Object.values(snapshot).every(value => value === null || typeof value === 'number' || ['idle', 'waiting_response', 'receiving', 'waiting_data'].includes(value)));
  for (const unknown of [null, undefined, {}, { receivedBytes: 42 }, 'metrics']) assert.equal(remoteTelemetry(unknown), null);
});

test('failed, cancelled and rejected-before-dispatch reads keep independent stable request counters', { timeout: 10000 }, async t => {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  const f = await fixture(t);
  const bad = f.source.createLease({ budgetBytes: 8192 });
  f.handle(({ res, headers }) => { now = 100; res.writeHead(206, { ...headers, 'Content-Range': `bytes 1-4096/${bytes.length}` }).end(bytes.subarray(0, 4096)); });
  await assert.rejects(bad.read(20000, 4096), { code: 'RANGE_INVALID' });
  assert.equal(remoteTelemetry(bad.metrics).requestsFailed, 1);
  assert.equal(remoteTelemetry(bad.metrics).requestsCompleted, 0);
  assert.equal(remoteTelemetry(bad.metrics).activeRequests, 0);
  await bad.settle();
  const tooSmall = f.source.createLease({ budgetBytes: 1 });
  await assert.rejects(tooSmall.read(20000, 4096), { code: 'BUDGET_EXCEEDED' });
  assert.equal(remoteTelemetry(tooSmall.metrics).requestsStarted, 0);
  assert.equal(remoteTelemetry(tooSmall.metrics).requestsFailed, 0);
  await tooSmall.settle();
  const controller = new AbortController(), cancelled = f.source.createLease({ budgetBytes: 8192, signal: controller.signal });
  let pending;
  f.handle(request => { pending = request; });
  const reading = cancelled.read(20000, 4096).then(value => ({ value }), error => ({ error }));
  await eventually(() => Boolean(pending));
  now = 200; pending.res.writeHead(206, pending.headers); pending.res.flushHeaders();
  await eventually(() => remoteTelemetry(cancelled.metrics).state === 'waiting_data');
  now = 300; pending.res.write(bytes.subarray(20000, 20128));
  await eventually(() => cancelled.metrics.receivedBytes === 128);
  now = 500; controller.abort(); await cancelled.settle();
  assert.equal((await reading).error.code, 'CANCELLED');
  const finished = remoteTelemetry(cancelled.metrics);
  assert.equal(finished.requestsStarted, 1); assert.equal(finished.requestsFailed, 1);
  assert.equal(finished.requestsCompleted, 0); assert.equal(finished.activeRequests, 0);
  assert.equal(finished.lastByteAgeMs, 200);
  now = 5000;
  assert.deepEqual(remoteTelemetry(cancelled.metrics), finished);
  assert.equal(remoteTelemetry(f.source.metrics).requestsFailed, 0, 'source and lease telemetry must be isolated');
});
