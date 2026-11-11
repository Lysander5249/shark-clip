import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { createRemoteSource, RemoteError } from '../src/remote.mjs';

const FIXTURE_BYTES = Buffer.from(Array.from({ length: 96 * 1024 }, (_, i) => i % 251));
const SOURCE_BUDGET = 256 * 1024;
const TEST_OPTIONS = { timeout: 10_000 };

async function startServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function createFixture(t, options = {}) {
  const bytes = options.bytes ?? FIXTURE_BYTES;
  const state = { etag: '"fixture-v1"', mode: options.mode ?? 'valid' };
  const requests = [];
  const origin = await startServer(t, (req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      range: req.headers.range,
      authorization: req.headers.authorization,
    });
    if (options.expectedAuthorization && req.headers.authorization !== options.expectedAuthorization) {
      res.writeHead(401).end('fixture authentication required');
      return;
    }
    if (options.redirectTo) {
      res.writeHead(302, { Location: options.redirectTo }).end();
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
    if (!match) {
      res.writeHead(400).end('fixture requires a single byte range');
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(match[2] ? Number(match[2]) : bytes.length - 1, bytes.length - 1);
    if (start >= bytes.length || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${bytes.length}` }).end();
      return;
    }
    const mode = options.failOnStart === undefined || options.failOnStart === start ? state.mode : 'valid';
    if (mode === 'ignore-range') {
      res.writeHead(200, { 'Content-Length': bytes.length, ETag: state.etag }).end(bytes);
      return;
    }
    const expectedLength = end - start + 1;
    const body = ['short-body', 'truncated-body'].includes(mode)
      ? bytes.subarray(start, start + Math.max(0, expectedLength - 7))
      : bytes.subarray(start, end + 1);
    const rangeStart = mode === 'wrong-range' ? start + 1 : start;
    res.writeHead(206, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': mode === 'truncated-body' ? expectedLength : body.length,
      'Content-Range': `bytes ${rangeStart}-${end}/${bytes.length}`,
      'Accept-Ranges': 'bytes',
      ...(mode === 'truncated-body' ? { Connection: 'close' } : {}),
      ETag: state.etag,
      ...options.responseHeaders,
    });
    if (['disconnected-body', 'stalled-body'].includes(mode)) {
      res.flushHeaders();
      res.write(body.subarray(0, Math.min(128, Math.max(0, expectedLength - 7))), () => {
        if (mode === 'disconnected-body') setTimeout(() => res.destroy(), 20);
      });
      return;
    }
    if (mode === 'slow-body') {
      // Keep sending so the upstream socket remains healthy, while completing
      // a large validated slice takes much longer than a small validated one.
      let sent = 0;
      const timer = setInterval(() => {
        const end = Math.min(body.length, sent + 8192);
        res.write(body.subarray(sent, end)); sent = end;
        if (sent === body.length) { clearInterval(timer); res.end(); }
      }, 20);
      res.once('close', () => clearInterval(timer));
      return;
    }
    res.end(body);
  });
  return { ...origin, bytes, requests, state };
}

function isRemoteError(code) {
  return error => {
    assert.ok(error instanceof RemoteError, `expected RemoteError, received ${error?.constructor?.name}`);
    assert.equal(error.code, code);
    return true;
  };
}

async function sourceFor(fixture, extra = {}) {
  return createRemoteSource({ url: `${fixture.url}/movie.mkv`, budgetBytes: SOURCE_BUDGET, ...extra });
}

async function serveLease(t, session, options = {}) {
  const lease = session.createLease({ budgetBytes: SOURCE_BUDGET, ...options });
  t.after(() => lease.close());
  const gateway = await startServer(t, (req, res) => {
    // serve() owns its error response; rejecting is a contract violation and must not hang the test.
    Promise.resolve(lease.serve(req, res)).catch(error => {
      if (!res.headersSent) res.writeHead(500);
      res.end(String(error));
    });
  });
  return { lease, inputUrl: `${gateway.url}/input` };
}

test('serve chunk bounds are validated without requests and do not change direct index reads', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t);
  const session = await sourceFor(fixture, { initialRanges: 'head' });
  const before = fixture.requests.length;
  for (const serveChunkBytes of [null, 0, 1023, 1024 * 1024 + 1, 1.5, Infinity, '65536']) {
    assert.throws(() => session.createLease({ serveChunkBytes }), isRemoteError('SERVE_CHUNK_INVALID'));
  }
  assert.equal(fixture.requests.length, before, 'invalid chunk settings must not dispatch reads');
  const maximum = session.createLease({ serveChunkBytes: 1024 * 1024 });
  await maximum.settle();
  const lease = session.createLease({ serveChunkBytes: 1024, budgetBytes: SOURCE_BUDGET });
  t.after(() => lease.settle());
  assert.deepEqual(await lease.read(0, fixture.bytes.length), fixture.bytes);
  assert.equal(lease.metrics.requests, 1, 'direct index reads retain their independent 1 MiB chunking');
  assert.equal(fixture.requests.at(-1).range, `bytes=0-${fixture.bytes.length - 1}`);
});

test('64 KiB serving releases a validated first payload before a continuously arriving 1 MiB slice completes', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t, { bytes: Buffer.alloc(2 * 1024 * 1024, 7) });
  const session = await sourceFor(fixture, { initialRanges: 'head', requestTimeoutMs: 1000 });
  fixture.state.mode = 'slow-body';
  const large = await serveLease(t, session, { budgetBytes: 2 * 1024 * 1024 });
  const small = await serveLease(t, session, { budgetBytes: 2 * 1024 * 1024, serveChunkBytes: 65536 });
  const largeAbort = new AbortController(), smallAbort = new AbortController();
  let largeHeaders = false, reader;
  const largeRead = fetch(large.inputUrl, { signal: largeAbort.signal, headers: { Range: 'bytes=0-1048575' } })
    .then(async response => { largeHeaders = true; return response.arrayBuffer(); }).catch(error => ({ error }));
  try {
    for (let i = 0; i < 200 && large.lease.metrics.receivedBytes < 8192; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert(large.lease.metrics.receivedBytes >= 8192, 'the comparison request must already be receiving a continuous response');
    const response = await fetch(small.inputUrl, { signal: smallAbort.signal, headers: { Range: 'bytes=0-1048575' } });
    assert.equal(response.status, 206);
    reader = response.body.getReader();
    const first = await reader.read();
    assert(first.value?.length > 0);
    assert(Buffer.from(first.value).equals(fixture.bytes.subarray(0, first.value.length)));
    assert(small.lease.metrics.receivedBytes >= 65536, 'the small slice must be fully validated before downstream bytes are released');
    assert(large.lease.metrics.receivedBytes < 1024 * 1024, 'the slow continuous 1 MiB response must still be incomplete');
    assert.equal(largeHeaders, false, 'the default large slice must not release headers or partial data before validation');
    assert(fixture.requests.some(request => request.range === 'bytes=0-65535'));
    assert(fixture.requests.some(request => request.range === 'bytes=0-1048575'));
  } finally {
    largeAbort.abort(); smallAbort.abort();
    await reader?.cancel().catch(() => {});
    await Promise.all([large.lease.settle(), small.lease.settle(), largeRead]);
  }
});

test('small serving slices never forward incomplete data and preserve a real upstream timeout diagnostic', TEST_OPTIONS, async t => {
  for (const [mode, code, received] of [['wrong-range', 'RANGE_INVALID', 0], ['truncated-body', 'RANGE_INVALID', 65529], ['stalled-body', 'TIMEOUT', 128]]) {
    await t.test(mode, async t => {
      const fixture = await createFixture(t, { bytes: Buffer.alloc(2 * 1024 * 1024, 7) });
      const session = await sourceFor(fixture, { initialRanges: 'head', requestTimeoutMs: 75 });
      fixture.state.mode = mode;
      const { lease, inputUrl } = await serveLease(t, session, { serveChunkBytes: 65536 });
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2000);
      let response, text;
      try {
        response = await fetch(inputUrl, { signal: controller.signal, headers: { Range: 'bytes=0-1048575' } });
        text = await response.text();
      } finally { clearTimeout(timer); }
      assert.equal(controller.signal.aborted, false, 'the upstream failure must reach the client before client cancellation');
      assert.equal(response.status, 502, 'no unverified media payload may have been forwarded with a 206 status');
      assert.match(text, /媒体读取失败/);
      assert.equal(lease.error?.code, code);
      assert.equal(lease.error.diagnostic.phase, 'media');
      assert.equal(lease.error.diagnostic.offset, 0);
      assert.equal(lease.error.diagnostic.expectedBytes, 65536);
      assert.equal(lease.error.diagnostic.receivedBytes, received);
      assert.equal(lease.error.diagnostic.timedOut, mode === 'stalled-body');
      assert.equal(lease.metrics.receivedBytes, received);
      assert.equal(lease.metrics.reservedBytes, 0);
      assert.equal(lease.metrics.requests, 1);
    });
  }
});

test('small serving slices retain an exact aggregate budget across slice boundaries', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t);
  const session = await sourceFor(fixture, { initialRanges: 'head' });
  const { lease, inputUrl } = await serveLease(t, session, { budgetBytes: 70000, serveChunkBytes: 65536 });
  let bodyFailed = false;
  try {
    const response = await fetch(inputUrl, { headers: { Range: `bytes=0-${fixture.bytes.length - 1}` } });
    await response.arrayBuffer();
  } catch { bodyFailed = true; }
  assert(bodyFailed, 'an oversized downstream response must not appear complete');
  await lease.settle();
  assert.equal(lease.error?.code, 'BUDGET_EXCEEDED');
  assert.equal(lease.error.diagnostic.offset, 70000);
  assert.equal(lease.metrics.receivedBytes, 70000);
  assert.equal(lease.metrics.reservedBytes, 0);
  assert.equal(lease.metrics.requests, 2);
  assert.deepEqual(fixture.requests.slice(1).map(request => request.range), ['bytes=0-65535', 'bytes=65536-69999']);
});

test('valid remote source probes separated ranges and serves the exact requested bytes', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t);
  const session = await sourceFor(fixture);
  assert.equal(session.size, fixture.bytes.length);
  assert.ok(session.id);
  assert.ok(session.label);
  assert.equal(session.initialRanges, 'separated');
  assert.equal(session.metrics.upstreamBytes, null);
  assert.ok(session.metrics.receivedBytes > 0);
  assert.ok(session.metrics.receivedBytes <= SOURCE_BUDGET);
  assert.ok(fixture.requests.length >= 3, 'source creation must verify head, middle and tail');
  const probeStarts = fixture.requests.map(request => Number(/^bytes=(\d+)-/.exec(request.range)?.[1]));
  assert.equal(Math.min(...probeStarts), 0);
  assert.ok(probeStarts.some(start => start > 0 && start <= fixture.bytes.length / 2));
  assert.ok(probeStarts.some(start => start > fixture.bytes.length / 2));

  const { lease, inputUrl } = await serveLease(t, session);
  const response = await fetch(inputUrl, { headers: { Range: 'bytes=4096-8191' } });
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('content-range'), `bytes 4096-8191/${fixture.bytes.length}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture.bytes.subarray(4096, 8192));
  assert.equal(lease.metrics.receivedBytes, 4096);
  assert.equal(lease.metrics.upstreamBytes, null);
  assert.ok(lease.metrics.requests >= 1);
  assert.ok(!lease.error);
  for (const request of fixture.requests) {
    const match = /^bytes=(\d+)-(\d+)$/.exec(request.range ?? '');
    assert.ok(match, 'all upstream reads must use a bounded Range');
    assert.ok(Number(match[2]) - Number(match[1]) + 1 <= 1024 * 1024);
  }
});

test('the initial range mode rejects invalid values before any upstream request', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t);
  for (const initialRanges of [null, '', 'all', 'HEAD', true, 1, ['head'], {}]) {
    await assert.rejects(sourceFor(fixture, { initialRanges }), isRemoteError('INITIAL_RANGES_INVALID'));
  }
  assert.equal(fixture.requests.length, 0);
});

