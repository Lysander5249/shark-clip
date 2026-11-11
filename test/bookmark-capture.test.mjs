import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtemp, readFile, writeFile, stat, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createBookmarkCapture } from '../src/bookmark-capture.mjs';

const PORT = 19371, ORIGIN = `http://127.0.0.1:${PORT}`;
const ROUTE = '/api/bookmark-capture/import';
const media = (extra = {}) => ({ url: 'https://cdn.example.com/original.mkv?signature=SYNTHETIC_PRIVATE_SIGNED_URL',
  name: '影片.mkv', size: 123456, ...extra });
const batch = (candidates = [media()], extra = {}) => ({ schemaVersion: 1, provider: 'xunlei',
  pageUrl: 'https://pan.xunlei.com/web/folder', candidates, ...extra });

async function fixture(t, options = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'clip-bookmark-unit-'));
  const capture = await createBookmarkCapture({ dataDir, origin: () => ORIGIN, ...options });
  t.after(async () => { capture.close(); await rm(dataDir, { recursive: true, force: true }); });
  await capture.bindPort(PORT);
  return { capture, dataDir, filename: path.join(dataDir, 'bookmark-capture.json') };
}

async function request(capture, { method = 'POST', route = ROUTE, headers = {}, rawHeaders,
  token, origin = ORIGIN, payload = batch(), raw, declaredLength } = {}) {
  const req = new PassThrough(); req.url = route; req.method = method; req.complete = false;
  req.headers = { host: new URL(ORIGIN).host, origin, 'content-type': 'application/json',
    'x-bookmark-token': token ?? capture.config().token, ...headers };
  if (declaredLength !== undefined) req.headers['content-length'] = String(declaredLength);
  req.rawHeaders = rawHeaders || Object.entries(req.headers).flatMap(([key, value]) => [key, value]);
  const responseHeaders = new Map(); let body;
  const res = new PassThrough();
  res.setHeader = (key, value) => responseHeaders.set(key.toLowerCase(), value);
  res.end = value => { body = value; res.emit('finish'); };
  const pending = capture.handle(req, res);
  req.end(raw ?? JSON.stringify(payload)); req.complete = true;
  return { handled: await pending, status: res.statusCode,
    headers: Object.fromEntries(responseHeaders), body: body ? JSON.parse(body) : undefined };
}

test('first bind persists only local token and preferred port with private permissions; repeat bind is idempotent', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'clip-bookmark-bind-'));
  const capture = await createBookmarkCapture({ dataDir, origin: () => ORIGIN });
  t.after(async () => { capture.close(); await rm(dataDir, { recursive: true, force: true }); });
  assert.equal(capture.preferredPort, null);
  assert.equal(capture.state().available, false);
  assert.throws(() => capture.config(), /BOOKMARK_CAPTURE_UNAVAILABLE/);
  await assert.rejects(capture.bindPort(0), /INVALID_BOOKMARK_CAPTURE_PORT/);
  assert.equal((await capture.bindPort(PORT)).available, true);
  const file = path.join(dataDir, 'bookmark-capture.json');
  const before = await readFile(file, 'utf8'), saved = JSON.parse(before);
  assert.deepEqual(Object.keys(saved).sort(), ['preferredPort', 'schemaVersion', 'token']);
  assert.equal(saved.schemaVersion, 1); assert.equal(saved.preferredPort, PORT);
  assert(typeof saved.token === 'string' && /^[a-f0-9]{64}$/.test(saved.token), 'persist a 256-bit local capability');
  assert(capture.config().token === saved.token, 'RAM token matches only this synthetic local store');
  assert.equal(capture.config().origin, ORIGIN);
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  await capture.bindPort(PORT); await capture.bindPort(PORT);
  assert((await readFile(file, 'utf8')) === before, 'repeated binding must not rewrite or rotate capabilities');
  assert(!JSON.stringify(capture.state()).includes(saved.token), 'safe state excludes the local token');
  assert.deepEqual(capture.state(), { available: true, origin: ORIGIN });
});

