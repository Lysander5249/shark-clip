import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import vm from 'node:vm';
import { randomBytes, webcrypto } from 'node:crypto';
import { startBookmarkReceiver } from '../public/bookmark-capture-view.mjs';
import { startServer } from '../server.mjs';
import { createDirectStream } from '../src/direct-stream.mjs';
import { createRemoteSource } from '../src/remote.mjs';

const template = await readFile(new URL('../bookmark-capture/capture.js', import.meta.url), 'utf8');
const ORIGIN = 'http://127.0.0.1:49123', TOKEN = 'a'.repeat(64), NONCE = 'b'.repeat(32);
const source = template.replace('__CAPTURE_ORIGIN__', JSON.stringify(ORIGIN)).replace('__CAPTURE_TOKEN__', JSON.stringify(TOKEN));
const metadata = { id: 'file_A', name: '原片.mkv', size: 1000000, web_content_link: 'https://cdn.example.com/original.mkv?signature=SYNTHETIC_PRIVATE' };
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const settle = async () => { for (let i = 0; i < 18; i++) await Promise.resolve(); };
class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.events = new Map(); this.isConnected = true; }
  append(...items) { for (const item of items) this.appendChild(typeof item === 'string' ? { textContent: item } : item); }
  appendChild(item) { item.parent = this; item.isConnected = true; this.children.push(item); return item; }
  remove() { this.isConnected = false; if (this.parent) this.parent.children = this.parent.children.filter(item => item !== this); }
  setAttribute() {}
  addEventListener(type, action) { this.events.set(type, action); }
}
function fixture({ page = 'https://pan.xunlei.com/?private=1#folder', popup = true, resources = [], fetch: suppliedFetch,
  script = source } = {}) {
  const timers = new Map(), listeners = new Map(), calls = [], messages = [], alerts = []; let nextTimer = 0;
  const body = new Element('body'), document = { body, documentElement: body, createElement: tag => new Element(tag),
    createElementNS: (namespaceURI, tag) => Object.assign(new Element(tag), { namespaceURI }),
    addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [],
    getElementById: id => body.children.find(item => item.id === id) };
  class Xhr { open() {} send() {} }
  const originalXhrOpen = Xhr.prototype.open, originalXhrSend = Xhr.prototype.send;
  const receiver = { closed: false, close() { this.closed = true; }, postMessage(message, origin) { messages.push({ message, origin }); } };
  const originalFetch = async (...args) => {
    calls.push(args);
    return suppliedFetch ? suppliedFetch(...args) : new Response(JSON.stringify(metadata), { headers: { 'Content-Type': 'application/json' } });
  };
  const originalOpen = (...args) => { calls.push({ open: args }); if (popup) receiver.closed = false; return popup ? receiver : null; };
  const window = { fetch: originalFetch, open: originalOpen, addEventListener(type, action) { listeners.set(type, action); },
    removeEventListener(type, action) { if (listeners.get(type) === action) listeners.delete(type); } };
  const context = { window, document, location: new URL(page), navigator: { userAgent: 'BrowserFixture/1' },
    XMLHttpRequest: Xhr, URL, crypto: webcrypto, Uint8Array, TextEncoder, TextDecoder, console: { log() {} },
    setTimeout(action, milliseconds) { const id = ++nextTimer; timers.set(id, { action, milliseconds }); return id; },
    clearTimeout(id) { timers.delete(id); }, alert: value => alerts.push(value),
    performance: { getEntriesByType: () => resources.map(name => ({ name })) },
    PerformanceObserver: class { observe() {} disconnect() {} },
  };
  vm.createContext(context);
  function execute() { vm.runInContext(script, context); }
  const fire = milliseconds => { for (const [id, timer] of [...timers]) if (timer.milliseconds === milliseconds && timers.delete(id)) timer.action(); };
  const message = (data, overrides = {}) => listeners.get('message')?.({ source: receiver, origin: ORIGIN, data, ...overrides });
  execute();
  const runId = () => new URL(calls.filter(call => call.open).at(-1).open[0]).hash.split('.')[1];
  return { runId, window, context, receiver, calls, messages, alerts, body, timers, fire, message, execute, originalFetch, originalOpen,
    originalXhrOpen, originalXhrSend, Xhr,
    ready() { message({ type: 'clip-fetcher:bookmark-ready', schemaVersion: 1, receiverNonce: NONCE, runId: runId() }); },
    stop() { body.children[0].children.at(-1).events.get('click')(); },
    close() { body.children[0].children[0].events.get('click')(); },
    status: () => body.children[0]?.children.find(item => item.tag === 'p')?.textContent,
  };
}

