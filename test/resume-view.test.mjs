import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeView, historyStatusLabel, historyRequestedRange } from '../public/resume-view.mjs';

const stopped = (overrides = {}) => ({ id: 'clip-resume-test', status: 'cancelled', resume: {
  available: true, cachedBytes: 1024, totalBytes: 4096, receivedBytes: 2048,
  budgetBytes: 8192, budgetUsedBytes: 3072, uncertainBytes: 1024,
  needsSource: true, requested: { start: 100, end: 160, handles: 5 },
  outputDir: '/local/export', resumeCount: 1, ...overrides,
} });

test('old jobs and malformed resume metadata do not create a resume panel', () => {
  for (const resume of [undefined, null, [], {}, { available: 'true' }]) assert.equal(resumeView({ status: 'cancelled', resume }), null);
  assert.equal(resumeView(stopped({ available: false, reason: 'discarded' })), null);
  assert.equal(resumeView(stopped({ available: false, reason: 'completed' })), null);
});

test('resuming requires an idle service and a freshly checked source, including after reconnect', () => {
  const job = stopped();
  assert.equal(resumeView(job).canResume, false);
  assert.equal(resumeView(job, { connected: true }).canResume, false);
  assert.equal(resumeView(job, { connected: true, checkedSource: true }).canResume, true);
  assert.equal(resumeView(job, { connected: true, checkedSource: true, locked: true }).canResume, false);
  assert.match(resumeView(job).instruction, /重新连接云盘.*检查同一份源文件/);
  assert.match(resumeView(job, { checkedSource: true }).instruction, /再次核对.*同一版本/);
  assert.equal(resumeView(job, { connected: true }).canDiscard, true);
  assert.equal(resumeView(job, { connected: true, locked: true }).canDiscard, false);
});

test('active jobs show saved progress without exposing resume or clear actions', () => {
  for (const status of ['running', 'queued']) {
    const value = resumeView({ ...stopped(), status }, { connected: true, checkedSource: true });
    assert.equal(value.active, true);
    assert.equal(value.showActions, false);
    assert.equal(value.canResume, false);
    assert.equal(value.canDiscard, false);
    assert.match(value.instruction, /停止后会保留.*再次启动工具后/);
  }
  const completed = resumeView({ ...stopped(), status: 'completed' }, { connected: true, checkedSource: true });
  assert.equal(completed.canResume, false);
  assert.equal(completed.canDiscard, false);
});

test('uncertain crash reservations are distinct from measured receipt and reusable cached bytes', () => {
  const view = resumeView(stopped());
  assert.equal(view.receivedBytes, 2048);
  assert.equal(view.cachedBytes, 1024);
  assert.equal(view.budgetUsedBytes, 3072);
  assert.equal(view.uncertainBytes, 1024);
  assert.deepEqual(view.range, { start: 100, end: 160, handles: 5 });
  assert.equal(view.resumeCount, 1);
});

test('an invalid cache remains clearable without enabling resume or hiding its size', () => {
  const job = stopped({ available: false, discardable: true, reason: 'cache_invalid', cachedBytes: 2048 });
  const view = resumeView(job, { connected: true, checkedSource: true });
  assert.equal(view.title, '缓存需要清理');
  assert.equal(view.cachedBytes, 2048);
  assert.equal(view.canResume, false);
  assert.equal(view.showActions, false);
  assert.equal(view.showDiscard, true);
  assert.equal(view.canDiscard, true);
  assert.match(view.reason, /缓存校验未通过/);
  assert.equal(resumeView(job, { connected: true, locked: true }).canDiscard, false);
});

test('invalid values and unknown reason strings never appear as trusted UI copy', () => {
  const bad = stopped({ cachedBytes: '1000', totalBytes: Infinity, receivedBytes: -1,
    budgetBytes: NaN, budgetUsedBytes: 1.5, uncertainBytes: {}, resumeCount: -1,
    requested: { start: 10, end: 0, handles: 0 }, outputDir: {}, available: false, reason: 'https://private.example/?token=SECRET' });
  const view = resumeView(bad);
  for (const key of ['cachedBytes', 'totalBytes', 'receivedBytes', 'budgetBytes', 'budgetUsedBytes', 'uncertainBytes', 'range']) assert.equal(view[key], null, key);
  assert.equal(view.resumeCount, 0);
  assert.equal(view.outputDir, '');
  assert.equal(view.showActions, false);
  assert(!view.reason.includes('SECRET'));
  assert.match(resumeView(stopped({ available: false, reason: 'no_strong_etag' })).reason, /固定版本标识/);
});

test('history marks only interrupted resumable jobs and falls back to original task range', () => {
  const job = stopped();
  assert.equal(historyStatusLabel(job), '可继续 →');
  assert.equal(historyStatusLabel({ ...job, status: 'failed' }), '可继续 →');
  assert.equal(historyStatusLabel({ ...job, status: 'running' }), '进行中');
  assert.equal(historyStatusLabel({ ...job, status: 'completed' }), '查看文件 →');
  assert.equal(historyStatusLabel(stopped({ available: false })), '已停止');
  assert.equal(historyStatusLabel(stopped({ available: false, discardable: true, reason: 'cache_invalid' })), '需清理 →');
  assert.deepEqual(historyRequestedRange(job), { start: 100, end: 160, handles: 5 });
  const requested = { start: 5, end: 10, handles: 0 };
  assert.deepEqual(historyRequestedRange({ ...job, result: { requested } }), requested);
  assert.equal(historyRequestedRange({ status: 'cancelled' }), null);
});
