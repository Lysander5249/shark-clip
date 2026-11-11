import path from 'node:path';
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { ROOT, DIST, copyApplication, exists, hashFile, run, writeManifest } from './build-common.mjs';
import { markZipNamesUtf8 } from './zip-utf8.mjs';

const version = '0.3.31-preview.1';
const baselineVersion = '0.3.30-preview.1';
const dataProfile = 'ClipFetcher-BookmarkPreview';
const baseline = path.join(ROOT, 'dist', baselineVersion, 'Shark-图标预览-mac-arm64.app');
const baselineResources = path.join(baseline, 'Contents/Resources');
const baselineCode = path.join(baselineResources, 'app');
const release = path.join(DIST, version);
const appName = 'Shark-任务状态预览-mac-arm64.app';
const archiveName = `Shark-${version}-mac-arm64.zip`;

if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Build on an Apple Silicon Mac.');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
if (pkg.version !== version) throw new Error(`The source must be version ${version}.`);
if (await exists(release)) throw new Error(`Release already exists: ${release}`);
await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', baseline]);

const baselinePkg = JSON.parse(await readFile(path.join(baselineCode, 'package.json'), 'utf8'));
const baselineConfig = JSON.parse(await readFile(path.join(baselineCode, 'desktop-config.json'), 'utf8'));
const baselineBuild = JSON.parse(await readFile(path.join(baselineResources, 'BUILD-INFO.json'), 'utf8'));
if (baselinePkg.version !== baselineVersion || baselineBuild.version !== baselineVersion || baselineConfig.dataProfile !== dataProfile || baselineConfig.edition) {
  throw new Error('Unexpected baseline version or data profile.');
}
const nativeLauncherSourceSha256 = await hashFile(path.join(ROOT, 'desktop/macos/Launcher.swift'));
if (nativeLauncherSourceSha256 !== baselineBuild.nativeLauncherSourceSha256) {
  throw new Error('The launcher source differs from the baseline executable.');
}
const unchanged = [
  'desktop-config.json',
  'desktop/main.mjs',
  'desktop/native-dialogs.mjs',
  'desktop/single-instance.mjs',
  'desktop/windows-integration.mjs',
  'bin/node',
  'bin/ffmpeg',
  'bin/ffprobe',
];

await mkdir(DIST, { recursive: true });
const staging = await mkdtemp(path.join(DIST, '.shark-task-status-'));
try {
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

  await Promise.all(unchanged.map(async relative => {
    if (await hashFile(path.join(code, relative)) !== await hashFile(path.join(baselineCode, relative))) {
      throw new Error(`Unexpected packaged difference: ${relative}`);
    }
  }));
  const launcher = 'Contents/MacOS/ClipFetcher';
  if (await hashFile(path.join(application, launcher)) !== await hashFile(path.join(baseline, launcher))) {
    throw new Error('The packaged native launcher differs from the baseline.');
  }
  const iconSha256 = await hashFile(path.join(resources, 'Shark.icns'));
  if (iconSha256 !== baselineBuild.iconSha256) throw new Error('The packaged Shark icon differs from the baseline.');

  const plist = path.join(application, 'Contents/Info.plist');
  for (const key of ['CFBundleShortVersionString', 'CFBundleVersion']) {
    await run('/usr/bin/plutil', ['-replace', key, '-string', version.split('-')[0], plist]);
  }
  const { builtAt, buildHost, ...baselineDetails } = baselineBuild;
  await writeManifest(resources, {
    ...baselineDetails,
    version,
    runtimeReusedFrom: baselineVersion,
    nativeLauncherReusedFrom: baselineVersion,
    realCloudTestedThisRelease: false,
  });

  await run('/usr/bin/codesign', ['--force', '--sign', '-', application]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);
  const archive = path.join(prepared, archiveName);
  await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', application, archive]);
  await writeFile(archive, markZipNamesUtf8(await readFile(archive)));
  const archiveSha256 = await hashFile(archive);
  await writeFile(`${archive}.sha256`, `${archiveSha256}  ${archiveName}\n`);
  await rename(prepared, release);
  console.log(JSON.stringify({ version, application: path.join(release, appName), archive: path.join(release, archiveName),
    archiveSha256, baseline: baselineVersion, dataProfile, nativeLauncherSourceSha256, iconSha256, unchanged }));
} finally {
  await rm(staging, { recursive: true, force: true });
}
