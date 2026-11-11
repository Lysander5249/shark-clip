import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../server.mjs';
import { createHistoryStore } from '../src/history.mjs';
import { openResumeStore } from '../src/resume-store.mjs';
import { createResumeTaskStore } from '../src/resume-tasks.mjs';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const terminal = job => ['completed', 'failed', 'cancelled'].includes(job.status);
async function until(read, predicate, message) {
  for (let index = 0; index < 250; index++) { const value = await read(); if (predicate(value)) return value; await wait(20); }
  assert.fail(message);
}
async function fixture(t, history = []) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-batch-queue-'));
  const bytes = await readFile(new URL('../examples/示例视频.mkv', import.meta.url));
  let gated = false, app, failNext = false, peak = 0, calls = 0;
  const pending = new Set();
  const upstream = http.createServer((req, res) => {
    calls++;
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) { res.writeHead(400).end(); return; }
    const start = Number(match[1]), end = Math.min(Number(match[2]), bytes.length - 1);
    const send = () => { pending.delete(send); if (!res.destroyed) {
      if (failNext) {
        const status = failNext === true ? 503 : failNext;
        failNext = false; res.writeHead(status).end(); return;
      }
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end-start+1, ETag: '"batch-fixture"' });
      res.end(bytes.subarray(start,end+1));
    } };
    res.once('close', () => pending.delete(send));
    if (gated) { pending.add(send); peak = Math.max(peak, pending.size); } else send();
  });
  t.after(async () => { await app?.close(); upstream.closeAllConnections(); if (upstream.listening) await new Promise(resolve => upstream.close(resolve)); await rm(root,{recursive:true,force:true}); });
  await new Promise((resolve,reject) => { upstream.once('error',reject); upstream.listen(0,'127.0.0.1',resolve); });
  const options = { outputDir: path.join(root, 'outputs'), dataDir: path.join(root, 'state') };
  if (history.length) await (await createHistoryStore(options.dataDir)).save(history);
  app = await startServer(options);
  const bootstrap = await fetch(app.url+'/api/bootstrap').then(r=>r.json());
  const request = async (route,body) => { const response=await fetch(app.url+route,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Session-Token':bootstrap.sessionToken},body:JSON.stringify(body)});return {status:response.status,data:await response.json()}; };
  const api = async (route,body) => {const result=await request(route,body);assert(result.status<400,JSON.stringify(result));return result.data;};
  const probeInput = { source: { type: 'http', value: `http://127.0.0.1:${upstream.address().port}/movie.mkv` }, budgetMiB: 32 };
  const source = await api('/api/probe', probeInput);
  return {root,app,options,source,probeInput,request,api,pending,get peak(){return peak},get calls(){return calls},gate(){gated=true},release({failure=false}={}){gated=false;failNext=failure;for(const send of [...pending])send()},
    finish(id){return until(()=>api('/api/jobs/'+id),terminal,'queued job did not finish')},
    batch(id='a',count=3){return {sourceId:source.sourceId,clientBatchId:id.repeat(32),jobs:Array.from({length:count},(_,index)=>({clientItemId:(index+1).toString(16).padStart(32,'0'),start:1+index,end:4+index,handles:0,clipName:'队列素材',budgetMiB:32,downloadMethod:'indexed'}))}},
  };
}

test('a whole batch is validated before any job or remote request is created', {timeout:30000}, async t => {
  const f=await fixture(t), baselineCalls=f.calls;
  for(const change of [body=>body.jobs[1].end=0,body=>body.jobs[1].budgetMiB='invalid',body=>body.jobs[1].outputDir='relative',body=>body.jobs[1].clientItemId=body.jobs[0].clientItemId]){
    const body=f.batch();change(body);const result=await f.request('/api/jobs/batch',body);assert.equal(result.status,400);
    const snapshot=await f.api('/api/jobs/queue');assert.equal(snapshot.activeJob,null);assert.equal(snapshot.queuedJobs.length,0);assert.equal(snapshot.batches.length,0);
    assert.equal(f.calls,baselineCalls,'batch validation does not contact the cloud');
  }
  const tooMany=f.batch('a',10);tooMany.jobs.push({...tooMany.jobs[0]});assert.equal((await f.request('/api/jobs/batch',tooMany)).status,400);
});

test('prefilled batch stays strictly serial, can skip a queued item, and continues after a failed first job', {timeout:45000}, async t => {
  const f=await fixture(t);f.gate();
  const created=await f.api('/api/jobs/batch',f.batch('b',4));assert.equal(created.jobs.length,4);
  await until(()=>f.api('/api/jobs/queue'),s=>s.activeJob?.status==='running'&&f.pending.size===1,'first job alone should run');
  const snapshot=await f.api('/api/jobs/queue');assert.equal(snapshot.concurrency,1);assert.equal(snapshot.queuedJobs.length,3);
  assert.equal(snapshot.activeSource.sourceId,f.source.sourceId);assert.doesNotMatch(JSON.stringify(snapshot.activeSource),/127\.0\.0\.1|headers|password|signature/);
  await wait(80);assert.equal(f.pending.size,1);assert.equal(f.peak,1,'queued siblings must not start their source recheck');
  const waiting=await f.api('/api/jobs/'+created.jobs[1].id+'/cancel',{});assert.equal(waiting.status,'cancelled');assert.equal(waiting.startedAt,undefined);
  f.release({failure:true});
  const results=await Promise.all(created.jobs.map(job=>f.finish(job.id)));
  assert.equal(results[0].status,'failed');assert.equal(results[1].status,'cancelled');
  for(const job of results.slice(2)){assert.equal(job.status,'completed',JSON.stringify(job.error));assert(job.startedAt);assert(job.metrics.receivedBytes<=32*1024*1024);assert.deepEqual(job.requested,{start:job===results[2]?3:4,end:job===results[2]?6:7,handles:0});}
  assert(Date.parse(results[2].startedAt)>=Date.parse(results[0].finishedAt));assert(Date.parse(results[3].startedAt)>=Date.parse(results[2].finishedAt));
  assert.equal(new Set(results.slice(2).map(job=>path.dirname(job.result.candidatePath))).size,2);
  assert.equal((await f.api('/api/jobs/queue')).activeJob,null);
  const history=JSON.parse(await readFile(path.join(f.root,'state/tasks.json'),'utf8'));
  assert.equal(history.jobs.find(job=>job.id===results[0].id).batchId,created.batchId);
  assert.deepEqual(history.jobs.find(job=>job.id===results[0].id).requested,{start:1,end:4,handles:0});
  assert.doesNotMatch(JSON.stringify(history),/127\.0\.0\.1|"(?:headers|authorization|cookie|sourceId|requestSignature)"\s*:|signature=/i);
});

test('concurrent or completed duplicate batch submissions return their original group exactly once', {timeout:30000}, async t => {
  const f=await fixture(t);f.gate();const body=f.batch('c',2);
  const attempts=await Promise.all([f.api('/api/jobs/batch',body),f.api('/api/jobs/batch',body)]);
  assert.deepEqual(attempts[0].jobs.map(job=>job.id),attempts[1].jobs.map(job=>job.id));
  const changed=structuredClone(body);changed.jobs[0].start=0;const rejected=await f.request('/api/jobs/batch',changed);assert.equal(rejected.status,400);assert.equal(rejected.data.error.code,'BATCH_CHANGED');
  const reordered={jobs:body.jobs.map(item=>Object.fromEntries(Object.entries(item).reverse())),clientBatchId:body.clientBatchId,sourceId:body.sourceId};assert.deepEqual((await f.api('/api/jobs/batch',reordered)).jobs.map(job=>job.id),attempts[0].jobs.map(job=>job.id));
  f.release();for(const job of attempts[0].jobs)assert.equal((await f.finish(job.id)).status,'completed');
  const again=await f.api('/api/jobs/batch',body);assert.deepEqual(again.jobs.map(job=>job.id),attempts[0].jobs.map(job=>job.id));assert(again.jobs.every(job=>job.status==='completed'));
  // The job endpoint reports a job finished a beat before the queue snapshot does:
  // settlement still has to write history and release the active slot. Poll for the
  // documented state instead of asserting on the exact tick the transfer ended.
  const snapshot=await until(()=>f.api('/api/jobs/queue'),state=>state.recentJobs.length===2,'both finished jobs must reach history');assert.equal(snapshot.batches.length,1);assert.equal(snapshot.batches[0].batchId,body.clientBatchId);assert.equal(snapshot.recentJobs.length,2);
  assert.deepEqual((await readdir(path.join(f.root,'outputs'))).sort(),['队列素材','队列素材 (2)']);
});

test('capacity and movie identity are rechecked atomically after asynchronous admission', {timeout:30000}, async t => {
  const f=await fixture(t);const other=await f.api('/api/probe',{source:{type:'local',value:path.resolve('examples/示例视频.mkv')}});f.gate();
  const first=await f.api('/api/jobs/batch',f.batch('d',10));await until(()=>f.api('/api/jobs/queue'),s=>s.activeJob?.id===first.jobs[0].id,'first starts');
  const foreign={...f.batch('e',1),sourceId:other.sourceId};const denied=await f.request('/api/jobs/batch',foreign);assert.equal(denied.status,400);assert.equal(denied.data.error.code,'SOURCE_BUSY');
  const room=f.batch('e',1),overflow=f.batch('f',1);const races=await Promise.all([f.request('/api/jobs/batch',room),f.request('/api/jobs/batch',overflow)]);assert.deepEqual(races.map(result=>result.status).sort(),[202,400]);
  const snapshot=await f.api('/api/jobs/queue');assert.equal(snapshot.queuedJobs.length,10);assert.equal(snapshot.batches.length,2);
  await f.app.close();
  const saved=JSON.parse(await readFile(path.join(f.root,'state/tasks.json'),'utf8'));assert.equal(saved.jobs.length,11);assert(saved.jobs.every(job=>job.status==='cancelled'));
  await until(async()=>f.pending.size,n=>n===0,'shutdown closes the one remote recheck');
});

test('deleting a finished history item preserves files, running jobs, and batch replay across later saves', {timeout:30000}, async t => {
  const f = await fixture(t);
  assert.equal((await f.api('/api/bootstrap')).defaults.handles, 5);
  const body = f.batch('a', 2);
  delete body.jobs[0].handles;
  const firstBatch = await f.api('/api/jobs/batch', body);
  const [first, second] = await Promise.all(firstBatch.jobs.map(job => f.finish(job.id)));
  assert.equal(first.status, 'completed');
  assert.equal(second.status, 'completed');
  assert.equal(first.requested.handles, 5);
  assert.equal(second.requested.handles, 0);
  await until(() => f.api('/api/jobs/queue'), state => state.recentJobs.length === 2, 'first batch must settle');
  const originalFiles = await Promise.all([first, second].flatMap(job =>
    [job.result.candidatePath, job.result.sidecarPath].map(async filename => ({ filename, bytes: await readFile(filename) }))));

  f.gate();
  const nextBatch = await f.api('/api/jobs/batch', f.batch('b', 2));
  const [running, waiting] = nextBatch.jobs;
  await until(() => f.api('/api/jobs/queue'), state => state.activeJob?.id === running.id && f.pending.size === 1, 'next batch must remain active');
  const deleteRoute = id => '/api/jobs/' + id + '/delete-history';
  const unauthorized = await fetch(f.app.url + deleteRoute(first.id), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(unauthorized.status, 403);
  for (const job of [running, waiting]) {
    const refused = await f.request(deleteRoute(job.id), {});
    assert.equal(refused.status, 409);
    assert.equal(refused.data.error.code, 'HISTORY_BUSY');
  }
  assert.deepEqual(await f.api(deleteRoute(first.id), {}), { ok: true, id: first.id });
  assert.equal((await f.request('/api/jobs/' + first.id)).status, 404);
  assert.equal((await f.request(deleteRoute(first.id), {})).status, 404);
  assert.equal((await f.api('/api/jobs/history')).jobs.some(job => job.id === first.id), false);
  const snapshot = await f.api('/api/jobs/queue');
  assert.equal(snapshot.activeJob.id, running.id);
  assert.deepEqual(snapshot.queuedJobs.map(job => job.id), [waiting.id]);
  assert.deepEqual(snapshot.recentJobs.map(job => job.id), [second.id]);
  assert.equal(snapshot.batches[0].jobCount, 2);
  assert.deepEqual(snapshot.batches[0].jobs.map(job => job.id), [second.id]);
  assert.deepEqual(await f.api('/api/jobs/batch', body), snapshot.batches[0]);
  assert.deepEqual(await f.api(deleteRoute(second.id), {}), { ok: true, id: second.id });
  const empty = await f.api('/api/jobs/batch', body);
  assert.equal(empty.batchId, firstBatch.batchId);
  assert.equal(empty.jobCount, 2);
  assert.deepEqual(empty.jobs, []);
  const changed = structuredClone(body);
  changed.jobs[0].start = 0;
  assert.equal((await f.request('/api/jobs/batch', changed)).data.error.code, 'BATCH_CHANGED');

  f.release();
  for (const job of [running, waiting]) assert.equal((await f.finish(job.id)).status, 'completed');
  await f.app.close();
  const outputDir = path.join(f.root, 'outputs'), dataDir = path.join(f.root, 'state');
  const reopened = await startServer({ outputDir, dataDir });
  try {
    const restored = await fetch(reopened.url + '/api/jobs/queue').then(r => r.json());
    assert.deepEqual(restored.recentJobs.map(job => job.id), [waiting.id, running.id]);
    assert.deepEqual(restored.batches, []);
    for (const { filename, bytes } of originalFiles) assert.deepEqual(await readFile(filename), bytes);
    assert.equal((await readdir(outputDir)).length, 4, 'batch replay did not create duplicate downloads');
  } finally {
    await reopened.close();
  }
});

test('bulk history deletion is durable alongside single deletion and later task saves', {timeout:30000}, async t => {
  const f = await fixture(t);
  const original = f.batch('a', 3);
  const batch = await f.api('/api/jobs/batch', original);
  const [first, second, third] = await Promise.all(batch.jobs.map(job => f.finish(job.id)));
  assert([first, second, third].every(job => job.status === 'completed'));
  await until(() => f.api('/api/jobs/queue'), state => state.recentJobs.length === 3, 'original jobs must settle');
  const files = await Promise.all([first, second, third].flatMap(job => [job.result.candidatePath, job.result.sidecarPath])
    .map(async file => ({ file, bytes: await readFile(file) })));

  f.gate();
  const { jobs: [running, waiting] } = await f.api('/api/jobs/batch', f.batch('b', 2));
  await until(() => f.api('/api/jobs/queue'), state => state.activeJob?.id === running.id && f.pending.size === 1, 'new batch must be active');
  const route = '/api/jobs/delete-history';
  const unauthorized = await fetch(f.app.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [first.id] }) });
  assert.equal(unauthorized.status, 403);
  for (const ids of [[], [first.id, first.id], [first.id, '../unsafe'], Array.from({ length: 101 }, (_, i) => `job-${i}`)]) {
    assert.equal((await f.request(route, { ids })).status, 400);
  }
  const [bulk, single] = await Promise.all([
    f.api(route, { ids: [first.id, running.id, second.id, waiting.id, 'missing-record'] }),
    f.api(`/api/jobs/${third.id}/delete-history`, {}),
  ]);
  assert.deepEqual(bulk, { ok: true, ids: [first.id, second.id],
    skipped: [{ id: running.id, code: 'HISTORY_BUSY' }, { id: waiting.id, code: 'HISTORY_BUSY' }, { id: 'missing-record', code: 'JOB_MISSING' }] });
  assert.deepEqual(single, { ok: true, id: third.id });
  assert.deepEqual(await f.api(route, { ids: [first.id, second.id] }), { ok: true, ids: [],
    skipped: [{ id: first.id, code: 'JOB_MISSING' }, { id: second.id, code: 'JOB_MISSING' }] });
  const snapshot = await f.api('/api/jobs/queue');
  assert.equal(snapshot.activeJob.id, running.id);
  assert.deepEqual(snapshot.queuedJobs.map(job => job.id), [waiting.id]);
  assert.deepEqual(snapshot.recentJobs, []);
  assert.deepEqual((await f.api('/api/jobs/batch', original)).jobs, []);
  assert.equal(snapshot.batches[0].jobCount, 3);

  f.release();
  for (const job of [running, waiting]) assert.equal((await f.finish(job.id)).status, 'completed');
  await f.app.close();
  const reopened = await startServer(f.options);
  try {
    const queue = await fetch(reopened.url + '/api/jobs/queue').then(r => r.json());
    assert.deepEqual(queue.recentJobs.map(job => job.id), [waiting.id, running.id]);
    for (const { file, bytes } of files) assert.deepEqual(await readFile(file), bytes);
    assert.equal((await readdir(f.options.outputDir)).length, 5);
  } finally {
    await reopened.close();
  }
});