test('head-only bootstrap and an independently needed range work despite an unrelated midpoint timeout', TEST_OPTIONS, async t => {
  const midpoint = FIXTURE_BYTES.length / 2;
  const fixture = await createFixture(t, { mode: 'stalled-body', failOnStart: midpoint });
  const session = await sourceFor(fixture, { initialRanges: 'head', requestTimeoutMs: 75 });
  assert.equal(session.initialRanges, 'head');
  assert.equal(session.metrics.receivedBytes, 16384);
  assert.equal(session.metrics.requests, 1);
  assert.deepEqual(fixture.requests.map(request => request.range), ['bytes=0-16383']);
  const lease = session.createLease({ budgetBytes: 8192 });
  t.after(() => lease.settle());
  const target = FIXTURE_BYTES.length - 8192;
  assert.deepEqual(await lease.read(target, 4096), FIXTURE_BYTES.subarray(target, target + 4096));
  assert.equal(lease.metrics.receivedBytes, 4096);
  assert.equal(lease.metrics.reservedBytes, 0);
  assert.equal(lease.metrics.requests, 1);
  assert.equal(lease.error, null);
  assert.equal(await session.check(), true, 'the original head fingerprint remains independently recheckable');
  assert(!fixture.requests.some(request => request.range.startsWith(`bytes=${midpoint}-`)), 'bootstrap must not require the unrelated midpoint');

  // The diagnostic/default path still tests that midpoint and reports its actual
  // failure; the new option does not remove the existing explicit diagnostics.
  await assert.rejects(sourceFor(fixture, { initialRanges: 'separated', requestTimeoutMs: 75 }), error => {
    assert(isRemoteError('TIMEOUT')(error));
    assert.equal(error.diagnostic.phase, 'middle');
    assert.equal(error.diagnostic.offset, midpoint);
    assert.equal(error.diagnostic.receivedBytes, 128);
    return true;
  });
});

