import path from 'node:path';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { ROOT, copyApplication, hashFile, run, writeManifest } from './build-common.mjs';
import { markZipNamesUtf8 } from './zip-utf8.mjs';
if(process.platform!=='darwin'||process.arch!=='arm64')throw new Error('Build on Apple Silicon.');
const pkg=JSON.parse(await readFile(path.join(ROOT,'package.json'),'utf8'));
if(pkg.version!=='0.3.23-preview.1')throw new Error('Independent sequential queue preview version required.');
const baseline=path.join(ROOT,'dist/0.3.21-preview.1/片段取材-抓链与文件夹命名预览-mac-arm64.app');
await run('/usr/bin/codesign',['--verify','--deep','--strict',baseline]);
const release=path.join(ROOT,'dist',pkg.version);await mkdir(release);
const application=path.join(release,'片段取材-顺序取材预览-mac-arm64.app');
await cp(baseline,application,{recursive:true});
const resources=path.join(application,'Contents/Resources'),code=path.join(resources,'app');
await copyApplication(code);await rm(path.join(code,'public/browser-helper.zip'),{force:true});
for(const n of ['src/job-scheduler.mjs','public/parallel-tasks.mjs']){
 try{await readFile(path.join(code,n));throw new Error('Parallel-only file entered sequential release: '+n)}catch(e){if(e.code!=='ENOENT')throw e}
}
const hashes={};for(const n of ['node','ffmpeg','ffprobe']){
 hashes[n]=await hashFile(path.join(code,'bin',n));if(hashes[n]!==await hashFile(path.join(baseline,'Contents/Resources/app/bin',n)))throw new Error('Runtime changed: '+n);
}
const unchanged=['src/engine.mjs','src/process-watchdog.mjs','src/subtitles.mjs','src/output-directory.mjs','src/remote.mjs','bookmark-capture/capture.js','public/bookmark-capture-view.mjs'];
for(const n of unchanged)if(await hashFile(path.join(code,n))!==await hashFile(path.join(baseline,'Contents/Resources/app',n)))throw new Error('Unrelated engine or capture change: '+n);
const infoPath=path.join(application,'Contents/Info.plist');
await writeFile(infoPath,(await readFile(infoPath,'utf8')).replaceAll('0.3.21','0.3.23').replace('片段取材·抓链与文件夹命名预览</string>','片段取材·顺序取材预览</string>'));
await cp(path.join(ROOT,'顺序取材使用说明.md'),path.join(resources,'顺序取材使用说明.md'));
await writeManifest(resources,{name:pkg.name,version:pkg.version,target:'darwin-arm64',signing:'ad-hoc-local-test-only',notarized:false,containsUserData:false,dataProfile:'ClipFetcher-BookmarkPreview',bookmarkConfigurationIncluded:false,mediaRuntimeHashes:hashes,runtimeReusedFrom:'0.3.21-preview.1',activeExtractionLimit:1,maxBatchItems:10,atomicBatchAdmission:true,passiveDirectStreamDiagnostics:true,remoteTimeoutPolicyUnchanged:true,realCloudTestedThisRelease:false,windowsVerified:false});
await run('/usr/bin/codesign',['--force','--sign','-',application]);await run('/usr/bin/codesign',['--verify','--deep','--strict',application]);
const archive=path.join(release,`片段取材-${pkg.version}-mac-arm64-顺序取材.zip`);
await run('/usr/bin/ditto',['-c','-k','--keepParent','--norsrc',application,archive]);
await writeFile(archive,markZipNamesUtf8(await readFile(archive)));await writeFile(archive+'.sha256',`${await hashFile(archive)}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({version:pkg.version,application,archive,baseline:'0.3.21-preview.1',singleActiveJob:true,unchanged,mediaRuntimeUnchanged:true,realCloudTested:false}));
