import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, stat, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../server.mjs';
import { locateMatroskaCue } from '../src/matroska-index.mjs';

const run = promisify(execFile), MiB = 1024 * 1024;
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const geometry = calls => calls.map(({ start, end }) => ({ start, end }));
const bytes = calls => calls.reduce((sum, call) => sum + call.end - call.start + 1, 0);

async function backend(t, root, options = {}) {
  const server = await startServer({ outputDir: path.join(root, 'output'), dataDir: path.join(root, 'state'), ...options });
  t.after(() => server.close());
  const bootstrap = await (await fetch(`${server.url}/api/bootstrap`)).json();
  async function api(route, value, { allowError = false } = {}) {
    const response = await fetch(server.url + route, value === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken }, body: JSON.stringify(value),
    });
    const result = await response.json();
    if (!response.ok && !allowError) throw new Error(`${route}: ${JSON.stringify(result)}`);
    return result;
  }
  async function finish(id) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const result = await api(`/api/jobs/${id}`);
      if (['completed', 'failed', 'cancelled'].includes(result.status)) return result;
      await wait(20);
    }
    throw new Error(`Timed out waiting for indexed task ${id}`);
  }
  return { api, finish, close: () => server.close() };
}

async function packets(filename) {
  const result = await run('ffprobe', ['-v', 'error', '-show_packets', '-show_data_hash', 'sha256', '-show_entries',
    'packet=stream_index,pts_time,dts_time,duration_time,size,flags,data_hash', '-of', 'json', filename], { timeout: 30000, maxBuffer: 8 * MiB });
  return JSON.parse(result.stdout).packets;
}

