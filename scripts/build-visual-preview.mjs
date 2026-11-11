import path from 'node:path';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { ROOT, copyApplication, exists, hashFile, run, writeManifest } from './build-common.mjs';
import { markZipNamesUtf8 } from './zip-utf8.mjs';

const version = '0.3.30-preview.1';
const baselineVersion = '0.3.29-preview.1';
const dataProfile = 'ClipFetcher-BookmarkPreview';
const iconName = 'Shark.icns';

async function verifyMatch(relativePath, destination, original) {
  const [packaged, previous] = await Promise.all([
    hashFile(path.join(destination, relativePath)),
    hashFile(path.join(original, relativePath)),
  ]);
  if (packaged !== previous) throw new Error(`Unexpected packaged difference: ${relativePath}`);
  return packaged;
}

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on an Apple Silicon Mac.');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
if (pkg.version !== version) throw new Error(`The source must be version ${version}.`);

const baseline = path.join(ROOT, 'dist', baselineVersion, 'Shark-网盘兼容预览-mac-arm64.app');
const baselineCode = path.join(baseline, 'Contents/Resources/app');
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', baseline]);
const baselinePkg = JSON.parse(await readFile(path.join(baselineCode, 'package.json'), 'utf8'));
const baselineConfig = JSON.parse(await readFile(path.join(baselineCode, 'desktop-config.json'), 'utf8'));
if (baselinePkg.version !== baselineVersion || baselineConfig.dataProfile !== dataProfile || baselineConfig.edition) {
  throw new Error('The baseline app version or Mac data profile does not match this release.');
}

let info = await readFile(path.join(baseline, 'Contents/Info.plist'), 'utf8');
const previousBuild = baselineVersion.split('-')[0];
const currentBuild = version.split('-')[0];
if (!info.includes('<key>CFBundleDisplayName</key><string>Shark</string>')
    || !info.includes(`<key>CFBundleIconFile</key><string>${iconName}</string>`)) {
  throw new Error('The baseline Info.plist has unexpected display name or icon fields.');
}
for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
  const field = `<key>${key}</key><string>${previousBuild}</string>`;
  if (!info.includes(field)) throw new Error(`Unexpected baseline version in ${key}.`);
  info = info.replace(field, `<key>${key}</key><string>${currentBuild}</string>`);
}

const baselineBuild = JSON.parse(await readFile(path.join(baseline, 'Contents/Resources/BUILD-INFO.json'), 'utf8'));
const nativeLauncherSourceSha256 = await hashFile(path.join(ROOT, 'desktop/macos/Launcher.swift'));
if (nativeLauncherSourceSha256 !== baselineBuild.nativeLauncherSourceSha256) {
  throw new Error('The native launcher source differs from the baseline executable.');
}

const release = path.join(ROOT, 'dist', version);
if (await exists(release)) throw new Error(`Release already exists: ${release}`);
const staging = await mkdtemp(path.join(ROOT, 'dist', '.shark-build-'));
const appName = 'Shark-图标预览-mac-arm64.app';
const archiveName = `Shark-${version}-mac-arm64.zip`;

try {
  // Reuse the baseline launcher and media runtime. Generate the new icon
  // and re-sign the bundle in staging before making the release available.
  const prepared = path.join(staging, 'release');
  await mkdir(prepared);
  const application = path.join(prepared, appName);
  await cp(baseline, application, { recursive: true, filter: source => source !== baselineCode });
  const resources = path.join(application, 'Contents/Resources');
  const code = path.join(resources, 'app');
  await copyApplication(code);
  await rm(path.join(code, 'public/browser-helper.zip'), { force: true });
  await cp(path.join(baselineCode, 'desktop-config.json'), path.join(code, 'desktop-config.json'));
  await cp(path.join(baselineCode, 'bin'), path.join(code, 'bin'), { recursive: true });

  const unchanged = [
    'desktop-config.json',
    'desktop/native-dialogs.mjs',
    'src/engine.mjs',
    'src/direct-stream.mjs',
    'src/direct-stream-telemetry.mjs',
    'src/remote.mjs',
    'src/process-watchdog.mjs',
    'src/subtitles.mjs',
    'src/output-directory.mjs',
  ];
  await Promise.all(unchanged.map(relative => verifyMatch(relative, code, baselineCode)));
  await verifyMatch('bookmark-capture/capture.js', code, ROOT);
  await verifyMatch('desktop/windows-integration.mjs', code, ROOT);
  const mediaRuntimeHashes = {};
  for (const name of ['node', 'ffmpeg', 'ffprobe']) {
    mediaRuntimeHashes[name] = await verifyMatch(`bin/${name}`, code, baselineCode);
  }
  await verifyMatch('Contents/MacOS/ClipFetcher', application, baseline);
  const iconPath = path.join(resources, iconName);
  await run('/usr/bin/xcrun', ['swift', '-module-cache-path', path.join(staging, 'swift-module-cache'),
    path.join(ROOT, 'scripts/visual-preview-icon.swift'), iconPath]);
  const iconSha256 = await hashFile(iconPath);
  await writeFile(path.join(application, 'Contents/Info.plist'), info);
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
    nativeLauncherReusedFrom: baselineVersion,
    nativeLauncherSourceSha256,
    iconSha256,
    displayName: 'Shark',
    monochromeWorkbenchPreview: true,
    activeExtractionLimit: 1,
    maxBatchItems: 10,
    atomicBatchAdmission: true,
    defaultHandlesSeconds: 5,
    terminalHistoryDeletionKeepsExports: true,
    terminalHistoryBulkDeletion: true,
    mediaDetailsOpenAfterCheck: true,
    failedHistoryRetry: true,
    passiveDirectStreamDiagnostics: true,
    remoteTimeoutPolicyUnchanged: true,
    baiduBookmarkValidation: { target: 'mac-chrome', fixture: 'synthetic', realAccount: false },
    realCloudTestedThisRelease: false,
  });

  await run('/usr/bin/codesign', ['--force', '--sign', '-', application]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
  const archive = path.join(prepared, archiveName);
  await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', application, archive]);
  await writeFile(archive, markZipNamesUtf8(await readFile(archive)));
  const archiveSha256 = await hashFile(archive);
  await writeFile(`${archive}.sha256`, `${archiveSha256}  ${path.basename(archive)}\n`);
  await rename(prepared, release);
  console.log(JSON.stringify({ version, application: path.join(release, appName), archive: path.join(release, archiveName),
    archiveSha256, baseline: baselineVersion, dataProfile, mediaRuntimeHashes, nativeLauncherSourceSha256, iconSha256, unchanged }));
} finally {
  await rm(staging, { recursive: true, force: true });
}