test('bookmark arms once, sends a fresh original-file identity, and closes itself on acknowledgement', async () => {
  const h = fixture();
  assert.equal(h.calls.length, 1, 'arming only opens the receiver; it must not call a platform API or play a video');
  assert.equal(h.calls[0].open[0], `${ORIGIN}/bookmark/receive#${TOKEN}.${h.runId()}`);
  assert.match(h.runId(), /^[a-f0-9]{32}$/);
  h.ready(); await h.window.fetch('https://api-pan.xunlei.com/drive/v1/files/file_A'); await settle(); h.fire(350);
  assert.equal(h.messages.length, 1);
  const { message, origin } = h.messages[0];
  assert.equal(origin, ORIGIN); assert.equal(message.type, 'clip-fetcher:bookmark-candidates');
  assert.equal(message.payload.provider, 'xunlei'); assert.equal(message.payload.pageUrl, 'https://pan.xunlei.com/');
  assert.equal(message.payload.candidates.length, 1);
  assert.equal(message.payload.candidates[0].name, metadata.name); assert.equal(message.payload.candidates[0].size, metadata.size);
  assert.deepEqual(Object.keys(message.payload.candidates[0].headers).sort(), ['Referer', 'User-Agent']);
  assert.doesNotMatch(JSON.stringify(message.payload), /Cookie|Authorization|private=1/);
  h.message({ type: 'clip-fetcher:bookmark-result', schemaVersion: 1, runId: message.runId, receiverNonce: NONCE, accepted: 1 });
  assert.match(h.status(), /已发送/); assert.equal(h.receiver.closed, true);
  assert.equal(h.window.fetch, h.originalFetch); assert.equal(h.window.open, h.originalOpen);
  assert.equal(h.Xhr.prototype.open, h.originalXhrOpen);
  h.fire(1200); assert.equal(h.body.children.length, 0); assert.equal(h.timers.size, 0);
});

test('unrelated cached video resources do not create extra choices when one precise file identity arrives', async () => {
  const h = fixture({ resources: ['https://cdn.example.com/unrelated.mp4', 'https://cdn.example.com/preview.m3u8'] });
  h.ready(); h.fire(350); assert.equal(h.messages.length, 0);
  await h.window.fetch('/file'); await settle(); h.fire(350);
  assert.equal(h.messages.length, 1); assert.equal(h.messages[0].message.payload.candidates.length, 1);
  assert.equal(h.messages[0].message.payload.candidates[0].url, metadata.web_content_link);
});

test('unsupported pages and popup rejection leave the website unchanged', () => {
  const h = fixture({ page: 'https://example.com/' }); assert.equal(h.alerts.length, 1); assert.equal(h.calls.length, 0);
  const blocked = fixture({ popup: false }); assert.match(blocked.status(), /拦截/);
  assert.equal(blocked.window.fetch, blocked.originalFetch);
});

test('stop and repeated bookmark clicks restore hooks and discard late metadata', async () => {
  const waiting = deferred();
  const h = fixture({ fetch: () => waiting.promise }); h.ready(); const request = h.window.fetch('/delayed');
  const firstHook = h.window.fetch; h.execute(); assert.notEqual(h.window.fetch, firstHook);
  h.ready();
  waiting.resolve(new Response(JSON.stringify(metadata), { headers: { 'Content-Type': 'application/json' } }));
  await request; await settle(); h.fire(350); assert.equal(h.messages.length, 0);
  assert.equal(h.body.children.length, 1, 're-clicking reuses one status panel');
  h.stop(); assert.equal(h.window.fetch, h.originalFetch); assert.equal(h.receiver.closed, true); assert.equal(h.timers.size, 0);
});

