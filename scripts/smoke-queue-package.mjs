import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const run=promisify(execFile),wait=ms=>new Promise(r=>setTimeout(r,ms));
const code=path.resolve(process.argv[2],'Contents/Resources/app'),bin=n=>path.join(code,'bin',n);
const {startServer}=await import(pathToFileURL(path.join(code,'server.mjs')));
const {createRemoteSource}=await import(pathToFileURL(path.join(code,'src/remote.mjs')));
const {createDirectStream}=await import(pathToFileURL(path.join(code,'src/direct-stream.mjs')));
const scratch=await mkdtemp(path.join(os.tmpdir(),'clip-queue-package-'));
const source=path.join(scratch,'合成电影.mkv'),captions=path.join(scratch,'captions.srt');
await writeFile(captions,'1\n00:00:02,000 --> 00:00:03,500\n第一段字幕\n\n2\n00:00:06,000 --> 00:00:07,500\n第二段字幕\n\n3\n00:00:10,000 --> 00:00:11,500\n第三段字幕\n');
await run(bin('ffmpeg'),['-v','error','-n','-i',path.join(code,'examples/示例视频.mkv'),'-i',captions,'-map','0:v:0','-map','0:a:0?','-map','1:0','-c','copy',source]);
const bytes=await readFile(source),leases=[];let app,failLeaseNumber=0,peak=0;
const upstream=http.createServer((req,res)=>{
 if(req.url.includes('fail=1')){res.writeHead(503).end();return}
 const m=/^bytes=(\d+)-(\d+)$/.exec(req.headers.range||'');if(!m){res.writeHead(400).end();return}
 const start=Number(m[1]),end=Math.min(Number(m[2]),bytes.length-1);if(start<0||end<start){res.writeHead(416).end();return}
 res.writeHead(206,{'Content-Length':end-start+1,'Content-Range':`bytes ${start}-${end}/${bytes.length}`,ETag:'"queue-fixture"'});res.end(bytes.subarray(start,end+1));
});
try{
 await new Promise((resolve,reject)=>{upstream.once('error',reject);upstream.listen(0,'127.0.0.1',resolve)});
 const fixture=`http://127.0.0.1:${upstream.address().port}/source.mkv`,publicUrl='https://media.example.com/fixture.mkv?signature=SYNTHETIC_ONLY';
 app=await startServer({outputDir:path.join(scratch,'outputs'),dataDir:path.join(scratch,'state'),ffmpegPath:bin('ffmpeg'),ffprobePath:bin('ffprobe'),
  browserSourceFactory:o=>{assert.equal(o.url,publicUrl);return createRemoteSource({...o,url:fixture,networkPolicy:'default'})},
  browserStreamFactory:o=>{
   assert.equal(o.url,publicUrl);assert.equal(leases.filter(x=>!x.closed).length,0,'sequential queue must never open another extraction lease');
   const number=leases.length+1,lease=createDirectStream({...o,url:fixture+(number===failLeaseNumber?'?fail=1':''),allowLoopbackHttp:true});
   const entry={lease,closed:false};leases.push(entry);peak=Math.max(peak,leases.filter(x=>!x.closed).length);const close=lease.close;lease.close=(...args)=>{entry.closed=true;return close(...args)};return lease;
  }});
 const boot=await fetch(app.url+'/api/bootstrap').then(r=>r.json());
 const request=async(route,body,headers={})=>{const response=await fetch(app.url+route,body===undefined?{}:{method:'POST',headers:{Origin:app.url,'Content-Type':'application/json','X-Session-Token':boot.sessionToken,...headers},body:JSON.stringify(body)});return{status:response.status,data:await response.json()}};
 const api=async(route,body)=>{const r=await request(route,body);assert(r.status>=200&&r.status<300,JSON.stringify(r));return r.data};
 const state=await api('/api/bookmark-capture/state'),token=/const TOKEN = "([a-f0-9]{64})"/.exec(decodeURIComponent(state.bookmarklet.slice(11)))?.[1];assert(token);
 const imported=await request('/api/bookmark-capture/import',{schemaVersion:1,provider:'xunlei',pageUrl:'https://pan.xunlei.com/',candidates:[{url:publicUrl,name:'合成电影.mkv',size:bytes.length,headers:{'User-Agent':'SyntheticQueueQA',Referer:'https://pan.xunlei.com/'}}]},{'X-Bookmark-Token':token});assert.equal(imported.status,200);
 const inbox=await api('/api/bookmark-capture/state'),probe=await api('/api/probe',{source:{type:'browser',value:inbox.candidates[0].id}}),subtitle=probe.media.streams.find(s=>s.type==='subtitle');assert(subtitle);
 const item=i=>({clientItemId:randomBytes(16).toString('hex'),start:1+i*4,end:4+i*4,handles:0,clipName:'顺序队列素材',subtitleStreamIndex:subtitle.index,budgetMiB:64,downloadMethod:'direct-stream',makeMp4:i===0});
 const invalid=await request('/api/jobs/batch',{sourceId:probe.sourceId,clientBatchId:randomBytes(16).toString('hex'),jobs:[item(0),{...item(1),end:0}]});assert.equal(invalid.status,400);
 const empty=await api('/api/jobs/queue');assert.equal(empty.activeJob,null);assert.equal(empty.queuedJobs.length,0);
 const payload={sourceId:probe.sourceId,clientBatchId:randomBytes(16).toString('hex'),jobs:[0,1,2].map(item)};
 const created=await api('/api/jobs/batch',payload),again=await api('/api/jobs/batch',payload);assert.equal(created.jobs.length,3);assert.deepEqual(again.jobs.map(j=>j.id),created.jobs.map(j=>j.id));
 const finish=async jobs=>{let snapshots;for(let i=0;i<800;i++){snapshots=await Promise.all(jobs.map(j=>api('/api/jobs/'+j.id)));if(snapshots.every(j=>['completed','failed','cancelled'].includes(j.status)))return snapshots;await wait(25)}assert.fail('queue did not settle')};
 const done=await finish(created.jobs);for(const j of done){assert.equal(j.status,'completed',JSON.stringify(j.error));assert(j.startedAt);assert.equal(j.result.subtitlePaths.length,1);assert(j.diagnostics.transfer);assert(j.diagnostics.transfer.requestsStarted>0);assert(j.diagnostics.transfer.readTimings?.requestsRecorded>0)}
 for(let i=1;i<done.length;i++)assert(Date.parse(done[i].startedAt)>=Date.parse(done[i-1].finishedAt),'next job starts after previous completion');
 assert.equal(new Set(done.map(j=>path.dirname(j.result.candidatePath))).size,3);
 for(const j of done){assert((await stat(j.result.candidatePath)).size>0);await run(bin('ffmpeg'),['-v','error','-xerror','-i',j.result.candidatePath,'-map','0:v:0','-an','-sn','-f','null','-'],{timeout:30000})}
 assert(done[0].result.compatiblePath);await run(bin('ffmpeg'),['-v','error','-xerror','-i',done[0].result.compatiblePath,'-map','0:v:0','-an','-sn','-f','null','-'],{timeout:30000});
 failLeaseNumber=leases.length+2;
 const mixed=await api('/api/jobs/batch',{sourceId:probe.sourceId,clientBatchId:randomBytes(16).toString('hex'),jobs:[0,1,2].map(i=>({...item(i),clipName:`失败继续${i}`,makeMp4:false}))});
 const settled=await finish(mixed.jobs);assert.equal(settled[0].status,'completed');assert.equal(settled[1].status,'failed');assert.equal(settled[1].error.code,'REMOTE_HTTP');assert.equal(settled[2].status,'completed');
 const record=JSON.stringify(settled[1].diagnostics);assert(settled[1].diagnostics.transfer.readTimings.requests.some(r=>r.httpStatus===503&&r.outcome==='failed'&&r.failureCode==='REMOTE_HTTP'&&r.terminalStage==='response_validation'),'passive diagnostics retains exact safe HTTP failure classification');assert(!/SYNTHETIC_ONLY|https?:|SyntheticQueueQA/.test(record));
 const moduleResponse=await fetch(app.url+'/queue-workspace.mjs');assert.equal(moduleResponse.status,200);assert.match(moduleResponse.headers.get('content-type'),/javascript/);
 const history=await readFile(path.join(scratch,'state/tasks.json'),'utf8');assert(!/SYNTHETIC_ONLY|signature=|SyntheticQueueQA/.test(history));
 await app.close();app=null;assert(leases.every(x=>x.closed));assert.equal(peak,1);
 console.log(JSON.stringify({status:'passed',version:boot.version,scope:'actual packaged Node/FFmpeg/ffprobe + synthetic loopback browser-source fixture',atomicBatchValidation:true,idempotentBatch:true,peakActiveExtractionLeases:peak,serialOrderVerified:true,separateSubtitles:true,sameNameFoldersIsolated:true,threeVideosAndMp4FullyDecoded:true,httpFailureContinuesNext:true,passiveHttpStatusVisible:true,passiveTransferTelemetryPresent:true,allLeasesClosed:true,realCloudTested:false}));
}finally{await app?.close();upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));await rm(scratch,{recursive:true,force:true,maxRetries:4,retryDelay:100})}
