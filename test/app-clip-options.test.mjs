import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { startServer } from '../server.mjs';
import { defaultClipName } from '../public/clip-options.mjs';
import { resumeTaskRecord } from '../src/resume-tasks.mjs';
import { historyRecord } from '../src/history.mjs';

const run = promisify(execFile);
const tools = { ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg', ffprobePath: process.env.FFPROBE_PATH || 'ffprobe' };

test('named extraction saves a clean movie and independent subtitle, preserves paths across restart and local MP4 creation', { timeout: 60000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-options-app-'));
  let app;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });
  const captions = path.join(root, 'caption.srt'), source = path.join(root, '测试电影.mkv');
  await writeFile(captions, '1\n00:00:01,000 --> 00:00:04,000\n你好，字幕独立保存。\n\n2\n00:00:04,200 --> 00:00:08,500\nSecond independent caption\n');
  await run(tools.ffmpegPath, ['-hide_banner','-loglevel','error','-n','-i',fileURLToPath(new URL('../examples/示例视频.mkv',import.meta.url)),'-i',captions,
    '-map','0:v:0','-map','0:a:0?','-map','1:0','-c','copy','-metadata:s:s:0','language=zho',source]);
  const options = { outputDir: path.join(root,'outputs'), dataDir: path.join(root,'state'), ...tools, reveal: async () => {} };
  app = await startServer(options);
  let session = await fetch(app.url+'/api/bootstrap').then(r=>r.json());
  const post = async (route,data) => {
    const r=await fetch(app.url+route,{method:'POST',headers:{'Content-Type':'application/json','X-Session-Token':session.sessionToken},body:JSON.stringify(data)});
    return { status:r.status, data:await r.json() };
  };
  const probe = await post('/api/probe',{source:{type:'local',value:source}});
  assert.equal(probe.status,200);
  const track = probe.data.media.streams.find(s=>s.type==='subtitle'); assert(track);
  for(const bad of [{clipName:{invalid:true}},{clipName:'x'.repeat(2049)},{subtitleStreamIndex:'2'},{subtitleStreamIndex:999}]) {
    const r=await post('/api/jobs',{sourceId:probe.data.sourceId,start:2,end:6,handles:1,...bad}); assert.equal(r.status,400);
  }
  const created=await post('/api/jobs',{sourceId:probe.data.sourceId,start:2,end:6,handles:1,clipName:'剪辑素材',subtitleStreamIndex:track.index});
  assert.equal(created.status,202); assert.equal(created.data.clipName,'剪辑素材');
  async function finish(id) {
    for(let i=0;i<200;i++) {
      const j=await fetch(app.url+'/api/jobs/'+id).then(r=>r.json());
      if(['completed','failed','cancelled'].includes(j.status)){assert.equal(j.status,'completed',JSON.stringify(j.error));return j;}
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    assert.fail('job did not finish');
  }
  const done=await finish(created.data.id);
  const namedDirectory=path.join(options.outputDir,'剪辑素材');
  assert.equal(path.dirname(done.result.candidatePath),namedDirectory);
  assert.equal(path.dirname(done.result.sidecarPath),namedDirectory);
  assert.equal(path.basename(done.result.candidatePath),'剪辑素材.mkv');
  assert.equal(path.basename(done.result.sidecarPath),'剪辑素材.json');
  assert.equal(done.result.subtitlePaths.length,1); assert.match(done.result.subtitlePaths[0],/\.srt$/);
  assert.equal(path.dirname(done.result.subtitlePaths[0]),namedDirectory);
  assert((await readFile(done.result.subtitlePaths[0],'utf8')).includes('字幕独立保存'));
  const media=JSON.parse((await run(tools.ffprobePath,['-v','error','-show_streams','-of','json',done.result.candidatePath])).stdout);
  assert(!media.streams.some(s=>s.codec_type==='subtitle'));
  assert.equal((await post('/api/reveal',{path:done.result.subtitlePaths[0]})).status,200);
  assert.equal((await post('/api/reveal',{path:namedDirectory})).status,200);
  await app.close(); app=await startServer(options); session=await fetch(app.url+'/api/bootstrap').then(r=>r.json());
  const history=await fetch(app.url+'/api/jobs/history').then(r=>r.json());
  const restored=history.jobs.find(j=>j.id===done.id); assert.equal(restored.clipName,'剪辑素材');
  assert.equal(restored.result.candidatePath,done.result.candidatePath);
  assert.deepEqual(restored.result.subtitlePaths,done.result.subtitlePaths);
  const mp4=await post('/api/jobs/'+done.id+'/compatible',{}); assert.equal(mp4.status,202);
  const compatible=await finish(mp4.data.id); assert.equal(path.basename(compatible.result.compatiblePath),'剪辑素材.mp4');
  assert.equal(path.dirname(compatible.result.compatiblePath),namedDirectory);
  assert((await stat(compatible.result.candidatePath)).size>0);
  assert.deepEqual(compatible.result.subtitlePaths,done.result.subtitlePaths);
  const second=await post('/api/probe',{source:{type:'local',value:source}});
  const auto=await post('/api/jobs',{sourceId:second.data.sourceId,start:3,end:5,handles:0});
  const plain=await finish(auto.data.id);
  assert.equal(path.basename(plain.result.candidatePath),defaultClipName('测试电影.mkv',3,5)+'.mkv');
  assert.equal(path.basename(path.dirname(plain.result.candidatePath)),defaultClipName('测试电影.mkv',3,5));
  assert.deepEqual(plain.result.subtitlePaths,[]);
  assert((await readFile(path.join(root,'state/tasks.json'),'utf8')).includes('剪辑素材'));
});

