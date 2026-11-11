import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRemoteSource } from '../src/remote.mjs';
import { openResumeStore } from '../src/resume-store.mjs';

const START = 32768, WIDTH = 4096;
const BYTES = Buffer.from(Array.from({ length: 128 * 1024 }, (_, i) => i % 251));
const OPTIONS = { timeout: 10_000 };
const observe = promise => promise.then(value => ({ value }), error => ({ error }));
async function until(check) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('controlled budget fixture did not reach the expected state');
}

async function fixture(t, { contentLength = true, changedStart } = {}) {
  const media = [];
  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    assert(match, 'every request must retain a finite byte range');
    const start = Number(match[1]), end = Number(match[2]);
    assert(start >= 0 && end >= start && end < BYTES.length);
    const bootstrap = start === 0 && end === 16383;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${BYTES.length}`,
      ...(bootstrap || contentLength ? { 'Content-Length': end - start + 1 } : {}),
      ETag: !bootstrap && start === changedStart ? '"budget-v2"' : '"budget-v1"',
    });
    if (bootstrap) { res.end(BYTES.subarray(start, end + 1)); return; }
    media.push({ req, res, start, end });
    res.flushHeaders();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const source = await createRemoteSource({ url: `http://127.0.0.1:${server.address().port}/budget.mkv`,
    initialRanges: 'head', budgetBytes: 16384, requestTimeoutMs: 3000 });
  return { source, media };
}

function leaseFor(t, source, budgetBytes, options) {
  const lease = source.createLease({ budgetBytes, ...options });
  t.after(() => lease.settle());
  return lease;
}
function write(request, offset, length) {
  request.res.write(BYTES.subarray(request.start + offset, request.start + offset + length));
}
function finish(request, offset = 0) {
  request.res.end(BYTES.subarray(request.start + offset, request.end + 1));
}
function counts(lease, received, reserved) {
  assert.equal(lease.metrics.receivedBytes, received);
  assert.equal(lease.metrics.reservedBytes, reserved);
}

test('interleaved reads share an exact budget without counting received bytes twice', OPTIONS, async t => {
  const f = await fixture(t), lease = leaseFor(t, f.source, 2 * WIDTH);
  const first = observe(lease.read(START, WIDTH)), second = observe(lease.read(START + WIDTH, WIDTH));
  await until(() => f.media.length === 2);
  counts(lease, 0, 2 * WIDTH);
  write(f.media[0], 0, 1024);
  await until(() => lease.metrics.receivedBytes === 1024);
  counts(lease, 1024, 2 * WIDTH - 1024);
  write(f.media[1], 0, 1536);
  await until(() => lease.metrics.receivedBytes === 2560);
  counts(lease, 2560, 2 * WIDTH - 2560);
  await assert.rejects(lease.read(START + 2 * WIDTH, 1), { code: 'BUDGET_EXCEEDED' });
  assert.equal(f.media.length, 2, 'a third range must not exceed the fully allocated budget');
  finish(f.media[1], 1536);
  assert.deepEqual((await second).value, BYTES.subarray(START + WIDTH, START + 2 * WIDTH));
  counts(lease, WIDTH + 1024, WIDTH - 1024);
  finish(f.media[0], 1024);
  assert.deepEqual((await first).value, BYTES.subarray(START, START + WIDTH));
  counts(lease, 2 * WIDTH, 0);
  assert.equal(lease.metrics.requests, 2);
  assert(f.media.every(item => item.req.headers['if-match'] === '"budget-v1"'));
});