test('head-only sources reject and account for bad responses at the actually requested media position', TEST_OPTIONS, async t => {
  const midpoint = FIXTURE_BYTES.length / 2;
  const cases = [
    ['ignore-range', 'RANGE_UNSUPPORTED', 0],
    ['wrong-range', 'RANGE_INVALID', 0],
    ['short-body', 'RANGE_INVALID', 0],
    ['truncated-body', 'RANGE_INVALID', 4089],
    ['disconnected-body', 'RANGE_INVALID', 128],
    ['stalled-body', 'TIMEOUT', 128],
  ];
  for (const [mode, code, received] of cases) await t.test(mode, async t => {
    const fixture = await createFixture(t, { mode, failOnStart: midpoint });
    const session = await sourceFor(fixture, { initialRanges: 'head', requestTimeoutMs: 75 });
    const lease = session.createLease({ budgetBytes: 8192 });
    t.after(() => lease.settle());
    await assert.rejects(lease.read(midpoint, 4096), error => {
      assert(isRemoteError(code)(error));
      assert.equal(lease.error, error);
      assert.equal(error.diagnostic.phase, 'media');
      assert.equal(error.diagnostic.offset, midpoint);
      assert.equal(error.diagnostic.expectedBytes, 4096);
      assert.equal(error.diagnostic.receivedBytes, received);
      assert.equal(error.diagnostic.timedOut, code === 'TIMEOUT');
      return true;
    });
    assert.equal(lease.metrics.receivedBytes, received, 'only body bytes actually received may be counted');
    assert.equal(lease.metrics.requests, 1);
    assert.equal(lease.metrics.reservedBytes, 0, 'failed reads must release their reservation');
    assert.equal(fixture.requests.length, 2, 'the failed media range is not automatically retried');
    await lease.settle();
    const stable = structuredClone(lease.metrics);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.deepEqual(lease.metrics, stable);
  });
});

