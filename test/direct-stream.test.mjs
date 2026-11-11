import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createDirectStream, checkedDirectUrl, directLookup, DirectStreamError } from '../src/direct-stream.mjs';
import { directTelemetry, directReadTimings } from '../src/direct-stream-telemetry.mjs';
import { jobTransferTelemetry, finishJobLease } from '../src/job-metrics.mjs';

const MiB = 1024 * 1024, WINDOW = 8 * MiB, ETAG = '"direct-fixture-v1"';
const DATA = Buffer.alloc(20 * MiB);
for (let i = 0; i < DATA.length; i++) DATA[i] = i % 251;
const OPTIONS = { timeout: 15000 };
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function serverFor(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function sourceFor(t, handler) {
  const requests = [];
  const source = await serverFor(t, (req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    assert(match, 'every physical upstream request is explicitly bounded');
    const start = Number(match[1]), end = Number(match[2]);
    assert(start >= 0 && end >= start && end < DATA.length && end - start + 1 <= WINDOW);
    const entry = { req, res, start, end, headers: req.headers };
    requests.push(entry);
    if (handler) handler(entry); else reply(entry);
  });
  return { ...source, requests };
}

function reply({ res, start, end }, overrides = {}) {
  res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${DATA.length}`,
    'Content-Length': end - start + 1, ETag: ETAG, ...overrides });
  res.end(DATA.subarray(start, end + 1));
}

async function gatewayFor(t, source, options = {}) {
  const lease = createDirectStream({ url: `${source.url}/synthetic.mkv`, size: DATA.length, etag: ETAG,
    budgetBytes: DATA.length, allowLoopbackHttp: true, requestTimeoutMs: 2000, ...options });
  t.after(() => lease.settle());
  const errors = [];
  const gateway = await serverFor(t, (req, res) => {
    Promise.resolve(lease.serve(req, res)).catch(error => { errors.push(error); res.destroy(); });
  });
  t.after(() => assert.deepEqual(errors, [], 'serve owns its response and never leaks rejections'));
  return { ...gateway, lease };
}

function request(url, range, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers: range === undefined ? {} : { Range: range } }, resolve);
    req.once('error', reject); req.end();
  });
}

async function body(response) {
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function lookupWith(records) {
  return directLookup({ lookup(_host, options, callback) { assert.equal(options.all, true); callback(null, records); } });
}

function resolveWith(lookup, hostname, options = {}) {
  return new Promise((resolve, reject) => lookup(hostname, options, (error, address, family) => {
    if (error) reject(error); else resolve({ address, family });
  }));
}

test('options require public HTTPS, a strong ETag, bounded windows and non-secret headers', () => {
  const base = { url: 'https://media.example/synthetic.mkv?secret=TEST_ONLY', size: 1000, etag: ETAG, budgetBytes: 1000 };
  for (const etag of [undefined, '', 'W/"weak"', 'unquoted', '"line\r\nbreak"']) {
    assert.throws(() => createDirectStream({ ...base, etag }), { code: 'STRONG_ETAG_REQUIRED' });
  }
  for (const options of [{ size: 0 }, { size: 1.1 }, { budgetBytes: 0 }, { windowBytes: WINDOW + 1 },
    { windowBytes: 0 }, { requestTimeoutMs: 0 }, { signal: {} }]) {
    assert.throws(() => createDirectStream({ ...base, ...options }), { code: 'OPTIONS_INVALID' });
  }
  for (const headers of [{ Cookie: 'synthetic-secret' }, { Authorization: 'synthetic-secret' },
    { Range: 'bytes=0-1' }, { 'User-Agent': 'bad\r\nheader' }, { Referer: 'http://pan.example/' },
    { 'User-Agent': 'one', 'user-agent': 'two' }]) {
    assert.throws(() => createDirectStream({ ...base, headers }), error => {
      assert(error instanceof DirectStreamError); assert.equal(error.code, 'HEADERS_INVALID');
      assert(!error.message.includes('synthetic-secret')); assert(!error.message.includes('TEST_ONLY')); return true;
    });
  }
  const lease = createDirectStream({ ...base, headers: { 'User-Agent': 'Synthetic Browser', Referer: 'https://pan.example/' } });
  assert.deepEqual(lease.metrics, { budgetBytes: 1000, receivedBytes: 0, reservedBytes: 0, requests: 0, upstreamBytes: null });
  lease.close();
});

test('URL and socket lookup reject private, mapped, mixed and special addresses without a network request', async () => {
  for (const value of ['http://media.example/file', 'https://user:pass@media.example/file', 'https://media.example/file#fragment',
    'https://localhost/file', 'https://127.1/file', 'https://2130706433/file', 'https://10.1.2.3/file',
    'https://100.64.0.1/file', 'https://169.254.169.254/file', 'https://172.31.0.1/file', 'https://192.168.1.1/file',
    'https://198.18.0.1/file', 'https://192.0.2.1/file', 'https://[::1]/file', 'https://[::ffff:127.0.0.1]/file',
    'https://[fe80::1]/file', 'https://[fd00::1]/file', 'https://[2002:7f00:1::]/file']) {
    assert.throws(() => checkedDirectUrl(value), { code: 'UNSAFE_URL' });
  }
  assert.equal(checkedDirectUrl('http://127.0.0.1:1234/file', { allowLoopbackHttp: true }).hostname, '127.0.0.1');
  assert.throws(() => checkedDirectUrl('http://127.0.0.2/file', { allowLoopbackHttp: true }), { code: 'UNSAFE_URL' });
  const good = [{ address: '8.8.8.8', family: 4 }, { address: '2001:4860:4860::8888', family: 6 }];
  assert.deepEqual(await resolveWith(lookupWith(good), 'media.example', { all: true }), { address: good, family: undefined });
  assert.deepEqual(await resolveWith(lookupWith(good), 'media.example', { family: 4 }), { address: '8.8.8.8', family: 4 });
  for (const records of [[], [{ address: '127.0.0.1', family: 4 }], [...good, { address: '10.1.2.3', family: 4 }],
    [{ address: '::ffff:10.1.2.3', family: 6 }]]) {
    await assert.rejects(resolveWith(lookupWith(records), 'media.example'), { code: 'UNSAFE_URL' });
  }
  await assert.rejects(resolveWith(directLookup({ allowLoopbackHttp: true }), 'localhost'), { code: 'UNSAFE_URL' });
});

test('a first payload reaches FFmpeg while the rest of its 8 MiB upstream window is still gated', OPTIONS, async t => {
  const gate = deferred(); let finished = false;
  const source = await sourceFor(t, ({ res, start, end }) => {
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${DATA.length}`, 'Content-Length': end - start + 1, ETag: ETAG });
    res.write(DATA.subarray(start, start + 16384));
    gate.promise.then(() => { finished = true; res.end(DATA.subarray(start + 16384, end + 1)); });
  });
  const { url, lease } = await gatewayFor(t, source);
  try {
    const response = await request(url, `bytes=0-${WINDOW - 1}`), iterator = response[Symbol.asyncIterator]();
    assert.equal(response.statusCode, 206);
    assert.equal(response.headers['content-range'], `bytes 0-${WINDOW - 1}/${DATA.length}`);
    const first = await iterator.next();
    assert(first.value.length > 0); assert.equal(finished, false);
    assert.equal(lease.metrics.receivedBytes, 16384);
    assert.equal(lease.metrics.receivedBytes + lease.metrics.reservedBytes, WINDOW);
    const live = jobTransferTelemetry({ lease });
    assert.equal(live.requestsStarted, 1); assert.equal(live.activeRequests, 1);
    assert.equal(live.requestsCompleted, 0); assert.equal(live.state, 'receiving');
    gate.resolve();
    const parts = [first.value];
    for (;;) { const value = await iterator.next(); if (value.done) break; parts.push(value.value); }
    assert.deepEqual(Buffer.concat(parts), DATA.subarray(0, WINDOW));
    await lease.settle(); assert.equal(lease.metrics.reservedBytes, 0); assert.equal(lease.error, null);
    const read = directReadTimings(lease.metrics).requests[0];
    assert.equal(read.outcome, 'completed'); assert.equal(read.httpStatus, 206); assert.equal(read.receivedBytes, WINDOW);
    assert.equal(read.headersVerified, true); assert.equal(read.transportCode, null);
    assert.equal(directTelemetry(lease.metrics).activeRequests, 0);
  } finally { gate.resolve(); }
});

