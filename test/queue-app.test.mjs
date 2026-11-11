import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createQueueWorkspace } from '../public/queue-workspace.mjs';
import * as clips from '../public/clip-options.mjs';
import * as policy from '../public/browser-helper-view.mjs';
import * as bookmarks from '../public/bookmark-capture-view.mjs';
import { estimateReadBudget } from '../public/budget.mjs';
import { resumeView } from '../public/resume-view.mjs';
import { setupPlatformLabel } from '../public/setup-view.mjs';
const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.value = ''; this.textContent = ''; this.children = []; this.options = []; this.dataset = {}; this.listeners = {}; this.attributes = {}; this.style = {}; this.hidden = false; this.disabled = false; this.checked = false; this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } }; }
  setAttribute(k,v) { this.attributes[k]=v; } getAttribute(k) { return this.attributes[k]; } removeAttribute(k) { delete this.attributes[k]; } hasAttribute(k) { return k in this.attributes; }
  append(...children) { this.children.push(...children); } replaceChildren(...children) { this.children=[...children]; this.options=[...children]; } add(child) { this.children.push(child); this.options.push(child); }
  addEventListener(k,fn) { this.listeners[k]=fn; } querySelector() { return this.label ||= new Element('span'); }
  focus() { this.focused = true; } scrollIntoView() { this.scrolledIntoView = true; } pause() {} load() {}
  set innerHTML(_) { throw new Error('unsafe HTML'); }
}
function fixture() {
  const elements=new Map(), requests=[]; const $=id=>{ if(!elements.has(id)) elements.set(id,new Element());return elements.get(id); };
  const tabs=['browser','dav','local','http'].map(type=>{ const e=$('tab-'+type);e.dataset.sourceType=type;return e; });
  const fields=['start-time','end-time','handles','output-dir','audio-stream','subtitle-stream','clip-name','make-mp4','budget','read-mode','reuse-index','download-method'].map($);
  const sourceFields=['source-url','source-username','source-password','local-path'].map($);
  const document={getElementById:$,createElement:tag=>new Element(tag),querySelectorAll(selector){if(selector==='[data-source-type]')return tabs;if(selector==='.source-field')return sourceFields;if(selector==='.source-field, [data-source-type]')return [...sourceFields,...tabs];if(selector==='#extract-form input, #extract-form select')return fields;return []}};
  const timers=new Map();let tid=0;
  const context=vm.createContext({...clips,...policy,...bookmarks,resumeView,setupPlatformLabel,document,console,URL,Option:class {constructor(text,value){this.text=text;this.value=value;}},window:{location:{origin:'http://127.0.0.1:12345'}},navigator:{},
    setTimeout:(fn,ms)=>{timers.set(++tid,{fn,ms});return tid},clearTimeout:id=>timers.delete(id),setInterval:()=>1,clearInterval(){},matchMedia:()=>({matches:true}),
    estimateReadBudget,historyStatusLabel:()=>'',historyRequestedRange:()=>null,
    createQueueWorkspace:options=>createQueueWorkspace({...options,document,setTimer:(fn,ms)=>{timers.set(++tid,{fn,ms});return tid},clearTimer:id=>timers.delete(id),requestId:()=> (++tid).toString(16).padStart(32,'0')}),
  });
  $('start-time').value='0';$('end-time').value='60';$('handles').value='0';$('output-dir').value='/synthetic/output';$('budget').value='256';$('read-mode').value='standard';$('read-mode').options=[{value:'standard'},{value:'continuous'},{value:'parallel'}];$('download-method').options=[{},{}];
  vm.runInContext(source.replace(/^import .*;\n/gm,'').replace(/^bootstrap\(\);\s*$/m,'')+'\nglobalThis.ui={state,bootstrap,queueContext,updateControls,updateBudgetSuggestion,bookmarkHasDraft,startJob,renderJob,makeCompatible,getWorkspace:()=>queueWorkspace};',context);
  vm.runInContext('api=async(route,options)=>record(route,options);loadHistory=async()=>{};renderJobDiagnostics=()=>{};renderResume=()=>{};',context);
  context.record=(route,options)=>{requests.push({route,options});return {activeJob:null,queuedJobs:[],recentJobs:[],batches:[]}};
  Object.assign(context.ui.state,{connected:true,dependenciesReady:true});
  return {ui:context.ui,$,requests,timers,context};
}