test('head-only sources still require matching size, validators, and uncompressed actual range responses', TEST_OPTIONS, async t => {
  const midpoint = FIXTURE_BYTES.length / 2;
  for (const kind of ['size', 'etag', 'encoding']) await t.test(kind, async t => {
    const responseHeaders = {};
    const fixture = await createFixture(t, { responseHeaders });
    const session = await sourceFor(fixture, { initialRanges: 'head' });
    if (kind === 'size') responseHeaders['Content-Range'] = `bytes ${midpoint}-${midpoint + 4095}/${FIXTURE_BYTES.length + 1}`;
    if (kind === 'etag') fixture.state.etag = '"fixture-v2"';
    if (kind === 'encoding') responseHeaders['Content-Encoding'] = 'gzip';
    const lease = session.createLease({ budgetBytes: 8192 });
    t.after(() => lease.settle());
    await assert.rejects(lease.read(midpoint, 4096), isRemoteError(kind === 'encoding' ? 'RANGE_INVALID' : 'SOURCE_CHANGED'));
    assert.equal(lease.metrics.receivedBytes, 0, 'invalid response headers must prevent accepting the body');
    assert.equal(lease.metrics.reservedBytes, 0);
    assert.equal(lease.metrics.requests, 1);
    assert.equal(fixture.requests.length, 2);
  });
});