test('16 MiB uses two streaming windows, preserves exact bytes and sends only approved headers', OPTIONS, async t => {
  const source = await sourceFor(t);
  const { url, lease } = await gatewayFor(t, source, { headers: { 'User-Agent': 'Synthetic-UA', Referer: 'https://pan.example/' }, budgetBytes: 16 * MiB });
  const response = await request(url, `bytes=33-${16 * MiB + 32}`);
  assert.equal(response.statusCode, 206); assert.equal(Number(response.headers['content-length']), 16 * MiB);
  assert.deepEqual(await body(response), DATA.subarray(33, 16 * MiB + 33));
  await lease.settle();
  assert.deepEqual(source.requests.map(({ start, end }) => [start, end]), [[33, WINDOW + 32], [WINDOW + 33, 16 * MiB + 32]]);
  assert.equal(lease.metrics.requests, 2); assert(lease.metrics.requests < 16, 'fewer requests than 1 MiB windowing');
  assert.equal(lease.metrics.receivedBytes, 16 * MiB); assert.equal(lease.metrics.reservedBytes, 0);
  assert.equal(directTelemetry(lease.metrics).requestsStarted, 2);
  assert.equal(directTelemetry(lease.metrics).requestsCompleted, 2);
  assert.equal(directReadTimings(lease.metrics).requests.reduce((n, record) => n + record.receivedBytes, 0), 16 * MiB);
  assert(source.requests.every(({ headers }) => headers['if-match'] === ETAG && headers['accept-encoding'] === 'identity'
    && headers['user-agent'] === 'Synthetic-UA' && headers.referer === 'https://pan.example/' && !headers.cookie && !headers.authorization));
  assert.equal(source.requests[0].req.socket, source.requests[1].req.socket, 'sequential windows reuse their upstream connection');
  const trackedLease = { ...lease, async release() { await lease.settle(); } };
  const job = { params: { budgetBytes: 16 * MiB }, lease: trackedLease };
  await finishJobLease(job, trackedLease);
  const saved = jobTransferTelemetry(job);
  assert.equal(saved.requestsStarted, 2); assert.equal(saved.readTimings.requests.length, 2);
  await finishJobLease(job, trackedLease);
  assert.deepEqual(jobTransferTelemetry(job), saved, 'settling direct telemetry twice does not count bytes or requests twice');
});