test('restart reuses the same token/port while every signed candidate is released from RAM', async t => {
  const { capture, dataDir, filename } = await fixture(t);
  const token = capture.config().token;
  assert.equal((await request(capture)).body.accepted, 1);
  assert.equal(capture.listCandidates().length, 1);
  capture.close();
  const restarted = await createBookmarkCapture({ dataDir, origin: () => ORIGIN });
  t.after(() => restarted.close());
  assert.equal(restarted.preferredPort, PORT);
  assert.equal(restarted.state().available, false);
  assert.equal((await restarted.bindPort(PORT)).available, true);
  assert(restarted.config().token === token, 'restart must retain the existing bookmark capability');
  assert.deepEqual(restarted.listCandidates(), []);
  const saved = await readFile(filename, 'utf8');
  assert(!/SYNTHETIC_PRIVATE|signature=|pan\.xunlei|cdn\.example|影片|Cookie|Authorization/.test(saved),
    'persistence contains neither source metadata nor cloud credentials');
});

test('a fallback port disables capture without changing the original persisted binding', async t => {
  const { capture, dataDir, filename } = await fixture(t);
  const before = await readFile(filename, 'utf8'), token = capture.config().token;
  capture.close();
  const fallback = await createBookmarkCapture({ dataDir, origin: () => `http://127.0.0.1:${PORT + 1}` });
  t.after(() => fallback.close());
  assert.equal(fallback.preferredPort, PORT);
  const state = await fallback.bindPort(PORT + 1);
  assert.equal(state.available, false); assert.match(state.message, /端口.*占用/);
  assert.throws(() => fallback.config(), /BOOKMARK_CAPTURE_UNAVAILABLE/);
  assert.equal((await request(fallback, { token })).status, 503);
  assert((await readFile(filename, 'utf8')) === before, 'fallback must never rotate or overwrite a working bookmark');
  fallback.close();
  const restored = await createBookmarkCapture({ dataDir, origin: () => ORIGIN });
  t.after(() => restored.close());
  await restored.bindPort(PORT);
  assert(restored.config().token === token, 'the original bookmark remains valid when its port is free again');
});

test('corrupt/oversized/unknown configuration only disables capture and is never overwritten', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-bookmark-bad-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const variants = ['{bad json', 'X'.repeat(1025),
    JSON.stringify({ schemaVersion: 2, token: 'a'.repeat(64), preferredPort: PORT }),
    JSON.stringify({ schemaVersion: 1, token: 'short', preferredPort: PORT }),
    JSON.stringify({ schemaVersion: 1, token: 'a'.repeat(64), preferredPort: 0 }),
    JSON.stringify({ schemaVersion: 1, token: 'a'.repeat(64), preferredPort: PORT, url: media().url })];
  for (let n = 0; n < variants.length; n++) {
    const dataDir = path.join(root, String(n)); await mkdir(dataDir);
    const filename = path.join(dataDir, 'bookmark-capture.json'); await writeFile(filename, variants[n]);
    const capture = await createBookmarkCapture({ dataDir, origin: () => ORIGIN });
    try {
      assert.equal((await capture.bindPort(PORT)).available, false, String(n));
      assert.throws(() => capture.config(), /BOOKMARK_CAPTURE_UNAVAILABLE/);
      assert((await readFile(filename, 'utf8')) === variants[n], 'invalid data remains untouched for recovery');
      assert(!/SYNTHETIC_PRIVATE|short|bad json/.test(JSON.stringify(capture.state())), 'untrusted configuration never becomes an error message');
    } finally { capture.close(); }
  }
  const blockedDir = path.join(root, 'not-a-directory'); await writeFile(blockedDir, 'fixture');
  const unavailable = await createBookmarkCapture({ dataDir: blockedDir, origin: () => ORIGIN });
  assert.equal((await unavailable.bindPort(PORT)).available, false); unavailable.close();
  await assert.rejects(createBookmarkCapture({ dataDir: 'relative-path', origin: () => ORIGIN }), /INVALID_BOOKMARK_CAPTURE_OPTIONS/);
});

