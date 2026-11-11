import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../server.mjs';
import { createRemoteSource } from '../src/remote.mjs';

const tokenOf = state => JSON.parse(/const TOKEN = ("[a-f0-9]{64}")/.exec(decodeURIComponent(state.bookmarklet.slice(11)))[1]);

for (const [edition, providerIds] of [
  ['windows-edge-xunlei', ['xunlei']],
  ['windows-edge-cloud', ['xunlei', 'baidu']],
]) {
  test(`${edition} opens its Edge install page and accepts its configured provider handoffs`, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clip-edge-edition-'));
    const opened = [];
    let edgeInstalled = true;
    const app = await startServer({ dataDir: path.join(root, 'state'), outputDir: root, edition,
      async openBrowser(browser, url) {
        if (!edgeInstalled) throw Object.assign(new Error('missing'), { code: 'BROWSER_MISSING' });
        opened.push({ browser, url });
      },
    });
    t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
    const get = route => fetch(app.url + route).then(response => response.json());
    const boot = await get('/api/bootstrap');
    assert.equal(boot.edition, edition);
    assert.deepEqual(boot.providers.map(provider => provider.id), providerIds);
    const state = await get('/api/bookmark-capture/state');
    assert.equal(state.edition, edition);
    const post = (route, body, headers) => fetch(app.url + route, { method: 'POST', body: JSON.stringify(body),
      headers: { Origin: app.url, 'Content-Type': 'application/json', 'X-Session-Token': boot.sessionToken, ...headers } });
    const open = browser => post('/api/bookmark-capture/open', { browser });
    assert.equal((await open('edge')).status, 200);
    assert.deepEqual(opened, [{ browser: 'edge', url: app.url + '/bookmark/install' }]);
    assert.equal((await open('chrome')).status, 400);
    edgeInstalled = false;
    const missing = await open('edge');
    assert.equal(missing.status, 400);
    assert.equal((await missing.json()).error.code, 'BROWSER_MISSING');
    const handoff = (provider, pageUrl) => post('/api/bookmark-capture/import', {
      schemaVersion: 1, provider, pageUrl,
      candidates: [{ url: `https://cdn.example.com/${provider}.mkv`, name: '示例.mkv' }],
    }, { 'X-Bookmark-Token': tokenOf(state) });
    assert.equal((await handoff('baidu', 'https://pan.xunlei.com/')).status, 400);
    assert.equal((await handoff('baidu', 'https://pan.baidu.com/')).status, providerIds.includes('baidu') ? 200 : 400);
    assert.equal((await handoff('xunlei', 'https://pan.xunlei.com/')).status, 200);
    assert.deepEqual((await get('/api/bookmark-capture/state')).candidates.map(item => item.provider).sort(),
      [...providerIds].sort());
  });
}

test('the original app preserves its bookmark across restart and safely survives an occupied bookmark port', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-bookmark-restart-'));
  let app, blocker;
  t.after(async () => { await app?.close(); if (blocker) { blocker.closeAllConnections(); await new Promise(resolve => blocker.close(resolve)); } await rm(root, { recursive: true, force: true }); });
  const options = { dataDir: path.join(root, 'state'), outputDir: path.join(root, 'output') };
  app = await startServer(options);
  const state = await fetch(app.url + '/api/bookmark-capture/state').then(response => response.json());
  assert.equal(state.available, true); assert.ok(state.bookmarklet.startsWith('javascript:'));
  assert.ok(state.bookmarklet.length < 40000);
  const oldUrl = app.url, port = Number(new URL(oldUrl).port);
  await app.close(); app = await startServer(options);
  assert.equal(app.url, oldUrl);
  const next = await fetch(app.url + '/api/bookmark-capture/state').then(response => response.json());
  assert.equal(next.bookmarklet, state.bookmarklet, 'restarting must not ask the user to drag or pair again');
  const configPath = path.join(root, 'state/bookmark-capture.json'), before = await readFile(configPath, 'utf8');
  await app.close(); app = null;
  blocker = http.createServer((req,res) => res.end('occupied'));
  await new Promise(resolve => blocker.listen(port, '127.0.0.1', resolve));
  app = await startServer(options); assert.notEqual(app.url, oldUrl);
  const blocked = await fetch(app.url + '/api/bookmark-capture/state').then(response => response.json());
  assert.equal(blocked.available, false); assert.equal(blocked.bookmarklet, '');
  assert.equal(await readFile(configPath, 'utf8'), before, 'a port collision must not silently invalidate the installed bookmark');
  assert.equal((await fetch(app.url + '/api/bootstrap')).status, 200, 'existing routes stay usable');
  await app.close(); app = null;
  await new Promise(resolve => blocker.close(resolve)); blocker = null;
  app = await startServer(options);
  assert.equal(app.url, oldUrl);
  assert.equal((await fetch(app.url + '/api/bookmark-capture/state').then(response => response.json())).bookmarklet, state.bookmarklet);
});

