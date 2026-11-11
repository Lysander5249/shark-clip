import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueueWorkspace } from '../public/queue-workspace.mjs';
class Element {
 constructor(tag='div'){this.tag=tag;this.children=[];this.value='';this.textContent='';this.hidden=false;this.disabled=false;this.attributes={};this.listeners={};this.classList={toggle(){}};}
 append(...items){this.children.push(...items)}replaceChildren(...items){this.children=[...items]}setAttribute(k,v){this.attributes[k]=v}removeAttribute(k){delete this.attributes[k]}addEventListener(k,f){this.listeners[k]=f}set innerHTML(_){throw new Error('unsafe HTML')}
}
const terminal=j=>['completed','failed','cancelled'].includes(j.status);
function all(root){return[root,...root.children.flatMap(all)]}
function harness({ready=true,handler,onChooseSource}={}){
 const editor=new Element(),status=new Element(),jobs=new Map(),batches=new Map(),requests=[],timers=new Map(),focused=[],completions=[],removed=[];let key=0,tid=0;
 const context={ready,sourceId:ready?'film':'',label:'测试电影',kind:'browser',duration:600,sizeBytes:6*1024**3,handles:5,request:{outputDir:'/synthetic/output',budgetMiB:256,readMode:'standard',makeMp4:false,reuseIndex:true},subtitles:[{index:2,supported:true,label:'中文SRT'}]};
 const snapshot=()=>({activeJob:[...jobs.values()].find(j=>j.status==='running'),queuedJobs:[...jobs.values()].filter(j=>j.status==='queued'),recentJobs:[...jobs.values()].filter(terminal),batches:[...batches.values()]});
 const fallback=async(route,options={})=>{
  if(route==='/api/jobs/queue')return snapshot();
  if(route==='/api/jobs/batch'){
   const body=options.body;if(batches.has(body.clientBatchId))return batches.get(body.clientBatchId);
   const list=body.jobs.map((p,i)=>({id:`job-${jobs.size+i}`,type:'extract',batchId:body.clientBatchId,clientItemId:p.clientItemId,sourceId:body.sourceId,status:i===0?'running':'queued',stage:i===0?'extract':'queued',clipName:p.clipName,requested:{start:p.start,end:p.end,handles:p.handles},createdAt:'2026-11-06T00:00:00Z',startedAt:i===0?'2026-11-06T00:01:00Z':undefined,metrics:{receivedBytes:0}}));
   for(const j of list)jobs.set(j.id,j);const result={batchId:body.clientBatchId,jobs:list};batches.set(body.clientBatchId,result);return result;
  }
  const match=/^\/api\/jobs\/([^/]+)\/cancel$/.exec(route);if(match){const j={...jobs.get(match[1]),status:'cancelled'};jobs.set(j.id,j);return j;}
  const deletion=/^\/api\/jobs\/([^/]+)\/delete-history$/.exec(route);if(deletion){jobs.delete(deletion[1]);return{ok:true,id:deletion[1]};}
  if(route==='/api/reveal')return{ok:true};throw new Error(route);
 };
 const api=async(route,options)=>{requests.push({route,method:options?.method,body:options?.body&&structuredClone(options.body)});return handler?handler(route,options,fallback,{jobs,batches,snapshot}):fallback(route,options)};
 const ui=createQueueWorkspace({editor,status,api,getContext:()=>context,document:{createElement:t=>new Element(t)},requestId:()=>String(++key).padStart(32,'0'),now:()=>Date.parse('2026-11-06T00:03:00Z'),setTimer:(f,ms)=>{timers.set(++tid,{f,ms});return tid},clearTimer:id=>timers.delete(id),onSource:s=>Object.assign(context,{sourceId:s.sourceId,ready:true}),onFocus:j=>focused.push(j),onComplete:j=>completions.push(j),onRecordRemoved:id=>removed.push(id),onChooseSource});
 return{ui,editor,status,context,jobs,batches,requests,timers,focused,completions,removed,find(id){return all(editor).find(e=>e.id===id)},async fire(){const copy=[...timers];timers.clear();for(const [,t]of copy)await t.f()}};
}
function fill(row,start,end,name){Object.assign(row,{start:String(start),end:String(end),name,editedName:true,edited:true});}

