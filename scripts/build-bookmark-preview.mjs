import path from 'node:path';
import { mkdir, readFile, writeFile, cp, rm } from 'node:fs/promises';
import { ROOT, copyApplication, hashFile, run, writeManifest } from './build-common.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build this preview on an Apple Silicon Mac.');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+-preview\.\d+$/.test(pkg.version)) throw new Error('A preview version is required.');
const baseline = path.join(ROOT, 'dist/片段取材-mac-arm64.app');
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', baseline]);
const binaries = {};
for (const name of ['node', 'ffmpeg', 'ffprobe']) binaries[name] = await hashFile(path.join(baseline, 'Contents/Resources/app/bin', name));
const release = path.join(ROOT, 'dist', pkg.version); await mkdir(release);
const application = path.join(release, '片段取材-书签抓链预览-mac-arm64.app');
await cp(baseline, application, { recursive: true });
const resources = path.join(application, 'Contents/Resources');
await copyApplication(path.join(resources, 'app'));
// The old helper remains in its frozen release, not a required preview asset.
await rm(path.join(resources, 'app/public/browser-helper.zip'), { force: true });
await writeFile(path.join(resources, 'app/desktop-config.json'), JSON.stringify({ dataProfile: 'ClipFetcher-BookmarkPreview' }) + '\n');
for (const [name, digest] of Object.entries(binaries)) if (await hashFile(path.join(resources, 'app/bin', name)) !== digest) throw new Error('Bundled media runtime changed');
const cache = path.join(ROOT, 'work/bookmark-native-module-cache'); await mkdir(cache, { recursive: true });
await run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', 'arm64-apple-macosx13.0',
  '-module-cache-path', cache, '-framework', 'AppKit', '-framework', 'WebKit', path.join(ROOT, 'desktop/macos/Launcher.swift'),
  '-o', path.join(application, 'Contents/MacOS/ClipFetcher')]);
const numeric = pkg.version.split('-')[0];
let info = (await readFile(path.join(ROOT, 'desktop/macos/Info.plist'), 'utf8')).replaceAll('__VERSION__', numeric);
info = info.replace('io.clipfetcher.desktop</string>', 'io.clipfetcher.desktop.bookmark-preview</string>')
  .replace('<key>CFBundleDisplayName</key><string>片段取材</string>', '<key>CFBundleDisplayName</key><string>片段取材·书签预览</string>');
await writeFile(path.join(application, 'Contents/Info.plist'), info);
await cp(path.join(ROOT, '书签抓链第一步说明.md'), path.join(resources, '书签抓链说明.md'));
await writeManifest(resources, { name: pkg.name, version: pkg.version, target: 'darwin-arm64',
  signing: 'ad-hoc-local-test-only', notarized: false, containsUserData: false, dataProfile: 'ClipFetcher-BookmarkPreview',
  mediaRuntimeReusedFrom: '0.3.13', mediaRuntimeHashes: binaries, nativeLauncherRecompiledForCaptureFocus: true,
  bookmarkReceiverStateIncluded: false, realCloudDownloadVerified: false, realCloudSpeedVerified: false });
await run('/usr/bin/codesign', ['--force', '--sign', '-', application]);
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
const archive = path.join(release, `片段取材-${pkg.version}-mac-arm64-书签预览.zip`);
await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', application, archive]);
await writeFile(archive + '.sha256', `${await hashFile(archive)}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({ application, archive, version: pkg.version, realCloudSpeedVerified: false }));
