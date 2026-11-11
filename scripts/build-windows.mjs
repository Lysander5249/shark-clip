import path from 'node:path';
import os from 'node:os';
import { cp, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { ROOT, BUILD, DIST, NODE_VERSION, FFMPEG_ARCHIVE, FFMPEG_SHA256, FFMPEG_VERSION, download,
  copyApplication, copyLicenses, writeManifest, hashFile, exists, run } from './build-common.mjs';
import { releaseArchitecture } from './release-targets.mjs';
import { markZipNamesUtf8 } from './zip-utf8.mjs';

const arch = releaseArchitecture('win32', process.argv.slice(2));
const onWindows = process.platform === 'win32';
if (!onWindows && process.platform !== 'darwin') throw new Error('Build on Windows or macOS. See desktop/README.md.');
const build = onWindows ? BUILD : path.resolve(process.env.CLIP_FETCHER_BUILD_DIR || path.join(ROOT, 'work/windows-build'));
const tar = onWindows ? 'tar.exe' : '/usr/bin/tar';
if (NODE_VERSION !== '24.22.0') throw new Error('Update the pinned official Windows Node checksums for the new runtime.');
const nodeArchiveName = `node-v${NODE_VERSION}-win-${arch}.zip`;
const nodeArchiveSha256 = 'f9683a19877e12a9b167305c8db71040d812876359de21f0d2e97c3f321f80c3';
const nodeExeSha256 = 'ba93f9a70bd86fce3ebbb39ec758501458453467aa92a34a0a3602d1e3fc2b9c';
const dataProfile = 'ClipFetcher-BookmarkPreview';
const edition = 'windows-edge-cloud';
const ffmpeg = path.join(build, `ffmpeg/win-${arch}`);
const mediaNames = ['ffmpeg.exe', 'ffprobe.exe'];
const toolchainName = 'llvm-mingw-20261104-ucrt-macos-universal';
const toolchainSha256 = '66cbd5178c4a71b0d473e68ede172f8eb7d15d023e67f39201d0a69e21f6bf3c';
const launcherSource = path.join(ROOT, 'desktop/windows');

const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const name = `Shark-${pkg.version}-windows-x64-Edge-迅雷-百度`;
const directory = path.join(DIST, name);
const archive = `${directory}.zip`;
const checksum = `${archive}.sha256`;
for (const output of [directory, archive, checksum]) {
  if (await exists(output)) throw new Error(`Release already exists: ${output}. Use a new CLIP_FETCHER_DIST_DIR.`);
}

async function verifyWindowsX64(filename) {
  const file = await open(filename, 'r');
  try {
    const dos = Buffer.alloc(64);
    if ((await file.read(dos, 0, dos.length, 0)).bytesRead !== dos.length || dos.readUInt16LE(0) !== 0x5a4d) {
      throw new Error(`Missing PE DOS header: ${filename}`);
    }
    const header = Buffer.alloc(26);
    if ((await file.read(header, 0, header.length, dos.readUInt32LE(60))).bytesRead !== header.length
        || header.readUInt32LE(0) !== 0x4550 || header.readUInt16LE(4) !== 0x8664
        || header.readUInt16LE(24) !== 0x20b || (header.readUInt16LE(22) & 0x2002) !== 0x0002) {
      throw new Error(`Expected an x64 PE32+ executable: ${filename}`);
    }
  } finally { await file.close(); }
}

function inspectWindowsImports(filename) {
  const report = execFileSync('/usr/bin/objdump', ['-p', filename], { encoding: 'utf8', timeout: 15000 });
  const imports = [...report.matchAll(/DLL Name:\s*(\S+)/g)].map(match => match[1]).sort();
  if (!imports.length || imports.some(dll => /^(?:libgcc|libstdc|libc\+\+|libwinpthread|msys-|libav|libz|zlib|libbz|vcruntime|msvcp)/i.test(dll))) {
    throw new Error(`Unexpected PE import table or non-system runtime dependency: ${filename}`);
  }
  return imports;
}

async function buildLauncher(scratch) {
  let compiler = 'gcc.exe', windres = 'windres.exe';
  const env = { ...process.env };
  if (onWindows) {
    if (env.CLIP_FETCHER_UCRT64_BIN) {
      const bin = path.resolve(env.CLIP_FETCHER_UCRT64_BIN);
      compiler = path.join(bin, compiler);
      windres = path.join(bin, windres);
      const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') || 'PATH';
      env[pathKey] = bin + path.delimiter + (env[pathKey] || '');
    }
  } else {
    const archive = path.join(build, 'downloads', `${toolchainName}.tar.xz`);
    if (await hashFile(archive) !== toolchainSha256) throw new Error('Windows launcher toolchain checksum mismatch.');
    await run(tar, ['-xf', archive, '-C', scratch]);
    const bin = path.join(scratch, toolchainName, 'bin');
    compiler = path.join(bin, 'x86_64-w64-mingw32-clang');
    windres = path.join(bin, 'x86_64-w64-mingw32-windres');
    env.PATH = bin + path.delimiter + (env.PATH || '');
  }
  const output = path.join(scratch, 'Shark.exe');
  const resource = path.join(scratch, 'launcher-res.o');
  const options = { cwd: launcherSource, env };
  await run(windres, ['launcher.rc', '-O', 'coff', '-o', resource], options);
  await run(compiler, ['-Wall', '-Wextra', '-Werror', '-Os', '-s', '-static', 'launcher.c', resource, '-o', output], options);
  await verifyWindowsX64(output);
  return output;
}

for (const executable of mediaNames) {
  if (!await exists(path.join(ffmpeg, 'bin', executable))) {
    const command = onWindows ? 'bash scripts/build-ffmpeg-windows.sh (MSYS2 UCRT64)' : 'bash scripts/build-ffmpeg-windows-cross.sh';
    throw new Error(`Build Windows media tools first: ${command}`);
  }
}
const ffmpegLicenses = path.join(ffmpeg, 'licenses');
const mediaConfig = JSON.parse(await readFile(path.join(ffmpegLicenses, 'build-config.json'), 'utf8'));
if (mediaConfig.target !== 'win-x64' || mediaConfig.version !== FFMPEG_VERSION || mediaConfig.sourceModified !== false
    || mediaConfig.sourceSha256 !== FFMPEG_SHA256 || mediaConfig.license !== 'LGPL-2.1-or-later'
    || await hashFile(path.join(ffmpegLicenses, FFMPEG_ARCHIVE)) !== FFMPEG_SHA256) {
  throw new Error('Windows FFmpeg must come from the pinned unmodified LGPL source.');
}
// The cross-build records its shell command with printf %q.
const configure = (await readFile(path.join(ffmpegLicenses, 'configure-command.txt'), 'utf8')).replaceAll('\\,', ',');
for (const flag of ['--disable-gpl', '--disable-version3', '--disable-nonfree', '--enable-zlib', 'subrip,ass']) {
  if (!configure.includes(flag)) throw new Error(`Required Windows FFmpeg configuration missing: ${flag}`);
}
const mediaRuntimeHashes = {};
const runtimeImports = {};
for (const executable of mediaNames) {
  const file = path.join(ffmpeg, 'bin', executable);
  await verifyWindowsX64(file);
  mediaRuntimeHashes[executable] = await hashFile(file);
  if (onWindows) {
    const license = execFileSync(file, ['-hide_banner', '-L'], { encoding: 'utf8', timeout: 15000 });
    if (!license.includes('Lesser General Public License') || license.includes('nonfree')) {
      throw new Error(`${executable} does not report the expected LGPL license.`);
    }
  } else {
    if (mediaRuntimeHashes[executable] !== mediaConfig.mediaRuntimeHashes?.[executable]) {
      throw new Error(`Cross-built PE does not match its verified build manifest: ${executable}`);
    }
    runtimeImports[executable] = inspectWindowsImports(file);
  }
}

const launcherName = '启动片段取材.cmd';
const guide = await readFile(path.join(launcherSource, '使用说明.md'));
const launcher = (await readFile(path.join(launcherSource, launcherName), 'utf8')).replace(/\r?\n/g, '\r\n');
const nodeArchive = await download(`https://nodejs.org/dist/v${NODE_VERSION}/${nodeArchiveName}`,
  path.join(build, 'downloads', nodeArchiveName), nodeArchiveSha256);
const scratch = await mkdtemp(path.join(os.tmpdir(), 'clip-windows-node-'));

try {
  const nodeRootName = `node-v${NODE_VERSION}-win-${arch}`;
  const nodeRoot = path.join(scratch, nodeRootName);
  await run(tar, ['-xf', nodeArchive, '-C', scratch, `${nodeRootName}/node.exe`, `${nodeRootName}/LICENSE`]);
  const nodeExe = path.join(nodeRoot, 'node.exe');
  await verifyWindowsX64(nodeExe);
  const nodeDigest = await hashFile(nodeExe);
  if (nodeDigest !== nodeExeSha256) throw new Error('Extracted node.exe does not match its official release checksum.');
  if (!onWindows) runtimeImports['node.exe'] = inspectWindowsImports(nodeExe);
  const launcherExe = await buildLauncher(scratch);
  const launcherSha256 = await hashFile(launcherExe);
  if (!onWindows) runtimeImports['Shark.exe'] = inspectWindowsImports(launcherExe);

  // Keep published versions independent. Create this directory only after all
  // runtime checks, and never delete an older package to rebuild it in place.
  await mkdir(DIST, { recursive: true });
  await mkdir(directory);
  const code = path.join(directory, 'app');
  await copyApplication(code);
  await rm(path.join(code, 'public/browser-helper.zip'), { force: true });
  await writeFile(path.join(code, 'desktop-config.json'), JSON.stringify({ dataProfile, edition }) + '\n');
  const bin = path.join(code, 'bin');
  await mkdir(bin);
  await cp(nodeExe, path.join(bin, 'node.exe'));
  for (const executable of mediaNames) await cp(path.join(ffmpeg, 'bin', executable), path.join(bin, executable));
  const node = { license: path.join(nodeRoot, 'LICENSE'), checksum: nodeArchiveSha256 };
  await copyLicenses(path.join(directory, 'Licenses'), node, ffmpeg);
  if (!onWindows) {
    const licenses = path.join(directory, 'Licenses/FFmpeg');
    for (const file of ['zlib-1.4.tar.xz', ...mediaNames.map(name => `${name}.pe.txt`)]) {
      await cp(path.join(ffmpegLicenses, file), path.join(licenses, file));
    }
  }
  await writeFile(path.join(directory, launcherName), launcher);
  await cp(launcherExe, path.join(directory, 'Shark.exe'));
  await writeFile(path.join(directory, '使用说明.md'), guide);
  await writeManifest(directory, { name: pkg.name, version: pkg.version, target: `win-${arch}`, edition, dataProfile,
    signing: 'unsigned-test-build', containsUserData: false, browser: 'edge', cloudProviders: ['xunlei', 'baidu'], launcher: 'Shark.exe', launcherSha256,
    mediaRuntimeHashes: { 'node.exe': nodeDigest, ...mediaRuntimeHashes },
    ...(!onWindows ? { runtimeImports } : {}),
    nodeArchiveSha256, ffmpegSourceSha256: FFMPEG_SHA256, crossCompiled: !onWindows,
    peX64Verified: true, nativeWindowsSmokeVerified: false, realEdgeXunleiVerified: false, realEdgeBaiduVerified: false });

  const zipFlags = onWindows ? [] : ['--no-mac-metadata'];
  await run(tar, ['-a', '-cf', archive, ...zipFlags, '-C', DIST, name]);
  await writeFile(archive, markZipNamesUtf8(await readFile(archive)));
  const archiveSha256 = await hashFile(archive);
  await writeFile(checksum, `${archiveSha256}  ${path.basename(archive)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ version: pkg.version, directory, archive, archiveSha256, launcherSha256, target: `win-${arch}`,
    edition, crossCompiled: !onWindows, peX64Verified: true, nativeWindowsSmokeVerified: false, realEdgeXunleiVerified: false, realEdgeBaiduVerified: false }));
} finally {
  await rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
