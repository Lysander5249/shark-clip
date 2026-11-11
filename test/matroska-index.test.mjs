import test from 'node:test';
import assert from 'node:assert/strict';
import { locateMatroskaCue } from '../src/matroska-index.mjs';
import { createMatroskaMetadataCache } from '../src/matroska-metadata-cache.mjs';

const MiB = 1024 * 1024;
const ID = { ebml: 0x1a45dfa3, segment: 0x18538067, seek: 0x114d9b74, info: 0x1549a966, tracks: 0x1654ae6b, cues: 0x1c53bb6b, cluster: 0x1f43b675 };
const idBytes = value => Buffer.from(value.toString(16).padStart(value.toString(16).length + value.toString(16).length % 2, '0'), 'hex');
function sizeBytes(value, width = 8) {
  const n = BigInt(value);
  assert(n >= 0n && n < (1n << BigInt(width * 7)) - 1n);
  const bytes = Buffer.alloc(width);
  let marked = n | (1n << BigInt(width * 7));
  for (let i = width - 1; i >= 0; i--) { bytes[i] = Number(marked & 255n); marked >>= 8n; }
  return bytes;
}
function unsigned(value, width = 8) {
  const bytes = Buffer.alloc(width); let n = BigInt(value);
  for (let i = width - 1; i >= 0; i--) { bytes[i] = Number(n & 255n); n >>= 8n; }
  assert.equal(n, 0n); return bytes;
}
function el(id, payload, width = 8) { return Buffer.concat([idBytes(id), sizeBytes(payload.length, width), payload]); }
const scalar = (id, value) => el(id, unsigned(value));
const seekEntry = (id, offset) => el(0x4dbb, Buffer.concat([el(0x53ab, idBytes(id)), scalar(0x53ac, offset)]));
const voidHeader = length => Buffer.concat([idBytes(0xec), sizeBytes(length - 9)]);

// Only the small declared chunks exist in memory. This exercises 64-bit file offsets
// without making large files, reading a cloud account, or allocating a movie-sized buffer.
function sparseFile(size, chunks) {
  const calls = [];
  return {
    size, calls,
    async read(position, length) {
      assert(Number.isSafeInteger(position) && Number.isSafeInteger(length));
      assert(position >= 0 && length > 0 && position + length <= size);
      calls.push({ position, length });
      const bytes = Buffer.alloc(length);
      for (const chunk of chunks) {
        const from = Math.max(position, chunk.position), to = Math.min(position + length, chunk.position + chunk.data.length);
        if (to > from) chunk.data.copy(bytes, from - position, from - chunk.position, to - chunk.position);
      }
      return bytes;
    },
  };
}

function fixture({ scale = 1_000_000, tracks = [{ number: 1, type: 1 }], times = [100, 110, 120], clusterOffset = 8192, cuesOffset = 65536, omitCues = false, cuePayload, cuePosition, clusterData, seekPosition } = {}) {
  const ebml = el(ID.ebml, Buffer.alloc(0));
  const base = ebml.length + idBytes(ID.segment).length + 8;
  const size = base + Math.max(cuesOffset + 8192, clusterOffset + 65536);
  const trackTable = el(ID.tracks, Buffer.concat(tracks.map(t => el(0xae, Buffer.concat([scalar(0xd7, t.number), scalar(0x83, t.type)])))));
  const info = el(ID.info, scalar(0x2ad7b1, scale));
  const refs = [seekEntry(ID.info, 512), seekEntry(ID.tracks, 1024)];
  if (!omitCues) refs.push(seekEntry(ID.cues, seekPosition ?? cuesOffset));
  const seek = el(ID.seek, Buffer.concat(refs));
  const chunks = [
    { position: 0, data: ebml },
    { position: ebml.length, data: Buffer.concat([idBytes(ID.segment), sizeBytes(size - base)]) },
    { position: base, data: seek },
    { position: base + seek.length, data: voidHeader(512 - seek.length) },
    { position: base + 512, data: info },
    { position: base + 512 + info.length, data: voidHeader(1024 - 512 - info.length) },
    { position: base + 1024, data: trackTable },
    { position: base + 1024 + trackTable.length, data: voidHeader(4096 - 1024 - trackTable.length) },
    { position: base + 4096, data: el(ID.cluster, scalar(0xe7, 0)) },
  ];
  const videos = tracks.filter(t => t.type === 1);
  const clusterAt = (timeIndex, videoIndex) => clusterOffset + timeIndex * 8192 + videoIndex * 2048;
  for (const [i, seconds] of times.entries()) {
    for (const [v] of videos.entries()) {
      chunks.push({ position: base + clusterAt(i, v), data: clusterData ?? el(ID.cluster, Buffer.concat([scalar(0xe7, Math.round(seconds * 1e9 / scale)), el(0xa3, Buffer.alloc(32))])) });
    }
  }
  const points = times.map((seconds, i) => el(0xbb, Buffer.concat([
    scalar(0xb3, Math.round(seconds * 1e9 / scale)),
    ...videos.map((t, v) => el(0xb7, Buffer.concat([
      scalar(0xf7, t.number), scalar(0xf1, cuePosition ? cuePosition(i, v, size, base) : clusterAt(i, v)),
    ]))),
  ])));
  if (!omitCues) chunks.push({ position: base + cuesOffset, data: cuePayload ?? el(ID.cues, Buffer.concat(points)) });
  return { ...sparseFile(size, chunks), base, clusterAt, chunks };
}

