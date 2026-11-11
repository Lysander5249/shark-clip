import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { materializeMatroskaWindow } from '../src/matroska-window.mjs';
import { openResumeStore } from '../src/resume-store.mjs';

const MiB = 1024 * 1024, sourceStart = 4096;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
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
    if (payload > 0 && sizeBytes(payload).length === width) return element('1f43b675', Buffer.alloc(payload, 42));
  }
  throw new Error('invalid fixture length');
}
const planFor = data => ({ prefix, sourceStart, sourceEnd: sourceStart + data.length, timelineStartSeconds: 60, timelineEndSeconds: 90 });
async function directoryFor(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-batch-test-'));
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
function reader(data, calls, hooks = {}) {
  return async (offset, length) => {
    calls.push({ offset, length });
    assert(offset >= sourceStart && offset + length <= sourceStart + data.length);
    hooks.start?.();
    await setImmediate();
    hooks.end?.();
    return data.subarray(offset - sourceStart, offset - sourceStart + length);
  };
}

test('opt-in 2/4 MiB batches reduce sequential network calls while preserving exact bytes and unit progress', async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(9 * MiB + 123), plan = planFor(data);
  for (const batch of [MiB, 2 * MiB, 4 * MiB]) {
    const calls = [], events = []; let inflight = 0, maximum = 0;
    const result = await materializeMatroskaWindow({ plan, directory, readBatchBytes: batch, budgetBytes: data.length,
      read: reader(data, calls, { start() { maximum = Math.max(maximum, ++inflight); }, end() { inflight--; } }),
      onProgress: event => events.push(event) });
    assert.equal(calls.length, Math.ceil(data.length / batch));
    assert.equal(calls.reduce((total, call) => total + call.length, 0), data.length);
    assert(calls.every(call => call.length > 0 && call.length <= batch));
    assert.equal(maximum, 1, 'one network request at a time');
    assert.deepEqual(await readFile(result.path), Buffer.concat([prefix, data]));
    assert.deepEqual(events.slice(1, -1).map(event => event.receivedBytes),
      Array.from({ length: Math.ceil(data.length / MiB) }, (_, index) => Math.min((index + 1) * MiB, data.length)));
    assert.equal(events.at(-1).percent, 100);
    await result.cleanup();
  }
  assert.deepEqual(await readdir(directory), []);
});

test('mixed cache holes terminate batches at hits and never re-fetch cached units or over-read the tail', async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(8 * MiB + 31), cache = memoryCache(data, [1, 4, 5]), calls = [];
  const result = await materializeMatroskaWindow({ plan: planFor(data), directory, cache, readBatchBytes: 4 * MiB,
    budgetBytes: data.length - 3 * MiB, read: reader(data, calls) });
  assert.deepEqual(calls, [
    { offset: sourceStart, length: MiB },
    { offset: sourceStart + 2 * MiB, length: 2 * MiB },
    { offset: sourceStart + 6 * MiB, length: 2 * MiB + 31 },
  ]);
  assert.deepEqual(cache.puts.map(item => item.offset), [0, 2, 3, 6, 7, 8].map(index => sourceStart + index * MiB));
  assert.deepEqual(await readFile(result.path), Buffer.concat([prefix, data]));
  await result.cleanup();
});

test('missing-only byte budget accepts an exact remainder and refuses a one-byte deficit before I/O', async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(5 * MiB + 51), calls = [], cache = memoryCache(data, [0, 2]);
  const options = { plan: planFor(data), directory, cache, readBatchBytes: 4 * MiB, read: reader(data, calls) };
  await assert.rejects(materializeMatroskaWindow({ ...options, budgetBytes: data.length - 2 * MiB - 1 }), { code: 'BUDGET_EXCEEDED' });
  assert.deepEqual(calls, []); assert.deepEqual(await readdir(directory), []);
  const result = await materializeMatroskaWindow({ ...options, budgetBytes: data.length - 2 * MiB });
  assert.equal(calls.reduce((sum, call) => sum + call.length, 0), data.length - 2 * MiB);
  await result.cleanup();
  const complete = await materializeMatroskaWindow({ ...options, budgetBytes: 0 });
  assert.equal(calls.length, 2, 'a fully cached window performs no additional reads');
  assert.deepEqual(await readFile(complete.path), Buffer.concat([prefix, data]));
  await complete.cleanup();
});

test('default stays at 1 MiB and unsupported batch sizes fail before reading or creating files', async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(2 * MiB + 13), calls = [];
  const options = { plan: planFor(data), directory, budgetBytes: data.length, read: reader(data, calls) };
  for (const readBatchBytes of [0, MiB + 1, 3 * MiB, 8 * MiB, '4194304', null, Infinity]) {
    await assert.rejects(materializeMatroskaWindow({ ...options, readBatchBytes }), { code: 'INVALID_MATROSKA_WINDOW' });
  }
  assert.deepEqual(calls, []); assert.deepEqual(await readdir(directory), []);
  const result = await materializeMatroskaWindow(options);
  assert.deepEqual(calls.map(call => call.length), [MiB, MiB, 13]);
  await result.cleanup();
});

