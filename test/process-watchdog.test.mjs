import test from 'node:test';
import assert from 'node:assert/strict';
import { createProcessWatchdog } from '../src/process-watchdog.mjs';

function fixture(options = {}) {
  let time = 0, reads = 0, activity = { receivedBytes: 0 }, fail = false;
  const timers = new Set(), stalls = [], unavailable = [];
  const watchdog = createProcessWatchdog({
    getActivity() { reads++; if (fail) throw new Error('https://private.example/?token=secret'); return activity; },
    now: () => time, onStall: value => stalls.push(value), onUnavailable: value => unavailable.push(value),
    setIntervalFn(callback) { const handle = { callback, unref() {} }; timers.add(handle); return handle; },
    clearIntervalFn(handle) { timers.delete(handle); },
    ...options,
  });
  return { watchdog, timers, stalls, unavailable,
    set activity(value) { activity = value; },
    set fail(value) { fail = value; },
    get reads() { return reads; },
    at(value) { time = value; for (const handle of [...timers]) handle.callback(); },
  };
}

test('sustained real byte growth remains live beyond the former 15-minute deadline', () => {
  const f = fixture();
  for (let minute = 1; minute <= 40; minute++) {
    f.activity = { receivedBytes: minute }; // A single real byte per minute is still forward progress.
    f.at(minute * 60000);
    assert.equal(f.stalls.length, 0); assert.equal(f.unavailable.length, 0);
  }
  assert.equal(f.timers.size, 1);
  f.watchdog.dispose();
  const reads = f.reads;
  f.at(24 * 3600000);
  assert.equal(f.timers.size, 0); assert.equal(f.reads, reads);
  assert.deepEqual(f.stalls, []);
});

test('each independent real progress source can reset the inactivity window', () => {
  for (const field of ['receivedBytes', 'outputBytes', 'mediaTimeUs']) {
    const f = fixture({ stallTimeoutMs: 1000, pollIntervalMs: 100 });
    f.activity = { [field]: 10 }; f.at(900);
    f.at(1800); assert.equal(f.stalls.length, 0, field);
    f.activity = { [field]: 11 }; f.at(1900);
    f.at(2899); assert.equal(f.stalls.length, 0, field);
    f.at(2900);
    assert.deepEqual(f.stalls, [{ code: 'PROCESS_STALLED', stallTimeoutMs: 1000 }]);
    assert.equal(f.timers.size, 0);
  }
});

test('repeated notifications, resets and old counts cannot keep a stalled process alive', () => {
  const f = fixture({ stallTimeoutMs: 1000, pollIntervalMs: 100 });
  f.activity = { receivedBytes: 100, outputBytes: 500, mediaTimeUs: 10000 }; f.at(100);
  for (let elapsed = 200; elapsed <= 1000; elapsed += 100) {
    f.activity = { receivedBytes: elapsed % 200 ? 99 : 100, outputBytes: 500, mediaTimeUs: 10000,
      progress: 'continue', heartbeat: elapsed, requestCount: elapsed };
    f.at(elapsed); assert.equal(f.stalls.length, 0);
  }
  f.at(1100);
  assert.equal(f.stalls.length, 1); assert.equal(f.stalls[0].code, 'PROCESS_STALLED');
  const reads = f.reads;
  f.activity = { receivedBytes: 1000000 }; f.at(60000); f.watchdog.sample();
  assert.equal(f.reads, reads); assert.equal(f.stalls.length, 1);
});

test('invalid fields do not reset time when another supported counter remains valid', () => {
  const f = fixture({ stallTimeoutMs: 1000, pollIntervalMs: 100 });
  for (const [index, invalid] of [NaN, Infinity, -1, 0.5, '100', {}, null, undefined, 2 ** 54].entries()) {
    f.activity = { receivedBytes: invalid, outputBytes: 0 };
    f.at((index + 1) * 100);
  }
  assert.equal(f.stalls.length, 0); assert.equal(f.unavailable.length, 0);
  f.at(1000);
  assert.equal(f.stalls.length, 1); assert.equal(f.unavailable.length, 0);
});

