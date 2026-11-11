import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRemoteSource } from '../src/remote.mjs';
import { openResumeStore } from '../src/resume-store.mjs';

const MiB = 1024 * 1024, START = 65536, LENGTH = 4 * MiB, PARTIAL = MiB + 777;
const OPTIONS = { timeout: 15_000 };
const BYTES = Buffer.alloc(START + 8 * MiB);
for (let i = 0; i < BYTES.length; i++) BYTES[i] = i % 251;
const tick = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function fixture(t) {
  const requests = [], media = [], state = { mode: 'valid', etag: '"batch-v1"', onMedia: null };
  const server = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    assert(match, 'all requests must remain strictly bounded');
    const start = Number(match[1]), end = Number(match[2]), length = end - start + 1;
    assert(start >= 0 && end < BYTES.length && length > 0 && length <= LENGTH);
    const request = { start, end, ifMatch: req.headers['if-match'] };
    requests.push(request);
    const bootstrap = start === 0 && end === 16383;
    if (!bootstrap) media.push(request);
    const mode = bootstrap ? 'valid' : state.mode;
    if (mode === 'ignore-range') { res.writeHead(200).end(); return; }
    const changedOnRetry = mode === 'changed-on-retry' && media.length > 1;
    const etag = mode === 'missing-etag' ? null : changedOnRetry ? '"batch-v2"' : state.etag;
    res.writeHead(206, {
      'Content-Range': `bytes ${mode === 'wrong-range' ? start + 1 : start}-${end}/${BYTES.length}`,
      'Content-Length': mode === 'wrong-length' ? length - 1 : length,
      ...(mode === 'compressed' ? { 'Content-Encoding': 'gzip' } : {}),
      ...(etag ? { ETag: etag } : {}),
    });
    if (!bootstrap) state.onMedia?.({ req, res, start, end });
    if (mode === 'hold') { res.flushHeaders(); return; }
    const interrupted = mode === 'always-disconnect' || ['disconnect', 'changed-on-retry'].includes(mode) && media.length === 1;
    if (interrupted) {
      res.flushHeaders();
      res.write(BYTES.subarray(start, start + Math.min(PARTIAL, length - 1)), () => {
        const timer = setTimeout(() => res.destroy(), 25);
        res.once('close', () => clearTimeout(timer));
      });
      return;
    }
    res.end(BYTES.subarray(start, end + 1));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const session = await createRemoteSource({ url: `http://127.0.0.1:${server.address().port}/synthetic.mkv`,
    initialRanges: 'head', budgetBytes: 65536, requestTimeoutMs: 1000 });
  return { server, session, requests, media, state };
}

function leaseFor(t, source, options = {}) {
  const lease = source.session.createLease({ readChunkBytes: LENGTH, budgetBytes: LENGTH, ...options });
  t.after(() => lease.settle()); return lease;
}

test('direct reads opt into exactly 1, 2 or 4 MiB without changing the 4 MiB logical bound', OPTIONS, async t => {
  const source = await fixture(t), before = source.requests.length;
  for (const readChunkBytes of [null, 0, 65536, MiB - 1, MiB + 1, 3 * MiB, 5 * MiB, NaN, Infinity, '4194304', {}, []]) {
    assert.throws(() => source.session.createLease({ readChunkBytes }), { code: 'READ_CHUNK_INVALID' });
  }
  assert.equal(source.requests.length, before);
  const lease = leaseFor(t, source);
  await assert.rejects(lease.read(START, LENGTH + 1), { code: 'RANGE_INVALID' });
  assert.equal(source.media.length, 0);
});