test('three editable list rows are present before first download, add/remove remains bounded',()=>{
 const h=harness({ready:false});assert.equal(h.ui.rows.length,3);assert.equal(all(h.editor).filter(e=>e.tag==='section').length,3);assert(!h.ui.hasDraft());
 for(let i=0;i<15;i++)h.ui.add();assert.equal(h.ui.rows.length,10);for(const row of [...h.ui.rows])h.ui.remove(row.id);assert.equal(h.ui.rows.length,1);assert.equal(h.requests.length,0);h.ui.dispose();
});
test('whole list is validated before one atomic submission and submitted settings are frozen',async()=>{
 const h=harness();fill(h.ui.rows[0],1,10,'甲');fill(h.ui.rows[1],20,30,'乙');Object.assign(h.ui.rows[1],{subtitle:'2',handles:'3',budget:'4096',editedBudget:true});
 await h.ui.submit();const posts=h.requests.filter(r=>r.route==='/api/jobs/batch');assert.equal(posts.length,1);assert.equal(posts[0].body.jobs.length,2);assert.deepEqual(posts[0].body.jobs.map(j=>j.clipName),['甲','乙']);assert.equal(posts[0].body.jobs[1].subtitleStreamIndex,2);assert.equal(posts[0].body.jobs[1].budgetMiB,4096);assert.equal(h.ui.rows.length,3);assert(h.ui.rows.every(r=>r.start===''));assert(h.ui.hasActivity());h.context.request.outputDir='/changed';assert.equal(posts[0].body.jobs[0].outputDir,'/synthetic/output');h.ui.dispose();
});
test('each new draft uses five seconds before and after a batch, and user edits survive refresh', async () => {
  const h = harness();
  h.context.handles = 10;
  assert.deepEqual(h.ui.rows.map(row => row.handles), ['5', '5', '5']);
  h.ui.add();
  assert.equal(h.ui.rows.at(-1).handles, '5');
  const input = h.find(`queue-${h.ui.rows[0].id}-handles`);
  input.value = '17';
  input.listeners.input();
  h.ui.refresh();
  fill(h.ui.rows[1], 100, 140, '五秒');
  await h.ui.submit();
  const post = h.requests.find(request => request.route === '/api/jobs/batch');
  assert.deepEqual(post.body.jobs.map(job => job.handles), [17, 5]);
  assert.deepEqual(h.ui.rows.map(row => row.handles), ['5', '5', '5']);
  h.ui.dispose();
});
test('one bad row prevents any partial submission and definite server refusal allows corrections',async()=>{
 const h=harness({handler:async(route,opt,fallback)=>{if(route==='/api/jobs/batch')throw Object.assign(new Error('无法保存'),{status:400,code:'OUTPUT_INVALID'});return fallback(route,opt)}});
 fill(h.ui.rows[1],30,10,'错误');await h.ui.submit();assert.equal(h.requests.length,0);fill(h.ui.rows[1],30,40,'修正');await h.ui.submit();assert(!h.ui.uncertain);assert.equal(h.ui.pending,null);assert(h.find(`queue-${h.ui.rows[0].id}-start`).disabled===false);h.ui.dispose();
});
test('a lost response recovers the complete batch even if every job has already finished',async()=>{
 let first=true;const h=harness({handler:async(route,opt,fallback,{jobs,batches})=>{const result=await fallback(route,opt);if(route==='/api/jobs/batch'&&first){first=false;for(const j of result.jobs){j.status='completed';j.stage='completed';jobs.set(j.id,j)}batches.set(result.batchId,result);throw new Error('响应丢失')}return result}});
 await h.ui.submit();assert(!h.ui.uncertain);assert.equal(h.ui.jobs.length,1);assert.equal(h.ui.jobs[0].status,'completed');assert.equal(h.requests.filter(r=>r.route==='/api/jobs/batch').length,1);h.ui.dispose();
});
test('unknown submission retains original body and key; empty live list does not authorize a new batch',async()=>{
 const h=harness({handler:async(route,opt,fallback)=>{if(route==='/api/jobs/batch')throw new Error('断连');return fallback(route,opt)}});await h.ui.submit();assert(h.ui.uncertain);const original=structuredClone(h.ui.pending);h.context.request.outputDir='/changed';h.ui.rows[0].start='200';await h.ui.submit(true);assert.deepEqual(h.requests.filter(r=>r.route==='/api/jobs/batch')[1].body,original);assert(h.ui.hasActivity());h.ui.dispose();
});
test('polling updates results without replacing draft inputs or resetting partially typed values',async()=>{
 const h=harness();const id=h.ui.rows[1].id,input=h.find(`queue-${id}-start`);input.value='12:';input.listeners.input();h.ui.hydrate({activeJob:{id:'running',status:'running',stage:'extract',createdAt:'2026-11-06T00:00:00Z'},queuedJobs:[],recentJobs:[]});assert.equal(h.find(`queue-${id}-start`),input);assert.equal(input.value,'12:');assert(h.ui.hasDraft());h.ui.dispose();
});
test('checking retains the active progress and waiting controls across queue refreshes', () => {
  const h = harness();
  const first = { id: 'first', status: 'running', stage: 'checking', progress: null };
  const second = { id: 'second', status: 'queued' };
  const snapshot = { activeJob: first, queuedJobs: [second], recentJobs: [] };
  const findProgress = () => all(h.status).find(element => element.tag === 'progress');
  const findWaitingRow = () => all(h.status).find(element => element.className === 'queue-job queue-job-waiting');
  h.ui.hydrate(snapshot);
  const progress = findProgress(), waitingRow = findWaitingRow();
  h.ui.hydrate({ ...snapshot, activeJob: { ...first, metrics: { receivedBytes: 1024 } } });
  assert.equal(findProgress(), progress);
  assert.equal(findWaitingRow(), waitingRow);
  assert.equal(progress.attributes.value, undefined);

  h.ui.hydrate({ ...snapshot, activeJob: { ...first, stage: 'fetch', progress: 42 } });
  assert.equal(findProgress(), progress);
  assert.equal(progress.value, 42);
  h.ui.hydrate({ activeJob: { ...second, status: 'running', stage: 'checking' }, queuedJobs: [], recentJobs: [] });
  assert.notEqual(findProgress(), progress);
  h.ui.dispose();
});
test('waiting cancellation preserves the running task and a failed first item does not lock later execution',async()=>{
 const h=harness();await h.ui.submit();const active=h.ui.jobs[0];const waiting={id:'wait',status:'queued',createdAt:active.createdAt};h.jobs.set('wait',waiting);await h.ui.sync();await h.ui.cancel(waiting);assert.equal(h.jobs.get(active.id).status,'running');assert.equal(h.jobs.get('wait').status,'cancelled');h.jobs.set(active.id,{...active,status:'failed',finishedAt:'2026-11-06T00:02:00Z'});h.jobs.set('next',{id:'next',status:'running',startedAt:'2026-11-06T00:02:00Z'});await h.ui.sync();assert(h.ui.hasActivity());assert.equal(h.focused.at(-1).id,'next');h.ui.dispose();
});
test('queue and work clocks remain separate, including older records without startedAt',()=>{
 const h=harness();const t=h.ui.queueTime({status:'completed',createdAt:'2026-11-06T00:00:00Z',startedAt:'2026-11-06T00:01:00Z',finishedAt:'2026-11-06T00:03:00Z'});assert.deepEqual(t,{waiting:60000,working:120000});const old=h.ui.queueTime({status:'completed',diagnostics:{elapsedMs:300000,stages:{extract:90000,probe:10000}}});assert.deepEqual(old,{waiting:200000,working:100000});h.ui.dispose();
});
test('resumed records use the latest queued timestamp when available', () => {
  const h = harness();
  assert.deepEqual(h.ui.queueTime({ status: 'completed', createdAt: '2026-11-01T00:00:00Z', queuedAt: '2026-11-06T00:00:00Z',
    startedAt: '2026-11-06T00:00:05Z', finishedAt: '2026-11-06T00:00:30Z' }), { waiting: 5000, working: 25000 });
  h.ui.dispose();
});
test('automatic budget follows each segment estimate and a manual cap is never overwritten',()=>{
 const h=harness();fill(h.ui.rows[0],0,20,'短');fill(h.ui.rows[1],0,200,'长');h.ui.refresh();assert(Number(h.ui.rows[1].budget)>Number(h.ui.rows[0].budget));h.ui.rows[1].editedBudget=true;h.ui.rows[1].budget='123';h.ui.refresh();assert.equal(h.ui.rows[1].budget,'123');h.ui.dispose();
});

