import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { remoteTelemetry, remoteReadTimings } from './remote.mjs';

const MIB = 1024 * 1024;
const HEAD_BYTES = 16 * 1024;
const PLANNED_BYTES = 8 * MIB + HEAD_BYTES;
// Retain the diagnostic's historical meter ceiling for report compatibility.
// In-memory reservations now cover only bytes still to arrive; the fixed plan
// below continues to dispatch exactly 8 MiB + 16 KiB, independently of the cap.
const METER_BYTES = 12 * MIB;
const TIMEOUT_MS = 8 * 60 * 1000;
const ORDER = Object.freeze(['serial', 'parallel', 'parallel', 'serial']);
const POSITIONS = Object.freeze([0.1, 0.3, 0.6, 0.8]);
const MINIMUM_SOURCE_BYTES = 32 * MIB;
const MINIMUM_WINDOW_GAP_BYTES = 4 * MIB;
const FAST_SAMPLE_MS = 100;
const OPTION_KEYS = new Set(['remote', 'signal', 'onProgress', 'timeoutMs']);
const HASH = /^[a-f0-9]{64}$/;
const ERROR_CODES = new Set(['CANCELLED', 'TIMEOUT', 'SOURCE_CHANGED', 'RANGE_UNSUPPORTED',
  'RANGE_INVALID', 'AUTH_REQUIRED', 'REMOTE_HTTP', 'BUDGET_EXCEEDED',
  'RESUME_IDENTITY_UNAVAILABLE']);