test('the default uses four requests while 2 and 4 MiB reads return identical exact bytes with fewer requests', OPTIONS, async t => {
  for (const [readChunkBytes, count] of [[undefined, 4], [2 * MiB, 2], [LENGTH, 1]]) {
    const source = await fixture(t);
    const lease = source.session.createLease({ readChunkBytes, budgetBytes: LENGTH });
    t.after(() => lease.settle());
    assert.deepEqual(await lease.read(START, LENGTH), BYTES.subarray(START, START + LENGTH));
    assert.equal(source.media.length, count);
    assert.equal(lease.metrics.requests, count);
    assert.equal(lease.metrics.receivedBytes, LENGTH);
    assert.equal(lease.metrics.reservedBytes, 0);
    const chunk = readChunkBytes ?? MiB;
    assert.deepEqual(source.media.map(({ start, end }) => [start, end]),
      Array.from({ length: count }, (_, i) => [START + i * chunk, START + (i + 1) * chunk - 1]));
    assert(source.media.every(request => request.ifMatch === '"batch-v1"'));
  }
});

test('large direct read settings leave source checks and forwarded media at their existing limits', OPTIONS, async t => {
  const source = await fixture(t), lease = leaseFor(t, source, { budgetBytes: 2 * MiB });
  assert.deepEqual(source.requests.map(({ start, end }) => [start, end]), [[0, 16383]]);
  await source.session.check();
  assert.deepEqual(source.requests.at(-1), { start: 0, end: 127, ifMatch: '"batch-v1"' });
  const proxy = http.createServer((req, res) => lease.serve(req, res));
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  t.after(async () => { proxy.closeAllConnections(); await new Promise(resolve => proxy.close(resolve)); });
  const response = await fetch(`http://127.0.0.1:${proxy.address().port}/media`, { headers: { Range: `bytes=${START}-${START + 2 * MiB - 1}` } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), BYTES.subarray(START, START + 2 * MiB));
  assert.deepEqual(source.media.slice(1).map(({ start, end }) => [start, end]),
    [[START, START + MiB - 1], [START + MiB, START + 2 * MiB - 1]]);
});