test('local queue summary never presents an HTTP byte cap',()=>{
 const h=harness();h.context.kind='local';h.ui.refresh();const notice=all(h.editor).find(e=>e.className==='queue-budget-notice field-hint');assert.match(notice.textContent,/本地文件不受HTTP读取上限/);assert.doesNotMatch(notice.textContent,/MiB|GiB|合计最多/);h.ui.dispose();
});

const rowsOfHistory = h => all(h.status).filter(node => node.className === 'queue-job queue-job-recent');
const button = (root, label) => all(root).find(node => node.tag === 'button' && node.textContent === label);
const historicalRecord = (index) => ({
  id: `old-${index}`, status: 'completed', sourceLabel: `旧电影${index}`, createdAt: '2026-11-01T00:00:00Z',
  result: { candidatePath: '/synthetic/movie/candidate.mkv', requested: { start: 12, end: 47, handles: 10 } },
});

test('one queue shows live work once, with pageable historical records and preserved legacy ranges', () => {
  const h = harness();
  const records = Array.from({ length: 8 }, (_, index) => historicalRecord(index));
  const active = { ...records[0], status: 'running' };
  const waiting = { ...records[1], status: 'queued' };
  const snapshot = { activeJob: active, queuedJobs: [waiting], recentJobs: records };
  h.ui.hydrate(snapshot);
  const section = all(h.status).find(node => node.className === 'queue-history');
  assert.equal(section.tag, 'details');
  assert.equal(section.children[0].textContent, '历史记录（6）');
  assert.equal(rowsOfHistory(h).length, 5);
  const first = rowsOfHistory(h)[0];
  assert(all(first).some(node => node.textContent === '源时间 00:00:12–00:00:47 · 前后各 10 秒'));
  button(first, '删除记录').listeners.click();
  const confirmation = button(rowsOfHistory(h)[0], '确认删除');
  assert(confirmation);
  h.ui.hydrate(snapshot);
  assert.equal(button(rowsOfHistory(h)[0], '确认删除'), confirmation);
  button(section, '下一页').listeners.click();
  assert.equal(rowsOfHistory(h).length, 1);
  button(rowsOfHistory(h)[0], '详情').listeners.click();
  assert.equal(h.focused.at(-1).id, 'old-7');
  assert.equal(h.requests.length, 0);
  h.ui.dispose();
});

