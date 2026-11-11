import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { planMatroskaProbe, locateMatroskaCue } from '../src/matroska-index.mjs';
import { materializeMatroskaWindow } from '../src/matroska-window.mjs';
import { detectTools, probeMedia } from '../src/engine.mjs';

const run = promisify(execFile), MiB = 1024 * 1024;
const ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg', ffprobePath = process.env.FFPROBE_PATH ?? 'ffprobe';
const ID = { ebml: 0x1a45dfa3, segment: 0x18538067, info: 0x1549a966, tracks: 0x1654ae6b, cluster: 0x1f43b675, cues: 0x1c53bb6b, attachments: 0x1941a469, tags: 0x1254c367 };
const idBytes = id => Buffer.from(id.toString(16).padStart(id.toString(16).length + id.toString(16).length % 2, '0'), 'hex');
function sizeBytes(size, width = 8) {
  const bytes = Buffer.alloc(width); let value = BigInt(size) | (1n << BigInt(width * 7));
  for (let i = width - 1; i >= 0; i--) { bytes[i] = Number(value & 255n); value >>= 8n; }
  return bytes;
}
const el = (id, payload) => Buffer.concat([idBytes(id), sizeBytes(payload.length), payload]);
function uint(id, value) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(value)); return el(id, bytes); }
function float(id, value, width = 8) { const bytes = Buffer.alloc(width); if (width === 4) bytes.writeFloatBE(value); else bytes.writeDoubleBE(value); return el(id, bytes); }
function header(bytes, position) {
  let at = position;
  function number(isId) {
    const first = bytes[at]; assert(first > 0, 'fixture has an invalid EBML leading byte');
    let width = 1; while (!(first & (1 << (8 - width)))) width++;
    let value = BigInt(isId ? first : first & ((1 << (8 - width)) - 1));
    for (let i = 1; i < width; i++) value = value * 256n + BigInt(bytes[at + i]);
    at += width;
    return !isId && value === (1n << BigInt(7 * width)) - 1n ? null : Number(value);
  }
  const id = number(true), size = number(false);
  return { id, position, data: at, size, end: size === null ? bytes.length : at + size };
}
function topLevel(bytes) {
  const ebml = header(bytes, 0), segment = header(bytes, ebml.end), elements = [];
  for (let at = segment.data; at < segment.end;) {
    const e = header(bytes, at); assert(e.end > at && e.end <= segment.end); elements.push(e); at = e.end;
  }
  return elements;
}
function reader(bytes, calls = [], forbidden = []) {
  return async (offset, length) => {
    assert(Number.isSafeInteger(offset) && offset >= 0 && Number.isSafeInteger(length) && length > 0 && offset + length <= bytes.length);
    for (const region of forbidden) assert(offset + length <= region.start || offset >= region.end, `unnecessary remote read intersects ${region.label}`);
    calls.push({ offset, length }); return bytes.subarray(offset, offset + length);
  };
}
function assertBounded(calls) {
  assert(calls.length <= 64, 'metadata planning must remain within 64 read operations');
  assert(calls.reduce((sum, c) => sum + c.length, 0) <= 4 * MiB, 'metadata planning must remain within 4 MiB');
}
function structuralFixture({ scale = 1_000_000, duration = 100_000, durationWidth = 8, omitDuration = false, unknownCluster = false, noTimestamp = false } = {}) {
  const ebml = el(ID.ebml, el(0x4282, Buffer.from('matroska')));
  const info = el(ID.info, Buffer.concat([uint(0x2ad7b1, scale), ...(omitDuration ? [] : [float(0x4489, duration, durationWidth)])]));
  const tracks = el(ID.tracks, el(0xae, Buffer.concat([uint(0xd7, 1), uint(0x83, 1), el(0x86, Buffer.from('V_MPEG4/ISO/AVC'))])));
  const payload = Buffer.concat([...(noTimestamp ? [] : [uint(0xe7, 2500)]), el(0xa3, Buffer.alloc(32))]);
  const cluster = unknownCluster ? Buffer.concat([idBytes(ID.cluster), Buffer.from('01ffffffffffffff', 'hex'), payload]) : el(ID.cluster, payload);
  return Buffer.concat([ebml, Buffer.from('1853806701ffffffffffffff', 'hex'), info, tracks, cluster]);
}

