import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, open, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { materializeMatroskaWindow } from '../src/matroska-window.mjs';
import { openResumeStore } from '../src/resume-store.mjs';

const MiB = 1024 * 1024, sourceStart = 4096, TEST = { timeout: 15000 };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
function sizeBytes(length) {
  for (let width = 1; width <= 8; width++) {
    if (BigInt(length) >= (1n << BigInt(width * 7)) - 1n) continue;
    let value = (1n << BigInt(width * 7)) | BigInt(length);
    const data = Buffer.alloc(width);
    for (let at = width - 1; at >= 0; at--) { data[at] = Number(value & 255n); value >>= 8n; }
    return data;
  }
  throw new Error('fixture too large');
}
const element = (id, payload) => Buffer.concat([Buffer.from(id, 'hex'), sizeBytes(payload.length), payload]);
const prefix = Buffer.concat([element('1a45dfa3', Buffer.from([42])), Buffer.from('1853806701ffffffffffffff', 'hex'),
  element('1549a966', Buffer.from([42])), element('1654ae6b', Buffer.from([42]))]);
function clusterOfTotal(length) {
  for (let width = 1; width <= 8; width++) {
    const payload = length - 4 - width;
    if (payload > 0 && sizeBytes(payload).length === width) {
      const data = element('1f43b675', Buffer.alloc(payload, 42));
      // Different data in each read unit makes a swapped result observable.
      for (let at = MiB; at < data.length; at += MiB) data.fill(42 + at / MiB, at, Math.min(at + MiB, data.length));
      return data;
    }
  }
  throw new Error('invalid fixture length');
}
const planFor = data => ({ prefix, sourceStart, sourceEnd: sourceStart + data.length, timelineStartSeconds: 60, timelineEndSeconds: 90 });
async function directoryFor(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-parallel-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function memoryCache(data, indices = []) {
  const units = new Map(indices.map(index => [sourceStart + index * MiB, Buffer.from(data.subarray(index * MiB, (index + 1) * MiB))]));
  const puts = [];
  return { units, puts,
    has(offset, length) { return units.get(offset)?.length === length; },
    get(offset, length) { return units.get(offset)?.length === length ? Buffer.from(units.get(offset)) : null; },
    put(offset, bytes) { assert(bytes.length <= MiB); puts.push({ offset, length: bytes.length }); units.set(offset, Buffer.from(bytes)); },
  };
}
function bytesAt(data, offset, length) {
  assert(offset >= sourceStart && offset + length <= sourceStart + data.length);
  return data.subarray(offset - sourceStart, offset - sourceStart + length);
}
function waitForAbort(signal, onAbort = () => {}) {
  assert(signal instanceof AbortSignal, 'the transport must receive the internal cancellation signal');
  return new Promise((resolve, reject) => {
    const abort = () => { onAbort(); reject(Object.assign(new Error('transport cancelled'), { code: 'CANCELLED' })); };
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

test('two reads overlap, reverse completion remains ordered, and a blocked head bounds all uncommitted work to two slots', TEST, async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(4 * MiB + 17), cache = memoryCache(data);
  const firstGate = deferred(), secondReturned = deferred(), controller = new AbortController(), calls = [], events = [];
  let live = 0, maximum = 0;
  t.after(() => { firstGate.resolve(); controller.abort(); });
  const operation = materializeMatroskaWindow({ plan: planFor(data), directory, cache, readConcurrency: 2,
    budgetBytes: data.length, signal: controller.signal, onProgress: event => events.push(event),
    read: async (offset, length, signal) => {
      calls.push({ offset, length }); assert(signal instanceof AbortSignal);
      maximum = Math.max(maximum, ++live);
      try {
        if (offset === sourceStart) await firstGate.promise;
        else if (offset === sourceStart + MiB) secondReturned.resolve();
        return bytesAt(data, offset, length);
      } finally { live--; }
    } });
  // Observe rejections immediately, including when an assertion fails below.
  operation.catch(() => {});
  await secondReturned.promise;
  await setImmediate();
  assert.equal(calls.length, 2, 'completed out-of-order bytes still occupy the second slot');
  assert.equal(maximum, 2);
  assert.deepEqual(cache.puts, [], 'later bytes cannot be committed before the first read');
  firstGate.resolve();
  const result = await operation;
  assert.equal(live, 0);
  assert.deepEqual(calls, [0, 1, 2, 3, 4].map(index => ({ offset: sourceStart + index * MiB, length: index === 4 ? 17 : MiB })));
  assert.deepEqual(cache.puts, calls);
  assert.deepEqual(await readFile(result.path), Buffer.concat([prefix, data]));
  assert.deepEqual(events.slice(1, -1).map(event => event.receivedBytes), [MiB, 2 * MiB, 3 * MiB, 4 * MiB, data.length]);
  await result.cleanup();
  assert.deepEqual(await readdir(directory), []);
});

test('parallel 1/2/4 MiB batches retain exact bytes, bounded reads, and 1 MiB cache units', TEST, async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(9 * MiB + 31);
  for (const readBatchBytes of [MiB, 2 * MiB, 4 * MiB]) {
    const cache = memoryCache(data), calls = []; let live = 0, maximum = 0;
    const result = await materializeMatroskaWindow({ plan: planFor(data), directory, cache, readConcurrency: 2, readBatchBytes,
      budgetBytes: data.length, read: async (offset, length, signal) => {
        assert(signal instanceof AbortSignal); calls.push({ offset, length }); maximum = Math.max(maximum, ++live);
        try { await setImmediate(); return bytesAt(data, offset, length); } finally { live--; }
      } });
    assert(maximum <= 2); assert.equal(live, 0);
    assert.equal(calls.length, Math.ceil(data.length / readBatchBytes));
    assert.equal(calls.reduce((sum, call) => sum + call.length, 0), data.length);
    assert(calls.every(call => call.length <= readBatchBytes));
    assert.deepEqual(cache.puts.map(item => item.length), Array.from({ length: 10 }, (_, index) => index === 9 ? 31 : MiB));
    assert.deepEqual(await readFile(result.path), Buffer.concat([prefix, data]));
    await result.cleanup();
  }
});

test('parallel batches stop at mixed cache hits and do not re-read cached units or the final tail', TEST, async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(8 * MiB + 31), cache = memoryCache(data, [1, 4, 5]), calls = [];
  const result = await materializeMatroskaWindow({ plan: planFor(data), directory, cache, readConcurrency: 2, readBatchBytes: 4 * MiB,
    budgetBytes: data.length - 3 * MiB, read: async (offset, length) => {
      calls.push({ offset, length }); await setImmediate(); return bytesAt(data, offset, length);
    } });
  assert.deepEqual(calls, [
    { offset: sourceStart, length: MiB }, { offset: sourceStart + 2 * MiB, length: 2 * MiB },
    { offset: sourceStart + 6 * MiB, length: 2 * MiB + 31 },
  ]);
  assert.deepEqual(cache.puts.map(item => item.offset), [0, 2, 3, 6, 7, 8].map(index => sourceStart + index * MiB));
  assert.deepEqual(await readFile(result.path), Buffer.concat([prefix, data]));
  await result.cleanup();
});

test('parallel preflight rejects a one-byte deficit before file/source I/O and accepts an exact missing-only budget', TEST, async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(5 * MiB + 51), cache = memoryCache(data, [0, 2]), calls = [];
  const options = { plan: planFor(data), directory, cache, readConcurrency: 2, readBatchBytes: 2 * MiB,
    read: async (offset, length) => { calls.push({ offset, length }); return bytesAt(data, offset, length); } };
  const missing = data.length - 2 * MiB;
  await assert.rejects(materializeMatroskaWindow({ ...options, budgetBytes: missing - 1 }), { code: 'BUDGET_EXCEEDED' });
  assert.deepEqual(calls, []); assert.deepEqual(await readdir(directory), []);
  const result = await materializeMatroskaWindow({ ...options, budgetBytes: missing });
  assert.equal(calls.reduce((sum, call) => sum + call.length, 0), missing);
  assert.deepEqual(await readFile(result.path), Buffer.concat([prefix, data]));
  await result.cleanup();
  const count = calls.length;
  const cached = await materializeMatroskaWindow({ ...options, budgetBytes: 0 });
  assert.equal(calls.length, count, 'a fully cached window does not spend any network budget');
  assert.deepEqual(await readFile(cached.path), Buffer.concat([prefix, data]));
  await cached.cleanup();
});

