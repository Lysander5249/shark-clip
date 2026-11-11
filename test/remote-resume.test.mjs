import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRemoteSource } from '../src/remote.mjs';

async function fixture(t) {
  let etag = '"verified-v1"', requests = 0;
  const bytes = Buffer.alloc(32768, 42);
  const server = http.createServer((req, res) => {
    requests++;
    const [, left, right] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range);
    const start = Number(left), end = Math.min(Number(right), bytes.length - 1);
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1,
      ...(etag ? { ETag: etag } : {}) });
    res.end(bytes.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { url: `http://127.0.0.1:${server.address().port}/file.mkv`, get requests() { return requests; }, set etag(value) { etag = value; } };
}

test('persistent reads reject a missing or changed strong validator before accepting bytes', async t => {
  for (const changed of [null, 'W/"verified-v1"', '"other-v2"']) {
    const upstream = await fixture(t);
    const source = await createRemoteSource({ url: upstream.url, initialRanges: 'head' });
    assert.equal(source.resumeIdentity.size, 32768);
    assert.match(source.resumeIdentity.headSha256, /^[a-f0-9]{64}$/);
    const calls = [];
    const lease = source.createLease({ budgetBytes: 4096, requireStrongValidator: true,
      accounting: { async reserve(bytes) { assert.equal(upstream.requests, 1); calls.push(['reserve', bytes]); return 'ticket'; },
        async settle(ticket, received) { calls.push(['settle', ticket, received]); } } });
    upstream.etag = changed;
    await assert.rejects(lease.read(16384, 1024), { code: 'SOURCE_CHANGED' });
    await lease.settle();
    assert.deepEqual(calls, [['reserve', 1024], ['settle', 'ticket', 0]]);
    assert.equal(lease.metrics.receivedBytes, 0);
  }
});

test('a durable reservation failure stops before dispatch and cannot silently fall back to untracked reads', async t => {
  const upstream = await fixture(t), source = await createRemoteSource({ url: upstream.url, initialRanges: 'head' });
  let settled = false;
  const lease = source.createLease({ budgetBytes: 4096, requireStrongValidator: true,
    accounting: { async reserve() { throw Object.assign(new Error('Disk unavailable'), { code: 'RESUME_WRITE_FAILED' }); },
      async settle() { settled = true; } } });
  await assert.rejects(lease.read(16384, 1024), { code: 'RESUME_WRITE_FAILED' });
  await lease.settle();
  assert.equal(upstream.requests, 1); assert.equal(lease.metrics.requests, 0);
  assert.equal(lease.metrics.reservedBytes, 0); assert.equal(settled, false);
});
