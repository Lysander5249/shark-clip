import test from 'node:test';
import assert from 'node:assert/strict';
import { createTaskDiagnostics } from '../src/task-diagnostics.mjs';

const STAGES = ['checking', 'positioning', 'fetch', 'probe', 'extract', 'validate', 'compatible', 'other'];
const TRANSFER_COUNTERS = ['requestsStarted', 'requestsCompleted', 'requestsFailed', 'activeRequests', 'responseWaitMs', 'responseBodyMs'];
const TRANSFER_KEYS = new Set(['schemaVersion', ...TRANSFER_COUNTERS, 'lastByteAgeMs', 'state', 'currentBytesPerSecond']);
const STATES = new Set(['idle', 'waiting_response', 'receiving', 'waiting_data']);
const MAX_ELAPSED = 7 * 24 * 60 * 60 * 1000;

test('index cache observations retain bounded counters only and are absent in legacy/local jobs', () => {
  const remote = createTaskDiagnostics({ sourceKind: 'remote', now: () => 0 });
  const indexCache = { enabled: true, hitBytes: 8192, hitReads: 5, password: 'PRIVATE', bytes: Buffer.from('PRIVATE') };
  const safe = remote.snapshot({ indexCache });
  assert.deepEqual(safe.indexCache, { enabled: true, hitBytes: 8192, hitReads: 5 });
  assert(!JSON.stringify(safe).includes('PRIVATE'));
  assert(!Object.hasOwn(remote.snapshot(), 'indexCache'));
  assert(!Object.hasOwn(createTaskDiagnostics().snapshot({ indexCache }), 'indexCache'));
  assert(!Object.hasOwn(remote.snapshot({ indexCache: { enabled: 'PRIVATE' } }), 'indexCache'));
  assert.deepEqual(remote.snapshot({ indexCache: { enabled: false, hitBytes: Infinity, hitReads: -1 } }).indexCache,
    { enabled: false, hitBytes: 0, hitReads: 0 });
});

function clock(initial = 1000) {
  let value = initial;
  return { now: () => value, set: next => { value = next; }, advance: amount => { value += amount; } };
}
function stageTimes(overrides = {}) { return Object.fromEntries(STAGES.map(stage => [stage, overrides[stage] ?? 0])); }
function assertSafeTime(value) { assert(Number.isSafeInteger(value) && value >= 0 && value <= MAX_ELAPSED, `invalid duration: ${value}`); }
function assertSafeSnapshot(snapshot) {
  assert.equal(snapshot.schemaVersion, 1);
  assert(['local', 'remote'].includes(snapshot.sourceKind));
  assertSafeTime(snapshot.elapsedMs);
  assert.deepEqual(Object.keys(snapshot.stages).sort(), [...STAGES].sort());
  for (const duration of Object.values(snapshot.stages)) assertSafeTime(duration);
  assert(Number.isSafeInteger(snapshot.recoveryAttempts) && snapshot.recoveryAttempts >= 0);
  if (snapshot.transfer !== null) {
    for (const key of Object.keys(snapshot.transfer)) assert(TRANSFER_KEYS.has(key), `unexpected transfer field ${key}`);
    for (const key of TRANSFER_COUNTERS) {
      const value = snapshot.transfer[key];
      assert(Number.isSafeInteger(value) && value >= 0, `invalid ${key}: ${value}`);
    }
    assert(snapshot.transfer.lastByteAgeMs === null || Number.isSafeInteger(snapshot.transfer.lastByteAgeMs) && snapshot.transfer.lastByteAgeMs >= 0);
    assert(STATES.has(snapshot.transfer.state));
    assert(snapshot.transfer.currentBytesPerSecond === null || typeof snapshot.transfer.currentBytesPerSecond === 'number'
      && Number.isFinite(snapshot.transfer.currentBytesPerSecond) && snapshot.transfer.currentBytesPerSecond >= 0);
  }
}
function transfer(overrides = {}) {
  return { schemaVersion: 1, requestsStarted: 4, requestsCompleted: 2, requestsFailed: 1, activeRequests: 1,
    responseWaitMs: 75, responseBodyMs: 250, lastByteAgeMs: 20, state: 'receiving', currentBytesPerSecond: 1234.5, ...overrides };
}

test('queued time contributes to task elapsed time but not execution stages', () => {
  const time = clock(), diagnostics = createTaskDiagnostics({ now: time.now, sourceKind: 'local' });
  assert.deepEqual(diagnostics.snapshot().stages, stageTimes());
  diagnostics.enter('queued'); time.advance(50);
  const queued = diagnostics.snapshot({ status: 'queued' });
  assert.equal(queued.status, 'queued'); assert.equal(queued.elapsedMs, 50);
  assert.deepEqual(queued.stages, stageTimes()); assert.equal(queued.transfer, null);
  diagnostics.enter('checking'); time.advance(40);
  const running = diagnostics.snapshot();
  assert.equal(running.elapsedMs, 90); assert.deepEqual(running.stages, stageTimes({ checking: 40 }));
  assertSafeSnapshot(running);
});

