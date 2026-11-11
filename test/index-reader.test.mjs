import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndexReader } from '../src/index-reader.mjs';

const MiB = 1024 * 1024;

// Model createRemoteSource's default direct-read contract: one physical Range
// per 1 MiB, maxAttempts=1, and counters updated for failed partial bodies.
function controlledLease({ receivedBytes = 0, requests = 0 } = {}) {
  const dispatches = [], state = { failAt: null, partialBytes: 0, onDispatch: null };
  const metrics = { receivedBytes, requests };
  const lease = {
    metrics,
    async read(start, length, signal) {
      const parts = [];
      for (let offset = 0; offset < length; offset += MiB) {
        signal?.throwIfAborted();
        const size = Math.min(MiB, length - offset);
        metrics.requests++;
        dispatches.push({ start: start + offset, length: size });
        await state.onDispatch?.();
        if (dispatches.length === state.failAt) {
          metrics.receivedBytes += Math.min(state.partialBytes, size);
          throw state.failure;
        }
        metrics.receivedBytes += size;
        parts.push(Buffer.alloc(size));
      }
      return Buffer.concat(parts, length);
    },
  };
  return { lease, dispatches, state };
}

test('index limit reserves every physical chunk before a greater-than-1 MiB read', async () => {
  const { lease, dispatches } = controlledLease(), read = createIndexReader({ lease });
  for (let i = 0; i < 62; i++) await read(i, 1);
  await read(1000, MiB + 1);
  assert.equal(dispatches.length, 64);
  assert.deepEqual(dispatches.slice(-2), [{ start: 1000, length: MiB }, { start: 1000 + MiB, length: 1 }]);
  await assert.rejects(read(2000, 1), { code: 'INDEX_LIMIT' });
  assert.equal(dispatches.length, 64);

  const other = controlledLease(), blocked = createIndexReader({ lease: other.lease });
  for (let i = 0; i < 63; i++) await blocked(i, 1);
  await assert.rejects(blocked(1000, MiB + 1), { code: 'INDEX_LIMIT' });
  assert.equal(other.dispatches.length, 63, 'reject before dispatching even the first chunk of an oversized reservation');
});

test('fresh complete head shares the exact 4 MiB byte allowance', async () => {
  const { lease, dispatches } = controlledLease({ receivedBytes: 321, requests: 7 });
  const read = createIndexReader({ lease });
  await read(0, 16384);
  await assert.rejects(read(16384, 4 * MiB), { code: 'INDEX_LIMIT' });
  assert.equal(dispatches.length, 1);
  await read(16384, 4 * MiB - 16384);
  assert.equal(lease.metrics.receivedBytes, 321 + 4 * MiB);
  assert.equal(lease.metrics.requests, 7 + 5);
  await assert.rejects(read(4 * MiB, 1), { code: 'INDEX_LIMIT' });
  assert.equal(dispatches.length, 5);
});

test('a failed logical read keeps completed chunks and its partial body charged', async () => {
  const { lease, dispatches, state } = controlledLease();
  state.failAt = 2; state.partialBytes = 128;
  state.failure = Object.assign(new Error('fixture body interrupted'), { code: 'TIMEOUT' });
  const read = createIndexReader({ lease });
  await assert.rejects(read(0, 3 * MiB), error => error === state.failure);
  assert.equal(lease.metrics.receivedBytes, MiB + 128);
  assert.equal(lease.metrics.requests, 2);
  await assert.rejects(read(5 * MiB, 3 * MiB), { code: 'INDEX_LIMIT' });
  assert.equal(dispatches.length, 2);
  state.failAt = null;
  await read(5 * MiB, 3 * MiB - 128);
  assert.equal(lease.metrics.receivedBytes, 4 * MiB);
  assert.equal(lease.metrics.requests, 5);
  await assert.rejects(read(0, 1), { code: 'INDEX_LIMIT' });
});

test('a failed dispatch consumes its request slot even with no returned bytes', async () => {
  const { lease, dispatches, state } = controlledLease(), read = createIndexReader({ lease });
  for (let i = 0; i < 62; i++) await read(i, 1);
  state.failAt = 64; state.failure = new Error('fixture disconnected before body');
  await assert.rejects(read(1000, MiB + 1), error => error === state.failure);
  assert.equal(lease.metrics.requests, 64);
  assert.equal(lease.metrics.receivedBytes, 62 + MiB);
  await assert.rejects(read(0, 1), { code: 'INDEX_LIMIT' });
  assert.equal(dispatches.length, 64);
});

test('pre-cancelled read preserves the abort reason and makes no dispatch', async () => {
  const { lease, dispatches } = controlledLease(), controller = new AbortController();
  const read = createIndexReader({ lease, signal: controller.signal });
  const reason = new Error('fixture index cancelled'); controller.abort(reason);
  await assert.rejects(read(0, 16384), error => error === reason);
  assert.equal(dispatches.length, 0);
});

test('dedicated reader refuses overlapping callers before dispatch', async () => {
  const { lease, dispatches, state } = controlledLease();
  let release;
  state.onDispatch = () => new Promise(resolve => { release = resolve; });
  const read = createIndexReader({ lease }), pending = read(0, 1);
  await assert.rejects(read(1, 1), { code: 'INDEX_LIMIT' });
  assert.equal(dispatches.length, 1);
  release(); await pending;
});

test('invalid inputs and reset counters fail closed without new dispatch', async () => {
  assert.throws(() => createIndexReader(), { code: 'INDEX_READER_INVALID' });
  assert.throws(() => createIndexReader({ lease: { read() {}, metrics: { receivedBytes: NaN, requests: 0 } } }), { code: 'INDEX_READER_INVALID' });
  const { lease, dispatches } = controlledLease(), read = createIndexReader({ lease });
  for (const [start, length] of [[-1, 1], [0, 0], [0, NaN], [Number.MAX_SAFE_INTEGER, 1]])
    await assert.rejects(read(start, length), { code: 'RANGE_INVALID' });
  await assert.rejects(read(0, 4 * MiB + 1), { code: 'INDEX_LIMIT' });
  assert.equal(dispatches.length, 0);
  await read(0, 1);
  lease.metrics.receivedBytes = 0; lease.metrics.requests = 0;
  await assert.rejects(read(0, 1), { code: 'INDEX_LIMIT' });
  assert.equal(dispatches.length, 1);
});