test('head-only source and direct media reads retain strict budgets and cancellation settlement', TEST_OPTIONS, async t => {
  const midpoint = FIXTURE_BYTES.length / 2;
  const fixture = await createFixture(t, { mode: 'stalled-body', failOnStart: midpoint });
  await assert.rejects(sourceFor(fixture, { initialRanges: 'head', budgetBytes: 16383 }), isRemoteError('BUDGET_EXCEEDED'));
  assert.equal(fixture.requests.length, 0);
  const session = await sourceFor(fixture, { initialRanges: 'head', budgetBytes: 16384 });
  assert.equal(session.metrics.receivedBytes, 16384);
  const tooSmall = session.createLease({ budgetBytes: 1024 });
  await assert.rejects(tooSmall.read(midpoint, 4096), isRemoteError('BUDGET_EXCEEDED'));
  await tooSmall.settle();
  assert.equal(tooSmall.metrics.requests, 0);
  assert.equal(tooSmall.metrics.receivedBytes, 0);
  assert.equal(tooSmall.metrics.reservedBytes, 0);
  assert.equal(fixture.requests.length, 1, 'an over-budget read must never be dispatched');

  const controller = new AbortController();
  const lease = session.createLease({ budgetBytes: 8192, signal: controller.signal });
  t.after(() => lease.settle());
  const reading = lease.read(midpoint, 4096).then(data => ({ data }), error => ({ error }));
  for (let count = 0; count < 200 && lease.metrics.receivedBytes < 128; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(lease.metrics.receivedBytes, 128, 'cancellation fixture must first deliver a real partial body');
  controller.abort();
  await lease.settle();
  const result = await reading;
  assert(result.error instanceof RemoteError);
  assert.equal(result.error.code, 'CANCELLED');
  assert.equal(result.error.diagnostic.receivedBytes, 128);
  assert.equal(lease.metrics.reservedBytes, 0);
  const stable = structuredClone(lease.metrics), requests = fixture.requests.length;
  await assert.rejects(lease.read(0, 128), isRemoteError('CANCELLED'));
  await lease.settle();
  assert.deepEqual(lease.metrics, stable, 'settled cancelled reads must not change counters');
  assert.equal(fixture.requests.length, requests, 'a cancelled lease must not dispatch later reads');
});

test('positioning reports dispatched request starts and nonsequential transitions independently per lease', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t);
  const session = await sourceFor(fixture);
  const sourcePositioning = {
    firstOffset: 0, lastOffset: FIXTURE_BYTES.length - 16384,
    maxOffset: FIXTURE_BYTES.length - 16384, seekCount: 2,
  };
  assert.deepEqual(session.metrics.positioning, sourcePositioning);
  const first = await serveLease(t, session);
  const second = await serveLease(t, session);
  const empty = { firstOffset: null, lastOffset: null, maxOffset: null, seekCount: 0 };
  assert.deepEqual(first.lease.metrics.positioning, empty);
  assert.deepEqual(second.lease.metrics.positioning, empty);
  const read = async (gateway, start, end, method = 'GET') => {
    const response = await fetch(gateway.inputUrl, { method, headers: { Range: `bytes=${start}-${end}` } });
    assert.equal(response.status, 206);
    await response.arrayBuffer();
  };
  await read(first, 4096, 8191, 'HEAD');
  assert.deepEqual(first.lease.metrics.positioning, empty, 'HEAD does not dispatch an upstream slice');
  await read(first, 4096, 8191);
  await read(first, 8192, 9215);
  assert.deepEqual(first.lease.metrics.positioning, { firstOffset: 4096, lastOffset: 8192, maxOffset: 8192, seekCount: 0 });
  await read(first, 0, 127);
  await read(first, 65536, 66559);
  await read(first, 66560, 67583);
  assert.deepEqual(first.lease.metrics.positioning, { firstOffset: 4096, lastOffset: 66560, maxOffset: 66560, seekCount: 2 });
  assert.deepEqual(second.lease.metrics.positioning, empty, 'another lease must not inherit read offsets');
  await read(second, 70000, 70127);
  await read(second, 1000, 1127);
  assert.deepEqual(second.lease.metrics.positioning, { firstOffset: 70000, lastOffset: 1000, maxOffset: 70000, seekCount: 1 });
  assert.deepEqual(session.metrics.positioning, sourcePositioning, 'lease reads must not alter source-check positioning');
});

