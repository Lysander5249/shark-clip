import test from 'node:test';
import assert from 'node:assert/strict';
import { setupHealthView, setupPlatformLabel, setupCheckAddress } from '../public/setup-view.mjs';

test('setup view keeps a responding DAV service separate from account authorization', () => {
  const view = setupHealthView({ schemaVersion: 1, platform: { os: 'darwin', arch: 'arm64', supportedTarget: true },
    tools: { ffmpeg: true, ffprobe: true }, storage: { status: 'ready', freeBytes: null }, cloudDrive: { status: 'responding' } });
  assert.match(view.headline, /连接云盘账号/);
  assert.match(view.items[3].detail, /尚未核对账号、网盘授权或视频读取能力/);
  assert.match(view.items[2].detail, /空间暂时未知/);
  assert.doesNotMatch(view.items[2].detail, /0\.0 GiB/);
});

test('setup view fails closed for missing components or storage without blocking local use on DAV failure', () => {
  let view = setupHealthView({ schemaVersion: 1, tools: {}, storage: {}, cloudDrive: {} });
  assert.equal(view.items[1].tone, 'error');
  assert.equal(view.items[2].tone, 'error');
  assert.equal(view.items[3].tone, 'warn');
  assert.match(view.items[3].detail, /本地文件取材可跳过/);
  view = setupHealthView({ schemaVersion: 1, tools: { ffmpeg: true, ffprobe: true }, storage: { status: 'ready', freeBytes: 0 }, cloudDrive: { status: 'unavailable' } });
  assert.match(view.headline, /本地取材环境已就绪/);
  assert.match(view.items[2].detail, /0\.0 GiB/);
  assert.equal(setupHealthView({ schemaVersion: 2 }), null);
});

test('setup view only advertises the two selected distribution targets', () => {
  assert.equal(setupPlatformLabel({ os: 'darwin', arch: 'arm64' }), 'M 系列 Mac');
  assert.equal(setupPlatformLabel({ os: 'win32', arch: 'x64' }), 'Windows x64');
  for (const platform of [{ os: 'darwin', arch: 'x64' }, { os: 'win32', arch: 'arm64' }, {}, null])
    assert.match(setupPlatformLabel(platform), /未列入/);
});

test('Windows Edge edition presents WebDAV as optional while preserving video and storage checks', () => {
  const report = { schemaVersion: 1, tools: { ffmpeg: true, ffprobe: true }, storage: { status: 'ready' },
    cloudDrive: { status: 'unavailable' } };
  const view = setupHealthView(report, { windowsEdge: true });
  assert.match(view.headline, /登录迅雷云盘后可使用 Edge 抓链/);
  assert.equal(view.items[3].tone, 'info');
  assert.match(view.items[3].detail, /可跳过/);
  assert.equal(setupHealthView(report).items[3].tone, 'warn');
  assert.equal(setupHealthView({ ...report, storage: {} }, { windowsEdge: true }).items[2].tone, 'error');
});

test('setup check refuses accidental URL credentials and remote or malformed destinations before posting', () => {
  for (const text of ['http://user:secret@127.0.0.1/dav/', 'http://127.0.0.1/dav/?token=secret',
    'https://example.com/dav/', 'http://127.0.0.1/dav/#private', 'ftp://localhost/dav/', 'http://localhost\\@example.com', 'bad', null])
    assert.equal(setupCheckAddress(text), null);
  for (const text of ['http://127.0.0.1:29798/dav/', 'http://localhost:1234/dav/', 'https://[::1]:1234/dav/'])
    assert.equal(setupCheckAddress(' '+text+' '), text);
});