test('deletion requires confirmation, removes only the chosen record and filters stale polls', async () => {
  let completePoll;
  const h = harness({ handler: async (route, options, fallback, { snapshot }) => {
    if (route !== '/api/jobs/queue') return fallback(route, options);
    const stale = snapshot();
    return new Promise(resolve => { completePoll = () => resolve(stale); });
  } });
  const old = historicalRecord(1), active = { id: 'active', status: 'running' };
  h.jobs.set(old.id, old);
  h.jobs.set(active.id, active);
  h.ui.hydrate({ activeJob: active, queuedJobs: [], recentJobs: [old] });
  button(rowsOfHistory(h)[0], '详情').listeners.click();
  button(rowsOfHistory(h)[0], '删除记录').listeners.click();
  assert.equal(h.requests.length, 0);
  assert(all(rowsOfHistory(h)[0]).some(node => /视频、字幕和导出文件夹会保留/.test(node.textContent)));
  button(rowsOfHistory(h)[0], '保留记录').listeners.click();
  assert.equal(h.requests.length, 0);
  const poll = h.ui.sync();
  button(rowsOfHistory(h)[0], '删除记录').listeners.click();
  await button(rowsOfHistory(h)[0], '确认删除').listeners.click();
  assert.deepEqual(h.requests[1], { route: '/api/jobs/old-1/delete-history', method: 'POST', body: {} });
  completePoll();
  await poll;
  assert.deepEqual(h.removed, [old.id]);
  assert.equal(rowsOfHistory(h).length, 0);
  assert.equal(h.ui.jobs[0].id, 'active');
  assert(h.ui.hasActivity());
  h.ui.dispose();
});

