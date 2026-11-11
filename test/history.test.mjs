import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHistoryStore, historyRecord } from '../src/history.mjs';

test('100 old-format jobs with full diagnostics and export paths reload and save intact', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-history-full-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const requests = Array.from({ length: 32 }, (_, index) => ({
    sequence: index + 1, outcome: 'completed', httpStatus: 206, transportCode: null, cancellationReason: null,
    headersReceived: true, headersVerified: true, receivedBytes: 8 * 1024 * 1024,
    elapsedMs: 2000, responseWaitMs: 100, firstDataWaitMs: 10, bodyTransferMs: 1890,
  }));
  const jobs = Array.from({ length: 100 }, (_, index) => {
    const clipName = `隔离样片 第 ${index + 1} 段 正式取材成品与字幕`;
    const stem = path.join(directory, '中文素材输出文件夹', clipName, clipName);
    return historyRecord({
      id: `clip-full-${index}`, status: 'completed', clipName, sourceLabel: '隔离样片',
      createdAt: '2026-11-11T00:00:00.000Z', finishedAt: '2026-11-11T00:01:04.000Z',
      requested: { start: 0, end: 60, handles: 5 },
      result: {
        candidatePath: stem + '.mkv', compatiblePath: stem + '.mp4', sidecarPath: stem + '.json',
        subtitlePaths: [stem + '.srt'], subtitleResults: [{ path: stem + '.srt', format: 'srt', language: 'zh', codec: 'subrip' }],
      },
      diagnostics: {
        schemaVersion: 1, sourceKind: 'remote', elapsedMs: 64000, stages: { extract: 64000 },
        transfer: { schemaVersion: 1, requestsStarted: 32, requestsCompleted: 32,
          readTimings: { schemaVersion: 1, requests } },
      },
    });
  });
  const filename = path.join(directory, 'tasks.json');
  const legacy = JSON.stringify({ schemaVersion: 1, jobs }, null, 2);
  assert(Buffer.byteLength(legacy) > 2 * 1024 * 1024, 'the old loader rejected this valid history');
  await writeFile(filename, legacy);
  const store = await createHistoryStore(directory);
  const loaded = await store.load();
  assert.deepEqual(loaded, jobs);
  await store.save(loaded);
  assert((await stat(filename)).size < Buffer.byteLength(legacy));
  assert.deepEqual(await (await createHistoryStore(directory)).load(), jobs);
});

test('failed reads preserve damaged or unreadable history across attempted saves', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-history-protected-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [name, contents] of [
    ['syntax', '{"schemaVersion":1,"jobs":['],
    ['schema', '{"schemaVersion":2,"jobs":[]}'],
    ['record', '{"schemaVersion":1,"jobs":[{"id":"valid","status":"completed"},null]}'],
    ['encoding', Buffer.from([0xff])],
  ]) {
    const directory = path.join(root, name);
    const store = await createHistoryStore(directory);
    const filename = path.join(directory, 'tasks.json');
    await writeFile(filename, contents);
    await assert.rejects(store.load(), { code: 'HISTORY_READ_FAILED' });
    await assert.rejects(store.save([]), { code: 'HISTORY_READ_FAILED' });
    assert.deepEqual(await readFile(filename), Buffer.from(contents));
  }
  const oversized = path.join(root, 'oversized');
  const store = await createHistoryStore(oversized);
  const filename = path.join(oversized, 'tasks.json');
  await writeFile(filename, '');
  const size = 16 * 1024 * 1024 + 1;
  await truncate(filename, size);
  await assert.rejects(store.load(), { code: 'HISTORY_READ_FAILED' });
  await assert.rejects(store.save([]), { code: 'HISTORY_READ_FAILED' });
  assert.equal((await stat(filename)).size, size);

  const nonFile = path.join(root, 'non-file');
  const nonFileStore = await createHistoryStore(nonFile);
  const directoryAtFilePath = path.join(nonFile, 'tasks.json');
  await mkdir(directoryAtFilePath);
  await assert.rejects(nonFileStore.load(), { code: 'HISTORY_READ_FAILED' });
  await assert.rejects(nonFileStore.save([]), { code: 'HISTORY_READ_FAILED' });
  assert((await stat(directoryAtFilePath)).isDirectory());

  const changed = path.join(root, 'changed-after-load');
  const changedStore = await createHistoryStore(changed);
  await changedStore.save([{ id: 'original', status: 'completed' }]);
  assert.equal((await changedStore.load())[0].id, 'original');
  const changedFile = path.join(changed, 'tasks.json');
  const incomplete = '{"schemaVersion":1,"jobs":[';
  await writeFile(changedFile, incomplete);
  await assert.rejects(changedStore.save([]));
  assert.equal(await readFile(changedFile, 'utf8'), incomplete);
});

