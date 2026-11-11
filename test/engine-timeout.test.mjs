import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { exportCandidate } from '../src/engine.mjs';
import { createDirectStream } from '../src/direct-stream.mjs';

const exec = promisify(execFile);
const ffmpegPath = process.env.TIMEOUT_TEST_FFMPEG ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobePath = process.env.TIMEOUT_TEST_FFPROBE ?? process.env.FFPROBE_PATH ?? 'ffprobe';
const example = fileURLToPath(new URL('../examples/示例视频.mkv', import.meta.url));
const errorIs = code => error => { assert.equal(error.code, code, error.message); return true; };

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-engine-timeout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'source.mkv'), srt = path.join(root, 'source.srt');
  // The checked cue starts inside 2–10 seconds; seeking can omit a cue that began before the clip.
  await fs.writeFile(srt, '1\n00:00:04,000 --> 00:00:06,000\nIndependent timeout subtitle\n\n2\n00:00:08,000 --> 00:00:12,000\n持续读取\n');
  await exec(ffmpegPath, ['-v', 'error', '-n', '-i', example, '-i', srt,
    '-map', '0:v:0', '-map', '0:a:0?', '-map', '1:0', '-c', 'copy', '-metadata:s:s:0', 'language=zho', source], { timeout: 10000 });
  return { root, source, bytes: await fs.readFile(source) };
}

async function listen(server) {
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return `http://127.0.0.1:${server.address().port}`;
}
async function stopServer(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function gateway(t, bytes, mode) {
  const state = { mode: 'fast', requests: 0, extractionRequests: 0, slowChunks: 0, outputStageRequests: null,
    extractionStartedAt: null, extractionCompletedAt: null };
  const upstream = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) { res.writeHead(400).end(); return; }
    const start = Number(match[1]), end = Number(match[2]);
    if (start < 0 || end < start || end >= bytes.length) { res.writeHead(416).end(); return; }
    state.requests++;
    const currentMode = state.mode;
    if (currentMode !== 'fast') state.extractionRequests++;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      'Content-Length': end - start + 1, ETag: '"timeout-fixture"' });
    if (currentMode === 'fast') { res.end(bytes.subarray(start, end + 1)); return; }
    res.flushHeaders();
    if (currentMode === 'stall') return;
    let offset = start;
    const send = () => {
      if (res.destroyed) return;
      const next = Math.min(end + 1, offset + 32 * 1024);
      res.write(bytes.subarray(offset, next)); offset = next; state.slowChunks++;
      if (offset > end) { clearInterval(timer); res.end(); }
    };
    const timer = setInterval(send, 40);
    res.once('close', () => clearInterval(timer));
    send();
  });
  const upstreamUrl = await listen(upstream);
  let lease;
  try {
    lease = createDirectStream({ url: upstreamUrl + '/source.mkv', size: bytes.length,
      etag: '"timeout-fixture"', budgetBytes: bytes.length * 12, requestTimeoutMs: 10000, allowLoopbackHttp: true });
    const server = http.createServer((req, res) => { Promise.resolve(lease.serve(req, res)).catch(error => res.destroy(error)); });
    const url = await listen(server);
    t.after(async () => { await lease.settle(); await stopServer(server); await stopServer(upstream); });
    return { state, lease, url: url + '/media', onProgress(event) {
      if (event.phase === 'extract' && event.message === '定位片段并获取原码候选素材。') {
        state.mode = mode; state.extractionStartedAt = performance.now();
      }
      if (event.phase === 'validate' && state.extractionCompletedAt === null) state.extractionCompletedAt = performance.now();
      if (event.message?.includes('本地保存独立字幕')) state.outputStageRequests = state.requests;
    } };
  } catch (error) { lease?.close(); await stopServer(upstream); throw error; }
}

function options(f, sourceInput, jobId, extra = {}) {
  return { sourceInput, outputDir: f.root, jobId, start: 2, end: 10, ffmpegPath, ffprobePath,
    timeoutMs: 250, remoteDeadlineMs: 10000, remoteStallTimeoutMs: 750, ...extra };
}

async function withoutFfmpegProgress(f) {
  const wrapper = path.join(f.root, 'quiet-ffmpeg.mjs');
  await fs.writeFile(wrapper, '#!' + process.execPath + '\n' + `
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
const remote = args.some(arg => arg.startsWith('http://127.0.0.1:'));
const child = spawn(${JSON.stringify(ffmpegPath)}, args, {stdio:['ignore',remote ? 'ignore' : 'inherit','inherit']});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
child.once('error', () => process.exit(1));
child.once('exit', code => process.exit(code ?? 1));
`, { mode: 0o755 });
  return wrapper;
}

