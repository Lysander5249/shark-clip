import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile, cp, chmod } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { BUILD, FFMPEG_VERSION, FFMPEG_ARCHIVE, FFMPEG_URL, FFMPEG_SHA256, run, exists, prepareFfmpegSource } from './build-common.mjs';
import { releaseArchitecture } from './release-targets.mjs';

export async function buildFfmpegMac({ arch = 'arm64', jobs = Math.min(os.availableParallelism(), 8) } = {}) {
  releaseArchitecture('darwin', ['--arch', arch]);
  if (process.platform !== 'darwin') throw new Error('This builder must run on macOS.');
  const target = `darwin-${arch}`;
  const prefix = path.join(BUILD, 'ffmpeg', target);
  if (await exists(path.join(prefix, 'bin/ffmpeg')) && await exists(path.join(prefix, 'licenses/build-config.json'))) return prefix;
  const archive = await prepareFfmpegSource();
  const sourceParent = path.join(BUILD, 'ffmpeg-source');
  const source = path.join(sourceParent, `ffmpeg-${FFMPEG_VERSION}`);
  if (!await exists(path.join(source, 'configure'))) {
    await mkdir(sourceParent, { recursive: true });
    await run('/usr/bin/tar', ['-xf', archive, '-C', sourceParent]);
  }
  const buildDirectory = path.join(BUILD, 'ffmpeg-build', target);
  await mkdir(buildDirectory, { recursive: true });
  const cpu = 'arm64';
  const args = [
    '--prefix=/', `--arch=${cpu}`, '--target-os=darwin',
    '--cc=clang', `--extra-cflags=-arch ${cpu} -mmacosx-version-min=13.0`, `--extra-ldflags=-arch ${cpu} -mmacosx-version-min=13.0`,
    '--disable-autodetect', '--disable-shared', '--enable-static',
    '--disable-gpl', '--disable-version3', '--disable-nonfree',
    '--disable-doc', '--disable-debug', '--disable-programs', '--enable-ffmpeg', '--enable-ffprobe',
    '--disable-avdevice', '--disable-devices', '--disable-audiotoolbox', '--disable-videotoolbox',
    '--disable-encoders', '--enable-encoder=aac,wrapped_avframe,pcm_s16le,mjpeg,subrip,ass',
    '--disable-protocols', '--enable-protocol=file,pipe,http,tcp',
    '--enable-zlib', '--enable-bzlib', '--enable-pthreads',
    ...(os.arch() !== arch ? ['--enable-cross-compile'] : []),
  ];
  await run(path.join(source, 'configure'), args, { cwd: buildDirectory });
  await run('/usr/bin/make', ['-j', String(jobs)], { cwd: buildDirectory });
  await run('/usr/bin/make', ['install', `DESTDIR=${prefix}`], { cwd: buildDirectory });
  for (const name of ['ffmpeg', 'ffprobe']) {
    const file = path.join(prefix, 'bin', name);
    const linked = execFileSync('/usr/bin/otool', ['-L', file], { encoding: 'utf8' });
    if (linked.includes('/opt/homebrew/') || linked.includes('/usr/local/') || /\n\s+@/.test(linked)) throw new Error(`${name} has a non-system dynamic dependency`);
    await chmod(file, 0o755);
  }
  const licenses = path.join(prefix, 'licenses');
  await mkdir(licenses, { recursive: true });
  for (const name of ['COPYING.LGPLv2.1', 'LICENSE.md']) await cp(path.join(source, name), path.join(licenses, name));
  await cp(archive, path.join(licenses, FFMPEG_ARCHIVE));
  await writeFile(path.join(licenses, 'build-config.json'), JSON.stringify({ version: FFMPEG_VERSION, sourceUrl: FFMPEG_URL, sourceSha256: FFMPEG_SHA256, sourceModified: false, target, configure: args, compiler: execFileSync('/usr/bin/clang', ['--version'], { encoding: 'utf8' }).split('\n')[0], license: 'LGPL-2.1-or-later' }, null, 2) + '\n');
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  const portableArgs = args.filter(value => !value.startsWith('--prefix='));
  const command = `./configure --prefix="$PWD/output" ${portableArgs.map(quote).join(' ')}\nmake -j8\nmake install\n`;
  await writeFile(path.join(licenses, 'configure-command.txt'), command);
  await writeFile(path.join(licenses, 'rebuild.sh'), `#!/bin/sh\nset -eu\ncd "$(dirname "$0")"\ntar -xf ${FFMPEG_ARCHIVE}\ncd ffmpeg-${FFMPEG_VERSION}\n${command}`);
  await chmod(path.join(licenses, 'rebuild.sh'), 0o755);
  console.log(`FFmpeg ready: ${prefix}`);
  return prefix;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arch = releaseArchitecture('darwin', process.argv.slice(2));
  await buildFfmpegMac({ arch });
}
