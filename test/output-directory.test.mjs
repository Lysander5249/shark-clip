import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, writeFile, symlink, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { reserveNamedDirectory } from '../src/output-directory.mjs';
import { CLIP_NAME_MAX_BYTES } from '../public/clip-options.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-output-directory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const outputDir = path.join(root, 'outputs');
  await mkdir(outputDir);
  return { root, outputDir };
}

test('simultaneous same-name reservations create distinct numbered directories without changing earlier output', async t => {
  const { outputDir } = await fixture(t);
  const clipName = '电影 🎬_00-01-00_00-02-00';
  const first = await reserveNamedDirectory({ outputDir, clipName });
  const sentinel = path.join(first, 'saved.mkv');
  await writeFile(sentinel, 'previous completed material');
  const later = await Promise.all(Array.from({ length: 3 }, () => reserveNamedDirectory({ outputDir, clipName })));
  assert.equal(path.basename(first), clipName);
  assert.deepEqual(later.map(directory => path.basename(directory)).sort(), [2, 3, 4].map(number => `${clipName} (${number})`));
  assert.equal(await readFile(sentinel, 'utf8'), 'previous completed material');
  for (const directory of later) assert.deepEqual(await readdir(directory), []);
});

test('files, directories, directory links and broken links are occupied names, never destinations', async t => {
  const { root, outputDir } = await fixture(t);
  const outside = path.join(root, 'outside');
  await mkdir(outside); await writeFile(path.join(outside, 'sentinel'), 'outside unchanged');
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  await symlink(outside, path.join(outputDir, '素材'), linkType);
  await symlink(path.join(root, 'missing-target'), path.join(outputDir, '素材 (2)'), linkType);
  await writeFile(path.join(outputDir, '素材 (3)'), 'file unchanged');
  await mkdir(path.join(outputDir, '素材 (4)'));
  await writeFile(path.join(outputDir, '素材 (4)', 'sentinel'), 'directory unchanged');
  const result = await reserveNamedDirectory({ outputDir, clipName: '素材' });
  assert.equal(path.basename(result), '素材 (5)');
  assert((await lstat(path.join(outputDir, '素材'))).isSymbolicLink());
  assert((await lstat(path.join(outputDir, '素材 (2)'))).isSymbolicLink());
  assert.equal(await readFile(path.join(outputDir, '素材 (3)'), 'utf8'), 'file unchanged');
  assert.equal(await readFile(path.join(outputDir, '素材 (4)', 'sentinel'), 'utf8'), 'directory unchanged');
  assert.deepEqual(await readdir(outside), ['sentinel']);
  assert.equal(await readFile(path.join(outside, 'sentinel'), 'utf8'), 'outside unchanged');
});

test('maximum-byte Unicode names leave room for numbering and noncanonical names cannot become paths', async t => {
  const { outputDir } = await fixture(t);
  const clipName = '😀'.repeat(45);
  assert.equal(Buffer.byteLength(clipName), CLIP_NAME_MAX_BYTES);
  const first = await reserveNamedDirectory({ outputDir, clipName });
  const second = await reserveNamedDirectory({ outputDir, clipName });
  assert.equal(path.basename(first), clipName);
  assert.equal(path.basename(second), `${clipName} (2)`);
  assert(Buffer.byteLength(path.basename(second)) < 255);
  for (const bad of ['../escape', 'a/b', 'a\\b', 'CON', 'aux.txt', 'trailing.', 'a:b', 'Cafe\u0301', clipName + 'a']) {
    await assert.rejects(reserveNamedDirectory({ outputDir, clipName: bad }), { code: 'INVALID_CLIP_NAME' });
  }
  assert.equal((await readdir(outputDir)).length, 2);
});

test('pre-cancelled reservations leave existing names alone and create no numbered directory', async t => {
  const { outputDir } = await fixture(t);
  await writeFile(path.join(outputDir, '素材'), 'keep');
  const controller = new AbortController(); controller.abort();
  await assert.rejects(reserveNamedDirectory({ outputDir, clipName: '素材', signal: controller.signal }), { code: 'CANCELLED' });
  assert.deepEqual(await readdir(outputDir), ['素材']);
  assert.equal(await readFile(path.join(outputDir, '素材'), 'utf8'), 'keep');
});

test('a filesystem-rejected long output path explains how to shorten it', async t => {
  const { outputDir } = await fixture(t);
  const invalidParent = path.join(outputDir, 'x'.repeat(300));
  await assert.rejects(reserveNamedDirectory({ outputDir: invalidParent, clipName: '素材' }), error => {
    assert(['OUTPUT_PATH_TOO_LONG', 'OUTPUT_NOT_WRITABLE'].includes(error.code));
    assert.match(error.message, /路径.*缩短/);
    return true;
  });
  assert.deepEqual(await readdir(outputDir), []);
});
