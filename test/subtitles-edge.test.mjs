import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exportCandidate } from '../src/engine.mjs';
import { hasPgsDisplay, alignSrt } from '../src/subtitles.mjs';

const exec = promisify(execFile);
const fixtureFfmpeg = process.env.SUBTITLE_FIXTURE_FFMPEG ?? 'ffmpeg';
const ffmpegPath = process.env.SUBTITLE_TEST_FFMPEG ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobePath = process.env.SUBTITLE_TEST_FFPROBE ?? process.env.FFPROBE_PATH ?? 'ffprobe';
const run = (tool, args) => exec(tool, args, { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
const u16 = value => { const b = Buffer.alloc(2); b.writeUInt16BE(value); return b; };
const u24 = value => { const b = Buffer.alloc(3); b.writeUIntBE(value, 0, 3); return b; };

// Synthetic PGS fixture: a 2x2 white bitmap and explicit clear events. Segment
// fields follow the shipped pgssubdec.c parser; no third-party media is included.
function segment(seconds, type, payload) {
  const header = Buffer.alloc(13); header.write('PG'); header.writeUInt32BE(Math.round(seconds * 90000), 2);
  header[10] = type; header.writeUInt16BE(payload.length, 11); return Buffer.concat([header, payload]);
}
function display(seconds, number, shown = true) {
  const pcs = Buffer.concat([u16(320), u16(180), Buffer.from([0x10]), u16(number), Buffer.from([shown ? 0x80 : 0, 0, 0, shown ? 1 : 0]),
    ...(shown ? [u16(0), Buffer.from([0, 0]), u16(140), u16(160)] : [])]);
  const parts = [segment(seconds, 0x16, pcs)];
  if (shown) {
    const rle = Buffer.from([1, 1, 0, 0, 1, 1, 0, 0]);
    parts.push(segment(seconds, 0x17, Buffer.concat([Buffer.from([1, 0]), u16(140), u16(160), u16(2), u16(2)])),
      segment(seconds, 0x14, Buffer.from([0, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, 255])),
      segment(seconds, 0x15, Buffer.concat([u16(0), Buffer.from([0, 0xc0]), u24(4 + rle.length), u16(2), u16(2), rle])));
  }
  parts.push(segment(seconds, 0x80, Buffer.alloc(0))); return Buffer.concat(parts);
}
function parseSup(bytes) {
  const result = [];
  for (let position = 0; position < bytes.length;) {
    assert(position + 13 <= bytes.length); assert.equal(bytes.toString('ascii', position, position + 2), 'PG');
    const length = bytes.readUInt16BE(position + 11), end = position + 13 + length; assert(end <= bytes.length);
    result.push({ seconds: bytes.readUInt32BE(position + 2) / 90000, type: bytes[position + 10], data: bytes.subarray(position + 13, end) }); position = end;
  }
  return result;
}
const packets = async (filename, selector) => JSON.parse((await run(ffprobePath, ['-v', 'error', '-select_streams', selector,
  '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=pts_time,data_hash', '-of', 'json', filename])).stdout).packets;
const streams = async filename => JSON.parse((await run(ffprobePath, ['-v', 'error', '-show_streams', '-of', 'json', filename])).stdout).streams;

test('PGS inspection distinguishes visible bitmap presentations from clears and rejects malformed/truncated segments', () => {
  assert.equal(hasPgsDisplay(Buffer.alloc(0)), false);
  assert.equal(hasPgsDisplay(display(1, 0, false)), false);
  assert.equal(hasPgsDisplay(display(1, 0)), true);
  const valid = display(1, 0);
  for (const malformed of [valid.subarray(0, 1), valid.subarray(0, 12), valid.subarray(0, valid.length - 1),
    Buffer.concat([valid, Buffer.from([1])]), segment(1, 0x16, Buffer.alloc(10))]) assert.throws(() => hasPgsDisplay(malformed));
  const magic = Buffer.from(valid); magic[0] = 0; assert.throws(() => hasPgsDisplay(magic));
  const length = Buffer.from(valid); length.writeUInt16BE(65535, 11); assert.throws(() => hasPgsDisplay(length));
  const missingObject = Buffer.alloc(11); missingObject[10] = 1; assert.throws(() => hasPgsDisplay(segment(1, 0x16, missingObject)));
  const missingCrop = Buffer.alloc(19); missingCrop[10] = 1; missingCrop[14] = 0x80;
  assert.throws(() => hasPgsDisplay(segment(1, 0x16, missingCrop)));
  // Validation must continue beyond an early visible presentation.
  assert.throws(() => hasPgsDisplay(Buffer.concat([valid, Buffer.from('broken')])));
});

test('SRT clipping drops cues that become zero duration after millisecond rounding', () => {
  const source = '1\n00:00:01,000 --> 00:00:02,000\n短尾部\n';
  assert.equal(alignSrt(source, { offsetSeconds: 0.0004, durationSeconds: 1.00049 }).cues, 0);
  assert.equal(alignSrt(source, { offsetSeconds: -1, durationSeconds: 0.00049 }).cues, 0);
  const valid = alignSrt(source, { offsetSeconds: 0.0006, durationSeconds: 1.002 });
  assert.equal(valid.cues, 1); assert.match(valid.text, /00:00:01,001 --> 00:00:01,002/);
});

test('actual target runtime preserves PGS event timing in independent SUP and cancels without publishing partial artifacts', { timeout: 60000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-subtitle-pgs-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sup = path.join(root, 'bitmap.sup'), source = path.join(root, 'source.mkv');
  const original = Buffer.concat([display(4.5, 0), display(6.5, 1, false), display(7.2, 2), display(8.8, 3, false), display(9.2, 4), display(11, 5, false)]);
  await fs.writeFile(sup, original);
  await run(fixtureFfmpeg, ['-v', 'error', '-n', '-copyts', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=14',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=14', '-i', sup, '-map', '0:v', '-map', '1:a', '-map', '2:s',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-bf', '2', '-c:a', 'aac', '-c:s', 'copy', source]);
  // Decode the synthetic bitmap fixture, failing on decoder errors rather than
  // counting arbitrary nonempty bytes as a subtitle sample.
  await run(fixtureFfmpeg, ['-v', 'error', '-xerror', '-i', source, '-filter_complex', '[0:v][0:s]overlay', '-an', '-c:v', 'wrapped_avframe', '-f', 'null', '-']);
  const common = { sourceInput: source, outputDir: root, start: 5.25, end: 9.5, subtitleStreamIndex: 2, ffmpegPath, ffprobePath };
  const result = await exportCandidate({ ...common, jobId: 'pgs', clipName: '独立图片字幕' });
  assert.equal(result.subtitlePaths.length, 1, JSON.stringify(result.subtitleWarnings)); assert.equal(path.extname(result.subtitlePaths[0]), '.sup');
  assert.equal(result.subtitleResults[0].kind, 'image'); assert(result.subtitleWarnings.some(w => w.code === 'SUBTITLE_IMAGE_FORMAT'));
  assert(!(await streams(result.candidatePath)).some(stream => stream.codec_type === 'subtitle'));
  const [before, after] = await Promise.all([packets(source, 'v:0'), packets(result.candidatePath, 'v:0')]);
  const firstSource = before.find(packet => packet.data_hash === after[0].data_hash); assert(firstSource);
  const offset = Number(after[0].pts_time) - Number(firstSource.pts_time);
  const presentations = parseSup(await fs.readFile(result.subtitlePaths[0])).filter(s => s.type === 0x16);
  assert(presentations.some(s => s.data[10] > 0), 'export must contain a visible presentation, not just clearing commands');
  for (const presentation of presentations) {
    const originalPresentation = parseSup(original).find(s => s.type === 0x16 && s.data.equals(presentation.data)); assert(originalPresentation);
    assert(Math.abs(presentation.seconds - (originalPresentation.seconds + offset)) <= 0.005, 'bitmap event must share the actual video timeline');
  }
  await run(fixtureFfmpeg, ['-v', 'error', '-xerror', '-i', result.candidatePath, '-i', result.subtitlePaths[0],
    '-filter_complex', '[0:v][1:s]overlay', '-an', '-c:v', 'wrapped_avframe', '-f', 'null', '-']);

  await t.test('a range containing only PGS clearing commands keeps the video and reports no usable subtitle', async () => {
    const empty = await exportCandidate({ ...common, start: 11.25, end: 12.5, jobId: 'pgs-empty' });
    assert.deepEqual(empty.subtitlePaths, []); assert.equal(empty.manifest.subtitles.status, 'unavailable');
    assert(empty.subtitleWarnings.some(w => w.code === 'SUBTITLE_EMPTY_RANGE'));
    assert((await fs.stat(empty.candidatePath)).size > 0);
    assert(!(await fs.readdir(path.dirname(empty.candidatePath))).some(file => file.endsWith('.sup') || file.includes('.partial')));
  });
  await t.test('DVD bitmap subtitles remain an independent subtitle-only MKS with the actual video time offset', async () => {
    const dvdSource = path.join(root, 'dvd.mkv');
    await run(fixtureFfmpeg, ['-v', 'error', '-n', '-copyts', '-fix_sub_duration', '-i', source, '-map', '0', '-c', 'copy', '-c:s', 'dvdsub', dvdSource]);
    const dvd = await exportCandidate({ ...common, sourceInput: dvdSource, jobId: 'dvd' });
    assert.equal(dvd.subtitlePaths.length, 1, JSON.stringify(dvd.subtitleWarnings)); assert.equal(path.extname(dvd.subtitlePaths[0]), '.mks');
    const dvdStreams = await streams(dvd.subtitlePaths[0]); assert.equal(dvdStreams.length, 1); assert.equal(dvdStreams[0].codec_type, 'subtitle');
    assert.equal(dvdStreams[0].codec_name, 'dvd_subtitle'); assert.equal(dvd.subtitleResults[0].kind, 'image');
    const [srcVideo, outVideo, srcSubtitle, outSubtitle] = await Promise.all([packets(dvdSource, 'v:0'), packets(dvd.candidatePath, 'v:0'), packets(dvdSource, 's:0'), packets(dvd.subtitlePaths[0], 's:0')]);
    const originVideo = srcVideo.find(packet => packet.data_hash === outVideo[0].data_hash); assert(originVideo);
    const dvdOffset = Number(outVideo[0].pts_time) - Number(originVideo.pts_time); assert(outSubtitle.length > 0);
    for (const packet of outSubtitle) {
      const originalPacket = srcSubtitle.find(item => item.data_hash === packet.data_hash); assert(originalPacket);
      assert(Math.abs(Number(packet.pts_time) - Number(originalPacket.pts_time) - dvdOffset) <= 0.005);
    }
    const empty = await exportCandidate({ ...common, sourceInput: dvdSource, start: 11.25, end: 12.5, jobId: 'dvd-empty' });
    assert.deepEqual(empty.subtitlePaths, []); assert.equal(empty.manifest.subtitles.status, 'unavailable');
    assert((await fs.stat(empty.candidatePath)).size > 0);
    assert(empty.subtitleWarnings.some(w => ['SUBTITLE_EMPTY_RANGE', 'SUBTITLE_EXPORT_FAILED'].includes(w.code)));
    assert(!(await fs.readdir(path.dirname(empty.candidatePath))).some(file => file.endsWith('.mks') || file.includes('.partial')));
  });
  await t.test('cancelling at local subtitle export removes staged video and subtitle files', async () => {
    const controller = new AbortController();
    await assert.rejects(exportCandidate({ ...common, jobId: 'pgs-cancel', signal: controller.signal, onProgress(event) {
      if (event.message?.includes('本地保存独立字幕')) controller.abort();
    } }), error => error.code === 'CANCELLED');
    await assert.rejects(fs.stat(path.join(root, 'pgs-cancel')), { code: 'ENOENT' });
  });
});