test('a task still settling cannot be persisted as a final result by another job save', () => {
  const job = { id: 'settling-fixture', status: 'completed', diagnosticTracker: {}, metrics: { receivedBytes: 100 } };
  assert.equal(historyRecord(job), null);
  delete job.diagnosticTracker;
  job.finishedAt = '2026-10-21T00:00:00.000Z';
  assert.equal(historyRecord(job).status, 'completed');
  assert.equal(historyRecord({ id: 'legacy-fixture', status: 'completed' }).status, 'completed', 'old history must remain compatible');
});

test('download modes survive history restart while unknown values and legacy fields remain omitted', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-history-mode-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createHistoryStore(directory);
  await store.save([
    { id: 'mode-standard', status: 'completed', params: { readMode: 'standard' } },
    { id: 'mode-continuous', status: 'completed', params: { readMode: 'continuous' } },
    { id: 'mode-legacy', status: 'completed' },
    { id: 'mode-invalid', status: 'completed', readMode: { password: 'private-password' } },
  ]);
  const loaded = await (await createHistoryStore(directory)).load();
  assert.equal(loaded.find(job => job.id === 'mode-standard').readMode, 'standard');
  assert.equal(loaded.find(job => job.id === 'mode-continuous').readMode, 'continuous');
  assert.equal(loaded.find(job => job.id === 'mode-legacy').readMode, undefined);
  assert.equal(loaded.find(job => job.id === 'mode-invalid').readMode, undefined);
  await store.save(loaded);
  assert.deepEqual(await (await createHistoryStore(directory)).load(), loaded);
  assert(!(await readFile(path.join(directory, 'tasks.json'), 'utf8')).includes('private-password'));
});

test('a budget failure retains its actual cap across restart without storing credentials or source URLs', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-history-budget-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createHistoryStore(directory);
  await store.save([{
    id: 'budget-fixture', status: 'failed',
    error: { code: 'BUDGET_EXCEEDED', message: 'private-error-detail' },
    source: { url: 'https://private-source.invalid', password: 'private-password' },
    metrics: { budgetBytes: 268435456, receivedBytes: 268435456, requests: 261, reservedBytes: 0, password: 'private-password' },
  }]);
  const reopened = await createHistoryStore(directory);
  const [job] = await reopened.load();
  assert.equal(job.error.code, 'BUDGET_EXCEEDED');
  assert.equal(job.metrics.budgetBytes, 268435456);
  assert.equal(job.metrics.receivedBytes, 268435456);
  const saved = await readFile(path.join(directory, 'tasks.json'), 'utf8');
  assert(!/private-|reservedBytes/.test(saved));
  for (const budgetBytes of [NaN, Infinity, -1, 0, '268435456', 65536 * 1024 * 1024 + 1]) {
    assert.equal(historyRecord({ id: 'invalid-cap', status: 'failed', metrics: { budgetBytes } }).metrics.budgetBytes, undefined);
  }
});

test('bounded recovery counts survive restart without retaining partial responses or retry details', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-history-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createHistoryStore(directory);
  await store.save([{ id: 'recovery-fixture', status: 'completed', recoveryAttempts: 2,
    partialData: Buffer.from('private-media-bytes'), retry: { url: 'https://private-source.invalid', password: 'private-password' } }]);
  const [job] = await (await createHistoryStore(directory)).load();
  assert.equal(job.recoveryAttempts, 2);
  const saved = await readFile(path.join(directory, 'tasks.json'), 'utf8');
  assert(!/private-|partialData|retry/.test(saved));
  for (const recoveryAttempts of [-1, 0, 0.5, Infinity, NaN, '2', 1000001, { url: 'private' }]) {
    assert.equal(historyRecord({ id: 'bad-recovery', status: 'failed', recoveryAttempts }).recoveryAttempts, undefined);
  }
});