test('head planner derives the full original duration from both Matroska float widths and TimecodeScale', async () => {
  for (const durationWidth of [4, 8]) {
    const bytes = structuralFixture({ scale: 250_000, duration: 400_000, durationWidth }), calls = [];
    const plan = await planMatroskaProbe({ read: reader(bytes, calls), size: bytes.length });
    assert.equal(plan?.method, 'matroska-head');
    assert.equal(plan.durationSeconds, 100);
    assert.equal(plan.window.timelineStartSeconds, 0.625);
    assert(plan.window.timelineEndSeconds > plan.window.timelineStartSeconds);
    assert.equal(plan.window.sourceStart, topLevel(bytes).find(e => e.id === ID.cluster).position);
    assert.equal(plan.window.sourceEnd, bytes.length);
    assert.equal(plan.indexBytes, calls.reduce((sum, c) => sum + c.length, 0));
    assertBounded(calls);
  }
});

test('missing or invalid original Duration, unknown first Cluster, and malformed metadata return null', async t => {
  const cases = [
    ['missing duration', { omitDuration: true }], ['zero duration', { duration: 0 }],
    ['negative duration', { duration: -1 }], ['NaN duration', { duration: NaN }], ['infinite duration', { duration: Infinity }],
    ['zero time scale', { scale: 0 }], ['unknown-sized first cluster', { unknownCluster: true }], ['missing cluster timestamp', { noTimestamp: true }],
  ];
  for (const [label, options] of cases) await t.test(label, async () => {
    const bytes = structuralFixture(options), calls = [];
    assert.equal(await planMatroskaProbe({ read: reader(bytes, calls), size: bytes.length }), null);
    assertBounded(calls);
  });
});

test('invalid arguments and oversized Info return null without scanning payload or exceeding read bounds', async () => {
  const bytes = structuralFixture(); let reads = 0;
  for (const options of [{ read: null }, { size: 0 }, { size: 15 }, { size: Infinity }, { size: 1.5 }]) {
    assert.equal(await planMatroskaProbe({ read: async () => { reads++; return bytes; }, size: bytes.length, ...options }), null);
  }
  assert.equal(reads, 0);
  const ebml = el(ID.ebml, el(0x4282, Buffer.from('matroska'))), infoPosition = ebml.length + 12;
  const prefix = Buffer.concat([ebml, Buffer.from('1853806701ffffffffffffff', 'hex'), idBytes(ID.info), sizeBytes(4 * MiB + 1)]);
  const calls = [], size = 8 * MiB;
  const plan = await planMatroskaProbe({ size, read: async (offset, length) => {
    calls.push({ offset, length });
    assert(offset + length <= infoPosition + 12, 'an oversized Info payload must never be requested');
    const data = Buffer.alloc(length); prefix.copy(data, 0, offset, offset + length); return data;
  } });
  assert.equal(plan, null); assertBounded(calls);
});

test('head planner preserves upstream errors and cancellation rather than falling back to an unrelated read', async () => {
  const bytes = structuralFixture();
  for (const code of ['TIMEOUT', 'SOURCE_CHANGED', 'BUDGET_EXCEEDED']) {
    const failure = Object.assign(new Error('synthetic read failed'), { code });
    await assert.rejects(planMatroskaProbe({ size: bytes.length, read: async () => { throw failure; } }), error => error === failure);
  }
  const before = new AbortController(), reason = new Error('cancelled head planning'); before.abort(reason);
  let reads = 0;
  await assert.rejects(planMatroskaProbe({ size: bytes.length, signal: before.signal, read: async () => { reads++; return bytes; } }), error => error === reason);
  assert.equal(reads, 0);
  const during = new AbortController();
  await assert.rejects(planMatroskaProbe({ size: bytes.length, signal: during.signal, read: async (offset, length) => {
    reads++; during.abort(reason); return bytes.subarray(offset, offset + length);
  } }), error => error === reason);
  assert.equal(reads, 1);
});