test('a retained resume cache gives a clear instruction and leaves the history record accessible', async () => {
  const old = { ...historicalRecord(1), status: 'failed' };
  const h = harness({ handler: async (route, options, fallback, { jobs }) => {
    if (route.endsWith('/delete-history')) {
      jobs.set(old.id, { ...old, resume: { available: false, discardable: true } });
      throw Object.assign(new Error('保留缓存'), { code: 'HISTORY_HAS_RESUME' });
    }
    return fallback(route, options);
  } });
  h.ui.hydrate({ recentJobs: [old] });
  button(rowsOfHistory(h)[0], '删除记录').listeners.click();
  await button(rowsOfHistory(h)[0], '确认删除').listeners.click();
  assert(all(h.status).some(node => /清除续传缓存后再删除记录/.test(node.textContent) && !node.hidden));
  button(rowsOfHistory(h)[0], '详情').listeners.click();
  assert.equal(h.focused.at(-1).id, old.id);
  assert.equal(h.focused.at(-1).resume.discardable, true);
  assert.equal(h.removed.length, 0);
  h.ui.dispose();
});

test('recovering a lost batch response recognizes its original job count after record deletion', async () => {
  const h = harness({ handler: async (route, options, fallback, { batches }) => {
    if (route !== '/api/jobs/batch') return fallback(route, options);
    batches.set(options.body.clientBatchId, { batchId: options.body.clientBatchId, jobCount: 1, jobs: [] });
    throw new Error('响应丢失');
  } });
  await h.ui.submit();
  assert.equal(h.ui.uncertain, false);
  assert.equal(h.ui.pending, null);
  assert.equal(h.ui.jobs.length, 0);
  assert(h.ui.rows.every(row => row.start === ''));
  h.ui.dispose();
});

const failedRecord = (retry = { sourceId: 'film' }) => ({
  id: 'failed', status: 'failed', type: 'extract', clipName: '原素材名称', sourceLabel: '原影片',
  requested: { start: 30, end: 60, handles: 10 }, retry,
});
const retryPanel = h => all(h.status).find(node => node.className === 'queue-retry-panel');

