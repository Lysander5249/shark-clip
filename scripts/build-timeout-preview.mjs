import path from 'node:path';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { ROOT, copyApplication, hashFile, run, writeManifest } from './build-common.mjs';
import { markZipNamesUtf8 } from './zip-utf8.mjs';
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on Apple Silicon.');
const pkg=JSON.parse(await readFile(path.join(ROOT,'package.json'),'utf8'));
if(!/^\d+\.\d+\.\d+-preview\.\d+$/.test(pkg.version))throw new Error('Independent preview version required.');
const baseline=path.join(ROOT,'dist/0.3.18-preview.2/片段取材-命名字幕预览-mac-arm64.app');
await run('/usr/bin/codesign',['--verify','--deep','--strict',baseline]);
const release=path.join(ROOT,'dist',pkg.version);await mkdir(release);
const application=path.join(release,'片段取材-超时修复预览-mac-arm64.app');
await cp(baseline,application,{recursive:true});
const resources=path.join(application,'Contents/Resources');
await copyApplication(path.join(resources,'app'));
await rm(path.join(resources,'app/public/browser-helper.zip'),{force:true});
const hashes={};for(const name of ['node','ffmpeg','ffprobe']){
 const previous=await hashFile(path.join(baseline,'Contents/Resources/app/bin',name));
 const current=await hashFile(path.join(resources,'app/bin',name));
 if(previous!==current)throw new Error('Media runtime changed: '+name);hashes[name]=current;
}
for(const name of ['src/direct-stream.mjs','public/app.js','public/index.html','public/clip-options.mjs','src/subtitles.mjs','bookmark-capture/capture.js'])
 if(await hashFile(path.join(resources,'app',name))!==await hashFile(path.join(baseline,'Contents/Resources/app',name)))throw new Error('Unrelated extraction or UI change: '+name);
let info=await readFile(path.join(application,'Contents/Info.plist'),'utf8');
info=info.replaceAll('0.3.18',pkg.version.split('-')[0]).replace('片段取材·命名字幕预览</string>','片段取材·超时修复预览</string>');
await writeFile(path.join(application,'Contents/Info.plist'),info);
await cp(path.join(ROOT,'超时修复使用说明.md'),path.join(resources,'超时修复使用说明.md'));
await writeManifest(resources,{name:pkg.name,version:pkg.version,target:'darwin-arm64',signing:'ad-hoc-local-test-only',notarized:false,containsUserData:false,dataProfile:'ClipFetcher-BookmarkPreview',bookmarkConfigurationIncluded:false,mediaRuntimeHashes:hashes,mediaRuntimeReusedFrom:'0.3.18-preview.2',remoteExtraction:{fixed15MinuteDeadlineRemoved:true,stallTimeoutSeconds:120,safetyDeadlineSeconds:7200},realCloudTimeoutFixVerified:false});
await run('/usr/bin/codesign',['--force','--sign','-',application]);await run('/usr/bin/codesign',['--verify','--deep','--strict',application]);
const archive=path.join(release,`片段取材-${pkg.version}-mac-arm64-超时修复.zip`);
await run('/usr/bin/ditto',['-c','-k','--keepParent','--norsrc',application,archive]);
await writeFile(archive,markZipNamesUtf8(await readFile(archive)));
await writeFile(archive+'.sha256',`${await hashFile(archive)}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({version:pkg.version,application,archive,mediaRuntimeUnchanged:true,realCloudTimeoutFixVerified:false}));
