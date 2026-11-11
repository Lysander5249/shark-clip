import path from 'node:path';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { ROOT, copyApplication, hashFile, run, writeManifest } from './build-common.mjs';
import { markZipNamesUtf8 } from './zip-utf8.mjs';

const version = '0.3.24-preview.1';
const baselineVersion = '0.3.23-preview.1';
const dataProfile = 'ClipFetcher-BookmarkPreview';
const guide = '队列与历史使用说明.md';

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on an Apple Silicon Mac.');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
if (pkg.version !== version) throw new Error(`The source must be version ${version}.`);

const baseline = path.join(ROOT, 'dist', baselineVersion, '片段取材-顺序取材预览-mac-arm64.app');
const baselineCode = path.join(baseline, 'Contents/Resources/app');
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', baseline]);
const baselinePkg = JSON.parse(await readFile(path.join(baselineCode, 'package.json'), 'utf8'));
const baselineConfig = JSON.parse(await readFile(path.join(baselineCode, 'desktop-config.json'), 'utf8'));
if (baselinePkg.version !== baselineVersion || baselineConfig.dataProfile !== dataProfile) {
  throw new Error('The baseline app version or data profile does not match this release.');
}
await readFile(path.join(ROOT, guide));

// Creating a fresh version directory protects sealed releases and prior builds.
const release = path.join(ROOT, 'dist', version);
await mkdir(release);
const application = path.join(release, '片段取材-队列与历史预览-mac-arm64.app');
await cp(baseline, application, { recursive: true });
const resources = path.join(application, 'Contents/Resources');
const code = path.join(resources, 'app');
await copyApplication(code);
await rm(path.join(code, 'public/browser-helper.zip'), { force: true });

const unchanged = [
  'desktop-config.json',
  'desktop/main.mjs',
  'desktop/native-dialogs.mjs',
  'desktop/single-instance.mjs',
  'src/engine.mjs',
  'src/direct-stream.mjs',
  'src/direct-stream-telemetry.mjs',
  'src/remote.mjs',
  'src/process-watchdog.mjs',
  'src/subtitles.mjs',
  'src/output-directory.mjs',
  'src/bookmark-capture.mjs',
  'bookmark-capture/capture.js',
  'public/bookmark-capture-view.mjs',
  'public/bookmark-install.html',
  'public/bookmark-install.js',
  'public/bookmark-receive.html',
  'public/bookmark-receive.js',
];
async function verifyUnchanged(relativePath) {
  const [packaged, previous] = await Promise.all([
    hashFile(path.join(code, relativePath)),
    hashFile(path.join(baselineCode, relativePath)),
  ]);
  if (packaged !== previous) throw new Error(`Unexpected difference from ${baselineVersion}: ${relativePath}`);
  return packaged;
}
await Promise.all(unchanged.map(verifyUnchanged));
const mediaRuntimeHashes = {};
for (const name of ['node', 'ffmpeg', 'ffprobe']) mediaRuntimeHashes[name] = await verifyUnchanged(`bin/${name}`);

const infoPath = path.join(application, 'Contents/Info.plist');
const info = await readFile(infoPath, 'utf8');
const previousBuild = baselineVersion.split('-')[0];
const currentBuild = version.split('-')[0];
const previousTitle = '片段取材·顺序取材预览</string>';
if (!info.includes(`<string>${previousBuild}</string>`) || !info.includes(previousTitle)) {
  throw new Error('The baseline Info.plist has unexpected version or display name fields.');
}
await writeFile(infoPath, info
  .replaceAll(`<string>${previousBuild}</string>`, `<string>${currentBuild}</string>`)
  .replace(previousTitle, '片段取材·队列与历史预览</string>'));
await cp(path.join(ROOT, guide), path.join(resources, guide));
await writeManifest(resources, {
  name: pkg.name,
  version,
  target: 'darwin-arm64',
  signing: 'ad-hoc-local-test-only',
  notarized: false,
  containsUserData: false,
  dataProfile,
  bookmarkConfigurationIncluded: false,
  mediaRuntimeHashes,
  runtimeReusedFrom: baselineVersion,
  activeExtractionLimit: 1,
  maxBatchItems: 10,
  atomicBatchAdmission: true,
  defaultHandlesSeconds: 5,
  terminalHistoryDeletionKeepsExports: true,
  passiveDirectStreamDiagnostics: true,
  remoteTimeoutPolicyUnchanged: true,
  realCloudTestedThisRelease: false,
  windowsVerified: false,
});

await run('/usr/bin/codesign', ['--force', '--sign', '-', application]);
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
const archive = path.join(release, `片段取材-${version}-mac-arm64-队列与历史.zip`);
await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', application, archive]);
await writeFile(archive, markZipNamesUtf8(await readFile(archive)));
const archiveSha256 = await hashFile(archive);
await writeFile(`${archive}.sha256`, `${archiveSha256}  ${path.basename(archive)}\n`);
console.log(JSON.stringify({ version, application, archive, archiveSha256, baseline: baselineVersion,
  dataProfile, mediaRuntimeHashes, unchanged }));