function assertBounded(file) {
  assert(file.calls.length <= 64, `too many index reads: ${file.calls.length}`);
  assert(file.calls.reduce((sum, c) => sum + c.length, 0) <= 4 * MiB, 'index reads exceeded 4 MiB');
}

test('locates the preceding video cue and validates its cluster without scanning media', async () => {
  const file = fixture();
  const found = await locateMatroskaCue({ ...file, start: 115 });
  assert.equal(found?.timestampSeconds, 110);
  assert.equal(found.positionBytes, file.base + file.clusterAt(1, 0));
  assert.equal(found.nextTimestampSeconds, 120);
  assert.equal(found.method, 'matroska-cues');
  assert.equal(found.trackNumber, 1);
  assert.equal(found.entries, 3);
  assert.equal(found.indexBytes, file.calls.reduce((sum, c) => sum + c.length, 0));
  assertBounded(file);
  assert(file.calls.every(c => c.length <= 4096));
});

test('preserves cue and seek offsets above 4 GiB without 32-bit truncation', async () => {
  const file = fixture({ clusterOffset: 2 ** 32 + 8192, cuesOffset: 2 ** 32 + MiB });
  const found = await locateMatroskaCue({ ...file, start: 111 });
  assert.equal(found?.positionBytes, file.base + file.clusterAt(1, 0));
  assert(found.positionBytes > 2 ** 32);
  assert(file.calls.some(c => c.position > 2 ** 32));
  assertBounded(file);
});

test('uses TimecodeScale for cue and cluster timestamps rather than assuming milliseconds', async () => {
  const file = fixture({ scale: 250_000, times: [10.25, 12.5, 15.75] });
  const found = await locateMatroskaCue({ ...file, start: 13 });
  assert.equal(found?.timestampSeconds, 12.5);
  assert.equal(found.nextTimestampSeconds, 15.75);
  assert.equal(found.positionBytes, file.base + file.clusterAt(1, 0));
});

test('videoOrdinal selects the corresponding video TrackNumber while ignoring audio entries', async () => {
  const file = fixture({ tracks: [{ number: 9, type: 2 }, { number: 3, type: 1 }, { number: 11, type: 1 }] });
  const first = await locateMatroskaCue({ ...file, start: 115, videoOrdinal: 0 });
  const second = await locateMatroskaCue({ ...file, start: 115, videoOrdinal: 1 });
  assert.equal(first?.trackNumber, 3);
  assert.equal(second?.trackNumber, 11);
  assert.equal(second.positionBytes, file.base + file.clusterAt(1, 1));
  assert.notEqual(first.positionBytes, second.positionBytes);
  assert.equal(await locateMatroskaCue({ ...file, start: 115, videoOrdinal: 2 }), null);
});

test('missing, sparse, unsorted, or stale indexes fall back instead of claiming a verified seek', async t => {
  const cases = [
    ['no Cues', { omitCues: true }, 115],
    ['only one CuePoint', { times: [100] }, 100],
    ['target precedes first cue', {}, 99],
    ['preceding cue is over 60 seconds behind target', { times: [0, 200] }, 100],
    ['decreasing timestamps', { times: [110, 100, 120] }, 115],
    ['decreasing byte positions', { cuePosition: i => 24576 - i * 8192 }, 115],
    ['zero TimecodeScale', { scale: 0 }, 115],
  ];
  for (const [label, options, start] of cases) await t.test(label, async () => {
    // A zero scale has no representable media timestamps; only its invalid Info is needed.
    const file = fixture(options.scale === 0 ? { ...options, times: [] } : options);
    assert.equal(await locateMatroskaCue({ ...file, start }), null);
    assertBounded(file);
  });
});

