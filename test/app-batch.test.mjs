import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, stat, readFile, readdir, rm, open } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { locateMatroskaCue } from '../src/matroska-index.mjs';

const run = promisify(execFile), MiB = 1024 * 1024;
const serverModule = pathToFileURL(fileURLToPath(new URL('../server.mjs', import.meta.url))).href;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function eventually(callback, label, milliseconds = 45000) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    const result = await callback();
    if (result) return result;
    await wait(30);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function backend(t, root) {
  const script = `import { startServer } from ${JSON.stringify(serverModule)};
    const app = await startServer({ outputDir: process.env.BATCH_TEST_OUTPUT, dataDir: process.env.BATCH_TEST_STATE, reuseMatroskaIndex: false });
    process.send({ url: app.url });
    process.on('message', async message => { if (message === 'close') { await app.close(); process.exit(0); } });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, BATCH_TEST_OUTPUT: path.join(root, 'output'), BATCH_TEST_STATE: path.join(root, 'state') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, 'exit'); child.kill('SIGKILL'); await ended;
    }
  });
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code, signal]) => { throw new Error(`Batch backend exited ${code}/${signal}: ${stderr}`); }),
  ]);
  const bootstrap = await (await fetch(`${ready.url}/api/bootstrap`)).json();
  async function api(route, value, { allowError = false } = {}) {
    const response = await fetch(ready.url + route, value === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken }, body: JSON.stringify(value),
    });
    const result = await response.json();
    if (!response.ok && !allowError) throw new Error(`${route}: ${JSON.stringify(result)}`);
    return result;
  }
  return { api,
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = once(child, 'exit'); child.send('close'); await ended;
    },
    async kill() {
      assert.equal(child.exitCode, null);
      const ended = once(child, 'exit'); child.kill('SIGKILL');
      const [, signal] = await ended; assert.equal(signal, 'SIGKILL');
    },
  };
}
const finish = (app, id) => eventually(async () => {
  const job = await app.api(`/api/jobs/${id}`);
  return ['completed', 'failed', 'cancelled'].includes(job.status) ? job : null;
}, 'terminal batch task');
const geometry = calls => calls.map(({ start, end }) => ({ start, end }));
const byteSum = calls => calls.reduce((sum, call) => sum + call.end - call.start + 1, 0);
async function packetRecords(filename) {
  const result = await run('ffprobe', ['-v', 'error', '-show_packets', '-show_data_hash', 'sha256', '-show_entries',
    'packet=stream_index,pts_time,dts_time,duration_time,size,flags,data_hash', '-of', 'json', filename], { timeout: 30000, maxBuffer: 8 * MiB });
  return JSON.parse(result.stdout).packets;
}
async function decode(filename) {
  const result = await run('ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-i', filename,
    '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 45000, maxBuffer: MiB });
  assert.equal(result.stderr, '', 'the generated CFR fixture should decode without warnings');
}

test('continuous indexed extraction changes only physical target ranges and preserves restart safety', { timeout: 180000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-batch-api-'));
  try {
    const video = path.join(root, 'synthetic.mkv');
    // Lossless synthetic H.264 produces enough bytes for several 4 MiB ranges
    // without adding any real media, cloud account or long-running benchmark.
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-n',
      '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=20',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '0', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
      '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-cluster_time_limit', '1000', video], { timeout: 45000 });
    const size = (await stat(video)).size, sourceFile = await open(video, 'r');
    let indexed;
    try {
      indexed = await locateMatroskaCue({ size, start: 4, end: 16, videoStreamIndex: 0, videoCodec: 'h264',
        read: async (position, length) => {
          const data = Buffer.alloc(length);
          assert.equal((await sourceFile.read(data, 0, length, position)).bytesRead, length); return data;
        } });
    } finally { await sourceFile.close(); }
    assert(indexed?.window);
    const { sourceStart, sourceEnd } = indexed.window, targetBytes = sourceEnd - sourceStart;
    assert(targetBytes > 8 * MiB, 'fixture needs a completed and an unfinished 4 MiB target range');
    const requests = [];
    let stall = false, stalled = false, parallelControl = null;
    const canonicalTarget = ({ start, end }) => start >= sourceStart && start < sourceEnd
      && (start - sourceStart) % MiB === 0 && end === Math.min(start + MiB - 1, sourceEnd - 1);
    function targetControl(kind) {
      return { kind, active: 0, maxActive: 0, held: [], released: false };
    }
    function streamRange(res, start, end, endResponse = true) {
      const stream = createReadStream(video, { start, end });
      res.once('close', () => stream.destroy()); stream.pipe(res, { end: endResponse });
    }
    const fixture = http.createServer((req, res) => {
      const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (!match) { res.writeHead(400).end(); return; }
      const start = Number(match[1]), end = Math.min(Number(match[2]), size - 1);
      assert(start >= 0 && end >= start && end < size);
      const noEtag = req.url.startsWith('/no-etag.mkv');
      requests.push({ start, end, ifMatch: req.headers['if-match'], noEtag });
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1,
        ...(!noEtag ? { ETag: '"batch-fixture-v1"' } : {}) });
      if (parallelControl && canonicalTarget({ start, end })) {
        const control = parallelControl;
        control.active++; control.maxActive = Math.max(control.maxActive, control.active);
        let ended = false;
        const done = () => { if (!ended) { ended = true; control.active--; } };
        res.once('finish', done); res.once('close', done);
        if (control.kind === 'pair-gate' && !control.released) {
          control.held.push({ res, start, end });
          if (control.held.length === 2) {
            control.released = true;
            for (const held of control.held) streamRange(held.res, held.start, held.end);
          }
          return;
        }
        if (control.kind === 'checkpoint-gate' && start !== sourceStart) {
          control.held.push({ res, start, end });
          res.flushHeaders(); streamRange(res, start, start + 65535, false); return;
        }
        streamRange(res, start, end); return;
      }
      if (stall && start === sourceStart + 4 * MiB && end - start + 1 === 4 * MiB) {
        stalled = true; res.flushHeaders();
        const stream = createReadStream(video, { start, end: start + 65535 });
        res.once('close', () => stream.destroy()); stream.pipe(res, { end: false }); return;
      }
      const stream = createReadStream(video, { start, end });
      res.once('close', () => stream.destroy()); stream.pipe(res);
    });
    await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
    t.after(async () => { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); });
    const value = `http://127.0.0.1:${fixture.address().port}/movie.mkv?signature=BATCH_PRIVATE_URL_MUST_NOT_PERSIST`;
    const baseParams = { start: 4, end: 16, handles: 0, makeMp4: false };
    let baseline;
    function splitCompleted(calls, batchBytes) {
      assert.deepEqual(geometry(calls.slice(0, 1)), [{ start: 0, end: 127 }], 'the independent source identity recheck is not part of a task lease');
      const mediaAt = calls.findIndex(call => call.start === sourceStart && call.end - call.start + 1 === batchBytes);
      assert(mediaAt > 1, 'time indexing must finish before the first full target request');
      const index = calls.slice(1, mediaAt), media = calls.slice(mediaAt), expected = [];
      for (let start = sourceStart; start < sourceEnd; start += batchBytes) expected.push({ start, end: Math.min(start + batchBytes - 1, sourceEnd - 1) });
      assert.deepEqual(geometry(media), expected, 'target requests must remain contiguous and stop at the exact verified end');
      return { index, media };
    }
    function splitParallel(calls, committedBytes = 0, { recheck = true } = {}) {
      if (recheck) assert.deepEqual(geometry(calls.slice(0, 1)), [{ start: 0, end: 127 }]);
      const mediaAt = calls.findIndex(canonicalTarget);
      assert(mediaAt >= (recheck ? 2 : 1), 'index planning must complete before target requests');
      const index = calls.slice(recheck ? 1 : 0, mediaAt), media = calls.slice(mediaAt), expected = [];
      for (let start = sourceStart + committedBytes; start < sourceEnd; start += MiB)
        expected.push({ start, end: Math.min(start + MiB - 1, sourceEnd - 1) });
      assert.deepEqual(geometry(media).sort((a, b) => a.start - b.start), expected,
        'parallel reads must cover each missing canonical unit exactly once and stop at the verified end');
      return { index, media };
    }

    await t.test('standard and continuous share index bytes, exact cumulative budget and compressed packets', async () => {
      const directory = path.join(root, 'comparison'), app = await backend(t, directory);
      const source = await app.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 32 });
      const rejected = await app.api('/api/jobs', { ...baseParams, sourceId: source.sourceId, readMode: 'unbounded' }, { allowError: true });
      assert.equal(rejected.error.code, 'READ_MODE_INVALID');
      const beforeStandard = requests.length;
      const standard = await app.api('/api/jobs', { ...baseParams, sourceId: source.sourceId, budgetMiB: 128,
        outputDir: path.join(directory, 'saved') });
      assert.equal(standard.readMode, 'standard', 'legacy requests keep the original mode by default');
      const standardDone = await finish(app, standard.id);
      assert.equal(standardDone.status, 'completed', JSON.stringify(standardDone.error));
      const standardCalls = requests.slice(beforeStandard), standardSplit = splitCompleted(standardCalls, MiB);
      const indexBytes = byteSum(standardSplit.index), exactBytes = indexBytes + targetBytes;
      assert.equal(standardDone.metrics.receivedBytes, exactBytes);
      assert.equal(standardDone.metrics.requests, standardCalls.length - 1);

      const beforeContinuous = requests.length;
      const continuous = await app.api('/api/jobs', { ...baseParams, sourceId: source.sourceId, readMode: 'continuous',
        budgetMiB: exactBytes / MiB, outputDir: path.join(directory, 'saved') });
      assert.equal(continuous.readMode, 'continuous');
      const continuousDone = await finish(app, continuous.id);
      assert.equal(continuousDone.status, 'completed', JSON.stringify(continuousDone.error));
      const continuousCalls = requests.slice(beforeContinuous), continuousSplit = splitCompleted(continuousCalls, 4 * MiB);
      assert.deepEqual(geometry(continuousSplit.index), geometry(standardSplit.index), 'continuous mode must not enlarge index or bootstrap requests');
      assert(continuousSplit.media.length < standardSplit.media.length);
      assert.equal(byteSum(continuousSplit.media), targetBytes);
      assert.equal(continuousDone.metrics.receivedBytes, exactBytes, 'the index and target leases both count against one cap');
      assert.equal(continuousDone.metrics.budgetBytes, exactBytes);
      assert.equal(continuousDone.metrics.requests, continuousCalls.length - 1);
      assert.equal(continuousDone.diagnostics.transfer.requestsCompleted, continuousDone.metrics.requests);
      assert.equal(continuousDone.diagnostics.transfer.activeRequests, 0);
      assert(continuousCalls.slice(1).every(call => call.ifMatch === '"batch-fixture-v1"'));
      await Promise.all([decode(standardDone.result.candidatePath), decode(continuousDone.result.candidatePath)]);
      const [originalPackets, batchedPackets] = await Promise.all([
        packetRecords(standardDone.result.candidatePath), packetRecords(continuousDone.result.candidatePath),
      ]);
      assert(originalPackets.length > 100);
      assert.deepEqual(batchedPackets, originalPackets, 'all compressed packet hashes and timestamps must remain unchanged');

      const shortStart = requests.length;
      const short = await app.api('/api/jobs', { ...baseParams, sourceId: source.sourceId, readMode: 'continuous',
        budgetMiB: (exactBytes - 1) / MiB, outputDir: path.join(directory, 'saved') });
      const shortDone = await finish(app, short.id);
      assert.equal(shortDone.status, 'failed'); assert.equal(shortDone.error.code, 'BUDGET_EXCEEDED');
      assert.equal(shortDone.metrics.receivedBytes, indexBytes, 'budget preflight fails before any target range is dispatched');
      assert.deepEqual(geometry(requests.slice(shortStart + 1)), geometry(standardSplit.index));
      baseline = { indexBytes, indexCalls: geometry(standardSplit.index), packets: originalPackets };
      await app.close();
    });

    await t.test('parallel API extraction overlaps two 1 MiB ranges with exact bytes and identical packets', async () => {
      const directory = path.join(root, 'parallel-comparison'), app = await backend(t, directory);
      const source = await app.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 32 });
      const before = requests.length, control = targetControl('pair-gate');
      parallelControl = control;
      const exactBytes = baseline.indexBytes + targetBytes;
      const created = await app.api('/api/jobs', { ...baseParams, sourceId: source.sourceId, readMode: 'parallel',
        budgetMiB: exactBytes / MiB, outputDir: path.join(directory, 'saved') });
      assert.equal(created.readMode, 'parallel');
      const completed = await finish(app, created.id);
      parallelControl = null;
      assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
      assert.equal(completed.readMode, 'parallel');
      assert.equal(control.released, true, 'the first response is gated until the second range is actually dispatched');
      assert.equal(control.maxActive, 2, 'the target transport must overlap exactly two ranges, without a third');
      assert.equal(control.active, 0);
      const calls = requests.slice(before), split = splitParallel(calls);
      assert.deepEqual(geometry(split.index), baseline.indexCalls, 'parallel mode must keep the original index geometry');
      assert.equal(byteSum(split.media), targetBytes);
      assert.equal(completed.metrics.receivedBytes, exactBytes);
      assert.equal(completed.metrics.budgetBytes, exactBytes, 'parallel mode cannot need artificial budget headroom');
      assert.equal(completed.metrics.requests, calls.length - 1);
      assert.equal(completed.diagnostics.transfer.requestsCompleted, completed.metrics.requests);
      assert.equal(completed.diagnostics.transfer.activeRequests, 0);
      assert(calls.slice(1).every(call => call.ifMatch === '"batch-fixture-v1"'));
      assert.deepEqual(await packetRecords(completed.result.candidatePath), baseline.packets,
        'PTS, DTS, duration, flags, size and every compressed-packet SHA256 must match standard mode');
      await decode(completed.result.candidatePath);

      const shortStart = requests.length;
      const short = await app.api('/api/jobs', { ...baseParams, sourceId: source.sourceId, readMode: 'parallel',
        budgetMiB: (exactBytes - 1) / MiB, outputDir: path.join(directory, 'saved') });
      const shortDone = await finish(app, short.id);
      assert.equal(shortDone.status, 'failed'); assert.equal(shortDone.error.code, 'BUDGET_EXCEEDED');
      assert.equal(shortDone.metrics.receivedBytes, baseline.indexBytes);
      assert.deepEqual(geometry(requests.slice(shortStart + 1)), baseline.indexCalls,
        'a one-byte shortage must fail before either parallel target range is dispatched');
      await app.close();
    });

    await t.test('continuous mode and canonical 1 MiB units survive SIGKILL and retain a 4 MiB crash charge', async () => {
      const directory = path.join(root, 'restart'), first = await backend(t, directory);
      const source = await first.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 32 });
      stall = true; stalled = false;
      const job = await first.api('/api/jobs', { ...baseParams, sourceId: source.sourceId, readMode: 'continuous', budgetMiB: 128,
        outputDir: path.join(directory, 'saved') });
      await eventually(() => stalled, 'second continuous target range');
      const before = await first.api(`/api/jobs/${job.id}`);
      assert.equal(before.readMode, 'continuous'); assert.equal(before.resume.cachedBytes, 4 * MiB);
      await first.kill(); fixture.closeAllConnections(); stall = false;
      const taskRoot = path.join(directory, 'state', 'resume-data', job.id);
      const metadata = JSON.parse(await readFile(path.join(directory, 'state', 'resume-jobs', `${job.id}.json`), 'utf8'));
      assert.equal(metadata.params.readMode, 'continuous');
      assert(!JSON.stringify(metadata).includes('BATCH_PRIVATE_URL'));
      const disk = JSON.parse(await readFile(path.join(taskRoot, 'manifest.json'), 'utf8'));
      assert.equal(disk.ranges.length, 4);
      assert(disk.ranges.every(range => range.length === MiB));
      assert.deepEqual((await readdir(taskRoot)).filter(name => name.endsWith('.bin')).sort(),
        Array.from({ length: 4 }, (_, index) => `${sourceStart + index * MiB}-${MiB}.bin`).sort());
      assert.equal(disk.reservations.reduce((sum, reservation) => sum + reservation.bytes, 0), 4 * MiB);

      const second = await backend(t, directory), restored = await second.api(`/api/jobs/${job.id}`);
      assert.notEqual(restored.status, 'running'); assert.equal(restored.readMode, 'continuous');
      assert.equal(restored.resume.readMode, 'continuous'); assert.equal(restored.resume.cachedBytes, 4 * MiB);
      assert.equal(restored.resume.uncertainBytes, 4 * MiB);
      assert.equal(restored.resume.budgetUsedBytes, disk.receivedBytes + 4 * MiB);
      const fresh = await second.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 32 });
      const replayStart = requests.length;
      const resumed = await second.api(`/api/jobs/${job.id}/resume`, { sourceId: fresh.sourceId, readMode: 'standard' });
      assert.equal(resumed.readMode, 'continuous', 'resume uses the committed task setting');
      const completed = await finish(second, job.id);
      assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
      assert.equal(completed.readMode, 'continuous'); assert.equal(completed.metrics.budgetBytes, 128 * MiB);
      assert(completed.metrics.receivedBytes > before.metrics.receivedBytes);
      assert(completed.metrics.receivedBytes <= completed.metrics.budgetBytes);
      const replay = requests.slice(replayStart);
      const mediaAt = replay.findIndex(call => call.start === sourceStart + 4 * MiB && call.end - call.start + 1 === 4 * MiB);
      assert(mediaAt >= 0, 'the target lease keeps using 4 MiB after restarting');
      assert(replay.slice(mediaAt).every(call => call.start >= sourceStart + 4 * MiB && call.end < sourceEnd),
        'committed target units must be reused, never downloaded again');
      assert.equal(byteSum(replay.slice(mediaAt)), targetBytes - 4 * MiB);
      assert.deepEqual(await packetRecords(completed.result.candidatePath), baseline.packets);
      await decode(completed.result.candidatePath);
      await second.close();
    });

    await t.test('parallel restart keeps two conservative reservations and reuses committed 1 MiB data', async () => {
      const directory = path.join(root, 'parallel-restart'), first = await backend(t, directory);
      const source = await first.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 32 });
      const control = targetControl('checkpoint-gate'); parallelControl = control;
      const job = await first.api('/api/jobs', { ...baseParams, sourceId: source.sourceId, readMode: 'parallel',
        budgetMiB: 128, outputDir: path.join(directory, 'saved') });
      const taskRoot = path.join(directory, 'state', 'resume-data', job.id);
      // The first complete unit must be durably committed. Hold the following
      // two responses so the crash point is defined by disk state, not timing.
      const committed = await eventually(async () => {
        let disk;
        try { disk = JSON.parse(await readFile(path.join(taskRoot, 'manifest.json'), 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return null; throw error; }
        return disk.ranges.length === 1 && disk.reservations.length === 2 && control.held.length === 2 ? disk : null;
      }, 'one committed target unit and two durable in-flight parallel reservations');
      assert.deepEqual(committed.ranges.map(({ offset, length }) => ({ offset, length })), [{ offset: sourceStart, length: MiB }]);
      assert.equal(committed.reservations.reduce((sum, item) => sum + item.bytes, 0), 2 * MiB);
      assert.equal(committed.receivedBytes, baseline.indexBytes + MiB);
      assert.equal(control.maxActive, 2);
      const before = await eventually(async () => {
        const current = await first.api(`/api/jobs/${job.id}`);
        return current.metrics.receivedBytes >= committed.receivedBytes + 2 * 65536 ? current : null;
      }, 'partial bodies of both held parallel requests');
      assert.equal(before.readMode, 'parallel'); assert.equal(before.resume.cachedBytes, MiB);
      assert.equal(before.resume.reservedBytes, 2 * MiB, 'durable crash reservations remain whole while partial bytes arrive');
      await first.kill(); fixture.closeAllConnections(); parallelControl = null;

      const metadata = JSON.parse(await readFile(path.join(directory, 'state', 'resume-jobs', `${job.id}.json`), 'utf8'));
      assert.equal(metadata.params.readMode, 'parallel'); assert(!JSON.stringify(metadata).includes('BATCH_PRIVATE_URL'));
      const disk = JSON.parse(await readFile(path.join(taskRoot, 'manifest.json'), 'utf8'));
      assert.deepEqual(disk.ranges, committed.ranges); assert.deepEqual(disk.reservations, committed.reservations);
      assert.deepEqual((await readdir(taskRoot)).filter(name => name.endsWith('.bin')), [`${sourceStart}-${MiB}.bin`]);
      const second = await backend(t, directory), restored = await second.api(`/api/jobs/${job.id}`);
      assert.notEqual(restored.status, 'running'); assert.equal(restored.readMode, 'parallel');
      assert.equal(restored.resume.readMode, 'parallel'); assert.equal(restored.resume.cachedBytes, MiB);
      assert.equal(restored.resume.uncertainBytes, 2 * MiB);
      assert.equal(restored.resume.reservedBytes, 0);
      assert.equal(restored.resume.budgetUsedBytes, disk.receivedBytes + 2 * MiB,
        'both unresolved ranges must remain fully charged after SIGKILL');
      const fresh = await second.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 32 });
      const replayStart = requests.length;
      const resumed = await second.api(`/api/jobs/${job.id}/resume`, { sourceId: fresh.sourceId, readMode: 'standard' });
      assert.equal(resumed.readMode, 'parallel', 'resume must honor the saved mode even if a different mode is submitted');
      const completed = await finish(second, job.id);
      assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
      assert.equal(completed.readMode, 'parallel'); assert.equal(completed.metrics.budgetBytes, 128 * MiB);
      const replay = requests.slice(replayStart), split = splitParallel(replay, MiB, { recheck: false });
      assert.deepEqual(geometry(split.index), baseline.indexCalls);
      assert.equal(byteSum(split.media), targetBytes - MiB);
      assert(split.media.every(call => call.start >= sourceStart + MiB), 'the durably committed first unit must never be downloaded again');
      assert.equal(completed.metrics.receivedBytes, disk.receivedBytes + baseline.indexBytes + targetBytes - MiB);
      assert(completed.metrics.receivedBytes <= completed.metrics.budgetBytes);
      assert.deepEqual(await packetRecords(completed.result.candidatePath), baseline.packets);
      await decode(completed.result.candidatePath);
      await second.close();
    });

    await t.test('continuous input for a local file resolves to standard and leaves legacy local extraction working', async () => {
      const directory = path.join(root, 'local'), app = await backend(t, directory);
      const source = await app.api('/api/probe', { source: { type: 'local', value: video } });
      const created = await app.api('/api/jobs', { ...baseParams, end: 5, sourceId: source.sourceId, readMode: 'continuous',
        outputDir: path.join(directory, 'saved') });
      assert.equal(created.readMode, 'standard');
      const completed = await finish(app, created.id);
      assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
      assert.equal(completed.readMode, 'standard');
      assert.equal(completed.metrics.receivedBytes, 0);
      await decode(completed.result.candidatePath);
      await app.close();
    });

    await t.test('continuous source without a strong ETag cannot reset the budget when switching target leases', async () => {
      const directory = path.join(root, 'no-etag'), app = await backend(t, directory);
      const noEtagValue = `http://127.0.0.1:${fixture.address().port}/no-etag.mkv`;
      const source = await app.api('/api/probe', { source: { type: 'http', value: noEtagValue }, budgetMiB: 32 });
      const cap = targetBytes + Math.floor(baseline.indexBytes / 2);
      assert(targetBytes <= cap && targetBytes > cap - baseline.indexBytes);
      const requestStart = requests.length;
      const created = await app.api('/api/jobs', { ...baseParams, sourceId: source.sourceId, readMode: 'continuous',
        budgetMiB: cap / MiB, outputDir: path.join(directory, 'saved') });
      const completed = await finish(app, created.id);
      assert.equal(completed.status, 'failed'); assert.equal(completed.error.code, 'BUDGET_EXCEEDED');
      assert.equal(completed.metrics.budgetBytes, cap);
      assert.equal(completed.metrics.receivedBytes, baseline.indexBytes);
      assert.deepEqual(geometry(requests.slice(requestStart + 1)), baseline.indexCalls,
        'missing-only preflight must subtract bytes already consumed by the first lease even without a resume store');
      assert.equal(completed.resume.available, false);
      assert.equal(completed.resume.reason, 'no_strong_etag');
      await app.close();
    });

    await t.test('parallel mode rejects a source without a strong ETag before scheduling or reading media', async () => {
      const directory = path.join(root, 'parallel-no-etag'), app = await backend(t, directory);
      const noEtagValue = `http://127.0.0.1:${fixture.address().port}/no-etag.mkv`;
      const source = await app.api('/api/probe', { source: { type: 'http', value: noEtagValue }, budgetMiB: 32 });
      const before = requests.length;
      const rejected = await app.api('/api/jobs', { ...baseParams, sourceId: source.sourceId, readMode: 'parallel',
        budgetMiB: 128, outputDir: path.join(directory, 'saved') }, { allowError: true });
      assert.equal(rejected.error.code, 'READ_MODE_UNAVAILABLE');
      assert.equal(requests.length, before, 'rejecting an unavailable mode must not dispatch source, index or target reads');
      await app.close();
    });
  } finally {
    t.after(() => rm(root, { recursive: true, force: true }));
  }
});
