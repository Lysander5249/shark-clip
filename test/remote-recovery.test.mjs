import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRemoteSource, RemoteError } from '../src/remote.mjs';
import { materializeMatroskaWindow } from '../src/matroska-window.mjs';

const MiB = 1024 * 1024, START = 32768, LENGTH = 4096, PARTIAL = 128;
const DEFAULT_BYTES = Buffer.from(Array.from({ length: 192 * 1024 }, (_, i) => i % 251));
const OPTIONS = { timeout: 10_000 };

async function fixture(t, { mode = 'recover', bytes = DEFAULT_BYTES, partial = PARTIAL } = {}) {
  const requests = [], mediaRequests = [], completed = [];
  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    assert(match, 'every upstream recovery request must remain bounded');
    const start = Number(match[1]), end = Number(match[2]), length = end - start + 1;
    assert(start >= 0 && end < bytes.length && length > 0);
    const request = { start, end, ifMatch: req.headers['if-match'] };
    requests.push(request);
    const bootstrap = start === 0 && end === 16383;
    if (!bootstrap) mediaRequests.push(request);
    const attempt = mediaRequests.length;
    if (!bootstrap && mode === 'auth') { res.writeHead(401).end(); return; }
    const wrongRange = !bootstrap && mode === 'wrong-range';
    const changed = !bootstrap && mode === 'changed-on-retry' && attempt === 2;
    const shortened = !bootstrap && mode === 'clean-short';
    res.writeHead(206, {
      'Content-Range': `bytes ${wrongRange ? start + 1 : start}-${end}/${bytes.length}`,
      ...(!shortened ? { 'Content-Length': length } : {}),
      ETag: changed ? '"synthetic-v2"' : '"synthetic-v1"',
    });
    const interrupted = !bootstrap && (mode === 'always-stall' || ['recover', 'disconnect', 'changed-on-retry', 'cancel'].includes(mode) && attempt === 1);
    if (interrupted) {
      res.flushHeaders();
      res.write(bytes.subarray(start, start + Math.min(partial, length - 1)), () => {
        if (mode === 'disconnect') setTimeout(() => res.destroy(), 20);
      });
      return;
    }
    if (shortened) { res.end(bytes.subarray(start, end)); return; }
    res.end(bytes.subarray(start, end + 1)); completed.push(request);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = `http://127.0.0.1:${server.address().port}/synthetic-private-source.mkv?token=synthetic-query-secret`;
  const session = await createRemoteSource({ url, username: 'synthetic-user', password: 'synthetic-password',
    initialRanges: 'head', budgetBytes: 65536, requestTimeoutMs: 75 });
  return { session, bytes, url, requests, mediaRequests, completed };
}

function leaseFor(t, source, budgetBytes = LENGTH) {
  const lease = source.session.createLease({ budgetBytes });
  t.after(() => lease.settle()); return lease;
}
function failure(code) {
  return error => { assert(error instanceof RemoteError); assert.equal(error.code, code); return true; };
}
function assertRetryEvent(event, expected, source) {
  assert(Object.isFrozen(event), 'retry notifications must be immutable');
  assert.deepEqual(Object.keys(event).sort(), ['attempt', 'maxAttempts', 'remainingBytes', 'receivedBytes', 'delayMs'].sort());
  assert(Object.values(event).every(value => Number.isSafeInteger(value) && value >= 0));
  assert.deepEqual(event, expected);
  const serialized = JSON.stringify(event);
  for (const secret of [source.url, 'synthetic-private-source', 'synthetic-query-secret', 'synthetic-user', 'synthetic-password', 'Authorization', 'Basic']) {
    assert(!serialized.includes(secret), `retry event leaked ${secret}`);
  }
}