test('unreadable or entirely invalid activity fails closed without exposing observer data', () => {
  for (const value of [null, [], {}, Promise.resolve({ receivedBytes: 1 }), { heartbeat: 1 },
    { receivedBytes: NaN, outputBytes: -1, mediaTimeUs: '100' }]) {
    const f = fixture({ getActivity: () => value });
    assert.deepEqual(f.unavailable, [{ code: 'PROCESS_ACTIVITY_UNAVAILABLE', stallTimeoutMs: 120000 }]);
    assert.equal(f.timers.size, 0); assert.equal(f.stalls.length, 0);
  }
  const f = fixture(); f.fail = true; f.at(1000);
  assert.equal(f.timers.size, 0); assert.equal(f.unavailable.length, 1);
  assert.doesNotMatch(JSON.stringify(f.unavailable), /private|secret|https/);
  const reads = f.reads; f.watchdog.sample(); f.at(100000);
  assert.equal(f.reads, reads); assert.equal(f.unavailable.length, 1);
});

test('missing onUnavailable uses the failure callback and callback exceptions leave no timer', () => {
  const f = fixture({ getActivity: () => null, onUnavailable: undefined });
  assert.deepEqual(f.stalls, [{ code: 'PROCESS_ACTIVITY_UNAVAILABLE', stallTimeoutMs: 120000 }]);
  assert.equal(f.timers.size, 0);
  const throwing = fixture({ stallTimeoutMs: 1000, pollIntervalMs: 100,
    onStall() { throw new Error('caller stop failed'); } });
  assert.doesNotThrow(() => throwing.at(1000));
  assert.equal(throwing.timers.size, 0);
});

test('disposal is idempotent and suppresses both explicit and timer samples', () => {
  const f = fixture(); assert.equal(f.reads, 1);
  f.watchdog.dispose(); f.watchdog.dispose();
  f.activity = {}; f.watchdog.sample(); f.at(1000000);
  assert.equal(f.reads, 1); assert.equal(f.timers.size, 0);
  assert.deepEqual(f.stalls, []); assert.deepEqual(f.unavailable, []);
});

test('a clock moving backwards cannot reset inactivity and invalid clocks fail closed', () => {
  const f = fixture({ stallTimeoutMs: 1000, pollIntervalMs: 100 });
  f.activity = { receivedBytes: 1 }; f.at(900);
  f.at(200); f.at(1899); assert.equal(f.stalls.length, 0);
  f.at(1900); assert.equal(f.stalls.length, 1);
  for (const now of [() => NaN, () => Infinity, () => -1, () => { throw new Error('private'); }]) {
    const invalid = fixture({ now });
    assert.equal(invalid.unavailable.length, 1); assert.equal(invalid.timers.size, 0);
  }
});

test('invalid configuration is rejected before observing activity or scheduling timers', () => {
  let reads = 0, schedules = 0;
  const base = { getActivity() { reads++; return { receivedBytes: 0 }; }, onStall() {},
    setIntervalFn() { schedules++; return 1; }, clearIntervalFn() {} };
  for (const options of [
    ...[0, -1, 0.5, NaN, Infinity, '1000', 86400001].map(stallTimeoutMs => ({ stallTimeoutMs })),
    ...[0, -1, 0.5, NaN, Infinity, '1000', 86400001].map(pollIntervalMs => ({ pollIntervalMs })),
    { stallTimeoutMs: 10, pollIntervalMs: 11 }, { getActivity: null }, { onStall: null }, { onUnavailable: null },
    { now: 1 }, { setIntervalFn: null }, { clearIntervalFn: null },
  ]) assert.throws(() => createProcessWatchdog({ ...base, ...options }), { code: 'PROCESS_WATCHDOG_INVALID' });
  assert.equal(reads, 0); assert.equal(schedules, 0);
});

test('a failed scheduler reports unavailability instead of silently running unmonitored', () => {
  const f = fixture({ setIntervalFn() { throw new Error('scheduler failure'); } });
  assert.deepEqual(f.unavailable, [{ code: 'PROCESS_ACTIVITY_UNAVAILABLE', stallTimeoutMs: 120000 }]);
  assert.equal(f.timers.size, 0);
});
