import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { createBrowserHelper } from '../src/browser-helper.mjs';

const EXT = `chrome-extension://${'a'.repeat(32)}`;
const OTHER_EXT = `chrome-extension://${'b'.repeat(32)}`;
const ORIGIN = 'http://127.0.0.1:19371';
const PAIR = '/api/browser-helper/pair';
const CANDIDATES = '/api/browser-helper/candidates';
const media = (extra = {}) => ({ url: 'https://cdn.example.com/original.mkv?signature=PRIVATE_SIGNED_VALUE',
  name: '影片.mkv', size: 123456, ...extra });
const batch = (candidates = [media()], extra = {}) => ({ schemaVersion: 1, provider: 'xunlei',
  pageUrl: 'https://pan.xunlei.com/web/folder', candidates, ...extra });
const tokenOf = helper => new URL(helper.pairingInfo().url).hash.slice(1);

// The stream boundary also exercises cancellation without requiring a listening
// socket in restricted child-agent environments. The final test uses real HTTP.
async function request(helper, path, { method = 'POST', extension = EXT, token = tokenOf(helper),
  headers = {}, payload, raw, declaredLength, rawHeaders } = {}) {
  const req = new PassThrough();
  req.url = path; req.method = method; req.complete = false;
  req.headers = { host: new URL(ORIGIN).host, origin: extension,
    'content-type': 'application/json', 'x-browser-pairing': token, ...headers };
  if (declaredLength !== undefined) req.headers['content-length'] = String(declaredLength);
  req.rawHeaders = rawHeaders || Object.entries(req.headers).flatMap(([key, value]) => [key, value]);
  const responseHeaders = new Map();
  let body;
  const res = new PassThrough();
  res.setHeader = (key, value) => responseHeaders.set(key.toLowerCase(), value);
  res.end = value => { body = value; res.emit('finish'); };
  const pending = helper.handle(req, res);
  if (payload !== undefined || raw !== undefined) {
    req.end(raw ?? JSON.stringify(payload)); req.complete = true;
  } else { req.end(); req.complete = true; }
  const handled = await pending;
  return { status: res.statusCode, headers: Object.fromEntries(responseHeaders),
    body: body ? JSON.parse(body) : undefined, handled };
}

async function pair(helper, options = {}) {
  return request(helper, PAIR, { payload: { schemaVersion: 1 }, ...options });
}

