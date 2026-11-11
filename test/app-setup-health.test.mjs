import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fsSync from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, stat, copyFile, chmod } from 'node:fs/promises';
import { startServer } from '../server.mjs';

const options = { timeout: 20000 };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const terminal = new Set(['completed', 'failed', 'cancelled']);
const sample = fileURLToPath(new URL('../examples/示例视频.mkv', import.meta.url));
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
async function until(check) {
  for (let i = 0; i < 400; i++) { const value = await check(); if (value) return value; await wait(5); }
  assert.fail('local setup fixture did not reach expected state');
}
async function fixture(t, { badDefault = false, missingFfmpeg = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-setup-api-'));
  const local = path.join(root, '本地 素材.mkv'), outputDir = path.join(root, 'output'), dataDir = path.join(root, 'state');
  const missingFfmpegPath = path.join(root, '恢复的 媒体组件', `ffmpeg${process.platform === 'win32' ? '.exe' : ''}`);
  const sampleBytes = await readFile(sample); await writeFile(local, sampleBytes);
  const bytes = Buffer.alloc(64 * 1024 * 1024); sampleBytes.copy(bytes);
  if (badDefault) await writeFile(outputDir, 'EXISTING_DEFAULT_FILE');
  const calls = [], active = new Set(), held = new Set(), state = { holdDav: false, holdGet: false };
  let app, origin;
  t.after(async () => {
    for (const res of held) res.destroy();
    await app?.close();
    origin?.closeAllConnections();
    if (origin?.listening) await new Promise(resolve => origin.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  origin = http.createServer((req, res) => {
    calls.push({ method: req.method, depth: req.headers.depth, authorization: req.headers.authorization, url: req.url });
    active.add(res); res.once('close', () => { active.delete(res); held.delete(res); });
    if (req.method === 'PROPFIND') {
      if (state.holdDav) { held.add(res); return; }
      res.writeHead(401).end('PRIVATE_DAV_AUTH_PAGE'); return;
    }
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (req.method !== 'GET' || !range) { res.writeHead(400).end(); return; }
    const start = Number(range[1]), end = Math.min(Number(range[2]), bytes.length - 1);
    if (state.holdGet) { held.add(res); res.fixtureComplete = () => respond(); return; }
    respond();
    function respond() { res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      'Content-Length': end - start + 1, ETag: '"setup-api-fixture"' }).end(bytes.subarray(start, end + 1)); }
  });
  await new Promise((resolve, reject) => { origin.once('error', reject); origin.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${origin.address().port}`;
  app = await startServer({ outputDir, dataDir, ...(missingFfmpeg ? { ffmpegPath: missingFfmpegPath } : {}) });
  const bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  async function api(route, body, extra = {}) {
    const method = body === undefined ? 'GET' : 'POST';
    const headers = { ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken }), ...extra.headers };
    if (Object.hasOwn(headers, 'Host')) return new Promise((resolve, reject) => {
      const req = http.request(app.url + route, { method, headers }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.once('error', reject); res.once('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); }
        });
      });
      req.once('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const response = await fetch(app.url + route, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json() };
  }
  async function success(route, body) { const result = await api(route, body); assert(result.status < 300, JSON.stringify(result)); return result.data; }
  async function probe(remote = false) { return success('/api/probe', { source: { type: remote ? 'http' : 'local', value: remote ? `${base}/movie.mkv` : local }, budgetMiB: 32 }); }
  function release() {
    state.holdDav = false; state.holdGet = false;
    for (const res of held) if (!res.destroyed) { if (res.fixtureComplete) res.fixtureComplete(); else res.writeHead(401).end(); }
  }
  return { app, root, outputDir, dataDir, local, base, calls, state, active, held, bootstrap, api, success, probe, release, missingFfmpegPath };
}

async function actualFfmpegPath() {
  const configured = process.env.FFMPEG_PATH || 'ffmpeg';
  const names = process.platform === 'win32' && !configured.toLowerCase().endsWith('.exe') ? [configured + '.exe', configured] : [configured];
  if (path.isAbsolute(configured) || configured.includes('/') || configured.includes('\\')) {
    for (const name of names) { try { if ((await stat(name)).isFile()) return path.resolve(name); } catch {} }
  } else for (const directory of (process.env.PATH || '').split(path.delimiter)) {
    for (const name of names) { const candidate = path.join(directory, name); try { if ((await stat(candidate)).isFile()) return candidate; } catch {} }
  }
  assert.fail('a real FFmpeg executable is required for setup component recovery integration');
}

test('setup API reports platform and bundled tool availability while a bad default output still permits the panel', options, async t => {
  const f = await fixture(t, { badDefault: true });
  assert.deepEqual(Object.keys(f.bootstrap.platform).sort(), ['os', 'arch', 'supportedTarget'].sort());
  assert.equal(f.bootstrap.platform.os, process.platform); assert.equal(f.bootstrap.platform.arch, process.arch);
  const bad = await f.success('/api/setup/check', { davUrl: `${f.base}/dav/` });
  assert.equal(bad.schemaVersion, 1); assert.deepEqual(bad.platform, f.bootstrap.platform);
  assert.equal(typeof bad.tools.ffmpeg, 'boolean'); assert.equal(typeof bad.tools.ffprobe, 'boolean');
  assert.equal(bad.storage.status, 'error'); assert.equal(bad.storage.code, 'OUTPUT_NOT_WRITABLE');
  assert.equal(await readFile(f.outputDir, 'utf8'), 'EXISTING_DEFAULT_FILE');
  const destination = path.join(f.root, '其他 保存位置');
  const healthy = await f.success('/api/setup/check', { outputDir: destination, davUrl: `${f.base}/dav/` });
  assert.equal(healthy.storage.status, 'ready'); assert.equal(healthy.cloudDrive.status, 'responding');
  assert.deepEqual(await readdir(destination), []);
  assert.deepEqual((await f.success('/api/jobs/history')).jobs, []);
  assert(f.calls.every(call => call.method === 'PROPFIND' && call.depth === '0' && call.authorization === undefined));
  const serialized = JSON.stringify(healthy);
  for (const sensitive of [f.root, f.base, 'PRIVATE_DAV_AUTH_PAGE', f.bootstrap.sessionToken, 'username', 'password']) assert(!serialized.includes(sensitive));
  const view = await fetch(`${f.app.url}/setup-view.mjs`);
  assert.equal(view.status, 200); assert.match(view.headers.get('content-type'), /^text\/javascript(?:;|$)/);
});

test('setup API requires POST session/origin/host checks and rejects extra credentials before any work', options, async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/setup/check')).status, 404);
  for (const headers of [{ 'X-Session-Token': 'wrong' }, { Origin: 'https://outside.invalid' }, { Host: 'outside.invalid' }])
    assert.equal((await f.api('/api/setup/check', { outputDir: f.outputDir, davUrl: `${f.base}/dav/` }, { headers })).status, 403);
  for (const value of [[], null, { username: 'PRIVATE_USER' }, { password: 'PRIVATE_PASSWORD' }, { refresh: true }, { outputDir: 7 }, { davUrl: null }]) {
    const result = await f.api('/api/setup/check', value);
    assert.equal(result.status, 400); assert.equal(result.data.error.code, 'SETUP_OPTIONS_INVALID');
  }
  assert.equal(f.calls.length, 0); await assert.rejects(stat(f.outputDir), { code: 'ENOENT' });
});

test('a fresh setup check detects a restored real media component and updates bootstrap availability', options, async t => {
  const f = await fixture(t, { missingFfmpeg: true });
  assert.equal(f.bootstrap.dependencies.ffmpeg.available, false);
  const missing = await f.success('/api/setup/check', { outputDir: f.outputDir, davUrl: `${f.base}/dav/` });
  assert.equal(missing.tools.ffmpeg, false);
  await mkdir(path.dirname(f.missingFfmpegPath), { recursive: true });
  await copyFile(await actualFfmpegPath(), f.missingFfmpegPath);
  if (process.platform !== 'win32') await chmod(f.missingFfmpegPath, 0o755);
  const restored = await f.success('/api/setup/check', { outputDir: f.outputDir, davUrl: `${f.base}/dav/` });
  assert.equal(restored.tools.ffmpeg, true);
  assert.equal((await f.success('/api/bootstrap')).dependencies.ffmpeg.available, true);
  assert.deepEqual(await readdir(f.outputDir), []);
});

test('setup checks are single-flight and exclude new media commands until their bounded local check settles', options, async t => {
  const f = await fixture(t); f.state.holdDav = true;
  const first = f.api('/api/setup/check', { outputDir: f.outputDir, davUrl: `${f.base}/dav/` });
  await until(() => f.held.size);
  for (const [route, value] of [
    ['/api/setup/check', {}], ['/api/probe', { source: { type: 'local', value: f.local } }],
    ['/api/jobs', { sourceId: 'none', start: 0, end: 1 }], ['/api/transfer-checks', { sourceId: 'none' }],
    ['/api/jobs/none/resume', {}], ['/api/jobs/none/compatible', {}],
  ]) {
    const result = await f.api(route, value);
    assert.equal(result.status, 400); assert.equal(result.data.error.code, 'SETUP_CHECK_BUSY');
  }
  assert.equal(f.calls.length, 1); f.release(); assert.equal((await first).status, 200);
  await f.probe();
});

test('active source checking excludes a setup check before local writes or another DAV request', options, async t => {
  const f = await fixture(t); f.state.holdGet = true;
  const probe = f.probe(true); await until(() => f.held.size);
  const target = path.join(f.root, 'should-not-be-created');
  const result = await f.api('/api/setup/check', { outputDir: target, davUrl: `${f.base}/dav/` });
  assert.equal(result.data.error.code, 'SETUP_CHECK_BUSY');
  await assert.rejects(stat(target), { code: 'ENOENT' });
  assert(f.calls.every(call => call.method === 'GET'));
  f.release(); await probe;
});

test('unwritable job output is rejected before any target media reads or queued history', options, async t => {
  const f = await fixture(t), source = await f.probe(true), before = f.calls.length;
  const invalid = path.join(f.root, 'save-is-a-file'); await writeFile(invalid, 'KEEP_ME');
  const result = await f.api('/api/jobs', { sourceId: source.sourceId, start: 0, end: 1, handles: 0, outputDir: invalid });
  assert.equal(result.status, 400); assert.equal(result.data.error.code, 'OUTPUT_NOT_WRITABLE');
  assert.equal(f.calls.length, before, 'invalid save path must stop before a new media request');
  assert.deepEqual((await f.success('/api/jobs/history')).jobs, []);
  assert.equal(await readFile(invalid, 'utf8'), 'KEEP_ME');
});

test('pending save validation reserves media preparation so setup and transfer diagnostics cannot overtake it', options, async t => {
  const f = await fixture(t), source = await f.probe(true), target = path.join(f.root, 'gated-save');
  const entered = deferred(), release = deferred(), original = fsSync.promises.mkdir;
  t.mock.method(fsSync.promises, 'mkdir', async function (filename, ...rest) {
    if (filename === target) { entered.resolve(); await release.promise; }
    return original.call(this, filename, ...rest);
  });
  syncBuiltinESMExports();
  t.after(() => { release.resolve(); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const creating = f.api('/api/jobs', { sourceId: source.sourceId, start: 0, end: 1, handles: 0, outputDir: target });
  await entered.promise;
  try {
    const before = f.calls.length;
    assert.equal((await f.api('/api/setup/check', { davUrl: `${f.base}/dav/` })).data.error.code, 'SETUP_CHECK_BUSY');
    assert.equal((await f.api('/api/transfer-checks', { sourceId: source.sourceId })).data.error.code, 'TRANSFER_CHECK_BUSY');
    assert.equal(f.calls.length, before);
  } finally { release.resolve(); }
  const result = await creating; assert.equal(result.status, 202);
  await f.success(`/api/jobs/${result.data.id}/cancel`, {});
  await until(async () => terminal.has((await f.success(`/api/jobs/${result.data.id}`)).status));
});

test('backend shutdown aborts and awaits a pending unauthenticated setup request', options, async t => {
  const f = await fixture(t); f.state.holdDav = true;
  const pending = f.api('/api/setup/check', { outputDir: f.outputDir, davUrl: `${f.base}/dav/` }).catch(() => null);
  await until(() => f.held.size);
  await f.app.close(); await pending;
  assert.equal(f.app.server.listening, false); await until(() => f.active.size === 0);
  assert.deepEqual(await readdir(f.outputDir), []);
});
