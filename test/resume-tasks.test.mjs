import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createResumeTaskStore, resumeTaskRecord, resumeSourceKey } from '../src/resume-tasks.mjs';

const job = { id: 'clip-example', sourceKey: resumeSourceKey('dav', 'http://127.0.0.1/dav/film.mkv', 'fixture-account'),
  sourceLabel: '合成素材.mkv', createdAt: '2026-10-21T00:00:00.000Z',
  params: { start: 10, end: 20, handles: 2, fetchStart: 8, fetchEnd: 22, outputDir: path.join(os.tmpdir(), 'exports'), budgetBytes: 1024 * 1024, makeMp4: false } };
test('resume settings persist only explicit task fields and replace atomically without remote credentials', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-resume-meta-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await createResumeTaskStore(directory);
  await store.save({ ...job, password: 'PRIVATE_PASSWORD', source: { url: 'http://private/?signature=SECRET' }, params: { ...job.params, cookie: 'PRIVATE_COOKIE' } });
  const disk = await readFile(path.join(directory, job.id + '.json'), 'utf8');
  assert(!/PRIVATE|SECRET|signature|password|cookie|http:/.test(disk));
  assert.deepEqual(await store.load(job.id), resumeTaskRecord(job));
  await store.save({ ...job, resumeCount: 2 });
  assert.equal((await store.load(job.id)).resumeCount, 2);
  assert.deepEqual(await readdir(directory), [job.id + '.json']);
  await store.discard(job.id); assert.equal(await store.load(job.id), null);
});
test('new resume records retain the selected read mode while legacy records remain compatible', () => {
  assert.equal(resumeTaskRecord(job).params.readMode, undefined);
  for (const readMode of ['standard', 'continuous']) assert.equal(resumeTaskRecord({ ...job, params: { ...job.params, readMode } }).params.readMode, readMode);
  for (const readMode of ['fast', 4, null, {}]) assert.throws(() => resumeTaskRecord({ ...job, params: { ...job.params, readMode } }), { code: 'RESUME_METADATA_INVALID' });
});
test('malformed task descriptors and object-coerced identifiers are refused before persistence', () => {
  for (const changed of [{ id: '../outside' }, { id: { toString: () => job.id, private: 'secret' } },
    { sourceKey: 'http://private' }, { sourceKey: { toString: () => job.sourceKey, private: 'secret' } },
    { params: { ...job.params, outputDir: 'relative' } }, { params: { ...job.params, budgetBytes: -1 } }]) {
    assert.throws(() => resumeTaskRecord({ ...job, ...changed }), { code: 'RESUME_METADATA_INVALID' });
  }
  assert.notEqual(resumeSourceKey('dav', 'http://127.0.0.1/dav/film.mkv', 'other-account'), job.sourceKey);
});

test('index reuse opt-out survives restart without changing legacy descriptors', () => {
  assert.equal(resumeTaskRecord(job).params.reuseIndex, undefined);
  for (const reuseIndex of [false, true])
    assert.equal(resumeTaskRecord({ ...job, params: { ...job.params, reuseIndex } }).params.reuseIndex, reuseIndex);
  for (const reuseIndex of [null, 'true', 0, {}, []])
    assert.throws(() => resumeTaskRecord({ ...job, params: { ...job.params, reuseIndex } }), { code: 'RESUME_METADATA_INVALID' });
});