test('cancelled automatic MP4 leaves the published MKV and subtitle accessible before and after restart', { timeout: 60000, skip: process.platform === 'win32' }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-cancel-mp4-'));
  let app, session;
  t.after(async () => { await app?.close(); await rm(root, { recursive: true, force: true }); });

  const captions = path.join(root, 'caption.srt');
  const source = path.join(root, 'movie.mkv');
  const sample = fileURLToPath(new URL('../examples/示例视频.mkv', import.meta.url));
  await writeFile(captions, '1\n00:00:03,000 --> 00:00:05,000\nSynthetic subtitle\n');
  await run(tools.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', sample, '-i', captions,
    '-map', '0:v:0', '-map', '0:a:0?', '-map', '1:0', '-c', 'copy', source]);

  // Hold only the MP4 process so the cancellation cannot race a fast remux.
  const wrapper = path.join(root, 'hold-mp4.mjs');
  await writeFile(wrapper, '#!' + process.execPath + '\n' + `
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
if (args.at(-1)?.endsWith('.partial.mp4')) {
  await new Promise(resolve => setTimeout(resolve, 60000));
} else {
  const child = spawn(${JSON.stringify(tools.ffmpegPath)}, args, { stdio: 'inherit' });
  child.once('error', () => process.exit(1));
  child.once('exit', code => process.exit(code ?? 1));
}
`, { mode: 0o755 });

  const options = { outputDir: path.join(root, 'outputs'), dataDir: path.join(root, 'state'), ...tools, reveal: async () => {} };
  app = await startServer({ ...options, ffmpegPath: wrapper });
  const get = route => fetch(app.url + route).then(response => response.json());
  const post = async (route, data) => {
    const response = await fetch(app.url + route, { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Session-Token': session.sessionToken }, body: JSON.stringify(data) });
    return { status: response.status, data: await response.json() };
  };
  async function waitForJob(id, predicate) {
    for (let attempt = 0; attempt < 200; attempt++) {
      const job = await get('/api/jobs/' + id);
      if (predicate(job) || ['completed', 'failed', 'cancelled'].includes(job.status)) return job;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.fail('job did not reach expected state');
  }
  session = await get('/api/bootstrap');
  const probe = await post('/api/probe', { source: { type: 'local', value: source } });
  assert.equal(probe.status, 200);
  const subtitleStreamIndex = probe.data.media.streams.find(stream => stream.type === 'subtitle').index;
  const created = await post('/api/jobs', { sourceId: probe.data.sourceId, start: 2, end: 6, handles: 0,
    clipName: '保存的原码片段', subtitleStreamIndex, makeMp4: true });
  assert.equal(created.status, 202);
  const id = created.data.id;
  const converting = await waitForJob(id, job => job.stage === 'compatible');
  assert.equal(converting.stage, 'compatible', JSON.stringify(converting.error));
  assert.equal((await post(`/api/jobs/${id}/cancel`, {})).status, 200);
  const stopped = await waitForJob(id, job => job.status === 'cancelled');
  assert.equal(stopped.status, 'cancelled');
  assert.equal(stopped.result.compatiblePath, undefined);
  const { candidatePath, sidecarPath, subtitlePaths } = stopped.result;
  assert.equal(subtitlePaths.length, 1);
  const originalMkv = await readFile(candidatePath);
  assert(originalMkv.length > 0);
  assert.match(await readFile(subtitlePaths[0], 'utf8'), /Synthetic subtitle/);
  for (const filename of [candidatePath, sidecarPath, ...subtitlePaths]) {
    assert.equal((await post('/api/reveal', { path: filename })).status, 200);
  }

  await app.close();
  app = await startServer(options);
  session = await get('/api/bootstrap');
  const restored = session.recentJobs.find(job => job.id === id);
  assert.equal(restored.status, 'cancelled');
  assert.equal(restored.result.candidatePath, candidatePath);
  assert.deepEqual(restored.result.subtitlePaths, subtitlePaths);
  assert.equal((await post('/api/reveal', { path: subtitlePaths[0] })).status, 200);
  const retry = await post(`/api/jobs/${id}/compatible`, {});
  assert.equal(retry.status, 202);
  const completed = await waitForJob(retry.data.id, job => job.status === 'completed');
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
  assert((await stat(completed.result.compatiblePath)).size > 0);
  assert.deepEqual(await readFile(candidatePath), originalMkv);
});

test('resume and terminal history retain only bounded naming/subtitle settings without replayable source credentials', () => {
  const base={id:'new-settings',sourceKey:'a'.repeat(64),sourceLabel:'电影.mkv',params:{start:1,end:3,handles:0,fetchStart:1,fetchEnd:3,outputDir:path.resolve('/tmp/output'),budgetBytes:1048576,clipName:'电影_00-00-01_00-00-03',subtitleStreamIndex:2}};
  const saved=resumeTaskRecord(base); assert.equal(saved.params.clipName,base.params.clipName); assert.equal(saved.params.subtitleStreamIndex,2);
  for(const bad of [{clipName:'../private'},{clipName:{}},{subtitleStreamIndex:-1},{subtitleStreamIndex:'2'}]) assert.throws(()=>resumeTaskRecord({...base,params:{...base.params,...bad}}));
  const record=historyRecord({...base,status:'completed',result:{candidatePath:'/tmp/电影.mkv',subtitlePaths:['/tmp/电影.srt','https://private.invalid/caption'],subtitleResults:[{path:'/tmp/电影.srt',format:'srt',language:'zho',kind:'text',url:'https://private.invalid/token'}]}});
  assert.equal(record.clipName,base.params.clipName); assert.deepEqual(record.result.subtitlePaths,['/tmp/电影.srt']);
  assert(!JSON.stringify(record).includes('private.invalid'));
});
