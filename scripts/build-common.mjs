import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, cp, stat, rm, rename } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { spawn } from 'node:child_process';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BUILD = path.resolve(process.env.CLIP_FETCHER_BUILD_DIR || path.join(ROOT, '../../work/desktop-build'));
// A release can be built beside a running version without replacing its files.
export const DIST = path.resolve(process.env.CLIP_FETCHER_DIST_DIR || path.join(ROOT, 'dist'));
export const NODE_VERSION = '24.22.0';
export const FFMPEG_VERSION = '9.0.2';
export const FFMPEG_SHA256 = '8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e';
export const FFMPEG_ARCHIVE = `ffmpeg-${FFMPEG_VERSION}.tar.xz`;
export const FFMPEG_URL = `https://ffmpeg.org/releases/${FFMPEG_ARCHIVE}`;
export const applicationSourceEntries = ['server.mjs', 'src', 'public', 'bookmark-capture'];

export async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(command)} failed (${code ?? 'signal'})`)));
  });
}
export async function hashFile(filename) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export async function exists(filename) { try { return await stat(filename); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
export async function download(url, destination, expected) {
  await mkdir(path.dirname(destination), { recursive: true });
  if (await exists(destination)) {
    if (!expected || await hashFile(destination) === expected) return destination;
    throw new Error(`Cached checksum mismatch: ${path.basename(destination)}. Remove that file and retry.`);
  }
  console.log(`Downloading ${new URL(url).hostname}/${path.basename(destination)}`);
  const partial = destination + '.download';
  // Source archives can be slow. Keep a verified-target partial download across
  // interruption and resume it with an HTTP Range request on the next build.
  // Small unpinned metadata files are always restarted instead.
  const partialInfo = expected && await exists(partial);
  let offset = partialInfo ? partialInfo.size : 0;
  try {
    const response = await fetch(url, { redirect: 'error', headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: AbortSignal.timeout(30 * 60 * 1000) });
    if (response.status === 416 && offset && await hashFile(partial) === expected) {
      await response.body?.cancel();
      await rename(partial, destination);
      return destination;
    }
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
    if (response.status === 206) {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
      if (!range || Number(range[1]) !== offset) {
        await response.body.cancel();
        throw new Error('Invalid range response while resuming archive download');
      }
    } else offset = 0; // A server that ignores Range safely restarts the file.
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { flags: offset ? 'a' : 'w' }));
    const actual = await hashFile(partial);
    if (expected && actual !== expected) {
      await rm(partial, { force: true });
      throw new Error(`Checksum mismatch for ${path.basename(destination)}`);
    }
    await rename(partial, destination);
    return destination;
  } catch (error) {
    if (!expected) await rm(partial, { force: true });
    throw error;
  }
}

export async function prepareNode(platform, arch) {
  if (!['darwin', 'win32'].includes(platform) || !['arm64', 'x64'].includes(arch)) throw new Error('Unsupported runtime target');
  const target = platform === 'darwin' ? `darwin-${arch}` : `win-${arch}`;
  const filename = `node-v${NODE_VERSION}-${target}.${platform === 'darwin' ? 'tar.xz' : 'zip'}`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}`;
  const sumsPath = path.join(BUILD, 'downloads', `node-v${NODE_VERSION}-SHASUMS256.txt`);
  await download(`${base}/SHASUMS256.txt`, sumsPath);
  const sums = await readFile(sumsPath, 'utf8');
  const line = sums.split(/\r?\n/).find(value => value.trim().endsWith(` ${filename}`));
  const checksum = line?.trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(checksum || '')) throw new Error('Official Node checksum entry not found');
  const archive = await download(`${base}/${filename}`, path.join(BUILD, 'downloads', filename), checksum);
  const unpack = path.join(BUILD, 'node', target);
  const root = path.join(unpack, `node-v${NODE_VERSION}-${target}`);
  const executable = path.join(root, platform === 'darwin' ? 'bin/node' : 'node.exe');
  if (!await exists(executable)) {
    await mkdir(unpack, { recursive: true });
    if (platform === 'darwin') await run('/usr/bin/tar', ['-xf', archive, '-C', unpack]);
    else await run('tar.exe', ['-xf', archive, '-C', unpack]);
  }
  return { executable, license: path.join(root, 'LICENSE'), archive, checksum, target };
}