function descendants(e){return[e,...e.children.flatMap(descendants)]}
test('queue initialization displays three rows before first download and disables the legacy form path',async()=>{
 const h=fixture(),w=h.ui.getWorkspace();assert.equal(w.rows.length,3);assert.equal(h.$('legacy-range-options').hidden,true);assert.equal(h.$('legacy-submit-options').hidden,true);assert.equal(h.$('legacy-budget-option').hidden,true);
 let prevented=false;await h.ui.startJob({preventDefault(){prevented=true}});assert(prevented);assert.equal(h.requests.length,0);assert(html.indexOf('id="queue-editor"')<html.indexOf('id="queue-status"'));w.dispose();
});
test('source tab keyboard navigation follows capture, cloud, local, then direct link', () => {
  const h = fixture();
  h.ui.state.connected = false;
  for (const [current, key, next] of [
    ['browser', 'ArrowRight', 'dav'], ['dav', 'ArrowRight', 'local'],
    ['local', 'End', 'http'], ['http', 'Home', 'browser'],
  ]) {
    let prevented = false;
    h.$(`tab-${current}`).listeners.keydown({ key, preventDefault() { prevented = true; } });
    assert(prevented);
    assert.equal(h.ui.state.sourceType, next);
    assert.equal(h.$(`tab-${next}`).getAttribute('aria-selected'), 'true');
    assert.equal(h.$(`tab-${next}`).tabIndex, 0);
    assert(h.$(`tab-${next}`).focused);
    assert.equal(h.$(`panel-${next}`).hidden, false);
    assert.equal(h.$(`panel-${current}`).hidden, true);
  }
  h.ui.getWorkspace().dispose();
});
test('a successful source check opens the film information once and a failed check hides it', async () => {
  const h = fixture();
  h.ui.state.sourceType = 'local';
  h.$('local-path').value = '/synthetic/movie.mkv';
  let reject = false;
  h.context.record = route => {
    assert.equal(route, '/api/probe');
    if (reject) throw new Error('无法读取影片');
    return { sourceId: 'checked', source: { label: '示例影片', size: 2048 }, media: { duration: 90, streams: [] } };
  };

  const check = h.$('probe-button').listeners.click;
  await check();
  assert.equal(h.$('media-info').hidden, false);
  assert.equal(h.$('media-info').open, true);

  h.$('media-info').open = false;
  h.ui.updateControls();
  assert.equal(h.$('media-info').open, false);

  reject = true;
  await check();
  assert.equal(h.$('media-info').hidden, true);
  reject = false;
  await check();
  assert.equal(h.$('media-info').open, true);
  h.ui.getWorkspace().dispose();
});
test('a terminal selected job does not unlock the source while the sequential queue continues',()=>{
 const h=fixture(),w=h.ui.getWorkspace();const running={id:'next',status:'running',stage:'extract',sourceId:'film',createdAt:'2026-11-06T00:00:00Z',startedAt:'2026-11-06T00:01:00Z'};
 w.hydrate({activeJob:running,queuedJobs:[],recentJobs:[],activeSource:{sourceId:'film',label:'同一电影',type:'local',media:{duration:300,streams:[]}}});h.ui.renderJob({id:'finished',status:'completed',stage:'completed'});assert(h.ui.state.busy);assert(h.$('tab-browser').disabled);assert(h.$('cancel-button').hidden);
 w.hydrate({activeJob:null,queuedJobs:[],recentJobs:[{...running,status:'completed'}]});assert.equal(h.ui.state.busy,false);assert.equal(h.$('tab-browser').disabled,false);w.dispose();
});
test('unsent list drafts protect capture selection and restored source can prepare more segments',()=>{
 const h=fixture(),w=h.ui.getWorkspace();assert.equal(h.ui.bookmarkHasDraft(),false);const id=w.rows[1].id;const input=descendants(h.$('queue-editor')).find(e=>e.id===`queue-${id}-start`);input.value='80';input.listeners.input();assert(h.ui.bookmarkHasDraft());
 w.hydrate({activeJob:null,queuedJobs:[],recentJobs:[],activeSource:{sourceId:'restored',label:'恢复电影',type:'browser',media:{duration:600,sizeBytes:6*1024**3,streams:[]},directStreamAvailable:true}});const ctx=h.ui.queueContext();assert(ctx.ready);assert.equal(ctx.sourceId,'restored');assert.equal(ctx.request.downloadMethod,'direct-stream');assert.equal(h.$('source-ready-summary').hidden,false);assert.equal(h.$('panel-browser').hidden,false);h.$('tab-browser').listeners.click();assert.equal(h.ui.queueContext().sourceId,'restored');w.dispose();
});
test('queue mode uses per-row recommendations and keeps the obsolete shared advice hidden',()=>{
 const h=fixture(),w=h.ui.getWorkspace();w.hydrate({activeJob:null,queuedJobs:[],recentJobs:[],activeSource:{sourceId:'film',label:'预算电影',type:'browser',media:{duration:600,sizeBytes:6*1024**3,streams:[]},directStreamAvailable:true}});
 Object.assign(w.rows[0],{start:'0',end:'20',handles:'0'});Object.assign(w.rows[1],{start:'0',end:'200',handles:'0'});w.refresh();assert(Number(w.rows[1].budget)>Number(w.rows[0].budget));h.ui.updateBudgetSuggestion();assert(h.$('budget-suggestion').hidden);w.dispose();
});