test('history deletion requires explicit cache discard and leaves records visible on a write error', {timeout:30000}, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-history-delete-'));
  const dataDir = path.join(root, 'state'), outputDir = path.join(root, 'outputs');
  let app;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  const saved = await createHistoryStore(dataDir);
  const cachedId = 'clip-recoverable', orphanId = 'clip-untracked-cache', plainId = 'clip-history-only', otherId = 'clip-other-history';
  await saved.save([cachedId, orphanId, plainId, otherId].map(id => ({ id, status: 'failed' })));
  const resumeDirectory = path.join(dataDir, 'resume-data');
  const identity = { size: 512, sourceKey: 'a'.repeat(64), etagSha256: 'b'.repeat(64), headSha256: 'c'.repeat(64) };
  const cache = await openResumeStore({ directory: resumeDirectory, id: cachedId, identity, budgetBytes: 1024,
    plan: { version: 1, sourceStart: 128, sourceEnd: 256, prefixSha256: 'd'.repeat(64), timelineStartSeconds: 1, timelineEndSeconds: 2 } });
  try {
    await cache.put(128, Buffer.alloc(128, 9));
  } finally {
    await cache.close();
  }
  const resumeTasks = await createResumeTaskStore(path.join(dataDir, 'resume-jobs'));
  await resumeTasks.save({ id: cachedId, sourceKey: identity.sourceKey, params: { start: 1, end: 2, handles: 10, fetchStart: 0, fetchEnd: 12, outputDir, budgetBytes: 1024 } });

  app = await startServer({ outputDir, dataDir });
  const get = route => fetch(app.url + route).then(r => r.json());
  const { sessionToken } = await get('/api/bootstrap');
  const request = async (route, data) => {
    const r = await fetch(app.url + route, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-Session-Token': sessionToken }, body: JSON.stringify(data) });
    return { status: r.status, data: await r.json() };
  };
  const post = (id, action) => request(`/api/jobs/${id}/${action}`, {});
  const bulk = ids => request('/api/jobs/delete-history', { ids });
  const prior = await get('/api/jobs/' + cachedId);
  assert.equal(prior.resume.available, true);
  assert.equal(prior.requested.handles, 10, 'persisted resume settings retain their original handle duration');
  assert.equal(prior.resume.cachedBytes, 128);
  assert.deepEqual(prior.retry, { needsSourceConfirmation: false, needsSubtitleSelection: false });
  const refused = await post(cachedId, 'delete-history');
  assert.equal(refused.status, 409);
  assert.equal(refused.data.error.code, 'HISTORY_HAS_RESUME');
  assert.equal((await get('/api/jobs/' + cachedId)).resume.cachedBytes, 128);

  // Simulate a cache directory created before an unsuccessful open can attach
  // a resume snapshot to the live record.
  await mkdir(path.join(resumeDirectory, orphanId));
  assert.deepEqual(await bulk([cachedId, orphanId]), { status: 200, data: { ok: true, ids: [],
    skipped: [{ id: cachedId, code: 'HISTORY_HAS_RESUME' }, { id: orphanId, code: 'HISTORY_HAS_RESUME' }] } });
  assert.equal((await post(orphanId, 'delete-history')).data.error.code, 'HISTORY_HAS_RESUME');
  assert.equal((await get('/api/jobs/' + orphanId)).resume.discardable, true);
  for (const id of [cachedId, orphanId]) {
    assert.equal((await post(id, 'discard-resume')).status, 200);
    assert.equal((await post(id, 'delete-history')).status, 200);
  }

  const historyFile = path.join(dataDir, 'tasks.json');
  await rename(historyFile, historyFile + '.backup');
  await mkdir(historyFile);
  const failed = await post(plainId, 'delete-history');
  assert.equal(failed.status, 500);
  assert.equal(failed.data.error.code, 'HISTORY_WRITE_FAILED');
  const failedBulk = await bulk([plainId, otherId]);
  assert.equal(failedBulk.status, 500);
  assert.equal(failedBulk.data.error.code, 'HISTORY_WRITE_FAILED');
  assert.deepEqual((await get('/api/jobs/queue')).recentJobs.map(job => job.id), [otherId, plainId]);
  await rm(historyFile, { recursive: true });
  await rename(historyFile + '.backup', historyFile);
  assert.deepEqual(await bulk([plainId, otherId]), { status: 200, data: { ok: true, ids: [plainId, otherId], skipped: [] } });
  assert.deepEqual(await saved.load(), []);
  await app.close();
  app = await startServer({ outputDir, dataDir });
  assert.deepEqual((await get('/api/jobs/queue')).recentJobs, []);
});

