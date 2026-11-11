import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import {
  detectTools, parseTime, probePosition, exportCandidate, exportCompatibleMp4, MediaError,
} from '../src/engine.mjs';

const execFileAsync = promisify(execFile);
const ffmpegPath = process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobePath = process.env.FFPROBE_PATH ?? 'ffprobe';

function isMediaError(code) {
  return error => {
    assert.ok(error instanceof MediaError);
    assert.equal(error.code, code);
    return true;
  };
}

async function fileDigest(filename) {
  return createHash('sha256').update(await fs.readFile(filename)).digest('hex');
}

async function decodedVideoHashes(filename) {
  const { stdout } = await execFileAsync(ffmpegPath, [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-i', filename,
    '-map', '0:v:0', '-an', '-sn', '-dn', '-fps_mode', 'passthrough', '-f', 'framemd5', '-',
  ], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  const frameRate = /^#tb 0: (\d+)\/(\d+)$/m.exec(stdout);
  assert.ok(frameRate, 'framemd5 must report a video time base');
  const frames = stdout.split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const fields = line.split(',').map(field => field.trim());
    assert.equal(fields.length, 6);
    return { dts: Number(fields[1]), pts: Number(fields[2]), duration: Number(fields[3]), md5: fields[5] };
  });
  assert.ok(frames.length > 0, 'full local decode must produce frames');
  return { frames, timeBase: Number(frameRate[1]) / Number(frameRate[2]) };
}

test('time parsing accepts precise user input and rejects ambiguous or invalid times', () => {
  assert.equal(parseTime('00:42:10.500'), 2530.5);
  assert.equal(parseTime('5.25'), 5.25);
  assert.equal(parseTime(0), 0);
  assert.equal(parseTime('05:25.250'), 325.25);
  for (const value of ['', 'abc', '-1', '00:61:00', '00:00:60', -1, Infinity, NaN, 604_801, null]) {
    assert.throws(() => parseTime(value), isMediaError('INVALID_TIME'));
  }
});