test('a recoverable partial body resumes only missing bytes and fits the original exact budget', OPTIONS, async t => {
  for (const mode of ['recover', 'disconnect']) await t.test(mode, async t => {
    const source = await fixture(t, { mode }), lease = leaseFor(t, source), events = [];
    const output = await lease.read(START, LENGTH, undefined, { maxAttempts: 3, onRetry: event => events.push(event) });
    assert.deepEqual(output, source.bytes.subarray(START, START + LENGTH), 'resumed output must contain each original byte exactly once');
    assert.deepEqual(source.mediaRequests.map(({ start, end }) => [start, end]), [[START, START + LENGTH - 1], [START + PARTIAL, START + LENGTH - 1]]);
    assert(source.mediaRequests.every(request => request.ifMatch === '"synthetic-v1"'));
    assert.equal(lease.metrics.requests, 2);
    assert.equal(lease.metrics.receivedBytes, LENGTH);
    assert.equal(lease.metrics.reservedBytes, 0);
    assert.equal(lease.error, null, 'a recovered intermediate transport error must not remain sticky');
    assert.equal(events.length, 1);
    assertRetryEvent(events[0], { attempt: 2, maxAttempts: 3, remainingBytes: LENGTH - PARTIAL, receivedBytes: PARTIAL, delayMs: 250 }, source);
    await lease.settle();
  });
});

test('recovery stops at three attempts and accounts only for the accepted prefixes', OPTIONS, async t => {
  const source = await fixture(t, { mode: 'always-stall' }), lease = leaseFor(t, source), events = [];
  await assert.rejects(lease.read(START, LENGTH, undefined, { maxAttempts: 3, onRetry: event => events.push(event) }), error => {
    assert(failure('TIMEOUT')(error)); assert.equal(lease.error, error); return true;
  });
  assert.deepEqual(source.mediaRequests.map(({ start, end }) => [start, end]), [0, 1, 2].map(attempt => [START + attempt * PARTIAL, START + LENGTH - 1]));
  assert.equal(lease.metrics.requests, 3); assert.equal(lease.metrics.receivedBytes, 3 * PARTIAL); assert.equal(lease.metrics.reservedBytes, 0);
  assert.equal(events.length, 2);
  for (let i = 0; i < events.length; i++) assertRetryEvent(events[i], {
    attempt: i + 2, maxAttempts: 3, remainingBytes: LENGTH - (i + 1) * PARTIAL,
    receivedBytes: (i + 1) * PARTIAL, delayMs: i === 0 ? 250 : 1000,
  }, source);
  const stable = structuredClone(lease.metrics); await lease.settle();
  assert.deepEqual(lease.metrics, stable);
});

test('the default remains one attempt and invalid attempt settings dispatch no media request', OPTIONS, async t => {
  const source = await fixture(t, { mode: 'always-stall' }), lease = leaseFor(t, source);
  for (const maxAttempts of [0, 4, 1.5, NaN, '3', null]) {
    await assert.rejects(lease.read(START, LENGTH, undefined, { maxAttempts }), failure('READ_OPTIONS_INVALID'));
  }
  for (const options of [null, [], { onRetry: 3 }]) await assert.rejects(lease.read(START, LENGTH, undefined, options), failure('READ_OPTIONS_INVALID'));
  assert.equal(lease.error, null, 'configuration mistakes must not mark a source lease as a transport failure');
  assert.equal(source.mediaRequests.length, 0);
  await assert.rejects(lease.read(START, LENGTH), failure('TIMEOUT'));
  assert.equal(source.mediaRequests.length, 1); assert.equal(lease.metrics.receivedBytes, PARTIAL);
});

test('invalid metadata, authentication, and clean short EOF never trigger transport recovery', OPTIONS, async t => {
  for (const [mode, code, received] of [['wrong-range', 'RANGE_INVALID', 0], ['auth', 'AUTH_REQUIRED', 0], ['clean-short', 'RANGE_INVALID', LENGTH - 1]]) await t.test(mode, async t => {
    const source = await fixture(t, { mode }), lease = leaseFor(t, source), events = [];
    await assert.rejects(lease.read(START, LENGTH, undefined, { maxAttempts: 3, onRetry: event => events.push(event) }), failure(code));
    assert.equal(source.mediaRequests.length, 1); assert.equal(events.length, 0);
    assert.equal(lease.metrics.receivedBytes, received); assert.equal(lease.metrics.reservedBytes, 0);
  });
});