test('malformed mandatory fields, invalid clusters, and out-of-file references return null', async t => {
  const cases = [
    ['missing CueTime', { cuePayload: el(ID.cues, el(0xbb, el(0xb7, scalar(0xf7, 1)))) }],
    ['truncated CuePoint', { cuePayload: el(ID.cues, Buffer.from([0xbb, 0xff])) }],
    ['out-of-file seek entry', { seekPosition: Number.MAX_SAFE_INTEGER }],
    ['out-of-file cue position', { cuePosition: (_i, _v, size) => size }],
    ['cue points to a non-cluster', { clusterData: el(0xec, Buffer.alloc(32)) }],
    ['cluster without timestamp', { clusterData: el(ID.cluster, el(0xa3, Buffer.alloc(32))) }],
    ['cluster timestamp disagrees with cue', { clusterData: el(ID.cluster, scalar(0xe7, 0)) }],
  ];
  for (const [label, options] of cases) await t.test(label, async () => {
    const file = fixture(options);
    assert.equal(await locateMatroskaCue({ ...file, start: 115 }), null);
    assertBounded(file);
  });
});

test('the per-table and cumulative 4 MiB limits reject payloads before dispatching a large read', async t => {
  for (const tableSize of [4 * MiB, 4 * MiB + 1]) await t.test(`${tableSize} declared table bytes`, async () => {
    const file = fixture({ cuePayload: Buffer.concat([idBytes(ID.cues), sizeBytes(tableSize)]) });
    // Keep the file and Segment large enough that the header is valid. Exactly
    // 4 MiB exceeds the remaining cumulative allowance after prior reads; 4 MiB
    // plus one also exceeds the independent single-table limit.
    file.size += 8 * MiB;
    file.chunks[1].data = Buffer.concat([idBytes(ID.segment), sizeBytes(file.size - file.base)]);
    const readFile = sparseFile(file.size, file.chunks);
    assert.equal(await locateMatroskaCue({ ...readFile, start: 115 }), null);
    assertBounded(readFile);
    assert(readFile.calls.every(c => c.length <= 4096));
  });
});

function manyReadsFixture(paddingCount) {
  const ebml = el(ID.ebml, Buffer.alloc(0)), base = ebml.length + 12, size = base + 1_000_000;
  const chunks = [
    { position: 0, data: ebml },
    { position: ebml.length, data: Buffer.concat([idBytes(ID.segment), sizeBytes(size - base)]) },
  ];
  for (let i = 0; i < 31; i++) chunks.push({ position: base + i * 5000, data: voidHeader(5000) });
  const at = i => i === 0 ? 155000 : 200000 + (i - 1) * 20000;
  for (let i = 0; i < 8; i++) {
    const refs = i === 0 ? [seekEntry(ID.info, 600000), seekEntry(ID.tracks, 610000), seekEntry(ID.cues, 620000)] : [];
    if (i < 7) refs.push(seekEntry(ID.seek, at(i + 1)));
    const content = Buffer.concat(refs);
    // A legal Void makes each SeekHead larger than a prefetched header page.
    chunks.push({ position: base + at(i), data: el(ID.seek, Buffer.concat([content, el(0xec, Buffer.alloc(5000 - content.length - 9))])) });
  }
  chunks.push({ position: base + 600000, data: el(ID.info, scalar(0x2ad7b1, 1_000_000)) });
  chunks.push({ position: base + 610000, data: el(ID.tracks, el(0xae, Buffer.concat([scalar(0xd7, 1), scalar(0x83, 1)]))) });
  chunks.push({ position: base + 620000, data: el(ID.cues, Buffer.concat([100, 110].map((seconds, i) => el(0xbb, Buffer.concat([
    scalar(0xb3, seconds * 1000), el(0xb7, Buffer.concat([scalar(0xf7, 1), scalar(0xf1, 700000 + i * 100000)])),
  ]))))) });
  const clusterPayload = Buffer.concat([
    ...Array.from({ length: paddingCount }, () => el(0xec, Buffer.alloc(4991))),
    scalar(0xe7, 100000), el(0xa3, Buffer.alloc(32)),
  ]);
  chunks.push({ position: base + 700000, data: el(ID.cluster, clusterPayload) });
  return sparseFile(size, chunks);
}

