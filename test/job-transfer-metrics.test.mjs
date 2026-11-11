import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRemoteSource } from '../src/remote.mjs';
import { jobMetrics, jobTransferTelemetry, finishJobLease } from '../src/job-metrics.mjs';

test('sequential task leases retain settled telemetry exactly once without changing byte budgets', async t => {
  const data = Buffer.alloc(65536, 31);
  const server = http.createServer((req, res) => {
    const [, a, b] = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '') || [];
    const start = Number(a), end = Math.min(Number(b), data.length - 1);
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${data.length}`, 'Content-Length': end - start + 1, ETag: '"fixture-metric"' });
    res.end(data.subarray(start, end + 1));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const source = await createRemoteSource({ url: `http://127.0.0.1:${server.address().port}/fixture.mkv`, initialRanges: 'head' });
  const job = { params: { budgetBytes: 8192 }, metrics: { receivedBytes: 0, requests: 0 } };
  for (let n = 0; n < 2; n++) {
    const original = source.createLease({ budgetBytes: 8192 - jobMetrics(job).receivedBytes });
    const lease = { ...original, async release() { original.close(); await original.settle(); } };
    job.lease = lease;
    await lease.read(20000 + n * 4096, 4096);
    assert.equal(jobTransferTelemetry(job).requestsStarted, n + 1);
    await finishJobLease(job, lease);
    const settled = jobTransferTelemetry(job);
    assert.equal(settled.requestsStarted, n + 1);
    assert.equal(settled.requestsCompleted, n + 1);
    assert.equal(settled.requestsFailed, 0);
    assert.equal(settled.activeRequests, 0);
    assert.equal(settled.currentBytesPerSecond, null);
    await finishJobLease(job, lease);
    assert.deepEqual(jobTransferTelemetry(job), settled, 'releasing an old lease twice must not duplicate measurements');
  }
  assert.equal(jobMetrics(job).receivedBytes, 8192);
  assert.equal(jobMetrics(job).budgetBytes, 8192);
  assert.equal(jobMetrics(job).requests, 2);
  assert.equal(source.metrics.requests, 1, 'source checks are not silently merged into task metrics');
});

test('local and legacy jobs do not invent transfer measurements', () => {
  assert.equal(jobTransferTelemetry({}), null);
  assert.equal(jobTransferTelemetry({ metrics: { receivedBytes: 1000 } }), null);
});
