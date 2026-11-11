import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRemoteSource } from '../src/remote.mjs';

test('browser source headers survive bootstrap, identity checks and media reads without exposing API credentials', async t => {
  const bytes = Buffer.alloc(65536, 71), calls = [];
  const server = http.createServer((req, res) => {
    calls.push(req.headers);
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    const start = Number(match?.[1]), end = Math.min(Number(match?.[2]), bytes.length-1);
    res.writeHead(206, { 'Content-Length': end-start+1, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, ETag: '"context"' });
    res.end(bytes.subarray(start, end+1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const source = await createRemoteSource({ url: `http://127.0.0.1:${server.address().port}/file`, initialRanges: 'head',
    requestHeaders: { 'User-Agent': 'BrowserContext/1', Referer: 'https://pan.baidu.com/' } });
  await source.check();
  const lease = source.createLease({ budgetBytes: bytes.length });
  assert.deepEqual(await lease.read(20000, 2048), bytes.subarray(20000, 22048));
  lease.close(); await lease.settle();
  assert.equal(calls.length, 3);
  for (const headers of calls) {
    assert.equal(headers['user-agent'], 'BrowserContext/1'); assert.equal(headers.referer, 'https://pan.baidu.com/');
    assert.equal(headers.authorization, undefined); assert.equal(headers.cookie, undefined);
    assert.equal(headers['accept-encoding'], 'identity');
  }
});

test('new source header options and public-only policy reject ambiguous or private inputs before dispatch', async () => {
  for (const requestHeaders of [{ Cookie: 'secret' }, { Authorization: 'secret' }, { 'User-Agent': 'bad\r\nX: 1' },
    { 'User-Agent': 'one', 'user-agent': 'two' }]) {
    await assert.rejects(createRemoteSource({ url: 'https://media.example.com/file', requestHeaders }), { code: 'SOURCE_HEADERS_INVALID' });
  }
  for (const url of ['http://media.example.com/file', 'https://127.0.0.1/file', 'https://0x7f000001/file',
    'https://169.254.169.254/file', 'https://[::ffff:127.0.0.1]/file', 'https://localhost/file']) {
    await assert.rejects(createRemoteSource({ url, networkPolicy: 'public-https' }), { code: 'UNSAFE_URL' });
  }
});