test('a failed player is irrelevant to captured metadata, but playlist and error responses never count as an original', async () => {
  const h = fixture({ page: 'https://pan.baidu.com/disk/main?account=private', fetch: async value => new Response(JSON.stringify(value === '/error'
    ? { web_content_link: metadata.web_content_link } : { list: [{ server_filename: '原片.mkv', size: metadata.size, dlink: metadata.web_content_link },
      { name: '播放器', web_content_link: 'https://cdn.example.com/preview.m3u8' }] }), {
    status: value === '/error' ? 400 : 200, headers: { 'Content-Type': 'application/json' } }) });
  h.ready(); await h.window.fetch('/error'); await settle(); h.fire(350); assert.equal(h.messages.length, 0);
  await h.window.fetch('/files'); await settle(); h.fire(350);
  assert.equal(h.messages[0].message.payload.provider, 'baidu'); assert.equal(h.messages[0].message.payload.candidates.length, 1);
});

async function waitFor(read, description) {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(20);
  }
  assert.fail(description);
}

for (const [label, edition] of [['general edition', undefined], ['Windows Edge cloud edition', 'windows-edge-cloud']]) {
  test(`Baidu bookmark handoff reaches sequential extraction in the ${label}`, { timeout: 25000 }, async t => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clip-baidu-bookmark-'));
    const dataDir = path.join(root, 'state');
    const bytes = await readFile(new URL('../examples/示例视频.mkv', import.meta.url));
    const baiduPage = 'https://pan.baidu.com/disk/main';
    const signedUrl = 'https://cdn.example.com/baidu-file?signature=SYNTHETIC_BAIDU';
    const name = '百度验收样片.mkv';
    const requests = [];
    const upstream = http.createServer((request, response) => {
      requests.push(request.headers);
      const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.range || '');
      const start = Number(range?.[1]), end = Math.min(Number(range?.[2]), bytes.length - 1);
      if (!range || start > end) return response.writeHead(416).end();
      response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
        'Content-Length': end - start + 1, ETag: '"baidu-bookmark-fixture"' });
      response.end(bytes.subarray(start, end + 1));
    });
    let app, receiver;
    t.after(async () => {
      receiver?.dispose();
      await app?.close();
      upstream.closeAllConnections();
      if (upstream.listening) await new Promise(resolve => upstream.close(resolve));
      await rm(root, { recursive: true, force: true });
    });
    await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve); });
    const upstreamUrl = `http://127.0.0.1:${upstream.address().port}/source.mkv`;
    app = await startServer({ edition, dataDir, outputDir: path.join(root, 'output'),
      browserSourceFactory(options) {
        assert.equal(options.url, signedUrl);
        assert.equal(options.networkPolicy, 'public-https');
        return createRemoteSource({ ...options, url: upstreamUrl, networkPolicy: 'default' });
      },
      browserStreamFactory(options) {
        assert.equal(options.url, signedUrl);
        return createDirectStream({ ...options, url: upstreamUrl, allowLoopbackHttp: true });
      },
    });
    const get = async route => {
      const response = await fetch(app.url + route);
      assert.equal(response.status, 200, route);
      return response.json();
    };
    const boot = await get('/api/bootstrap');
    const post = async (route, body, expected) => {
      const response = await fetch(app.url + route, { method: 'POST', headers: { Origin: app.url,
        'Content-Type': 'application/json', 'X-Session-Token': boot.sessionToken }, body: JSON.stringify(body) });
      const result = await response.json();
      assert.equal(response.status, expected, JSON.stringify(result));
      return result;
    };
    assert.equal(boot.edition, edition);
    const state = await get('/api/bookmark-capture/state');
    const bookmark = fixture({ page: baiduPage + '?bdstoken=SYNTHETIC_PAGE_TOKEN',
      script: decodeURIComponent(state.bookmarklet.slice(11)),
      fetch: async () => Response.json({ list: [{ server_filename: name, size: String(bytes.length), dlink: signedUrl },
        { dlink: 'https://cdn.example.com/preview.m3u8' }] }),
    });
    const captureOrigin = new URL(baiduPage).origin;
    const opener = { postMessage(message, targetOrigin) {
      if (targetOrigin === captureOrigin) bookmark.message(message, { origin: app.url });
    } };
    const listeners = new Map();
    const receiverUrl = bookmark.calls[0].open[0];
    const receiverDocument = await fetch(receiverUrl, { headers: { Origin: captureOrigin, 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(receiverDocument.status, 200);
    await receiverDocument.body.cancel();
    receiver = startBookmarkReceiver({
      window: { location: new URL(receiverUrl), opener, document: { getElementById: () => new Element('p') },
        history: { replaceState() {} }, addEventListener(type, handler) { listeners.set(type, handler); },
        removeEventListener(type) { listeners.delete(type); }, close: () => bookmark.receiver.close() },
      fetch: (route, options) => fetch(app.url + route, { ...options, headers: { ...options.headers, Origin: app.url } }),
    });
    await bookmark.window.fetch('/api/download');
    const handoff = await waitFor(() => { bookmark.fire(350); return bookmark.messages[0]; }, 'Baidu did not hand off the original');
    assert.equal(handoff.origin, app.url);
    assert.equal(handoff.message.payload.candidates.length, 1);
    await listeners.get('message')({ source: opener, origin: captureOrigin, data: handoff.message });
    assert.equal(bookmark.receiver.closed, true);
    bookmark.fire(1200);
    const inbox = await get('/api/bookmark-capture/state');
    assert.deepEqual(inbox.candidates.map(item => [item.provider, item.name, item.size]), [['baidu', name, bytes.length]]);
    assert.doesNotMatch(JSON.stringify(inbox.candidates), /SYNTHETIC_|"headers"/);
    const probe = await post('/api/probe', { source: { type: 'browser', value: inbox.candidates[0].id } }, 200);
    assert.equal(probe.source.label, name);
    assert.equal(probe.directStreamAvailable, true);
    assert.equal((await get('/api/jobs/queue')).activeJob, null, 'capture and probe do not queue work');
    const created = await post('/api/jobs/batch', { sourceId: probe.sourceId, clientBatchId: randomBytes(16).toString('hex'),
      jobs: ['direct-stream', 'indexed'].map((downloadMethod, index) => ({
        start: 1 + index * 4, end: 4 + index * 4, handles: 0, budgetMiB: 32, downloadMethod, clipName: `百度片段 ${index + 1}`,
      })) }, 202);
    const jobs = await waitFor(async () => {
      const snapshot = await get('/api/jobs/queue');
      if (snapshot.activeJob || snapshot.queuedJobs.length) return null;
      return snapshot.recentJobs.length === 2 ? created.jobs.map(job => snapshot.recentJobs.find(item => item.id === job.id)) : null;
    }, 'Baidu clips did not finish');
    for (const job of jobs) {
      assert.equal(job.status, 'completed', JSON.stringify(job.error));
      assert.ok((await stat(job.result.candidatePath)).size > 0);
    }
    assert.ok(Date.parse(jobs[1].startedAt) >= Date.parse(jobs[0].finishedAt));
    assert.ok(requests.length > 0);
    assert.ok(requests.every(headers => headers.referer === baiduPage && headers['user-agent'] === 'BrowserFixture/1'
      && !headers.cookie && !headers.authorization));
    for (const filename of ['bookmark-capture.json', 'tasks.json']) {
      assert.doesNotMatch(await readFile(path.join(dataDir, filename), 'utf8'), /SYNTHETIC_|cdn\.example\.com|BrowserFixture/);
    }
  });
}

