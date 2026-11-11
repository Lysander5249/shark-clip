import path from 'node:path';
import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { ROOT, BUILD, DIST, run, prepareNode, copyApplication, copyLicenses, exists, writeManifest, hashFile } from './build-common.mjs';
import { buildFfmpegMac } from './build-ffmpeg-macos.mjs';
import { releaseArchitecture } from './release-targets.mjs';
import { markZipNamesUtf8 } from './zip-utf8.mjs';

const arch = releaseArchitecture('darwin', process.argv.slice(2));
if (process.platform !== 'darwin') throw new Error('Run this build on macOS.');
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const release = path.join(DIST, pkg.version);
if (await exists(release)) throw new Error('Release already exists: ' + release);

const node = await prepareNode('darwin', arch);
const ffmpeg = await buildFfmpegMac({ arch });
await mkdir(DIST, { recursive: true });
const staging = await mkdtemp(path.join(DIST, '.shark-mac-'));
const appName = 'Shark-mac-' + arch + '.app';
const archiveName = 'Shark-' + pkg.version + '-mac-' + arch + '.zip';
const dataProfile = 'ClipFetcher-BookmarkPreview';

try {
  const application = path.join(staging, appName);
  const contents = path.join(application, 'Contents');
  const resources = path.join(contents, 'Resources');
  const code = path.join(resources, 'app');
  const launcherSource = path.join(ROOT, 'desktop/macos/Launcher.swift');
  const iconPath = path.join(resources, 'Shark.icns');
  await mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await copyApplication(code);
  await rm(path.join(code, 'public/browser-helper.zip'), { force: true });
  await writeFile(path.join(code, 'desktop-config.json'), JSON.stringify({ dataProfile }) + '\n');

  const bin = path.join(code, 'bin');
  await mkdir(bin, { recursive: true });
  await cp(node.executable, path.join(bin, 'node'));
  for (const name of ['ffmpeg', 'ffprobe']) await cp(path.join(ffmpeg, 'bin', name), path.join(bin, name));

  const info = (await readFile(path.join(ROOT, 'desktop/macos/Info.plist'), 'utf8')).replaceAll('__VERSION__', pkg.version.split('-')[0]);
  await writeFile(path.join(contents, 'Info.plist'), info);
  await writeFile(path.join(contents, 'PkgInfo'), 'APPL????');
  const moduleCache = path.join(BUILD, 'swift-module-cache');
  await mkdir(moduleCache, { recursive: true });
  await run('/usr/bin/xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', 'arm64-apple-macosx13.0',
    '-module-cache-path', moduleCache, '-framework', 'AppKit', '-framework', 'WebKit',
    launcherSource, '-o', path.join(contents, 'MacOS/ClipFetcher')]);
  await run('/usr/bin/xcrun', ['swift', '-module-cache-path', moduleCache,
    path.join(ROOT, 'scripts/visual-preview-icon.swift'), iconPath]);

  await copyLicenses(path.join(resources, 'Licenses'), node, ffmpeg);
  await cp(path.join(ROOT, 'desktop/同学试用须知.md'), path.join(resources, '同学试用须知.md'));

  // Sign nested executables before the enclosing app. The signatures are ad hoc.
  const mediaRuntimeHashes = {};
  for (const name of ['node', 'ffmpeg', 'ffprobe']) {
    const executable = path.join(bin, name);
    const linked = execFileSync('/usr/bin/otool', ['-L', executable], { encoding: 'utf8' });
    if (linked.includes('/opt/homebrew/') || linked.includes('/usr/local/')) throw new Error('Nonportable dependency in ' + name);
    await chmod(executable, 0o755);
    await run('/usr/bin/codesign', ['--force', '--sign', '-', executable]);
    mediaRuntimeHashes[name] = await hashFile(executable);
  }
  await writeManifest(resources, {
    name: pkg.name, displayName: 'Shark', version: pkg.version, target: 'darwin-' + arch, dataProfile,
    signing: 'ad-hoc-local-test-only', notarized: false, containsUserData: false, bookmarkConfigurationIncluded: false,
    nativeLauncherSourceSha256: await hashFile(launcherSource), iconSha256: await hashFile(iconPath), mediaRuntimeHashes,
  });
  await run('/usr/bin/codesign', ['--force', '--sign', '-', application]);
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', application]);

  const archive = path.join(staging, archiveName);
  await run('/usr/bin/ditto', ['-c', '-k', '--keepParent', '--norsrc', application, archive]);
  await writeFile(archive, markZipNamesUtf8(await readFile(archive)));
  const archiveSha256 = await hashFile(archive);
  await writeFile(archive + '.sha256', archiveSha256 + '  ' + archiveName + '\n');
  await rename(staging, release);
  console.log(JSON.stringify({ version: pkg.version, application: path.join(release, appName),
    archive: path.join(release, archiveName), archiveSha256, dataProfile }));
} finally {
  await rm(staging, { recursive: true, force: true });
}