test('a later SOURCE_CHANGED cancels a stalled sibling immediately and cannot be replaced by its CANCELLED error', TEST, async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(3 * MiB), cache = memoryCache(data), firstStarted = deferred();
  let live = 0, calls = 0, siblingAborted = false;
  await assert.rejects(materializeMatroskaWindow({ plan: planFor(data), directory, cache, readConcurrency: 2, budgetBytes: data.length,
    read: async (offset, length, signal) => {
      calls++; live++;
      try {
        if (offset === sourceStart) {
          firstStarted.resolve();
          return await waitForAbort(signal, () => { siblingAborted = true; });
        }
        await firstStarted.promise;
        throw Object.assign(new Error('https://private.invalid/?token=never-display'), { code: 'SOURCE_CHANGED' });
      } finally { live--; }
    } }), error => {
    assert.equal(error.code, 'SOURCE_CHANGED');
    assert(!String(error.stack).includes('never-display'));
    return true;
  });
  assert.equal(calls, 2); assert.equal(live, 0); assert.equal(siblingAborted, true);
  assert.equal(cache.units.size, 0); assert.deepEqual(await readdir(directory), []);
});

test('external cancellation aborts both transports, settles readers, and cleans all temporary output', TEST, async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(4 * MiB), cache = memoryCache(data), bothStarted = deferred();
  const controller = new AbortController(); let live = 0, calls = 0, abortedReaders = 0;
  t.after(() => controller.abort());
  const operation = materializeMatroskaWindow({ plan: planFor(data), directory, cache, readConcurrency: 2,
    signal: controller.signal, budgetBytes: data.length, read: async (offset, length, signal) => {
      calls++; live++; if (calls === 2) bothStarted.resolve();
      try { return await waitForAbort(signal, () => { abortedReaders++; }); } finally { live--; }
    } });
  const rejection = assert.rejects(operation, { code: 'CANCELLED' });
  await bothStarted.promise; controller.abort(); await rejection;
  assert.equal(calls, 2); assert.equal(live, 0); assert.equal(abortedReaders, 2);
  assert.equal(cache.units.size, 0); assert.deepEqual(await readdir(directory), []);
});

