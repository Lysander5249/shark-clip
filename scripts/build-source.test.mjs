import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const windows = process.platform === 'win32';

test('the extracted source package starts with the bookmark script and includes the helper sources', {
  timeout: 30000,
  skip: !windows && process.platform !== 'darwin',
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'shark-source-package-'));
  const dist = path.join(temporary, 'dist');
  const unpack = path.join(temporary, 'unpack');
  let app;
  try {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    await run(process.execPath, [fileURLToPath(new URL('build-source.mjs', import.meta.url))], {
      env: { ...process.env, CLIP_FETCHER_BUILD_DIR: path.join(temporary, 'build'), CLIP_FETCHER_DIST_DIR: dist },
      timeout: 15000,
    });
    const archive = path.join(dist, '片段取材-' + pkg.version + '-源码.zip');
    await mkdir(unpack);
    await run(windows ? 'tar.exe' : '/usr/bin/ditto', windows
      ? ['-xf', archive, '-C', unpack]
      : ['-x', '-k', archive, unpack], { timeout: 10000 });
    const extracted = path.join(unpack, 'clip-fetcher-' + pkg.version + '-source');
    await access(path.join(extracted, 'browser-helper', 'manifest.json'));
    const { startServer } = await import(pathToFileURL(path.join(extracted, 'server.mjs')).href);
    app = await startServer({ dataDir: path.join(temporary, 'state'), outputDir: path.join(temporary, 'exports') });
    const response = await fetch(app.url + '/api/bookmark-capture/state');
    assert.equal(response.status, 200);
    const bookmark = await response.json();
    assert.equal(bookmark.available, true);
    assert.match(bookmark.bookmarklet, /^javascript:/);
  } finally {
    try { await app?.close(); }
    finally { await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  }
});