test('history read failure is reported and the original file survives new exports and shutdown', { timeout: 30000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-history-restart-'));
  const options = { dataDir: path.join(root, 'state'), outputDir: path.join(root, 'exports') };
  const filename = path.join(options.dataDir, 'tasks.json');
  let app;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  await mkdir(options.dataDir);
  const damaged = '{"schemaVersion":1,"jobs":[';
  await writeFile(filename, damaged);
  app = await startServer(options);
  const get = route => fetch(app.url + route).then(response => response.json());
  const boot = await get('/api/bootstrap');
  assert.equal(boot.historyWarning, true);
  assert.equal(boot.historyReadWarning, true);
  assert.deepEqual(boot.recentJobs, []);
  async function post(route, body) {
    const response = await fetch(app.url + route, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': boot.sessionToken },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    assert(response.ok, JSON.stringify(data));
    return data;
  }
  const source = await post('/api/probe', { source: { type: 'local', value: boot.defaults.samplePath } });
  const { jobs: [created] } = await post('/api/jobs/batch', { sourceId: source.sourceId, clientBatchId: 'a'.repeat(32),
    jobs: [{ clientItemId: 'b'.repeat(32), start: 1, end: 4, handles: 0, clipName: '隔离测试素材', budgetMiB: 32, downloadMethod: 'indexed' }] });
  const snapshot = await until(() => get('/api/jobs/queue'),
    state => state.recentJobs.some(job => job.id === created.id), 'local export must settle');
  const completed = snapshot.recentJobs.find(job => job.id === created.id);
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
  assert((await readFile(completed.result.candidatePath)).length > 0);
  assert.equal(await readFile(filename, 'utf8'), damaged);
  await app.close();
  assert.equal(await readFile(filename, 'utf8'), damaged);
  // Once a valid history is restored, a fresh application run can use it.
  await writeFile(filename, JSON.stringify({ schemaVersion: 1, jobs: [{ id: 'restored', status: 'completed' }] }));
  app = await startServer(options);
  const recovered = await get('/api/bootstrap');
  assert.equal(recovered.historyWarning, false);
  assert.equal(recovered.historyReadWarning, false);
  assert.deepEqual(recovered.recentJobs.map(job => job.id), ['restored']);
});

test('failed extraction retries once from its checked source, and a cancelled retry keeps its settings across restart', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const body = f.batch('c', 1);
  body.jobs[0] = { ...body.jobs[0], clipName: '原重试名称', start: 2, end: 5, handles: 1, budgetMiB: 16 };
  f.gate();
  const { jobs: [original] } = await f.api('/api/jobs/batch', body);
  await until(async () => f.pending.size, size => size === 1, 'original check must wait at the fixture');
  f.release({ failure: 503 });
  const settled = async id => until(() => f.api('/api/jobs/queue'), state => state.recentJobs.some(job => job.id === id), 'history row must settle');
  const failure = (await settled(original.id)).recentJobs[0];
  assert.equal(failure.status, 'failed');
  assert.deepEqual(failure.retry, { sourceId: f.source.sourceId, needsSourceConfirmation: false, needsSubtitleSelection: false });
  assert.equal(failure.retrySettings, undefined);
  const different = await f.api('/api/probe', { source: { type: 'local', value: path.resolve('examples/示例视频.mkv') } });
  const retryPath = '/api/jobs/' + original.id + '/retry';
  assert.equal((await f.request(retryPath, { sourceId: different.sourceId, confirmSource: true })).data.error.code, 'RETRY_SOURCE_MISMATCH');

  f.gate();
  const [child, replay] = await Promise.all([f.api(retryPath, {}), f.api(retryPath, {})]);
  assert.equal(child.id, replay.id);
  assert.equal(child.retryOf, original.id);
  assert.equal(child.clipName, '原重试名称');
  assert.deepEqual(child.requested, { start: 2, end: 5, handles: 1 });
  assert.equal(child.metrics.budgetBytes, 16 * 1024 * 1024);
  await until(async () => f.pending.size, size => size === 1, 'single retry should start');
  const queue = await f.api('/api/jobs/queue');
  assert.equal(queue.activeJob.id, child.id);
  assert.deepEqual(queue.queuedJobs, []);
  assert.equal(queue.recentJobs[0].retry.jobId, child.id);
  await f.api('/api/jobs/' + child.id + '/cancel', {});
  const cancelled = (await settled(child.id)).recentJobs.find(job => job.id === child.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.retry.needsSubtitleSelection, false);
  f.release();
  await f.app.close();

  const reopened = await startServer(f.options);
  try {
    const bootstrap = await fetch(reopened.url + '/api/bootstrap').then(r => r.json());
    const request = async (route, data) => {
      const res = await fetch(reopened.url + route, data === undefined ? {} : { method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken }, body: JSON.stringify(data) });
      return { status: res.status, data: await res.json() };
    };
    const childPath = '/api/jobs/' + child.id + '/retry';
    assert.equal((await request(retryPath, {})).data.id, child.id);
    assert.equal((await request(childPath, {})).data.error.code, 'RETRY_SOURCE_REQUIRED');
    assert.equal((await request('/api/probe', f.probeInput)).status, 200);
    const retry = await request(childPath, {});
    assert.equal(retry.status, 202);
    assert.equal(retry.data.retryOf, child.id);
    assert.deepEqual(retry.data.requested, child.requested);
    const complete = await until(async () => (await request('/api/jobs/' + retry.data.id)).data, terminal, 'restored retry must finish');
    assert.equal(complete.status, 'completed', JSON.stringify(complete.error));
    await until(async () => (await request('/api/jobs/queue')).data, state => state.recentJobs.some(job => job.id === complete.id), 'completed child must settle');
    assert.equal((await request('/api/jobs/' + complete.id + '/delete-history', {})).status, 200);
    assert.equal((await request(childPath, {})).data.error.code, 'RETRY_ALREADY_SUBMITTED');
    assert.equal((await request('/api/jobs/' + complete.id)).status, 404);
  } finally {
    await reopened.close();
  }
});