test('terminal diagnostics survive history restart with only whitelisted measurements and the authoritative job status', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-history-diagnostics-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createHistoryStore(directory);
  const statuses = ['completed', 'failed', 'cancelled'];
  const diagnostics = {
    schemaVersion: 1, sourceKind: 'remote', elapsedMs: 1250, recoveryAttempts: 2, status: 'running',
    stages: { checking: 100, positioning: 50, fetch: 1000, probe: 0, extract: 0, validate: 0, compatible: 0, other: 0,
      'https://private-stage.invalid/?token=private-stage-token': 100 },
    transfer: { schemaVersion: 1, requestsStarted: 8, requestsCompleted: 6, requestsFailed: 1, activeRequests: 1,
      responseWaitMs: 150, responseBodyMs: 900, lastByteAgeMs: 25, state: 'receiving', currentBytesPerSecond: 12345,
      url: 'https://private-media.invalid/?token=private-token', headers: { Authorization: 'Basic private-authorization' },
      username: 'private-user', password: 'private-password', partialData: Buffer.from('private-media-bytes') },
    url: 'https://private-source.invalid', error: { message: 'private-error-detail' }, windowPath: '/private-source-path',
  };
  await store.save([
    ...statuses.map(status => ({ id: `diagnostics-${status}`, status, diagnostics, recoveryAttempts: 2,
      error: status === 'completed' ? undefined : { code: 'TIMEOUT', stage: 'fetch', message: 'private-message' } })),
    { id: 'legacy-without-diagnostics', status: 'failed', error: { code: 'EXPORT_FAILED' }, metrics: { receivedBytes: 123 } },
  ]);
  const loaded = await (await createHistoryStore(directory)).load();
  assert.equal(loaded.length, 4);
  for (const status of statuses) {
    const job = loaded.find(job => job.id === `diagnostics-${status}`), saved = job.diagnostics;
    assert(saved, 'terminal diagnostics must be retained across a history restart');
    assert.equal(saved.schemaVersion, 1); assert.equal(saved.sourceKind, 'remote');
    assert.equal(saved.status, status, 'the job terminal status must override stale producer status');
    assert.equal(saved.elapsedMs, 1250); assert.equal(saved.recoveryAttempts, 2);
    assert.deepEqual(saved.stages, { checking: 100, positioning: 50, fetch: 1000, probe: 0, extract: 0, validate: 0, compatible: 0, other: 0 });
    assert.deepEqual(saved.transfer, { schemaVersion: 1, requestsStarted: 8, requestsCompleted: 6, requestsFailed: 1, activeRequests: 0,
      responseWaitMs: 150, responseBodyMs: 900, lastByteAgeMs: 25, state: 'idle', currentBytesPerSecond: null });
    if (status !== 'completed') assert.equal(job.error.stage, 'fetch');
  }
  const legacy = loaded.find(job => job.id === 'legacy-without-diagnostics');
  assert.equal(legacy.diagnostics, undefined, 'old history remains valid without invented observations');
  assert.equal(legacy.metrics.receivedBytes, 123);
  const savedText = await readFile(path.join(directory, 'tasks.json'), 'utf8');
  assert(!/private-|Authorization|partialData|windowPath/.test(savedText), 'support diagnostics must never persist source or authentication details');
  // Saving the restored records must remain stable rather than introducing
  // dynamic clocks, rates, or extra normalization drift on each application run.
  await store.save(loaded);
  assert.deepEqual(await (await createHistoryStore(directory)).load(), loaded);
});

test('unsupported diagnostic schemas are omitted without discarding otherwise valid old history', () => {
  for (const diagnostics of [undefined, null, [], 'private-text', {}, { schemaVersion: 2, elapsedMs: 100 }, { schemaVersion: '1', elapsedMs: 100 }]) {
    const record = historyRecord({ id: 'compatible-history', status: 'completed', diagnostics, metrics: { receivedBytes: 456 } });
    assert(record);
    assert.equal(record.diagnostics, undefined);
    assert.equal(record.metrics.receivedBytes, 456);
  }
});