test('positioning contains only numeric offsets and counters, without source or authentication details', TEST_OPTIONS, async t => {
  const username = 'private-position-user', password = 'private-position-password';
  const token = 'private-position-token', filename = 'private-position-source.mkv';
  const headerSecret = 'private-position-header';
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const fixture = await createFixture(t, { expectedAuthorization: authorization, responseHeaders: { 'X-Private-Fixture': headerSecret } });
  const url = `${fixture.url}/${filename}?token=${token}`;
  const session = await sourceFor(fixture, { url, username, password });
  const { lease, inputUrl } = await serveLease(t, session);
  const response = await fetch(inputUrl, { headers: { Range: 'bytes=4096-8191' } });
  assert.equal(response.status, 206);
  await response.arrayBuffer();
  for (const metrics of [session.metrics, lease.metrics]) {
    assert.deepEqual(Object.keys(metrics.positioning).sort(), ['firstOffset', 'lastOffset', 'maxOffset', 'seekCount'].sort());
    assert(Object.values(metrics.positioning).every(value => value === null || Number.isSafeInteger(value) && value >= 0));
    const serialized = JSON.stringify(metrics);
    for (const secret of [username, password, token, filename, headerSecret, authorization, fixture.url, url]) {
      assert(!serialized.includes(secret), `positioning metrics leaked ${secret}`);
    }
  }
});

test('settling an interrupted lease waits for in-flight reads and freezes counters against later requests', TEST_OPTIONS, async t => {
  for (const externalAbort of [false, true]) {
    const fixture = await createFixture(t, { mode: 'stalled-body', failOnStart: 4096 });
    const session = await sourceFor(fixture);
    const controller = new AbortController();
    const { lease, inputUrl } = await serveLease(t, session, { signal: controller.signal });
    const response = fetch(inputUrl, { headers: { Range: 'bytes=4096-8191' } }).then(
      async result => ({ status: result.status, body: await result.text() }),
      error => ({ error }),
    );
    for (let count = 0; lease.metrics.receivedBytes < 128 && count < 200; count++) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    assert.equal(lease.metrics.receivedBytes, 128, 'test must interrupt an upstream body after partial receipt');
    if (externalAbort) controller.abort();
    else { lease.close(); lease.close(); }
    await lease.settle();
    const stable = structuredClone(lease.metrics);
    const requests = fixture.requests.length;
    const interrupted = await response;
    assert(interrupted.status === 502 || interrupted.error, 'the incomplete read must not succeed');
    assert.equal(lease.error?.code, 'CANCELLED');
    const closed = await fetch(inputUrl, { headers: { Range: 'bytes=8192-12287' } });
    assert.equal(closed.status, 410);
    await closed.arrayBuffer();
    await lease.settle();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.deepEqual(lease.metrics, stable, 'settled metrics cannot grow after cancellation or new requests');
    assert.equal(fixture.requests.length, requests, 'a settled lease cannot dispatch new upstream reads');
  }
});

test('settle also releases a serve operation waiting for downstream backpressure', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t, { bytes: Buffer.alloc(2 * 1024 * 1024, 7) });
  const session = await sourceFor(fixture);
  const lease = session.createLease({ budgetBytes: 2 * 1024 * 1024 });
  t.after(() => lease.close());
  let written;
  const blocked = new Promise(resolve => { written = resolve; });
  const res = Object.assign(new EventEmitter(), { headersSent: false, destroyed: false, writableFinished: false });
  res.writeHead = () => { res.headersSent = true; return res; };
  res.write = () => { written(); return false; };
  res.end = () => { res.writableFinished = true; return res; };
  res.destroy = () => { res.destroyed = true; res.emit('close'); return res; };
  const serving = lease.serve({ method: 'GET', headers: { range: 'bytes=0-2097151' } }, res);
  await blocked;
  await lease.settle();
  await serving;
  assert.equal(res.writableFinished, true);
  assert.equal(lease.metrics.receivedBytes, 1024 * 1024);
  assert.equal(lease.metrics.requests, 1, 'settlement must not read the rest of the requested stream');
});

test('a source that ignores Range with HTTP 200 is rejected', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t, { mode: 'ignore-range' });
  await assert.rejects(sourceFor(fixture), isRemoteError('RANGE_UNSUPPORTED'));
  assert.equal(fixture.requests.length, 1, 'do not continue probing a whole-file-only endpoint');
});

test('an incorrect Content-Range is rejected before accepting source data', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t, { mode: 'wrong-range' });
  await assert.rejects(sourceFor(fixture), isRemoteError('RANGE_INVALID'));
});

test('a body shorter than its declared byte range is rejected', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t, { mode: 'short-body' });
  await assert.rejects(sourceFor(fixture), isRemoteError('RANGE_INVALID'));
});