test('partial responses do not falsely consume the capacity for a third bounded read', OPTIONS, async t => {
  const f = await fixture(t), lease = leaseFor(t, f.source, 3 * WIDTH);
  const readings = [observe(lease.read(START, WIDTH)), observe(lease.read(START + WIDTH, WIDTH))];
  await until(() => f.media.length === 2);
  for (const request of f.media) write(request, 0, 3072);
  await until(() => lease.metrics.receivedBytes === 6144);
  counts(lease, 6144, 2048);
  readings.push(observe(lease.read(START + 2 * WIDTH, WIDTH)));
  await until(() => f.media.length === 3);
  counts(lease, 6144, 6144);
  finish(f.media[0], 3072); finish(f.media[1], 3072); finish(f.media[2]);
  const outcomes = await Promise.all(readings);
  for (let i = 0; i < outcomes.length; i++) assert.deepEqual(outcomes[i].value,
    BYTES.subarray(START + i * WIDTH, START + (i + 1) * WIDTH));
  counts(lease, 3 * WIDTH, 0);
  assert.equal(lease.error, null);
});

test('a clean short response releases only its own unreceived reservation', OPTIONS, async t => {
  const f = await fixture(t, { contentLength: false }), lease = leaseFor(t, f.source, 2 * WIDTH);
  const first = observe(lease.read(START, WIDTH, undefined, { maxAttempts: 3 }));
  const second = observe(lease.read(START + WIDTH, WIDTH));
  await until(() => f.media.length === 2);
  write(f.media[0], 0, 1024); write(f.media[1], 0, 1024);
  await until(() => lease.metrics.receivedBytes === 2048);
  f.media[0].res.end(BYTES.subarray(START + 1024, START + 2048));
  assert.equal((await first).error?.code, 'RANGE_INVALID');
  counts(lease, 3072, WIDTH - 1024);
  assert.equal(f.media.length, 2, 'a clean short EOF is never retried');
  finish(f.media[1], 1024);
  assert.deepEqual((await second).value, BYTES.subarray(START + WIDTH, START + 2 * WIDTH));
  counts(lease, WIDTH + 2048, 0);
});

test('an overlong body cannot make reservations negative or release a sibling reservation', OPTIONS, async t => {
  const f = await fixture(t, { contentLength: false }), lease = leaseFor(t, f.source, 2 * WIDTH);
  const first = observe(lease.read(START, WIDTH, undefined, { maxAttempts: 3 }));
  const second = observe(lease.read(START + WIDTH, WIDTH));
  await until(() => f.media.length === 2);
  write(f.media[1], 0, 1024);
  await until(() => lease.metrics.receivedBytes === 1024);
  f.media[0].res.end(BYTES.subarray(START, START + WIDTH + 1));
  assert.equal((await first).error?.code, 'RANGE_INVALID');
  counts(lease, WIDTH + 1025, WIDTH - 1024);
  assert.equal(f.media.length, 2, 'an overlong body is never retried');
  lease.close();
  assert.equal((await second).error?.code, 'CANCELLED');
  await lease.settle();
  counts(lease, WIDTH + 1025, 0);
});

async function storeFor(t, source) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-concurrent-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { directory, id: 'concurrent-budget', budgetBytes: 2 * WIDTH,
    identity: { sourceKey: 'a'.repeat(64), ...source.resumeIdentity },
    plan: { version: 1, sourceStart: START, sourceEnd: START + 2 * WIDTH,
      prefixSha256: 'b'.repeat(64), timelineStartSeconds: 60, timelineEndSeconds: 61 } };
  const store = await openResumeStore(options);
  t.after(() => store.close());
  return { store, options, accounting: { reserve: bytes => store.reserve(bytes), settle: (ticket, received) => store.settle(ticket, received) } };
}

