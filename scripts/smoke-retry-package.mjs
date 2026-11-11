import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { ROOT } from './build-common.mjs';

const version = '0.3.25-preview.1';
const baselineVersion = '0.3.24-preview.1';
assert(process.argv[2], 'Usage: <bundled node> scripts/smoke-retry-package.mjs <built .app>');
const codeDirectory = app => path.join(app, 'Contents/Resources/app');
const code = codeDirectory(await realpath(process.argv[2]));
const baselineCode = codeDirectory(path.join(ROOT, 'dist', baselineVersion, '片段取材-队列与历史预览-mac-arm64.app'));
const bin = (directory, name) => path.join(directory, 'bin', name);
assert.equal(await realpath(process.execPath), await realpath(bin(code, 'node')), 'Run the smoke test with the new app’s bundled Node.');

const exec = promisify(execFile);
const scratch = await mkdtemp(path.join(os.tmpdir(), 'clip-retry-package-'));
const sourceName = '合成重试电影.mkv';
const source = path.join(scratch, sourceName);
const dataDir = path.join(scratch, 'state');
const outputDir = path.join(scratch, 'outputs');
const customOutputDir = path.join(scratch, 'custom-exports');
const alternateText = '另一条字幕轨';
const selectedText = '保留原选字幕';
const initialUrl = 'https://media.example.com/retry.mkv?signature=RETRY_SYNTHETIC_ONLY';
const refreshedUrl = 'https://media.example.com/refresh/stream.mkv?signature=RETRY_SYNTHETIC_REFRESHED';
const syntheticAgent = 'SyntheticRetryQA';
let fixture, fixtureUrl, media, failingReads = 0, failNextExtraction = false, app;

async function createFixture() {
  const alternate = path.join(scratch, 'alternate.srt');
  const selected = path.join(scratch, 'selected.srt');
  await writeFile(alternate, `1\n00:00:05,000 --> 00:00:06,000\n${alternateText}\n`);
  await writeFile(selected, `1\n00:00:05,000 --> 00:00:06,000\n${selectedText}\n`);
  await exec(bin(code, 'ffmpeg'), ['-v', 'error', '-n', '-i', path.join(code, 'examples/示例视频.mkv'),
    '-i', alternate, '-i', selected, '-map', '0:v:0', '-map', '0:a:0?', '-map', '1:0', '-map', '2:0',
    '-c', 'copy', '-metadata:s:s:0', 'language=eng', '-metadata:s:s:1', 'language=zho', source], { timeout: 30000 });
  media = await readFile(source);
  fixture = http.createServer((req, res) => {
    if (req.url === '/fixture.mkv?fault=503') {
      failingReads++;
      res.writeHead(503).end();
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (req.url !== '/fixture.mkv' || !range) { res.writeHead(400).end(); return; }
    const start = Number(range[1]);
    const end = Math.min(Number(range[2]), media.length - 1);
    if (start >= media.length || end < start) { res.writeHead(416).end(); return; }
    res.writeHead(206, { 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${media.length}`,
      ETag: '"retry-fixture"' });
    res.end(media.subarray(start, end + 1));
  });
  await new Promise((resolve, reject) => {
    fixture.once('error', reject);
    fixture.listen(0, '127.0.0.1', resolve);
  });
  fixtureUrl = `http://127.0.0.1:${fixture.address().port}/fixture.mkv`;
}

async function startPackagedApp(directory, expectedVersion, signedUrl = initialUrl) {
  const load = relative => import(pathToFileURL(path.join(directory, relative)));
  const [{ startServer }, { createRemoteSource }, { createDirectStream }] = await Promise.all([
    load('server.mjs'), load('src/remote.mjs'), load('src/direct-stream.mjs'),
  ]);
  app = await startServer({ outputDir, dataDir, ffmpegPath: bin(directory, 'ffmpeg'), ffprobePath: bin(directory, 'ffprobe'),
    browserSourceFactory(options) {
      assert.equal(options.url, signedUrl);
      return createRemoteSource({ ...options, url: fixtureUrl, networkPolicy: 'default' });
    },
    browserStreamFactory(options) {
      assert.equal(options.url, signedUrl);
      const url = failNextExtraction ? `${fixtureUrl}?fault=503` : fixtureUrl;
      failNextExtraction = false;
      return createDirectStream({ ...options, url, allowLoopbackHttp: true });
    },
  });
  const { url } = app;
  const request = async (route, { body, headers, token } = {}) => {
    const response = await fetch(url + route, { redirect: 'error', signal: AbortSignal.timeout(30000),
      ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body),
        headers: { Origin: url, 'Content-Type': 'application/json', 'X-Session-Token': token, ...headers } }),
    });
    return { status: response.status, data: await response.json() };
  };
  const boot = await request('/api/bootstrap');
  assert.equal(boot.status, 200);
  assert.equal(boot.data.version, expectedVersion);
  return {
    signedUrl,
    async api(route, { expected = 200, ...options } = {}) {
      const { status, data } = await request(route, { ...options, token: boot.data.sessionToken });
      assert.equal(status, expected, `${route}: ${data.error?.code || ''} ${data.error?.message || ''}`);
      return data;
    },
  };
}

async function checkSyntheticSource({ api, signedUrl }) {
  const state = await api('/api/bookmark-capture/state');
  const token = /const TOKEN = "([a-f0-9]{64})"/.exec(decodeURIComponent(state.bookmarklet.slice(11)))?.[1];
  assert(token, 'The packaged bookmark-capture entry point did not issue a token.');
  await api('/api/bookmark-capture/import', { headers: { 'X-Bookmark-Token': token }, body: {
    schemaVersion: 1, provider: 'xunlei', pageUrl: 'https://pan.xunlei.com/',
    candidates: [{ url: signedUrl, name: sourceName, size: media.length,
      headers: { 'User-Agent': syntheticAgent, Referer: 'https://pan.xunlei.com/' } }],
  } });
  const inbox = await api('/api/bookmark-capture/state');
  const probe = await api('/api/probe', { body: { source: { type: 'browser', value: inbox.candidates[0].id } } });
  assert.equal(probe.source.label, sourceName);
  assert.equal(probe.directStreamAvailable, true);
  const subtitles = probe.media.streams.filter(stream => stream.type === 'subtitle');
  assert.equal(subtitles.length, 2);
  return { id: probe.sourceId, subtitleStreamIndex: subtitles[1].index };
}

async function waitForTerminal({ api }, id) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const queue = await api('/api/jobs/queue');
    const terminal = queue.recentJobs.find(job => job.id === id);
    if (terminal) return terminal;
    await delay(50);
  }
  assert.fail('The packaged queue did not settle within one minute.');
}

