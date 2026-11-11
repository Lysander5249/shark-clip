import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { listWebDav, WebDavError } from '../src/webdav.mjs';

async function fixture(t, handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, depth: req.headers.depth, authorization: req.headers.authorization });
    handler(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
function xml(responses, prefix = 'D') {
  return `<?xml version="1.0" encoding="UTF-8"?><${prefix}:multistatus xmlns:${prefix}="DAV:">${responses}</${prefix}:multistatus>`;
}
function response(href, { directory = false, size = '1234', extra = '', prefix = 'D' } = {}) {
  return `<${prefix}:response><${prefix}:href>${href}</${prefix}:href><${prefix}:propstat><${prefix}:prop><${prefix}:resourcetype>${directory ? `<${prefix}:collection/>` : ''}</${prefix}:resourcetype><${prefix}:getcontentlength>${size}</${prefix}:getcontentlength><${prefix}:getlastmodified>Fri, 16 Oct 2026 00:00:00 GMT</${prefix}:getlastmodified></${prefix}:prop><${prefix}:status>HTTP/1.1 200 OK</${prefix}:status></${prefix}:propstat>${extra}</${prefix}:response>`;
}
async function serveXml(t, body, headers = {}) {
  return fixture(t, (_req, res) => res.writeHead(207, { 'Content-Type': 'application/xml', ...headers }).end(body));
}
function errorCode(code) {
  return error => { assert.ok(error instanceof WebDavError); assert.equal(error.code, code); assert.doesNotMatch(error.message, /http|fixture-secret|fixture-password/); return true; };
}

test('Depth:1 PROPFIND lists namespaced successful properties and returns encoded immediate children', async t => {
  const prefix = 'arbitrary_19';
  const failed = `<${prefix}:propstat><${prefix}:prop><${prefix}:getcontentlength>999999</${prefix}:getcontentlength><${prefix}:resourcetype><${prefix}:collection/></${prefix}:resourcetype></${prefix}:prop><${prefix}:status>HTTP/1.1 404 Not Found</${prefix}:status></${prefix}:propstat>`;
  const f = await serveXml(t, xml([
    response('/dav/迅雷/', { directory: true, prefix }),
    response('/dav/', { directory: true, prefix }),
    response('/dav/迅雷/电影 空格.mkv', { prefix, extra: failed }),
    response('/dav/迅雷/文件夹/', { prefix, directory: true }),
  ].join(''), prefix));
  const result = await listWebDav({ url: `${f.url}/dav/迅雷`, username: 'fixture-user', password: 'fixture-password' });
  assert.equal(result.baseUrl, `${f.url}/dav/`);
  assert.equal(result.directoryUrl, `${f.url}/dav/${encodeURIComponent('迅雷')}/`);
  assert.equal(result.parentUrl, `${f.url}/dav/`);
  assert.equal(result.entries.length, 2);
  assert.deepEqual(result.entries[0], { name: '电影 空格.mkv', url: `${f.url}/dav/${encodeURIComponent('迅雷')}/${encodeURIComponent('电影 空格.mkv')}`, isDirectory: false, size: 1234, lastModified: 'Fri, 16 Oct 2026 00:00:00 GMT' });
  assert.equal(result.entries[1].isDirectory, true);
  assert.equal(result.entries[1].size, null);
  assert.ok(result.entries[1].url.endsWith('/'));
  assert.deepEqual(f.requests, [{ method: 'PROPFIND', url: `/dav/${encodeURIComponent('迅雷')}/`, depth: '1', authorization: `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}` }]);
});

test('default DAV namespace, standard and numeric entities are decoded without expanding text twice', async t => {
  const body = '<multistatus xmlns="DAV:"><response><href>/dav/A&amp;B%20&#x4E2D;&#25991;.mkv</href><propstat><prop><resourcetype/><getcontentlength>0</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat></response></multistatus>';
  const f = await serveXml(t, body);
  const result = await listWebDav({ url: `${f.url}/dav/` });
  assert.equal(result.parentUrl, null);
  assert.equal(result.entries[0].name, 'A&B 中文.mkv');
  assert.equal(result.entries[0].size, 0);
  assert.equal(result.entries[0].url, `${f.url}/dav/A%26B%20${encodeURIComponent('中文')}.mkv`);
});

test('absolute same-origin href and relative child href remain inside the dav root', async t => {
  let body;
  const f = await fixture(t, (_req, res) => res.writeHead(207).end(body));
  body = xml(response(`${f.url}/dav/absolute.mkv`) + response('relative.mkv'));
  const result = await listWebDav({ url: `${f.url}/dav/` });
  assert.deepEqual(result.entries.map(entry => entry.name), ['absolute.mkv', 'relative.mkv']);
});

test('failed propstat and failed response do not become usable files', async t => {
  const body = xml('<D:response><D:href>/dav/unavailable.mkv</D:href><D:propstat><D:prop><D:resourcetype/></D:prop><D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response><D:response><D:href>/dav/missing.mkv</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>');
  const f = await serveXml(t, body);
  assert.deepEqual((await listWebDav({ url: `${f.url}/dav/` })).entries, []);
});

test('cross-origin href is rejected without contacting the referenced server', async t => {
  const destination = await fixture(t, (_req, res) => res.end());
  const f = await serveXml(t, xml(response(`${destination.url}/dav/movie.mkv`)));
  await assert.rejects(listWebDav({ url: `${f.url}/dav/`, username: 'fixture-user', password: 'fixture-password' }), errorCode('WEBDAV_HREF_UNSAFE'));
  assert.equal(destination.requests.length, 0);
});

test('outside-root, recursive and encoded traversal hrefs fail closed', async t => {
  for (const href of ['/other/movie.mkv', '/dav/%2e%2e/private.mkv', '/dav/%252e%252e/private.mkv', '/dav/a%2Fb.mkv', '/dav/a%255cb.mkv', '/dav/folder/movie.mkv', '/dav/movie.mkv?token=fixture-secret', '//elsewhere/dav/movie.mkv']) {
    const f = await serveXml(t, xml(response(href)));
    await assert.rejects(listWebDav({ url: `${f.url}/dav/` }), errorCode('WEBDAV_HREF_UNSAFE'), href);
  }
});

test('input accepts only a local dav path and rejects credentials, queries and pre-normalisation traversal', async () => {
  for (const url of ['https://example.org/dav/', 'file:///dav/', 'http://fixture-user:fixture-password@127.0.0.1/dav/', 'http://127.0.0.1/dav/?token=fixture-secret', 'http://127.0.0.1/dav/../dav/', 'http://127.0.0.1/dav/%2e%2e/dav/', 'http://127.0.0.1/outside/']) {
    await assert.rejects(listWebDav({ url }), errorCode('WEBDAV_URL_INVALID'));
  }
});

test('same-origin redirects retain PROPFIND and auth, while cross-origin redirect never sends auth', async t => {
  const destination = await fixture(t, (_req, res) => res.writeHead(207).end(xml('')));
  let mode = 'local';
  const f = await fixture(t, (req, res) => {
    if (mode === 'external') res.writeHead(307, { Location: `${destination.url}/dav/` }).end();
    else if (req.url === '/dav/') res.writeHead(301, { Location: '/dav/folder/' }).end();
    else res.writeHead(207).end(xml(response('/dav/folder/movie.mkv')));
  });
  const options = { url: `${f.url}/dav/`, username: 'fixture-user', password: 'fixture-password' };
  assert.equal((await listWebDav(options)).directoryUrl, `${f.url}/dav/folder/`);
  assert.equal(f.requests.length, 2);
  assert.ok(f.requests.every(req => req.method === 'PROPFIND' && req.depth === '1' && req.authorization));
  mode = 'external';
  await assert.rejects(listWebDav(options), errorCode('WEBDAV_REDIRECT'));
  assert.equal(destination.requests.length, 0);
});

test('HTTP 401 is a sanitised authentication error', async t => {
  const f = await fixture(t, (_req, res) => res.writeHead(401).end('fixture-password'));
  await assert.rejects(listWebDav({ url: `${f.url}/dav/`, password: 'fixture-password' }), e => {
    errorCode('AUTH_REQUIRED')(e);
    assert.match(e.message, /HTTP 401/);
    assert.match(e.message, /允许 CloudDrive 账号访问/);
    return true;
  });
});

test('HTTP 403 reports directory permissions separately from authentication', async t => {
  const f = await fixture(t, (_req, res) => res.writeHead(403).end('fixture-password'));
  await assert.rejects(listWebDav({ url: `${f.url}/dav/`, password: 'fixture-password' }), e => {
    errorCode('ACCESS_DENIED')(e);
    assert.match(e.message, /HTTP 403/);
    assert.match(e.message, /根目录与访问权限/);
    return true;
  });
});

test('redirect queries, unsafe paths and loops stop before forwarding credentials', async t => {
  for (const location of ['/dav/?token=fixture-secret', '/dav/%2e%2e/private/', '/outside/', '/dav/']) {
    const f = await fixture(t, (_req, res) => res.writeHead(302, { Location: location }).end());
    await assert.rejects(listWebDav({ url: `${f.url}/dav/`, password: 'fixture-password' }), errorCode('WEBDAV_REDIRECT'));
    assert.ok(f.requests.length <= 4);
    assert.ok(f.requests.every(request => !request.url.includes('fixture-secret')));
  }
});

test('response budget rejects both declared and streamed oversized directories', async t => {
  const oversized = ' '.repeat(1024 * 1024 + 1);
  const declared = await serveXml(t, oversized, { 'Content-Length': Buffer.byteLength(oversized) });
  await assert.rejects(listWebDav({ url: `${declared.url}/dav/` }), errorCode('WEBDAV_BUDGET_EXCEEDED'));
  const streamed = await fixture(t, (_req, res) => {
    res.writeHead(207);
    res.write(oversized.slice(0, 700_000));
    res.end(oversized.slice(700_000));
  });
  await assert.rejects(listWebDav({ url: `${streamed.url}/dav/` }), errorCode('WEBDAV_BUDGET_EXCEEDED'));
});

test('DTD, unknown entities, malformed XML and invalid UTF-8 are rejected', async t => {
  const invalid = [
    '<!DOCTYPE D:multistatus [<!ENTITY x "expansion">]>' + xml(response('/dav/&x;.mkv')),
    xml(response('/dav/&undeclared;.mkv')),
    xml(response('/dav/&#0;.mkv')),
    xml(response('/dav/movie.mkv')).replace('</D:href>', '</D:other>'),
    xml(response('/dav/movie.mkv')).slice(0, -1),
    '<D:multistatus xmlns:D="DAV:"><D:response></D:multistatus>',
    '<D:multistatus xmlns:D="DAV:"/><D:multistatus xmlns:D="DAV:"/>',
    '<D:multistatus xmlns:D="DAV:" duplicate="a" duplicate="b"/>',
    '<D:multistatus xmlns:D="DAV:"><X:response/></D:multistatus>',
    '<D:multistatus\u00a0xmlns:D="DAV:"/>',
    '<!--invalid---><D:multistatus xmlns:D="DAV:"/>',
    '<D:multistatus xmlns:D="DAV:"/>\u00a0',
    Buffer.from([0x3c, 0xff, 0x3e]),
  ];
  for (const body of invalid) {
    const f = await serveXml(t, body);
    await assert.rejects(listWebDav({ url: `${f.url}/dav/` }), errorCode('WEBDAV_XML_INVALID'));
  }
});

test('namespace confusion cannot mark a foreign collection element as a directory', async t => {
  const body = '<D:multistatus xmlns:D="DAV:" xmlns:X="urn:other"><D:response><D:href>/dav/movie.mkv</D:href><D:propstat><D:prop><D:resourcetype><X:collection/></D:resourcetype></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response></D:multistatus>';
  const f = await serveXml(t, body);
  assert.equal((await listWebDav({ url: `${f.url}/dav/` })).entries[0].isDirectory, false);
});

test('more than 1000 entries returns an explicit limit error rather than silently hiding files', async t => {
  const f = await serveXml(t, xml(Array.from({ length: 1001 }, (_, i) => response(`/dav/${i}.mkv`)).join('')));
  await assert.rejects(listWebDav({ url: `${f.url}/dav/` }), errorCode('WEBDAV_TOO_MANY_ENTRIES'));
});

test('caller cancellation aborts an unfinished directory request', async t => {
  const f = await fixture(t, () => {});
  const controller = new AbortController();
  const pending = listWebDav({ url: `${f.url}/dav/`, signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, errorCode('CANCELLED'));
});