test('cancellation settles interleaved bytes while durable reservations stay conservative in flight', OPTIONS, async t => {
  const f = await fixture(t), saved = await storeFor(t, f.source), controller = new AbortController();
  const lease = leaseFor(t, f.source, 2 * WIDTH, { signal: controller.signal,
    requireStrongValidator: true, accounting: saved.accounting });
  const readings = [observe(lease.read(START, WIDTH)), observe(lease.read(START + WIDTH, WIDTH))];
  await until(() => f.media.length === 2);
  write(f.media[0], 0, 1024); write(f.media[1], 0, 2048);
  await until(() => lease.metrics.receivedBytes === 3072);
  counts(lease, 3072, 2 * WIDTH - 3072);
  assert.equal(saved.store.snapshot().receivedBytes, 0);
  assert.equal(saved.store.snapshot().reservedBytes, 2 * WIDTH,
    'crash accounting keeps the original full reservations until transport settlement');
  assert.equal(saved.store.snapshot().remainingBytes, 0);
  controller.abort(); await lease.settle();
  for (const outcome of await Promise.all(readings)) assert.equal(outcome.error?.code, 'CANCELLED');
  counts(lease, 3072, 0);
  assert.equal(saved.store.snapshot().receivedBytes, 3072);
  assert.equal(saved.store.snapshot().reservedBytes, 0);
  assert.equal(saved.store.snapshot().remainingBytes, 2 * WIDTH - 3072);
  await saved.store.close();
  const reopened = await openResumeStore(saved.options); t.after(() => reopened.close());
  assert.equal(reopened.snapshot().receivedBytes, 3072);
  assert.equal(reopened.snapshot().uncertainBytes, 0);
  assert.equal(reopened.snapshot().reservedBytes, 0);
  const settled = structuredClone(lease.metrics);
  await assert.rejects(lease.read(START, 1), { code: 'CANCELLED' });
  assert.deepEqual(lease.metrics, settled);
});

test('an interrupted read retries only its suffix within an exact budget shared with a receiving sibling', OPTIONS, async t => {
  const f = await fixture(t), saved = await storeFor(t, f.source), events = [];
  const lease = leaseFor(t, f.source, 2 * WIDTH, { requireStrongValidator: true, accounting: saved.accounting });
  const first = observe(lease.read(START, WIDTH, undefined, { maxAttempts: 2, onRetry: event => events.push(event) }));
  const second = observe(lease.read(START + WIDTH, WIDTH));
  await until(() => f.media.length === 2);
  write(f.media[0], 0, 1024); write(f.media[1], 0, 1024);
  await until(() => lease.metrics.receivedBytes === 2048);
  f.media[0].res.destroy();
  await until(() => f.media.length === 3);
  assert.deepEqual(f.media.map(({ start, end }) => [start, end]),
    [[START, START + WIDTH - 1], [START + WIDTH, START + 2 * WIDTH - 1], [START + 1024, START + WIDTH - 1]]);
  counts(lease, 2048, 2 * WIDTH - 2048);
  assert.equal(events.length, 1); assert.equal(events[0].remainingBytes, WIDTH - 1024);
  assert.equal(saved.store.snapshot().chargedBytes, 2 * WIDTH);
  finish(f.media[2]);
  assert.deepEqual((await first).value, BYTES.subarray(START, START + WIDTH));
  finish(f.media[1], 1024);
  assert.deepEqual((await second).value, BYTES.subarray(START + WIDTH, START + 2 * WIDTH));
  counts(lease, 2 * WIDTH, 0);
  assert.equal(saved.store.snapshot().receivedBytes, 2 * WIDTH);
  assert.equal(saved.store.snapshot().chargedBytes, 2 * WIDTH);
  assert.equal(saved.store.snapshot().reservedBytes, 0);
  assert.equal(lease.metrics.requests, 3); assert.equal(lease.error, null);
});

test('a source version failure remains the lease error after a sibling is cancelled', OPTIONS, async t => {
  const f = await fixture(t, { changedStart: START }), controller = new AbortController();
  const lease = leaseFor(t, f.source, 2 * WIDTH, { requireStrongValidator: true, signal: controller.signal });
  const first = observe(lease.read(START, WIDTH)), second = observe(lease.read(START + WIDTH, WIDTH));
  await until(() => f.media.length === 2);
  const failure = (await first).error;
  assert.equal(failure?.code, 'SOURCE_CHANGED');
  controller.abort();
  assert.equal((await second).error?.code, 'CANCELLED');
  await lease.settle();
  assert.equal(lease.error, failure, 'secondary cancellation must not replace the triggering source error');
  counts(lease, 0, 0);
});
