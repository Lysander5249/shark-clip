import { defaultClipName, sanitizeClipName } from './clip-options.mjs';
import { estimateReadBudget } from './budget.mjs';
import { historyRequestedRange } from './resume-view.mjs';
const TERMINAL = new Set(['completed','failed','cancelled']);
const HISTORY_PAGE_SIZE = 5;
const DEFAULT_HANDLES = 5;
const historyDate = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const live = job => Boolean(job?.id && !TERMINAL.has(job.status));
const text = error => String(error?.message || '操作未完成，请重试。');
const base = value => typeof value === 'string' ? value.split(/[\\/]/).at(-1) : '';
const parse = value => {
  const s=String(value).trim(); if(!/^(?:\d+:){0,2}\d+(?:\.\d+)?$/.test(s))return NaN;
  const parts=s.split(':').map(Number);if(parts.length>1&&parts.at(-1)>=60||parts.length===3&&parts[1]>=60)return NaN;
  return parts.reduce((sum,n)=>sum*60+n,0);
};
const bytes = n => !Number.isFinite(n) ? '—' : n>=1024**3 ? `${(n/1024**3).toFixed(2)} GiB` : `${(n/1024**2).toFixed(1)} MiB`;
const duration = ms => {const s=Math.max(0,Math.floor(ms/1000));return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;};
const time = value => { const n=Number(value);if(!Number.isFinite(n))return '—';const whole=Math.floor(n);return `${String(Math.floor(whole/3600)).padStart(2,'0')}:${String(Math.floor(whole/60)%60).padStart(2,'0')}:${String(whole%60).padStart(2,'0')}`;};
const stamp = value => {const n=Date.parse(value||'');return Number.isFinite(n)?n:null;};
const stage = {checking:'复核来源',positioning:'定位片段',fetch:'读取片段',probe:'探测媒体',extract:'获取片段',validate:'核验成品',compatible:'生成 MP4',finalizing:'保存并清理',completed:'已完成',failed:'未完成',cancelled:'已取消',queued:'等待处理'};
const sourceErrors = new Set(['RETRY_SOURCE_REQUIRED', 'RETRY_SOURCE_MISMATCH', 'RETRY_SUBTITLE_CHANGED', 'DIRECT_STREAM_UNAVAILABLE', 'SOURCE_MISSING']);
const retryable = job => Boolean(job?.retry && (job.status === 'failed' || job.status === 'cancelled'));