test('bulk deletion confirms all eligible history pages once and preserves newer records, queue, retry and draft', async () => {
  const route = '/api/jobs/delete-history';
  const h = harness({ handler: async (path, options, fallback, { jobs }) => {
    if (path !== route) return fallback(path, options);
    const { ids } = options.body;
    for (const id of ids) jobs.delete(id);
    return { ok: true, ids, skipped: [] };
  } });
  const pending = failedRecord({ needsSourceConfirmation: true });
  const cached = { ...historicalRecord(20), status: 'failed', resume: { available: true, discardable: true } };
  const orphan = { ...historicalRecord(21), status: 'failed', resume: { available: false, discardable: true } };
  const removable = Array.from({ length: 7 }, (_, index) => historicalRecord(index));
  const active = { id: 'active', status: 'running' };
  const waiting = { id: 'waiting', status: 'queued' };
  const snapshot = { activeJob: active, queuedJobs: [waiting], recentJobs: [pending, ...removable, cached, orphan] };
  for (const job of [active, waiting, ...snapshot.recentJobs]) h.jobs.set(job.id, job);
  h.ui.hydrate(snapshot);
  const draft = h.ui.rows[0];
  fill(draft, 300, 330, '待提交草稿');
  h.ui.refresh();
  button(rowsOfHistory(h)[0], '重试').listeners.click();
  assert.equal(retryPanel(h).hidden, false);
  button(rowsOfHistory(h)[1], '详情').listeners.click();

  const bulk = button(h.status, '批量删除');
  const confirmation = all(h.status).find(node => node.className === 'queue-record-confirm queue-history-confirm');
  bulk.listeners.click();
  assert.equal(confirmation.hidden, false);
  assert.match(confirmation.children[0].textContent, /各页共 7 条历史记录/);
  button(confirmation, '取消').listeners.click();
  assert.equal(confirmation.hidden, true);
  assert.equal(h.requests.length, 0);

  bulk.listeners.click();
  const next = { ...waiting, status: 'running' };
  const newWaiter = { id: 'new-waiting', status: 'queued' };
  const newlyFinished = { ...active, status: 'completed' };
  for (const job of [next, newWaiter, newlyFinished]) h.jobs.set(job.id, job);
  const updated = { activeJob: next, queuedJobs: [newWaiter], recentJobs: [newlyFinished, ...snapshot.recentJobs] };
  h.ui.hydrate(updated);
  button(h.status, '下一页').listeners.click();
  assert.equal(rowsOfHistory(h).length, 5);
  assert.match(confirmation.children[0].textContent, /各页共 7 条历史记录/);
  await button(confirmation, '确认批量删除').listeners.click();

  const ids = removable.map(job => job.id);
  assert.deepEqual(h.requests, [{ route, method: 'POST', body: { ids } }]);
  h.ui.hydrate(updated);
  assert.deepEqual(h.ui.jobs.map(job => job.id), [next.id, newWaiter.id, newlyFinished.id, pending.id, cached.id, orphan.id]);
  assert.deepEqual(h.removed, ids);
  assert.equal(rowsOfHistory(h).length, 4);
  assert.equal(retryPanel(h).hidden, false);
  assert.equal(h.ui.rows[0], draft);
  assert.equal(draft.name, '待提交草稿');
  assert(all(h.status).some(node => !node.hidden && /已删除 7 条历史记录/.test(node.textContent)));
  h.ui.dispose();
});

test('bulk deletion reconciles confirmed removals and missing records while refreshing a newly protected cache', async () => {
  const [removed, missing, cached] = [1, 2, 3].map(historicalRecord);
  const h = harness({ handler: async (route, options, fallback, { jobs }) => {
    if (route !== '/api/jobs/delete-history') return fallback(route, options);
    jobs.delete(removed.id);
    jobs.delete(missing.id);
    jobs.set(cached.id, { ...cached, resume: { available: false, discardable: true } });
    return { ok: true, ids: [removed.id], skipped: [
      { id: missing.id, code: 'JOB_MISSING' }, { id: cached.id, code: 'HISTORY_HAS_RESUME' },
    ] };
  } });
  for (const job of [removed, missing, cached]) h.jobs.set(job.id, job);
  h.ui.hydrate({ recentJobs: [...h.jobs.values()] });
  button(h.status, '批量删除').listeners.click();
  await button(h.status, '确认批量删除').listeners.click();

  assert.deepEqual(h.removed, [removed.id, missing.id]);
  assert.deepEqual(h.ui.jobs.map(job => job.id), [cached.id]);
  assert.equal(h.ui.jobs[0].resume.discardable, true);
  assert(button(h.status, '批量删除').disabled);
  assert.deepEqual(h.requests.map(request => request.route), ['/api/jobs/delete-history', '/api/jobs/queue']);
  const notice = all(h.status).find(node => node.className === 'queue-history-notice field-hint');
  assert.match(notice.textContent, /已删除 1 条历史记录/);
  assert.match(notice.textContent, /另有 1 条记录暂时无法删除/);
  h.ui.dispose();
});

