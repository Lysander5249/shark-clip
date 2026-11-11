import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const run=promisify(execFile);
const namedDirectories=process.argv.includes('--named-directories');
const packagePath=path.resolve(process.argv[2]);
const root=path.join(packagePath,'Contents/Resources/app');
const binary=name=>path.join(root,'bin',name);
const temp=await mkdtemp(path.join(os.tmpdir(),'clip-options-package-'));
const captions=path.join(temp,'captions.srt'),source=path.join(temp,'测试电影.mkv');
await writeFile(captions,'1\n00:00:01,000 --> 00:00:04,000\n独立字幕测试\n\n2\n00:00:04,200 --> 00:00:08,000\nSeparate captions\n');
await run(binary('ffmpeg'),['-v','error','-n','-i',path.join(root,'examples/示例视频.mkv'),'-i',captions,'-map','0:v:0','-map','0:a:0?','-map','1:0','-c','copy','-metadata:s:s:0','language=zho',source]);
const child=spawn(binary('node'),[path.join(root,'desktop/main.mjs')],{env:{...process.env,NODE_OPTIONS:'',NODE_PATH:'',CLIP_FETCHER_NATIVE_DIALOGS:'0',CLIP_FETCHER_OUTPUT_DIR:path.join(temp,'outputs'),CLIP_FETCHER_DATA_DIR:path.join(temp,'state')},stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',chunk=>{stderr=(stderr+chunk).slice(-2000)});
try {
 const url=await new Promise((resolve,reject)=>{
  let buffer='';const timer=setTimeout(()=>reject(new Error('startup timeout')),30000);
  child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);reject(new Error(`exit ${code}: ${stderr}`))});
  child.stdout.on('data',chunk=>{buffer+=chunk;const m=/^CLIP_FETCHER_URL=(http:\/\/127\.0\.0\.1:\d+)\r?$/m.exec(buffer);if(m){clearTimeout(timer);resolve(m[1])}});
 });
 const boot=await fetch(url+'/api/bootstrap').then(r=>r.json());
 const post=async(route,data)=>{const r=await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json','X-Session-Token':boot.sessionToken},body:JSON.stringify(data)});const d=await r.json();assert(r.ok,JSON.stringify(d));return d;};
 const p=await post('/api/probe',{source:{type:'local',value:source}});
 const sub=p.media.streams.find(s=>s.type==='subtitle');assert(sub);
 const job=await post('/api/jobs',{sourceId:p.sourceId,start:2,end:6,handles:1,clipName:'独立命名测试',subtitleStreamIndex:sub.index,makeMp4:true,budgetMiB:256});
 let done;
 for(let n=0;n<200;n++){done=await fetch(url+'/api/jobs/'+job.id).then(r=>r.json());if(['completed','failed','cancelled'].includes(done.status))break;await new Promise(r=>setTimeout(r,100));}
 assert.equal(done.status,'completed',JSON.stringify(done.error));assert.equal(done.result.subtitlePaths.length,1,JSON.stringify(done.result.warnings));
 assert.equal(path.basename(done.result.candidatePath),'独立命名测试.mkv');assert.equal(path.basename(done.result.compatiblePath),'独立命名测试.mp4');
 if(namedDirectories) assert.equal(path.basename(path.dirname(done.result.candidatePath)), '独立命名测试');
 const srt=await readFile(done.result.subtitlePaths[0],'utf8');assert(srt.includes('独立字幕测试'));
 for(const f of [done.result.candidatePath,done.result.compatiblePath]){
  assert((await stat(f)).size>0);
  const m=JSON.parse((await run(binary('ffprobe'),['-v','error','-show_streams','-of','json',f])).stdout);assert(!m.streams.some(s=>s.codec_type==='subtitle'));
  await run(binary('ffmpeg'),['-v','error','-xerror','-i',f,'-map','0:v:0','-an','-sn','-f','null','-'],{timeout:30000});
 }
 const manifest=JSON.parse(await readFile(done.result.sidecarPath,'utf8'));assert.equal(manifest.subtitles.status,'exported');
 assert.equal(manifest.subtitles.files[0].timeline.status,'verified-local-packet-offset');
 if(namedDirectories) {
  const second=await post('/api/jobs',{sourceId:p.sourceId,start:2,end:6,handles:1,clipName:'独立命名测试',makeMp4:false,budgetMiB:256});
  let duplicate;
  for(let n=0;n<200;n++){duplicate=await fetch(url+'/api/jobs/'+second.id).then(r=>r.json());if(['completed','failed','cancelled'].includes(duplicate.status))break;await new Promise(r=>setTimeout(r,100));}
  assert.equal(duplicate.status,'completed',JSON.stringify(duplicate.error));
  assert.equal(path.basename(path.dirname(duplicate.result.candidatePath)), '独立命名测试 (2)');
  assert((await stat(done.result.candidatePath)).size>0);
 }
 console.log(JSON.stringify({namedDirectories,duplicateDirectorySafe:namedDirectories ? true : null,status:'passed',version:boot.version,scope:'actual packaged Node/FFmpeg/ffprobe + synthetic local subtitle fixture',nameBeforeDownload:true,separateSrt:true,videoContainsSubtitle:false,mp4ContainsSubtitle:false,fullVideoDecodePassed:true,subtitleLocalPacketTimelineVerified:true,realCloudTested:false}));
} finally {
 if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,5000))]);if(child.exitCode===null)child.kill('SIGKILL')}
 await rm(temp,{recursive:true,force:true,maxRetries:4,retryDelay:100});
}