test('queue history retains requested ranges and actual start separately while omitting batch secrets', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-history-batch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createHistoryStore(directory);
  const job = { id: 'batch-history-item', status: 'failed', batchId: 'a'.repeat(32), clientItemId: 'b'.repeat(32),
    createdAt: '2026-11-06T00:00:00.000Z', queuedAt: '2026-11-06T00:00:00.000Z', startedAt: '2026-11-06T00:04:00.000Z', finishedAt: '2026-11-06T00:04:30.000Z',
    params: { start: 100, end: 200, handles: 5, sourceId: 'private-source', url: 'https://private.invalid/source' },
    requestSignature: 'private-signature', error: { code: 'REMOTE_HTTP', stage: 'probe' } };
  await store.save([job]); const [restored] = await (await createHistoryStore(directory)).load();
  assert.equal(restored.batchId, job.batchId); assert.equal(restored.clientItemId, job.clientItemId);
  assert.equal(restored.queuedAt,job.queuedAt); assert.equal(restored.startedAt,job.startedAt); assert.equal(restored.finishedAt,job.finishedAt);
  assert.deepEqual(restored.requested,{start:100,end:200,handles:5});
  const saved=await readFile(path.join(directory,'tasks.json'),'utf8');assert.doesNotMatch(saved,/private-|requestSignature|sourceId|url/);
  for(const bad of [{batchId:'https://private.invalid'},{clientItemId:{}},{requested:{start:-1,end:2,handles:0}},{requested:{start:1,end:2,handles:'5'}}]) {
    const record=historyRecord({id:'safe-range',status:'cancelled',...bad});
    if('batchId'in bad)assert.equal(record.batchId,undefined);
    if('clientItemId'in bad)assert.equal(record.clientItemId,undefined);
    if('requested'in bad)assert.equal(record.requested,undefined);
  }
});

test('failed and cancelled-retry history retains only the original extraction settings needed to retry', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-history-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createHistoryStore(directory);
  const settings = { start: 10, end: 30, handles: 5, outputDir: path.join(directory, 'exports'), clipName: '保留原名称',
    budgetBytes: 64 * 1024 * 1024, subtitleStreamIndex: 4, subtitleTrack: { codec: 'ASS', language: 'ZH-Hans',
      title: 'private-subtitle-title' }, audioStreamIndex: null, makeMp4: true, reuseIndex: false, downloadMethod: 'direct-stream',
    readMode: 'standard', sourceFingerprint: 'f'.repeat(64), url: 'https://private-source.invalid/?signature=private-signature',
    sourcePath: '/private-source-location', headers: { cookie: 'private-cookie' }, authorization: 'private-authorization' };
  await store.save([
    { id: 'original-failure', status: 'failed', retrySettings: settings },
    { id: 'cancelled-child', status: 'cancelled', retryOf: 'original-failure', retrySettings: { ...settings, subtitleStreamIndex: null } },
    { id: 'cancelled-plain', status: 'cancelled', retrySettings: settings },
    { id: 'completed-child', status: 'completed', retryOf: 'original-failure', retrySettings: settings },
    { id: 'invalid-retry', status: 'failed', retrySettings: { ...settings, subtitleStreamIndex: undefined } },
  ]);
  const loaded = await (await createHistoryStore(directory)).load();
  assert.deepEqual(loaded[0].retrySettings, {
    start: 10, end: 30, handles: 5, outputDir: settings.outputDir, clipName: '保留原名称', budgetBytes: settings.budgetBytes,
    subtitleStreamIndex: 4, subtitleTrack: { codec: 'ass', language: 'zh-hans' }, audioStreamIndex: null, makeMp4: true,
    reuseIndex: false, downloadMethod: 'direct-stream', readMode: 'standard', sourceFingerprint: settings.sourceFingerprint,
  });
  assert.equal(loaded[1].retryOf, 'original-failure');
  assert.equal(loaded[1].retrySettings.subtitleStreamIndex, null);
  assert.equal(loaded[1].retrySettings.subtitleTrack, undefined);
  assert.equal(loaded[2].retrySettings, undefined);
  assert.equal(loaded[3].retryOf, 'original-failure');
  assert.equal(loaded[3].retrySettings, undefined);
  assert.equal(loaded[4].retrySettings, undefined);
  assert.doesNotMatch(await readFile(path.join(directory, 'tasks.json'), 'utf8'), /private-|signature=|sourcePath|headers|authorization/);
  await store.save(loaded);
  assert.deepEqual(await store.load(), loaded);
});