test('direct diagnostic HTTP status identifies rejected requests without retaining source secrets or retrying', OPTIONS, async t => {
  for (const [status, code] of [[401, 'AUTH_REQUIRED'], [403, 'AUTH_REQUIRED'], [503, 'REMOTE_HTTP']]) await t.test(String(status), async t => {
    const source = await sourceFor(t, ({ res }) => res.writeHead(status).end('private response body'));
    const { url, lease } = await gatewayFor(t, source, { headers: { Referer: 'https://pan.example/?private=TEST_SECRET' } });
    await body(await request(url, 'bytes=0-99')); await lease.settle();
    assert.equal(lease.error.code, code); assert.equal(source.requests.length, 1);
    const data = jobTransferTelemetry({ lease }), latest = data.readTimings.requests.at(-1);
    assert.equal(data.requestsFailed, 1); assert.equal(data.requestsCancelled, 0); assert.equal(data.activeRequests, 0);
    assert.equal(latest.httpStatus, status); assert.equal(latest.failureCode, code); assert.equal(latest.terminalStage, 'response_validation');
    assert.equal(latest.receivedBytes, 0); assert.equal(latest.headersVerified, false);
    assert.doesNotMatch(JSON.stringify(data), /https?:|TEST_SECRET|private response|"headers"|Referer/i);
  });
});