test('stage transitions accumulate disjoint durations and entering the same stage does not reset it', () => {
  const time = clock(), diagnostics = createTaskDiagnostics({ now: time.now, sourceKind: 'remote' });
  diagnostics.enter('checking'); time.advance(25); diagnostics.enter('checking'); time.advance(35);
  assert.deepEqual(diagnostics.snapshot().stages, stageTimes({ checking: 60 }));
  diagnostics.enter('positioning'); time.advance(20); diagnostics.enter('fetch'); time.advance(45);
  diagnostics.enter('probe'); time.advance(10); diagnostics.enter('extract'); time.advance(12);
  diagnostics.enter('validate'); time.advance(7); diagnostics.enter('compatible'); time.advance(6);
  const result = diagnostics.snapshot({ recoveryAttempts: 3 });
  assert.deepEqual(result.stages, stageTimes({ checking: 60, positioning: 20, fetch: 45, probe: 10, extract: 12, validate: 7, compatible: 6 }));
  assert.equal(result.elapsedMs, 160); assert.equal(result.recoveryAttempts, 3);
  assert.equal(Object.values(result.stages).reduce((sum, ms) => sum + ms, 0), result.elapsedMs);
  assertSafeSnapshot(result);
});

test('repeated snapshots report live time without committing it twice or modifying prior snapshots', () => {
  const time = clock(), diagnostics = createTaskDiagnostics({ now: time.now, sourceKind: 'remote' });
  diagnostics.enter('fetch'); time.advance(40);
  const input = transfer(), first = diagnostics.snapshot({ transfer: input });
  assert.deepEqual(diagnostics.snapshot({ transfer: input }), first, 'a same-clock snapshot must be observational');
  assert.notEqual(first.transfer, input, 'public diagnostics must copy sanitized transfer data');
  input.requestsStarted = 99;
  assert.equal(first.transfer.requestsStarted, 4, 'later producer mutation must not rewrite an earlier snapshot');
  time.advance(30);
  assert.equal(diagnostics.snapshot().stages.fetch, 70);
  time.advance(10); diagnostics.enter('validate'); time.advance(5);
  const after = diagnostics.snapshot();
  assert.deepEqual(after.stages, stageTimes({ fetch: 80, validate: 5 }));
  assert.equal(after.elapsedMs, 85);
  assert.equal(first.stages.fetch, 40, 'earlier snapshots must not share the live stage accumulator');
});

test('finish is idempotent and freezes both task and stage durations against later entry and clocks', () => {
  const time = clock(), diagnostics = createTaskDiagnostics({ now: time.now, sourceKind: 'remote' });
  diagnostics.enter('fetch'); time.advance(125); diagnostics.finish();
  const done = diagnostics.snapshot({ status: 'completed', transfer: transfer() });
  assert.equal(done.elapsedMs, 125); assert.deepEqual(done.stages, stageTimes({ fetch: 125 }));
  time.advance(500); diagnostics.finish(); diagnostics.enter('validate'); time.advance(500);
  assert.deepEqual(diagnostics.snapshot({ status: 'completed', transfer: transfer() }), done);
  assertSafeSnapshot(done);
});

test('terminal status clears the current transfer speed without implicitly freezing a task', () => {
  for (const status of ['completed', 'failed', 'cancelled']) {
    const time = clock(), diagnostics = createTaskDiagnostics({ now: time.now, sourceKind: 'remote' });
    diagnostics.enter('fetch'); time.advance(50);
    const terminal = diagnostics.snapshot({ status, transfer: transfer() });
    assert.equal(terminal.status, status); assert.equal(terminal.transfer.currentBytesPerSecond, null);
    assert.equal(terminal.transfer.requestsStarted, 4);
    time.advance(25);
    const live = diagnostics.snapshot({ status: 'running', transfer: transfer() });
    assert.equal(live.elapsedMs, 75); assert.equal(live.stages.fetch, 75);
    assert.equal(live.transfer.currentBytesPerSecond, 1234.5, 'terminal presentation must not mutate a later running snapshot');
    diagnostics.finish(); time.advance(500);
    assert.equal(diagnostics.snapshot({ status }).elapsedMs, 75);
  }
});

