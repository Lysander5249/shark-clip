import path from 'node:path';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { ROOT, copyApplication, hashFile, run, writeManifest } from './build-common.mjs';

// Reuse the frozen 0.3.13 runtime and its complete licenses. This preview changes
// only our source; it must never rebuild, replace or download a different runtime.
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build this preview on an Apple Silicon Mac.');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+-preview\.\d+$/.test(pkg.version)) throw new Error('A preview version is required.');
const baseline = path.join(ROOT, 'dist/片段取材-mac-arm64.app');
const baselineInfo = JSON.parse(await readFile(path.join(baseline, 'Contents/Resources/BUILD-INFO.json'), 'utf8'));
if (baselineInfo.version !== '0.3.13' || baselineInfo.target !== 'darwin-arm64') throw new Error('The frozen 0.3.13 Mac baseline is required.');
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', baseline]);

const binaries = {};
for (const name of ['node', 'ffmpeg', 'ffprobe']) {
  const filename = path.join(baseline, 'Contents/Resources/app/bin', name);
  const linked = execFileSync('/usr/bin/otool', ['-L', filename], { encoding: 'utf8' });
  if (linked.includes('/opt/homebrew/') || linked.includes('/usr/local/')) throw new Error(`Nonportable baseline binary: ${name}`);
  binaries[name] = await hashFile(filename);
}
const release = path.join(ROOT, 'dist', pkg.version);
// Refuse an existing release rather than silently overwriting a rollback point.
await mkdir(release);
const application = path.join(release, '片段取材-速度预览-mac-arm64.app');
await cp(baseline, application, { recursive: true });
const resources = path.join(application, 'Contents/Resources');
await copyApplication(path.join(resources, 'app'));
for (const [name, expected] of Object.entries(binaries)) {
  if (await hashFile(path.join(resources, 'app/bin', name)) !== expected) throw new Error(`Runtime changed: ${name}`);
}
const numericVersion = pkg.version.split('-')[0];
const parts = numericVersion.split('.').map(Number);
const buildVersion = `${parts[1]}.${parts[2]}.${Number(pkg.version.split('.').at(-1))}`;
let info = (await readFile(path.join(ROOT, 'desktop/macos/Info.plist'), 'utf8')).replaceAll('__VERSION__', numericVersion);
info = info.replace('<key>CFBundleVersion</key><string>' + numericVersion + '</string>', '<key>CFBundleVersion</key><string>' + buildVersion + '</string>')
  .replace('<key>CFBundleDisplayName</key><string>片段取材</string>', '<key>CFBundleDisplayName</key><string>片段取材·速度预览</string>');
await writeFile(path.join(application, 'Contents/Info.plist'), info);
await cp(path.join(ROOT, '第一轮预览使用与验收.md'), path.join(resources, '速度预览说明.md'));
await writeManifest(resources, { name: pkg.name, version: pkg.version, target: 'darwin-arm64',
  signing: 'ad-hoc-local-test-only', notarized: false, containsUserData: false,
  baselineVersion: '0.3.13', runtimeReusedWithoutModification: binaries,
  realCloudSpeedVerified: false });
await run('/usr/bin/codesign', ['--force', '--sign', '-', application]);
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
const archive = path.join(release, `片段取材-${pkg.version}-mac-arm64-预览.zip`);
await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', application, archive]);
await writeFile(archive + '.sha256', `${await hashFile(archive)}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({ application, archive, version: pkg.version, runtimeChanged: false, cloudSpeedVerified: false }));