test('HEAD and malformed local ranges never dispatch upstream; open-ended seeks preserve full requested range', OPTIONS, async t => {
  const source = await sourceFor(t), { url, lease } = await gatewayFor(t, source, { budgetBytes: 257 });
  const head = await request(url, undefined, 'HEAD'); assert.equal(head.statusCode, 200); await body(head);
  assert.equal(Number(head.headers['content-length']), DATA.length);
  const headRange = await request(url, 'bytes=10-20', 'HEAD'); assert.equal(headRange.statusCode, 206); await body(headRange);
  for (const range of [undefined, 'bytes=-10', 'bytes=10-9', `bytes=0-${DATA.length}`, 'bytes=0-1,3-4', 'bytes=x-', 'bytes=9007199254740992-']) {
    const response = await request(url, range); assert.equal(response.statusCode, 416); await body(response);
  }
  const wrongMethod = await request(url, 'bytes=0-1', 'POST'); assert.equal(wrongMethod.statusCode, 405); await body(wrongMethod);
  assert.equal(source.requests.length, 0); assert.equal(lease.error, null);
  const response = await request(url, `bytes=${DATA.length - 257}-`);
  assert.equal(response.statusCode, 206);
  assert.equal(response.headers['content-range'], `bytes ${DATA.length - 257}-${DATA.length - 1}/${DATA.length}`);
  assert.deepEqual(await body(response), DATA.subarray(DATA.length - 257));
  await lease.settle(); assert.equal(lease.metrics.receivedBytes, 257);
});

test('all FFmpeg seeks, including duplicate byte ranges, consume one exact shared budget', OPTIONS, async t => {
  const source = await sourceFor(t), { url, lease } = await gatewayFor(t, source, { budgetBytes: 200 });
  for (let i = 0; i < 2; i++) assert.deepEqual(await body(await request(url, 'bytes=500-599')), DATA.subarray(500, 600));
  const refused = await request(url, 'bytes=1000-1000'); assert.equal(refused.statusCode, 502); await body(refused);
  await lease.settle();
  assert.equal(lease.error.code, 'BUDGET_EXCEEDED'); assert.equal(lease.metrics.receivedBytes, 200);
  assert.equal(lease.metrics.reservedBytes, 0); assert.equal(source.requests.length, 2);
});

test('two interleaved readers share remaining reservations; a third reader is refused without dispatch', OPTIONS, async t => {
  const ready = deferred(), held = [];
  const source = await sourceFor(t, entry => {
    held.push(entry);
    entry.res.writeHead(206, { 'Content-Range': `bytes ${entry.start}-${entry.end}/${DATA.length}`, 'Content-Length': 100, ETag: ETAG });
    entry.res.write(DATA.subarray(entry.start, entry.start + 20));
    if (held.length === 2) ready.resolve();
  });
  const { url, lease } = await gatewayFor(t, source, { budgetBytes: 200 });
  const clients = [request(url, 'bytes=0-99'), request(url, 'bytes=100-199')];
  await ready.promise;
  const responses = await Promise.all(clients), iterators = responses.map(response => response[Symbol.asyncIterator]());
  const first = await Promise.all(iterators.map(iterator => iterator.next()));
  assert.equal(lease.metrics.receivedBytes, 40); assert.equal(lease.metrics.reservedBytes, 160);
  const third = await request(url, 'bytes=1000-1000'); assert.equal(third.statusCode, 503); await body(third);
  assert.equal(source.requests.length, 2); assert.equal(lease.error, null);
  held.forEach(entry => entry.res.end(DATA.subarray(entry.start + 20, entry.end + 1)));
  for (let i = 0; i < iterators.length; i++) {
    const parts = [first[i].value];
    for (;;) { const next = await iterators[i].next(); if (next.done) break; parts.push(next.value); }
    assert.deepEqual(Buffer.concat(parts), DATA.subarray(i * 100, i * 100 + 100));
  }
  await lease.settle(); assert.equal(lease.metrics.receivedBytes, 200); assert.equal(lease.metrics.reservedBytes, 0);
});

