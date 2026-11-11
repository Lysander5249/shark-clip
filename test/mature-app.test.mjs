import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, readFile, stat, copyFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

const run = promisify(execFile);
const sample = fileURLToPath(new URL('../examples/示例视频.mkv', import.meta.url));
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function assertFinishedDiagnostics(job, sourceKind) {
  const diagnostics = job.diagnostics;
  assert(diagnostics, 'finished jobs must expose their bounded diagnostics');
  assert.equal(diagnostics.schemaVersion, 1);
  assert.equal(diagnostics.status, job.status);
  assert.equal(diagnostics.sourceKind, sourceKind);
  assert(Number.isSafeInteger(diagnostics.elapsedMs) && diagnostics.elapsedMs >= 0);
  assert.deepEqual(Object.keys(diagnostics.stages).sort(), ['checking', 'positioning', 'fetch', 'probe', 'extract', 'validate', 'compatible', 'other'].sort());
  for (const duration of Object.values(diagnostics.stages)) assert(Number.isSafeInteger(duration) && duration >= 0);
  assert(Object.values(diagnostics.stages).reduce((sum, duration) => sum + duration, 0) <= diagnostics.elapsedMs,
    'execution stages must not double-count elapsed time');
  if (sourceKind === 'local') assert.equal(diagnostics.transfer, null, 'local work must not imply a cloud transfer rate');
  if (diagnostics.transfer) {
    assert.equal(diagnostics.transfer.currentBytesPerSecond, null);
    assert.equal(diagnostics.transfer.activeRequests, 0);
  }
  return diagnostics;
}