const settings = { start: 4, end: 8, handles: 2, budgetMiB: 48, readMode: 'standard', downloadMethod: 'direct-stream' };
async function produceFailure(client, checked, clipName) {
  const before = failingReads;
  failNextExtraction = true;
  const batch = await client.api('/api/jobs/batch', { expected: 202, body: {
    sourceId: checked.id, clientBatchId: randomBytes(16).toString('hex'), jobs: [{ ...settings, clipName,
      outputDir: customOutputDir, audioStreamIndex: null, subtitleStreamIndex: checked.subtitleStreamIndex, makeMp4: true }],
  } });
  const failed = await waitForTerminal(client, batch.jobs[0].id);
  assert(failingReads > before, 'The upstream should have emitted an actual HTTP 503.');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error.code, 'REMOTE_HTTP');
  assert.equal(failed.result?.candidatePath, undefined);
  assert(failed.diagnostics.transfer.readTimings.requests.some(read => read.httpStatus === 503));
  return failed;
}

async function verifyRetry(client, accepted, failed, { preserveSettings }) {
  assert.notEqual(accepted.id, failed.id);
  assert.equal(accepted.retryOf, failed.id);
  const completed = await waitForTerminal(client, accepted.id);
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
  assert.equal(completed.retryOf, failed.id);
  assert.equal(completed.clipName, failed.clipName);
  assert.deepEqual(completed.requested, failed.requested);
  assert.equal(completed.downloadMethod, settings.downloadMethod);
  assert.equal(completed.metrics.budgetBytes, settings.budgetMiB * 1024 * 1024);
  assert.equal(completed.result.subtitlePaths.length, 1);
  const captions = await readFile(completed.result.subtitlePaths[0], 'utf8');
  assert(captions.includes(selectedText));
  assert(!captions.includes(alternateText));
  if (preserveSettings) {
    assert.equal(path.dirname(path.dirname(completed.result.candidatePath)), customOutputDir);
    assert(completed.result.compatiblePath, 'The original job requested an MP4 work copy.');
    for (const file of [completed.result.candidatePath, completed.result.compatiblePath]) {
      const { stdout } = await exec(bin(code, 'ffprobe'), ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'json', file], { timeout: 30000 });
      assert.deepEqual(JSON.parse(stdout).streams.map(stream => stream.codec_type), ['video'], 'The video stays clean and the original audio-off setting is retained.');
      await exec(bin(code, 'ffmpeg'), ['-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-an', '-sn', '-f', 'null', '-'], { timeout: 30000 });
    }
  }
  const original = await client.api(`/api/jobs/${failed.id}`);
  assert.equal(original.status, 'failed');
  assert.equal(original.error.code, 'REMOTE_HTTP');
  return completed;
}