test('wrong receiver, origin, run nonce and acknowledgement cannot complete or submit a capture', async () => {
  const h = fixture();
  h.context.window.__clipFetcherBookmarkCaptureV1; // Entry is available only to this page, not a privileged API.
  h.ready(); await h.window.fetch('/file'); await settle(); h.fire(350);
  const sent = h.messages[0].message;
  h.message({ type: 'clip-fetcher:bookmark-result', schemaVersion: 1, runId: 'wrong', receiverNonce: NONCE, accepted: 1 });
  assert.equal(h.receiver.closed, false);
  h.message({ type: 'clip-fetcher:bookmark-result', schemaVersion: 1, runId: sent.runId, receiverNonce: 'c'.repeat(32), accepted: 1 });
  assert.equal(h.receiver.closed, false); h.fire(15000); assert.equal(h.receiver.closed, true); assert.match(h.status(), /尚未确认/);
});

test('no-file timeout and oversized JSON end with a bounded, actionable state', async () => {
  const h = fixture({ fetch: async () => new Response('{}', { headers: { 'Content-Type': 'application/json', 'Content-Length': '9999999' } }) });
  h.ready(); await h.window.fetch('/large'); await settle(); h.fire(350); assert.equal(h.messages.length, 0);
  h.fire(90000); assert.match(h.status(), /未识别到/); assert.equal(h.receiver.closed, true); assert.equal(h.window.fetch, h.originalFetch);
});