test('candidate and local derivative preserve the source image sequence and existing work', { timeout: 60_000 }, async t => {
  const tools = await detectTools({ ffmpegPath, ffprobePath });
  if (!tools.ffmpeg.available || !tools.ffprobe.available) {
    t.skip('Install FFmpeg and ffprobe, or set FFMPEG_PATH / FFPROBE_PATH, to run media integration tests.');
    return;
  }
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-fetcher-engine-test-'));
  t.after(() => fs.rm(temporaryRoot, { recursive: true, force: true }));
  const existingFixture = process.env.CLIP_FETCHER_TEST_SOURCE
    ?? fileURLToPath(new URL('../../../work/media-fixtures/source.mkv', import.meta.url));
  let sourceInput = existingFixture;
  try { await fs.access(sourceInput); } catch {
    // A portable, deterministic test fixture; no downloaded media or cloud account.
    sourceInput = path.join(temporaryRoot, 'source.mkv');
    await execFileAsync(ffmpegPath, [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-n',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=12',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-keyint_min', '48', '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', sourceInput,
    ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  }
  const outputDir = path.join(temporaryRoot, 'outputs');
  const common = {
    sourceInput, outputDir, start: 5.25, end: 9.5, jobId: 'fractional', ffmpegPath, ffprobePath,
    targetRange: { startSeconds: 6.25, endSeconds: 8.5, handlesSeconds: 1 },
    sourceDescriptor: {
      label: '测试素材 http://127.0.0.1:9999/private?token=fixture-manifest-secret',
      sizeBytes: (await fs.stat(sourceInput)).size,
    },
  };
  let candidate;
  let candidateHashes;

  await t.test('position preflight finds a video packet near a synthetic MKV target without claiming exact boundaries', async () => {
    const position = await probePosition({ sourceInput, start: 5.25, videoTrackIndex: 0, ffprobePath });
    assert.equal(Object.keys(position).sort().join(','), 'keyframe,positionBytes,timestampSeconds');
    assert(Number.isFinite(position.timestampSeconds));
    assert(position.timestampSeconds >= 0 && position.timestampSeconds <= 20.25);
    assert(Number.isSafeInteger(position.positionBytes) && position.positionBytes >= 0);
    assert.equal(typeof position.keyframe, 'boolean');
    assert(!JSON.stringify(position).includes(sourceInput));
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(probePosition({ sourceInput, start: 5.25, ffprobePath, signal: controller.signal }), isMediaError('CANCELLED'));
  });

  await t.test('fractional extraction returns a continuous original frame sequence covering the requested interval', async () => {
    const events = [];
    candidate = await exportCandidate({ ...common, onProgress: event => events.push(event) });
    const [originalHashes, resultHashes] = await Promise.all([
      decodedVideoHashes(sourceInput), decodedVideoHashes(candidate.candidatePath),
    ]);
    candidateHashes = resultHashes.frames.map(frame => frame.md5);
    const originalImageSequence = originalHashes.frames.map(frame => frame.md5);
    const firstIndex = originalImageSequence.indexOf(candidateHashes[0]);
    assert.ok(firstIndex >= 0, 'first candidate image must exist in source');
    assert.deepEqual(candidateHashes, originalImageSequence.slice(firstIndex, firstIndex + candidateHashes.length),
      'every output image must be the next original frame, with no frame loss, duplication or modification');
    const sourceStart = originalHashes.frames[firstIndex].pts * originalHashes.timeBase;
    const finalFrame = originalHashes.frames[firstIndex + candidateHashes.length - 1];
    const sourceEnd = (finalFrame.pts + finalFrame.duration) * originalHashes.timeBase;
    const oneFrame = originalHashes.timeBase;
    assert.ok(sourceStart <= common.start + oneFrame, `source start ${sourceStart} must cover requested start ${common.start}`);
    assert.ok(sourceEnd >= common.end - oneFrame, `source end ${sourceEnd} must cover requested end ${common.end}`);
    const sidecar = JSON.parse(await fs.readFile(candidate.sidecarPath, 'utf8'));
    assert.equal(sidecar.requestedRange.startSeconds, common.start);
    assert.equal(sidecar.requestedRange.endSeconds, common.end);
    assert.equal(sidecar.targetRange.startSeconds, 6.25);
    assert.equal(sidecar.targetRange.endSeconds, 8.5);
    assert.equal(sidecar.targetRange.handlesSeconds, 1);
    assert.equal(sidecar.source.sizeBytes, common.sourceDescriptor.sizeBytes);
    assert.equal(sidecar.source.label, '测试素材 [链接已隐藏]');
    assert.ok(!JSON.stringify(sidecar).includes('fixture-manifest-secret'), 'descriptor links must not persist credentials');
    assert.equal(sidecar.mapping.status, 'unverified', 'source timing must not be claimed as calibrated');
    assert.equal(sidecar.mapping.actualSourceStartSeconds, null);
    assert.equal(sidecar.processing.video, 'copy');
    assert.equal(sidecar.validation.firstVideoPacketIsKeyframe, true);
    assert.ok(events.some(event => event.phase === 'extract'));
    assert.equal(events[0].phase, 'probe');
    assert.equal(events[0].percent, null, 'media probing has no timeline percentage');
    assert.equal(events.find(event => event.phase === 'extract').percent, null, 'positioning must not report a fabricated 0%');
    assert.equal(events.find(event => event.phase === 'validate').percent, null, 'local validation cannot inherit extraction progress');
    assert.ok(events.filter(event => event.status === 'running' && event.percent !== null)
      .every(event => event.percent > 0 && event.percent < 100));
    assert.equal(events.at(-1).status, 'completed');
    assert.ok(!(await fs.readdir(path.dirname(candidate.candidatePath))).some(name => name.includes('.partial')));
    t.diagnostic(`Confirmed original-frame coverage ${sourceStart.toFixed(3)}–${sourceEnd.toFixed(3)}s for requested 5.250–9.500s.`);
  });

  await t.test('local MP4 derivative preserves every decoded image, converts audio to AAC stereo, and keeps the master', async () => {
    assert.ok(candidate, 'candidate extraction must have succeeded');
    const masterHashBefore = await fileDigest(candidate.candidatePath);
    const events = [];
    const result = await exportCompatibleMp4({
      candidatePath: candidate.candidatePath, outputDir: path.dirname(candidate.candidatePath), ffmpegPath, ffprobePath,
      onProgress: event => events.push(event),
    });
    const derivativeHashes = await decodedVideoHashes(result.outputPath);
    assert.deepEqual(derivativeHashes.frames.map(frame => frame.md5), candidateHashes);
    assert.equal(result.media.streams.find(stream => stream.type === 'video').codec, 'h264');
    const audio = result.media.streams.find(stream => stream.type === 'audio');
    assert.equal(audio.codec, 'aac');
    assert.equal(audio.channels, 2);
    assert.equal(result.manifest.processing.audio, 'aac-320k-stereo');
    assert.equal(result.manifest.validation.editorImportValidation, 'unverified');
    assert.equal(await fileDigest(candidate.candidatePath), masterHashBefore, 'derivative must not alter the original master');
    assert.equal(events[0].phase, 'compatible');
    assert.equal(events[0].percent, null, 'MP4 source probing starts with unknown progress');
    assert.equal(events.find(event => event.phase === 'validate').percent, null);
    assert.equal(events.at(-1).percent, 100);
  });

  await t.test('reusing a job ID refuses overwrite and leaves both committed files intact', async () => {
    assert.ok(candidate, 'candidate extraction must have succeeded');
    assert.equal(path.basename(path.dirname(candidate.candidatePath)), common.jobId);
    const before = await Promise.all([fileDigest(candidate.candidatePath), fileDigest(candidate.sidecarPath)]);
    await assert.rejects(exportCandidate(common), isMediaError('JOB_EXISTS'));
    assert.deepEqual(await Promise.all([fileDigest(candidate.candidatePath), fileDigest(candidate.sidecarPath)]), before);
  });

  await t.test('a pre-cancelled task never creates an artifact or a job directory', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(exportCandidate({ ...common, jobId: 'pre-cancelled', signal: controller.signal }), isMediaError('CANCELLED'));
    await assert.rejects(fs.access(path.join(outputDir, 'pre-cancelled')), { code: 'ENOENT' });
  });

  await t.test('cancelling a named task removes only its newly reserved directory', async () => {
    const clipName = '已保存素材', existing = path.join(outputDir, clipName);
    await fs.mkdir(existing);
    const sentinel = path.join(existing, '保留.mkv');
    await fs.writeFile(sentinel, 'existing material');
    const controller = new AbortController();
    await assert.rejects(exportCandidate({ ...common, jobId: 'named-cancelled', clipName, signal: controller.signal,
      onProgress(event) { if (event.phase === 'extract') controller.abort(); },
    }), isMediaError('CANCELLED'));
    assert.equal(await fs.readFile(sentinel, 'utf8'), 'existing material');
    await assert.rejects(fs.access(path.join(outputDir, `${clipName} (2)`)), { code: 'ENOENT' });
  });

  await t.test('failed named publication never recursively deletes unrelated files in its directory', async () => {
    const clipName = '未提交素材', directory = path.join(outputDir, clipName);
    await assert.rejects(exportCandidate({ ...common, jobId: 'named-guard', clipName, async beforeCommit() {
      await fs.writeFile(path.join(directory, '用户放入的文件.txt'), 'keep unrelated file');
      throw new MediaError('SOURCE_CHANGED', '模拟来源校验失败');
    } }), isMediaError('SOURCE_CHANGED'));
    assert.deepEqual(await fs.readdir(directory), ['用户放入的文件.txt']);
    assert.equal(await fs.readFile(path.join(directory, '用户放入的文件.txt'), 'utf8'), 'keep unrelated file');
  });

  await t.test('a maximum-length canonical name keeps existing numbered local MP4 copies compatible', async () => {
    const clipName = '长'.repeat(60);
    assert.equal(Buffer.byteLength(clipName), 180);
    // A canonical user title may itself end with a number; it is not always a generated suffix.
    for (const name of [`${clipName} (100)`, '素材.mkv (2)']) {
      const result = await exportCompatibleMp4({ candidatePath: candidate.candidatePath, clipName: name,
        jobId: 'long-numbered-copy', ffmpegPath, ffprobePath });
      assert.equal(path.basename(result.outputPath), `${name}.mp4`);
      assert.equal(path.dirname(result.outputPath), path.dirname(candidate.candidatePath));
      assert((await fs.stat(result.outputPath)).size > 0);
    }
  });

  await t.test('a source guard failure prevents publication even after successful media processing', async () => {
    let called = false;
    await assert.rejects(exportCandidate({ ...common, jobId: 'source-guard', beforeCommit() {
      called = true;
      throw new MediaError('SOURCE_CHANGED', '模拟读取层发现来源改变');
    } }), isMediaError('SOURCE_CHANGED'));
    assert.equal(called, true);
    await assert.rejects(fs.access(path.join(outputDir, 'source-guard')), { code: 'ENOENT' });
  });

  await t.test('an invalid or reversed range stops before creating a job', async () => {
    await assert.rejects(exportCandidate({ ...common, jobId: 'bad-time', start: '00:99:00' }), isMediaError('INVALID_TIME'));
    await assert.rejects(exportCandidate({ ...common, jobId: 'bad-range', start: 10, end: 5 }), isMediaError('INVALID_RANGE'));
    await assert.rejects(exportCandidate({ ...common, jobId: 'outside-target', targetRange: { startSeconds: 4, endSeconds: 6 } }), isMediaError('INVALID_TARGET_RANGE'));
    await assert.rejects(fs.access(path.join(outputDir, 'bad-time')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(outputDir, 'bad-range')), { code: 'ENOENT' });
    await assert.rejects(fs.access(path.join(outputDir, 'outside-target')), { code: 'ENOENT' });
  });
});

test('position preflight rejects invalid targets before accessing a source', async () => {
  for (const start of [undefined, null, '5', -1, NaN, Infinity, -Infinity]) {
    await assert.rejects(probePosition({ sourceInput: '/not-a-real-source.mkv', start }), isMediaError('INVALID_TIME'));
  }
});

test('position preflight rejects invalid video track indexes before accessing a source', async () => {
  for (const videoTrackIndex of [null, '0', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(probePosition({ sourceInput: '/not-a-real-source.mkv', start: 5, videoTrackIndex }), isMediaError('INVALID_TRACK'));
  }
});