test('normal FFmpeg early close immediately cancels the upstream window without a fatal lease error', OPTIONS, async t => {
  const closed = deferred();
  const source = await sourceFor(t, ({ res, start, end }) => {
    res.once('close', closed.resolve);
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${DATA.length}`, 'Content-Length': end - start + 1, ETag: ETAG });
    res.write(DATA.subarray(start, start + 65536));
  });
  const { url, lease } = await gatewayFor(t, source);
  const response = await request(url, 'bytes=0-'); await once(response, 'data'); response.destroy();
  await closed.promise; await lease.settle();
  assert.equal(source.requests.length, 1); assert.equal(lease.error, null); assert.equal(lease.metrics.reservedBytes, 0);
  const telemetry = directTelemetry(lease.metrics), record = directReadTimings(lease.metrics).requests[0];
  assert.equal(telemetry.requestsConsumerClosed, 1); assert.equal(telemetry.requestsCancelled, 1);
  assert.equal(record.failureCode, 'CANCELLED'); assert.equal(record.cancellationReason, 'consumer_closed');
  assert(lease.metrics.receivedBytes > 0 && lease.metrics.receivedBytes <= 65536);
  const afterClose = await request(url, 'bytes=0-1'); assert.equal(afterClose.statusCode, 410); await body(afterClose);
});

test('close and external cancellation settle requests waiting for headers and bodies', OPTIONS, async t => {
  for (const stage of ['headers', 'body']) await t.test(stage, async t => {
    const ready = deferred(), controller = new AbortController();
    const source = await sourceFor(t, ({ res, start, end }) => {
      if (stage === 'body') {
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${DATA.length}`, 'Content-Length': end - start + 1, ETag: ETAG });
        res.flushHeaders();
      }
      ready.resolve();
    });
    const { url, lease } = await gatewayFor(t, source, { signal: controller.signal });
    const client = request(url, 'bytes=0-99').then(body).catch(() => {});
    await ready.promise; controller.abort(); await lease.settle(); await client;
    assert.equal(lease.error, null); assert.equal(lease.metrics.receivedBytes, 0); assert.equal(lease.metrics.reservedBytes, 0);
    assert.equal(source.requests.length, 1);
    const record = directReadTimings(lease.metrics).requests[0];
    assert.equal(record.failureCode, 'CANCELLED'); assert.equal(record.cancellationReason, 'task_cancelled');
    assert.equal(directTelemetry(lease.metrics).activeRequests, 0);
  });
});

test('200, malformed 206, compression and changed validators fail before forwarding payload', OPTIONS, async t => {
  for (const [mode, code] of [['200', 'RANGE_UNSUPPORTED'], ['wrong-range', 'RANGE_INVALID'], ['wrong-size', 'RANGE_INVALID'],
    ['wrong-length', 'RANGE_INVALID'], ['chunked', 'RANGE_INVALID'], ['gzip', 'RANGE_INVALID'],
    ['missing-etag', 'SOURCE_CHANGED'], ['weak-etag', 'SOURCE_CHANGED'], ['changed-etag', 'SOURCE_CHANGED'], ['412', 'SOURCE_CHANGED']]) {
    await t.test(mode, async t => {
      const source = await sourceFor(t, ({ res, start, end }) => {
        if (mode === '200' || mode === '412') { res.writeHead(Number(mode)).end('synthetic'); return; }
        const headers = { 'Content-Range': `bytes ${mode === 'wrong-range' ? start + 1 : start}-${end}/${mode === 'wrong-size' ? DATA.length + 1 : DATA.length}`,
          'Content-Length': mode === 'wrong-length' ? end - start + 2 : end - start + 1,
          ETag: mode === 'weak-etag' ? 'W/' + ETAG : mode === 'changed-etag' ? '"direct-fixture-v2"' : ETAG };
        if (mode === 'missing-etag') delete headers.ETag;
        if (mode === 'gzip') headers['Content-Encoding'] = 'gzip';
        if (mode === 'chunked') { delete headers['Content-Length']; headers['Transfer-Encoding'] = 'chunked'; }
        res.writeHead(206, headers).end(DATA.subarray(start, end + 1));
      });
      const { url, lease } = await gatewayFor(t, source);
      const response = await request(url, 'bytes=100-199'); assert.equal(response.statusCode, 502);
      const message = (await body(response)).toString(); assert(!message.includes(source.url));
      await lease.settle();
      assert.equal(lease.error.code, code); assert.equal(lease.metrics.receivedBytes, 0); assert.equal(lease.metrics.reservedBytes, 0);
      assert.equal(source.requests.length, 1);
    });
  }
});