async function decode(filename) {
  const result = await run('ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-i', filename,
    '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 30000, maxBuffer: MiB });
  assert.equal(result.stderr, '', 'the synthetic candidate must decode without warnings');
}

test('API metadata reuse preserves independent source checks, exact budgets and playable media', { timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-index-cache-api-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'synthetic.mkv');
  // Every frame is a keyframe so twelve seconds produce a meaningful footer
  // Cues table, without a long film, artificial padding or real cloud account.
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=24:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=12',
    '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000:duration=12',
    '-map', '0:v:0', '-map', '1:a:0', '-map', '2:a:0',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-g', '1', '-keyint_min', '1', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-cluster_time_limit', '250', filename], { timeout: 45000 });
  const data = await readFile(filename), size = (await stat(filename)).size;
  assert(size > MiB);
  const baseParams = { start: 3, end: 5, handles: 0, makeMp4: false, budgetMiB: 64 };
  const plans = new Map();
  async function plan(params = baseParams) {
    const key = `${params.start}-${params.end}`;
    if (!plans.has(key)) plans.set(key, await locateMatroskaCue({ size, start: params.start, end: params.end,
      videoStreamIndex: 0, videoCodec: 'h264', read: async (position, length) => Buffer.from(data.subarray(position, position + length)) }));
    assert(plans.get(key)?.window, 'fixture must expose a verified independent window');
    return plans.get(key).window;
  }
  const firstPlan = await plan(), requests = [];
  assert(firstPlan.sourceStart > 16384, 'adversarial Cluster responses must be outside the freshly checked bootstrap');
  let etag = '"index-fixture-v1"', tamperHead = false, targetFault = null;
  const fixture = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) { res.writeHead(400).end(); return; }
    const start = Number(match[1]), end = Math.min(Number(match[2]), size - 1);
    if (start < 0 || end < start || end >= size) { res.writeHead(416).end(); return; }
    const weak = req.url.startsWith('/weak.mkv'), responseEtag = weak ? 'W/"index-fixture-weak"' : etag;
    requests.push({ start, end, ifMatch: req.headers['if-match'], path: req.url, weak });
    if (req.headers['if-match'] && req.headers['if-match'] !== responseEtag) { res.writeHead(412).end(); return; }
    const badTarget = targetFault && start === firstPlan.sourceStart && end === start + 4095;
    const headers = { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, ETag: responseEtag };
    if (badTarget && targetFault === 'missing-etag') delete headers.ETag;
    if (badTarget && targetFault === 'changed-etag') headers.ETag = '"index-fixture-other-version"';
    if (badTarget && targetFault === 'wrong-range') headers['Content-Range'] = `bytes ${start + 1}-${end}/${size}`;
    res.writeHead(206, headers);
    const body = Buffer.from(data.subarray(start, end + 1));
    // Deliberately preserve the initial 128 bytes and lie about the validator.
    // The full fresh bootstrap digest must still catch this changed source.
    if (tamperHead && start <= 4096 && end >= 4096) body[4096 - start] ^= 1;
    res.end(body);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(async () => { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); });
  const origin = `http://127.0.0.1:${fixture.address().port}`;
  const value = `${origin}/movie.mkv?signature=INDEX_CACHE_PRIVATE_MUST_NOT_PERSIST`;
  const directory = path.join(root, 'enabled'), app = await backend(t, directory);
  const source = await app.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 16 });
  const secondAudio = source.media.streams.filter(stream => stream.type === 'audio')[1]?.index;
  assert.equal(typeof secondAudio, 'number');

  async function extract(params = {}, selectedSource = source, selectedApp = app) {
    const from = requests.length;
    const created = await selectedApp.api('/api/jobs', { ...baseParams, ...params, sourceId: selectedSource.sourceId });
    const done = await selectedApp.finish(created.id), calls = requests.slice(from);
    return { done, calls };
  }
  function split(result, window = firstPlan, expectedEtag = etag) {
    const { done, calls } = result;
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.deepEqual(geometry(calls.slice(0, 1)), [{ start: 0, end: 127 }], 'every new task separately rechecks its original source');
    const target = [];
    for (let start = window.sourceStart; start < window.sourceEnd; start += MiB)
      target.push({ start, end: Math.min(start + MiB - 1, window.sourceEnd - 1) });
    const at = calls.findIndex(call => call.start === target[0].start && call.end === target[0].end);
    assert(at > 1, 'verified index and cluster checks must precede all target reads');
    const indexCalls = calls.slice(1, at), targetCalls = calls.slice(at);
    assert.deepEqual(geometry(targetCalls), target, 'metadata reuse cannot alter target geometry or read outside the window');
    assert.equal(done.metrics.receivedBytes, bytes(calls.slice(1)), 'all fresh lease bytes, including the full bootstrap, count exactly once');
    assert.equal(done.metrics.requests, calls.length - 1);
    assert.equal(done.diagnostics.transfer.requestsCompleted, done.metrics.requests);
    assert.equal(done.diagnostics.transfer.activeRequests, 0);
    if (expectedEtag) assert(calls.slice(1).every(call => call.ifMatch === expectedEtag), 'every task read must carry the original strong validator');
    return { indexCalls, targetCalls };
  }

  let cold, warm, warmSplit, coldPackets;
  await t.test('cold and warm tasks differ only in metadata reads; local packets, decode and fresh cluster checks agree', async () => {
    const rejected = await app.api('/api/jobs', { ...baseParams, sourceId: source.sourceId, reuseIndex: 'yes' }, { allowError: true });
    assert.equal(rejected.error.code, 'INDEX_CACHE_INVALID');
    cold = await extract(); const coldSplit = split(cold);
    warm = await extract(); warmSplit = split(warm);
    assert.deepEqual(cold.done.diagnostics.indexCache, { enabled: true, hitBytes: 0, hitReads: 0 });
    assert(warm.done.diagnostics.indexCache.enabled);
    assert(warm.done.diagnostics.indexCache.hitBytes > 0);
    assert(warm.done.diagnostics.indexCache.hitReads > 0);
    assert(bytes(warmSplit.indexCalls) < bytes(coldSplit.indexCalls), 'the warm job must actually receive fewer indexing bytes');
    assert(warmSplit.indexCalls.length < coldSplit.indexCalls.length, 'the warm job must actually dispatch fewer indexing requests');
    for (const result of [coldSplit, warmSplit])
      assert(result.indexCalls.some(call => call.start === 0 && call.end === 16383), 'the complete bootstrap is freshly verified inside each task budget');
    const targetChecks = calls => geometry(calls.filter(call => call.start >= firstPlan.sourceStart && call.start < firstPlan.sourceEnd));
    assert.deepEqual(targetChecks(warmSplit.indexCalls), targetChecks(coldSplit.indexCalls), 'selected and terminal Cluster headers and timecodes must never be shared');
    assert(targetChecks(warmSplit.indexCalls).length >= 2);
    assert.deepEqual(geometry(warmSplit.targetCalls), geometry(coldSplit.targetCalls));
    await Promise.all([decode(cold.done.result.candidatePath), decode(warm.done.result.candidatePath)]);
    coldPackets = await packets(cold.done.result.candidatePath);
    assert(coldPackets.length > 100);
    assert.deepEqual(await packets(warm.done.result.candidatePath), coldPackets, 'compressed packets and all timestamps must remain identical');
  });

  await t.test('explicit per-job and global disable retain the uncached extraction path', async () => {
    const disabled = await extract({ reuseIndex: false }), oldPath = split(disabled);
    assert.deepEqual(disabled.done.diagnostics.indexCache, { enabled: false, hitBytes: 0, hitReads: 0 });
    assert(!oldPath.indexCalls.some(call => call.start === 0 && call.end === 16383), 'disabled reuse does not add the 16 KiB cache identity check');
    assert.deepEqual(await packets(disabled.done.result.candidatePath), coldPackets);
    const other = await backend(t, path.join(root, 'disabled'), { reuseMatroskaIndex: false });
    const otherSource = await other.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 16 });
    const global = await extract({}, otherSource, other), globalSplit = split(global);
    assert.deepEqual(global.done.diagnostics.indexCache, { enabled: false, hitBytes: 0, hitReads: 0 });
    assert.deepEqual(geometry(globalSplit.indexCalls), geometry(oldPath.indexCalls));
    const measurements = result => {
      const { indexCalls } = split(result);
      return { indexBytes: bytes(indexCalls), indexRequests: indexCalls.length,
        hitBytes: result.done.diagnostics.indexCache.hitBytes, hitReads: result.done.diagnostics.indexCache.hitReads,
        receivedBytes: result.done.metrics.receivedBytes, totalRequests: result.done.metrics.requests };
    };
    // Numeric structural observations only: no URLs, filenames, credentials,
    // elapsed-time claims or synthetic-to-real-cloud speed extrapolation.
    const observations = { schemaVersion: 1, cold: measurements(cold), warm: measurements(warm), disabled: measurements(disabled) };
    for (const measurement of [observations.cold, observations.warm, observations.disabled])
      assert(Object.values(measurement).every(value => Number.isSafeInteger(value) && value >= 0));
    console.log(JSON.stringify(observations));
    await other.close();
  });

  await t.test('another time and audio selection reuse only metadata, preserving that selection against a disabled baseline', async () => {
    const params = { start: 7, end: 9, audioStreamIndex: secondAudio }, window = await plan(params);
    const changed = await extract(params), normal = await extract({ ...params, reuseIndex: false });
    split(changed, window); split(normal, window);
    assert(changed.done.diagnostics.indexCache.hitBytes > 0);
    await Promise.all([decode(changed.done.result.candidatePath), decode(normal.done.result.candidatePath)]);
    const selectedPackets = await packets(changed.done.result.candidatePath);
    assert.deepEqual(selectedPackets, await packets(normal.done.result.candidatePath));
    assert.notDeepEqual(selectedPackets, coldPackets, 'new time and selected audio must actually change the saved media');
  });

  await t.test('a warm exact-byte budget succeeds and one byte less fails before target dispatch', async () => {
    const exact = warm.done.metrics.receivedBytes;
    const exactRun = await extract({ budgetMiB: exact / MiB }); split(exactRun);
    assert.equal(exactRun.done.metrics.receivedBytes, exact);
    assert.equal(exactRun.done.metrics.budgetBytes, exact);
    const short = await extract({ budgetMiB: (exact - 1) / MiB });
    assert.equal(short.done.status, 'failed'); assert.equal(short.done.error.code, 'BUDGET_EXCEEDED');
    assert.equal(short.done.metrics.receivedBytes, bytes(warmSplit.indexCalls));
    assert.deepEqual(geometry(short.calls.slice(1)), geometry(warmSplit.indexCalls), 'a failed preflight must not dispatch any target bytes');
  });

  await t.test('full bootstrap changes fail closed, invalidate prior metadata and never read target media', async () => {
    tamperHead = true;
    const changed = await extract();
    assert.equal(changed.done.status, 'failed'); assert.equal(changed.done.error.code, 'SOURCE_CHANGED');
    assert.deepEqual(geometry(changed.calls), [{ start: 0, end: 127 }, { start: 0, end: 16383 }]);
    assert.equal(changed.done.metrics.receivedBytes, 16384);
    tamperHead = false;
    const restored = await extract(); split(restored);
    assert.deepEqual(restored.done.diagnostics.indexCache, { enabled: true, hitBytes: 0, hitReads: 0 }, 'failed source validation evicts old metadata for this source');
  });

  for (const [fault, code] of [['missing-etag', 'SOURCE_CHANGED'], ['changed-etag', 'SOURCE_CHANGED'], ['wrong-range', 'RANGE_INVALID']]) {
    await t.test(`warm metadata cannot bypass a fresh target Cluster ${fault} failure`, async () => {
      const primed = await extract(); split(primed);
      assert(primed.done.diagnostics.indexCache.hitBytes > 0, 'the failure must exercise a populated metadata cache');
      const headerAt = primed.calls.findIndex(call => call.start === firstPlan.sourceStart && call.end === firstPlan.sourceStart + 4095);
      assert(headerAt > 1, 'the selected Cluster must receive its own fresh range after the full bootstrap');
      targetFault = fault;
      let failed;
      try { failed = await extract(); }
      finally { targetFault = null; }
      assert.equal(failed.done.status, 'failed');
      assert.equal(failed.done.error.code, code);
      assert.equal(failed.done.result?.candidatePath, undefined);
      await assert.rejects(stat(path.join(directory, 'output', failed.done.id, 'candidate.mkv')), { code: 'ENOENT' });
      assert.deepEqual(geometry(failed.calls), geometry(primed.calls.slice(0, headerAt + 1)),
        'cached metadata may be reused, but a rejected Cluster header must stop before all target media requests');
      assert(failed.calls.every(call => call.ifMatch === etag));
      assert.equal(failed.done.metrics.receivedBytes, bytes(failed.calls.slice(1, -1)), 'rejected response bodies must never enter task accounting or cache');
      assert.equal(failed.done.diagnostics.transfer.activeRequests, 0);
      const recovered = await extract(); split(recovered);
      await decode(recovered.done.result.candidatePath);
      assert.deepEqual(await packets(recovered.done.result.candidatePath), coldPackets, 'restored origin semantics must produce the original independently verified candidate');
    });
  }

  await t.test('source keys, strong versions and weak validators do not share metadata', async () => {
    const alias = await app.api('/api/probe', { source: { type: 'http', value: `${origin}/alias.mkv` }, budgetMiB: 16 });
    const aliasJob = await extract({}, alias); split(aliasJob);
    assert.equal(aliasJob.done.diagnostics.indexCache.hitBytes, 0, 'same bytes and validator at a new URL are a distinct source');
    etag = '"index-fixture-v2"';
    const oldVersion = await extract();
    assert.equal(oldVersion.done.status, 'failed'); assert.equal(oldVersion.done.error.code, 'SOURCE_CHANGED');
    assert.deepEqual(geometry(oldVersion.calls), [{ start: 0, end: 127 }], 'version changes fail before opening any indexing lease');
    const nextVersion = await app.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 16 });
    const versionJob = await extract({}, nextVersion); split(versionJob);
    assert.equal(versionJob.done.diagnostics.indexCache.hitBytes, 0);
    const weak = await app.api('/api/probe', { source: { type: 'http', value: `${origin}/weak.mkv` }, budgetMiB: 16 });
    const weakOne = await extract({}, weak), weakTwo = await extract({}, weak);
    const first = split(weakOne, firstPlan, null), second = split(weakTwo, firstPlan, null);
    assert.deepEqual(weakOne.done.diagnostics.indexCache, { enabled: false, hitBytes: 0, hitReads: 0 });
    assert.deepEqual(weakTwo.done.diagnostics.indexCache, { enabled: false, hitBytes: 0, hitReads: 0 });
    assert.deepEqual(geometry(first.indexCalls), geometry(second.indexCalls));
    assert(weakOne.calls.every(call => call.ifMatch === undefined), 'weak validators cannot be promoted to strong If-Match conditions');
  });

  await t.test('cache is process-local: reopening the backend starts cold without changing the saved result', async () => {
    await app.close();
    const reopened = await backend(t, directory), fresh = await reopened.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 16 });
    const afterRestart = await extract({}, fresh, reopened); split(afterRestart);
    assert.deepEqual(afterRestart.done.diagnostics.indexCache, { enabled: true, hitBytes: 0, hitReads: 0 });
    assert.deepEqual(await packets(afterRestart.done.result.candidatePath), coldPackets);
    await reopened.close();
  });
});