test('a version change during recovery rejects the new response without accepting mixed-source bytes', OPTIONS, async t => {
  const source = await fixture(t, { mode: 'changed-on-retry' }), lease = leaseFor(t, source), events = [];
  await assert.rejects(lease.read(START, LENGTH, undefined, { maxAttempts: 3, onRetry: event => events.push(event) }), failure('SOURCE_CHANGED'));
  assert.equal(source.mediaRequests.length, 2); assert.equal(events.length, 1);
  assert.equal(source.mediaRequests[1].start, START + PARTIAL);
  assert.equal(lease.metrics.receivedBytes, PARTIAL, 'bytes of the changed version must not be accepted');
  assert.equal(lease.metrics.reservedBytes, 0);
});

test('cancelling a retry notification interrupts backoff before another request', OPTIONS, async t => {
  const source = await fixture(t, { mode: 'cancel' }), lease = leaseFor(t, source), controller = new AbortController(), events = [];
  await assert.rejects(lease.read(START, LENGTH, controller.signal, { maxAttempts: 3, onRetry: event => {
    events.push(event); controller.abort();
  } }), failure('CANCELLED'));
  assert.equal(events.length, 1); assert.equal(source.mediaRequests.length, 1);
  assert.equal(lease.metrics.receivedBytes, PARTIAL); assert.equal(lease.metrics.reservedBytes, 0);
  await lease.settle(); const stable = structuredClone(lease.metrics);
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.deepEqual(lease.metrics, stable); assert.equal(source.mediaRequests.length, 1);
});

test('an insufficient aggregate budget never dispatches or retries a logical read', OPTIONS, async t => {
  const source = await fixture(t), lease = leaseFor(t, source, LENGTH - 1), events = [];
  await assert.rejects(lease.read(START, LENGTH, undefined, { maxAttempts: 3, onRetry: event => events.push(event) }), failure('BUDGET_EXCEEDED'));
  assert.equal(source.mediaRequests.length, 0); assert.equal(events.length, 0);
  assert.equal(lease.metrics.receivedBytes, 0); assert.equal(lease.metrics.reservedBytes, 0);
});

function element(id, payload) {
  const raw = Buffer.from(id, 'hex'); let width = 1;
  while (payload.length >= 2 ** (7 * width) - 1) width++;
  let value = BigInt(payload.length) | (1n << BigInt(7 * width)); const size = Buffer.alloc(width);
  for (let i = width - 1; i >= 0; i--) { size[i] = Number(value & 255n); value >>= 8n; }
  return Buffer.concat([raw, size, payload]);
}

test('window materialization survives a recovered range and removes its private file on cleanup', OPTIONS, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-recovered-window-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const prefix = Buffer.concat([element('1a45dfa3', Buffer.from([0x42])), Buffer.from('1853806701ffffffffffffff', 'hex'),
    element('1549a966', Buffer.from([0x42])), element('1654ae6b', Buffer.from([0x42]))]);
  const cluster = element('1f43b675', Buffer.alloc(65536 + 257, 0x3a)), bytes = Buffer.alloc(START + cluster.length + 16384);
  cluster.copy(bytes, START);
  const source = await fixture(t, { bytes, partial: 1024 }), lease = leaseFor(t, source, cluster.length), events = [];
  const output = await materializeMatroskaWindow({ directory, budgetBytes: cluster.length,
    plan: { prefix, sourceStart: START, sourceEnd: START + cluster.length, timelineStartSeconds: 60, timelineEndSeconds: 61 },
    read: (start, length, signal) => lease.read(start, length, signal, { maxAttempts: 3, onRetry: event => events.push(event) }),
  });
  t.after(output.cleanup);
  assert.deepEqual(await readFile(output.path), Buffer.concat([prefix, cluster]));
  assert.equal(lease.error, null); assert.equal(lease.metrics.receivedBytes, cluster.length); assert.equal(events.length, 1);
  assert.equal(source.mediaRequests[1].start, START + 1024);
  await output.cleanup(); await output.cleanup();
  assert.deepEqual(await readdir(directory), []);
});
