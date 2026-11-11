import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createTransferGuard } from '../src/transfer-guard.mjs';

function clock(t) {
  let now = 0;
  t.mock.method(performance, 'now', () => now);
  t.mock.timers.enable({ apis: ['setInterval'] });
  return { tick(milliseconds) { now += milliseconds; t.mock.timers.tick(milliseconds); } };
}

test('actual byte growth keeps a slow transfer alive beyond the former 15-minute wall-clock limit', t => {
  const time = clock(t); let bytes = 0, samples = 0;
  const guard = createTransferGuard({ getActivity() { samples++; return bytes; } });
  t.after(guard.dispose);
  for (let minute = 0; minute < 40; minute++) {
    bytes += 1; // Slow but real progress, even below one complete media chunk.
    time.tick(60000);
    assert.equal(guard.signal.aborted, false);
    assert.equal(guard.stalled, false);
  }
  assert(samples > 40);
  guard.dispose();
  const stoppedSamples = samples;
  time.tick(24 * 60 * 60 * 1000);
  assert.equal(samples, stoppedSamples, 'dispose must remove the repeating timer');
  assert.equal(guard.signal.aborted, false, 'completion/disposal must not fabricate a transfer failure');
});

test('unchanged counters and callback frequency cannot keep a stalled transfer alive', t => {
  const time = clock(t); let callbacks = 0;
  const guard = createTransferGuard({ getActivity() { callbacks++; return 1250; } });
  t.after(guard.dispose);
  for (let elapsed = 0; elapsed < 119000; elapsed += 1000) time.tick(1000);
  assert.equal(guard.signal.aborted, false);
  time.tick(1000);
  assert.equal(guard.stalled, true);
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.signal.reason.code, 'TRANSFER_STALLED');
  assert(guard.signal.reason.message.startsWith('连续2分钟没有接收或写入新数据'));
  const stoppedSamples = callbacks;
  time.tick(120000);
  assert.equal(callbacks, stoppedSamples, 'the stall path must stop monitoring immediately');
});

test('invalid, decreasing and previously observed counts never reset the last real activity time', t => {
  const time = clock(t); let observation = 100;
  const guard = createTransferGuard({ getActivity: () => observation, stallTimeoutMs: 1000, pollIntervalMs: 100 });
  t.after(guard.dispose);
  for (const value of [NaN, Infinity, -1, 1.5, '101', null, {}, 99, 100]) {
    observation = value; time.tick(100);
    assert.equal(guard.signal.aborted, false);
  }
  observation = 0; time.tick(100);
  assert.equal(guard.stalled, true);
  assert.equal(guard.signal.reason.code, 'TRANSFER_STALLED');
  assert(guard.signal.reason.message.startsWith('连续1秒'));
});

test('activity greater than the high-water mark restarts only the inactivity window', t => {
  const time = clock(t); let bytes = 500;
  const guard = createTransferGuard({ getActivity: () => bytes, stallTimeoutMs: 1000, pollIntervalMs: 100 });
  t.after(guard.dispose);
  time.tick(900);
  bytes++; time.tick(100);
  assert.equal(guard.signal.aborted, false);
  time.tick(900);
  assert.equal(guard.signal.aborted, false);
  time.tick(100);
  assert.equal(guard.stalled, true);
});

test('parent cancellation is preserved and removes the activity timer without marking a stall', t => {
  const time = clock(t), parent = new AbortController(); let samples = 0;
  const guard = createTransferGuard({ signal: parent.signal, getActivity() { samples++; return 0; } });
  const reason = new Error('Fixture cancellation');
  parent.abort(reason);
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.signal.reason, reason);
  assert.equal(guard.stalled, false);
  const cancelledSamples = samples;
  time.tick(1200000);
  assert.equal(samples, cancelledSamples);
  guard.dispose(); guard.dispose();
});

test('pre-cancelled parents and disposed guards never query activity again', t => {
  const time = clock(t), parent = new AbortController(); parent.abort(); let samples = 0;
  const cancelled = createTransferGuard({ signal: parent.signal, getActivity() { samples++; return 0; } });
  assert.equal(samples, 0);
  assert.equal(cancelled.signal.reason, parent.signal.reason);
  const completed = createTransferGuard({ getActivity() { samples++; return 0; } });
  assert.equal(samples, 1);
  completed.dispose(); completed.dispose();
  time.tick(1200000);
  assert.equal(samples, 1);
  assert.equal(completed.signal.aborted, false);
});

test('observer exceptions stop safely, discard private exception details and clean the timer', t => {
  const time = clock(t); let fail = false, samples = 0;
  const guard = createTransferGuard({ getActivity() {
    samples++;
    if (fail) throw new Error('https://private.example.test/?token=fixture-private-token');
    return 0;
  } });
  fail = true; time.tick(1000);
  assert.equal(guard.signal.aborted, true);
  assert.equal(guard.stalled, false);
  assert.equal(guard.signal.reason.code, 'TRANSFER_ACTIVITY_UNAVAILABLE');
  assert(!String(guard.signal.reason.stack).includes('private.example.test'));
  const stoppedSamples = samples;
  time.tick(1200000);
  assert.equal(samples, stoppedSamples);
  const immediatelyFailed = createTransferGuard({ getActivity() { throw new Error('fixture secret'); } });
  assert.equal(immediatelyFailed.signal.aborted, true);
  assert.equal(immediatelyFailed.signal.reason.code, 'TRANSFER_ACTIVITY_UNAVAILABLE');
});

test('invalid guard options fail synchronously before observing or starting timers', t => {
  const time = clock(t); let samples = 0;
  const observer = () => { samples++; return 0; };
  for (const changed of [
    { signal: null }, { signal: {} }, { getActivity: null }, { getActivity: 1 },
    ...[0, -1, 0.5, NaN, Infinity, '120000', 86400001].map(stallTimeoutMs => ({ stallTimeoutMs })),
    ...[0, -1, 0.5, NaN, Infinity, '1000', 86400001].map(pollIntervalMs => ({ pollIntervalMs })),
    { stallTimeoutMs: 100, pollIntervalMs: 101 },
  ]) assert.throws(() => createTransferGuard({ getActivity: observer, ...changed }), { code: 'TRANSFER_GUARD_INVALID' });
  time.tick(1200000);
  assert.equal(samples, 0);
});