test('only the receiver same-origin POST with an exact Host and token is admitted, without any CORS', async t => {
  const { capture } = await fixture(t);
  assert.equal(capture.matches(ROUTE), true);
  assert.equal(capture.matches({ url: ROUTE + '?token=synthetic' }), true);
  assert.equal(capture.matches('/api/probe'), false);
  assert.equal((await request(capture, { route: '/api/probe' })).handled, false);
  for (const origin of ['https://pan.xunlei.com', 'https://pan.baidu.com', 'null', '',
    `chrome-extension://${'a'.repeat(32)}`, `http://localhost:${PORT}`, ORIGIN + '/']) {
    const result = await request(capture, { origin });
    assert.equal(result.status, 403, origin);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  for (const headers of [{ host: `localhost:${PORT}` }, { host: 'evil.example' }, { origin: undefined },
    { 'x-bookmark-token': undefined }, { 'x-bookmark-token': 'f'.repeat(64) },
    { 'x-bookmark-token': ['bad', 'bad'] }, { 'sec-fetch-site': 'cross-site' }]) {
    const result = await request(capture, { headers });
    assert.equal(result.status, 403); assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  for (const name of ['host', 'origin', 'x-bookmark-token'])
    assert.equal((await request(capture, { rawHeaders: [name, 'one', name.toUpperCase(), 'two'] })).status, 403);
  assert.equal((await request(capture, { route: ROUTE + '?token=synthetic' })).status, 400);
  for (const method of ['GET', 'PUT', 'OPTIONS']) {
    const result = await request(capture, { method });
    assert.equal(result.status, 405); assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  assert.equal((await request(capture, { headers: { 'content-type': 'text/plain' } })).status, 415);
  const result = await request(capture, { headers: { 'sec-fetch-site': 'same-origin' } });
  assert.deepEqual(result.body, { ok: true, accepted: 1 });
  assert.equal(result.headers['access-control-allow-origin'], undefined);
});

test('inbox snapshots and notifications reconstruct safe metadata; signed URLs and headers remain private', async t => {
  const notifications = [];
  const { capture, filename } = await fixture(t, { onCandidates: snapshot => notifications.push(snapshot) });
  const token = capture.config().token;
  const result = await request(capture, { payload: batch([media({ headers: {
    'User-Agent': 'SyntheticChrome/1', Referer: 'https://pan.xunlei.com/web',
    Cookie: 'SYNTHETIC_PRIVATE_COOKIE', Authorization: 'Bearer SYNTHETIC_PRIVATE_AUTH' }, raw: 'SYNTHETIC_PRIVATE_RAW' })]) });
  assert.deepEqual(result.body, { ok: true, accepted: 1 });
  const snapshot = capture.listCandidates();
  assert.equal(snapshot.length, 1); assert.equal(notifications.length, 1);
  assert.deepEqual(Object.keys(snapshot[0]).sort(), ['hasContext', 'id', 'name', 'provider', 'receivedAt', 'size', 'sourceHost']);
  assert.equal(snapshot[0].hasContext, true); assert.equal(snapshot[0].sourceHost, 'cdn.example.com');
  const shared = JSON.stringify([snapshot, notifications, result.body, capture.state()]);
  assert(!/SYNTHETIC_PRIVATE|signature=|https:|Cookie|Authorization|pageUrl/.test(shared));
  assert(!shared.includes(token), 'public metadata cannot include the local bookmark token');
  const candidate = capture.getCandidate(snapshot[0].id);
  assert.equal(candidate.url, media().url);
  assert.deepEqual(candidate.headers, { 'User-Agent': 'SyntheticChrome/1', Referer: 'https://pan.xunlei.com/web' });
  candidate.headers.Cookie = 'mutation'; candidate.name = 'mutation'; snapshot[0].name = 'mutation';
  assert.equal(capture.getCandidate(snapshot[0].id).headers.Cookie, undefined);
  assert.equal(capture.listCandidates()[0].name, '影片.mkv');
  const saved = await readFile(filename, 'utf8');
  assert(!/SYNTHETIC_PRIVATE|signature=|SyntheticChrome|影片/.test(saved));
  assert.equal((await request(capture, { payload: batch([media({ url: 'blob:invalid' })]) })).body.accepted, 0);
  assert.equal(notifications.length, 1, 'empty captures never trigger candidate notifications');
});

test('unsafe URLs, preview assets and HLS/DASH are filtered without contacting any source', async t => {
  const { capture } = await fixture(t);
  const rejected = ['http://cdn.example.com/movie.mkv', 'blob:https://pan.xunlei.com/id', 'data:video/mp4;base64,AAAA',
    'https://user:password@cdn.example.com/movie.mkv', 'https://cdn.example.com/movie.mkv#fragment',
    'https://localhost/movie.mkv', 'https://localhost./movie.mkv', 'https://x.localhost/movie.mkv',
    'https://127.0.0.1/movie.mkv', 'https://2130706433/movie.mkv', 'https://10.0.0.1/movie.mkv',
    'https://172.20.0.1/movie.mkv', 'https://192.168.1.1/movie.mkv', 'https://169.254.169.254/movie.mkv',
    'https://[::1]/movie.mkv', 'https://[::ffff:127.0.0.1]/movie.mkv', 'https://cdn.example.com/%0d%0afile.mkv',
    'https://cdn.example.com/playlist.m3u8?signature=synthetic', 'https://cdn.example.com/manifest.mpd',
    'https://cdn.example.com/logo.png', 'https://cdn.example.com/player.js', 'https://cdn.example.com/part.m4s'];
  for (let n = 0; n < rejected.length; n += 20) {
    const result = await request(capture, { payload: batch(rejected.slice(n, n + 20).map(url => media({ url }))) });
    assert.equal(result.body.accepted, 0);
  }
  const accepted = await request(capture, { payload: batch([media(), media({
    url: 'https://another.example.com/opaque?signature=synthetic', name: 'another.MKV' })]) });
  assert.equal(accepted.body.accepted, 2); assert.equal(capture.listCandidates().length, 2);
});

test('only the corresponding official provider page is accepted, with query and fragment removed by the sender', async t => {
  const { capture } = await fixture(t);
  for (const pageUrl of ['http://pan.xunlei.com/', 'https://pan.xunlei.com.evil.example/',
    'https://pan.baidu.com/disk/main', 'https://pan.xunlei.com/?token=synthetic', 'https://pan.xunlei.com/?',
    'https://pan.xunlei.com/#fragment', 'https://pan.xunlei.com:444/', 'https://pan.xunlei.com/%0a'])
    assert.equal((await request(capture, { payload: batch(undefined, { pageUrl }) })).status, 400, pageUrl);
  for (const provider of ['quark', '__proto__', 'constructor', null, {}])
    assert.equal((await request(capture, { payload: batch(undefined, { provider }) })).status, 400);
  assert.equal((await request(capture, { payload: batch(undefined, {
    provider: 'baidu', pageUrl: 'https://pan.baidu.com/disk/main' }) })).body.accepted, 1);
  assert.equal(capture.listCandidates()[0].provider, 'baidu');
});

test('batch/ring/TTL limits, URL deduplication, bounded text and forget prevent an unbounded inbox', async t => {
  let time = 1000;
  const { capture } = await fixture(t, { now: () => time });
  assert.equal((await request(capture, { payload: batch(Array(21).fill(media())) })).status, 400);
  assert.equal((await request(capture, { payload: batch([media(), media()]) })).body.accepted, 1);
  const first = capture.listCandidates()[0].id;
  time += 50;
  assert.equal((await request(capture, { payload: batch([media({ name: 'https://secret.example/?sign=SYNTHETIC_PRIVATE',
    size: '123', headers: { 'User-Agent': 'bad\r\nCookie: synthetic', Referer: 'https://pan.xunlei.com/?token=synthetic' } })]) })).body.accepted, 1);
  assert.equal(capture.listCandidates()[0].id, first);
  assert.equal(capture.listCandidates()[0].name, '书签捕获的媒体');
  assert.equal(capture.listCandidates()[0].hasContext, false); assert.equal(capture.listCandidates()[0].size, undefined);
  for (let n = 0; n < 3; n++) {
    const candidates = Array.from({ length: 20 }, (_, i) => media({ url: `https://cdn.example.com/movie-${n * 20 + i}.mkv`,
      name: '名'.repeat(1024), size: Number.MAX_SAFE_INTEGER + 1 }));
    assert.equal((await request(capture, { payload: batch(candidates) })).body.accepted, 20);
  }
  assert.equal(capture.listCandidates().length, 50); assert.equal(capture.getCandidate(first), undefined);
  const id = capture.listCandidates()[0].id;
  assert.equal(capture.listCandidates()[0].name.length, 256); assert.equal(capture.listCandidates()[0].size, undefined);
  assert.equal(capture.forget(id), true); assert.equal(capture.forget(id), false);
  const nextId = capture.listCandidates()[0].id;
  time += 30 * 60_000 - 1; assert.equal(capture.listCandidates().length, 49);
  time++; assert.equal(capture.getCandidate(nextId), undefined); assert.deepEqual(capture.listCandidates(), []);
});

test('oversized, malformed and unsupported bodies return only fixed errors and never echo secrets', async t => {
  const { capture } = await fixture(t);
  for (const options of [{ raw: '{"SYNTHETIC_PRIVATE":' }, { raw: Buffer.from([0xc3, 0x28]) },
    { payload: { schemaVersion: 2, url: media().url } }, { payload: null }]) {
    const response = await request(capture, options);
    assert.equal(response.status, 400);
    assert(!/SYNTHETIC_PRIVATE|https:|signature=/.test(JSON.stringify(response.body)));
  }
  const raw = JSON.stringify({ ...batch(), extra: 'SYNTHETIC_PRIVATE'.repeat(5000) });
  assert.equal((await request(capture, { raw })).status, 413);
  assert.equal((await request(capture, { raw: '{}', declaredLength: 65537 })).status, 413);
  assert.deepEqual(capture.listCandidates(), []);
});

test('client abort and lifecycle cancellation settle stalled input without committing a candidate', async t => {
  const controller = new AbortController();
  const { capture, filename } = await fixture(t, { signal: controller.signal });
  const token = capture.config().token, before = await readFile(filename, 'utf8');
  const stalled = () => {
    const req = new PassThrough(); req.url = ROUTE; req.method = 'POST'; req.complete = false;
    req.headers = { host: new URL(ORIGIN).host, origin: ORIGIN, 'content-type': 'application/json', 'x-bookmark-token': token };
    const res = new PassThrough(); let body;
    res.setHeader = () => {}; res.end = value => { body = value; };
    const promise = capture.handle(req, res); req.write('{"schemaVersion":1,');
    return { req, promise, body: () => body };
  };
  const client = stalled(); client.req.emit('aborted');
  assert.doesNotThrow(() => client.req.emit('error', new Error('SYNTHETIC_PRIVATE_SOCKET_ERROR')));
  assert.equal(await client.promise, true); assert.match(client.body(), /REQUEST_CANCELLED/);
  client.req.emit('close'); assert.equal(capture.state().available, true);
  const server = stalled(); controller.abort();
  assert.equal(await server.promise, true); assert.match(server.body(), /REQUEST_CANCELLED/);
  assert.deepEqual(capture.listCandidates(), []); assert.equal(capture.state().available, false);
  assert.throws(() => capture.config(), /BOOKMARK_CAPTURE_UNAVAILABLE/);
  assert.equal((await request(capture, { token })).status, 503);
  assert((await readFile(filename, 'utf8')) === before, 'closing never revokes an already persisted bookmark');
});

test('closing during the first asynchronous bind cannot leave a corrupt bookmark configuration', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'clip-bookmark-close-bind-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const capture = await createBookmarkCapture({ dataDir, origin: () => ORIGIN });
  const binding = capture.bindPort(PORT);
  capture.close();
  await binding;
  assert.equal(capture.state().available, false);
  let saved;
  try { saved = JSON.parse(await readFile(path.join(dataDir, 'bookmark-capture.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  assert(saved.schemaVersion === 1 && saved.preferredPort === PORT && typeof saved.token === 'string'
    && /^[a-f0-9]{64}$/.test(saved.token), 'a late first bind must either cancel persistence or write a complete valid local configuration');
});

test('real loopback POST requires same origin and the bookmark header, with no website CORS permission', async t => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'clip-bookmark-http-'));
  let origin;
  const capture = await createBookmarkCapture({ dataDir, origin: () => origin });
  const server = http.createServer(async (req, res) => {
    if (!await capture.handle(req, res)) { res.writeHead(404); res.end(); }
  });
  t.after(async () => {
    capture.close(); server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(dataDir, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  origin = `http://127.0.0.1:${server.address().port}`;
  await capture.bindPort(server.address().port);
  const token = capture.config().token;
  const headers = { Origin: origin, 'Content-Type': 'application/json', 'X-Bookmark-Token': token };
  const accepted = await fetch(origin + ROUTE, { method: 'POST', headers, body: JSON.stringify(batch()) });
  assert.equal(accepted.status, 200); assert.deepEqual(await accepted.json(), { ok: true, accepted: 1 });
  assert.equal(accepted.headers.get('Access-Control-Allow-Origin'), null);
  for (const extra of [{ Origin: 'https://pan.xunlei.com' }, { Origin: 'https://pan.baidu.com' },
    { Origin: 'null' }, { 'X-Bookmark-Token': 'f'.repeat(64) }]) {
    const response = await fetch(origin + ROUTE, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(batch()) });
    assert.equal(response.status, 403); assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  }
  const preflight = await fetch(origin + ROUTE, { method: 'OPTIONS', headers: {
    Origin: 'https://pan.xunlei.com', 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-bookmark-token' } });
  assert.equal(preflight.status, 403); assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), null);
  const oversized = await fetch(origin + ROUTE, { method: 'POST', headers,
    body: JSON.stringify({ ...batch(), extra: 'X'.repeat(70_000) }) });
  assert.equal(oversized.status, 413);
  assert(!/SYNTHETIC_PRIVATE|signature=|https:/.test(JSON.stringify(capture.listCandidates())));
});