test('legacy history preserves known settings and asks for source confirmation and subtitle choice before retry', { timeout: 30000 }, async t => {
  const legacy = { id: 'clip-legacy-failure', status: 'failed', sourceLabel: 'movie.mkv', clipName: '旧片段名称',
    requested: { start: 2, end: 4, handles: 3 }, downloadMethod: 'indexed', metrics: { budgetBytes: 32 * 1024 * 1024 } };
  const f = await fixture(t, [legacy]);
  const old = await f.api('/api/jobs/' + legacy.id);
  assert.deepEqual(old.retry, { needsSourceConfirmation: true, needsSubtitleSelection: true });
  const route = '/api/jobs/' + legacy.id + '/retry', sourceId = f.source.sourceId;
  assert.equal((await f.request(route, {})).data.error.code, 'RETRY_SOURCE_REQUIRED');
  assert.equal((await f.request(route, { sourceId })).data.error.code, 'RETRY_SOURCE_CONFIRM_REQUIRED');
  assert.equal((await f.request(route, { sourceId, confirmSource: true })).data.error.code, 'RETRY_SUBTITLE_REQUIRED');
  assert.equal((await f.request(route, { sourceId, confirmSource: true, subtitleStreamIndex: 99 })).data.error.code, 'RETRY_SUBTITLE_CHANGED');
  const accepted = await f.request(route, { sourceId, confirmSource: true, subtitleStreamIndex: null });
  assert.equal(accepted.status, 202);
  assert.deepEqual(accepted.data.requested, legacy.requested);
  assert.equal(accepted.data.clipName, legacy.clipName);
  assert.equal((await f.finish(accepted.data.id)).status, 'completed');
});

test('an expired checked entry cannot be retried before the same source is checked again', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  f.gate();
  const { jobs: [job] } = await f.api('/api/jobs/batch', f.batch('a', 1));
  await until(async () => f.pending.size, size => size === 1, 'range request must be waiting');
  f.release({ failure: 404 });
  const settled = await until(() => f.api('/api/jobs/queue'), state => state.recentJobs.some(item => item.id === job.id), 'failed job must settle');
  assert.equal(settled.recentJobs[0].status, 'failed');
  assert.equal(settled.recentJobs[0].retry.sourceId, undefined);
  const route = '/api/jobs/' + job.id + '/retry';
  assert.equal((await f.request(route, { sourceId: f.source.sourceId })).data.error.code, 'RETRY_SOURCE_REQUIRED');
  const refreshed = await f.api('/api/probe', f.probeInput);
  assert.notEqual(refreshed.sourceId, f.source.sourceId);
  const child = await f.api(route, {});
  assert.equal(child.sourceId, refreshed.sourceId);
  assert.equal((await f.finish(child.id)).status, 'completed');
});
