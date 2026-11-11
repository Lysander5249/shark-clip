import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRemoteSource } from '../src/remote.mjs';
import { transferCheckAvailability, runTransferCheck } from '../src/transfer-check.mjs';

const MIB = 1024 * 1024, HEAD = 16384, PLAN = 8 * MIB + HEAD;
const OPTIONS = { timeout: 10000 };
const BYTES = Buffer.alloc(32 * MIB + 321);
for (let i = 0; i < BYTES.length; i++) BYTES[i] = (i * 13 + Math.floor(i / 1024)) % 251;
const sha = b => createHash('sha256').update(b).digest('hex');

async function fixture(t, options = {}) {
  const state = { mode: 'valid', active: 0, maxActive: 0, starts: [], ends: [],
    requests: [], mediaReads: 0, closed: 0, etag: '"safe-fixture-v1"' };
  const bytes = options.bytes ?? BYTES;
  const server = http.createServer((req, res) => {
    state.active++; state.maxActive = Math.max(state.active, state.maxActive);
    res.once('close', () => { state.active--; state.closed++; state.ends.push(state.active); });
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    state.requests.push({ range: req.headers.range, ifMatch: req.headers['if-match'],
      method: req.method, acceptEncoding: req.headers['accept-encoding'] });
    if (!match) { res.writeHead(400).end(); return; }
    const start = Number(match[1]), end = Number(match[2]);
    state.starts.push(start);
    if (start < 0 || end >= bytes.length || end < start) { res.writeHead(416).end(); return; }
    const isBootstrap = state.requests.length === 1;
    if (!isBootstrap && req.headers['if-match'] !== state.etag) { res.writeHead(412).end(); return; }
    if (!isBootstrap && start !== 0) state.mediaReads++;
    const mode = isBootstrap ? 'valid' : options.modeFor?.({ start, end, state }) ?? state.mode;
    if (mode === 'version-changed') { res.writeHead(412).end(); return; }
    if (mode === 'ignore-range') { res.writeHead(200, { ETag: state.etag }).end(bytes); return; }
    const data = Buffer.from(bytes.subarray(start, end + 1));
    if (mode === 'changed-content' || mode === 'changed-head') data[0] ^= 255;
    const headers = { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
      'Content-Length': data.length, ETag: mode === 'missing-etag' ? undefined : state.etag,
      'Content-Type': 'application/octet-stream' };
    if (headers.ETag === undefined) delete headers.ETag;
    if (mode === 'wrong-range') headers['Content-Range'] = `bytes ${start + 1}-${end}/${bytes.length}`;
    if (mode === 'overlong') delete headers['Content-Length'];
    res.writeHead(206, headers);
    if (mode === 'no-first-data') { res.flushHeaders(); return; }
    if (mode === 'stall') { res.flushHeaders(); res.write(data.subarray(0, 128)); return; }
    if (mode === 'truncate') {
      res.flushHeaders(); res.write(data.subarray(0, 128));
      setTimeout(() => res.destroy(), 5); return;
    }
    if (mode === 'overlong') { res.end(Buffer.concat([data, Buffer.alloc(31)])); return; }
    const finish = () => res.end(data);
    if (!isBootstrap && start !== 0 && options.delayMedia) setTimeout(finish, options.delayMedia);
    else finish();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const remote = await createRemoteSource({ url: `http://127.0.0.1:${server.address().port}/SECRET-URL?token=DO-NOT-LEAK`,
    username: 'SECRET-ACCOUNT', password: 'SECRET-PASSWORD', budgetBytes: HEAD,
    initialRanges: 'head', requestTimeoutMs: options.requestTimeoutMs ?? 1000 });
  function reset() { state.requests.length = 0; state.starts.length = 0; state.mediaReads = 0; state.maxActive = 0; }
  // Keep the bootstrap in requests for mode selection and strict If-Match checks.
  return { state, bytes, remote, server, reset };
}
function settled(report) {
  assert.equal(report.schemaVersion, 3);
  assert.equal(report.sampling.strategy, 'non_overlapping_ranges');
  assert.equal(report.metrics.activeRequests, 0);
  assert.equal(report.metrics.reservedBytes, 0);
  assert.equal(report.metrics.unknownUpstream, true);
  assert.equal(report.metrics.upstreamBytes, null);
  assert.equal(report.metrics.plannedBytes, PLAN);
  assert.equal(report.metrics.maxBytes, 12 * MIB);
  assert.equal(report.conclusion, 'inconclusive');
  assert.equal(report.comparison, 'controlled_comparison_only');
  assert.equal(report.integrity.rangesVerified, report.status === 'completed');
  assert.equal(report.integrity.sampleHashes.length, 4);
  assert.deepEqual(report.integrity.sampleHashes, report.rounds.map(round => round.hashes));
  assert(!JSON.stringify(report).includes('SECRET'));
  assert(!JSON.stringify(report).includes('http:'));
}

test('ABBA reads four exact non-overlapping windows once, with a fresh strong head and one finite shared meter', OPTIONS, async t => {
  const f = await fixture(t, { delayMedia: 10 });
  assert.equal(transferCheckAvailability(f.remote), true);
  const events = [];
  const report = await runTransferCheck({ remote: f.remote, onProgress: e => events.push(e) });
  settled(report);
  assert.equal(report.status, 'completed'); assert.equal(report.errorCode, null);
  assert.equal(report.metrics.receivedBytes, PLAN); assert.equal(report.metrics.requestCount, 9);
  assert.deepEqual(report.rounds.map(r => r.mode), ['serial', 'parallel', 'parallel', 'serial']);
  assert.deepEqual(report.rounds.map(r => r.status), Array(4).fill('completed'));
  const expectedWindows = [0.1, 0.3, 0.6, 0.8].map((positionFraction, i) => {
    const start = Math.floor(f.bytes.length * positionFraction);
    return { index: i + 1, start, endExclusive: start + 2 * MIB, positionFraction };
  });
  assert.deepEqual(report.sampling.windows, expectedWindows);
  assert.equal(report.sampling.minimumSourceBytes, 32 * MIB);
  assert.equal(report.sampling.minimumWindowGapBytes, 4 * MIB);
  assert(!Object.hasOwn(report.sampling, 'positionFraction'));
  assert(!Object.hasOwn(report.sampling, 'start'));
  const expectedRanges = [`bytes=0-${HEAD - 1}`];
  for (const { start } of expectedWindows) expectedRanges.push(`bytes=${start}-${start + MIB - 1}`, `bytes=${start + MIB}-${start + 2 * MIB - 1}`);
  assert.deepEqual(f.state.requests.slice(1).map(r => r.range), expectedRanges);
  assert.equal(new Set(expectedRanges).size, 9, 'this run never repeats a requested range');
  for (const request of f.state.requests.slice(1)) {
    assert.equal(request.ifMatch, '"safe-fixture-v1"'); assert.equal(request.method, 'GET'); assert.equal(request.acceptEncoding, 'identity');
  }
  assert.equal(f.state.maxActive, 2, 'the fixture observes exactly two simultaneous requests, never more');
  for (const [i, round] of report.rounds.entries()) {
    assert.equal(round.receivedBytes, 2 * MIB); assert.equal(round.requestCount, 2);
    assert.equal(round.hashes.length, 2); assert(round.throughputBytesPerSecond > 0);
    assert.equal(round.start, expectedWindows[i].start); assert.equal(round.endExclusive, expectedWindows[i].endExclusive);
  }
  assert.deepEqual(report.integrity, { headChecked: true, rangesVerified: true,
    sampleHashes: expectedWindows.map(({ start }) => [sha(f.bytes.subarray(start, start + MIB)), sha(f.bytes.subarray(start + MIB, start + 2 * MIB))]) });
  assert(new Set(report.integrity.sampleHashes.map(hashes => hashes.join(':'))).size > 1, 'different source windows need not have equal content');
  assert.equal(report.throughput.serialSamples.length, 2); assert.equal(report.throughput.parallelSamples.length, 2);
  assert.equal(report.throughput.serialMedianBytesPerSecond, null);
  assert.equal(report.throughput.parallelMedianBytesPerSecond, null);
  assert.equal(report.orderEffect.firstSerialElapsedMs, report.rounds[0].elapsedMs);
  assert.equal(report.orderEffect.lastSerialElapsedMs, report.rounds[3].elapsedMs);
  assert.equal(report.orderEffect.firstParallelElapsedMs, report.rounds[1].elapsedMs);
  assert.equal(report.orderEffect.lastParallelElapsedMs, report.rounds[2].elapsedMs);
  assert.equal(report.orderEffect.serialElapsedDeltaMs, report.rounds[3].elapsedMs - report.rounds[0].elapsedMs);
  assert.equal(report.orderEffect.parallelElapsedDeltaMs, report.rounds[2].elapsedMs - report.rounds[1].elapsedMs);
  assert(!report.limitations.includes('repeated_same_ranges'));
  assert(report.limitations.includes('file_positions_uncontrolled'));
  assert(report.limitations.includes('non_overlapping_does_not_prove_cold_cache'));
  assert(report.limitations.includes('prefetch_uncontrolled'));
  assert(report.limitations.includes('upstream_cache_uncontrolled'));
  assert.equal(events.at(-1).phase, 'settled');
  for (const event of events) {
    assert(Object.isFrozen(event));
    assert.deepEqual(Object.keys(event).sort(), ['phase', 'roundIndex', 'mode', 'receivedBytes', 'requestCount',
      'completedRounds', 'plannedBytes', 'maxBytes', 'elapsedMs', 'liveWaitCounts'].sort());
    assert(['checking_head', 'round_started', 'reading', 'round_completed', 'settled'].includes(event.phase));
    assert(!JSON.stringify(event).includes('SECRET'));
  }
});

test('windows stay inside the source and retain at least four MiB between them at the minimum eligible size', OPTIONS, async t => {
  for (const bytes of [BYTES, BYTES.subarray(0, 32 * MIB)]) {
    await t.test(`${bytes.length}`, async t => {
      const f = await fixture(t, { bytes });
      const r = await runTransferCheck({ remote: f.remote }); settled(r);
      assert.equal(r.status, 'completed');
      for (const [i, window] of r.sampling.windows.entries()) {
        assert(Number.isSafeInteger(window.start) && Number.isSafeInteger(window.endExclusive));
        assert(window.start >= HEAD); assert(window.endExclusive <= bytes.length);
        assert.equal(window.endExclusive - window.start, 2 * MIB);
        if (i) assert(window.start - r.sampling.windows[i - 1].endExclusive >= 4 * MIB);
      }
    });
  }
});

test('timing warnings flag only qualifying same-mode differences or very short completed samples, never a speed verdict', OPTIONS, async t => {
  for (const [name, durations, differingModes, veryShortSampleRounds] of [
    ['serial ratio threshold', [4000, 1200, 1200, 1000], ['serial'], []],
    ['parallel threshold with nonqualifying serial difference', [1300, 2000, 500, 400], ['parallel'], []],
    ['ratio below four', [1300, 1200, 1200, 400], [], []],
    ['difference below one second', [400, 200, 200, 100], [], []],
    ['short sample threshold', [1000, 99, 100, 1000], [], [2]],
  ]) await t.test(name, async t => {
    // Control only the monotonic clock for report threshold boundaries. Range,
    // protocol, concurrency, timeout and cleanup behavior use HTTP fixtures below.
    let now = 0;
    t.mock.method(performance, 'now', () => now);
    const remote = {
      size: BYTES.length,
      resumeIdentity: { size: BYTES.length, etagSha256: sha(Buffer.from('timing-fixture')), headSha256: sha(BYTES.subarray(0, HEAD)) },
      createLease({ budgetBytes, requireStrongValidator }) {
        assert.equal(budgetBytes, 12 * MIB); assert.equal(requireStrongValidator, true);
        const metrics = { receivedBytes: 0, requests: 0, reservedBytes: 0 };
        return { metrics, async read(start, length, signal, options) {
          assert.equal(options.maxAttempts, 1); assert.equal(signal.aborted, false);
          if (start) {
            const index = [0.1, 0.3, 0.6, 0.8].findIndex(fraction => {
              const offset = Math.floor(BYTES.length * fraction);
              return start === offset || start === offset + MIB;
            });
            assert(index >= 0); now += durations[index] / 2;
          } else now += 5;
          metrics.receivedBytes += length; metrics.requests++;
          return Buffer.from(BYTES.subarray(start, start + length));
        }, close() {}, async settle() {} };
      },
    };
    const r = await runTransferCheck({ remote }); settled(r);
    assert.equal(r.status, 'completed'); assert.equal(r.conclusion, 'inconclusive');
    assert.deepEqual(r.rounds.map(round => round.elapsedMs), durations);
    assert.deepEqual(r.orderEffect.differingModes, differingModes);
    assert.deepEqual(r.orderEffect.veryShortSampleRounds, veryShortSampleRounds);
    assert.deepEqual(r.rounds.filter(round => round.veryShortSample).map(round => round.index), veryShortSampleRounds);
    assert.equal(r.orderEffect.flagged, differingModes.length + veryShortSampleRounds.length > 0);
    assert.deepEqual(r.orderEffect.reasons, [
      ...(differingModes.length ? ['large_same_mode_elapsed_difference'] : []),
      ...(veryShortSampleRounds.length ? ['very_short_samples'] : []),
    ]);
    assert.deepEqual(r.orderEffect.thresholds, { sameModeElapsedRatio: 4, sameModeElapsedDeltaMs: 1000, veryShortSampleMs: 100 });
    assert.equal(r.throughput.serialMedianBytesPerSecond, null);
    assert.equal(r.throughput.parallelMedianBytesPerSecond, null);
    assert(r.limitations.includes('short_samples_and_order_effect_not_proof_of_cache_or_speed_gain'));
  });
});

test('local availability and invalid options cannot dispatch requests', OPTIONS, async t => {
  const f = await fixture(t); const before = f.state.requests.length;
  for (const remote of [null, {}, { ...f.remote, size: 2 * MIB }, { ...f.remote, size: 32 * MIB - 1 }, { ...f.remote, size: Infinity },
    { ...f.remote, size: Number.MAX_SAFE_INTEGER + 1 }, { ...f.remote, resumeIdentity: null },
    { ...f.remote, resumeIdentity: { ...f.remote.resumeIdentity, size: 12 } },
    { ...f.remote, resumeIdentity: { ...f.remote.resumeIdentity, etagSha256: 'W/weak' } },
    { ...f.remote, resumeIdentity: { ...f.remote.resumeIdentity, headSha256: 'invalid' } },
    { ...f.remote, createLease: null }]) {
    assert.equal(transferCheckAvailability(remote), false);
    await assert.rejects(runTransferCheck({ remote }), { code: 'TRANSFER_CHECK_UNAVAILABLE' });
  }
  for (const positionFraction of [undefined, 0, 0.5, -1, 1.00001, Infinity, NaN, '0.5', null, {}, Number.MAX_SAFE_INTEGER])
    await assert.rejects(runTransferCheck({ remote: f.remote, positionFraction }), { code: 'TRANSFER_CHECK_OPTIONS_INVALID' });
  for (const unknown of [{ concurrency: 2 }, { repeat: false }, { budgetBytes: PLAN }, { unused: undefined }, { [Symbol('unknown')]: true }])
    await assert.rejects(runTransferCheck({ remote: f.remote, ...unknown }), { code: 'TRANSFER_CHECK_OPTIONS_INVALID' });
  for (const invalid of [null, [], 1, 'input', Object.create({ positionFraction: 0.5 })])
    await assert.rejects(runTransferCheck(invalid), { code: 'TRANSFER_CHECK_OPTIONS_INVALID' });
  for (const timeoutMs of [0, 24, 480001, 1e10, Infinity, '100', 30.5, null])
    await assert.rejects(runTransferCheck({ remote: f.remote, timeoutMs }), { code: 'TRANSFER_CHECK_OPTIONS_INVALID' });
  await assert.rejects(runTransferCheck({ remote: f.remote, signal: {} }), { code: 'TRANSFER_CHECK_OPTIONS_INVALID' });
  await assert.rejects(runTransferCheck({ remote: f.remote, onProgress: 'bad' }), { code: 'TRANSFER_CHECK_OPTIONS_INVALID' });
  assert.equal(f.state.requests.length, before);
});

test('fresh head mismatch stops before any media range even under the same ETag', OPTIONS, async t => {
  const f = await fixture(t); f.state.mode = 'changed-head';
  const r = await runTransferCheck({ remote: f.remote }); settled(r);
  assert.equal(r.status, 'failed'); assert.equal(r.errorCode, 'SOURCE_CHANGED');
  assert.equal(r.metrics.requestCount, 1); assert.equal(r.metrics.receivedBytes, HEAD);
  assert.equal(r.integrity.headChecked, false); assert.equal(r.integrity.rangesVerified, false);
  assert.deepEqual(r.integrity.sampleHashes, [[], [], [], []]);
  assert(r.rounds.every(r => r.status === 'not_started'));
});

test('unsupported ranges, changed/missing validators and malformed/truncated responses never retry', OPTIONS, async t => {
  for (const [mode, errorCode] of [['ignore-range', 'RANGE_UNSUPPORTED'], ['version-changed', 'SOURCE_CHANGED'],
    ['missing-etag', 'SOURCE_CHANGED'], ['wrong-range', 'RANGE_INVALID'], ['truncate', 'RANGE_INVALID'], ['overlong', 'RANGE_INVALID']]) {
    await t.test(mode, async t => {
      const f = await fixture(t); f.state.mode = mode;
      const r = await runTransferCheck({ remote: f.remote }); settled(r);
      assert.equal(r.status, 'failed'); assert.equal(r.errorCode, errorCode);
      assert.equal(r.metrics.requestCount, 1); assert.equal(f.state.requests.length, 2);
      assert(r.rounds.every(r => r.status === 'not_started'));
      assert(r.metrics.receivedBytes <= HEAD + 31);
    });
  }
});

test('partial failed media counts actual bytes and leaves incomplete round without a speed sample', OPTIONS, async t => {
  const f = await fixture(t, { modeFor: ({ start }) => start ? 'truncate' : 'valid' });
  const r = await runTransferCheck({ remote: f.remote }); settled(r);
  assert.equal(r.status, 'failed'); assert.equal(r.errorCode, 'RANGE_INVALID');
  assert.equal(r.rounds[0].status, 'failed'); assert.equal(r.rounds[0].receivedBytes, 128);
  assert.equal(r.rounds[0].requestCount, 1); assert.equal(r.rounds[0].throughputBytesPerSecond, null);
  assert.equal(r.metrics.receivedBytes, HEAD + 128); assert.equal(r.metrics.requestCount, 2);
  assert.deepEqual(r.throughput.serialSamples, []); assert.deepEqual(r.throughput.parallelSamples, []);
});

test('distinct windows can return different valid contents without a cross-window equality claim', OPTIONS, async t => {
  const f = await fixture(t, { modeFor: ({ start, state }) => start && state.mediaReads > 2 ? 'changed-content' : 'valid' });
  const r = await runTransferCheck({ remote: f.remote }); settled(r);
  assert.equal(r.status, 'completed'); assert.equal(r.errorCode, null);
  assert.equal(r.integrity.rangesVerified, true); assert(!Object.hasOwn(r.integrity, 'consistent'));
  assert.deepEqual(r.rounds.map(r => r.status), Array(4).fill('completed'));
  assert.notDeepEqual(r.rounds[0].hashes, r.rounds[1].hashes);
  for (const [i, window] of r.sampling.windows.entries()) {
    const expected = [f.bytes.subarray(window.start, window.start + MIB), f.bytes.subarray(window.start + MIB, window.endExclusive)]
      .map(data => { const copy = Buffer.from(data); if (i > 0) copy[0] ^= 255; return sha(copy); });
    assert.deepEqual(r.integrity.sampleHashes[i], expected, 'hashes describe returned content, not independent source authenticity');
  }
  assert.equal(r.metrics.requestCount, 9); assert.equal(r.metrics.receivedBytes, PLAN);
});

test('a failure in one parallel response aborts and settles its stalled sibling', OPTIONS, async t => {
  const f = await fixture(t, { modeFor: ({ start, state }) => {
    if (state.mediaReads <= 2 || start === 0) return 'valid';
    return state.mediaReads === 3 ? 'truncate' : 'stall';
  } });
  const r = await runTransferCheck({ remote: f.remote }); settled(r);
  assert.equal(r.status, 'failed'); assert.equal(r.errorCode, 'RANGE_INVALID');
  assert.deepEqual(r.rounds.map(r => r.status), ['completed', 'failed', 'not_started', 'not_started']);
  assert.equal(r.rounds[1].requestCount, 2);
  assert.equal(r.rounds[1].receivedBytes, 256);
  assert.equal(r.metrics.requestCount, 5);
  const terminal = f.state.requests.length;
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(f.state.active, 0); assert.equal(f.state.requests.length, terminal);
});

test('pre-cancellation, head cancellation and two-request cancellation return settled reports', OPTIONS, async t => {
  for (const cancelAt of ['before', 'head', 'parallel']) await t.test(cancelAt, async t => {
    const controller = new AbortController();
    const f = await fixture(t, { modeFor: ({ start, state }) =>
      cancelAt === 'head' && start === 0 || cancelAt === 'parallel' && state.mediaReads > 2 ? 'stall' : 'valid' });
    if (cancelAt === 'before') controller.abort();
    const operation = runTransferCheck({ remote: f.remote, signal: controller.signal });
    if (cancelAt !== 'before') {
      const target = cancelAt === 'head' ? 2 : 6;
      while (f.state.requests.length < target) await new Promise(resolve => setTimeout(resolve, 2));
      controller.abort();
    }
    const r = await operation; settled(r);
    assert.equal(r.status, 'cancelled'); assert.equal(r.errorCode, 'CANCELLED');
    assert(r.metrics.requestCount <= 5);
    if (cancelAt === 'before') assert.equal(r.metrics.requestCount, 0);
    if (cancelAt === 'parallel') {
      assert.equal(r.rounds[0].status, 'completed'); assert.equal(r.rounds[1].status, 'cancelled');
      assert.equal(r.rounds[1].requestCount, 2);
    }
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.state.active, 0);
  });
});

test('bounded overall timeout is a failure, and request idle timeout is not retried', OPTIONS, async t => {
  for (const [timeoutMs, requestTimeoutMs] of [[25, 1000], [1000, 25]]) await t.test(`${timeoutMs}/${requestTimeoutMs}`, async t => {
    const f = await fixture(t, { requestTimeoutMs }); f.state.mode = 'stall';
    const r = await runTransferCheck({ remote: f.remote, timeoutMs }); settled(r);
    assert.equal(r.status, 'failed'); assert.equal(r.errorCode, 'TIMEOUT');
    assert.equal(r.metrics.requestCount, 1); assert.equal(r.metrics.receivedBytes, 128);
  });
});

test('budget rejection stops without an extra HTTP request or lost completed sample', OPTIONS, async t => {
  const f = await fixture(t);
  const limited = { ...f.remote, createLease: options => f.remote.createLease({ ...options, budgetBytes: HEAD + 2 * MIB }) };
  const r = await runTransferCheck({ remote: limited }); settled(r);
  assert.equal(r.status, 'failed'); assert.equal(r.errorCode, 'BUDGET_EXCEEDED');
  assert.equal(r.metrics.receivedBytes, HEAD + 2 * MIB); assert.equal(r.metrics.requestCount, 3);
  assert.equal(r.rounds[0].status, 'completed'); assert.equal(r.rounds[1].status, 'failed');
  assert.equal(r.rounds[1].requestCount, 0); assert.equal(r.throughput.serialSamples.length, 1);
  assert.equal(r.throughput.serialMedianBytesPerSecond, null);
});

test('observer exceptions/rejections and raw transport messages cannot leak or alter results', OPTIONS, async t => {
  const f = await fixture(t); let calls = 0;
  const r = await runTransferCheck({ remote: f.remote, onProgress: () => {
    calls++; if (calls % 2) throw new Error('SECRET-PASSWORD');
    return Promise.reject(new Error('SECRET-URL'));
  } }); settled(r); assert.equal(r.status, 'completed'); assert(calls > 3);
  const broken = { ...f.remote, createLease: () => { throw Object.assign(new Error('SECRET-URL SECRET-PASSWORD'), { code: 'SECRET' }); } };
  const failed = await runTransferCheck({ remote: broken }); settled(failed);
  assert.equal(failed.status, 'failed'); assert.equal(failed.errorCode, 'REMOTE_HTTP');
});

test('request timelines link the fresh head and every round by dispatch sequence, not completion order', OPTIONS, async t => {
  const f = await fixture(t, { delayMedia: 5 });
  const report = await runTransferCheck({ remote: f.remote }); settled(report);
  const trace = report.requestTimings;
  assert.equal(trace.schemaVersion, 1); assert.equal(trace.droppedRequests, 0);
  assert.equal(trace.requestsRecorded, 9); assert.equal(trace.requests.length, 9);
  assert.deepEqual(trace.requests.map(read => read.sequence), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(report.headRequestSequences, [1]);
  assert.deepEqual(report.rounds.map(round => round.requestSequences), [[2, 3], [4, 5], [6, 7], [8, 9]]);
  for (const read of trace.requests) {
    assert.equal(read.outcome, 'completed'); assert.equal(read.terminalStage, 'completed');
    assert.equal(read.headersReceived, true); assert.equal(read.headersVerified, true);
    assert.equal(read.failureCode, null);
    assert.equal(read.receivedBytes, read.sequence === 1 ? HEAD : MIB);
    assert(read.responseWaitMs >= 0 && read.firstDataWaitMs >= 0 && read.bodyTransferMs >= 0);
  }
  assert.deepEqual(Object.values(report.metrics.liveWaitCounts), [0, 0, 0, 0]);
});

test('first-data waiting remains distinct in live diagnostics and survives cancellation without invented later requests', OPTIONS, async t => {
  const f = await fixture(t, { modeFor: ({ start }) => start === 0 ? 'valid' : 'no-first-data' });
  const controller = new AbortController(), events = [];
  const operation = runTransferCheck({ remote: f.remote, signal: controller.signal, onProgress(event) { events.push(event); } });
  const deadline = Date.now() + 2000;
  while (!events.some(event => event.liveWaitCounts?.waitingFirstDataRequests === 1)) {
    assert(Date.now() < deadline, 'first-data wait was not observed');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  controller.abort();
  const report = await operation; settled(report);
  assert.equal(report.status, 'cancelled'); assert.equal(report.requestTimings.requestsRecorded, 2);
  assert.deepEqual(report.headRequestSequences, [1]);
  assert.deepEqual(report.rounds.map(round => round.requestSequences), [[2], [], [], []]);
  const read = report.requestTimings.requests[1];
  assert.equal(read.outcome, 'failed'); assert.equal(read.failureCode, 'CANCELLED');
  assert.equal(read.terminalStage, 'waiting_first_data');
  assert.equal(read.headersReceived, true); assert.equal(read.headersVerified, true);
  assert.equal(read.receivedBytes, 0); assert(read.firstDataWaitMs >= 400);
  assert.equal(read.bodyTransferMs, null);
  assert.deepEqual(Object.values(report.metrics.liveWaitCounts), [0, 0, 0, 0]);
  assert(!JSON.stringify(report).includes('SECRET'));
});

test('a head hash mismatch keeps its successful Range timing while the diagnostic fails source validation', OPTIONS, async t => {
  const f = await fixture(t); f.state.mode = 'changed-head';
  const report = await runTransferCheck({ remote: f.remote }); settled(report);
  assert.equal(report.errorCode, 'SOURCE_CHANGED');
  assert.deepEqual(report.headRequestSequences, [1]);
  assert.equal(report.requestTimings.requests.length, 1);
  assert.equal(report.requestTimings.requests[0].outcome, 'completed');
  assert.equal(report.requestTimings.requests[0].headersVerified, true);
  assert(report.rounds.every(round => round.requestSequences.length === 0));
});
