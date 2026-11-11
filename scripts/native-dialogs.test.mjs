import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import os from 'node:os';
import { createNativeDialogs } from '../desktop/native-dialogs.mjs';

test('native dialog responses require matching IDs and absolute paths; cancellation releases the channel', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const requests = [];
  output.on('data', bytes => requests.push(JSON.parse(bytes.toString().split('=')[1])));
  const dialogs = createNativeDialogs({ input, output, timeoutMs: 1000 });
  const first = dialogs.request('directory');
  assert.equal(await dialogs.request('file'), null, 'one visible dialog at a time');
  const id = requests[0].id;
  input.write(JSON.stringify({ id: 'unrelated', path: '/tmp/ignored' }) + '\n');
  input.write(JSON.stringify({ id, path: 'relative/path' }) + '\n');
  const destination = path.join(os.tmpdir(), '素材文件夹');
  input.write(JSON.stringify({ id, path: destination }) + '\n');
  assert.equal(await first, destination);
  const next = dialogs.request('file');
  input.write(JSON.stringify({ id: requests[1].id, path: null }) + '\n');
  assert.equal(await next, null);
  const pending = dialogs.request('directory');
  dialogs.close();
  assert.equal(await pending, null);
  assert.equal(await dialogs.request('file'), null);
});