test('upstream disconnect fails safely, charges delivered bytes and never silently retries', OPTIONS, async t => {
  const held = deferred();
  const source = await sourceFor(t, entry => {
    entry.res.writeHead(206, { 'Content-Range': `bytes ${entry.start}-${entry.end}/${DATA.length}`, 'Content-Length': 100, ETag: ETAG });
    entry.res.write(DATA.subarray(entry.start, entry.start + 20)); held.resolve(entry);
  });
  const { url, lease } = await gatewayFor(t, source);
  const response = await request(url, 'bytes=0-99'), entry = await held.promise;
  const iterator = response[Symbol.asyncIterator](); const first = await iterator.next(); assert.equal(first.value.length, 20);
  entry.res.destroy(); await assert.rejects(iterator.next()); await lease.settle();
  assert.equal(lease.error.code, 'REMOTE_HTTP'); assert.equal(lease.metrics.receivedBytes, 20);
  assert.equal(lease.metrics.reservedBytes, 0); assert.equal(source.requests.length, 1);
  const record = directReadTimings(lease.metrics).requests[0];
  assert.equal(record.httpStatus, 206); assert.equal(record.failureCode, 'REMOTE_HTTP'); assert.equal(record.terminalStage, 'body');
  assert.equal(record.receivedBytes, 20); assert(['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE'].includes(record.transportCode));
});

test('an overlong fixed-length HTTP message cannot disappear after its headers promise resolves', OPTIONS, async t => {
  const source = await sourceFor(t, ({ res, start, end }) => {
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${DATA.length}`, 'Content-Length': end - start + 1, ETag: ETAG });
    res.end(DATA.subarray(start, end + 2));
  });
  const { url, lease } = await gatewayFor(t, source);
  await request(url, 'bytes=0-99').then(body).catch(() => {}); await lease.settle();
  assert.equal(lease.error.code, 'REMOTE_HTTP'); assert(lease.metrics.receivedBytes <= 100);
  assert.equal(lease.metrics.reservedBytes, 0); assert.equal(source.requests.length, 1);
});

test('a source version failure cancels a sibling without replacing the original error', OPTIONS, async t => {
  const source = await sourceFor(t, entry => {
    if (entry.start === 100) { reply(entry, { ETag: '"direct-fixture-v2"' }); return; }
    entry.res.writeHead(206, { 'Content-Range': `bytes ${entry.start}-${entry.end}/${DATA.length}`, 'Content-Length': 100, ETag: ETAG });
    entry.res.write(DATA.subarray(entry.start, entry.start + 20));
  });
  const { url, lease } = await gatewayFor(t, source);
  const first = await request(url, 'bytes=0-99'), iterator = first[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.length, 20);
  const second = await request(url, 'bytes=100-199'); assert.equal(second.statusCode, 502); await body(second);
  await assert.rejects(iterator.next()); await lease.settle();
  assert.equal(lease.error.code, 'SOURCE_CHANGED'); assert.equal(lease.metrics.receivedBytes, 20);
  assert.equal(lease.metrics.reservedBytes, 0); assert.equal(source.requests.length, 2);
});

test('header and body inactivity timeouts stop the physical request without retries', OPTIONS, async t => {
  for (const stage of ['headers', 'body']) await t.test(stage, async t => {
    const source = await sourceFor(t, ({ res, start, end }) => {
      if (stage === 'body') {
        res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${DATA.length}`, 'Content-Length': end - start + 1, ETag: ETAG });
        res.flushHeaders();
      }
    });
    const { url, lease } = await gatewayFor(t, source, { requestTimeoutMs: 200 });
    await request(url, 'bytes=0-99').then(body).catch(() => {}); await lease.settle();
    assert.equal(lease.error.code, 'TIMEOUT'); assert.equal(lease.metrics.receivedBytes, 0);
    assert.equal(lease.metrics.reservedBytes, 0); assert.equal(source.requests.length, 1);
    const record = directReadTimings(lease.metrics).requests[0];
    assert.equal(record.failureCode, 'TIMEOUT'); assert.equal(record.terminalStage, stage === 'headers' ? 'waiting_response' : 'waiting_first_data');
    assert.equal(directTelemetry(lease.metrics).activeRequests, 0);
  });
});

