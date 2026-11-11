import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../server.mjs';
import { createRemoteSource } from '../src/remote.mjs';
import { createDirectStream } from '../src/direct-stream.mjs';

const run = promisify(execFile), wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
test('browser handoff uses the original app queue and exports a real synthetic clip without persisting signed links', { timeout: 45000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-browser-app-'));
  const bytes = await readFile(new URL('../examples/示例视频.mkv', import.meta.url));
  const calls = [];
  const fixture = http.createServer((req, res) => {
    calls.push({ range: req.headers.range, ua: req.headers['user-agent'], referer: req.headers.referer });
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!range) { res.writeHead(400).end(); return; }
    const start = Number(range[1]), end = Math.min(Number(range[2]), bytes.length - 1);
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end-start+1, ETag: '"browser-fixture"' });
    res.end(bytes.subarray(start, end+1));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/source.mkv`;
  const signedUrl = 'https://media.example.com/source.mkv?signature=SYNTHETIC_PRIVATE_SIGNATURE';
  let app;
  const openedBrowsers = [];
  t.after(async () => { await app?.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); await rm(root, { recursive: true, force: true }); });
  app = await startServer({ outputDir: path.join(root, 'output'), dataDir: path.join(root, 'state'),
    openBrowser: async (browser, url) => { openedBrowsers.push({ browser, url }); },
    // Explicit test dependency injection. Production never rewrites the public
    // source URL or accepts the loopback exception through any HTTP endpoint.
    browserSourceFactory: options => {
      assert.equal(options.url, signedUrl); assert.equal(options.networkPolicy, 'public-https');
      return createRemoteSource({ ...options, url: fixtureUrl, networkPolicy: 'default' });
    },
    browserStreamFactory: options => {
      assert.equal(options.url, signedUrl);
      return createDirectStream({ ...options, url: fixtureUrl, allowLoopbackHttp: true });
    },
  });
  const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
  async function api(route, value) {
    const response = await fetch(app.url + route, value === undefined ? {} : { method: 'POST', headers: {
      Origin: app.url, 'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken }, body: JSON.stringify(value) });
    const payload = await response.json(); assert.equal(response.ok, true, JSON.stringify(payload)); return payload;
  }
  const pairing = await api('/api/browser-helper/state');
  assert.deepEqual(await api('/api/browser-helper/open', { browser: 'chrome' }), { opened: true });
  assert.deepEqual(openedBrowsers, [{ browser: 'chrome', url: pairing.url }]);
  const pairingToken = new URL(pairing.url).hash.slice(1);
  const bridge = async (route, value) => {
    const response = await fetch(app.url + '/api/browser-helper/' + route, { method: 'POST', headers: {
      Origin: extensionOrigin, 'Content-Type': 'application/json', 'X-Browser-Pairing': pairingToken }, body: JSON.stringify(value) });
    const payload = await response.json(); assert.equal(response.status, 200, JSON.stringify(payload)); return payload;
  };
  assert.equal((await bridge('pair', { schemaVersion: 1 })).ok, true);
  const forbidden = await fetch(app.url + '/api/bootstrap', { headers: { Origin: extensionOrigin } });
  assert.equal(forbidden.status, 403, 'extension must not inherit the original panel API authority');
  await bridge('candidates', { schemaVersion: 1, provider: 'xunlei', pageUrl: 'https://pan.xunlei.com/', candidates: [
    { url: signedUrl, name: '浏览器合成素材.mkv', size: bytes.length, headers: { 'User-Agent': 'BrowserFixture/1.0', Referer: 'https://pan.xunlei.com/' } },
  ] });
  const inbox = await api('/api/browser-helper/state');
  assert.equal(inbox.candidates.length, 1);
  assert.doesNotMatch(JSON.stringify(inbox.candidates), /SYNTHETIC_PRIVATE|signature=/);
  const source = await api('/api/probe', { source: { type: 'browser', value: inbox.candidates[0].id } });
  assert.equal(source.source.type, 'browser'); assert.equal(source.source.label, '浏览器合成素材.mkv');
  assert.equal(source.directStreamAvailable, true);
  assert.doesNotMatch(JSON.stringify(source), /SYNTHETIC_PRIVATE|signature=/);
  const first = await api('/api/jobs', { sourceId: source.sourceId, start: '0:03', end: '0:06', handles: 1, budgetMiB: 32 });
  const second = await api('/api/jobs', { sourceId: source.sourceId, start: '0:10', end: '0:12', handles: 1, budgetMiB: 32 });
  assert.equal(first.downloadMethod, 'direct-stream'); assert.equal(second.downloadMethod, 'direct-stream');
  const finish = async id => {
    for (let i = 0; i < 350; i++) {
      const job = await api('/api/jobs/' + id);
      if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
      await wait(50);
    }
    throw new Error('synthetic browser job did not finish');
  };
  const done = await finish(first.id), done2 = await finish(second.id);
  assert.equal(done.status, 'completed', JSON.stringify(done.error));
  assert.equal(done2.status, 'completed', JSON.stringify(done2.error));
  assert.ok((await stat(done.result.candidatePath)).size > 0);
  assert.ok(done.metrics.receivedBytes > 0 && done.metrics.receivedBytes <= 32 * 1024 * 1024);
  await run('ffmpeg', ['-v', 'error', '-xerror', '-i', done.result.candidatePath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  assert.ok(calls.every(call => call.ua === 'BrowserFixture/1.0' && call.referer === 'https://pan.xunlei.com/'));
  assert.ok(calls.some(call => Number(call.range.split('-')[1]) - Number(call.range.match(/\d+/)[0]) > 1024 * 1024), 'new download path must issue continuous ranges larger than the old per-MiB path');
  const history = JSON.parse(await readFile(path.join(root, 'state/tasks.json'), 'utf8'));
  assert.doesNotMatch(JSON.stringify(history), /SYNTHETIC_PRIVATE|signature=|BrowserFixture/);
  assert.equal(history.jobs.find(job => job.id === first.id).downloadMethod, 'direct-stream');
});

test('browser-source production probe rejects a missing handoff ID before opening a source', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-browser-deny-'));
  const app = await startServer({ outputDir: root });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
  const response = await fetch(app.url + '/api/probe', { method: 'POST', headers: { Origin: app.url,
    'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken }, body: JSON.stringify({ source: { type: 'browser', value: 'missing' } }) });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'BROWSER_SOURCE_MISSING');
});