/** One movie, one atomic batch, one download at a time. No source credentials are stored. */
export function createQueueWorkspace({ editor, status, statusBadge, api, getContext, onActivity=()=>{}, onDraftChange=()=>{}, onSource=()=>{}, onFocus=()=>{}, onComplete=()=>{},
  onRecordRemoved=()=>{}, onChooseSource=()=>{},
  document=globalThis.document, setTimer=globalThis.setTimeout, clearTimer=globalThis.clearTimeout, now=Date.now,
  requestId=()=>globalThis.crypto.randomUUID().replaceAll('-','') }={}) {
  let context={},rows=[],rowNodes=new Map(),jobs=[],batchRecords=[],submitting=false,uncertain=false,pending=null,error='',disposed=false,timer=null,synchronization=null,focusedId='',followActive=true;
  const completed = new Set();
  const removedRecords = new Set();
  let historyLoaded = false, historyPage = 0, historyKey = '', confirmingId = '', confirmingBulk = null;
  let activeRow = null, emptyActiveMessage = '', waitingRows = [], historyRows = [];
  let deletingHistory = false;
  let queueError = '', historyError = '', historyNotice = '';
  let jobRevision = 0;
  let retryIntent = null, retryPosting = false, retryPanelKey = '';
  const node=(tag,cls,value)=>{const e=document.createElement(tag);if(cls)e.className=cls;if(value!==undefined)e.textContent=value;return e;};
  const empty=row=>!row.start.trim()&&!row.end.trim()&&!row.name.trim();
  const activeJobs=()=>jobs.filter(live);
  const hasActivity=()=>submitting||uncertain||retryPosting||Boolean(retryIntent?.uncertain)||activeJobs().length>0;
  function makeRow(first=false){return{id:requestId(),start:first?'00:00:00':'',end:first?'00:01:00':'',name:'',editedName:false,handles:String(DEFAULT_HANDLES),subtitle:'',budget:String(context.request?.budgetMiB||256),editedBudget:false,edited:false,error:''};}
  rows=Array.from({length:3},(_,i)=>makeRow(i===0));
  const elements={};
  function estimate(row){return context.kind==='local'?null:estimateReadBudget({sizeBytes:Number(context.sizeBytes),durationSeconds:Number(context.duration),startSeconds:parse(row.start),endSeconds:parse(row.end),handlesSeconds:Number(row.handles)});}
  function refresh(){
    context=getContext?.()||{};
    for(const row of rows){
      if(!row.edited&&context.duration>0&&parse(row.end)>context.duration)row.end=String(Math.min(60,context.duration));
      if(!row.editedName){const start=parse(row.start),end=parse(row.end);row.name=Number.isFinite(start)&&end>start?defaultClipName(context.label||'电影',start,end):'';}
      const advice=estimate(row);if(!row.editedBudget)row.budget=String(advice?.recommendedMiB||context.request?.budgetMiB||256);
    }
    render();
  }
  function emit(){if(disposed)return;render();onActivity();schedule();}
  function edit(row,key,value){row[key]=value;row.edited=true;row.error='';error='';if(key==='name')row.editedName=Boolean(value.trim());if(key==='budget')row.editedBudget=true;onDraftChange();refresh();}
  function add(){if(rows.length>=10||submitting||uncertain)return;rows.push(makeRow());mountRows();emit();}
  function remove(id){if(submitting||uncertain)return;rows=rows.filter(r=>r.id!==id);if(!rows.length)rows.push(makeRow());mountRows();emit();onDraftChange();}
  function bodyFor(row,index){
    const start=parse(row.start),end=parse(row.end),handles=Number(row.handles),budgetMiB=Number(row.budget);
    if(!Number.isFinite(start)||!Number.isFinite(end)||end<=start)throw new Error(`第${index+1}段：请填写有效起止时间，结束需晚于开始。`);
    if(!Number.isFinite(handles)||handles<0||handles>300)throw new Error(`第${index+1}段：前后余量需为0–300秒。`);
    const fetchStart=Math.max(0,start-handles),fetchEnd=context.duration>0?Math.min(context.duration,end+handles):end+handles;
    if(context.duration>0&&(start>=context.duration||end>context.duration+0.1))throw new Error(`第${index+1}段：时间超过影片时长。`);
    if(fetchEnd-fetchStart>600)throw new Error(`第${index+1}段：含余量每次最多取10分钟，请缩短时段。`);
    if(!Number.isFinite(budgetMiB)||budgetMiB<1||budgetMiB>65536)throw new Error(`第${index+1}段：读取上限需为1–65536 MiB。`);
    const body={...context.request,clientItemId:row.id,start,end,handles,clipName:sanitizeClipName(row.name)||defaultClipName(context.label||'电影',start,end),budgetMiB};
    delete body.sourceId;delete body.subtitleStreamIndex;
    if(!body.outputDir)throw new Error('请先选择本地保存位置。');
    if(row.subtitle!==''){const selected=Number(row.subtitle);if(!Number.isInteger(selected)||!(context.subtitles||[]).some(t=>t.index===selected&&t.supported))throw new Error(`第${index+1}段：请选择当前影片可导出的字幕。`);body.subtitleStreamIndex=selected;}
    return body;
  }
  async function submit(retry=false){
    if(submitting||retryPosting||retryIntent?.uncertain||uncertain&&!retry)return;
    refresh();
    let body;
    try{
      if(retry&&pending)body=pending;
      else{
        if(!context.ready||!context.sourceId||context.blocked)throw new Error('请先检查影片，再加入顺序队列。');
        if (otherMovieActive()) throw new Error('队列仍在处理另一部影片，请等待完成后提交当前草稿。');
        const filled=rows.filter(r=>!empty(r));if(!filled.length)throw new Error('请至少填写一个片段的起止时间。');
        const payload=filled.map((r)=>bodyFor(r,rows.indexOf(r)));
        body={sourceId:context.sourceId,clientBatchId:requestId(),jobs:payload};pending=body;
      }
    }catch(e){error=text(e);emit();return;}
    submitting=true;error='';emit();
    try{const result=await api('/api/jobs/batch',{method:'POST',body});if(!batchMatches(result,body))throw new Error('整批提交结果尚未确认。');acceptBatch(result);}
    catch(e){
      const definite=e.code!=='BATCH_CHANGED'&&(Number.isInteger(e.status)&&e.status>=400&&e.status<500||['TIME_INVALID','WINDOW_TOO_LARGE','OUTPUT_INVALID','SOURCE_MISSING','BUDGET_INVALID','BATCH_INVALID','JOB_LIMIT'].includes(e.code));
      error=text(e);
      if(definite){pending=null;uncertain=false;}else{uncertain=true;error+=' 提交结果未确认，将核对原批次；请勿重复新建。';try{await sync();}catch{}}
    }finally{submitting=false;emit();}
  }
  function batchMatches(result, body) {
    return result?.batchId === body.clientBatchId && Array.isArray(result.jobs)
      && (result.jobCount ?? result.jobs.length) === body.jobs.length && result.jobs.length <= body.jobs.length;
  }
  function otherMovieActive() {
    return context.sourceId && activeJobs().some(job => job.sourceId && job.sourceId !== context.sourceId);
  }
  function acceptBatch(result){
    jobRevision += 1;
    const id=result.batchId;uncertain=false;pending=null;error='';
    batchRecords=[...batchRecords.filter(b=>b.batchId!==id),{batchId:id,jobs:result.jobs}];
    const map=new Map(jobs.map(j=>[j.id,j]));for(const j of result.jobs)if(!removedRecords.has(j.id))map.set(j.id,j);jobs=[...map.values()];
    rows=Array.from({length:3},()=>makeRow());mountRows();refresh();emit();
  }
  function queueTime(job){
    const created=stamp(job.queuedAt || job.createdAt),started=stamp(job.startedAt),finished=stamp(job.finishedAt);
    let waiting=created!==null?Math.max(0,(started??(live(job)?now():finished??created))-created):null;
    let working=started!==null?Math.max(0,(finished??now())-started):null;
    if(started===null&&TERMINAL.has(job.status)&&job.diagnostics?.stages){working=Object.values(job.diagnostics.stages).filter(Number.isFinite).reduce((a,b)=>a+b,0);waiting=Math.max(0,(job.diagnostics.elapsedMs||0)-working);}
    return {waiting,working};
  }
  function selectJob(id) {
    const job = jobs.find(item => item.id === id);
    if (!job) return;
    focusedId = id;
    followActive = false;
    onFocus(job, { explicit: true });
    render();
  }
  function hydrate(snapshot){
    if(!snapshot||disposed)return;
    if(snapshot.activeSource)onSource(snapshot.activeSource);
    const oldLive=new Set(jobs.filter(live).map(j=>j.id));
    const oldRecord = jobs.find(j => j.id === focusedId && TERMINAL.has(j.status));
    const next=[snapshot.activeJob,...(snapshot.queuedJobs||[]),...(snapshot.recentJobs||[])];
    const map = new Map();
    for (const job of next) {
      if (job?.id && !map.has(job.id) && !removedRecords.has(job.id)) map.set(job.id, job);
    }
    jobs=[...map.values()];batchRecords=snapshot.batches||batchRecords;
    historyLoaded = Array.isArray(snapshot.recentJobs) || historyLoaded;
    if(uncertain&&pending){const found=batchRecords.find(b=>batchMatches(b,pending));if(found)acceptBatch(found);}
    if (retryIntent?.uncertain) {
      const old = jobs.find(job => job.id === retryIntent.id);
      const retried = jobs.find(job => job.retryOf === retryIntent.id);
      if (old?.retry?.jobId || retried) finishRetry(retried, old?.retry?.jobId);
    }
    for(const j of jobs){if(TERMINAL.has(j.status)&&!completed.has(j.id)){completed.add(j.id);if(oldLive.has(j.id))onComplete(j);}}
    const current = jobs.find(job => job.status === 'running');
    if (followActive && current) focusedId = current.id;
    const selected = jobs.find(job => job.id === focusedId);
    if (selected) onFocus(selected, { explicit: false });
    else if (oldRecord && Array.isArray(snapshot.recentJobs)) clearRecordFocus(oldRecord.id);
    refresh();emit();
  }
  async function sync() {
    if (synchronization) return synchronization;
    const revision = jobRevision;
    synchronization = (async () => {
      try {
        const value = await api('/api/jobs/queue');
        queueError = '';
        // A command acknowledged after this read started supersedes its snapshot.
        if (revision === jobRevision) hydrate(value);
        else schedule();
        return value;
      } catch (e) {
        queueError = text(e);
        if (uncertain) error = queueError + ' 提交状态未确认，可重新同步或重试原批次。';
        emit();
        throw e;
      } finally {
        synchronization = null;
      }
    })();
    return synchronization;
  }
  function schedule(){clearTimer(timer);timer=null;if(!disposed&&hasActivity())timer=setTimer(()=>{timer=null;sync().catch(()=>{});},1000);}
  async function cancel(job){try{await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`,{method:'POST',body:{}});await sync();}catch(e){queueError=text(e);emit();}}
  async function reveal(path){
    try{await api('/api/reveal',{method:'POST',body:{path}});}catch(e){queueError=text(e);emit();}
  }
  function clearRecordFocus(id) {
    if (focusedId === id) { focusedId = ''; followActive = true; }
    onRecordRemoved(id);
  }
  function beginRecordRetry(job, label) {
    const current = jobs.find(item => item.id === job.id);
    if (retryIntent || retryPosting || submitting || uncertain || confirmingBulk || context.blocked || context.connected === false
        || !retryable(current) || current.retry.jobId) return;
    retryIntent = {
      id: current.id, label, sourceLabel: current.sourceLabel,
      originalSourceId: current.retry.sourceId,
      needsSourceConfirmation: current.retry.needsSourceConfirmation === true,
      needsSubtitle: current.retry.needsSubtitleSelection === true,
      rejectedSourceId: '', subtitleChoice: '', subtitleSourceId: '', message: '', body: null, uncertain: false,
    };
    historyNotice = '';
    if (current.retry.sourceId && !retryIntent.needsSourceConfirmation && !retryIntent.needsSubtitle) {
      return sendRetry({});
    }
    render();
    elements.retryPanel?.scrollIntoView?.({ block: 'nearest' });
  }
  function finishRetry(job, jobId = job?.id) {
    if (!retryIntent || !jobId) return;
    const original = jobs.find(item => item.id === retryIntent.id);
    if (original?.retry) original.retry = { ...original.retry, jobId };
    if (job?.status && !jobs.some(item => item.id === jobId) && !removedRecords.has(jobId)) {
      if (live(job)) jobs.push(job);
      else jobs.unshift(job);
    }
    historyNotice = `已将「${retryIntent.label}」的重试任务加入顺序队列。`;
    retryIntent = null;
  }
  async function sendRetry(body) {
    const intent = retryIntent;
    if (!intent || retryPosting || submitting || uncertain || context.blocked || context.connected === false) return;
    intent.body = body;
    intent.message = '';
    retryPosting = true;
    emit();
    elements.retryPanel?.scrollIntoView?.({ block: 'nearest' });
    try {
      const job = await api(`/api/jobs/${encodeURIComponent(intent.id)}/retry`, { method: 'POST', body });
      if (!job?.id || job.retryOf !== intent.id) throw new Error('重试提交结果待确认。');
      jobRevision += 1;
      finishRetry(job);
    } catch (failure) {
      if (retryIntent !== intent) return;
      intent.message = text(failure);
      intent.uncertain = !(Number.isInteger(failure.status) && failure.status >= 400 && failure.status < 500);
      const selectLegacySubtitle = intent.needsSubtitle && ['INVALID_SUBTITLE_TRACK', 'RETRY_SUBTITLE_CHANGED'].includes(failure.code);
      if (sourceErrors.has(failure.code) && !selectLegacySubtitle) {
        intent.rejectedSourceId = body.sourceId || intent.originalSourceId || context.sourceId;
        intent.body = null;
        intent.uncertain = false;
      } else if (failure.code === 'RETRY_SOURCE_CONFIRM_REQUIRED') {
        intent.needsSourceConfirmation = true;
        intent.body = null;
        intent.uncertain = false;
      } else if (failure.code === 'RETRY_SUBTITLE_REQUIRED' || selectLegacySubtitle) {
        intent.needsSubtitle = true;
        intent.subtitleChoice = '';
        intent.body = null;
        intent.uncertain = false;
      } else if (failure.code === 'RETRY_ALREADY_SUBMITTED') {
        retryIntent = null;
        historyNotice = '这条记录已提交过重试。';
        if (synchronization) await synchronization.catch(() => {});
        await sync().catch(() => {});
      }
    } finally {
      retryPosting = false;
      emit();
    }
  }
  function cancelRetryIntent() {
    if (retryPosting || retryIntent?.uncertain) return;
    retryIntent = null;
    emit();
  }
  function canDeleteRecord(job) {
    return job && TERMINAL.has(job.status) && !deletingHistory && context.connected !== false
      && (!pending || job.batchId !== pending.clientBatchId) && job.id !== retryIntent?.id;
  }
  function bulkDeleteIds() {
    return jobs.filter(job => canDeleteRecord(job) && !job.resume?.available && !job.resume?.discardable)
      .map(job => job.id);
  }
  function removeHistoryRecords(ids) {
    if (!ids.length) return;
    for (const id of ids) removedRecords.add(id);
    jobs = jobs.filter(job => !removedRecords.has(job.id));
    for (const id of ids) clearRecordFocus(id);
  }
  async function syncHistoryAfterDeletion() {
    if (synchronization) await synchronization.catch(() => {});
    await sync().catch(() => {});
  }
  async function deleteRecord(id) {
    const job = jobs.find(item => item.id === id);
    if (confirmingId !== id || confirmingBulk || !canDeleteRecord(job)) return;
    deletingHistory = true;
    historyError = historyNotice = '';
    render();
    try {
      const result = await api(`/api/jobs/${encodeURIComponent(id)}/delete-history`, { method: 'POST', body: {} });
      if (!result?.ok || result.id !== id) throw new Error('删除结果尚未确认，请刷新记录后查看。');
      removeHistoryRecords([id]);
      historyNotice = '已删除记录，导出文件仍保留。';
    } catch (e) {
      historyError = e.code === 'HISTORY_HAS_RESUME' ? '这条记录仍有续传缓存。请打开详情，清除续传缓存后再删除记录。' : text(e);
      if (e.code === 'JOB_MISSING' || e.code === 'HISTORY_HAS_RESUME') {
        // A deletion attempt can discover an orphaned cache that was absent
        // from the preceding snapshot. Refresh its cleanup actions.
        await syncHistoryAfterDeletion();
      }
    } finally {
      confirmingId = '';
      deletingHistory = false;
      render();
    }
  }
  function beginBulkDelete() {
    if (confirmingBulk || deletingHistory) return;
    const ids = bulkDeleteIds();
    if (!ids.length) return;
    confirmingBulk = ids;
    confirmingId = '';
    historyError = historyNotice = '';
    render();
    elements.bulkCancel.focus?.();
  }
  function cancelBulkDelete() {
    if (deletingHistory) return;
    confirmingBulk = null;
    render();
    elements.historyDelete.focus?.();
  }
  async function deleteHistoryBatch() {
    if (!confirmingBulk || deletingHistory || context.connected === false) return;
    // Freeze the user's selection at confirmation time. The server rechecks
    // records whose status or cache changed while the confirmation was open.
    const ids = confirmingBulk;
    const requested = new Set(ids);
    deletingHistory = true;
    historyError = historyNotice = '';
    render();
    try {
      const result = await api('/api/jobs/delete-history', { method: 'POST', body: { ids } });
      if (result?.ok !== true || !Array.isArray(result.ids) || !Array.isArray(result.skipped)
          || result.skipped.some(item => typeof item?.code !== 'string')) {
        throw new Error('删除结果尚未确认，请刷新记录后查看。');
      }
      const reported = [...result.ids, ...result.skipped.map(item => item.id)];
      if (reported.length !== ids.length || new Set(reported).size !== ids.length || reported.some(id => !requested.has(id))) {
        throw new Error('删除结果尚未确认，请刷新记录后查看。');
      }
      const missing = result.skipped.filter(item => item.code === 'JOB_MISSING').map(item => item.id);
      removeHistoryRecords([...result.ids, ...missing]);
      const retained = result.skipped.length - missing.length;
      historyNotice = (result.ids.length ? `已删除 ${result.ids.length} 条历史记录，导出文件仍保留。` : missing.length && !retained ? '所选记录已不在历史中。' : '未删除历史记录。')
        + (retained ? `另有 ${retained} 条记录暂时无法删除，已保留。` : '');
      if (retained) await syncHistoryAfterDeletion();
    } catch (e) {
      historyError = text(e);
    } finally {
      confirmingBulk = null;
      deletingHistory = false;
      render();
      if (elements.historyDelete.disabled) elements.historyHeading.focus?.();
      else elements.historyDelete.focus?.();
    }
  }
  function mountRows(){
    if(!elements.rows)return;elements.rows.replaceChildren();rowNodes=new Map();
    rows.forEach((row,index)=>{
      const item=node('section','queue-draft-row');item.setAttribute('aria-label',`片段 ${index+1}`);
      const number=node('span','queue-row-number',String(index+1)),fields=node('div','queue-row-fields');
      const refs={item,number};
      for(const [key,label,placeholder]of[['start','开始时间','00:00:00'],['end','结束时间','00:01:00'],['name','素材与文件夹名称','按电影名和时段自动命名']]){
        const wrapper=node('div',`queue-field queue-field-${key}`),caption=node('label','',label),input=node('input');input.id=`queue-${row.id}-${key}`;caption.setAttribute('for',input.id);input.type='text';input.placeholder=placeholder;input.autocomplete='off';input.spellcheck=false;if(key==='name')input.maxLength=160;input.addEventListener('input',()=>edit(row,key,input.value));wrapper.append(caption,input);fields.append(wrapper);refs[key]=input;
      }
      const removeButton=node('button','queue-remove','移除');removeButton.type='button';removeButton.setAttribute('aria-label',`移除第${index+1}段`);removeButton.addEventListener('click',()=>remove(row.id));
      const advanced=node('details','queue-row-options'),summary=node('summary','','字幕、余量与读取上限');advanced.append(summary);const options=node('div','queue-row-option-grid');
      const subtitle=node('select');subtitle.id=`queue-${row.id}-subtitle`;const subtitleLabel=node('label','','独立字幕');subtitleLabel.setAttribute('for',subtitle.id);const subtitleWrap=node('div');subtitleWrap.append(subtitleLabel,subtitle);subtitle.addEventListener('change',()=>edit(row,'subtitle',subtitle.value));options.append(subtitleWrap);refs.subtitle=subtitle;
      for(const [key,label,max]of[['handles','前后各多取（秒）',300],['budget','本段读取上限（MiB）',65536]]){const w=node('div'),caption=node('label','',label),input=node('input');input.id=`queue-${row.id}-${key}`;input.type='number';input.min=key==='handles'?'0':'1';input.max=String(max);input.step='1';caption.setAttribute('for',input.id);input.addEventListener('input',()=>edit(row,key,input.value));w.append(caption,input);options.append(w);refs[key]=input;}
      const use=node('button','button secondary queue-use-advice','使用本段建议');use.type='button';use.addEventListener('click',()=>{row.editedBudget=false;refresh();});const advice=node('p','queue-row-advice field-hint');refs.advice=advice;refs.use=use;refs.trackKey='';options.append(use);advanced.append(options);
      const meta = node('div', 'queue-row-meta');
      meta.append(advice, advanced);
      item.append(number, fields, removeButton, meta);
      refs.remove=removeButton;elements.rows.append(item);rowNodes.set(row.id,refs);
    });
  }
  function mount(){
    if(editor){const heading=node('div','queue-editor-heading'),intro=node('p','field-hint','支持时:分:秒、分:秒或秒数。空白行会跳过。');heading.append(intro);elements.rows=node('div','queue-draft-list');
      const toolbar=node('div','queue-editor-toolbar');elements.add=node('button','button secondary','＋ 添加片段');elements.add.type='button';elements.add.addEventListener('click',add);elements.count=node('span','field-hint');toolbar.append(elements.add,elements.count);
      elements.notice=node('p','queue-budget-notice field-hint');elements.error=node('div','inline-error');elements.error.setAttribute('role','alert');elements.submit=node('button','button primary queue-submit','开始顺序取材');elements.submit.type='button';elements.submit.addEventListener('click',()=>submit());
      elements.sync=node('button','button secondary','重新同步');elements.sync.type='button';elements.sync.addEventListener('click',()=>sync().catch(()=>{}));elements.retry=node('button','button secondary','重试原批次');elements.retry.type='button';elements.retry.addEventListener('click',()=>submit(true));
      elements.recovery = node('div', 'action-row queue-recovery');
      elements.recovery.append(elements.sync, elements.retry);
      editor.append(heading,elements.rows,toolbar,elements.notice,elements.error,elements.submit,elements.recovery);mountRows();}
    if (status) {
      elements.summary = node('p', 'queue-status-summary field-hint');
      elements.active = node('div', 'queue-active');
      elements.waiting = node('div', 'queue-waiting');
      elements.queueError = node('p', 'inline-error');
      elements.queueError.setAttribute('role', 'alert');
      elements.retryPanel = node('section', 'queue-retry-panel');
      elements.retryPanel.setAttribute('aria-label', '待重试任务');

      const history = node('details', 'queue-history');
      elements.historyHeading = node('summary');
      const tools = node('div', 'queue-history-tools');
      elements.historyRefresh = node('button', 'text-button', '刷新记录');
      elements.historyRefresh.type = 'button';
      elements.historyRefresh.addEventListener('click', () => sync().catch(() => {}));
      elements.historyDelete = recordButton('批量删除', beginBulkDelete, 'text-button queue-delete-record');
      const historyActions = node('div', 'queue-history-actions');
      historyActions.append(elements.historyRefresh, elements.historyDelete);
      tools.append(node('span', 'field-hint', '已结束的任务与导出结果'), historyActions);

      elements.bulkConfirmation = node('div', 'queue-record-confirm queue-history-confirm');
      elements.bulkCaption = node('p', 'field-hint');
      elements.bulkConfirm = recordButton('确认批量删除', deleteHistoryBatch, 'text-button queue-delete-record');
      elements.bulkCancel = recordButton('取消', cancelBulkDelete);
      const confirmationActions = node('div', 'queue-job-actions');
      confirmationActions.append(elements.bulkConfirm, elements.bulkCancel);
      elements.bulkConfirmation.append(elements.bulkCaption, confirmationActions);

      elements.historyError = node('p', 'inline-error');
      elements.historyError.setAttribute('role', 'alert');
      elements.historyNotice = node('p', 'queue-history-notice field-hint');
      elements.historyNotice.setAttribute('role', 'status');
      elements.results = node('div', 'queue-history-list');
      elements.pagination = node('nav', 'queue-history-pages');
      elements.pagination.setAttribute('aria-label', '历史记录分页');
      elements.pageLabel = node('span', 'field-hint');
      elements.pageLabel.setAttribute('aria-live', 'polite');
      elements.previousPage = historyPageButton('上一页', -1);
      elements.nextPage = historyPageButton('下一页', 1);
      elements.pagination.append(elements.previousPage, elements.pageLabel, elements.nextPage);
      history.append(elements.historyHeading, tools, elements.bulkConfirmation, elements.historyError, elements.historyNotice, elements.results, elements.pagination);
      status.append(elements.summary, elements.active, elements.waiting, elements.queueError, elements.retryPanel, history);
    }
  }
  function historyPageButton(label, step) {
    const button = node('button', 'button secondary', label);
    button.type = 'button';
    button.addEventListener('click', () => {
      if (button.disabled) return;
      confirmingId = '';
      historyPage += step;
      renderHistory(jobs.filter(job => TERMINAL.has(job.status)));
    });
    return button;
  }
  function recordButton(label, handler, className = 'text-button') {
    const button = node('button', className, label);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
  }
  function renderRetryPanel() {
    const panel = elements.retryPanel, intent = retryIntent;
    panel.hidden = !intent;
    if (!intent) { retryPanelKey = ''; panel.replaceChildren(); return; }
    const differentLegacySource = intent.needsSourceConfirmation && intent.sourceLabel && context.label && context.label !== intent.sourceLabel;
    const sourceId = context.ready && !differentLegacySource && context.sourceId !== intent.rejectedSourceId ? context.sourceId : '';
    const tracks = intent.needsSubtitle && sourceId ? (context.subtitles || []).filter(track => track.supported) : [];
    if (intent.subtitleSourceId !== sourceId) {
      intent.subtitleChoice = '';
      intent.subtitleSourceId = sourceId;
    }
    const original = jobs.find(job => job.id === intent.id);
    const unavailable = !intent.uncertain && !retryable(original);
    const blocked = context.blocked || context.connected === false || submitting || uncertain;
    const key = JSON.stringify([intent.id, intent.body, intent.message, intent.uncertain, intent.needsSourceConfirmation, intent.needsSubtitle,
      retryPosting, sourceId, context.label, tracks, blocked, context.sourceLocked, unavailable]);
    if (key === retryPanelKey) return;
    retryPanelKey = key;
    const heading = node('h3', '', `重试「${intent.label}」`);
    const message = node('p', 'field-hint');
    if (retryPosting) message.textContent = '正在加入顺序队列…';
    else if (unavailable) message.textContent = '原记录已变化，请在历史记录中查看最新状态。';
    else if (intent.uncertain) message.textContent = '提交结果待确认。可以重新确认同一次重试。';
    else if (intent.body) message.textContent = '重试设置已保留，可以再次尝试入队。';
    else if (differentLegacySource) message.textContent = `当前影片与旧记录的原片名称不同，请选择并检查「${intent.sourceLabel}」。`;
    else if (!sourceId) message.textContent = '请重新抓取或选择原来的影片并检查。原片段的时间、名称和余量已保留。';
    else message.textContent = `已检查「${context.label || '当前影片'}」。确认与原片「${intent.sourceLabel || intent.label}」为同一份文件后继续。`;
    panel.replaceChildren(heading, message);
    if (intent.message && !retryPosting && (!intent.rejectedSourceId || !sourceId)) {
      const failure = node('p', 'queue-job-error', intent.message);
      failure.setAttribute('role', 'alert');
      panel.append(failure);
    }
    if (retryPosting) return;

    const actions = node('div', 'queue-job-actions');
    const dismiss = recordButton(unavailable ? '关闭' : '取消重试', cancelRetryIntent);
    if (!unavailable && intent.body) {
      const again = recordButton(intent.uncertain ? '重新确认提交' : '再次尝试入队', () => sendRetry(intent.body), 'button secondary');
      again.disabled = blocked;
      actions.append(again);
    } else if (!unavailable && sourceId) {
      const proceed = recordButton('确认同片并重试', () => {
        if (proceed.disabled) return;
        const body = { sourceId };
        if (intent.needsSourceConfirmation) body.confirmSource = true;
        if (intent.needsSubtitle) body.subtitleStreamIndex = intent.subtitleChoice === 'none' ? null : Number(intent.subtitleChoice);
        return sendRetry(body);
      }, 'button secondary');
      proceed.disabled = blocked || intent.needsSubtitle && intent.subtitleChoice === '';
      if (intent.needsSubtitle) {
        const label = node('label', 'field-hint', '旧记录缺少字幕设置，请补选独立字幕');
        label.setAttribute('for', 'queue-retry-subtitle');
        const select = node('select');
        select.id = 'queue-retry-subtitle';
        select.disabled = blocked;
        for (const [value, title] of [['', '请选择'], ['none', '不保存字幕'], ...tracks.map(track => [String(track.index), track.label])]) {
          const option = node('option', '', title);
          option.value = value;
          select.append(option);
        }
        select.value = intent.subtitleChoice;
        select.addEventListener('change', () => {
          intent.subtitleChoice = select.value;
          proceed.disabled = blocked || select.value === '';
        });
        panel.append(label, select, node('p', 'field-hint', '旧记录中未保存的其他导出选项会采用工具默认值。'));
      }
      actions.append(proceed);
      const choose = recordButton('重新选择原片', onChooseSource);
      choose.disabled = context.sourceLocked || context.connected === false;
      actions.append(choose);
    } else if (!unavailable) {
      const choose = recordButton('去检查同一原片', onChooseSource, 'button secondary');
      choose.disabled = context.sourceLocked || context.connected === false;
      actions.append(choose);
      if (context.sourceLocked) panel.append(node('p', 'field-hint', '当前操作结束后可重新检查原片。'));
    }
    if (!intent.uncertain) actions.append(dismiss);
    panel.append(actions);
  }
  function renderRetryAction(job, label, actions) {
    if (!retryable(job)) return;
    if (job.retry.jobId) {
      const child = jobs.find(item => item.id === job.retry.jobId);
      if (child) {
        const open = recordButton('查看重试任务', () => selectJob(job.retry.jobId));
        actions.append(open);
      } else actions.append(node('span', 'field-hint', '已重试'));
      return;
    }
    const retry = recordButton(retryPosting && retryIntent?.id === job.id ? '正在提交…' : '重试', () => beginRecordRetry(job, label));
    retry.setAttribute('aria-label', `重试 ${label}`);
    retry.disabled = Boolean(retryIntent || submitting || uncertain || confirmingBulk || context.blocked || context.connected === false);
    actions.append(retry);
  }
  function renderRecordActions(job, name, actions, line) {
    if (confirmingId !== job.id) {
      const remove = recordButton('删除记录', () => {
        if (confirmingBulk || !canDeleteRecord(job)) return;
        confirmingId = job.id;
        historyError = historyNotice = '';
        render();
        elements.confirmCancel?.focus?.();
      }, 'text-button queue-delete-record');
      remove.setAttribute('aria-label', `删除记录 ${name}`);
      remove.disabled = Boolean(confirmingBulk) || !canDeleteRecord(job);
      actions.append(remove);
      return;
    }
    const confirmation = node('div', 'queue-record-confirm');
    const caption = node('p', 'field-hint', '删除这条记录？视频、字幕和导出文件夹会保留。');
    const controls = node('div', 'queue-job-actions');
    const confirm = recordButton(deletingHistory ? '正在删除…' : '确认删除', () => deleteRecord(job.id), 'text-button queue-delete-record');
    const keep = recordButton('保留记录', () => { confirmingId = ''; render(); });
    confirm.disabled = keep.disabled = deletingHistory;
    elements.confirmCancel = keep;
    controls.append(confirm, keep);
    confirmation.append(caption, controls);
    line.append(confirmation);
  }
  function renderHistory(records) {
    const pages = Math.max(1, Math.ceil(records.length / HISTORY_PAGE_SIZE));
    historyPage = Math.max(0, Math.min(historyPage, pages - 1));
    if (confirmingId && !records.some(job => job.id === confirmingId)) confirmingId = '';
    const page = records.slice(historyPage * HISTORY_PAGE_SIZE, (historyPage + 1) * HISTORY_PAGE_SIZE);
    const bulkCount = bulkDeleteIds().length;
    const key = JSON.stringify([page, records.length, historyLoaded, historyPage, confirmingId, confirmingBulk, deletingHistory, bulkCount, historyError, historyNotice,
      pending?.clientBatchId, context.connected, context.blocked, retryIntent?.id, retryPosting, submitting, uncertain,
      page.map(job => job.retry?.jobId && jobs.some(item => item.id === job.retry.jobId))]);
    if (key === historyKey) {
      for (const row of historyRows) markSelected(row);
      return;
    }
    historyKey = key;
    elements.historyHeading.textContent = historyLoaded ? `历史记录（${records.length}）` : '历史记录';
    elements.historyRefresh.disabled = context.connected === false;
    elements.historyDelete.disabled = !bulkCount || Boolean(confirmingBulk);
    elements.bulkConfirmation.hidden = !confirmingBulk;
    if (confirmingBulk) {
      elements.bulkCaption.textContent = `删除各页共 ${confirmingBulk.length} 条历史记录？导出文件和可续传记录会保留。`;
      elements.bulkConfirm.textContent = deletingHistory ? '正在删除…' : '确认批量删除';
      elements.bulkConfirm.disabled = deletingHistory || context.connected === false;
      elements.bulkCancel.disabled = deletingHistory;
    }
    elements.historyError.textContent = historyError;
    elements.historyError.hidden = !historyError;
    elements.historyNotice.textContent = historyNotice;
    elements.historyNotice.hidden = !historyNotice;
    elements.pagination.hidden = pages === 1;
    elements.pageLabel.textContent = `第 ${historyPage + 1} / ${pages} 页`;
    elements.previousPage.disabled = historyPage === 0;
    elements.nextPage.disabled = historyPage + 1 === pages;
    elements.confirmCancel = null;
    historyRows = page.map(job => createJobRow(job, 'recent'));
    elements.results.replaceChildren(...historyRows.map(row => row.line));
    if (!page.length) {
      const message = historyLoaded ? '还没有取材记录。' : context.connected === false ? '连接本机服务后显示取材记录。' : '正在读取任务记录…';
      elements.results.append(node('p', 'field-hint queue-history-empty', message));
    }
  }
  function markSelected(row) {
    row.detail.setAttribute('aria-pressed', String(row.id === focusedId));
  }
  function updateJobRow(row, job) {
    const label = job.clipName || job.sourceLabel || job.result?.sourceLabel || base(job.result?.outputDir || job.result?.candidatePath) || '片段';
    const recent = row.kind === 'recent';
    const resumable = recent && job.status !== 'completed' && job.resume?.available === true;
    const cleanup = recent && job.resume?.discardable === true;
    const stoppedMp4 = job.status === 'cancelled' && job.result?.candidatePath && !job.result.compatiblePath;
    row.name.textContent = label;
    row.detail.setAttribute('aria-label', `查看详情 ${label}`);
    row.badge.className = `tag${job.status === 'failed' ? ' error' : job.status === 'completed' ? ' success' : ''}`;
    row.badge.textContent = stoppedMp4 ? 'MP4 已停止' : resumable ? '可继续' : cleanup ? '需清理缓存' : stage[job.status] || '处理中';
    const range = job.requested || historyRequestedRange(job);
    const hasRange = range && Number.isFinite(range.start) && Number.isFinite(range.end);
    const handles = Number.isFinite(range?.handles) ? ` · 前后各 ${range.handles} 秒` : '';
    row.range.textContent = hasRange ? `源时间 ${time(range.start)}–${time(range.end)}${handles}` : '';
    row.range.hidden = !hasRange;
    const timing = queueTime(job), meta = [];
    const created = stamp(job.createdAt || job.finishedAt);
    if (recent && created !== null) meta.push(historyDate.format(created));
    if (job.type === 'compatible') meta.push('本地 MP4');
    if (stoppedMp4) meta.push('原码 MKV 已保存');
    if (job.retryOf) meta.push('重试任务');
    if (timing.waiting !== null) meta.push(`排队 ${duration(timing.waiting)}`);
    if (timing.working !== null) meta.push(`实际处理 ${duration(timing.working)}`);
    if (Number.isFinite(job.metrics?.receivedBytes)) meta.push(`已接收 ${bytes(job.metrics.receivedBytes)}`);
    row.meta.textContent = meta.join(' · ');
    row.meta.hidden = meta.length === 0;
    if (row.progress) {
      const value = Number.isFinite(job.progress) ? job.progress : null;
      if (value !== row.progressValue) {
        if (value === null) row.progress.removeAttribute('value');
        else row.progress.value = value;
        row.progressValue = value;
      }
      row.stage.textContent = stage[job.stage] || job.message || '正在处理';
    }
    row.error.textContent = !stoppedMp4 && job.error?.message ? text(job.error) : '';
    row.error.hidden = !row.error.textContent;
    markSelected(row);
    return label;
  }
  function createJobRow(job, kind) {
    const line = node('div', `queue-job queue-job-${kind}`);
    const top = node('div', 'queue-job-top');
    const name = node('strong');
    const badge = node('span', 'tag');
    const range = node('p', 'field-hint');
    const meta = node('p', 'field-hint queue-job-meta');
    const error = node('p', 'queue-job-error');
    const actions = node('div', 'queue-job-actions');
    const detail = recordButton('详情', () => selectJob(job.id), 'text-button queue-detail');
    detail.setAttribute('aria-controls', 'task-details-shell');
    line.addEventListener('click', event => {
      if (!event.target.closest('button, a, .queue-record-confirm')) selectJob(job.id);
    });
    const row = { id: job.id, kind, line, name, badge, range, meta, error, detail };
    top.append(name, badge);
    line.append(top, range, meta);
    if (kind === 'active') {
      row.progress = node('progress', 'queue-progress');
      row.progress.max = 100;
      row.progress.setAttribute('aria-label', '当前片段进度');
      row.progressValue = null;
      row.stage = node('p', 'field-hint');
      line.append(row.progress, row.stage);
    }
    line.append(error, actions);
    actions.append(detail);
    const label = updateJobRow(row, job);
    if (kind === 'recent') renderRetryAction(job, label, actions);
    if (live(job)) actions.append(recordButton(job.status === 'queued' ? '移出队列' : '停止本条', () => cancel(job)));
    const result = job.result;
    const revealPath = result?.candidatePath || result?.compatiblePath || result?.outputPath || result?.outputDir || result?.sidecarPath || result?.subtitlePaths?.[0];
    if (kind === 'recent' && revealPath) {
      actions.append(recordButton('打开文件夹', () => reveal(revealPath)));
    }
    if (kind === 'recent') renderRecordActions(job, label, actions, line);
    return row;
  }
  function renderLiveJobs(current, waiting) {
    if (current) {
      if (activeRow?.id === current.id) updateJobRow(activeRow, current);
      else {
        activeRow = createJobRow(current, 'active');
        emptyActiveMessage = '';
        elements.active.replaceChildren(activeRow.line);
      }
    } else {
      const message = waiting.length ? '正在准备下一段…' : '暂无进行中的任务';
      if (message !== emptyActiveMessage) {
        activeRow = null;
        emptyActiveMessage = message;
        elements.active.replaceChildren(node('div', 'queue-empty', message));
      }
    }
    if (waiting.length !== waitingRows.length || waiting.some((job, index) => job.id !== waitingRows[index].id)) {
      const previousRows = new Map(waitingRows.map(row => [row.id, row]));
      waitingRows = waiting.map(job => previousRows.get(job.id) || createJobRow(job, 'waiting'));
      elements.waiting.replaceChildren(...(waiting.length ? [
        node('h3', '', '等待处理'), ...waitingRows.map(row => row.line),
      ] : []));
    }
    waiting.forEach((job, index) => updateJobRow(waitingRows[index], job));
  }
  function render(){
    const locked=submitting||uncertain;
    if(editor){for(const row of rows){const refs=rowNodes.get(row.id);if(!refs)continue;for(const key of['start','end','name','handles','budget']){if(refs[key].value!==row[key])refs[key].value=row[key];refs[key].disabled=locked||key==='budget'&&context.kind==='local';}
      refs.remove.disabled=locked;const tracks=context.subtitles||[],trackKey=JSON.stringify(tracks);if(refs.trackKey!==trackKey){refs.subtitle.replaceChildren();const none=node('option','','不保存字幕');none.value='';refs.subtitle.append(none);for(const t of tracks){const o=node('option','',t.label);o.value=String(t.index);o.disabled=!t.supported;refs.subtitle.append(o);}refs.trackKey=trackKey;}refs.subtitle.value=row.subtitle;refs.subtitle.disabled=locked||!tracks.some(t=>t.supported);
      const advice=estimate(row),low=advice&&Number(row.budget)*1024**2<advice.estimatedBytes;refs.advice.textContent=empty(row)?'':context.kind==='local'?`前后各 ${row.handles} 秒${row.subtitle!==''?' · 独立字幕':''}`:advice?`本段估算 ${bytes(advice.estimatedBytes)} · 读取上限 ${bytes(Number(row.budget)*1024**2)}${low?' · 上限偏低，可能提前停止':''}`:`前后各 ${row.handles} 秒 · ${row.subtitle===''?'不保存字幕':'独立字幕'} · 每段上限 ${bytes(Number(row.budget)*1024**2)}`;refs.advice.classList.toggle('queue-low-budget',Boolean(low));refs.use.hidden=!advice;refs.use.disabled=locked;
    }elements.add.disabled=locked||rows.length>=10;elements.count.textContent=`${rows.length}/10 个片段行`;const filled=rows.filter(r=>!empty(r));const total=filled.reduce((sum,r)=>sum+Number(r.budget||0),0);elements.notice.textContent=otherMovieActive()?'队列仍在处理另一部影片，请等待完成后提交当前草稿。':context.kind==='local'?`本地文件不受HTTP读取上限限制。`:filled.length?`读取上限合计 ${bytes(total*1024**2)}。`:'';elements.error.textContent=error;elements.error.hidden=!error;elements.submit.disabled=locked||retryPosting||Boolean(retryIntent?.uncertain)||Boolean(otherMovieActive())||!context.ready||context.blocked||!filled.length;elements.submit.textContent=submitting?'正在整批提交…':activeJobs().length?'把这些片段加入队列':`开始顺序取材${filled.length?`（${filled.length} 段）`:''}`;elements.sync.hidden=!uncertain&&!error;elements.retry.hidden=!uncertain;elements.retry.disabled=submitting;}
    if (editor) elements.recovery.hidden = !uncertain && !error;
    if (status) {
      const current = jobs.find(j => j.status === 'running');
      const waiting = jobs.filter(j => j.status === 'queued');
      if (statusBadge) {
        const label = [current ? '进行中 1' : '', waiting.length ? `等待 ${waiting.length}` : ''].filter(Boolean).join(' · ');
        if (statusBadge.textContent !== label) statusBadge.textContent = label;
        statusBadge.hidden = !label;
      }
      elements.summary.textContent = `一次只处理一条${waiting.length ? ` · ${waiting.length} 条等待` : ''}${current ? ' · 完成或失败后继续下一条' : ''}`;
      renderLiveJobs(current, waiting);
      elements.queueError.textContent = queueError;
      elements.queueError.hidden = !queueError;
      renderRetryPanel();
      renderHistory(jobs.filter(job => TERMINAL.has(job.status)));
    }
  }
  function observe(job, { track = false } = {}) {
    if (!job?.id || removedRecords.has(job.id)) return;
    if (track) { jobRevision += 1; focusedId = job.id; followActive = false; }
    const index = jobs.findIndex(item => item.id === job.id);
    if (index >= 0) jobs[index] = job;
    else if (live(job)) jobs.unshift(job);
    render(); schedule();
  }
  mount();refresh();
  return{submit,sync,hydrate,refresh,add,remove,cancel,observe,hasActivity,hasDraft:()=>rows.some(r=>r.edited&&!empty(r)),get rows(){return rows;},get jobs(){return jobs;},get uncertain(){return uncertain;},get pending(){return pending;},queueTime,
    focusFirstDraft(){rowNodes.get(rows[0]?.id)?.start.focus?.();},
    dispose(){disposed=true;clearTimer(timer);timer=null;}};
}