test('a cache commit failure cancels an in-flight sibling and preserves the cache failure code', TEST, async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(3 * MiB), cache = memoryCache(data), bothStarted = deferred();
  let calls = 0, live = 0, siblingAborted = false;
  cache.put = () => { throw Object.assign(new Error('cache disk full'), { code: 'RESUME_WRITE_FAILED' }); };
  await assert.rejects(materializeMatroskaWindow({ plan: planFor(data), directory, cache, readConcurrency: 2, budgetBytes: data.length,
    read: async (offset, length, signal) => {
      live++; if (++calls === 2) bothStarted.resolve();
      try {
        if (offset === sourceStart) { await bothStarted.promise; return bytesAt(data, offset, length); }
        return await waitForAbort(signal, () => { siblingAborted = true; });
      } finally { live--; }
    } }), { code: 'RESUME_WRITE_FAILED' });
  assert.equal(calls, 2); assert.equal(live, 0); assert.equal(siblingAborted, true);
  assert.equal(cache.units.size, 0); assert.deepEqual(await readdir(directory), []);
});

test('a window write failure cancels an in-flight sibling and retains only the complete validated cached unit', TEST, async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(3 * MiB), cache = memoryCache(data), bothStarted = deferred();
  const fixtureHandle = await open(path.join(directory, 'handle-for-prototype'), 'wx');
  const handlePrototype = Object.getPrototypeOf(fixtureHandle), originalWrite = handlePrototype.write;
  await fixtureHandle.close(); await rm(path.join(directory, 'handle-for-prototype'));
  t.mock.method(handlePrototype, 'write', async function (...args) {
    if (Buffer.isBuffer(args[0]) && args[0].length === MiB) throw Object.assign(new Error('window disk full'), { code: 'ENOSPC' });
    return originalWrite.apply(this, args);
  });
  let calls = 0, live = 0, siblingAborted = false;
  await assert.rejects(materializeMatroskaWindow({ plan: planFor(data), directory, cache, readConcurrency: 2, budgetBytes: data.length,
    read: async (offset, length, signal) => {
      live++; if (++calls === 2) bothStarted.resolve();
      try {
        if (offset === sourceStart) { await bothStarted.promise; return bytesAt(data, offset, length); }
        return await waitForAbort(signal, () => { siblingAborted = true; });
      } finally { live--; }
    } }), { code: 'WINDOW_OUTPUT_FAILED' });
  assert.equal(calls, 2); assert.equal(live, 0); assert.equal(siblingAborted, true);
  assert.deepEqual(cache.puts, [{ offset: sourceStart, length: MiB }]);
  assert.deepEqual(cache.units.get(sourceStart), data.subarray(0, MiB));
  assert.deepEqual(await readdir(directory), []);
});

test('an incomplete parallel read commits no partial cache units and cancels the other request', TEST, async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(3 * MiB), cache = memoryCache(data), bothStarted = deferred();
  let calls = 0, live = 0, siblingAborted = false;
  await assert.rejects(materializeMatroskaWindow({ plan: planFor(data), directory, cache, readConcurrency: 2, budgetBytes: data.length,
    read: async (offset, length, signal) => {
      live++; if (++calls === 2) bothStarted.resolve();
      try {
        if (offset === sourceStart) { await bothStarted.promise; return bytesAt(data, offset, length - 1); }
        return await waitForAbort(signal, () => { siblingAborted = true; });
      } finally { live--; }
    } }), { code: 'WINDOW_READ_FAILED' });
  assert.equal(calls, 2); assert.equal(live, 0); assert.equal(siblingAborted, true);
  assert.equal(cache.units.size, 0); assert.deepEqual(await readdir(directory), []);
});