test('an incomplete bulk deletion response leaves records visible until a fresh snapshot confirms removal', async () => {
  const first = historicalRecord(1), second = historicalRecord(2);
  const h = harness({ handler: async (route, options, fallback, { jobs }) => {
    if (route !== '/api/jobs/delete-history') return fallback(route, options);
    jobs.delete(first.id);
    return { ok: true, ids: [first.id], skipped: [] };
  } });
  for (const job of [first, second]) h.jobs.set(job.id, job);
  h.ui.hydrate({ recentJobs: [...h.jobs.values()] });
  button(h.status, '批量删除').listeners.click();
  await button(h.status, '确认批量删除').listeners.click();

  assert.deepEqual(h.ui.jobs.map(job => job.id), [first.id, second.id]);
  assert.deepEqual(h.removed, []);
  assert(all(h.status).some(node => !node.hidden && /删除结果尚未确认/.test(node.textContent)));
  await h.ui.sync();
  assert.deepEqual(h.ui.jobs.map(job => job.id), [second.id]);
  h.ui.dispose();
});

test('one click appends a retry after waiting items, keeps another film draft, and ignores double clicks', async () => {
  let finishPost;
  const h = harness({ handler: async (route, options, fallback) => {
    if (route === '/api/jobs/failed/retry') return new Promise(resolve => { finishPost = resolve; });
    return fallback(route, options);
  } });
  const old = failedRecord();
  const first = { id: 'first', status: 'running', sourceId: 'film' };
  const next = { id: 'next', status: 'queued', sourceId: 'film' };
  h.context.sourceId = 'different-draft';
  h.ui.hydrate({ activeJob: first, queuedJobs: [next], recentJobs: [old] });
  const row = h.ui.rows[0];
  fill(row, 300, 330, '保留另片草稿');
  const input = h.find(`queue-${row.id}-start`);
  const action = button(rowsOfHistory(h)[0], '重试');
  const pending = action.listeners.click();
  await action.listeners.click();
  assert.deepEqual(h.requests, [{ route: '/api/jobs/failed/retry', method: 'POST', body: {} }]);
  assert.match(retryPanel(h).children[1].textContent, /正在加入顺序队列/);
  finishPost({ id: 'retry', retryOf: old.id, status: 'queued', sourceId: 'film', requested: old.requested });
  await pending;
  assert.deepEqual(h.ui.jobs.filter(job => job.status === 'queued').map(job => job.id), [next.id, 'retry']);
  assert.equal(h.ui.rows[0], row);
  assert.equal(h.find(`queue-${row.id}-start`), input);
  assert.equal(h.ui.rows[0].name, '保留另片草稿');
  assert.equal(retryPanel(h).hidden, true);
  button(rowsOfHistory(h)[0], '查看重试任务').listeners.click();
  assert.equal(h.focused.at(-1).id, 'retry');
  h.ui.dispose();
});

test('expired and mismatched sources leave a pending retry until the user explicitly confirms a fresh source', async () => {
  let chosen = 0;
  const h = harness({ onChooseSource: () => { chosen += 1; }, handler: async (route, options, fallback) => {
    if (route !== '/api/jobs/failed/retry') return fallback(route, options);
    if (!options.body.sourceId) throw Object.assign(new Error('原链接已失效'), { code: 'RETRY_SOURCE_REQUIRED', status: 400 });
    if (options.body.sourceId === 'wrong') throw Object.assign(new Error('这不是原影片'), { code: 'RETRY_SOURCE_MISMATCH', status: 400 });
    return { id: 'retry', retryOf: 'failed', status: 'queued' };
  } });
  const old = failedRecord();
  h.ui.hydrate({ recentJobs: [old] });
  await button(rowsOfHistory(h)[0], '重试').listeners.click();
  button(retryPanel(h), '去检查同一原片').listeners.click();
  assert.equal(chosen, 1);
  assert.equal(h.requests.length, 1);
  assert(all(retryPanel(h)).some(node => /时间、名称和余量已保留/.test(node.textContent)));
  Object.assign(h.context, { sourceId: 'wrong', label: '其他影片' });
  h.ui.refresh();
  assert.equal(h.requests.length, 1, 'checking a source does not submit a retry');
  await button(retryPanel(h), '确认同片并重试').listeners.click();
  assert(all(retryPanel(h)).some(node => node.textContent === '这不是原影片'));
  assert.equal(button(retryPanel(h), '确认同片并重试'), undefined);
  Object.assign(h.context, { sourceId: 'fresh-film', label: '原影片' });
  h.ui.refresh();
  assert(!all(retryPanel(h)).some(node => node.textContent === '这不是原影片'));
  await button(retryPanel(h), '确认同片并重试').listeners.click();
  assert.deepEqual(h.requests.map(request => request.body), [{}, { sourceId: 'wrong' }, { sourceId: 'fresh-film' }]);
  assert.equal(retryPanel(h).hidden, true);
  h.ui.dispose();
});

