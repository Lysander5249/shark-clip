import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { releaseArchitecture } from './release-targets.mjs';

const run = promisify(execFile);

test('release targets permit only Mac arm64 and Windows x64 with explicit argument validation', () => {
  assert.equal(releaseArchitecture('darwin'), 'arm64');
  assert.equal(releaseArchitecture('darwin', ['--arch', 'arm64']), 'arm64');
  assert.equal(releaseArchitecture('win32'), 'x64');
  assert.equal(releaseArchitecture('win32', ['--arch', 'x64']), 'x64');
  for (const [platform, arch] of [['darwin', 'x64'], ['darwin', 'x86_64'], ['win32', 'arm64'], ['win32', 'ia32']]) {
    assert.throws(() => releaseArchitecture(platform, ['--arch', arch]), /support (?:arm64|x64) only/);
  }
  for (const args of [['--arch'], ['--unknown'], ['--arch', 'arm64', '--arch', 'arm64'], ['--arch=arm64'], null, 'arm64']) {
    assert.throws(() => releaseArchitecture('darwin', args), /Use only --arch/);
  }
  assert.throws(() => releaseArchitecture('linux'), /No release is configured/);
});

test('unsupported package and media targets fail before download or publication mutation', { timeout: 10000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-fetcher-target-rejection-'));
  const publication = path.join(root, 'published');
  const cache = path.join(root, 'must-not-create-cache');
  await mkdir(publication);
  await writeFile(path.join(publication, 'existing-package.txt'), 'preserve this release');
  try {
    for (const [script, arch, message] of [
      ['build-macos.mjs', 'x64', /Mac releases support arm64 only/],
      ['build-ffmpeg-macos.mjs', 'x64', /Mac releases support arm64 only/],
      ['build-windows.mjs', 'arm64', /Windows releases support x64 only/],
    ]) {
      await assert.rejects(run(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), '--arch', arch], {
        timeout: 5000,
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', CLIP_FETCHER_BUILD_DIR: cache, CLIP_FETCHER_DIST_DIR: publication },
      }), error => error.code === 1 && message.test(error.stderr));
      assert.deepEqual(await readdir(publication), ['existing-package.txt']);
      assert.equal(await readFile(path.join(publication, 'existing-package.txt'), 'utf8'), 'preserve this release');
      await assert.rejects(stat(cache), { code: 'ENOENT' });
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