const limitations = Object.freeze(['file_positions_uncontrolled', 'upstream_cache_uncontrolled',
  'non_overlapping_does_not_prove_cold_cache', 'prefetch_uncontrolled',
  'network_uncontrolled', 'upstream_bytes_unknown', 'byte_position_not_movie_time',
  'sample_hashes_record_content_not_independent_source_authenticity',
  'short_samples_and_order_effect_not_proof_of_cache_or_speed_gain',
  'diagnostic_only_no_download_strategy_change']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
const elapsed = start => Math.max(0, Math.round(performance.now() - start));
function fail(code) { const error = new Error(code); error.code = code; return error; }

function sampleWindows(size) {
  if (!Number.isSafeInteger(size) || size < MINIMUM_SOURCE_BYTES) return null;
  const windows = POSITIONS.map((positionFraction, i) => {
    const start = Math.floor(size * positionFraction);
    return { index: i + 1, start, endExclusive: start + 2 * MIB, positionFraction };
  });
  for (let i = 0; i < windows.length; i++) {
    const window = windows[i];
    if (!Number.isSafeInteger(window.start) || !Number.isSafeInteger(window.endExclusive)
        || window.start < HEAD_BYTES || window.endExclusive > size
        || i > 0 && window.start - windows[i - 1].endExclusive < MINIMUM_WINDOW_GAP_BYTES) return null;
  }
  return windows;
}

/** Availability is local only: no network, URL, credentials or cloud metadata. */
export function transferCheckAvailability(remote) {
  const identity = remote?.resumeIdentity;
  return sampleWindows(remote?.size) !== null
    && typeof remote.createLease === 'function' && identity?.size === remote.size
    && typeof identity.etagSha256 === 'string' && HASH.test(identity.etagSha256)
    && typeof identity.headSha256 === 'string' && HASH.test(identity.headSha256);
}

/**
 * A finite diagnostic, never a download policy. Each ABBA round reads a distinct
 * pair of adjacent 1 MiB slices. Non-overlap does not establish a cold cache.
 * Timings include a whole round's wall time;
 * parallel HTTP requests do not promise independent physical connections.
 */
export async function runTransferCheck(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
      || Reflect.ownKeys(options).some(key => !OPTION_KEYS.has(key))) {
    throw fail('TRANSFER_CHECK_OPTIONS_INVALID');
  }
  const { remote, signal, onProgress, timeoutMs = TIMEOUT_MS } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 25 || timeoutMs > TIMEOUT_MS
      || (signal !== undefined && !(signal instanceof AbortSignal))
      || (onProgress !== undefined && typeof onProgress !== 'function')) {
    throw fail('TRANSFER_CHECK_OPTIONS_INVALID');
  }
  if (!transferCheckAvailability(remote)) throw fail('TRANSFER_CHECK_UNAVAILABLE');

  const expectedHeadSha256 = remote.resumeIdentity.headSha256;
  const startedAt = performance.now();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const windows = sampleWindows(remote.size);
  const rounds = ORDER.map((mode, i) => ({ index: i + 1, mode, status: 'not_started',
    start: windows[i].start, endExclusive: windows[i].endExclusive,
    elapsedMs: 0, receivedBytes: 0, requestCount: 0, throughputBytesPerSecond: null,
    veryShortSample: false, hashes: [], requestSequences: [] }));
  let lease, timer, progressTimer, timedOut = false, errorCode = null, currentRound = null;
  let status = 'running', phase = 'checking_head', roundStartedAt = 0, roundBefore = null;
  let headChecked = false;
  let headSequenceEnd = null;
  const sequenceBounds = new Map();
  const sequenceCount = () => remoteTelemetry(lease?.metrics)?.requestsStarted ?? null;
  const liveCounts = telemetry => telemetry ? Object.fromEntries([
    'waitingResponseRequests', 'waitingFirstDataRequests', 'receivingRequests', 'waitingMoreDataRequests',
  ].map(key => [key, count(telemetry[key])])) : null;
  const metrics = () => {
    const telemetry = remoteTelemetry(lease?.metrics);
    return { elapsedMs: elapsed(startedAt),
    receivedBytes: count(lease?.metrics?.receivedBytes), requestCount: count(lease?.metrics?.requests),
    activeRequests: telemetry?.activeRequests ?? 0, liveWaitCounts: liveCounts(telemetry),
    reservedBytes: count(lease?.metrics?.reservedBytes), plannedBytes: PLANNED_BYTES,
    maxBytes: METER_BYTES, upstreamBytes: null, unknownUpstream: true };
  };
  function notify(nextPhase = phase) {
    phase = nextPhase;
    if (!onProgress) return;
    const m = metrics();
    const event = Object.freeze({ phase, roundIndex: currentRound?.index ?? 0,
      mode: currentRound?.mode ?? 'none', receivedBytes: m.receivedBytes,
      requestCount: m.requestCount, completedRounds: rounds.filter(r => r.status === 'completed').length,
      plannedBytes: PLANNED_BYTES, maxBytes: METER_BYTES, elapsedMs: m.elapsedMs,
      liveWaitCounts: m.liveWaitCounts ? Object.freeze({ ...m.liveWaitCounts }) : null });
    try { Promise.resolve(onProgress(event)).catch(() => {}); } catch { /* Observation cannot change a diagnostic. */ }
  }
  const checkAbort = () => { if (combined.aborted) throw fail('CANCELLED'); };
  function finishRound(roundStatus) {
    if (!currentRound || currentRound.status !== 'running') return;
    const m = metrics();
    currentRound.status = roundStatus;
    currentRound.elapsedMs = elapsed(roundStartedAt);
    currentRound.receivedBytes = Math.max(0, m.receivedBytes - roundBefore.receivedBytes);
    currentRound.requestCount = Math.max(0, m.requestCount - roundBefore.requestCount);
    const bounds = sequenceBounds.get(currentRound.index);
    if (bounds) bounds.through = sequenceCount();
    // Failed partial responses retain counters, but are not throughput samples.
    if (roundStatus === 'completed') {
      const duration = Math.max(1, performance.now() - roundStartedAt);
      currentRound.throughputBytesPerSecond = 2 * MIB * 1000 / duration;
      currentRound.veryShortSample = duration < FAST_SAMPLE_MS;
    }
  }
  async function readHash(offset, length) {
    checkAbort();
    let data = await lease.read(offset, length, combined, { maxAttempts: 1 });
    if (!Buffer.isBuffer(data) || data.length !== length) throw fail('RANGE_INVALID');
    const hash = sha(data);
    data = null;
    checkAbort();
    return hash;
  }
  try {
    timer = setTimeout(() => { timedOut = true; controller.abort(); lease?.close(); }, timeoutMs);
    timer.unref?.();
    checkAbort();
    lease = remote.createLease({ budgetBytes: METER_BYTES, signal: combined, requireStrongValidator: true });
    notify('checking_head');
    progressTimer = setInterval(() => notify(), 500);
    progressTimer.unref?.();
    const headHash = await readHash(0, HEAD_BYTES);
    headSequenceEnd = sequenceCount();
    if (headHash !== expectedHeadSha256) throw fail('SOURCE_CHANGED');
    headChecked = true;
    for (const round of rounds) {
      checkAbort();
      currentRound = round;
      round.status = 'running';
      roundStartedAt = performance.now();
      roundBefore = metrics();
      sequenceBounds.set(round.index, { after: sequenceCount(), through: null });
      notify('round_started');
      phase = 'reading';
      let hashes;
      if (round.mode === 'serial') {
        hashes = [await readHash(round.start, MIB), await readHash(round.start + MIB, MIB)];
      } else {
        const reads = [readHash(round.start, MIB), readHash(round.start + MIB, MIB)];
        try { hashes = await Promise.all(reads); }
        catch (error) {
          controller.abort(); lease.close();
          await Promise.allSettled(reads);
          throw error;
        }
      }
      round.hashes = hashes;
      finishRound('completed');
      notify('round_completed');
    }
    status = 'completed';
  } catch (error) {
    const cancelled = signal?.aborted === true;
    status = cancelled ? 'cancelled' : 'failed';
    errorCode = cancelled ? 'CANCELLED' : timedOut ? 'TIMEOUT'
      : ERROR_CODES.has(error?.code) ? error.code : 'REMOTE_HTTP';
    controller.abort();
    lease?.close();
  } finally {
    clearTimeout(timer); clearInterval(progressTimer);
    // settle() aborts and awaits all pending strict reads, including a sibling
    // which was still in flight when one parallel response failed.
    await lease?.settle();
    finishRound(status === 'cancelled' ? 'cancelled' : 'failed');
    if (headSequenceEnd === null && currentRound === null) headSequenceEnd = sequenceCount();
  }
  notify('settled');
  // A Range read attempt may include a redirect chain. Link by dispatch
  // sequence after all reads settle, never by completion order or timing sums.
  const requestTimings = remoteReadTimings(lease?.metrics);
  const sequencesBetween = (after, through) => requestTimings && after !== null && through !== null
    ? requestTimings.requests.filter(item => item.sequence > after && item.sequence <= through).map(item => item.sequence) : [];
  const headRequestSequences = sequencesBetween(0, headSequenceEnd);
  for (const round of rounds) {
    const bounds = sequenceBounds.get(round.index);
    if (bounds) round.requestSequences = sequencesBetween(bounds.after, bounds.through);
  }
  const serialSamples = rounds.filter(r => r.status === 'completed' && r.mode === 'serial').map(r => r.throughputBytesPerSecond);
  const parallelSamples = rounds.filter(r => r.status === 'completed' && r.mode === 'parallel').map(r => r.throughputBytesPerSecond);
  const completed = index => rounds[index].status === 'completed' ? rounds[index].elapsedMs : null;
  const ratio = (a, b) => completed(a) === null || completed(b) === null ? null
    : Math.max(completed(a), completed(b)) / Math.max(1, Math.min(completed(a), completed(b)));
  const delta = (a, b) => completed(a) === null || completed(b) === null ? null : completed(b) - completed(a);
  const serialRatio = ratio(0, 3), parallelRatio = ratio(1, 2);
  const serialDelta = delta(0, 3), parallelDelta = delta(1, 2);
  const differingModes = [];
  if (serialRatio >= 4 && Math.abs(serialDelta) >= 1000) differingModes.push('serial');
  if (parallelRatio >= 4 && Math.abs(parallelDelta) >= 1000) differingModes.push('parallel');
  const veryShortSampleRounds = rounds.filter(r => r.veryShortSample).map(r => r.index);
  const reasons = [];
  if (differingModes.length) reasons.push('large_same_mode_elapsed_difference');
  if (veryShortSampleRounds.length) reasons.push('very_short_samples');
  return {
    schemaVersion: 3, status, errorCode, comparison: 'controlled_comparison_only', conclusion: 'inconclusive',
    sampling: { strategy: 'non_overlapping_ranges', windows, chunkBytes: MIB, bytesPerRound: 2 * MIB,
      minimumWindowGapBytes: MINIMUM_WINDOW_GAP_BYTES, minimumSourceBytes: MINIMUM_SOURCE_BYTES,
      roundCount: 4, order: [...ORDER] },
    rounds, metrics: metrics(), headRequestSequences, requestTimings,
    integrity: { headChecked, rangesVerified: headChecked && rounds.every(r => r.status === 'completed'),
      sampleHashes: rounds.map(r => r.hashes.slice()) },
    throughput: { serialSamples, parallelSamples, serialMedianBytesPerSecond: null,
      parallelMedianBytesPerSecond: null },
    orderEffect: { firstSerialElapsedMs: completed(0), lastSerialElapsedMs: completed(3),
      firstParallelElapsedMs: completed(1), lastParallelElapsedMs: completed(2),
      serialElapsedDeltaMs: serialDelta, parallelElapsedDeltaMs: parallelDelta,
      serialElapsedRatio: serialRatio, parallelElapsedRatio: parallelRatio,
      flagged: reasons.length > 0, reasons, differingModes, veryShortSampleRounds,
      thresholds: { sameModeElapsedRatio: 4, sameModeElapsedDeltaMs: 1000, veryShortSampleMs: FAST_SAMPLE_MS } },
    limitations: [...limitations],
  };
}
