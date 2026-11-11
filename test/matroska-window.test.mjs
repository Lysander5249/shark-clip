import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { materializeMatroskaWindow } from '../src/matroska-window.mjs';

const run = promisify(execFile);
const ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH ?? 'ffprobe';
const ids = { ebml: '1a45dfa3', segment: '18538067', info: '1549a966', tracks: '1654ae6b', cluster: '1f43b675', seek: '114d9b74', cues: '1c53bb6b', void: 'ec' };
function sizeBytes(length) {
  for (let width = 1; width <= 8; width++) {
    if (BigInt(length) >= (1n << BigInt(width * 7)) - 1n) continue;
    let value = (1n << BigInt(width * 7)) | BigInt(length);
    const data = Buffer.alloc(width);
    for (let i = width - 1; i >= 0; i--) { data[i] = Number(value & 255n); value >>= 8n; }
    return data;
  }
  throw new Error('fixture too large');
}
function element(id, payload) { return Buffer.concat([Buffer.from(id, 'hex'), sizeBytes(payload.length), payload]); }
const segment = Buffer.from('1853806701ffffffffffffff', 'hex');
function smallPrefix() {
  // Structural-only test bytes. The integration test below uses real Info/Tracks.
  return Buffer.concat([element(ids.ebml, Buffer.from([0x42])), segment,
    element(ids.info, Buffer.from([0x42])), element(ids.tracks, Buffer.from([0x42]))]);
}
function planFor(data, prefix = smallPrefix()) {
  return { prefix, sourceStart: 4096, sourceEnd: 4096 + data.length, timelineStartSeconds: 60, timelineEndSeconds: 65 };
}
function readerFor(data, calls = []) {
  return async (offset, length) => { calls.push({ offset, length }); return data.subarray(offset - 4096, offset - 4096 + length); };
}
async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-window-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('materialized window copies only its planned range in bounded chunks and cleanup is idempotent', async t => {
  const directory = await temporary(t);
  const data = Buffer.concat([element(ids.cluster, Buffer.alloc(1024 * 1024 + 257, 0x3a)),
    element(ids.void, Buffer.alloc(7)), element(ids.cluster, Buffer.alloc(123, 0x27))]);
  const plan = planFor(data), calls = [], progress = [];
  const result = await materializeMatroskaWindow({ plan: { window: plan }, read: readerFor(data, calls), directory,
    budgetBytes: data.length, onProgress: event => progress.push(event) });
  assert.equal(result.bytesWritten, plan.prefix.length + data.length);
  assert.deepEqual(await readFile(result.path), Buffer.concat([plan.prefix, data]));
  assert.equal(calls.length, 2);
  assert(calls.every(call => call.length > 0 && call.length <= 1024 * 1024));
  assert.equal(calls[0].offset, plan.sourceStart);
  assert.equal(calls.at(-1).offset + calls.at(-1).length, plan.sourceEnd);
  assert(progress.every(event => event.phase === 'fetch' && event.totalBytes === data.length));
  assert.equal(progress[0].percent, 0);
  assert.equal(progress.at(-1).percent, 100);
  assert(progress.slice(0, -1).every(event => event.percent <= 99));
  assert.equal((await stat(result.path)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(result.path))).mode & 0o777, 0o700);
  await Promise.all([result.cleanup(), result.cleanup()]);
  await result.cleanup();
  assert.deepEqual(await readdir(directory), []);
});