async function client(app) {
  const boot = await (await fetch(`${app.url}/api/bootstrap`)).json();
  return { boot, async request(route, value) {
    const response = await fetch(app.url + route, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': boot.sessionToken }, body: JSON.stringify(value) });
    const data = await response.json();
    assert(response.ok, JSON.stringify(data));
    return data;
  }, async finish(id) {
    for (let count = 0; count < 200; count++) {
      const response = await fetch(`${app.url}/api/jobs/${id}`);
      const job = await response.json();
      if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
      await wait(50);
    }
    throw new Error('job timeout');
  } };
}

test('desktop workflow: isolated instances, directory hooks, selected audio, local preview and durable history', { timeout: 45000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-mature-'));
  const outputDir = path.join(root, 'output'), dataDir = path.join(root, 'state');
  let app = await startServer({ outputDir, dataDir, pickDirectory: async () => outputDir });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const c = await client(app);
  assert.deepEqual(c.boot.providers.map(p => p.id), ['xunlei', 'baidu']);
  assert.equal(c.boot.defaults.budgetMiB, 256);
  const budgetModule = await fetch(app.url + '/budget.mjs');
  assert.equal(budgetModule.status, 200);
  assert.match(budgetModule.headers.get('content-type'), /^text\/javascript/);
  assert.match(await budgetModule.text(), /export function estimateReadBudget/);
  assert.equal((await fetch(app.url + '/src/history.mjs')).status, 404, 'source internals stay outside the static allowlist');
  assert.deepEqual(await c.request('/api/pick-directory', {}), { path: outputDir });

  const isolated = await startServer({ outputDir: path.join(root, 'other') });
  const other = await client(isolated);
  assert.notEqual(other.boot.sessionToken, c.boot.sessionToken);
  assert.equal((await fetch(`${app.url}/api/bootstrap`)).status, 200, 'second server must not replace first origin');
  const forbidden = await fetch(`${isolated.url}/api/pick-directory`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': c.boot.sessionToken }, body: '{}' });
  assert.equal(forbidden.status, 403);
  await isolated.close();

  const multiAudio = path.join(root, 'multi.mkv');
  await run('ffmpeg', ['-v', 'error', '-i', sample, '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-map', '0:v:0', '-map', '0:a:0', '-map', '1:a:0', '-t', '8', '-c:v', 'copy', '-c:a', 'aac', '-disposition:a:0', '0', '-disposition:a:1', 'default', multiAudio]);
  const source = await c.request('/api/probe', { source: { type: 'local', value: multiAudio } });
  const selectedIndex = source.media.streams.find(s => s.type === 'audio' && s.default).index;
  const created = await c.request('/api/jobs', { sourceId: source.sourceId, start: 2, end: 4, handles: 0 });
  const extracted = await c.finish(created.id);
  assert.equal(extracted.status, 'completed', JSON.stringify(extracted.error));
  const extractedDiagnostics = assertFinishedDiagnostics(extracted, 'local');
  const manifest = JSON.parse(await readFile(extracted.result.sidecarPath, 'utf8'));
  assert.equal(manifest.selectedTracks.audio.index, selectedIndex, 'default source audio is selected');
  const before = await readFile(extracted.result.candidatePath);

  const requests = await Promise.all([0, 1].map(async () => {
    const response = await fetch(`${app.url}/api/jobs/${created.id}/compatible`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': c.boot.sessionToken }, body: '{}',
    });
    return { status: response.status, data: await response.json() };
  }));
  assert.deepEqual(requests.map(r => r.status).sort(), [202, 400], 'simultaneous MP4 requests must reserve the candidate exactly once');
  assert.equal(requests.find(r => r.status === 400).data.error.code, 'OUTPUT_BUSY');
  const derived = requests.find(r => r.status === 202).data;
  assert.equal(derived.type, 'compatible');
  const done = await c.finish(derived.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  const derivedDiagnostics = assertFinishedDiagnostics(done, 'local');
  assert.deepEqual((await c.request(`/api/jobs/${created.id}`)).diagnostics, extractedDiagnostics,
    'a completed extraction timer must not grow while a separate derivative runs');
  assert.equal(done.metrics.receivedBytes, 0);
  assert.deepEqual(await readFile(extracted.result.candidatePath), before);
  const size = (await stat(done.result.compatiblePath)).size;
  const partial = await fetch(app.url + done.result.previewUrl, { headers: { Range: 'bytes=0-31' } });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), `bytes 0-31/${size}`);
  assert.equal((await partial.arrayBuffer()).byteLength, 32);
  const invalid = await fetch(app.url + done.result.previewUrl, { headers: { Range: 'bytes=999999999-' } });
  assert.equal(invalid.status, 416);
  assert.equal((await fetch(`${app.url}/api/local-media/not-known`)).status, 404);
  const head = await fetch(app.url + done.result.previewUrl, { method: 'HEAD' });
  assert.equal(head.headers.get('content-length'), String(size));

  await app.close();
  await app.close(); // Repeated teardown must not erase saved history.
  const saved = await readFile(path.join(dataDir, 'tasks.json'), 'utf8');
  assert(!saved.includes('sourceInput'));
  assert(!saved.includes('previewUrl'));
  assert(!saved.includes(source.sourceId));
  assert(!saved.includes('taskDiagnostics'), 'private timer objects must not be serialized');
  const persisted = JSON.parse(saved).jobs;
  assert.deepEqual(persisted.find(job => job.id === created.id).diagnostics, extractedDiagnostics);
  assert.deepEqual(persisted.find(job => job.id === done.id).diagnostics, derivedDiagnostics);
  app = await startServer({ outputDir, dataDir });
  const reopened = await client(app);
  const history = await reopened.request('/api/jobs/history');
  assert.equal(history.jobs.length, 2);
  const restored = history.jobs.find(j => j.id === done.id);
  assert.equal(restored.result.candidatePath, extracted.result.candidatePath);
  assert.deepEqual(restored.diagnostics, derivedDiagnostics, 'reopening the app must preserve frozen terminal diagnostics');
  assert.deepEqual(history.jobs.find(job => job.id === created.id).diagnostics, extractedDiagnostics);
  assertFinishedDiagnostics(restored, 'local');
  await wait(30);
  assert.deepEqual((await reopened.request(`/api/jobs/${done.id}`)).diagnostics, derivedDiagnostics,
    'polling restored history must not restart its task timer or current speed');
  assert.equal((await fetch(app.url + restored.result.previewUrl, { headers: { Range: 'bytes=-16' } })).status, 206);
  const offline = await reopened.request(`/api/jobs/${created.id}/compatible`, {});
  assert.equal((await reopened.finish(offline.id)).status, 'completed', 'history derivative needs no source reconnection');
});