test('redirects are bounded and retain Range checks; private redirect destinations never dispatch', OPTIONS, async t => {
  await t.test('same origin', async t => {
    const source = await sourceFor(t, entry => {
      if (entry.req.url === '/synthetic.mkv') entry.res.writeHead(302, { Location: '/final.mkv' }).end(); else reply(entry);
    });
    const { url, lease } = await gatewayFor(t, source, { budgetBytes: 100 });
    assert.deepEqual(await body(await request(url, 'bytes=1-100')), DATA.subarray(1, 101));
    await lease.settle(); assert.equal(lease.metrics.requests, 2); assert.equal(lease.metrics.receivedBytes, 100);
    const telemetry = directTelemetry(lease.metrics), records = directReadTimings(lease.metrics).requests;
    assert.equal(telemetry.requestsStarted, 2); assert.equal(telemetry.requestsCompleted, 2);
    assert.deepEqual(records.map(record => record.httpStatus), [302, 206]);
    assert.equal(lease.metrics.reservedBytes, 0); assert.equal(lease.error, null);
  });
  await t.test('cross origin strips the supplied Referer', async t => {
    const target = await sourceFor(t);
    const source = await sourceFor(t, ({ res }) => res.writeHead(302, { Location: `${target.url}/final.mkv` }).end());
    const { url, lease } = await gatewayFor(t, source, { budgetBytes: 100,
      headers: { 'User-Agent': 'Synthetic-UA', Referer: 'https://pan.example/' } });
    assert.deepEqual(await body(await request(url, 'bytes=1-100')), DATA.subarray(1, 101));
    await lease.settle(); assert.equal(source.requests.length, 1); assert.equal(target.requests.length, 1);
    assert.equal(target.requests[0].headers.referer, undefined); assert.equal(target.requests[0].headers['user-agent'], 'Synthetic-UA');
    assert.equal(lease.metrics.requests, 2); assert.equal(lease.metrics.receivedBytes, 100);
  });
  await t.test('redirect loop', async t => {
    const source = await sourceFor(t, ({ res }) => res.writeHead(302, { Location: '/synthetic.mkv' }).end());
    const { url, lease } = await gatewayFor(t, source, { budgetBytes: 100 });
    const response = await request(url, 'bytes=0-99'); assert.equal(response.statusCode, 502); await body(response); await lease.settle();
    assert.equal(lease.error.code, 'REDIRECT_LIMIT'); assert.equal(lease.metrics.requests, 4);
    assert.equal(lease.metrics.receivedBytes, 0); assert.equal(lease.metrics.reservedBytes, 0);
  });
  for (const destination of ['http://10.0.0.1/private', 'https://[::ffff:127.0.0.1]/private', 'http://localhost/private']) {
    await t.test(destination.split('/')[2], async t => {
      const source = await sourceFor(t, ({ res }) => res.writeHead(302, { Location: destination }).end());
      const { url, lease } = await gatewayFor(t, source);
      const response = await request(url, 'bytes=0-99'); assert.equal(response.statusCode, 502); await body(response); await lease.settle();
      assert.equal(lease.error.code, 'UNSAFE_URL'); assert.equal(source.requests.length, 1);
      assert.equal(lease.metrics.receivedBytes, 0); assert.equal(lease.metrics.reservedBytes, 0);
    });
  }
});