test('an aligned truncated batch cannot be mistaken for an intentional cache boundary', async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(4 * MiB), cache = memoryCache(data);
  await assert.rejects(materializeMatroskaWindow({ plan: planFor(data), directory, cache, readBatchBytes: 4 * MiB,
    budgetBytes: data.length, read: async (offset, length) => { assert.equal(length, 4 * MiB); return data.subarray(0, 2 * MiB); } }), { code: 'WINDOW_READ_FAILED' });
  assert.equal(cache.units.size, 0, 'an incomplete strict read commits no units');
  assert.deepEqual(await readdir(directory), []);
});

test('malformed later unit preserves only previously validated whole units and cleans temporary output', async t => {
  const directory = await directoryFor(t), data = Buffer.concat([clusterOfTotal(MiB), Buffer.alloc(3 * MiB)]), cache = memoryCache(data), calls = [];
  await assert.rejects(materializeMatroskaWindow({ plan: planFor(data), directory, cache, readBatchBytes: 4 * MiB,
    budgetBytes: data.length, read: reader(data, calls) }), { code: 'INVALID_MATROSKA_WINDOW' });
  assert.deepEqual(calls, [{ offset: sourceStart, length: 4 * MiB }]);
  assert.deepEqual(cache.puts, [{ offset: sourceStart, length: MiB }]);
  assert.deepEqual(cache.units.get(sourceStart), data.subarray(0, MiB));
  assert.deepEqual(await readdir(directory), []);
});

test('cancellation during a batched read commits nothing and does not start a second request', async t => {
  const directory = await directoryFor(t), data = clusterOfTotal(5 * MiB), cache = memoryCache(data), controller = new AbortController();
  let calls = 0;
  await assert.rejects(materializeMatroskaWindow({ plan: planFor(data), directory, cache, readBatchBytes: 4 * MiB,
    signal: controller.signal, budgetBytes: data.length, read: async () => { calls++; controller.abort(); return new Promise(() => {}); } }), { code: 'CANCELLED' });
  assert.equal(calls, 1); assert.equal(cache.units.size, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('cancellation between units preserves the 1 MiB disk checkpoint, reusable after reopen with either batch size', async t => {
  const directory = await directoryFor(t), cacheDirectory = path.join(directory, 'cache'), outputDirectory = await mkdtemp(path.join(directory, 'output-'));
  const data = clusterOfTotal(6 * MiB + 33), plan = planFor(data), controller = new AbortController(), calls = [];
  const options = { directory: cacheDirectory, id: 'batch-resume', budgetBytes: 16 * MiB,
    identity: { sourceKey: sha('locator'), size: sourceStart + data.length, etagSha256: sha('strong-version'), headSha256: sha('verified-head') },
    plan: { version: 1, sourceStart, sourceEnd: plan.sourceEnd, prefixSha256: sha(prefix), timelineStartSeconds: 60, timelineEndSeconds: 90 } };
  let cache = await openResumeStore(options);
  const read = async (offset, length) => {
    const ticket = await cache.reserve(length);
    const result = await reader(data, calls)(offset, length);
    await cache.settle(ticket, result.length);
    return result;
  };
  await assert.rejects(materializeMatroskaWindow({ plan, read, directory: outputDirectory, cache, readBatchBytes: 4 * MiB,
    signal: controller.signal, budgetBytes: cache.snapshot().remainingBytes,
    onProgress: event => { if (event.receivedBytes === MiB) controller.abort(); } }), { code: 'CANCELLED' });
  assert.equal(cache.snapshot().cachedBytes, MiB);
  assert.equal(cache.snapshot().receivedBytes, 4 * MiB, 'the whole completed network batch remains charged');
  assert.deepEqual((await readdir(path.join(cacheDirectory, options.id))).filter(name => name.endsWith('.bin')), [`${sourceStart}-${MiB}.bin`]);
  assert.deepEqual(await readdir(outputDirectory), []);
  await cache.close();
  cache = await openResumeStore(options); t.after(() => cache.close());
  const result = await materializeMatroskaWindow({ plan, read, directory: outputDirectory, cache, readBatchBytes: 4 * MiB,
    budgetBytes: cache.snapshot().remainingBytes });
  assert.deepEqual(calls, [{ offset: sourceStart, length: 4 * MiB },
    { offset: sourceStart + MiB, length: 4 * MiB }, { offset: sourceStart + 5 * MiB, length: MiB + 33 }]);
  assert.equal(cache.snapshot().cachedBytes, data.length);
  assert.equal(cache.snapshot().receivedBytes, 9 * MiB + 33);
  assert.equal(cache.snapshot().reservedBytes, 0);
  assert.deepEqual(await readFile(result.path), Buffer.concat([prefix, data]));
  await result.cleanup(); await cache.close();
  cache = await openResumeStore(options);
  const originalReader = await materializeMatroskaWindow({ plan, directory: outputDirectory, cache, budgetBytes: 0,
    read: async () => assert.fail('old 1 MiB materialization must reuse new batched cache') });
  assert.deepEqual(await readFile(originalReader.path), Buffer.concat([prefix, data]));
  await originalReader.cleanup();
});
