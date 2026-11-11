import path from 'node:path';
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { ROOT, copyApplication, hashFile, run, writeManifest } from './build-common.mjs';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build this preview on an Apple Silicon Mac.');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+-preview\.\d+$/.test(pkg.version)) throw new Error('A preview version is required.');
await import('./build-browser-helper.mjs');
const baseline = path.join(ROOT, 'dist/片段取材-mac-arm64.app');
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', baseline]);
const binaries = {};
for (const name of ['node', 'ffmpeg', 'ffprobe']) binaries[name] = await hashFile(path.join(baseline, 'Contents/Resources/app/bin', name));
const release = path.join(ROOT, 'dist', pkg.version); await mkdir(release);
const application = path.join(release, '片段取材-浏览器直连预览-mac-arm64.app');
await cp(baseline, application, { recursive: true });
const resources = path.join(application, 'Contents/Resources');
await copyApplication(path.join(resources, 'app'));
await writeFile(path.join(resources, 'app/desktop-config.json'), JSON.stringify({ dataProfile: 'ClipFetcher-BrowserPreview' }) + '\n');
for (const [name, digest] of Object.entries(binaries)) if (await hashFile(path.join(resources, 'app/bin', name)) !== digest) throw new Error('Bundled runtime changed');
const numeric = pkg.version.split('-')[0];
let info = (await readFile(path.join(ROOT, 'desktop/macos/Info.plist'), 'utf8')).replaceAll('__VERSION__', numeric);
info = info.replace('io.clipfetcher.desktop</string>', 'io.clipfetcher.desktop.browser-preview</string>')
  .replace('<key>CFBundleDisplayName</key><string>片段取材</string>', '<key>CFBundleDisplayName</key><string>片段取材·浏览器直连预览</string>');
await writeFile(path.join(application, 'Contents/Info.plist'), info);
await cp(path.join(ROOT, '浏览器直连预览使用与验收.md'), path.join(resources, '浏览器直连预览说明.md'));
await writeManifest(resources, { name: pkg.name, version: pkg.version, target: 'darwin-arm64',
  signing: 'ad-hoc-local-test-only', notarized: false, containsUserData: false,
  baselineVersion: '0.3.13', runtimeReusedWithoutModification: binaries,
  dataProfile: 'ClipFetcher-BrowserPreview', realCloudDownloadVerified: false, realCloudSpeedVerified: false });
await run('/usr/bin/codesign', ['--force', '--sign', '-', application]);
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
const archive = path.join(release, `片段取材-${pkg.version}-mac-arm64-浏览器直连预览.zip`);
await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', application, archive]);
await writeFile(archive + '.sha256', `${await hashFile(archive)}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({ application, archive, version: pkg.version, runtimeChanged: false, realCloudSpeedVerified: false }));
