import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { startServer } from '../server.mjs';

const MiB = 1024 * 1024;
const sample = fileURLToPath(new URL('../examples/示例视频.mkv', import.meta.url));
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const terminal = new Set(['completed', 'failed', 'cancelled']);
const options = { timeout: 30000 };

async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await wait(10);
  }
  throw new Error(message);
}

async function inventory(directory, prefix = '') {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + item.name;
    if (item.isDirectory()) result.push(...await inventory(path.join(directory, item.name), name + '/'));
    else result.push(name);
  }
  return result.sort();
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-transfer-api-'));
  let app, origin;
  t.after(async () => {
    await app?.close();
    if (origin?.listening) { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); }
    await rm(root, { recursive: true, force: true });
  });
  // A real bounded MKV probe uses the valid sample at the beginning. Padding is
  // only a deterministic binary diagnostic region, never a decoded movie.
  const sampleBytes = await readFile(sample);
  const data = Buffer.alloc(64 * MiB);
  for (let offset = 0; offset < data.length; offset += MiB) data.fill(offset / MiB, offset, offset + MiB);
  sampleBytes.copy(data);
  const small = path.join(root, 'local.mkv'); await writeFile(small, sampleBytes);
  const calls = [], active = new Set(), held = new Set();
  const state = { hold: false };
  origin = http.createServer((req, res) => {
    if (req.method === 'PROPFIND') {
      const self = '<d:response><d:href>/dav/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>';
      const file = `<d:response><d:href>/dav/video.mkv</d:href><d:propstat><d:prop><d:resourcetype/><d:getcontentlength>${data.length}</d:getcontentlength></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
      res.writeHead(207, { 'Content-Type': 'application/xml' }).end(`<d:multistatus xmlns:d="DAV:">${self}${file}</d:multistatus>`);
      return;
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (req.method !== 'GET' || !match) { res.writeHead(400).end(); return; }
    const size = req.url.startsWith('/small.mkv') ? 32 * MiB - 1 : req.url.startsWith('/boundary.mkv') ? 32 * MiB : data.length;
    const start = Number(match[1]), end = Math.min(Number(match[2]), size - 1);
    if (start < 0 || end < start || start >= size) { res.writeHead(416).end(); return; }
    calls.push({ start, end, ifMatch: req.headers['if-match'], authorization: req.headers.authorization });
    active.add(res); res.once('close', () => { active.delete(res); held.delete(res); });
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1,
      ETag: req.url.startsWith('/weak.mkv') ? 'W/"transfer-fixture"' : '"transfer-fixture"' });
    const payload = data.subarray(start, end + 1);
    if (state.hold) {
      held.add(res); res.flushHeaders(); res.write(payload.subarray(0, Math.min(128, payload.length)));
      res.fixtureRest = payload.subarray(Math.min(128, payload.length));
      return;
    }
    res.end(payload);
  });
  await new Promise((resolve, reject) => { origin.once('error', reject); origin.listen(0, '127.0.0.1', resolve); });
  const base = `http://127.0.0.1:${origin.address().port}`;
  const dataDir = path.join(root, 'state');
  app = await startServer({ outputDir: path.join(root, 'output'), dataDir });
  const bootstrap = await (await fetch(`${app.url}/api/bootstrap`)).json();
  async function api(route, value, extra = {}) {
    const method = extra.method || (value === undefined ? 'GET' : 'POST');
    const headers = { ...(value === undefined ? {} : { 'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken }), ...extra.headers };
    // Node fetch can replace a supplied Host. Use the raw HTTP client for the
    // adversarial Host check so the server receives the forged header itself.
    if (Object.hasOwn(headers, 'Host')) {
      return new Promise((resolve, reject) => {
        const request = http.request(app.url + route, { method, headers }, response => {
          const chunks = [];
          response.on('data', chunk => chunks.push(chunk));
          response.once('error', reject);
          response.once('end', () => {
            try { resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); }
            catch (error) { reject(error); }
          });
        });
        request.once('error', reject);
        request.end(value === undefined ? undefined : JSON.stringify(value));
      });
    }
    const response = await fetch(app.url + route, { method, ...extra,
      headers,
      ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
    return { status: response.status, data: await response.json() };
  }
  async function success(route, value) {
    const result = await api(route, value); assert(result.status < 300, JSON.stringify(result)); return result.data;
  }
  async function probe(kind = 'strong') {
    return success('/api/probe', { source: kind === 'local' ? { type: 'local', value: small }
      : { type: 'http', value: `${base}/${['weak', 'small', 'boundary'].includes(kind) ? kind : 'movie'}.mkv?token=TRANSFER_PRIVATE_URL` }, budgetMiB: 32 });
  }
  async function finish(id) {
    return until(async () => {
      const result = await success(`/api/transfer-checks/${id}`);
      return terminal.has(result.status) ? result : null;
    }, 'finite diagnostic did not settle');
  }
  function release() {
    state.hold = false;
    for (const res of held) if (!res.destroyed) res.end(res.fixtureRest);
  }
  return { app, root, dataDir, base, small, data, state, calls, active, held, bootstrap, api, success, probe, finish, release };
}

function settled(result, expected = 'completed') {
  assert.equal(result.status, expected);
  assert.equal(result.report.status, expected);
  assert.equal(result.report.metrics.activeRequests, 0);
  assert.equal(result.report.metrics.reservedBytes, 0);
  assert.equal(result.report.metrics.upstreamBytes, null);
  assert.equal(result.report.metrics.unknownUpstream, true);
  assert.equal(result.report.conclusion, 'inconclusive');
  assert.equal(result.report.schemaVersion, 3);
  assert.equal(result.report.sampling.strategy, 'non_overlapping_ranges');
  assert.equal(result.report.throughput.serialMedianBytesPerSecond, null);
  assert.equal(result.report.throughput.parallelMedianBytesPerSecond, null);
  assert.equal(result.report.requestTimings.droppedRequests, 0);
  assert.equal(result.report.requestTimings.requestsRecorded, result.report.metrics.requestCount);
  assert.equal(result.report.requestTimings.requests.length, result.report.metrics.requestCount);
  assert.deepEqual(Object.values(result.report.metrics.liveWaitCounts), [0, 0, 0, 0]);
}

test('transfer diagnostic view module is served as JavaScript for the application import', options, async t => {
  const f = await fixture(t);
  const response = await fetch(`${f.app.url}/transfer-check-view.mjs`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/javascript(?:;|$)/);
  assert.equal(await response.text(), await readFile(fileURLToPath(new URL('../public/transfer-check-view.mjs', import.meta.url)), 'utf8'));
});

test('finite transfer API enforces session/origin checks, validates options and rejects unavailable sources', options, async t => {
  const f = await fixture(t), strong = await f.probe(), weak = await f.probe('weak'), local = await f.probe('local'), small = await f.probe('small'), boundary = await f.probe('boundary');
  assert.equal(strong.transferCheckAvailable, true);
  assert.equal(weak.transferCheckAvailable, false); assert.equal(local.transferCheckAvailable, false);
  assert.equal(small.transferCheckAvailable, false, 'a source just below 32 MiB cannot fit diagnostic windows');
  assert.equal(boundary.transferCheckAvailable, true, '32 MiB is the supported lower boundary');
  const before = f.calls.length;
  const forbidden = await f.api('/api/transfer-checks', { sourceId: strong.sourceId }, { headers: { 'X-Session-Token': 'wrong-session' } });
  assert.equal(forbidden.status, 403);
  assert.equal((await f.api('/api/transfer-checks', { sourceId: strong.sourceId }, { headers: { Origin: 'https://outside.invalid' } })).status, 403);
  assert.equal((await f.api('/api/transfer-checks', { sourceId: strong.sourceId }, { headers: { Host: 'outside.invalid' } })).status, 403);
  assert.equal((await f.api('/api/transfer-checks')).status, 404, 'GET must not create work');
  for (const source of [local, weak, small]) {
    const denied = await f.api('/api/transfer-checks', { sourceId: source.sourceId });
    assert.equal(denied.status, 400); assert.equal(denied.data.error.code, 'TRANSFER_CHECK_UNAVAILABLE');
  }
  for (const extra of [
    ...[-0.01, 0.5, 1.01, '0.5', null, true, {}].map(positionFraction => ({ positionFraction })),
    { windows: [] }, { concurrency: 2 }, { timeoutMs: 25 }, { sourceIdTypo: strong.sourceId },
    { sampling: { strategy: 'non_overlapping_ranges' } }, { unused: null },
  ]) {
    const denied = await f.api('/api/transfer-checks', { sourceId: strong.sourceId, ...extra });
    assert.equal(denied.status, 400); assert.equal(denied.data.error.code, 'TRANSFER_CHECK_OPTIONS_INVALID');
  }
  assert.equal(f.calls.length, before, 'invalid or unauthorized diagnostics must not dispatch cloud reads');
});

test('finite transfer API completes a bounded diagnostic without history, files, credentials or raw source addresses', options, async t => {
  const f = await fixture(t), source = await f.probe(), beforeFiles = await inventory(f.dataDir), beforeCalls = f.calls.length;
  const created = await f.api('/api/transfer-checks', { sourceId: source.sourceId });
  assert.equal(created.status, 202); assert.equal(created.data.status, 'running');
  assert(Object.hasOwn(created.data, 'progress'));
  const result = await f.finish(created.data.id); settled(result);
  assert.equal(result.report.metrics.receivedBytes, 8 * MiB + 16384);
  assert.equal(result.report.metrics.plannedBytes, 8 * MiB + 16384);
  assert.equal(result.report.metrics.requestCount, 9);
  assert.equal(f.calls.length - beforeCalls, 9);
  const reads = f.calls.slice(beforeCalls);
  assert(reads.every(call => call.ifMatch === '"transfer-fixture"'));
  assert.equal(result.report.integrity.headChecked, true); assert.equal(result.report.integrity.rangesVerified, true);
  assert.equal(Object.hasOwn(result.report.integrity, 'consistent'), false);
  const windows = [0.1, 0.3, 0.6, 0.8].map((positionFraction, i) => {
    const start = Math.floor(f.data.length * positionFraction);
    return { index: i + 1, start, endExclusive: start + 2 * MiB, positionFraction };
  });
  assert.deepEqual(result.report.sampling.windows, windows);
  assert.equal(result.report.sampling.minimumWindowGapBytes, 4 * MiB);
  assert.equal(result.report.sampling.minimumSourceBytes, 32 * MiB);
  assert.deepEqual({ start: reads[0].start, end: reads[0].end }, { start: 0, end: 16383 });
  assert.equal(new Set(reads.map(call => `${call.start}-${call.end}`)).size, reads.length, 'each physical range is requested once');
  const expectedHashes = [];
  for (const [i, window] of windows.entries()) {
    assert(window.start >= 16384 && window.endExclusive <= f.data.length);
    if (i) assert(window.start - windows[i - 1].endExclusive >= 4 * MiB);
    // Parallel requests may reach the HTTP fixture in either order. The pair
    // must belong to this window, and complete before the next round begins.
    assert.deepEqual(reads.slice(1 + 2 * i, 3 + 2 * i).map(({ start, end }) => ({ start, end })).sort((a, b) => a.start - b.start), [
      { start: window.start, end: window.start + MiB - 1 },
      { start: window.start + MiB, end: window.endExclusive - 1 },
    ]);
    const hashes = [window.start, window.start + MiB].map(start => createHash('sha256').update(f.data.subarray(start, start + MiB)).digest('hex'));
    expectedHashes.push(hashes);
    const round = result.report.rounds[i];
    assert.equal(round.start, window.start); assert.equal(round.endExclusive, window.endExclusive);
    assert.equal(round.receivedBytes, 2 * MiB); assert.equal(round.requestCount, 2);
    assert.deepEqual(round.hashes, hashes);
  }
  assert.deepEqual(result.report.integrity.sampleHashes, expectedHashes);
  assert.equal(new Set(expectedHashes.flat()).size, 8, 'position-dependent fixture contents expose accidental repeated ranges');
  assert.deepEqual(result.report.rounds.map(round => round.mode), ['serial', 'parallel', 'parallel', 'serial']);
  assert.equal((await f.success('/api/bootstrap')).transferCheck, null);
  assert.deepEqual((await f.success('/api/jobs/history')).jobs, []);
  assert.deepEqual(await inventory(f.dataDir), beforeFiles, 'diagnostics must not create cache, manifests or task history');
  const text = JSON.stringify(result);
  for (const secret of ['TRANSFER_PRIVATE_URL', '127.0.0.1', 'transfer-fixture', source.sourceId, f.root, 'authorization'])
    assert(!text.includes(secret), `diagnostic leaked ${secret}`);
});

test('active diagnostic blocks media commands and another diagnostic; cancel is authenticated, settled and idempotent', options, async t => {
  const f = await fixture(t), source = await f.probe(); f.state.hold = true;
  const created = await f.success('/api/transfer-checks', { sourceId: source.sourceId });
  await until(() => f.held.size > 0, 'diagnostic did not start');
  assert.equal((await f.success('/api/bootstrap')).transferCheck.id, created.id);
  const before = f.calls.length;
  for (const [route, value] of [
    ['/api/transfer-checks', { sourceId: source.sourceId }],
    ['/api/probe', { source: { type: 'local', value: f.small } }],
    ['/api/jobs', { sourceId: source.sourceId, start: 1, end: 2, handles: 0 }],
    ['/api/jobs/not-a-job/compatible', {}],
    ['/api/jobs/not-a-job/resume', { sourceId: source.sourceId }],
  ]) {
    const blocked = await f.api(route, value);
    assert.equal(blocked.status, 400); assert.equal(blocked.data.error.code, 'TRANSFER_CHECK_BUSY');
  }
  assert.equal(f.calls.length, before);
  assert.equal((await f.api(`/api/transfer-checks/${created.id}/cancel`, {}, { headers: { 'X-Session-Token': 'wrong-session' } })).status, 403);
  assert.equal((await f.api(`/api/transfer-checks/${created.id}/cancel`)).status, 404, 'GET must not cancel work');
  const cancelled = await f.success(`/api/transfer-checks/${created.id}/cancel`, {}); settled(cancelled, 'cancelled');
  assert.deepEqual(await f.success(`/api/transfer-checks/${created.id}/cancel`, {}), cancelled);
  await until(() => f.active.size === 0, 'cancel left an upstream response active');
  assert.equal((await f.success('/api/bootstrap')).transferCheck, null);
  f.release();
  settled(await f.finish((await f.success('/api/transfer-checks', { sourceId: source.sourceId })).id));
});

test('source probes and queued/running extraction exclude a concurrent diagnostic', options, async t => {
  const f = await fixture(t), source = await f.probe(); f.state.hold = true;
  const pendingProbe = f.api('/api/probe', { source: { type: 'http', value: `${f.base}/another.mkv` }, budgetMiB: 32 });
  await until(() => f.held.size > 0, 'pending probe did not start');
  assert.equal((await f.api('/api/transfer-checks', { sourceId: source.sourceId })).data.error.code, 'TRANSFER_CHECK_BUSY');
  f.release(); assert.equal((await pendingProbe).status, 200);
  f.state.hold = true;
  const first = await f.success('/api/jobs', { sourceId: source.sourceId, start: 1, end: 2, handles: 0 });
  const second = await f.success('/api/jobs', { sourceId: source.sourceId, start: 2, end: 3, handles: 0 });
  await until(() => f.held.size > 0, 'extraction did not start');
  assert.equal((await f.api('/api/transfer-checks', { sourceId: source.sourceId })).data.error.code, 'TRANSFER_CHECK_BUSY');
  for (const job of [first, second]) await f.success(`/api/jobs/${job.id}/cancel`, {});
  for (const job of [first, second]) await until(async () => terminal.has((await f.success(`/api/jobs/${job.id}`)).status), 'cancelled extraction did not settle');
  f.release();
  settled(await f.finish((await f.success('/api/transfer-checks', { sourceId: source.sourceId })).id));
});

test('only four in-memory records survive and another backend cannot access them', options, async t => {
  const f = await fixture(t), source = await f.probe(), ids = [];
  for (let i = 0; i < 5; i++) {
    const created = await f.success('/api/transfer-checks', { sourceId: source.sourceId });
    ids.push(created.id); settled(await f.finish(created.id));
  }
  assert.equal((await f.api(`/api/transfer-checks/${ids[0]}`)).status, 404);
  for (const id of ids.slice(1)) assert.equal((await f.api(`/api/transfer-checks/${id}`)).status, 200);
  const other = await startServer({ outputDir: path.join(f.root, 'other-output'), dataDir: path.join(f.root, 'other-state') });
  t.after(() => other.close());
  assert.equal((await fetch(`${other.url}/api/transfer-checks/${ids.at(-1)}`)).status, 404);
  assert.deepEqual((await f.success('/api/jobs/history')).jobs, []);
});

test('disconnect aborts and settles the matching WebDAV diagnostic before invalidating its source', options, async t => {
  const f = await fixture(t);
  const connection = await f.success('/api/dav/connect', { url: `${f.base}/dav/`, username: 'TRANSFER_PRIVATE_ACCOUNT', password: 'TRANSFER_PRIVATE_PASSWORD' });
  const video = connection.entries.find(entry => !entry.isDirectory);
  const source = await f.success('/api/probe', { source: { type: 'dav', connectionId: connection.connectionId, value: video.url }, budgetMiB: 32 });
  assert.equal(source.transferCheckAvailable, true); f.state.hold = true;
  const created = await f.success('/api/transfer-checks', { sourceId: source.sourceId });
  await until(() => f.held.size > 0, 'WebDAV diagnostic did not start');
  const listing = await f.success('/api/dav/list', { connectionId: connection.connectionId, url: connection.directoryUrl });
  assert(listing.entries.length > 0, 'browsing may continue while a diagnostic runs');
  await f.success('/api/dav/disconnect', { connectionId: connection.connectionId });
  const cancelled = await f.success(`/api/transfer-checks/${created.id}`); settled(cancelled, 'cancelled');
  await until(() => f.active.size === 0, 'disconnect left an upstream response active');
  const rejected = await f.api('/api/transfer-checks', { sourceId: source.sourceId });
  assert.equal(rejected.data.error.code, 'SOURCE_MISSING');
  const serialized = JSON.stringify(cancelled);
  assert(!serialized.includes('TRANSFER_PRIVATE_ACCOUNT') && !serialized.includes('TRANSFER_PRIVATE_PASSWORD') && !serialized.includes('Basic '));
});

test('closing the backend aborts and awaits active diagnostic responses', options, async t => {
  const f = await fixture(t), source = await f.probe(); f.state.hold = true;
  await f.success('/api/transfer-checks', { sourceId: source.sourceId });
  await until(() => f.held.size > 0, 'diagnostic did not start');
  await f.app.close(); await f.app.close();
  assert.equal(f.app.server.listening, false);
  await until(() => f.active.size === 0, 'close left an upstream response active');
});
