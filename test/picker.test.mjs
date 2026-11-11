import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSystemPicker, createPathPicker, validatePickedPath } from '../src/picker.mjs';
import { startServer } from '../server.mjs';

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('system pickers preserve spaces and Chinese names and distinguish OS commands', async () => {
  const requests = [];
  const controller = new AbortController();
  const mac = createSystemPicker({ platform: 'darwin', execute: async (...args) => {
    requests.push(args); return { stdout: '/tmp/剪辑 素材 /\n' };
  } });
  assert.equal(await mac(true, controller.signal), '/tmp/剪辑 素材 /');
  assert.equal(requests[0][0], '/usr/bin/osascript');
  assert.match(requests[0][1][1], /choose folder/u);
  assert.equal(requests[0][2].signal, controller.signal);
  await mac(false, controller.signal);
  assert.match(requests[1][1][1], /choose file/u);

  const win = createSystemPicker({ platform: 'win32', execute: async (command, args) => {
    assert.equal(command, 'powershell.exe');
    assert(args.includes('-STA'));
    assert.match(args.at(-1), /FolderBrowserDialog/u);
    return { stdout: 'C:\\视频 素材\\取片 ' };
  } });
  assert.equal(await win(true), 'C:\\视频 素材\\取片 ');
});

test('only explicit AppleScript -128 and normal Windows empty output count as cancellation', async () => {
  const mac = createSystemPicker({ platform: 'darwin', execute: async () => {
    throw Object.assign(new Error('private command'), { code: 1, stderr: 'execution error: User canceled. (-128)\n' });
  } });
  assert.equal(await mac(true), null);
  const win = createSystemPicker({ platform: 'win32', execute: async () => ({ stdout: '' }) });
  assert.equal(await win(true), null);
  const emptyMac = createSystemPicker({ platform: 'darwin', execute: async () => ({ stdout: '\n' }) });
  await assert.rejects(emptyMac(true), { code: 'PICKER_INVALID_RESULT' });
  const otherMacError = createSystemPicker({ platform: 'darwin', execute: async () => {
    throw Object.assign(new Error('secret-user'), { code: 1, stderr: 'secret-path execution error (-1743)' });
  } });
  await assert.rejects(otherMacError(true), error => error.code === 'PICKER_UNAVAILABLE' && !/secret/u.test(error.message));
});

test('picker launch failures, permissions and timeout have safe visible errors', async () => {
  for (const [failure, expected] of [
    [{ code: 'EPERM' }, 'PICKER_PERMISSION'],
    [{ code: 'EACCES' }, 'PICKER_PERMISSION'],
    [{ code: 'ENOENT' }, 'PICKER_UNAVAILABLE'],
    [{ code: 'ETIMEDOUT' }, 'PICKER_TIMEOUT'],
    [{ killed: true, signal: 'SIGTERM' }, 'PICKER_TIMEOUT'],
    [{ code: 1, stderr: 'secret path (-128) then another error' }, 'PICKER_UNAVAILABLE'],
  ]) {
    const picker = createSystemPicker({ platform: 'darwin', execute: async () => {
      throw Object.assign(new Error('secret command /Users/private-name'), { stderr: 'secret stderr', ...failure });
    } });
    await assert.rejects(picker(true), error => {
      assert.equal(error.code, expected);
      assert(!/secret|private-name/u.test(error.message));
      assert.equal(error.stderr, undefined);
      assert.equal(error.cause, undefined);
      return true;
    });
  }
});

test('picker rejects relative, malformed and control-character paths from hooks and processes', async () => {
  for (const invalid of [undefined, {}, '', 'relative/folder', '/tmp/line\nbreak', '/tmp/\0file', '/tmp/\u007ffile', '/tmp/' + 'a'.repeat(8192)]) {
    assert.throws(() => validatePickedPath(invalid, 'darwin'), { code: 'PICKER_INVALID_RESULT' });
    const picker = createPathPicker({ platform: 'darwin', pickDirectory: async () => invalid });
    await assert.rejects(picker(true), { code: 'PICKER_INVALID_RESULT' });
  }
  assert.equal(validatePickedPath(null), null);
  assert.equal(validatePickedPath('C:\\素材', 'win32'), 'C:\\素材');
  assert.throws(() => validatePickedPath('C:relative', 'win32'), { code: 'PICKER_INVALID_RESULT' });
});