test('selected failed details remain stopped while later work runs, and old queued time is excluded',()=>{
 const h=fixture(),w=h.ui.getWorkspace();w.hydrate({activeJob:{id:'next',status:'running',stage:'extract',sourceId:'film'},queuedJobs:[],recentJobs:[]});
 h.ui.renderJob({id:'failed',status:'failed',stage:'failed',createdAt:'2026-11-06T00:00:00Z',finishedAt:'2026-11-06T00:05:00Z',diagnostics:{elapsedMs:300000,stages:{probe:5000,extract:90000}},error:{message:'读取失败'}});
 assert(h.ui.state.busy);assert.equal(h.$('task-progress-text').textContent,'任务已停止');assert.match(h.$('task-elapsed').textContent,/实际处理 1:35/);w.dispose();
});

test('selecting a waiting row keeps its own details through checks, download and completion', () => {
  const h = fixture(), workspace = h.ui.getWorkspace();
  const first = { id: 'first', status: 'running', stage: 'checking', clipName: '第一段', progress: null };
  const second = { id: 'second', status: 'queued', stage: 'queued', clipName: '第二段' };
  const snapshot = { activeJob: first, queuedJobs: [second], recentJobs: [] };
  workspace.hydrate(snapshot);
  const row = descendants(h.$('queue-status')).find(e => e.className === 'queue-job queue-job-waiting');
  const detail = descendants(row).find(e => e.textContent === '详情');
  row.listeners.click({ target: { closest: () => null } });
  assert.equal(detail.getAttribute('aria-pressed'), 'true');
  assert.equal(h.$('task-selection').textContent, '第二段');
  assert.equal(h.$('task-badge').textContent, '排队中');
  assert.equal(h.$('task-progress-text').textContent, '尚未开始下载');
  assert.equal(h.$('progress-track').getAttribute('aria-valuenow'), '0');
  assert(h.$('task-details-shell').open);

  workspace.hydrate({ ...snapshot, activeJob: { ...first, stage: 'fetch', progress: 40 } });
  assert.equal(h.$('task-selection').textContent, '第二段');
  assert.equal(h.$('task-progress-text').textContent, '尚未开始下载');

  workspace.hydrate({
    activeJob: { ...second, status: 'running', stage: 'fetch', progress: 27 },
    queuedJobs: [], recentJobs: [{ ...first, status: 'completed' }],
  });
  assert.equal(h.$('task-selection').textContent, '第二段');
  assert.equal(h.$('task-progress-text').textContent, '当前阶段 27%');
  workspace.hydrate({ activeJob: null, queuedJobs: [], recentJobs: [{ ...second, status: 'completed' }] });
  assert.equal(h.$('task-selection').textContent, '第二段');
  assert.equal(h.$('task-progress-text').textContent, '100%');
  workspace.dispose();
});

test('a stop response updates the queue without switching away from a later selection', async () => {
  const h = fixture(), workspace = h.ui.getWorkspace();
  const first = { id: 'first', status: 'running', clipName: '第一段' };
  const second = { id: 'second', status: 'queued', clipName: '第二段' };
  const stopped = { ...first, status: 'cancelled' };
  workspace.hydrate({ activeJob: first, queuedJobs: [second], recentJobs: [] });
  let finishStop;
  h.context.record = route => {
    if (route === '/api/jobs/queue') return { activeJob: null, queuedJobs: [second], recentJobs: [stopped] };
    assert.equal(route, '/api/jobs/first/cancel');
    return new Promise(resolve => { finishStop = resolve; });
  };
  const stopping = h.$('cancel-button').listeners.click();
  const waitingRow = descendants(h.$('queue-status')).find(e => e.className === 'queue-job queue-job-waiting');
  descendants(waitingRow).find(e => e.textContent === '详情').listeners.click();
  finishStop(stopped);
  await stopping;
  assert.equal(h.$('task-selection').textContent, '第二段');
  assert.equal(h.$('task-badge').textContent, '排队中');
  assert.equal(h.$('cancel-button').textContent, '移出队列');
  workspace.dispose();
});