test('the 64-read operation limit stops dispersed but valid index structures', async () => {
  const underLimit = manyReadsFixture(10);
  assert.equal((await locateMatroskaCue({ ...underLimit, start: 105 }))?.timestampSeconds, 100);
  assertBounded(underLimit);
  const overLimit = manyReadsFixture(15);
  assert.equal(await locateMatroskaCue({ ...overLimit, start: 105 }), null);
  assert.equal(overLimit.calls.length, 64, 'the parser must not dispatch a 65th upstream read');
  assertBounded(overLimit);
});

test('invalid arguments, truncated replies, and non-Buffer replies cannot produce a cue', async () => {
  const file = fixture();
  for (const changes of [{ size: 15 }, { size: Infinity }, { start: -1 }, { start: NaN }, { videoOrdinal: -1 }, { videoOrdinal: 0.5 }, { read: null }]) {
    assert.equal(await locateMatroskaCue({ ...file, start: 115, ...changes }), null);
  }
  assert.equal(file.calls.length, 0, 'invalid inputs should not cause upstream reads');
  assert.equal(await locateMatroskaCue({ ...file, start: 115, read: async () => Buffer.alloc(1) }), null);
  assert.equal(await locateMatroskaCue({ ...file, start: 115, read: async (_p, n) => new Uint8Array(n) }), null);
});

test('cancellation before or during an index read propagates the original abort reason', async () => {
  const file = fixture();
  const before = new AbortController(), reasonBefore = new Error('index operation cancelled before read');
  before.abort(reasonBefore);
  await assert.rejects(locateMatroskaCue({ ...file, start: 115, signal: before.signal }), e => e === reasonBefore);
  assert.equal(file.calls.length, 0);
  const during = new AbortController(), reasonDuring = new Error('index operation cancelled during read');
  await assert.rejects(locateMatroskaCue({ ...file, start: 115, signal: during.signal, read: async (p, n) => {
    const bytes = await file.read(p, n); during.abort(reasonDuring); return bytes;
  } }), e => e === reasonDuring);
  assert.equal(file.calls.length, 1);
});

test('upstream transport and budget failures retain their error identity and code', async () => {
  for (const code of ['BUDGET_EXCEEDED', 'TIMEOUT', 'HTTP_401']) {
    const failure = Object.assign(new Error('synthetic upstream failure'), { code });
    const file = fixture();
    await assert.rejects(locateMatroskaCue({ ...file, start: 115, read: async () => { throw failure; } }), e => e === failure && e.code === code);
  }
});

const metadataIdentity = (file, changes = {}) => ({ sourceKey: '1'.repeat(64), size: file.size, etagSha256: '2'.repeat(64), headSha256: '3'.repeat(64), ...changes });
function comparablePlan(plan) {
  const { indexBytes, metadataCache, ...result } = plan;
  return result;
}

test('committed metadata reuses exact tables while producing the same independently checked window', async () => {
  const file = fixture(), cache = createMatroskaMetadataCache();
  const coldTx = cache.begin(metadataIdentity(file));
  const cold = await locateMatroskaCue({ ...file, start: 111, end: 112, metadataCache: coldTx });
  assert(cold?.window);
  assert.deepEqual(cold.metadataCache, { hitBytes: 0, hitReads: 0 });
  assert.equal(cache.stats().entries, 0, 'the parser must not publish before the caller validates the complete plan');
  assert(coldTx.commit());
  const coldCalls = file.calls.splice(0);
  const warmTx = cache.begin(metadataIdentity(file));
  const warm = await locateMatroskaCue({ ...file, start: 111, end: 112, metadataCache: warmTx });
  assert.deepEqual(comparablePlan(warm), comparablePlan(cold));
  assert(warm.metadataCache.hitBytes > 0); assert(warm.metadataCache.hitReads > 0);
  assert(warm.indexBytes < cold.indexBytes);
  assert(file.calls.length < coldCalls.length);
  assert.equal(warm.indexBytes, file.calls.reduce((sum, call) => sum + call.length, 0));
  assert(file.calls.some(call => call.position === warm.window.sourceStart), 'the chosen Cluster must be newly requested');
  assert(file.calls.some(call => call.position === file.base + file.clusterAt(2, 0)), 'the terminal Cluster must be newly requested');
  assert(warmTx.commit());
  const inspected = cache.begin(metadataIdentity(file));
  assert.equal(inspected.get(file.base + 4096, 1), null, 'the first encountered Cluster is not metadata');
  assert.equal(inspected.get(warm.window.sourceStart, 1), null, 'target media must not enter metadata cache');
  assert.equal(inspected.get(file.base + 4000, 1), null, 'prefetched Void payload must not enter metadata cache');
});

