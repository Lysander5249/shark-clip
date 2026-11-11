import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exportCandidate, exportCompatibleMp4 } from '../src/engine.mjs';
import { alignSrt, subtitleExportSpec } from '../src/subtitles.mjs';
const exec = promisify(execFile);
const fixtureFfmpeg = process.env.SUBTITLE_FIXTURE_FFMPEG ?? 'ffmpeg';
const ffmpegPath = process.env.SUBTITLE_TEST_FFMPEG ?? process.env.FFMPEG_PATH ?? 'ffmpeg';
const ffprobePath = process.env.SUBTITLE_TEST_FFPROBE ?? process.env.FFPROBE_PATH ?? 'ffprobe';
const run = (executable,args) => exec(executable,args,{timeout:30000,maxBuffer:2*1024*1024});
const sourceSrt = `1\n00:00:00,500 --> 00:00:02,500\n早于片段\n\n2\n00:00:04,500 --> 00:00:06,500\n跨过截取起点\n\n3\n00:00:07,200 --> 00:00:08,800\n中文与 English 文字\n\n4\n00:00:09,200 --> 00:00:11,000\n跨过截取终点\n`;
const probe = async filename => JSON.parse((await run(ffprobePath,['-v','error','-show_streams','-show_format','-of','json',filename])).stdout);
const packets = async filename => JSON.parse((await run(ffprobePath,['-v','error','-select_streams','v:0','-show_packets','-show_data_hash','sha256','-show_entries','packet=pts_time,data_hash','-of','json',filename])).stdout).packets;
function srtStartFor(text,words) {
  const cue=text.trim().split(/\n\s*\n/).find(block=>block.includes(words));assert.ok(cue,`missing cue ${words}`);
  const m=/(\d+):(\d+):(\d+),(\d+)\s+-->/.exec(cue);assert.ok(m);
  return Number(m[1])*3600+Number(m[2])*60+Number(m[3])+Number(m[4])/1000;
}

test('independent subtitle policies distinguish editable text, PGS, DVD and unsupported formats',()=>{
  assert.equal(subtitleExportSpec('ass').extension,'srt');
  assert.equal(subtitleExportSpec('hdmv_pgs_subtitle').extension,'sup');
  assert.equal(subtitleExportSpec('dvd_subtitle').extension,'mks');
  assert.equal(subtitleExportSpec('unknown'),null);
});

test('SRT alignment uses a measured offset, clips both boundaries and preserves multilingual text',()=>{
  const r=alignSrt('1\r\n00:00:01,000 --> 00:00:03,000\r\n中文\r\n\r\n2\r\n00:00:04,000 --> 00:00:07,000\r\nEnglish\r\n\r\n3\r\n00:00:09,000 --> 00:00:11,000\r\n越界\r\n',{offsetSeconds:-2,durationSeconds:4});
  assert.equal(r.cues,2);assert.match(r.text,/00:00:00,000 --> 00:00:01,000\n中文/);assert.match(r.text,/00:00:02,000 --> 00:00:04,000\nEnglish/);assert.doesNotMatch(r.text,/越界/);
  assert.throws(()=>alignSrt('bad',{durationSeconds:4}),/INVALID_SUBTITLE/);
  assert.throws(()=>alignSrt(sourceSrt,{durationSeconds:NaN}),/INVALID_SUBTITLE/);
});

