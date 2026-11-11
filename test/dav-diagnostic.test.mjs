import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { diagnoseDavAuth } from '../src/dav-diagnostic.mjs';

async function fixture(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, depth: req.headers.depth, authorization: req.headers.authorization, body });
      handler(req, res);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/dav/`, requests };
}

test('independent curl sends only Depth 0 PROPFIND and reports 401, 207 and 403', async t => {
  for (const status of [401, 207, 403]) {
    const f = await fixture(t, (_req, res) => res.writeHead(status).end('<ignored/>'));
    assert.deepEqual(await diagnoseDavAuth({ url: f.url, username: 'fixture-user', password: 'fixture-password' }), { client: 'system-curl', status, code: 'HTTP_RESPONSE' });
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].method, 'PROPFIND');
    assert.equal(f.requests[0].depth, '0');
    assert.equal(f.requests[0].authorization, `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`);
    assert.match(f.requests[0].body, /resourcetype/);
    assert.doesNotMatch(f.requests[0].body, /getcontent|video/i);
  }
});

test('stdin curl config preserves quotes, backslashes, colons and Unicode credentials', async t => {
  const username = '用户"\\';
  const password = '密码:"\\尾';
  const f = await fixture(t, (_req, res) => res.writeHead(207).end());
  assert.equal((await diagnoseDavAuth({ url: f.url, username, password })).status, 207);
  assert.equal(f.requests[0].authorization, `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
});

test('braces in a directory path do not expand into multiple curl requests', async t => {
  const f = await fixture(t, (_req, res) => res.writeHead(401).end());
  assert.equal((await diagnoseDavAuth({ url: `${f.url}{a,b}/`, username: 'user', password: 'pass' })).status, 401);
  assert.equal(f.requests.length, 1);
  assert.equal(decodeURIComponent(f.requests[0].url), '/dav/{a,b}/');
});

test('unsafe targets and control characters are rejected before making any request', async t => {
  const f = await fixture(t, (_req, res) => res.writeHead(207).end());
  for (const url of [
    'https://example.org/dav/', 'file:///dav/', f.url.replace('/dav/', '/outside/'),
    f.url.replace('http://', 'http://secret:password@'), `${f.url}?secret=value`, `${f.url}#secret`,
    `${f.url}../dav/`, `${f.url}%2e%2e/dav/`, `${f.url}%252e%252e/dav/`, `${f.url}a%2fb/`,
  ]) assert.equal((await diagnoseDavAuth({ url })).code, 'TRANSPORT_ERROR');
  for (const password of ['secret\nurl = "https://example.org/dav/"', 'bad\r', 'bad\0', 'bad\u0085']) {
    assert.equal((await diagnoseDavAuth({ url: f.url, username: 'user', password })).code, 'TRANSPORT_ERROR');
  }
  assert.equal(f.requests.length, 0);
});

test('pre-cancelled diagnostics make no request and return no credentials', async t => {
  const f = await fixture(t, (_req, res) => res.writeHead(207).end());
  const output = await diagnoseDavAuth({ url: f.url, username: 'secret-user', password: 'secret-pass', signal: AbortSignal.abort() });
  assert.deepEqual(output, { client: 'system-curl', status: null, code: 'CANCELLED' });
  assert.equal(f.requests.length, 0);
  assert.doesNotMatch(JSON.stringify(output), /secret/);
});

test('redirects are reported without following or forwarding credentials', async t => {
  const destination = await fixture(t, (_req, res) => res.writeHead(207).end());
  const source = await fixture(t, (_req, res) => res.writeHead(307, { Location: destination.url }).end());
  assert.deepEqual(await diagnoseDavAuth({ url: source.url, username: 'user', password: 'pass' }), { client: 'system-curl', status: 307, code: 'HTTP_RESPONSE' });
  assert.equal(destination.requests.length, 0);
});

test('cancelling an in-flight diagnostic stops it without disclosing curl errors', async t => {
  const f = await fixture(t, () => {});
  const controller = new AbortController();
  const pending = diagnoseDavAuth({ url: f.url, username: 'secret-user', password: 'secret-pass', signal: controller.signal });
  await new Promise(resolve => setTimeout(resolve, 100));
  controller.abort();
  assert.deepEqual(await pending, { client: 'system-curl', status: null, code: 'CANCELLED' });
});