test('generated bookmark code remains a standalone browser script with no extension or credential API', () => {
  assert.ok(('javascript:' + encodeURIComponent('void ' + source)).length < 40000);
  assert.doesNotMatch(source, /chrome\.|document\.cookie|localStorage|sessionStorage|Authorization/);
});


test('close dismisses the panel, restores website hooks, and the saved bookmark can start a fresh capture', async () => {
  const waiting = deferred();
  const h = fixture({ fetch: () => waiting.promise }); h.ready();
  const pending = h.window.fetch('/delayed'); h.close();
  assert.equal(h.body.children.length, 0); assert.equal(h.receiver.closed, true); assert.equal(h.timers.size, 0);
  assert.equal(h.window.fetch, h.originalFetch); assert.equal(h.window.open, h.originalOpen);
  assert.equal(h.Xhr.prototype.open, h.originalXhrOpen); assert.equal(h.Xhr.prototype.send, h.originalXhrSend);
  waiting.resolve(new Response(JSON.stringify(metadata), { headers: { 'Content-Type': 'application/json' } }));
  await pending; await settle(); h.fire(350); assert.equal(h.messages.length, 0, 'late website data cannot return a dismissed capture');
  h.execute(); h.ready(); await h.window.fetch('/fresh'); await settle(); h.fire(350);
  assert.equal(h.body.children.length, 1); assert.equal(h.messages.length, 1);
  assert.equal(h.messages[0].message.payload.candidates[0].name, metadata.name);
  h.close(); assert.equal(h.timers.size, 0);
});

test('receiver close notifications must match the window, origin and current nonce', () => {
  const h = fixture(); h.ready();
  const closed = { type: 'clip-fetcher:bookmark-closed', schemaVersion: 1, receiverNonce: NONCE, runId: h.runId() };
  for (const overrides of [{ source: {} }, { origin: 'https://evil.example' }, { origin: 'http://localhost:49123' }]) h.message(closed, overrides);
  h.message({ ...closed, receiverNonce: 'c'.repeat(32) });
  assert.equal(h.body.children.length, 1); assert.notEqual(h.window.fetch, h.originalFetch);
  h.message(closed);
  assert.equal(h.body.children.length, 0); assert.equal(h.window.fetch, h.originalFetch); assert.equal(h.timers.size, 0);
  h.execute(); h.message(closed);
  assert.equal(h.body.children.length, 1, 'a previous receiver cannot close an unbound fresh run');
  h.close();
});