test('ongoing real gateway bytes outlive the former short media deadline, with and without independent subtitles', { timeout: 30000 }, async t => {
  const f = await fixture(t), quietFfmpeg = await withoutFfmpegProgress(f);
  for (const subtitles of [false, true]) await t.test(subtitles ? 'independent SRT enabled' : 'clean video', async t => {
    const g = await gateway(t, f.bytes, 'slow');
    const started = performance.now();
    const result = await exportCandidate(options(f, g.url, subtitles ? 'with-subtitles' : 'clean', {
      // No FFmpeg progress lines reach the engine: only real received bytes can renew activity.
      ffmpegPath: quietFfmpeg,
      ...(subtitles ? { subtitleStreamIndex: 2 } : {}),
      getRemoteActivity: () => g.lease.metrics.receivedBytes,
      onProgress: g.onProgress,
      beforeCommit() { if (g.lease.error) throw g.lease.error; },
    }));
    assert(performance.now() - started > 500, 'the real transfer must exceed twice the legacy short deadline');
    assert(g.state.extractionCompletedAt - g.state.extractionStartedAt > 750,
      'byte activity must keep a transfer with no FFmpeg progress alive beyond its stall interval');
    assert(g.state.slowChunks > 10, 'actual source bytes, rather than UI heartbeats, kept the transfer alive');
    assert((await fs.stat(result.candidatePath)).size > 0);
    assert.equal(result.manifest.validation.status, 'passed');
    assert.equal(result.subtitlePaths.length, subtitles ? 1 : 0, JSON.stringify(result.subtitleWarnings));
    if (subtitles) {
      assert((await fs.readFile(result.subtitlePaths[0], 'utf8')).includes('Independent timeout subtitle'));
      assert.equal(g.state.requests, g.state.outputStageRequests, 'independent subtitle output must remain local');
    }
  });
});

test('a genuinely silent gateway is stopped as TRANSFER_STALLED and leaves no unfinished artifact', { timeout: 15000 }, async t => {
  const f = await fixture(t), g = await gateway(t, f.bytes, 'stall');
  await assert.rejects(exportCandidate(options(f, g.url, 'stalled', {
    remoteStallTimeoutMs: 300, getRemoteActivity: () => g.lease.metrics.receivedBytes, onProgress: g.onProgress,
  })), errorIs('TRANSFER_STALLED'));
  assert(g.state.extractionRequests > 0);
  await assert.rejects(fs.stat(path.join(f.root, 'stalled')), { code: 'ENOENT' });
});

test('the independent remote safety ceiling still stops an active but excessively long transfer', { timeout: 15000 }, async t => {
  const f = await fixture(t), g = await gateway(t, f.bytes, 'slow');
  await assert.rejects(exportCandidate(options(f, g.url, 'remote-ceiling', {
    remoteDeadlineMs: 400, remoteStallTimeoutMs: 1000,
    getRemoteActivity: () => g.lease.metrics.receivedBytes, onProgress: g.onProgress,
  })), errorIs('REMOTE_DEADLINE_EXCEEDED'));
  assert(g.state.slowChunks > 2);
  await assert.rejects(fs.stat(path.join(f.root, 'remote-ceiling')), { code: 'ENOENT' });
});

test('user cancellation remains CANCELLED while a remote reader is blocked', { timeout: 15000 }, async t => {
  const f = await fixture(t), g = await gateway(t, f.bytes, 'stall');
  const controller = new AbortController(); let timer;
  t.after(() => clearTimeout(timer));
  await assert.rejects(exportCandidate(options(f, g.url, 'cancelled', {
    signal: controller.signal, getRemoteActivity: () => g.lease.metrics.receivedBytes,
    onProgress(event) { g.onProgress(event); if (event.phase === 'extract' && !timer) timer = setTimeout(() => controller.abort(), 150); },
  })), errorIs('CANCELLED'));
  await assert.rejects(fs.stat(path.join(f.root, 'cancelled')), { code: 'ENOENT' });
});

test('local media work keeps its own bounded deadline, independent of remote timeout options', { timeout: 15000 }, async t => {
  const f = await fixture(t), wrapper = path.join(f.root, 'slow-local-ffmpeg.mjs');
  await fs.writeFile(wrapper, '#!' + process.execPath + '\n' + `
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (args.includes('-ss')) await new Promise(resolve => setTimeout(resolve, 500));
const child = spawn(${JSON.stringify(ffmpegPath)}, args, {stdio:'inherit'});
child.once('exit', code => process.exit(code ?? 1));
`, { mode: 0o755 });
  await assert.rejects(exportCandidate(options(f, f.source, 'local-deadline', {
    ffmpegPath: wrapper, timeoutMs: 100, remoteDeadlineMs: 10000, remoteStallTimeoutMs: 10000,
  })), errorIs('TIMEOUT'));
  await assert.rejects(fs.stat(path.join(f.root, 'local-deadline')), { code: 'ENOENT' });
});