async function assertRejectedRetry(client, id, body, expectedCode) {
  const data = await client.api(`/api/jobs/${id}/retry`, { body, expected: 400 });
  assert.equal(data.error?.code, expectedCode);
}

async function stopApp() {
  await app?.close();
  app = null;
}

try {
  await createFixture();

  // Generate a real record with the old application rather than synthesizing
  // the history format that the new application is meant to migrate.
  const legacyClient = await startPackagedApp(baselineCode, baselineVersion);
  const legacySource = await checkSyntheticSource(legacyClient);
  const legacy = await produceFailure(legacyClient, legacySource, '旧版历史重试');
  await stopApp();

  const client = await startPackagedApp(code, version);
  const checked = await checkSyntheticSource(client);
  const oldRecord = await client.api(`/api/jobs/${legacy.id}`);
  assert.equal(oldRecord.retry.needsSourceConfirmation, true);
  assert.equal(oldRecord.retry.needsSubtitleSelection, true);
  await assertRejectedRetry(client, legacy.id, { sourceId: checked.id, subtitleStreamIndex: checked.subtitleStreamIndex }, 'RETRY_SOURCE_CONFIRM_REQUIRED');
  await assertRejectedRetry(client, legacy.id, { sourceId: checked.id, confirmSource: true }, 'RETRY_SUBTITLE_REQUIRED');
  const legacyRetry = await client.api(`/api/jobs/${legacy.id}/retry`, { expected: 202, body: {
    sourceId: checked.id, confirmSource: true, subtitleStreamIndex: checked.subtitleStreamIndex,
  } });
  await verifyRetry(client, legacyRetry, legacy, { preserveSettings: false });

  const current = await produceFailure(client, checked, '本次失败直接重试');
  assert.equal(current.retry.sourceId, checked.id);
  assert.equal(current.retry.needsSourceConfirmation, false);
  assert.equal(current.retry.needsSubtitleSelection, false);
  const submit = () => client.api(`/api/jobs/${current.id}/retry`, { expected: 202, body: {} });
  const [first, duplicate] = await Promise.all([submit(), submit()]);
  assert.equal(duplicate.id, first.id);
  await verifyRetry(client, first, current, { preserveSettings: true });

  const beforeRestart = await produceFailure(client, checked, '重启后重试');
  await stopApp();
  // A re-capture can change both the URL path and signature for the same film.
  // The candidate name, provider, strong ETag and file bytes stay the same.
  const restarted = await startPackagedApp(code, version, refreshedUrl);
  await assertRejectedRetry(restarted, beforeRestart.id, {}, 'RETRY_SOURCE_REQUIRED');
  const fresh = await checkSyntheticSource(restarted);
  assert.notEqual(fresh.id, checked.id);
  const restoredFailure = await restarted.api(`/api/jobs/${beforeRestart.id}`);
  assert.equal(restoredFailure.retry.sourceId, fresh.id);
  const persisted = await restarted.api(`/api/jobs/${beforeRestart.id}/retry`, { expected: 202, body: {} });
  await verifyRetry(restarted, persisted, beforeRestart, { preserveSettings: true });

  const records = await restarted.api('/api/jobs/history');
  assert.deepEqual(records.jobs.filter(job => job.retryOf).map(job => job.retryOf).sort(), [legacy.id, current.id, beforeRestart.id].sort());
  assert.deepEqual((await readdir(customOutputDir)).sort(), [current.clipName, beforeRestart.clipName].sort());
  await stopApp();
  const saved = await readFile(path.join(dataDir, 'tasks.json'), 'utf8');
  assert(!saved.includes('RETRY_SYNTHETIC_') && !saved.includes(syntheticAgent));

  console.log(JSON.stringify({ status: 'passed', version, baselineVersion,
    scope: 'packaged Node/FFmpeg/ffprobe and synthetic loopback browser-source HTTP 503',
    legacyRecordRetriedAfterSourceAndSubtitleConfirmation: true,
    currentFailureRetriedWithoutReenteringSettings: true,
    duplicateRetryRequestsCreatedOneJob: true,
    persistedFailureRetriedAfterMatchingSourceCheck: true,
    changedSignedPathAndQueryMatchedSameFilm: true,
    selectedSubtitleAndOtherSettingsPreserved: true,
    cleanVideoAndMp4FullyDecoded: true,
    originalFailuresRetained: true,
    historyContainsNoSyntheticCredentials: true,
    realCloudTested: false,
  }));
} finally {
  await stopApp();
  if (fixture?.listening) {
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
  }
  await rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