export async function prepareFfmpegSource() {
  const archive = await download(FFMPEG_URL, path.join(BUILD, 'downloads', FFMPEG_ARCHIVE), FFMPEG_SHA256);
  return archive;
}

export async function copyApplication(destination) {
  await mkdir(destination, { recursive: true });
  // Explicit whitelist: user clips, account data, logs and intermediate files
  // cannot accidentally enter a distributable, even if they live in this project.
  for (const name of applicationSourceEntries) {
    await cp(path.join(ROOT, name), path.join(destination, name), { recursive: true, filter: source => !['.DS_Store'].includes(path.basename(source)) });
  }
  await mkdir(path.join(destination, 'examples'), { recursive: true });
  await cp(path.join(ROOT, 'examples/示例视频.mkv'), path.join(destination, 'examples/示例视频.mkv'));
  await mkdir(path.join(destination, 'desktop'), { recursive: true });
  for (const name of ['main.mjs', 'single-instance.mjs', 'native-dialogs.mjs', 'windows-integration.mjs']) await cp(path.join(ROOT, 'desktop', name), path.join(destination, 'desktop', name));
  const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
  await writeFile(path.join(destination, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, private: true, type: 'module' }, null, 2) + '\n');
  return pkg;
}

export async function copyLicenses(destination, node, ffmpegPrefix) {
  const nodeDir = path.join(destination, 'Node');
  const ffmpegDir = path.join(destination, 'FFmpeg');
  await mkdir(nodeDir, { recursive: true });
  await mkdir(ffmpegDir, { recursive: true });
  await cp(node.license, path.join(nodeDir, 'LICENSE'));
  await writeFile(path.join(nodeDir, 'ORIGIN.txt'), `Node.js ${NODE_VERSION}\nhttps://nodejs.org/dist/v${NODE_VERSION}/\nArchive SHA256: ${node.checksum}\n`);
  for (const name of ['COPYING.LGPLv2.1', 'LICENSE.md', 'build-config.json', 'configure-command.txt', FFMPEG_ARCHIVE, 'rebuild.sh']) {
    const file = path.join(ffmpegPrefix, 'licenses', name);
    if (!await exists(file)) throw new Error(`Missing FFmpeg compliance material: ${name}`);
    await cp(file, path.join(ffmpegDir, name));
  }
  if (await exists(path.join(ffmpegPrefix, 'licenses/third-party'))) await cp(path.join(ffmpegPrefix, 'licenses/third-party'), path.join(ffmpegDir, 'third-party'), { recursive: true });
  await writeFile(path.join(destination, 'THIRD-PARTY-NOTICES.txt'), `This package includes Node.js ${NODE_VERSION} (MIT and bundled third-party licenses) and FFmpeg ${FFMPEG_VERSION} built with GPL/nonfree components disabled (LGPL 2.1 or later).\n\nFFmpeg is a separate command-line program. Its complete, unmodified source archive and exact build configuration are in the FFmpeg directory. You may replace the ffmpeg and ffprobe executables in app/bin with compatible versions. No cloud account credentials or user movies are included in this package.\n\nhttps://nodejs.org/\nhttps://ffmpeg.org/\nhttps://ffmpeg.org/legal.html\n`);
}

export async function writeManifest(directory, details) {
  await writeFile(path.join(directory, 'BUILD-INFO.json'), JSON.stringify({ builtAt: new Date().toISOString(), buildHost: `${os.platform()}-${os.arch()}`, ...details }, null, 2) + '\n');
}