test('a target overlapping metadata prefetch still gets a fresh conditional-read opportunity', async () => {
  const file = fixture({ clusterOffset: 2048 }), cache = createMatroskaMetadataCache();
  const tx = cache.begin(metadataIdentity(file));
  const cold = await locateMatroskaCue({ ...file, start: 101, end: 102, metadataCache: tx });
  assert(cold?.window); assert(tx.commit());
  assert(file.calls.some(call => call.position === cold.window.sourceStart), 'cold target is not satisfied by the initial 4 KiB metadata prefetch');
  file.calls.length = 0;
  const warm = await locateMatroskaCue({ ...file, start: 101, end: 102, metadataCache: cache.begin(metadataIdentity(file)) });
  assert(warm?.window);
  assert(file.calls.some(call => call.position === warm.window.sourceStart));
  const rejected = Object.assign(new Error('current target version no longer matches'), { code: 'SOURCE_CHANGED' });
  await assert.rejects(locateMatroskaCue({ ...file, start: 101, end: 102, metadataCache: cache.begin(metadataIdentity(file)), read: (position, length) => {
    if (position === warm.window.sourceStart) throw rejected;
    return file.read(position, length);
  } }), error => error === rejected);
});

test('metadata identity mismatches force cold reads and every time/track selection is reparsed', async () => {
  const file = fixture({ tracks: [{ number: 9, type: 2 }, { number: 3, type: 1 }, { number: 11, type: 1 }] });
  const cache = createMatroskaMetadataCache();
  const tx = cache.begin(metadataIdentity(file));
  const first = await locateMatroskaCue({ ...file, start: 111, end: 112, metadataCache: tx });
  assert(first?.window); tx.commit();
  const second = await locateMatroskaCue({ ...file, start: 115, end: 116, videoOrdinal: 1, metadataCache: cache.begin(metadataIdentity(file)) });
  const uncached = await locateMatroskaCue({ ...file, start: 115, end: 116, videoOrdinal: 1 });
  assert(second.metadataCache.hitBytes > 0);
  assert.deepEqual(comparablePlan(second), comparablePlan(uncached));
  assert.notEqual(second.trackNumber, first.trackNumber);
  assert.notEqual(second.positionBytes, first.positionBytes);
  const changed = await locateMatroskaCue({ ...file, start: 111, end: 112, metadataCache: cache.begin(metadataIdentity(file, { etagSha256: '4'.repeat(64) })) });
  assert.deepEqual(changed.metadataCache, { hitBytes: 0, hitReads: 0 });
});

test('invalid structures, partial replies, cancellation and failures never publish staged metadata', async t => {
  for (const kind of ['invalid', 'partial', 'cancel', 'throw']) await t.test(kind, async () => {
    const file = fixture(kind === 'invalid' ? { clusterData: el(ID.cluster, scalar(0xe7, 0)) } : {});
    const cache = createMatroskaMetadataCache(), tx = cache.begin(metadataIdentity(file));
    const controller = new AbortController(), reason = new Error('index cancelled after a response');
    const read = async (position, length) => {
      const bytes = await file.read(position, length);
      if (position === file.base + 65536) {
        if (kind === 'partial') return bytes.subarray(0, -1);
        if (kind === 'cancel') controller.abort(reason);
        if (kind === 'throw') throw reason;
      }
      return bytes;
    };
    const result = locateMatroskaCue({ ...file, read, start: 111, end: 112, signal: controller.signal, metadataCache: tx });
    if (['cancel', 'throw'].includes(kind)) await assert.rejects(result, error => error === reason);
    else assert.equal(await result, null);
    assert.equal(cache.stats().entries, 0);
    tx.discard();
    assert.equal(tx.commit(), false);
    assert.equal(cache.begin(metadataIdentity(file)).get(0, 1), null);
  });
});
