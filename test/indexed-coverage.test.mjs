import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, readdir, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { detectTools, exportCandidate, probeMedia } from '../src/engine.mjs';
import { locateMatroskaCue } from '../src/matroska-index.mjs';
import { materializeMatroskaWindow } from '../src/matroska-window.mjs';

const run = promisify(execFile);
const ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH ?? 'ffprobe';
const commonTools = { ffmpegPath, ffprobePath };

async function packets(filename) {
  const { stdout } = await run(ffprobePath, [
    '-v', 'error', '-show_packets', '-show_data_hash', 'sha256',
    '-show_entries', 'packet=stream_index,pts_time,duration_time,flags,data_hash', '-of', 'json', filename,
  ], { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout).packets;
}

async function videoFrames(filename) {
  const { stdout } = await run(ffmpegPath, [
    '-v', 'error', '-xerror', '-nostdin', '-i', filename, '-map', '0:v:0',
    '-an', '-fps_mode', 'passthrough', '-f', 'framemd5', '-',
  ], { timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  const base = /^#tb 0: (\d+)\/(\d+)$/m.exec(stdout);
  assert(base, 'full decode must report a video time base');
  const timeBase = Number(base[1]) / Number(base[2]);
  const frames = stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const [, , pts, duration, , hash] = line.split(',').map(value => value.trim());
    return { time: Number(pts) * timeBase, end: (Number(pts) + Number(duration)) * timeBase, hash };
  });
  assert(frames.length > 0, 'full decode must produce frames');
  return frames;
}

test('indexed local preparation verifies actual coverage before publishing a late clip', { timeout: 90_000 }, async t => {
  const tools = await detectTools(commonTools);
  if (!tools.ffmpeg.available || !tools.ffprobe.available) {
    t.skip('FFmpeg and ffprobe are required for the synthetic media integration test.'); return;
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-indexed-coverage-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceInput = path.join(directory, 'two-audio-source.mkv');
  // Twenty-second GOPs deliberately leave substantial leading material before
  // 63 seconds. An output duration check alone could mistake that leading GOP
  // for the missing tail when an incomplete window is later requested to 82s.
  await run(ffmpegPath, [
    '-v', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=10:duration=80',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=80',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=80',
    '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '200', '-keyint_min', '200', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '48k',
    '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=zho',
    '-disposition:a:0', 'default', '-disposition:a:1', '0',
    '-cluster_time_limit', '1000', '-shortest', sourceInput,
  ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const originalMedia = await probeMedia({ sourceInput, ffprobePath });
  assert.deepEqual(originalMedia.streams.map(stream => [stream.index, stream.type]), [[0, 'video'], [1, 'audio'], [2, 'audio']]);
  const source = await readFile(sourceInput), reads = [];
  const read = async (offset, length) => {
    assert(offset >= 0 && length > 0 && offset + length <= source.length);
    reads.push({ offset, length });
    return source.subarray(offset, offset + length);
  };
  const plan = await locateMatroskaCue({ read, size: source.length, start: 63, end: 68, videoStreamIndex: 0, videoCodec: 'h264' });
  assert(plan?.window, 'the real encoded MKV must provide a verified index window');
  assert(plan.timestampSeconds <= 63 && plan.timestampSeconds > 30);
  const prepared = await materializeMatroskaWindow({ plan, read, directory, budgetBytes: source.length });
  t.after(prepared.cleanup);
  const preparedMedia = await probeMedia({ sourceInput: prepared.path, ffprobePath });
  assert.deepEqual(preparedMedia.streams.map(stream => [stream.index, stream.type]), [[0, 'video'], [1, 'audio'], [2, 'audio']],
    'preparation must retain original track order, including unselected audio');
  const preparedPackets = await packets(prepared.path);
  const videoPackets = preparedPackets.filter(packet => packet.stream_index === 0);
  const first = Math.min(...videoPackets.map(packet => Number(packet.pts_time)));
  const lastEnd = Math.max(...videoPackets.map(packet => Number(packet.pts_time) + Number(packet.duration_time || 0)));
  assert(first > 30 && first <= 63, 'the window must retain absolute source coordinates');
  assert(lastEnd >= 68 && lastEnd < 82);
  assert(lastEnd - first >= 82 - 63, 'the leading GOP must be long enough to hide a missing tail from a duration-only check');
  const options = {
    ...commonTools, sourceInput: prepared.path, outputDir: path.join(directory, 'exports'),
    start: 63, end: 68, absoluteSeek: true, originalMedia,
    preparation: { sourceStart: plan.window.sourceStart, sourceEnd: plan.window.sourceEnd, cueSeconds: plan.timestampSeconds },
  };

  await t.test('the target is covered in original coordinates and the complete output decodes', async () => {
    const candidate = await exportCandidate({ ...options, jobId: 'indexed-63-68' });
    const manifest = JSON.parse(await readFile(candidate.sidecarPath, 'utf8'));
    const coverage = manifest.inputPreparation.coverage;
    assert.equal(coverage.status, 'passed');
    assert.equal(coverage.keyframeBeforeRequestedStart, true);
    assert(coverage.firstVideoTimestampSeconds <= 63);
    assert(coverage.lastVideoEndSeconds >= 68, 'coverage must reach the requested end on the source timeline');
    assert.equal(coverage.lastVideoEndSeconds, lastEnd);
    assert.deepEqual(manifest.requestedRange, { startSeconds: 63, endSeconds: 68, durationSeconds: 5 });
    const [originalFrames, candidateFrames] = await Promise.all([videoFrames(sourceInput), videoFrames(candidate.candidatePath)]);
    const at = originalFrames.findIndex(frame => frame.hash === candidateFrames[0].hash);
    assert(at >= 0);
    assert.deepEqual(candidateFrames.map(frame => frame.hash), originalFrames.slice(at, at + candidateFrames.length).map(frame => frame.hash),
      'the entire decoded clip must be one unmodified continuous source image sequence');
    assert(originalFrames[at].time <= 63 + 0.1);
    assert(originalFrames[at + candidateFrames.length - 1].end >= 68 - 0.1);
    await run(ffmpegPath, ['-v', 'error', '-xerror', '-nostdin', '-i', candidate.candidatePath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 20_000 });
  });

  await t.test('a missing target tail is rejected even when container duration and leading GOP appear sufficient', async () => {
    const outputDir = path.join(directory, 'rejected'); await mkdir(outputDir);
    await assert.rejects(exportCandidate({
      ...options, outputDir, jobId: 'missing-tail', end: 82,
      originalMedia: { ...originalMedia, durationSeconds: 120 },
    }), error => error.code === 'PREPARED_COVERAGE_INCOMPLETE');
    assert.deepEqual(await readdir(outputDir), [], 'failed coverage must publish neither candidate, sidecar, nor partial output');
  });

  await t.test('selecting the second original audio index exports that encoded track rather than the default audio', async () => {
    const candidate = await exportCandidate({ ...options, jobId: 'second-audio', audioTrackIndex: 2 });
    assert.equal(candidate.manifest.selectedTracks.audio.index, 2);
    assert.equal(candidate.manifest.selectedTracks.audio.language, 'zho');
    const audios = candidate.media.streams.filter(stream => stream.type === 'audio');
    assert.equal(audios.length, 1); assert.equal(audios[0].language, 'zho');
    const actualAudio = (await packets(candidate.candidatePath)).filter(packet => packet.stream_index === audios[0].index).map(packet => packet.data_hash);
    const originalPackets = await packets(sourceInput);
    const chosen = originalPackets.filter(packet => packet.stream_index === 2).map(packet => packet.data_hash);
    const defaultAudio = new Set(originalPackets.filter(packet => packet.stream_index === 1).map(packet => packet.data_hash));
    assert(actualAudio.length > 50);
    // A stationary sine produces repeated AAC payloads. Locate the whole
    // sequence, rather than assuming its first repeated packet is unique.
    const at = chosen.findIndex((hash, index) => hash === actualAudio[0]
      && actualAudio.every((packet, offset) => packet === chosen[index + offset]));
    assert(at >= 0, 'the complete encoded output audio sequence must exist contiguously in the selected source track');
    assert.deepEqual(actualAudio, chosen.slice(at, at + actualAudio.length), 'compressed audio packets must match the selected original track in order');
    assert(actualAudio.some(hash => !defaultAudio.has(hash)), 'fixture audio tracks must have distinct payloads');
    await run(ffmpegPath, ['-v', 'error', '-xerror', '-nostdin', '-i', candidate.candidatePath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 20_000 });
  });
});