test('default and explicit concurrency one preserve sequential dispatch and invalid values perform no I/O', TEST, async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(2 * MiB + 19);
  let invalidCalls = 0;
  for (const readConcurrency of [0, 3, -1, 1.5, '2', null, {}, Infinity]) {
    await assert.rejects(materializeMatroskaWindow({ plan: planFor(data), directory, readConcurrency, budgetBytes: data.length,
      read: async () => { invalidCalls++; return data; } }), { code: 'INVALID_MATROSKA_WINDOW' });
  }
  assert.equal(invalidCalls, 0); assert.deepEqual(await readdir(directory), []);
  for (const options of [{}, { readConcurrency: 1 }]) {
    const firstGate = deferred(), firstStarted = deferred(), calls = []; let live = 0, maximum = 0;
    t.after(() => firstGate.resolve());
    const operation = materializeMatroskaWindow({ plan: planFor(data), directory, ...options, budgetBytes: data.length,
      read: async (offset, length) => {
        calls.push({ offset, length }); maximum = Math.max(maximum, ++live);
        try {
          if (offset === sourceStart) { firstStarted.resolve(); await firstGate.promise; }
          return bytesAt(data, offset, length);
        } finally { live--; }
      } });
    operation.catch(() => {});
    await firstStarted.promise; await setImmediate();
    assert.equal(calls.length, 1);
    firstGate.resolve(); const result = await operation;
    assert.equal(maximum, 1); assert.equal(live, 0);
    assert.deepEqual(calls.map(call => call.length), [MiB, MiB, 19]);
    assert.deepEqual(await readFile(result.path), Buffer.concat([prefix, data]));
    await result.cleanup();
  }
});

test('parallel out-of-order network bytes remain durably charged after cancellation and saved units resume in serial mode', TEST, async t => {
  const directory = await directoryFor(t), outputDirectory = await mkdtemp(path.join(directory, 'output-'));
  const data = clusterOfTotal(4 * MiB + 23), plan = planFor(data), controller = new AbortController(), secondSettled = deferred();
  const options = { directory: path.join(directory, 'cache'), id: 'parallel-resume', budgetBytes: 8 * MiB,
    identity: { sourceKey: sha('parallel-locator'), size: sourceStart + data.length, etagSha256: sha('parallel-version'), headSha256: sha('parallel-head') },
    plan: { version: 1, sourceStart, sourceEnd: plan.sourceEnd, prefixSha256: sha(prefix), timelineStartSeconds: 60, timelineEndSeconds: 90 } };
  let cache = await openResumeStore(options), calls = [], firstRun = true;
  t.after(() => cache.close());
  const read = async (offset, length, signal) => {
    const ticket = await cache.reserve(length);
    let received = 0;
    try {
      calls.push({ offset, length });
      if (firstRun && offset === sourceStart) await secondSettled.promise;
      assert(!signal?.aborted);
      const dataPart = bytesAt(data, offset, length); received = dataPart.length;
      return dataPart;
    } finally {
      await cache.settle(ticket, received);
      if (firstRun && offset === sourceStart + MiB) secondSettled.resolve();
    }
  };
  await assert.rejects(materializeMatroskaWindow({ plan, directory: outputDirectory, cache, read, readConcurrency: 2,
    signal: controller.signal, budgetBytes: cache.snapshot().remainingBytes,
    onProgress: event => { if (event.receivedBytes === MiB) controller.abort(); } }), { code: 'CANCELLED' });
  const interrupted = cache.snapshot();
  assert.deepEqual(calls, [{ offset: sourceStart, length: MiB }, { offset: sourceStart + MiB, length: MiB }]);
  assert.equal(interrupted.cachedBytes, MiB); assert.equal(interrupted.receivedBytes, 2 * MiB);
  assert.equal(interrupted.reservedBytes, 0); assert.deepEqual(await readdir(outputDirectory), []);
  await cache.close(); cache = await openResumeStore(options); firstRun = false;
  assert.equal(cache.snapshot().receivedBytes, 2 * MiB, 'both completed reads survive restart in the charged byte counter');
  const result = await materializeMatroskaWindow({ plan, directory: outputDirectory, cache, read, budgetBytes: cache.snapshot().remainingBytes });
  assert.deepEqual(calls.slice(2), [1, 2, 3, 4].map(index => ({ offset: sourceStart + index * MiB, length: index === 4 ? 23 : MiB })));
  assert.equal(cache.snapshot().cachedBytes, data.length);
  assert.equal(cache.snapshot().receivedBytes, data.length + MiB, 'the completed but uncommitted second unit is charged again when actually re-read');
  assert.equal(cache.snapshot().reservedBytes, 0);
  assert.deepEqual(await readFile(result.path), Buffer.concat([prefix, data]));
  await result.cleanup();
});