test('a response truncated in transit is rejected even when its headers promise the correct length', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t, { mode: 'truncated-body' });
  await assert.rejects(sourceFor(fixture), isRemoteError('RANGE_INVALID'));
});

test('an interrupted response reports the failing initial phase and bounded byte counts', TEST_OPTIONS, async t => {
  for (const [phase, start] of [['head', 0], ['middle', FIXTURE_BYTES.length / 2], ['tail', FIXTURE_BYTES.length - 16384]]) {
    const fixture = await createFixture(t, { mode: 'disconnected-body', failOnStart: start });
    await assert.rejects(sourceFor(fixture), error => {
      assert.ok(isRemoteError('RANGE_INVALID')(error));
      assert.equal(error.diagnostic.phase, phase);
      assert.equal(error.diagnostic.offset, start);
      assert.equal(error.diagnostic.expectedBytes, 16384);
      assert.equal(error.diagnostic.receivedBytes, 128);
      assert.equal(error.diagnostic.timedOut, false);
      assert.ok(['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.diagnostic.transportCode));
      assert.ok(Number.isSafeInteger(error.diagnostic.elapsedMs));
      assert.ok(error.diagnostic.elapsedMs >= 0 && error.diagnostic.elapsedMs <= 86400000);
      assert.match(error.message, /上游连接中断/);
      assert.match(error.message, /128 \/ 16384 字节/);
      return true;
    });
    assert.equal(fixture.requests.length, { head: 1, middle: 2, tail: 3 }[phase], 'a failed range must not be retried');
  }
});

test('socket inactivity after response headers remains TIMEOUT rather than a range error', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t, { mode: 'stalled-body' });
  await assert.rejects(sourceFor(fixture, { requestTimeoutMs: 75 }), error => {
    assert.ok(isRemoteError('TIMEOUT')(error));
    assert.equal(error.diagnostic.phase, 'head');
    assert.equal(error.diagnostic.offset, 0);
    assert.equal(error.diagnostic.expectedBytes, 16384);
    assert.equal(error.diagnostic.receivedBytes, 128);
    assert.equal(error.diagnostic.timedOut, true);
    assert.match(error.message, /文件头检查.*空闲超时.*128 \/ 16384 字节/);
    return true;
  });
  assert.equal(fixture.requests.length, 1, 'a timed out range must not be retried');
});

test('range failure diagnostics never expose credentials, source names, URLs, headers or query tokens', TEST_OPTIONS, async t => {
  const username = 'private-fixture-user';
  const password = 'private-fixture-password';
  const token = 'private-fixture-query-token';
  const filename = 'private-fixture-source-name.mkv';
  const headerSecret = 'private-fixture-response-header';
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  const fixture = await createFixture(t, { mode: 'disconnected-body', expectedAuthorization: authorization, responseHeaders: { 'X-Fixture-Secret': headerSecret } });
  const url = `${fixture.url}/${filename}?token=${token}`;
  await assert.rejects(sourceFor(fixture, { url, username, password }), error => {
    assert.ok(isRemoteError('RANGE_INVALID')(error));
    assert.deepEqual(Object.keys(error.diagnostic).sort(), ['phase', 'offset', 'expectedBytes', 'receivedBytes', 'elapsedMs', 'timedOut', 'transportCode'].sort());
    assert.ok(Object.isFrozen(error.diagnostic));
    const serialized = `${JSON.stringify(error)} ${error.message} ${error.stack}`;
    for (const secret of [username, password, token, filename, headerSecret, authorization, fixture.url, url]) assert.ok(!serialized.includes(secret), `diagnostic leaked ${secret}`);
    return true;
  });
});

test('recheck and media reads retain their own diagnostic phase', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t);
  const session = await sourceFor(fixture);
  fixture.state.mode = 'disconnected-body';
  await assert.rejects(session.check(), error => {
    assert.ok(isRemoteError('RANGE_INVALID')(error));
    assert.equal(error.diagnostic.phase, 'recheck');
    assert.equal(error.diagnostic.expectedBytes, 128);
    assert.equal(error.diagnostic.receivedBytes, 121);
    return true;
  });
  const { lease, inputUrl } = await serveLease(t, session);
  const response = await fetch(inputUrl, { headers: { Range: 'bytes=4096-8191' } });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /媒体读取.*128 \/ 4096 字节/);
  assert.equal(lease.error?.code, 'RANGE_INVALID');
  assert.equal(lease.error?.diagnostic.phase, 'media');
  assert.equal(lease.error?.diagnostic.offset, 4096);
});

