import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createWindowsIntegration } from '../desktop/windows-integration.mjs';

const env = { SystemRoot: 'C:\\Windows', 'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\剪辑师\\AppData\\Local' };
const firstEdge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const userEdge = env.LOCALAPPDATA + '\\Microsoft\\Edge\\Application\\msedge.exe';
const powershell = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const localUrl = 'http://127.0.0.1:54321';
const encode = value => Buffer.from(value, 'utf8').toString('base64');
const scriptFrom = args => Buffer.from(args.at(-1), 'base64').toString('utf16le');

test('Windows edition opens its panel and bookmark installer directly in installed Edge', async () => {
  const checked = [], launched = [];
  let detached = 0;
  const windows = createWindowsIntegration({ env, async check(candidate) {
    checked.push(candidate);
    if (candidate !== userEdge) throw new Error('missing');
  }, launch(command, args, options) {
    launched.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => detached++;
    queueMicrotask(() => child.emit('spawn'));
    return child;
  } });
  await windows.openBrowser('edge', localUrl);
  await windows.openBrowser('edge', localUrl + '/bookmark/install');
  assert.equal(checked[0], firstEdge);
  assert.equal(checked.at(-1), userEdge);
  assert.deepEqual(launched, [localUrl, localUrl + '/bookmark/install'].map(url => ({
    command: userEdge, args: [url], options: { detached: true, stdio: 'ignore', windowsHide: true },
  })));
  assert.equal(detached, 2);
});

test('Windows Edge integration separates missing and failed launch and refuses unsafe or unrelated URLs', async () => {
  const missing = createWindowsIntegration({ env, async check() { throw new Error('missing'); },
    launch() { assert.fail('do not switch to the system default browser'); } });
  await assert.rejects(missing.openBrowser('edge', localUrl), { code: 'BROWSER_MISSING' });
  const unsafe = createWindowsIntegration({ env, async check() { assert.fail('reject URL before looking up Edge'); } });
  for (const url of ['https://127.0.0.1:54321', 'http://127.0.0.1.evil.test:54321', 'http://localhost:54321',
    'http://127.0.0.1', localUrl + '/api/bootstrap', localUrl + '#token', localUrl + '/bookmark/install?token=bad']) {
    await assert.rejects(unsafe.openBrowser('edge', url), { code: 'BROWSER_OPEN_FAILED' });
  }
  await assert.rejects(unsafe.openBrowser('chrome', localUrl), { code: 'BROWSER_OPEN_FAILED' });
  const failed = createWindowsIntegration({ env, async check() {}, launch() {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('execution denied')));
    return child;
  } });
  await assert.rejects(failed.openBrowser('edge', localUrl), { code: 'BROWSER_OPEN_FAILED' });
});

test('Windows file and directory pickers round-trip Unicode and preserve explicit cancellation', async () => {
  const filename = 'C:\\用户\\剪辑 师\\素材,片段.mkv';
  const directory = '\\\\工作站\\共享\\🎞️ 成片 & 声音';
  const replies = [encode(filename), encode(directory), '', 'invalid base64'];
  const calls = [], signal = new AbortController().signal;
  const windows = createWindowsIntegration({ env, async execute(command, args, options) {
    calls.push({ command, args, options, script: scriptFrom(args) });
    return { stdout: replies.shift() };
  } });
  assert.equal(await windows.pickFile({ signal }), filename);
  assert.equal(await windows.pickDirectory({ signal }), directory);
  assert.equal(await windows.pickDirectory({ signal }), null);
  await assert.rejects(windows.pickFile({ signal }), { code: 'PICKER_INVALID_RESULT' });
  assert.match(calls[0].script, /OpenFileDialog[\s\S]*\$dialog\.FileName/);
  assert.match(calls[1].script, /FolderBrowserDialog[\s\S]*\$dialog\.SelectedPath/);
  for (const { command, args, options, script } of calls) {
    assert.equal(command, powershell);
    assert.deepEqual(args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand']);
    assert.match(script, /ToBase64String/);
    assert.equal(options.signal, signal);
    assert.equal(options.timeout, 120000);
    assert.equal(options.windowsHide, true);
  }
});

test('Windows Explorer receives paths only as encoded data and handles files and folders separately', async () => {
  const target = "C:\\素材 & 成片\\中文, (副本) ! $() '单引号'.mkv";
  const windows = createWindowsIntegration({ env, async execute(command, args, options) {
    assert.equal(command, powershell);
    assert.equal(options.timeout, 15000);
    assert.equal(options.env.CLIP_FETCHER_REVEAL_PATH, encode(target));
    const script = scriptFrom(args);
    assert.ok(!script.includes(target));
    assert.match(script, /Directory\]::Exists[\s\S]*\$explorer\.Open\(\$target\)/);
    assert.match(script, /SHOpenFolderAndSelectItems\(item, 0, IntPtr\.Zero, 0\)/);
    return { stdout: '' };
  } });
  await windows.reveal(target);
  await assert.rejects(windows.reveal('relative\\file.mkv'), { code: 'PICKER_INVALID_RESULT' });
});

test('the Windows launcher keeps Unicode and exclamation marks in its extracted path and requests the browser panel', async () => {
  const launcher = await readFile(new URL('../desktop/windows/启动片段取材.cmd', import.meta.url), 'utf8');
  assert.match(launcher, /^setlocal EnableExtensions DisableDelayedExpansion\r?$/m);
  assert.match(launcher, /^"%~dp0app\\bin\\node\.exe" "%~dp0app\\desktop\\main\.mjs" --browser\r?$/m);
  assert.match(launcher, /^set CLIP_FETCHER_PARENT_PID=\r?$/m);
});
