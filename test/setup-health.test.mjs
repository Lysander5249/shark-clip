import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import { setupPlatform, checkOutputDirectory, checkCloudDrive } from '../src/setup-health.mjs';

const options = { timeout: 10000 };
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function directory(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'clip-setup-health-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
async function fixture(t, handler) {
  const calls = [], active = new Set();
  const server = http.createServer((req, res) => {
    calls.push({ method: req.method, url: req.url, depth: req.headers.depth,
      authorization: req.headers.authorization, cookie: req.headers.cookie });
    active.add(res); res.once('close', () => active.delete(res)); handler(req, res);
  });
  t.after(async () => {
    server.closeAllConnections();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { server, calls, active, url: `http://127.0.0.1:${server.address().port}/dav/` };
}
async function idle(active) {
  for (let i = 0; i < 100 && active.size; i++) await wait(5);
  assert.equal(active.size, 0, 'check left an HTTP response active');
}

test('setup platform declares only the selected Mac arm64 and Windows x64 targets', () => {
  assert.deepEqual(setupPlatform('darwin', 'arm64'), { os: 'darwin', arch: 'arm64', supportedTarget: true });
  assert.deepEqual(setupPlatform('win32', 'x64'), { os: 'win32', arch: 'x64', supportedTarget: true });
  for (const [os, arch] of [['darwin', 'x64'], ['win32', 'arm64'], ['linux', 'x64']]) assert.equal(setupPlatform(os, arch).supportedTarget, false);
});

test('output directory check creates nested Chinese paths and removes only its own empty write probe', options, async t => {
  const root = await directory(t), output = path.join(root, '剪辑 素材', '保存 目录');
  const first = await checkOutputDirectory(output);
  assert.equal(first.status, 'ready'); assert.equal(first.code, 'OUTPUT_READY');
  assert(first.freeBytes === null || Number.isSafeInteger(first.freeBytes) && first.freeBytes > 0);
  const sentinel = path.join(output, '.clip-fetcher-write-check-user-file');
  await fs.writeFile(sentinel, 'KEEP_EXISTING_USER_DATA');
  assert.equal((await checkOutputDirectory(output)).status, 'ready');
  assert.deepEqual(await fs.readdir(output), [path.basename(sentinel)]);
  assert.equal(await fs.readFile(sentinel, 'utf8'), 'KEEP_EXISTING_USER_DATA');
});

test('storage rejects malformed paths and an existing file without changing its contents', options, async t => {
  const root = await directory(t), file = path.join(root, 'existing-file');
  await fs.writeFile(file, 'DO_NOT_OVERWRITE');
  for (const invalid of [null, 7, '', 'relative/folder', '/tmp/line\nbreak', '/tmp/\0file']) {
    const result = await checkOutputDirectory(invalid);
    assert.equal(result.status, 'error'); assert.equal(result.code, 'OUTPUT_INVALID'); assert.equal(result.freeBytes, null);
  }
  const result = await checkOutputDirectory(file);
  assert.equal(result.code, 'OUTPUT_NOT_WRITABLE'); assert.equal(await fs.readFile(file, 'utf8'), 'DO_NOT_OVERWRITE');
  assert(!JSON.stringify(result).includes(root));
});

test('storage distinguishes unknown space from zero and unrepresentable space', options, async t => {
  const output = await directory(t);
  const unknown = await checkOutputDirectory(output, { filesystem: { ...fs, statfs: async () => { throw new Error('private filesystem details'); } } });
  assert.equal(unknown.status, 'ready'); assert.equal(unknown.freeBytes, null);
  const zero = await checkOutputDirectory(output, { filesystem: { ...fs, statfs: async () => ({ bavail: 0n, bsize: 4096n }) } });
  assert.equal(zero.status, 'error'); assert.equal(zero.code, 'OUTPUT_NO_SPACE'); assert.equal(zero.freeBytes, 0);
  const huge = await checkOutputDirectory(output, { filesystem: { ...fs, statfs: async () => ({ bavail: 2n ** 60n, bsize: 4096n }) } });
  assert.equal(huge.status, 'ready'); assert.equal(huge.freeBytes, null);
  assert.deepEqual(await fs.readdir(output), []);
});

test('storage uses exclusive creation and never removes a probe it did not create', options, async t => {
  const output = await directory(t); let removals = 0;
  const result = await checkOutputDirectory(output, { filesystem: { ...fs,
    open: async (_filename, flags, mode) => {
      assert.equal(flags, 'wx'); assert.equal(mode, 0o600);
      throw Object.assign(new Error('private collision details'), { code: 'EEXIST' });
    }, unlink: async () => { removals++; },
  } });
  assert.equal(result.status, 'error'); assert.equal(removals, 0);
  assert(!JSON.stringify(result).includes('private'));
});

test('storage cancellation cleans an acquired probe and pre-cancellation performs no creation', options, async t => {
  const output = await directory(t), controller = new AbortController();
  await assert.rejects(checkOutputDirectory(output, { signal: controller.signal, filesystem: { ...fs,
    open: async (...args) => { const handle = await fs.open(...args); controller.abort(); return handle; },
  } }), { code: 'CANCELLED' });
  assert.deepEqual(await fs.readdir(output), []);
  const missing = path.join(output, 'not-created');
  await assert.rejects(checkOutputDirectory(missing, { signal: controller.signal }), { code: 'CANCELLED' });
  await assert.rejects(fs.stat(missing), { code: 'ENOENT' });
});

test('storage reports cleanup failure instead of a false ready result', options, async t => {
  const output = await directory(t);
  const result = await checkOutputDirectory(output, { filesystem: { ...fs,
    unlink: async () => { throw Object.assign(new Error('private path'), { code: 'EACCES' }); },
  } });
  assert.equal(result.status, 'error'); assert.equal(result.code, 'OUTPUT_CLEANUP_FAILED');
  assert.equal((await fs.readdir(output)).length, 1);
  assert(!JSON.stringify(result).includes('private'));
});

test('unsupported CloudDrive addresses are rejected before dispatch without exposing address credentials', async () => {
  for (const url of ['https://outside.invalid/dav/', 'http://192.168.1.1/dav/', 'ftp://127.0.0.1/dav/',
    'http://PRIVATE_USER:PRIVATE_PASSWORD@127.0.0.1/dav/', 'http://127.0.0.1/dav/?PRIVATE_QUERY',
    'http://127.0.0.1/dav/#PRIVATE_FRAGMENT', 'http://127.0.0.1/dav/?', 'http://127.0.0.1/dav/#', '\nhttp://127.0.0.1/dav/', '', null]) {
    const result = await checkCloudDrive(url);
    assert.equal(result.status, 'unsupported_address'); assert.equal(result.code, 'DAV_ADDRESS_UNSUPPORTED');
    assert(!JSON.stringify(result).includes('PRIVATE'));
  }
});

test('CloudDrive check accepts only a local DAV response and never sends credentials or collects directories', options, async t => {
  for (const status of [401, 403, 207]) await t.test(String(status), async t => {
    const f = await fixture(t, (_req, res) => { res.writeHead(status); res.flushHeaders(); res.write('PRIVATE_DIRECTORY_BODY'); });
    const result = await checkCloudDrive(f.url);
    assert.equal(result.status, 'responding'); assert.equal(result.code, 'DAV_LOCAL_RESPONDING');
    assert(result.message.includes('尚未验证账号登录'));
    assert.deepEqual(f.calls, [{ method: 'PROPFIND', url: '/dav/', depth: '0', authorization: undefined, cookie: undefined }]);
    assert(!JSON.stringify(result).includes('PRIVATE_DIRECTORY_BODY'));
    await idle(f.active);
  });
});

test('CloudDrive check refuses redirects and rejects other HTTP responses without following or accepting them', options, async t => {
  const target = await fixture(t, (_req, res) => res.writeHead(207).end());
  const redirect = await fixture(t, (_req, res) => res.writeHead(302, { Location: target.url }).end());
  const redirected = await checkCloudDrive(redirect.url);
  assert.equal(redirected.code, 'DAV_LOCAL_REDIRECT'); assert.equal(target.calls.length, 0);
  const ordinary = await fixture(t, (_req, res) => res.writeHead(200).end('PRIVATE_HTML'));
  assert.equal((await checkCloudDrive(ordinary.url)).status, 'unavailable');
  await idle(redirect.active); await idle(ordinary.active);
});

test('CloudDrive check has a two-second deadline and abort settles pending HTTP responses', options, async t => {
  const f = await fixture(t, () => {});
  const start = performance.now();
  assert.equal((await checkCloudDrive(f.url)).code, 'DAV_LOCAL_TIMEOUT');
  assert(performance.now() - start < 4000); await idle(f.active);
  const controller = new AbortController(), operation = checkCloudDrive(f.url, { signal: controller.signal });
  while (f.calls.length < 2) await wait(5);
  controller.abort(); assert.equal((await operation).code, 'CANCELLED'); await idle(f.active);
  const before = f.calls.length;
  assert.equal((await checkCloudDrive(f.url, { signal: controller.signal })).code, 'CANCELLED');
  assert.equal(f.calls.length, before);
});