test('actual target runtime exports clean named video and synchronized independent SRT without a second remote extraction', {timeout:90000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'clip-subtitles-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const srt=path.join(root,'中文.srt'), source=path.join(root,'source.mkv');await fs.writeFile(srt,sourceSrt);
  await run(fixtureFfmpeg,['-hide_banner','-nostdin','-loglevel','error','-n','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=14','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=14','-i',srt,'-map','0:v','-map','1:a','-map','2:s','-c:v','libx264','-preset','ultrafast','-g','48','-keyint_min','48','-sc_threshold','0','-bf','2','-c:a','aac','-c:s','subrip','-metadata:s:s:0','language=zho',source]);
  const bytes=await fs.readFile(source);let requests=0,atSubtitleExport=null;
  const server=http.createServer((req,res)=>{requests++;const m=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');const start=m?Number(m[1]):0,end=m&&m[2]?Math.min(bytes.length-1,Number(m[2])):bytes.length-1;res.writeHead(m?206:200,{'Content-Length':end-start+1,'Accept-Ranges':'bytes',...(m?{'Content-Range':`bytes ${start}-${end}/${bytes.length}`}:{})});res.end(bytes.subarray(start,end+1));});
  const localOnly=process.env.SUBTITLE_LOCAL_ONLY==='1';
  if(!localOnly){await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));}
  else t.diagnostic('Explicit local-only run; HTTP-read assertions are not performed in this run.');
  const common={sourceInput:localOnly?source:`http://127.0.0.1:${server.address().port}/video.mkv`,outputDir:root,start:5.25,end:9.5,ffmpegPath,ffprobePath};
  const clean=await exportCandidate({...common,jobId:'clean'});const cleanRequests=requests;requests=0;
  const named=await exportCandidate({...common,jobId:'named',clipName:'电影_00-00-05_00-00-09',subtitleStreamIndex:2,onProgress(e){if(e.message?.includes('本地保存独立字幕'))atSubtitleExport=requests;}});
  assert.equal(path.basename(path.dirname(named.candidatePath)),'电影_00-00-05_00-00-09');
  assert.equal(path.basename(named.candidatePath),'电影_00-00-05_00-00-09.mkv');assert.equal(path.basename(named.sidecarPath),'电影_00-00-05_00-00-09.json');
  assert.equal(named.subtitlePaths.length,1,JSON.stringify(named.subtitleWarnings));assert.equal(path.extname(named.subtitlePaths[0]),'.srt');
  if(!localOnly){assert.equal(requests,atSubtitleExport,'subtitle and final remux steps must use no further network requests');assert(requests<=cleanRequests+1,`extra source reads: ${requests} vs clean ${cleanRequests}`);}
  const media=await probe(named.candidatePath);assert.equal(media.streams.filter(s=>s.codec_type==='subtitle').length,0);assert.equal(media.streams.find(s=>s.codec_type==='video').codec_name,'h264');
  const resultSrt=await fs.readFile(named.subtitlePaths[0],'utf8');assert.match(resultSrt,/中文与 English/);
  const [srcPackets,outPackets]=await Promise.all([packets(source),packets(named.candidatePath)]);const first=outPackets[0],match=srcPackets.find(p=>p.data_hash===first.data_hash);assert.ok(match);
  const expected=7.2-Number(match.pts_time)+Number(first.pts_time);assert(Math.abs(srtStartFor(resultSrt,'中文与 English')-expected)<=0.005,`SRT must use actual output timeline ${expected}`);
  assert.equal(named.manifest.subtitles.files[0].timeline.status,'verified-local-packet-offset');assert(named.manifest.subtitles.files[0].timeline.verifiedPackets>=2);
  const frameHashes=async filename=>(await run(fixtureFfmpeg,['-v','error','-i',filename,'-map','0:v:0','-an','-sn','-f','framemd5','-'])).stdout.split('\n').filter(l=>l&&!l.startsWith('#')).map(l=>l.split(',').at(-1).trim());
  assert.deepEqual(await frameHashes(named.candidatePath),await frameHashes(clean.candidatePath),'subtitle option must not change the copied image sequence');
  assert(!(await fs.readdir(path.dirname(named.candidatePath))).some(n=>n.includes('.partial')));
  const mp4=await exportCompatibleMp4({candidatePath:named.candidatePath,clipName:'电影_00-00-05_00-00-09',jobId:'derivative',ffmpegPath,ffprobePath});
  assert.equal(path.basename(mp4.outputPath),'电影_00-00-05_00-00-09.mp4');assert.equal(path.basename(mp4.sidecarPath),'电影_00-00-05_00-00-09.mp4.json');assert.equal((await probe(mp4.outputPath)).streams.filter(s=>s.codec_type==='subtitle').length,0);
  await t.test('ASS converts to independent editable SRT while noting lost styles',async()=>{
    const assSource=path.join(root,'ass.mkv');await run(fixtureFfmpeg,['-v','error','-n','-i',source,'-map','0','-c','copy','-c:s','ass',assSource]);
    const r=await exportCandidate({...common,sourceInput:assSource,jobId:'ass',subtitleStreamIndex:2});assert.equal(r.subtitlePaths.length,1,JSON.stringify(r.subtitleWarnings));assert.match(await fs.readFile(r.subtitlePaths[0],'utf8'),/中文与 English/);assert(r.subtitleWarnings.some(w=>w.code==='SUBTITLE_STYLE_SIMPLIFIED'));
  });
  await t.test('a subtitle encoder failure preserves clean video and publishes a clear warning',async()=>{
    const wrapper = path.join(root, 'ffmpeg-without-subrip.mjs');
    await fs.writeFile(wrapper, '#!' + process.execPath + '\n' + `
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[args.indexOf('-c:s') + 1] === 'subrip') process.exit(1);
const result = spawnSync(${JSON.stringify(ffmpegPath)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
    const r = await exportCandidate({ ...common, sourceInput: source, jobId: 'encoder-failure',
      subtitleStreamIndex: 2, ffmpegPath: wrapper });
    assert.equal(r.subtitlePaths.length, 0);
    assert(r.subtitleWarnings.some(w => w.code === 'SUBTITLE_EXPORT_FAILED'));
    assert((await fs.stat(r.candidatePath)).size > 0);
    assert(!(await fs.readdir(path.dirname(r.candidatePath))).some(n => n.includes('.partial')));
  });
  await t.test('unsafe names and nonexistent subtitle tracks cannot escape the task directory',async()=>{
    for(const clipName of ['../escape','a/b','..'])await assert.rejects(exportCandidate({...common,sourceInput:source,jobId:'bad',clipName}),e=>e.code==='INVALID_CLIP_NAME');
    await assert.rejects(exportCandidate({...common,sourceInput:source,jobId:'bad-sub',subtitleStreamIndex:0}),e=>e.code==='INVALID_SUBTITLE_TRACK');
  });
});