test('a 4 MiB interruption keeps a verified prefix above 1 MiB and persists only actual bytes across retries', OPTIONS, async t => {
  const source = await fixture(t), directory = await mkdtemp(path.join(os.tmpdir(), 'clip-large-read-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const args = { directory, id: 'batch-resume', identity: { sourceKey: 'a'.repeat(64), ...source.session.resumeIdentity },
    plan: { version: 1, sourceStart: START, sourceEnd: START + LENGTH, prefixSha256: 'b'.repeat(64), timelineStartSeconds: 10, timelineEndSeconds: 20 },
    budgetBytes: LENGTH, maxCacheBytes: LENGTH };
  const store = await openResumeStore(args), events = [];
  t.after(() => store.close());
  const reservations = [], settlements = [];
  const accounting = {
    async reserve(bytes) {
      const ticket = await store.reserve(bytes);
      const snapshot = store.snapshot();
      reservations.push({ bytes, mediaCount: source.media.length, chargedBytes: snapshot.chargedBytes, reservedBytes: snapshot.reservedBytes });
      return ticket;
    },
    async settle(ticket, bytes) { settlements.push(bytes); await store.settle(ticket, bytes); },
  };
  source.state.mode = 'disconnect';
  const lease = leaseFor(t, source, { accounting, requireStrongValidator: true });
  assert.deepEqual(await lease.read(START, LENGTH, undefined, { maxAttempts: 3, onRetry: event => events.push(event) }),
    BYTES.subarray(START, START + LENGTH));
  await lease.settle();
  assert.deepEqual(source.media.map(({ start, end }) => [start, end]), [[START, START + LENGTH - 1], [START + PARTIAL, START + LENGTH - 1]]);
  assert.deepEqual(reservations, [
    { bytes: LENGTH, mediaCount: 0, chargedBytes: LENGTH, reservedBytes: LENGTH },
    { bytes: LENGTH - PARTIAL, mediaCount: 1, chargedBytes: LENGTH, reservedBytes: LENGTH - PARTIAL },
  ]);
  assert.deepEqual(settlements, [PARTIAL, LENGTH - PARTIAL]);
  assert.equal(events.length, 1); assert.equal(events[0].receivedBytes, PARTIAL); assert.equal(events[0].remainingBytes, LENGTH - PARTIAL);
  assert.equal(lease.metrics.receivedBytes, LENGTH); assert.equal(lease.metrics.reservedBytes, 0); assert.equal(lease.metrics.requests, 2);
  assert.equal(store.snapshot().receivedBytes, LENGTH); assert.equal(store.snapshot().chargedBytes, LENGTH);
  assert.equal(store.snapshot().requests, 2); assert.equal(store.snapshot().reservedBytes, 0);
  await store.close();
  const reopened = await openResumeStore(args); t.after(() => reopened.close());
  assert.equal(reopened.snapshot().chargedBytes, LENGTH); assert.equal(reopened.snapshot().remainingBytes, 0);
  await assert.rejects(reopened.reserve(1), { code: 'BUDGET_EXCEEDED' });
});

test('each large response must pass strict headers and strong ETag before any payload is accepted', OPTIONS, async t => {
  for (const [mode, code] of [['ignore-range', 'RANGE_UNSUPPORTED'], ['wrong-range', 'RANGE_INVALID'], ['wrong-length', 'RANGE_INVALID'], ['compressed', 'RANGE_INVALID'], ['missing-etag', 'SOURCE_CHANGED'], ['changed-etag', 'SOURCE_CHANGED']]) {
    await t.test(mode, async t => {
      const source = await fixture(t), calls = [];
      source.state.mode = mode;
      if (mode === 'changed-etag') source.state.etag = '"batch-v2"';
      const lease = leaseFor(t, source, { requireStrongValidator: true,
        accounting: { async reserve(bytes) { calls.push(['reserve', bytes]); return 'ticket'; }, async settle(ticket, bytes) { calls.push(['settle', ticket, bytes]); } } });
      await assert.rejects(lease.read(START, LENGTH, undefined, { maxAttempts: 3 }), { code });
      assert.equal(source.media.length, 1); assert.equal(lease.metrics.receivedBytes, 0); assert.equal(lease.metrics.reservedBytes, 0);
      assert.deepEqual(calls, [['reserve', LENGTH], ['settle', 'ticket', 0]]);
    });
  }
});

test('a changed large retry response cannot combine bytes from two source versions', OPTIONS, async t => {
  const source = await fixture(t); source.state.mode = 'changed-on-retry';
  const lease = leaseFor(t, source, { requireStrongValidator: true });
  await assert.rejects(lease.read(START, LENGTH, undefined, { maxAttempts: 3 }), { code: 'SOURCE_CHANGED' });
  assert.equal(source.media.length, 2); assert.equal(source.media[1].start, START + PARTIAL);
  assert.equal(lease.metrics.receivedBytes, PARTIAL); assert.equal(lease.metrics.reservedBytes, 0);
});

test('the larger physical range still stops after three interrupted attempts with no duplicated prefix', OPTIONS, async t => {
  const source = await fixture(t); source.state.mode = 'always-disconnect';
  const lease = leaseFor(t, source), events = [];
  await assert.rejects(lease.read(START, LENGTH, undefined, { maxAttempts: 3, onRetry: event => events.push(event) }), { code: 'RANGE_INVALID' });
  assert.equal(source.media.length, 3); assert.equal(events.length, 2);
  assert.deepEqual(source.media.map(({ start, end }) => [start, end]),
    [0, 1, 2].map(index => [START + index * PARTIAL, START + LENGTH - 1]));
  assert.equal(lease.metrics.receivedBytes, 3 * PARTIAL); assert.equal(lease.metrics.reservedBytes, 0);
});

test('an insufficient or concurrent budget cannot dispatch a partially reserved 4 MiB request', OPTIONS, async t => {
  const source = await fixture(t), tooSmall = leaseFor(t, source, { budgetBytes: LENGTH - 1 });
  await assert.rejects(tooSmall.read(START, LENGTH), { code: 'BUDGET_EXCEEDED' });
  assert.equal(source.media.length, 0); assert.equal(tooSmall.metrics.reservedBytes, 0);
  source.state.mode = 'hold';
  let ready, response;
  const dispatched = new Promise(resolve => { ready = resolve; });
  source.state.onMedia = ({ res }) => { response = res; ready(); };
  const lease = leaseFor(t, source), pending = lease.read(START, LENGTH);
  await dispatched;
  assert.equal(lease.metrics.reservedBytes, LENGTH);
  await assert.rejects(lease.read(START + LENGTH, LENGTH), { code: 'BUDGET_EXCEEDED' });
  assert.equal(source.media.length, 1);
  response.end(BYTES.subarray(START, START + LENGTH));
  assert.deepEqual(await pending, BYTES.subarray(START, START + LENGTH));
  assert.equal(lease.metrics.receivedBytes, LENGTH); assert.equal(lease.metrics.reservedBytes, 0);
});

test('a failed durable 4 MiB reservation prevents HTTP dispatch', OPTIONS, async t => {
  const source = await fixture(t);
  let reserveBytes, settled = false;
  const lease = leaseFor(t, source, { requireStrongValidator: true,
    accounting: { async reserve(bytes) { reserveBytes = bytes; throw new Error('synthetic disk failure'); }, async settle() { settled = true; } } });
  await assert.rejects(lease.read(START, LENGTH), { code: 'RESUME_WRITE_FAILED' });
  assert.equal(reserveBytes, LENGTH); assert.equal(settled, false); assert.equal(source.media.length, 0);
  assert.equal(lease.metrics.requests, 0); assert.equal(lease.metrics.reservedBytes, 0);
});

test('cancellation after a durable large reservation settles zero bytes before dispatch', OPTIONS, async t => {
  const source = await fixture(t), controller = new AbortController(), calls = [];
  const lease = leaseFor(t, source, { accounting: {
    async reserve(bytes) { calls.push(['reserve', bytes]); controller.abort(); return 'cancelled-ticket'; },
    async settle(ticket, bytes) { calls.push(['settle', ticket, bytes]); },
  } });
  await assert.rejects(lease.read(START, LENGTH, controller.signal), { code: 'CANCELLED' });
  assert.deepEqual(calls, [['reserve', LENGTH], ['settle', 'cancelled-ticket', 0]]);
  assert.equal(source.media.length, 0); assert.equal(lease.metrics.receivedBytes, 0); assert.equal(lease.metrics.reservedBytes, 0);
});

test('cancelling a receiving large response settles only accepted bytes and never retries', OPTIONS, async t => {
  const source = await fixture(t), controller = new AbortController(), calls = [];
  source.state.mode = 'hold';
  source.state.onMedia = ({ res }) => res.write(BYTES.subarray(START, START + PARTIAL));
  const lease = leaseFor(t, source, { accounting: {
    async reserve(bytes) { calls.push(['reserve', bytes]); return 'active-ticket'; },
    async settle(ticket, bytes) { calls.push(['settle', ticket, bytes]); },
  } });
  const pending = lease.read(START, LENGTH, controller.signal, { maxAttempts: 3 });
  const rejected = assert.rejects(pending, { code: 'CANCELLED' });
  for (let i = 0; i < 200 && lease.metrics.receivedBytes < PARTIAL; i++) await tick(5);
  assert.equal(lease.metrics.receivedBytes, PARTIAL);
  controller.abort(); await rejected; await lease.settle();
  assert.equal(source.media.length, 1); assert.equal(lease.metrics.reservedBytes, 0);
  assert.deepEqual(calls, [['reserve', LENGTH], ['settle', 'active-ticket', PARTIAL]]);
});
