import path from 'node:path';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { ROOT, copyApplication, hashFile, run, writeManifest } from './build-common.mjs';
import { markZipNamesUtf8 } from './zip-utf8.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on Apple Silicon.');
const stage = process.argv[2];
if (!['bookmark', 'folders'].includes(stage)) throw new Error('Use bookmark or folders.');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const expected = stage === 'bookmark' ? '0.3.20-preview.1' : '0.3.21-preview.1';
if (pkg.version !== expected) throw new Error(`Expected independent release ${expected}`);
const baseline = path.join(ROOT, 'dist/0.3.19-preview.1/片段取材-超时修复预览-mac-arm64.app');
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', baseline]);
const release = path.join(ROOT, 'dist', pkg.version);
await mkdir(release); // Intentionally refuse to overwrite any existing release.
const label = stage === 'bookmark' ? '抓链体验' : '抓链与文件夹命名';
const application = path.join(release, `片段取材-${label}预览-mac-arm64.app`);
await cp(baseline, application, { recursive: true });
const resources = path.join(application, 'Contents/Resources');
const code = path.join(resources, 'app');
await copyApplication(code);
await rm(path.join(code, 'public/browser-helper.zip'), { force: true });
const hashes = {};
for (const name of ['node', 'ffmpeg', 'ffprobe']) {
  hashes[name] = await hashFile(path.join(code, 'bin', name));
  if (hashes[name] !== await hashFile(path.join(baseline, 'Contents/Resources/app/bin', name))) throw new Error('Runtime changed: ' + name);
}
const unchanged = ['server.mjs', 'src/direct-stream.mjs', 'src/process-watchdog.mjs', 'src/subtitles.mjs', 'public/app.js'];
if (stage === 'bookmark') unchanged.push('src/engine.mjs');
for (const name of unchanged) {
  if (await hashFile(path.join(code, name)) !== await hashFile(path.join(baseline, 'Contents/Resources/app', name))) throw new Error('Unrelated download change: ' + name);
}
const infoPath = path.join(application, 'Contents/Info.plist');
const info = (await readFile(infoPath, 'utf8')).replaceAll('0.3.19', pkg.version.split('-')[0]).replace('片段取材·超时修复预览</string>', `片段取材·${label}预览</string>`);
await writeFile(infoPath, info);
await cp(path.join(ROOT, '交互优化使用说明.md'), path.join(resources, '交互优化使用说明.md'));
await writeManifest(resources, {
  name: pkg.name, version: pkg.version, target: 'darwin-arm64', stage,
  signing: 'ad-hoc-local-test-only', notarized: false, containsUserData: false,
  dataProfile: 'ClipFetcher-BookmarkPreview', bookmarkConfigurationIncluded: false,
  mediaRuntimeHashes: hashes, runtimeReusedFrom: '0.3.19-preview.1',
  remoteTimeoutPolicyUnchanged: true, downloadStrategyUnchanged: true,
  manualCaptureDismissal: true, bookmarkScriptUpdateOnceRequired: true,
  namedOutputDirectory: stage === 'folders', concurrencyAdded: false,
  realCloudTested: false, windowsVerified: false,
});
await run('/usr/bin/codesign', ['--force', '--sign', '-', application]);
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
const archive = path.join(release, `片段取材-${pkg.version}-mac-arm64-${label}.zip`);
await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', application, archive]);
await writeFile(archive, markZipNamesUtf8(await readFile(archive)));
await writeFile(archive + '.sha256', `${await hashFile(archive)}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({ version: pkg.version, application, archive, stage, unchanged, mediaRuntimeUnchanged: true, realCloudTested: false }));