test('stopped MP4 keeps published MKV and subtitle actions in task details and restored history', async () => {
  const h = fixture(), workspace = h.ui.getWorkspace();
  const result = { candidatePath: '/synthetic/片段.mkv', subtitlePaths: ['/synthetic/片段.srt'] };
  const running = { id: 'extract', type: 'extract', status: 'running', stage: 'compatible', result };
  const stopped = { ...running, status: 'cancelled', stage: 'cancelled', error: { stage: 'compatible', message: '任务未完成，可重新选择来源取片。' } };
  const unfinished = { id: 'unfinished', type: 'extract', status: 'cancelled' };
  workspace.hydrate({ activeJob: running, recentJobs: [] });
  assert(h.$('task-results').hidden);

  workspace.hydrate({ activeJob: null, recentJobs: [stopped, unfinished] });
  const [stoppedRow, unfinishedRow] = descendants(h.$('queue-status')).filter(e => e.className === 'queue-job queue-job-recent');
  assert(descendants(stoppedRow).some(e => e.textContent === 'MP4 已停止'));
  assert(descendants(stoppedRow).some(e => e.textContent.includes('原码 MKV 已保存')));
  assert(!descendants(unfinishedRow).some(e => e.textContent === '打开文件夹'));
  const button = (row, label) => descendants(row).find(e => e.tagName === 'button' && e.textContent === label);
  button(stoppedRow, '详情').listeners.click();
  assert.equal(h.$('task-status-title').textContent, 'MP4 生成已停止');
  assert.equal(h.$('task-stage').textContent, '原码 MKV 已保存。');
  assert(h.$('task-error').hidden);
  assert(!h.$('task-results').hidden);
  assert(!h.$('compatible-button').hidden);
  assert(!h.$('compatible-button').disabled);
  await button(stoppedRow, '打开文件夹').listeners.click();
  assert.equal(h.requests.at(-1).route, '/api/reveal');
  assert.equal(h.requests.at(-1).options.body.path, result.candidatePath);
  const subtitleCard = h.$('result-files').children[1];
  await button(subtitleCard, '在文件夹中显示').listeners.click();
  assert.equal(h.requests.at(-1).route, '/api/reveal');
  assert.equal(h.requests.at(-1).options.body.path, result.subtitlePaths[0]);
  button(unfinishedRow, '详情').listeners.click();
  assert(h.$('task-results').hidden);
  workspace.dispose();
});

test('unreadable history gets a persistent startup notice independent of connection status', async () => {
  const h = fixture();
  vm.runInContext('refreshBrowserCapture=()=>{};', h.context);
  h.context.record = route => {
    assert.equal(route, '/api/bootstrap');
    return { sessionToken: 'test', historyWarning: true, historyReadWarning: true, recentJobs: [] };
  };
  await h.ui.bootstrap();
  assert.match(html, /id="history-notice"[^>]+role="status"/);
  assert(h.ui.state.connected);
  assert(!h.$('history-notice').hidden);
  assert.match(h.$('history-notice').textContent, /原历史文件已保留.*仅在当前会话可见/);
  assert.equal(h.$('dependency-state').textContent, '本机服务已连接');
  h.ui.getWorkspace().dispose();
});

test('save position precedes the list and ready source collapses only healthy setup guidance',()=>{
 const h=fixture(),w=h.ui.getWorkspace();assert(html.indexOf('id="output-dir"')<html.indexOf('id="queue-editor"'));assert(html.includes('id="queue-default-options"'));
 h.$('setup-guide').open=true;w.hydrate({activeJob:null,queuedJobs:[],recentJobs:[],activeSource:{sourceId:'ready',label:'电影',type:'local',media:{duration:300,streams:[]}}});assert.equal(h.$('setup-guide').open,false);
 h.$('setup-guide').open=true;h.ui.updateControls();assert.equal(h.$('setup-guide').open,true,'manual reopening remains respected');w.dispose();
 const broken=fixture(),bw=broken.ui.getWorkspace();broken.ui.state.setupReport={storage:{status:'failed'}};broken.$('setup-guide').open=true;bw.hydrate({activeJob:null,queuedJobs:[],recentJobs:[],activeSource:{sourceId:'other',label:'电影',type:'local',media:{duration:300,streams:[]}}});assert.equal(broken.$('setup-guide').open,true);bw.dispose();
});