test('source probing respects its own byte budget', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t);
  await assert.rejects(sourceFor(fixture, { budgetBytes: 1024 }), isRemoteError('BUDGET_EXCEEDED'));
});

test('a lease budget stops an oversized read without accepting the complete range', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t);
  const session = await sourceFor(fixture);
  const { lease, inputUrl } = await serveLease(t, session, { budgetBytes: 1024 });
  let response;
  let body;
  let bodyError;
  try {
    response = await fetch(inputUrl, { headers: { Range: 'bytes=0-8191' } });
    body = await response.arrayBuffer();
  } catch (error) { bodyError = error; }
  assert.ok(response?.status === 502 || bodyError, 'failure must be explicit or truncate the downstream response');
  assert.ok(response?.status !== 206 || bodyError || body.byteLength < 8192);
  assert.equal(lease.error?.code, 'BUDGET_EXCEEDED');
  assert.ok(lease.metrics.receivedBytes <= 1024, 'a rejected read must not consume an unbounded body');
  assert.equal(lease.error.diagnostic.phase, 'media');
  assert.equal(lease.error.diagnostic.offset, 1024, 'budget exhaustion reports the next unread position');
  assert.equal(lease.error.diagnostic.expectedBytes, 0);
  assert.equal(lease.error.diagnostic.receivedBytes, 0);
  assert.equal(lease.error.diagnostic.timedOut, false);
  assert.deepEqual(lease.metrics.positioning, { firstOffset: 0, lastOffset: 0, maxOffset: 0, seekCount: 0 }, 'an undispatched read must not change positioning');
});

test('check rejects a changed ETag instead of reusing the old source identity', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t);
  const session = await sourceFor(fixture);
  fixture.state.etag = '"fixture-v2"';
  await assert.rejects(session.check(), isRemoteError('SOURCE_CHANGED'));
});

test('a changed source is not served as bytes of the old source', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t);
  const session = await sourceFor(fixture);
  const { lease, inputUrl } = await serveLease(t, session);
  fixture.state.etag = '"fixture-v2"';
  const response = await fetch(inputUrl, { headers: { Range: 'bytes=100-999' } });
  await response.arrayBuffer();
  assert.equal(response.status, 502);
  assert.equal(lease.error?.code, 'SOURCE_CHANGED');
});

test('cross-origin redirects do not forward Basic credentials or copy source query tokens', TEST_OPTIONS, async t => {
  const destination = await createFixture(t);
  const authorization = `Basic ${Buffer.from('fixture-user:fixture-password').toString('base64')}`;
  const fixture = await createFixture(t, {
    expectedAuthorization: authorization,
    redirectTo: `${destination.url}/redirected.mkv?destination=1`,
  });
  const session = await sourceFor(fixture, {
    url: `${fixture.url}/private.mkv?token=fixture-source-secret`,
    username: 'fixture-user',
    password: 'fixture-password',
  });
  assert.ok(fixture.requests.length > 0);
  assert.ok(fixture.requests.every(request => request.authorization === authorization));
  assert.ok(destination.requests.length > 0);
  assert.ok(destination.requests.every(request => request.authorization === undefined));
  assert.ok(destination.requests.every(request => !request.url.includes('fixture-source-secret')));

  const beforeExport = destination.requests.length;
  const { lease, inputUrl } = await serveLease(t, session);
  const response = await fetch(inputUrl, { headers: { Range: 'bytes=100-199' } });
  assert.equal(response.status, 206);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture.bytes.subarray(100, 200));
  assert.ok(destination.requests.length > beforeExport);
  assert.ok(destination.requests.every(request => request.authorization === undefined));
  assert.ok(!lease.error);
});

test('a downstream GET without Range still uses bounded upstream ranges', TEST_OPTIONS, async t => {
  const fixture = await createFixture(t);
  const session = await sourceFor(fixture);
  const beforeExport = fixture.requests.length;
  const { lease, inputUrl } = await serveLease(t, session);
  const response = await fetch(inputUrl);
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), fixture.bytes);
  assert.equal(lease.metrics.receivedBytes, fixture.bytes.length);
  for (const request of fixture.requests.slice(beforeExport)) {
    assert.match(request.range, /^bytes=\d+-\d+$/);
  }
});