test('a legacy record requests only explicit subtitle choice and same-source confirmation', async () => {
  const h = harness({ handler: async (route, options, fallback) => {
    if (route === '/api/jobs/failed/retry') return { id: 'retry', retryOf: 'failed', status: 'queued' };
    return fallback(route, options);
  } });
  h.context.subtitles.push({ index: 9, supported: false, label: '不可导出字幕' });
  const old = failedRecord({ needsSubtitleSelection: true, needsSourceConfirmation: true });
  const snapshot = { recentJobs: [old] };
  h.ui.hydrate(snapshot);
  button(rowsOfHistory(h)[0], '重试').listeners.click();
  assert.equal(button(retryPanel(h), '确认同片并重试'), undefined);
  assert.equal(h.requests.length, 0);
  h.context.label = old.sourceLabel;
  h.ui.refresh();
  const select = all(retryPanel(h)).find(node => node.id === 'queue-retry-subtitle');
  const proceed = button(retryPanel(h), '确认同片并重试');
  assert.deepEqual(select.children.map(option => option.textContent), ['请选择', '不保存字幕', '中文SRT']);
  assert(proceed.disabled);
  await proceed.listeners.click();
  assert.equal(h.requests.length, 0);
  select.value = 'none';
  select.listeners.change();
  h.ui.hydrate(snapshot);
  assert.equal(all(retryPanel(h)).find(node => node.id === select.id), select);
  assert.equal(select.value, 'none');
  await proceed.listeners.click();
  assert.deepEqual(h.requests[0].body, { sourceId: 'film', confirmSource: true, subtitleStreamIndex: null });
  assert.equal(old.requested.handles, 10);
  h.ui.dispose();
});

test('unknown retry submission is confirmed from the queue and a stopped retry can itself be retried', async () => {
  const old = failedRecord();
  const child = { ...failedRecord(), id: 'retry', retryOf: old.id, status: 'cancelled' };
  const h = harness({ handler: async (route, options, fallback, { jobs }) => {
    if (route === '/api/jobs/failed/retry') {
      jobs.set(old.id, { ...old, retry: { ...old.retry, jobId: child.id } });
      jobs.set(child.id, child);
      throw new Error('返回丢失');
    }
    if (route === '/api/jobs/retry/retry') return { id: 'next-retry', retryOf: child.id, status: 'queued' };
    return fallback(route, options);
  } });
  h.ui.hydrate({ recentJobs: [old] });
  await button(rowsOfHistory(h)[0], '重试').listeners.click();
  assert(h.ui.hasActivity());
  assert(button(retryPanel(h), '重新确认提交'));
  await h.ui.sync();
  assert.equal(retryPanel(h).hidden, true);
  assert.equal(h.ui.hasActivity(), false);
  await button(rowsOfHistory(h)[1], '重试').listeners.click();
  assert.deepEqual(h.requests.filter(request => request.method === 'POST').map(request => request.route),
    ['/api/jobs/failed/retry', '/api/jobs/retry/retry']);
  assert.equal(h.ui.jobs.at(-1).id, 'next-retry');
  h.ui.dispose();
});