test('unknown stages aggregate into other without serializing their input or creating arbitrary keys', () => {
  const time = clock(), diagnostics = createTaskDiagnostics({ now: time.now, sourceKind: 'remote' });
  diagnostics.enter('https://private-source.example/film?token=stage-secret'); time.advance(10);
  diagnostics.enter({ username: 'stage-user', password: 'stage-password' }); time.advance(15);
  diagnostics.enter('__proto__'); time.advance(5); diagnostics.enter('checking'); time.advance(7);
  const result = diagnostics.snapshot();
  assert.deepEqual(result.stages, stageTimes({ other: 30, checking: 7 }));
  assert.equal(result.elapsedMs, 37);
  for (const secret of ['private-source', 'stage-secret', 'stage-user', 'stage-password', '__proto__']) assert(!JSON.stringify(result).includes(secret));
  assertSafeSnapshot(result);
});

test('transfer snapshots retain only numeric counters, nullable measurements, and known state enums', () => {
  const diagnostics = createTaskDiagnostics({ now: () => 0, sourceKind: 'remote' });
  const malicious = transfer({ state: 'https://private-source.example/?token=state-secret', url: 'private-url',
    username: 'private-user', password: 'private-password', Authorization: 'Basic private-authorization',
    headers: { cookie: 'private-cookie' }, error: new Error('private-error'), partialData: Buffer.from('private-media'),
    lastRange: { start: 123, end: 456, url: 'private-range-url' }, text: 'private-text' });
  const result = diagnostics.snapshot({ transfer: malicious });
  assertSafeSnapshot(result);
  assert.equal(result.transfer.state, 'idle');
  assert.equal(result.transfer.currentBytesPerSecond, 1234.5);
  for (const key of TRANSFER_COUNTERS) assert.equal(result.transfer[key], malicious[key]);
  assert(!JSON.stringify(result).includes('private-'));
  assert.equal(JSON.stringify(result).includes('Buffer'), false);
  for (const state of STATES) assert.equal(diagnostics.snapshot({ transfer: transfer({ state }) }).transfer.state, state);
});

test('invalid numeric transfer values and recovery counts cannot become NaN, Infinity, negative, or text', () => {
  const diagnostics = createTaskDiagnostics({ now: () => 0, sourceKind: 'remote' });
  for (const invalid of [-1, NaN, Infinity, -Infinity, 'private-number', {}, null, true, 1e100]) {
    const values = Object.fromEntries(TRANSFER_COUNTERS.map(key => [key, invalid]));
    const result = diagnostics.snapshot({ recoveryAttempts: invalid, transfer: transfer({ ...values, lastByteAgeMs: invalid,
      currentBytesPerSecond: invalid }) });
    assertSafeSnapshot(result);
    assert(!JSON.stringify(result).includes('private-number'));
  }
  const zero = diagnostics.snapshot({ transfer: transfer({ currentBytesPerSecond: 0, lastByteAgeMs: 0 }), recoveryAttempts: 0 });
  assert.equal(zero.transfer.currentBytesPerSecond, 0); assert.equal(zero.transfer.lastByteAgeMs, 0); assert.equal(zero.recoveryAttempts, 0);
  assert.equal(diagnostics.snapshot().transfer, null);
});

test('a backward or non-finite clock uses the last valid monotonic high-water mark', () => {
  const time = clock(100), diagnostics = createTaskDiagnostics({ now: time.now, sourceKind: 'local' });
  diagnostics.enter('checking'); time.set(150);
  const valid = diagnostics.snapshot(); assert.equal(valid.elapsedMs, 50); assert.equal(valid.stages.checking, 50);
  for (const bad of [125, 0, -1000, NaN, Infinity, -Infinity]) {
    time.set(bad); const result = diagnostics.snapshot();
    assert.equal(result.elapsedMs, 50); assert.equal(result.stages.checking, 50); assertSafeSnapshot(result);
  }
  time.set(180); diagnostics.enter('fetch'); time.set(160);
  const backwards = diagnostics.snapshot();
  assert.equal(backwards.elapsedMs, 80); assert.deepEqual(backwards.stages, stageTimes({ checking: 80 }));
  time.set(200); diagnostics.finish(); time.set(900);
  const done = diagnostics.snapshot({ status: 'failed' });
  assert.equal(done.elapsedMs, 100); assert.deepEqual(done.stages, stageTimes({ checking: 80, fetch: 20 }));
});

test('invalid initial clocks and extreme time jumps remain finite and bounded', () => {
  for (const initial of [NaN, Infinity, -Infinity]) {
    const time = clock(initial), diagnostics = createTaskDiagnostics({ now: time.now, sourceKind: 'local' });
    diagnostics.enter('checking'); assertSafeSnapshot(diagnostics.snapshot());
    time.set(100); assertSafeSnapshot(diagnostics.snapshot());
    time.set(Number.MAX_VALUE); assertSafeSnapshot(diagnostics.snapshot());
    diagnostics.finish(); time.set(Infinity);
    assertSafeSnapshot(diagnostics.snapshot({ status: 'failed' }));
  }
});
