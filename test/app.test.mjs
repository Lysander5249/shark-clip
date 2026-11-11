import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, stat, readFile, rm, open } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../server.mjs';
import { exportCompatibleMp4 } from '../src/engine.mjs';
import { planMatroskaProbe, locateMatroskaCue } from '../src/matroska-index.mjs';

const run = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('end-to-end: local extraction, bounded remote extraction, offline derivative, and API isolation', { timeout: 90000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-fetcher-api-'));
  const local = path.join(root, 'source.mkv');
  const remoteFile = path.join(root, 'remote.mkv');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', local]);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-stream_loop', '7', '-i', local, '-t', '240', '-c', 'copy', remoteFile]);
  const size = (await stat(remoteFile)).size;
  const headFile = await open(remoteFile, 'r');
  let headPlan;
  try {
    headPlan = await planMatroskaProbe({ size, read: async (position, length) => {
      const data = Buffer.alloc(length);
      assert.equal((await headFile.read(data, 0, length, position)).bytesRead, length);
      return data;
    } });
  } finally { await headFile.close(); }
  assert(headPlan?.window, 'the synthetic MKV must have a bounded head window');
  let originRequested = 0;
  let midpointRequests = 0;
  let blockedAfter = null, unrelatedRequests = 0;
  let interruptedAt = null, interrupted = false, resumedAt = null;
  let davListRequests = 0;
  const davUser = 'cloud-user@example.test', davPassword = 'dav-fixture-only-secret';
  const davFolder = '/dav/%E7%B4%A0%E6%9D%90%20%26%20%E7%89%87%E6%AE%B5/';
  const davFile = `${davFolder}%E5%8E%9F%E7%89%87.mkv`;
  const fixture = http.createServer((req, res) => {
    if (req.url.startsWith('/dav/')) {
      if (req.headers.authorization !== `Basic ${Buffer.from(`${davUser}:${davPassword}`).toString('base64')}`) { res.writeHead(401); res.end(); return; }
      if (req.method === 'PROPFIND') {
        davListRequests++;
        assert.equal(req.headers.depth, '1');
        const entry = (href, directory) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${directory ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${directory ? 0 : size}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
        const xml = `<d:multistatus xmlns:d="DAV:">${entry(req.url, true)}${req.url === '/dav/' ? entry(davFolder, true) : entry(davFile, false)}</d:multistatus>`;
        res.writeHead(207, { 'Content-Type': 'application/xml' }); res.end(xml); return;
      }
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) { res.writeHead(400); res.end(); return; }
    const start = Number(match[1]), end = Math.min(Number(match[2]), size - 1);
    if (blockedAfter !== null && start >= blockedAfter) {
      unrelatedRequests++;
      res.writeHead(503).end();
      return;
    }
    // The unrelated midpoint can be unavailable while the metadata and desired
    // indexed window remain readable. It must not be a source bootstrap gate.
    if (start === Math.floor(size / 2)) {
      midpointRequests++;
      res.writeHead(503).end();
      return;
    }
    originRequested += end - start + 1;
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, ETag: '"fixture-v1"' });
    if (interrupted && resumedAt === null && start === interruptedAt + 65536) resumedAt = start;
    if (interruptedAt !== null && !interrupted && start === interruptedAt && end - start + 1 > 65536) {
      interrupted = true;
      const stream = createReadStream(remoteFile, { start, end: start + 65535 });
      res.once('close', () => stream.destroy());
      stream.pipe(res, { end: false });
      stream.once('end', () => setTimeout(() => res.destroy(), 20));
      return;
    }
    const stream = createReadStream(remoteFile, { start, end });
    res.once('close', () => stream.destroy());
    stream.pipe(res);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const app = await startServer({ outputDir: path.join(root, 'default-output'), dataDir: path.join(root, 'state') });
  t.after(async () => { await app.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  assert.equal(bootstrap.dependencies.ffmpeg.available, true);
  const api = async (route, value) => {
    const response = await fetch(app.url + route, value === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken }, body: JSON.stringify(value) });
    const data = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(data));
    return data;
  };
  const finish = async id => {
    for (let count = 0; count < 300; count++) {
      const job = await api(`/api/jobs/${id}`);
      if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
      await wait(100);
    }
    throw new Error('job timeout');
  };

  await t.test('source probe has normalized video information and valid time', async () => {
    const source = await api('/api/probe', { source: { type: 'local', value: local } });
    assert(source.media.duration >= 30);
    assert.equal(source.media.streams.find(s => s.type === 'video').codec, 'h264');
    const created = await api('/api/jobs', { sourceId: source.sourceId, start: '0:05.25', end: '0:09.5', handles: 1, makeMp4: true, outputDir: path.join(root, 'local-output') });
    const done = await finish(created.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert((await stat(done.result.candidatePath)).size > 0);
    assert((await stat(done.result.compatiblePath)).size > 0);
    assert.equal(done.metrics.receivedBytes, 0);
    assert.equal(done.result.mappingVerified, false);
    assert.equal(done.diagnostics.sourceKind, 'local');
    assert.equal(done.diagnostics.transfer, null);
    assert.equal(done.diagnostics.status, 'completed');
    assert(done.diagnostics.stages.extract > 0);
    assert(done.diagnostics.stages.validate > 0);
  });

  let remoteCandidate;
  let remoteSourceId;
  await t.test('HTTP source extracts an indexed window when an unrelated midpoint is unavailable', async () => {
    const value = `http://127.0.0.1:${fixture.address().port}/movie.mkv?signature=DO_NOT_PERSIST`;
    blockedAfter = headPlan.window.sourceEnd;
    const source = await api('/api/probe', { source: { type: 'http', value }, budgetMiB: 16 });
    blockedAfter = null;
    assert.equal(unrelatedRequests, 0, 'source metadata must not traverse unrelated footer data');
    assert.equal(source.media.duration, headPlan.durationSeconds, 'the local head must retain full original duration');
    assert.equal(source.media.sizeBytes, size, 'local staging size is not the original file size');
    remoteSourceId = source.sourceId;
    assert.equal(source.source.rangeVerified, true);
    assert.equal(source.source.upstreamVerified, false);
    const created = await api('/api/jobs', { sourceId: source.sourceId, start: 105, end: 110, handles: 1, makeMp4: false, budgetMiB: 32, outputDir: path.join(root, 'remote-output') });
    const done = await finish(created.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert(done.metrics.receivedBytes > 0);
    assert.equal(done.metrics.budgetBytes, 32 * 1024 * 1024, 'positioning and export share the selected task cap');
    assert(done.metrics.receivedBytes <= done.metrics.budgetBytes);
    assert(originRequested < size / 2, `origin requests ${originRequested}, source ${size}`);
    assert.equal(midpointRequests, 0, 'bootstrap and indexed extraction must not request an arbitrary midpoint');
    assert(!JSON.stringify(done).includes('DO_NOT_PERSIST'));
    const diagnostics = done.diagnostics;
    assert.equal(diagnostics.sourceKind, 'remote');
    assert.equal(diagnostics.status, 'completed');
    assert.equal(diagnostics.transfer.requestsStarted, done.metrics.requests);
    assert.equal(diagnostics.transfer.requestsCompleted, diagnostics.transfer.requestsStarted);
    assert.equal(diagnostics.transfer.requestsFailed, 0);
    assert.equal(diagnostics.transfer.activeRequests, 0);
    assert.equal(diagnostics.transfer.currentBytesPerSecond, null);
    assert(diagnostics.stages.fetch > 0);
    assert(diagnostics.stages.extract > 0);
    assert(Object.values(diagnostics.stages).reduce((total, duration) => total + duration, 0) <= diagnostics.elapsedMs);
    await wait(30);
    assert.deepEqual((await api(`/api/jobs/${done.id}`)).diagnostics, diagnostics, 'terminal diagnostics must remain frozen');
    assert(!(await readFile(done.result.sidecarPath, 'utf8')).includes('DO_NOT_PERSIST'));
    remoteCandidate = done.result.candidatePath;
    console.log(JSON.stringify({ verification: 'synthetic-range-origin', sourceBytes: size, allOriginRequestedBytes: originRequested, exportReceivedBytes: done.metrics.receivedBytes, originalWindow: '104–111s', note: 'not a Xunlei upstream measurement' }));
  });

  await t.test('a temporary body interruption resumes the missing bytes and completes a decodable candidate', async () => {
    const file = await open(remoteFile, 'r');
    let plan;
    try {
      plan = await locateMatroskaCue({ size, start: 104, end: 111, videoStreamIndex: 0, videoCodec: 'h264', read: async (position, length) => {
        const data = Buffer.alloc(length);
        assert.equal((await file.read(data, 0, length, position)).bytesRead, length);
        return data;
      } });
    } finally { await file.close(); }
    assert(plan?.window);
    interruptedAt = plan.window.sourceStart;
    const created = await api('/api/jobs', { sourceId: remoteSourceId, start: 105, end: 110, handles: 1, makeMp4: false, budgetMiB: 32, outputDir: path.join(root, 'recovered-output') });
    const done = await finish(created.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(interrupted, true);
    assert.equal(resumedAt, interruptedAt + 65536, 'only the missing suffix may be requested again');
    assert.equal(done.recoveryAttempts, 1);
    assert.equal(done.diagnostics.recoveryAttempts, 1);
    assert.equal(done.diagnostics.transfer.requestsFailed, 1);
    assert.equal(done.diagnostics.transfer.requestsStarted, done.diagnostics.transfer.requestsCompleted + 1);
    assert(done.metrics.receivedBytes <= done.metrics.budgetBytes);
    await run('ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-i', done.result.candidatePath, '-map', '0:v:0', '-map', '0:a:0?', '-f', 'null', '-']);
  });

  await t.test('a media job stops at its HTTP budget and does not publish an incomplete candidate', async () => {
    const created = await api('/api/jobs', { sourceId: remoteSourceId, start: 105, end: 110, handles: 1, makeMp4: false, budgetMiB: 1, outputDir: path.join(root, 'budget-output') });
    const done = await finish(created.id);
    assert.equal(done.status, 'failed');
    assert.equal(done.error.code, 'BUDGET_EXCEEDED');
    assert(['positioning', 'fetch'].includes(done.error.stage));
    assert.equal(done.diagnostics.status, 'failed');
    assert.equal(done.diagnostics.transfer.activeRequests, 0);
    assert.equal(done.diagnostics.transfer.currentBytesPerSecond, null);
    assert(done.metrics.receivedBytes <= 1024 * 1024);
    assert.equal(done.result, undefined);
  });

  await t.test('WebDAV browses authenticated directories and uses only a selected file for extraction', async () => {
    const url = `http://127.0.0.1:${fixture.address().port}/dav/`;
    const before = originRequested;
    const connection = await api('/api/dav/connect', { url, username: davUser, password: davPassword });
    assert.equal(connection.rootUrl, url);
    assert.equal(connection.entries[0].name, '素材 & 片段');
    assert.equal(connection.entries[0].isDirectory, true);
    assert.equal(originRequested, before, 'browsing must not read the video body');
    assert(!JSON.stringify(connection).includes(davUser));
    assert(!JSON.stringify(connection).includes(davPassword));
    const listing = await api('/api/dav/list', { connectionId: connection.connectionId, url: connection.entries[0].url });
    assert.equal(listing.entries[0].name, '原片.mkv');
    assert.equal(listing.parentUrl, url);
    assert.equal(davListRequests, 2);
    for (const request of [
      ['/api/dav/list', { connectionId: connection.connectionId, url: url + 'unlisted/' }],
      ['/api/probe', { source: { type: 'dav', connectionId: connection.connectionId, value: url + 'unlisted.mkv' } }],
      ['/api/dav/list', { connectionId: 'missing', url }]
    ]) {
      await assert.rejects(api(...request), /DAV_(?:PATH_INVALID|CONNECTION_MISSING)/);
    }
    assert.equal(originRequested, before);
    const source = await api('/api/probe', { source: { type: 'dav', connectionId: connection.connectionId, value: listing.entries[0].url }, budgetMiB: 16 });
    assert.equal(source.source.type, 'dav');
    assert.equal(source.source.rangeVerified, true);
    assert.equal(source.source.upstreamVerified, false);
    const created = await api('/api/jobs', { sourceId: source.sourceId, start: 105, end: 110, handles: 1, budgetMiB: 32, outputDir: path.join(root, 'dav-output') });
    const done = await finish(created.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert((await stat(done.result.candidatePath)).size > 0);
    const manifest = await readFile(done.result.sidecarPath, 'utf8');
    for (const secret of [davPassword, davUser, connection.connectionId, davFile]) {
      assert(!JSON.stringify(done).includes(secret));
      assert(!manifest.includes(secret));
    }
  });

  await t.test('a rejected WebDAV login reports independent client status without disclosing credentials', async () => {
    const before = originRequested;
    const secret = 'rejected-diagnostic-password';
    const response = await fetch(`${app.url}/api/dav/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken }, body: JSON.stringify({ url: `http://127.0.0.1:${fixture.address().port}/dav/`, username: davUser, password: secret }) });
    assert.equal(response.status, 400);
    const rejected = await response.json();
    assert.equal(rejected.error.code, 'AUTH_REQUIRED');
    assert.deepEqual(rejected.error.diagnostics.primary, { client: 'node-http', status: 401 });
    assert.deepEqual(rejected.error.diagnostics.independent, { client: 'system-curl', status: 401, code: 'HTTP_RESPONSE' });
    assert(!JSON.stringify(rejected).includes(secret));
    assert(!JSON.stringify(rejected).includes(davUser));
    assert.equal(originRequested, before, 'authentication diagnosis must not read video data');
  });

  await t.test('compatible output is produced with the upstream server unavailable', async () => {
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    const before = originRequested;
    const result = await exportCompatibleMp4({ candidatePath: remoteCandidate, outputDir: path.join(root, 'offline'), jobId: 'offline-check' });
    assert((await stat(result.outputPath)).size > 0);
    assert.equal(originRequested, before);
    assert.equal(result.manifest.processing.video, 'copy');
  });

  await t.test('mutations need a session token and foreign origins cannot read the session', async () => {
    const mutation = await fetch(`${app.url}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(mutation.status, 403);
    const foreign = await fetch(`${app.url}/api/bootstrap`, { headers: { Origin: 'https://unrelated.example' } });
    assert.equal(foreign.status, 403);
  });
});