test('real head probing needs only native metadata and the first complete cluster, including without Cues', { timeout: 45_000 }, async t => {
  const tools = await detectTools({ ffmpegPath, ffprobePath });
  if (!tools.ffmpeg.available || !tools.ffprobe.available) { t.skip('FFmpeg and ffprobe are required for the synthetic MKV integration test.'); return; }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-matroska-probe-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const attachment = path.join(directory, 'ignored-attachment.bin'), sourceInput = path.join(directory, 'source.mkv');
  await writeFile(attachment, Buffer.alloc(512 * 1024, 0x37));
  await run(ffmpegPath, [
    '-v', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=40',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=40',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20', '-keyint_min', '20', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-cluster_time_limit', '1000',
    '-attach', attachment, '-metadata:s:t:0', 'mimetype=application/octet-stream', sourceInput,
  ], { timeout: 20_000, maxBuffer: MiB });
  const original = await probeMedia({ sourceInput, ffprobePath }), bytes = await readFile(sourceInput), top = topLevel(bytes);
  const firstCluster = top.find(e => e.id === ID.cluster), cues = top.find(e => e.id === ID.cues), attachments = top.find(e => e.id === ID.attachments);
  assert(firstCluster && cues && attachments, 'fixture must have media, an index footer, and a large attachment');
  assert(attachments.size > 500 * 1024);
  const forbidden = top.filter(e => [ID.cues, ID.tags, ID.attachments].includes(e.id)).map(e => ({ start: e.data, end: e.end, label: `unneeded table 0x${e.id.toString(16)}` }));
  // An arbitrary midpoint is forbidden too, unless it happens to be part of the
  // first media cluster genuinely required by this exact synthetic source.
  const midpoint = Math.floor(bytes.length / 2);
  if (midpoint < firstCluster.position || midpoint >= firstCluster.end) forbidden.push({ start: midpoint, end: midpoint + 1, label: 'arbitrary midpoint' });
  const calls = [], read = reader(bytes, calls, forbidden);
  const plan = await planMatroskaProbe({ read, size: bytes.length });
  assert.equal(plan?.method, 'matroska-head');
  assert(Math.abs(plan.durationSeconds - original.durationSeconds) < 1e-6, 'Duration must describe the whole original source');
  assert.equal(plan.window.sourceStart, firstCluster.position);
  assert.equal(plan.window.sourceEnd, firstCluster.end);
  assertBounded(calls);
  const planningBytes = calls.reduce((sum, c) => sum + c.length, 0);
  assert(planningBytes < 16 * 1024, 'native metadata planning must skip the 512 KiB attachment');
  const prepared = await materializeMatroskaWindow({ plan, read, directory, budgetBytes: firstCluster.end - firstCluster.position });
  t.after(prepared.cleanup);
  const countBeforeLocalProbe = calls.length;
  const observed = await probeMedia({ sourceInput: prepared.path, ffprobePath });
  assert.equal(calls.length, countBeforeLocalProbe, 'local FFprobe must not trigger any additional remote read');
  assert(Math.abs(observed.durationSeconds - original.durationSeconds) < 1e-6);
  const native = media => media.streams.filter(stream => ['video', 'audio'].includes(stream.type)).map(stream => ({
    index: stream.index, type: stream.type, codec: stream.codec, width: stream.width, height: stream.height, sampleRate: stream.sampleRate, channels: stream.channels,
  }));
  assert.deepEqual(native(observed), native(original));
  assert(!observed.streams.some(stream => stream.type === 'attachment'), 'unneeded attachment streams must not be copied into the probe window');
  const materializedReads = calls.slice(countBeforeLocalProbe - 1).filter(c => c.offset >= firstCluster.position);
  assert(materializedReads.every(c => c.offset + c.length <= firstCluster.end));
  assert(calls.reduce((sum, c) => sum + c.length, 0) < bytes.length / 4, 'head probing must not transfer a whole synthetic movie');

  // Replace the Cues table with an equally sized Void, preserving every other
  // byte position and the original Info.Duration. Probing remains possible even
  // though late indexed extraction must correctly report that no index exists.
  const withoutCues = Buffer.from(bytes), voidLength = cues.end - cues.position;
  Buffer.concat([idBytes(0xec), sizeBytes(voidLength - 9), Buffer.alloc(voidLength - 9)]).copy(withoutCues, cues.position);
  const unindexedPlan = await planMatroskaProbe({ read: reader(withoutCues), size: withoutCues.length });
  assert.equal(unindexedPlan?.method, 'matroska-head');
  assert.equal(unindexedPlan.durationSeconds, plan.durationSeconds);
  const unindexed = await materializeMatroskaWindow({ plan: unindexedPlan, read: reader(withoutCues), directory, budgetBytes: bytes.length });
  t.after(unindexed.cleanup);
  const unindexedMedia = await probeMedia({ sourceInput: unindexed.path, ffprobePath });
  assert.deepEqual(native(unindexedMedia), native(original));
  assert.equal(await locateMatroskaCue({ read: reader(withoutCues), size: withoutCues.length, start: 20, end: 25 }), null);
});