test('budget and invalid plans stop before source reads or filesystem creation', async t => {
  const directory = await temporary(t), data = element(ids.cluster, Buffer.alloc(24)), plan = planFor(data);
  let reads = 0;
  const common = { plan, read: async () => { reads++; return data; }, directory, budgetBytes: data.length - 1 };
  await assert.rejects(materializeMatroskaWindow(common), { code: 'BUDGET_EXCEEDED' });
  for (const changed of [{ sourceStart: -1 }, { sourceEnd: plan.sourceStart }, { timelineEndSeconds: 0 }, { prefix: Buffer.concat([plan.prefix, element(ids.cues, Buffer.alloc(1))]) }]) {
    await assert.rejects(materializeMatroskaWindow({ ...common, budgetBytes: data.length, plan: { ...plan, ...changed } }), { code: 'INVALID_MATROSKA_WINDOW' });
  }
  assert.equal(reads, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('truncated reads and upstream failures clean temporary files and expose no source URL', async t => {
  const directory = await temporary(t), data = element(ids.cluster, Buffer.alloc(50)), plan = planFor(data);
  await assert.rejects(materializeMatroskaWindow({ plan, read: async () => data.subarray(0, -1), directory, budgetBytes: data.length }), { code: 'WINDOW_READ_FAILED' });
  await assert.rejects(materializeMatroskaWindow({ plan, read: async () => { throw Object.assign(new Error('https://private.example/?secret=hidden'), { code: 'SOURCE_CHANGED' }); }, directory, budgetBytes: data.length }), error => {
    assert.equal(error.code, 'SOURCE_CHANGED');
    assert(!String(error.stack).includes('private.example'));
    return true;
  });
  assert.deepEqual(await readdir(directory), []);
});

test('cancellation before or during a stalled read cleans temporary files promptly', async t => {
  const directory = await temporary(t), data = element(ids.cluster, Buffer.alloc(50)), plan = planFor(data);
  const controller = new AbortController(); controller.abort();
  let calls = 0;
  await assert.rejects(materializeMatroskaWindow({ plan, read: async () => { calls++; return data; }, directory, signal: controller.signal, budgetBytes: data.length }), { code: 'CANCELLED' });
  assert.equal(calls, 0);
  const stalled = new AbortController();
  await assert.rejects(materializeMatroskaWindow({ plan, read: async () => { stalled.abort(); return new Promise(() => {}); }, directory, signal: stalled.signal, budgetBytes: data.length }), { code: 'CANCELLED' });
  assert.deepEqual(await readdir(directory), []);
});

test('stale seek tables, unknown-size clusters and cut cluster boundaries are rejected', async t => {
  const directory = await temporary(t);
  for (const data of [
    Buffer.concat([element(ids.cluster, Buffer.alloc(1)), element(ids.seek, Buffer.alloc(1))]),
    Buffer.concat([element(ids.cluster, Buffer.alloc(1)), element(ids.cues, Buffer.alloc(1))]),
    Buffer.from('1f43b675ff000000', 'hex'),
    element(ids.cluster, Buffer.alloc(50)).subarray(0, -1),
    Buffer.from('1f43b6', 'hex'),
  ]) {
    await assert.rejects(materializeMatroskaWindow({ plan: planFor(data), read: readerFor(data), directory, budgetBytes: data.length }), { code: 'INVALID_MATROSKA_WINDOW' });
    assert.deepEqual(await readdir(directory), []);
  }
});

function header(data, at) {
  const begin = at;
  function vint(isId) {
    let width = 1;
    while (!(data[at] & (1 << (8 - width)))) width++;
    let value = BigInt(isId ? data[at] : data[at] & ((1 << (8 - width)) - 1));
    for (let i = 1; i < width; i++) value = (value << 8n) | BigInt(data[at + i]);
    at += width;
    return !isId && value === (1n << BigInt(7 * width)) - 1n ? null : Number(value);
  }
  const id = vint(true), size = vint(false);
  return { id, position: begin, data: at, size, end: size === null ? data.length : at + size };
}
function elements(data, start, end) {
  const result = [];
  for (let at = start; at < end;) { const e = header(data, at); assert(e.end > at && e.end <= end); result.push(e); at = e.end; }
  return result;
}

test('a real local window preserves original absolute packet timestamps and compressed payloads', { timeout: 45000 }, async t => {
  try { await Promise.all([run(ffmpegPath, ['-version']), run(ffprobePath, ['-version'])]); }
  catch { t.skip('FFmpeg and ffprobe are required for the local media integration test.'); return; }
  const directory = await temporary(t), sourcePath = path.join(directory, 'synthetic.mkv');
  await run(ffmpegPath, ['-v', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=24:duration=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=8',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-output_ts_offset', '60', '-cluster_time_limit', '1000', sourcePath], { timeout: 20000 });
  const source = await readFile(sourcePath), ebml = header(source, 0), originalSegment = header(source, ebml.end);
  const top = elements(source, originalSegment.data, originalSegment.end);
  const info = top.find(e => e.id === Number.parseInt(ids.info, 16)), tracks = top.find(e => e.id === Number.parseInt(ids.tracks, 16));
  const clusters = top.filter(e => e.id === Number.parseInt(ids.cluster, 16));
  assert(clusters.length >= 6);
  const first = clusters[2], last = clusters[5];
  const clusterTime = cluster => {
    const time = elements(source, cluster.data, cluster.end).find(e => e.id === 0xe7);
    let value = 0; for (const byte of source.subarray(time.data, time.end)) value = value * 256 + byte;
    return value / 1000;
  };
  const plan = { prefix: Buffer.concat([source.subarray(0, ebml.end), segment,
    source.subarray(info.position, info.end), source.subarray(tracks.position, tracks.end)]),
    sourceStart: first.position, sourceEnd: last.end,
    timelineStartSeconds: clusterTime(first), timelineEndSeconds: clusterTime(last) + 1 };
  const calls = [], result = await materializeMatroskaWindow({ plan, directory,
    budgetBytes: plan.sourceEnd - plan.sourceStart,
    read: async (offset, length) => { calls.push({ offset, length }); return source.subarray(offset, offset + length); } });
  t.after(result.cleanup);
  assert(calls.every(call => call.offset >= plan.sourceStart && call.offset + call.length <= plan.sourceEnd));
  const packets = async filename => JSON.parse((await run(ffprobePath, ['-v', 'error', '-show_packets', '-show_data_hash', 'sha256',
    '-show_entries', 'packet=stream_index,pts_time,dts_time,pos,data_hash,flags', '-of', 'json', filename], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 })).stdout).packets;
  const original = (await packets(sourcePath)).filter(packet => Number(packet.pos) >= plan.sourceStart && Number(packet.pos) < plan.sourceEnd);
  const actual = await packets(result.path);
  // Codec initialization can synthesize AAC Skip Samples side data on the first
  // staged audio packet. Compare immutable payloads and source time coordinates,
  // rather than claiming decoder state is identical after a mid-file start.
  const normalized = ({ stream_index, pts_time, dts_time, flags, data_hash }) => ({ stream_index, pts_time, dts_time, flags, data_hash });
  assert(actual.length > 50);
  assert.deepEqual(actual.map(normalized), original.map(normalized));
  assert(Math.min(...actual.map(packet => Number(packet.pts_time))) > 60, 'the staged timeline must not silently be rebased');
  await run(ffmpegPath, ['-v', 'error', '-xerror', '-nostdin', '-i', result.path, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 15000 });
  const trimmedPath = path.join(directory, 'trimmed.mkv');
  await run(ffmpegPath, ['-v', 'error', '-nostdin', '-n', '-seek_timestamp', '1', '-ss', '63.25', '-noaccurate_seek', '-i', result.path,
    '-t', '1.5', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-avoid_negative_ts', 'make_zero', trimmedPath], { timeout: 15000 });
  const trimmed = await packets(trimmedPath);
  const firstOriginalVideo = original.find(packet => packet.stream_index === 0 && packet.pts_time === '63.000000');
  assert(firstOriginalVideo);
  assert.equal(trimmed.find(packet => packet.stream_index === 0).data_hash, firstOriginalVideo.data_hash,
    'absolute timestamp seeking must select the intended keyframe rather than adding the staged start time');
  await run(ffmpegPath, ['-v', 'error', '-xerror', '-nostdin', '-i', trimmedPath, '-f', 'null', '-'], { timeout: 15000 });
  await result.cleanup();
});
