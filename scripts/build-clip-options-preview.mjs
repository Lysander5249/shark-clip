import path from 'node:path';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { ROOT, copyApplication, hashFile, run, writeManifest } from './build-common.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on an Apple Silicon Mac.');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+-preview\.\d+$/.test(pkg.version)) throw new Error('An independent preview version is required.');
const baseline = path.join(ROOT, 'dist/0.3.17-preview.3/片段取材-书签抓链预览-mac-arm64.app');
const media = path.join(ROOT, 'work/subtitle-media-build/ffmpeg/darwin-arm64');
const mediaConfig = JSON.parse(await readFile(path.join(media, 'licenses/build-config.json'), 'utf8'));
if (!mediaConfig.configure.some(value => value.startsWith('--enable-encoder=') && value.includes('subrip') && value.includes('ass')))
  throw new Error('The subtitle runtime must enable verified text subtitle encoders.');
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', baseline]);
const release = path.join(ROOT, 'dist', pkg.version); await mkdir(release);
const application = path.join(release, '片段取材-命名字幕预览-mac-arm64.app');
await cp(baseline, application, { recursive: true });
const resources = path.join(application, 'Contents/Resources');
await copyApplication(path.join(resources, 'app'));
await rm(path.join(resources, 'app/public/browser-helper.zip'), { force: true });
await writeFile(path.join(resources, 'app/desktop-config.json'), JSON.stringify({ dataProfile: 'ClipFetcher-BookmarkPreview' }) + '\n');
for (const name of ['ffmpeg', 'ffprobe']) await cp(path.join(media, 'bin', name), path.join(resources, 'app/bin', name));
await rm(path.join(resources, 'Licenses/FFmpeg'), { recursive: true });
await cp(path.join(media, 'licenses'), path.join(resources, 'Licenses/FFmpeg'), { recursive: true });
const hashes = {};
for (const name of ['node', 'ffmpeg', 'ffprobe']) hashes[name] = await hashFile(path.join(resources, 'app/bin', name));
if (hashes.node !== await hashFile(path.join(baseline, 'Contents/Resources/app/bin/node'))) throw new Error('Node runtime changed unexpectedly');
let info = await readFile(path.join(application, 'Contents/Info.plist'), 'utf8');
info = info.replaceAll('0.3.17', pkg.version.split('-')[0]).replace('片段取材·书签预览</string>', '片段取材·命名字幕预览</string>');
await writeFile(path.join(application, 'Contents/Info.plist'), info);
await cp(path.join(ROOT, '命名与独立字幕使用说明.md'), path.join(resources, '命名与独立字幕使用说明.md'));
await writeManifest(resources, { name: pkg.name, version: pkg.version, target: 'darwin-arm64', signing: 'ad-hoc-local-test-only', notarized: false,
  containsUserData: false, dataProfile: 'ClipFetcher-BookmarkPreview', bookmarkConfigurationIncluded: false,
  mediaRuntimeHashes: hashes, mediaBuildConfig: mediaConfig, nativeLauncherReusedFrom: '0.3.17-preview.3',
  cleanVideoDefaultRetained: true, optionalSeparateSubtitleFiles: true, postDownloadRenameIncluded: false,
  realCloudNamingAndSubtitlesVerified: false, previousDirectStreamSpeedBaseline: '0.3.17-preview.3; same-segment test passed' });
await run('/usr/bin/codesign', ['--force', '--sign', '-', application]);
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
const archive = path.join(release, `片段取材-${pkg.version}-mac-arm64-命名字幕预览.zip`);
await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', application, archive]);
await writeFile(archive + '.sha256', `${await hashFile(archive)}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({ application, archive, version: pkg.version, realCloudNamingAndSubtitlesVerified: false }));