test('legacy result details open from the merged queue and clear when its record is deleted', async () => {
  const h = fixture(), workspace = h.ui.getWorkspace();
  const saved = {
    id: 'saved', status: 'completed', stage: 'completed', clipName: '以前的片段',
    requested: { start: 60, end: 75, handles: 10 }, result: { candidatePath: '/synthetic/candidate.mkv' },
  };
  const active = { id: 'active', status: 'running', stage: 'extract' };
  const snapshot = { activeJob: active, queuedJobs: [], recentJobs: [saved] };
  workspace.hydrate(snapshot);
  assert(html.includes('顺序队列与记录'));
  assert(!html.includes('id="history-list"'));
  assert.match(html, /id="handles" type="number" value="5"/);
  assert(workspace.rows.every(row => row.handles === '5'));
  const history = () => descendants(h.$('queue-status')).find(e => e.className === 'queue-job queue-job-recent');
  const action = label => descendants(history()).find(e => e.tagName === 'button' && e.textContent === label);
  action('详情').listeners.click();
  assert(h.$('task-details-shell').open);
  assert.equal(h.ui.state.job.id, saved.id);
  assert.match(h.$('task-selection').textContent, /以前的片段.*前后各 10 秒/);
  assert(!h.$('task-results').hidden);
  assert(!h.$('compatible-button').hidden);
  assert(h.$('compatible-button').disabled);
  h.context.record = (route, options) => {
    assert.equal(route, '/api/jobs/saved/delete-history');
    assert.equal(options.method, 'POST');
    return { ok: true, id: saved.id };
  };
  action('删除记录').listeners.click();
  await action('确认删除').listeners.click();
  assert.equal(h.ui.state.job, null);
  assert(h.$('task-content').hidden);
  assert(!h.$('task-details-shell').open);
  assert(h.ui.state.busy);
  workspace.hydrate({ ...snapshot, recentJobs: [] });
  assert.equal(h.ui.state.job.id, active.id);
  assert.equal(history(), undefined);
  workspace.dispose();
});

test('MP4 started from an older record remains selected through a refresh that started before creation', async () => {
  const h = fixture(), workspace = h.ui.getWorkspace();
  const parent = { id: 'old', status: 'completed', result: { candidatePath: '/synthetic/candidate.mkv' } };
  const mp4 = { id: 'mp4', status: 'queued', type: 'compatible' };
  const snapshot = { activeJob: null, queuedJobs: [], recentJobs: [parent] };
  workspace.hydrate(snapshot);
  const record = descendants(h.$('queue-status')).find(e => e.className === 'queue-job queue-job-recent');
  descendants(record).find(e => e.textContent === '详情').listeners.click();
  let finishRefresh;
  h.context.record = (route, options) => {
    if (route === '/api/jobs/queue') return new Promise(resolve => { finishRefresh = () => resolve(snapshot); });
    assert.equal(route, '/api/jobs/old/compatible');
    assert.equal(options.method, 'POST');
    return mp4;
  };
  const refreshing = workspace.sync();
  await h.ui.makeCompatible();
  finishRefresh();
  await refreshing;
  assert.equal(h.ui.state.job.id, 'mp4');
  assert(h.ui.state.busy);
  workspace.hydrate({ activeJob: { ...mp4, status: 'running' }, queuedJobs: [], recentJobs: [parent] });
  assert.equal(h.ui.state.job.id, 'mp4');
  workspace.dispose();
});

test('retry source selection focuses the always-visible source card and preserves the draft', () => {
  const h = fixture(), workspace = h.ui.getWorkspace();
  const row = workspace.rows[0];
  const start = descendants(h.$('queue-editor')).find(e => e.id === `queue-${row.id}-start`);
  start.value = '00:04:00';
  start.listeners.input();
  workspace.hydrate({ recentJobs: [{ id: 'failed', status: 'failed', sourceLabel: '原影片',
    retry: { needsSubtitleSelection: true, needsSourceConfirmation: true } }] });
  const status = h.$('queue-status');
  descendants(status).find(e => e.textContent === '重试').listeners.click();
  descendants(status).find(e => e.textContent === '去检查同一原片').listeners.click();
  assert(h.$('source-title').focused);
  assert(h.$('source-title').scrolledIntoView);
  assert.equal(h.ui.state.sourceType, 'browser');
  assert.equal(workspace.rows[0], row);
  assert.equal(start.value, '00:04:00');
  assert.equal(h.requests.length, 0);
  workspace.dispose();
});