test('one picker guard covers file and directory, injected hooks and system fallback', async () => {
  const pending = deferred();
  let fileCalls = 0;
  const custom = createPathPicker({ platform: 'darwin', pickDirectory: () => pending.promise, pickFile: () => { fileCalls++; return '/tmp/file'; } });
  const first = custom(true);
  await assert.rejects(custom(false), { code: 'PICKER_BUSY' });
  assert.equal(fileCalls, 0);
  pending.resolve('/tmp/素材');
  assert.equal(await first, '/tmp/素材');
  assert.equal(await custom(false), '/tmp/file');

  const process = deferred();
  let launches = 0;
  const fallback = createPathPicker({ platform: 'darwin', execute: () => { launches++; return process.promise; } });
  const running = fallback(false);
  await assert.rejects(fallback(true), { code: 'PICKER_BUSY' });
  process.resolve({ stdout: '/tmp/file\n' });
  assert.equal(await running, '/tmp/file');
  assert.equal(launches, 1);
});

test('shutdown aborts pending hooks and fallback and prevents later launches', async () => {
  for (const useHook of [true, false]) {
    const controller = new AbortController(), pending = deferred();
    let started = false;
    const options = { platform: 'darwin', signal: controller.signal };
    if (useHook) options.pickDirectory = () => { started = true; return pending.promise; };
    else options.execute = (_command, _args, { signal }) => { assert.equal(signal, controller.signal); started = true; return pending.promise; };
    const picker = createPathPicker(options), result = picker(true);
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(started, true);
    controller.abort();
    await assert.rejects(result, { code: 'CANCELLED' });
    await assert.rejects(picker(false), { code: 'CANCELLED' });
    pending.reject(new Error('private late process error'));
  }
  const controller = new AbortController(); controller.abort();
  const picker = createSystemPicker({ execute: () => { throw new Error('must not launch'); } });
  await assert.rejects(picker(true, controller.signal), { code: 'CANCELLED' });
});

test('custom-hook failures are sanitized, and a failed request releases the picker guard', async () => {
  let attempts = 0;
  const picker = createPathPicker({ platform: 'darwin', pickDirectory: () => {
    if (++attempts === 1) throw Object.assign(new Error('secret command'), { code: 'EPERM', stderr: 'secret path' });
    return null;
  } });
  await assert.rejects(picker(true), error => error.code === 'PICKER_PERMISSION' && !/secret/u.test(error.message));
  assert.equal(await picker(true), null);
});

test('picker API reports busy and invalid results while keeping session and origin boundaries', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-picker-'));
  const pending = deferred(), opened = deferred();
  let mode = 'wait';
  const app = await startServer({ outputDir: root, pickDirectory: () => {
    if (mode === 'invalid') return 'relative';
    if (mode === 'fail') throw Object.assign(new Error('private details'), { code: 'EPERM' });
    opened.resolve(); return pending.promise;
  } });
  t.after(async () => { pending.resolve(null); await app.close(); await rm(root, { recursive: true, force: true }); });
  const bootstrap = await (await fetch(app.url + '/api/bootstrap')).json();
  const post = (route, headers = {}) => fetch(app.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken, ...headers }, body: '{}' });
  assert.equal((await post('/api/pick-directory', { 'X-Session-Token': 'wrong' })).status, 403);
  assert.equal((await post('/api/pick-directory', { Origin: 'https://unrelated.example' })).status, 403);
  const first = post('/api/pick-directory');
  await opened.promise;
  const busy = await post('/api/pick-file');
  assert.equal(busy.status, 400);
  assert.equal((await busy.json()).error.code, 'PICKER_BUSY');
  pending.resolve(root);
  assert.deepEqual(await (await first).json(), { path: root });
  mode = 'invalid';
  const invalid = await post('/api/pick-directory');
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'PICKER_INVALID_RESULT');
  mode = 'fail';
  const failure = await post('/api/pick-directory');
  assert.equal(failure.status, 400);
  const result = await failure.json();
  assert.equal(result.error.code, 'PICKER_PERMISSION');
  assert(!JSON.stringify(result).includes('private'));
});