test('pairing URL uses a RAM-only fragment; pins one extension; reset rotates and revokes', async () => {
  const helper = createBrowserHelper({ origin: () => ORIGIN });
  const url = new URL(helper.pairingInfo().url);
  assert.equal(url.pathname, '/browser-pair');
  assert.equal(url.search, ''); assert.match(url.hash, /^#[a-f0-9]{64}$/);
  assert.equal(helper.matches(PAIR), true);
  assert.equal(helper.matches({ url: `${CANDIDATES}?query` }), true);
  assert.equal(helper.matches('/api/probe'), false);
  assert.equal((await request(helper, '/api/probe')).handled, false);
  const oldToken = tokenOf(helper);
  assert.deepEqual((await pair(helper)).body, { ok: true, schemaVersion: 1, providers: ['xunlei', 'baidu'] });
  assert.equal((await pair(helper)).status, 200);
  assert.equal((await pair(helper, { extension: OTHER_EXT })).status, 403);
  assert.equal((await request(helper, CANDIDATES, { payload: batch() })).body.accepted, 1);
  const previous = helper.listCandidates()[0].id;
  assert.equal(helper.reset().url, helper.pairingInfo().url);
  assert.notEqual(tokenOf(helper), oldToken);
  assert.deepEqual(helper.listCandidates(), []);
  assert.equal(helper.getCandidate(previous), undefined);
  assert.equal((await pair(helper, { token: oldToken })).status, 403);
  assert.equal((await request(helper, CANDIDATES, { payload: batch() })).status, 403);
  assert.equal((await pair(helper, { extension: OTHER_EXT })).status, 200);
  helper.close(); helper.close();
  assert.throws(() => helper.pairingInfo(), /BROWSER_HELPER_CLOSED/);
  assert.equal((await request(helper, PAIR, { token: oldToken })).status, 503);
});

test('rejects website/null/malformed Origins, wrong Host/token and duplicate credentials without CORS reflection', async () => {
  const helper = createBrowserHelper({ origin: () => ORIGIN });
  for (const extension of ['null', '', undefined, 'https://pan.xunlei.com',
    `chrome-extension://${'z'.repeat(32)}`, `${EXT}/`, 'moz-extension://a']) {
    const result = await pair(helper, extension === undefined ? { headers: { origin: undefined } } : { extension });
    assert.equal(result.status, 403, String(extension));
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  for (const headers of [{ host: 'localhost:19371' }, { host: 'evil.example' },
    { 'x-browser-pairing': 'f'.repeat(64) }, { 'x-browser-pairing': ['x', 'y'] }]) {
    const result = await pair(helper, { headers });
    assert.equal(result.status, 403);
    assert.equal(result.headers['access-control-allow-origin'], undefined);
  }
  for (const name of ['host', 'origin', 'x-browser-pairing']) {
    const result = await pair(helper, { rawHeaders: [name, 'a', name.toUpperCase(), 'b'] });
    assert.equal(result.status, 403);
  }
  assert.equal((await request(helper, `${PAIR}?token=private`, { payload: { schemaVersion: 1 } })).status, 400);
  assert.equal((await pair(helper, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await request(helper, PAIR, { method: 'GET' })).status, 405);
  helper.close();
});

test('preflight only permits extension POST with required header names; never pairs by OPTIONS', async () => {
  const helper = createBrowserHelper({ origin: () => ORIGIN });
  const options = { method: 'OPTIONS', headers: { 'access-control-request-method': 'POST',
    'access-control-request-headers': 'Content-Type, X-Browser-Pairing', 'x-browser-pairing': undefined } };
  const preflight = await request(helper, PAIR, options);
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], EXT);
  assert.equal(preflight.headers['access-control-allow-headers'], 'Content-Type, X-Browser-Pairing');
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
  assert.equal((await request(helper, CANDIDATES, { payload: batch() })).status, 403);
  for (const headers of [{ 'access-control-request-headers': 'Authorization' },
    { 'access-control-request-headers': 'Cookie' }, { 'access-control-request-method': 'PUT' }]) {
    const response = await request(helper, PAIR, { ...options, headers: { ...options.headers, ...headers } });
    assert.equal(response.status, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
  }
  await pair(helper);
  assert.equal((await request(helper, PAIR, { ...options, extension: OTHER_EXT })).status, 403);
  helper.close();
});

test('public snapshots omit signed URLs, page URLs, headers and arbitrary submitted fields', async () => {
  const helper = createBrowserHelper({ origin: () => ORIGIN });
  await pair(helper);
  const result = await request(helper, CANDIDATES, { payload: batch([media({
    headers: { 'User-Agent': 'Chrome/123', Referer: 'https://pan.xunlei.com/web',
      Cookie: 'PRIVATE_COOKIE', Authorization: 'Bearer PRIVATE_TOKEN', 'X-Captcha-Token': 'PRIVATE_CAPTCHA' },
    raw: 'PRIVATE_RAW', message: 'PRIVATE_MESSAGE' })]) });
  assert.deepEqual(result.body, { ok: true, accepted: 1 });
  const snapshot = helper.listCandidates();
  assert.equal(snapshot.length, 1);
  assert.deepEqual(Object.keys(snapshot[0]).sort(), ['hasContext', 'id', 'name', 'provider', 'receivedAt', 'size', 'sourceHost']);
  assert.equal(snapshot[0].sourceHost, 'cdn.example.com');
  assert.equal(snapshot[0].hasContext, true);
  assert.doesNotMatch(JSON.stringify([snapshot, result.body]), /PRIVATE|signature|https:|Referer|Cookie|Authorization|pageUrl/);
  const privateValue = helper.getCandidate(snapshot[0].id);
  assert.equal(privateValue.url, media().url);
  assert.deepEqual(privateValue.headers, { 'User-Agent': 'Chrome/123', Referer: 'https://pan.xunlei.com/web' });
  privateValue.headers.Cookie = 'mutation'; privateValue.name = 'mutation'; snapshot[0].name = 'mutation';
  assert.equal(helper.getCandidate(snapshot[0].id).headers.Cookie, undefined);
  assert.equal(helper.listCandidates()[0].name, '影片.mkv');
  assert.equal(helper.forget(snapshot[0].id), true);
  assert.equal(helper.forget(snapshot[0].id), false);
  assert.deepEqual(helper.listCandidates(), []);
  helper.close();
});

test('filters private/unsafe URLs, streams and obvious assets while preserving full-file query signatures', async () => {
  const helper = createBrowserHelper({ origin: () => ORIGIN }); await pair(helper);
  const invalid = ['http://cdn.example.com/movie.mkv', 'blob:https://pan.xunlei.com/id',
    'https://user:secret@cdn.example.com/movie.mkv', 'https://cdn.example.com/movie.mkv#private',
    'https://localhost/movie.mkv', 'https://localhost./movie.mkv', 'https://x.localhost/movie.mkv',
    'https://127.0.0.1/movie.mkv', 'https://2130706433/movie.mkv', 'https://[::1]/movie.mkv',
    'https://[::ffff:127.0.0.1]/movie.mkv', 'https://192.168.1.1/movie.mkv',
    'https://172.20.1.2/movie.mkv', 'https://10.1.2.3/movie.mkv', 'https://169.254.169.254/movie.mkv',
    'https://cdn.example.com/playlist.m3u8?sign=secret', 'https://cdn.example.com/movie.mpd',
    'https://cdn.example.com/logo.png', 'https://cdn.example.com/%70layer.js', 'https://cdn.example.com/part.m4s'];
  assert.equal(invalid.length, 20);
  assert.deepEqual((await request(helper, CANDIDATES, { payload: batch(invalid.map(url => media({ url }))) })).body,
    { ok: true, accepted: 0 });
  const valid = [media(), media({ url: 'https://other.example.com/opaque?id=SIGNED_ORIGINAL', name: 'another.MKV' }),
    media({ url: 'https://8.8.8.8/movie.mp4', name: 'movie.mp4' }),
    media({ url: 'https://[2606:4700:4700::1111]/movie.mp4', name: 'movie.mp4' })];
  assert.equal((await request(helper, CANDIDATES, { payload: batch(valid) })).body.accepted, 4);
  assert.equal(helper.listCandidates().length, 4);
  assert.equal((await request(helper, CANDIDATES, { payload: batch([media({
    url: 'https://cdn.example.com/%0d%0aoriginal.mkv' })]) })).body.accepted, 0);
  helper.close();
});

test('provider pages must use the corresponding official HTTPS origin and have no query or fragment', async () => {
  const helper = createBrowserHelper({ origin: () => ORIGIN }); await pair(helper);
  for (const pageUrl of ['http://pan.xunlei.com/web', 'https://pan.xunlei.com.evil.example/web',
    'https://pan.baidu.com/disk/main', 'https://pan.xunlei.com/web?token=private',
    'https://pan.xunlei.com/web?', 'https://pan.xunlei.com/web#private',
    'https://pan.xunlei.com:444/web', 'https://pan.xunlei.com/%0a']) {
    assert.equal((await request(helper, CANDIDATES, { payload: batch(undefined, { pageUrl }) })).status, 400, pageUrl);
  }
  for (const provider of ['quark', '__proto__', 'constructor', null, {}]) {
    assert.equal((await request(helper, CANDIDATES, { payload: batch(undefined, { provider }) })).status, 400);
  }
  const baidu = await request(helper, CANDIDATES, { payload: batch(undefined, {
    provider: 'baidu', pageUrl: 'https://pan.baidu.com/disk/main' }) });
  assert.equal(baidu.body.accepted, 1);
  assert.equal(helper.listCandidates()[0].provider, 'baidu');
  helper.close();
});

test('bounds batches, ring, TTL, text and context; deduplicates exact signed URLs', async () => {
  let time = 1000;
  const helper = createBrowserHelper({ origin: () => ORIGIN, now: () => time, ttlMs: 100 }); await pair(helper);
  assert.equal((await request(helper, CANDIDATES, { payload: batch(Array(21).fill(media())) })).status, 400);
  assert.equal((await request(helper, CANDIDATES, { payload: batch([media(), media()]) })).body.accepted, 1);
  const firstId = helper.listCandidates()[0].id;
  time = 1050;
  const dirty = media({ name: 'https://private.example/file?signature=PRIVATE', size: '123', headers: {
    'User-Agent': 'bad\r\nCookie: PRIVATE', Referer: 'https://pan.xunlei.com/web?token=PRIVATE' } });
  assert.equal((await request(helper, CANDIDATES, { payload: batch([dirty]) })).body.accepted, 1);
  assert.equal(helper.listCandidates()[0].id, firstId);
  assert.equal(helper.listCandidates()[0].name, '浏览器捕获的媒体');
  assert.equal(helper.listCandidates()[0].hasContext, false);
  assert.equal(helper.listCandidates()[0].size, undefined);
  for (let n = 0; n < 3; n++) {
    const candidates = Array.from({ length: 20 }, (_, i) => media({ url: `https://cdn.example.com/movie-${n * 20 + i}.mkv`,
      name: '名'.repeat(1024), size: Number.MAX_SAFE_INTEGER + 1 }));
    assert.equal((await request(helper, CANDIDATES, { payload: batch(candidates) })).body.accepted, 20);
  }
  assert.equal(helper.listCandidates().length, 50);
  assert.equal(helper.getCandidate(firstId), undefined);
  assert.equal(helper.listCandidates()[0].name.length, 256);
  assert.equal(helper.listCandidates()[0].size, undefined);
  const id = helper.listCandidates()[0].id;
  time = 1149; assert.equal(helper.listCandidates().length, 50);
  time = 1150; assert.equal(helper.getCandidate(id), undefined);
  assert.deepEqual(helper.listCandidates(), []);
  helper.close();
});

test('body cap uses actual bytes; malformed JSON and unknown schema never echo body or accept a source', async () => {
  const helper = createBrowserHelper({ origin: () => ORIGIN }); await pair(helper);
  for (const options of [{ raw: '{"PRIVATE_SIGNED_VALUE":' },
    { payload: { schemaVersion: 2, url: 'https://secret.example/PRIVATE_SIGNED_VALUE' } },
    { raw: Buffer.from([0xc3, 0x28]) }]) {
    const response = await request(helper, CANDIDATES, options);
    assert.equal(response.status, 400);
    assert.doesNotMatch(JSON.stringify(response.body), /PRIVATE|https:|secret/);
  }
  const raw = JSON.stringify({ ...batch(), extra: 'PRIVATE'.repeat(10000) });
  assert.equal((await request(helper, CANDIDATES, { raw })).status, 413);
  assert.equal((await request(helper, CANDIDATES, { raw: '{}', declaredLength: 65537 })).status, 413);
  assert.deepEqual(helper.listCandidates(), []);
  helper.close();
});

test('signal/close abort stalled input; reset cannot commit a prior pairing or source submission', async () => {
  const controller = new AbortController();
  const helper = createBrowserHelper({ origin: () => ORIGIN, signal: controller.signal }); await pair(helper);
  const req = new PassThrough();
  req.url = CANDIDATES; req.method = 'POST'; req.complete = false;
  req.headers = { host: new URL(ORIGIN).host, origin: EXT, 'content-type': 'application/json', 'x-browser-pairing': tokenOf(helper) };
  const res = new PassThrough(); let body;
  res.setHeader = () => {}; res.end = value => { body = value; };
  const pending = helper.handle(req, res);
  req.write('{"schemaVersion":1,');
  helper.reset();
  assert.equal(await pending, true);
  assert.match(body, /REQUEST_CANCELLED/);
  assert.deepEqual(helper.listCandidates(), []);
  const newToken = tokenOf(helper);
  controller.abort();
  assert.equal((await pair(helper, { token: newToken })).status, 503);
  assert.throws(() => helper.reset(), /BROWSER_HELPER_CLOSED/);
  const alreadyAborted = createBrowserHelper({ origin: () => ORIGIN, signal: controller.signal });
  assert.throws(() => alreadyAborted.pairingInfo(), /BROWSER_HELPER_CLOSED/);
});

test('client abort followed by a socket error stays contained and cannot create a candidate', async () => {
  const helper = createBrowserHelper({ origin: () => ORIGIN }); await pair(helper);
  const req = new PassThrough();
  req.url = CANDIDATES; req.method = 'POST'; req.complete = false;
  req.headers = { host: new URL(ORIGIN).host, origin: EXT, 'content-type': 'application/json',
    'x-browser-pairing': tokenOf(helper) };
  const res = new PassThrough(); res.setHeader = () => {}; res.end = () => {};
  const pending = helper.handle(req, res);
  req.emit('aborted');
  assert.doesNotThrow(() => req.emit('error', new Error('PRIVATE_SOCKET_MESSAGE')));
  assert.equal(await pending, true);
  assert.deepEqual(helper.listCandidates(), []);
  req.emit('close'); helper.close();
});

test('real local HTTP boundary permits extension pairing/capture and rejects cross-site submission', async t => {
  let serverOrigin;
  const helper = createBrowserHelper({ origin: () => serverOrigin });
  const server = http.createServer(async (req, res) => {
    if (!await helper.handle(req, res)) { res.statusCode = 404; res.end(); }
  });
  t.after(() => { helper.close(); server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  serverOrigin = `http://127.0.0.1:${server.address().port}`;
  const token = tokenOf(helper);
  const headers = { Origin: EXT, 'X-Browser-Pairing': token, 'Content-Type': 'application/json' };
  const preflight = await fetch(`${serverOrigin}${PAIR}`, { method: 'OPTIONS', headers: {
    Origin: EXT, 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'content-type,x-browser-pairing' } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Origin'), EXT);
  assert.equal((await fetch(`${serverOrigin}${PAIR}`, { method: 'POST', headers,
    body: JSON.stringify({ schemaVersion: 1 }) })).status, 200);
  const capture = await fetch(`${serverOrigin}${CANDIDATES}`, { method: 'POST', headers, body: JSON.stringify(batch()) });
  assert.deepEqual(await capture.json(), { ok: true, accepted: 1 });
  const rejected = await fetch(`${serverOrigin}${CANDIDATES}`, { method: 'POST',
    headers: { ...headers, Origin: 'https://pan.xunlei.com' }, body: JSON.stringify(batch()) });
  assert.equal(rejected.status, 403);
  assert.equal(rejected.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal((await fetch(`${serverOrigin}${PAIR}`, { method: 'POST', headers,
    body: JSON.stringify({ schemaVersion: 1, extra: 'X'.repeat(70_000) }) })).status, 413);
  assert.doesNotMatch(JSON.stringify(helper.listCandidates()), /PRIVATE_SIGNED_VALUE|signature|https:/);
});