test('native receiver closure is observed before the first handshake and leaves no active watcher', () => {
  const h = fixture(); h.receiver.closed = true; h.fire(500);
  assert.equal(h.body.children.length, 0); assert.equal(h.window.fetch, h.originalFetch); assert.equal(h.timers.size, 0);
});

test('success dismissal cannot hide a newly restarted capture and a failed import remains readable', async () => {
  const h = fixture(); h.ready(); await h.window.fetch('/file'); await settle(); h.fire(350);
  const sent = h.messages[0].message;
  h.message({ type: 'clip-fetcher:bookmark-result', schemaVersion: 1, runId: sent.runId, receiverNonce: NONCE, accepted: 1 });
  h.execute(); h.fire(1200); assert.equal(h.body.children.length, 1); assert.equal(h.receiver.closed, false);
  h.ready(); await h.window.fetch('/file'); await settle(); h.fire(350);
  const next = h.messages[1].message;
  h.message({ type: 'clip-fetcher:bookmark-result', schemaVersion: 1, runId: next.runId, receiverNonce: NONCE, accepted: 0 });
  assert.match(h.status(), /未接受/); assert.equal(h.receiver.closed, false); assert.equal(h.timers.size, 0);
  h.close(); assert.equal(h.body.children.length, 0); assert.equal(h.receiver.closed, true);
});

test('updated bookmark replaces the old page instance instead of restarting its old UI', () => {
  const h = fixture(); h.stop();
  let stopped = 0, restarted = 0;
  Object.defineProperty(h.window, '__clipFetcherBookmarkCaptureV1', { configurable: true,
    value: { origin: ORIGIN, version: 3, restart() { restarted++; }, stop() { stopped++; } } });
  h.execute();
  assert.equal(stopped, 1); assert.equal(restarted, 0); assert.equal(h.body.children.length, 1);
  assert.equal(h.window.__clipFetcherBookmarkCaptureV1.version, 4);
  h.close();
});


test('stale ready followed by stale close cannot bind or dismiss a restarted capture', async () => {
  const h = fixture();
  const oldId = h.runId(); h.ready();
  h.execute(); const freshId = h.runId(); assert.notEqual(freshId, oldId);
  const oldReady = { type: 'clip-fetcher:bookmark-ready', schemaVersion: 1, runId: oldId, receiverNonce: NONCE };
  const oldClosed = { ...oldReady, type: 'clip-fetcher:bookmark-closed' };
  h.message(oldReady); h.message(oldClosed);
  assert.equal(h.body.children.length, 1); assert.equal(h.receiver.closed, false);
  assert.match(h.status(), /正在连接/);
  await h.window.fetch('/file'); await settle(); h.fire(350);
  assert.equal(h.messages.length, 0, 'a stale ready cannot authorize a payload to the old document');
  const freshNonce = 'd'.repeat(32);
  h.message({ ...oldReady, runId: freshId, receiverNonce: freshNonce }); h.fire(350);
  assert.equal(h.messages.length, 1); assert.equal(h.messages[0].message.runId, freshId);
  assert.equal(h.messages[0].message.receiverNonce, freshNonce);
  h.message(oldClosed); assert.equal(h.body.children.length, 1);
  h.message({ ...oldClosed, runId: freshId, receiverNonce: freshNonce });
  assert.equal(h.body.children.length, 0); assert.equal(h.timers.size, 0);
  assert.equal(h.window.fetch, h.originalFetch);
});

test('run binding rejects legacy or mismatched ready even when the window and nonce match', () => {
  const h = fixture();
  for (const runId of [undefined, '', 'f'.repeat(32)]) {
    h.message({ type: 'clip-fetcher:bookmark-ready', schemaVersion: 1, receiverNonce: NONCE, runId });
    assert.match(h.status(), /正在连接/);
  }
  h.ready(); assert.match(h.status(), /已准备/);
  h.message({ type: 'clip-fetcher:bookmark-closed', schemaVersion: 1, receiverNonce: NONCE });
  assert.equal(h.body.children.length, 1); h.close();
});