test('selected local source and output paths preserve trailing spaces through a real export', { timeout: 20000, skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-exact-path-'));
  const sourcePath = path.join(root, '本地 视频.mkv ');
  const outputDir = path.join(root, '保存 位置 ');
  let app;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  await copyFile(sample, sourcePath);
  await mkdir(outputDir);
  app = await startServer({
    outputDir: path.join(root, 'default-output'), dataDir: path.join(root, 'state'),
    pickFile: async () => sourcePath, pickDirectory: async () => outputDir,
  });
  const c = await client(app);
  const selectedFile = await c.request('/api/pick-file', {});
  const selectedFolder = await c.request('/api/pick-directory', {});
  assert.equal(selectedFile.path, sourcePath);
  assert.equal(selectedFolder.path, outputDir);
  const source = await c.request('/api/probe', { source: { type: 'local', value: selectedFile.path } });
  assert.equal(source.source.label, path.basename(sourcePath));
  const created = await c.request('/api/jobs', { sourceId: source.sourceId, start: 2, end: 4, handles: 0, outputDir: selectedFolder.path });
  const done = await c.finish(created.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.equal(path.dirname(path.dirname(done.result.candidatePath)), outputDir);
  assert((await stat(done.result.candidatePath)).size > 0);
  assert.equal((await stat(done.result.sidecarPath)).isFile(), true);
  await assert.rejects(stat(outputDir.trim()), { code: 'ENOENT' }, 'export must not create a trimmed sibling directory');
});

test('disconnecting WebDAV invalidates a previously probed source without reading more cloud bytes', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-disconnect-'));
  const bytes = (await stat(sample)).size;
  const username = 'fixture-user', password = 'fixture-password';
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  let upstreamRequests = 0;
  const fixture = http.createServer((req, res) => {
    upstreamRequests++;
    if (req.headers.authorization !== authorization) { res.writeHead(401).end(); return; }
    if (req.method === 'PROPFIND') {
      const self = '<d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
      const file = `<d:response><d:href>/dav/video.mkv</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${bytes}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      res.writeHead(207, { 'Content-Type': 'application/xml' }).end(`<d:multistatus xmlns:d="DAV:">${self}${file}</d:multistatus>`);
      return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!range) { res.writeHead(400).end(); return; }
    const start = Number(range[1]), end = Math.min(Number(range[2]), bytes - 1);
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes}`, 'Content-Length': end - start + 1, ETag: '"fixture-v1"' });
    const stream = createReadStream(sample, { start, end });
    res.once('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
  let app;
  t.after(async () => {
    await app?.close();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { fixture.once('error', reject); fixture.listen(0, '127.0.0.1', resolve); });
  app = await startServer({ outputDir: path.join(root, 'output') });
  const c = await client(app);
  const url = `http://127.0.0.1:${fixture.address().port}/dav/`;
  const connection = await c.request('/api/dav/connect', { url, username, password });
  const source = await c.request('/api/probe', { source: { type: 'dav', connectionId: connection.connectionId, value: connection.entries[0].url }, budgetMiB: 16 });
  assert.equal(source.source.rangeVerified, true);
  await c.request('/api/dav/disconnect', { connectionId: connection.connectionId });
  const before = upstreamRequests;
  for (const [route, value, code] of [
    ['/api/jobs', { sourceId: source.sourceId, start: 2, end: 4, handles: 0 }, 'SOURCE_MISSING'],
    ['/api/dav/list', { connectionId: connection.connectionId, url }, 'DAV_CONNECTION_MISSING'],
    ['/api/probe', { source: { type: 'dav', connectionId: connection.connectionId, value: connection.entries[0].url } }, 'DAV_CONNECTION_MISSING'],
  ]) {
    const response = await fetch(app.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': c.boot.sessionToken }, body: JSON.stringify(value) });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, code);
  }
  assert.equal(upstreamRequests, before, 'revoked connection and source IDs must not make any upstream request');
});