test('a cloud popup can reach only the static receiver; its same-origin handoff enters the original source workflow', { timeout: 20000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-bookmark-app-'));
  const bytes = await readFile(new URL('../examples/示例视频.mkv', import.meta.url));
  const signed = 'https://cdn.example.com/source.mkv?signature=SYNTHETIC_PRIVATE';
  const fixture = http.createServer((req, res) => {
    const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    assert.ok(range); assert.equal(req.headers['user-agent'], 'BookmarkFixture/1');
    const start = Number(range[1]), end = Math.min(Number(range[2]), bytes.length-1);
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end-start+1, ETag: '"fixture"' });
    res.end(bytes.subarray(start,end+1));
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  let focused = 0;
  const app = await startServer({ dataDir: path.join(root, 'state'), outputDir: root,
    onBookmarkReady: () => focused++, browserSourceFactory: options => {
      assert.equal(options.url, signed); assert.equal(options.networkPolicy, 'public-https');
      return createRemoteSource({ ...options, url: `http://127.0.0.1:${fixture.address().port}/fixture.mkv`, networkPolicy: 'default' });
    },
  });
  t.after(async () => { await app.close(); fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const state = await fetch(app.url + '/api/bookmark-capture/state').then(response => response.json());
  const receiver = await fetch(app.url + '/bookmark/receive', { headers: { Origin: 'https://pan.xunlei.com', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(receiver.status, 200); assert.doesNotMatch(await receiver.text(), /SYNTHETIC_PRIVATE|#[a-f0-9]{64}/);
  for (const query of ['?__trace_id__=' + 'a'.repeat(32), '?token=PRIVATE', '?__trace_id__=' + 'a'.repeat(32) + '&token=PRIVATE', '?__trace_id__=bad']) {
    const response = await fetch(app.url + '/bookmark/receive' + query, { headers: { Origin: 'https://pan.xunlei.com', 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(response.status, query === '?__trace_id__=' + 'a'.repeat(32) ? 200 : 403);
  }
  const forbidden = await fetch(app.url + '/api/bookmark-capture/state', { headers: { Origin: 'https://pan.xunlei.com', 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(forbidden.status, 403);
  const payload = { schemaVersion: 1, provider: 'xunlei', pageUrl: 'https://pan.xunlei.com/', candidates: [{ url: signed,
    name: '原片.mkv', size: bytes.length, headers: { 'User-Agent': 'BookmarkFixture/1', Referer: 'https://pan.xunlei.com/' } }] };
  const request = async origin => fetch(app.url + '/api/bookmark-capture/import', { method: 'POST', headers: {
    Origin: origin, 'Content-Type': 'application/json', 'X-Bookmark-Token': tokenOf(state) }, body: JSON.stringify(payload) });
  assert.equal((await request('https://pan.xunlei.com')).status, 403);
  assert.equal((await request(app.url)).status, 200);
  const inbox = await fetch(app.url + '/api/bookmark-capture/state').then(response => response.json());
  assert.equal(inbox.receiptSequence, 1); assert.equal(inbox.candidates.length, 1); assert.equal(focused, 1);
  assert.doesNotMatch(JSON.stringify(inbox.candidates), /signature=|SYNTHETIC_PRIVATE/);
  const bootstrap = await fetch(app.url + '/api/bootstrap').then(response => response.json());
  const probe = await fetch(app.url + '/api/probe', { method: 'POST', headers: { Origin: app.url,
    'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken },
    body: JSON.stringify({ source: { type: 'browser', value: inbox.candidates[0].id } }) });
  const result = await probe.json(); assert.equal(probe.status, 200, JSON.stringify(result));
  assert.equal(result.source.label, '原片.mkv'); assert.equal(result.directStreamAvailable, true);
  assert.equal(focused, 1, 'later probing must not steal focus a second time');
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE|signature=/);
  const saved = await readFile(path.join(root, 'state/bookmark-capture.json'), 'utf8');
  assert.doesNotMatch(saved, /SYNTHETIC_PRIVATE|cdn.example|BookmarkFixture|原片/);
});
