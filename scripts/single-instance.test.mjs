import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { acquireDesktopInstance } from '../desktop/single-instance.mjs';

test('one desktop instance owns a data directory; existing panel is verified without persisting its token', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-fetcher-instance-'));
  let owner;
  const token = 'test-private-session-token';
  const service = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ sessionToken: token })); });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  try {
    owner = await acquireDesktopInstance({ dataDir: directory });
    assert.equal(owner.alreadyRunning, false);
    const launching = await acquireDesktopInstance({ dataDir: directory });
    assert.deepEqual(launching, { alreadyRunning: true, url: null });
    const url = `http://127.0.0.1:${service.address().port}`;
    await owner.ready(url, token);
    const second = await acquireDesktopInstance({ dataDir: directory });
    assert.deepEqual(second, { alreadyRunning: true, url });
    assert.ok(!(await readFile(path.join(directory, 'desktop-instance.json'), 'utf8')).includes(token));
    await assert.rejects(owner.ready('https://example.com/', token), /Invalid instance/);
  } finally {
    if (owner) await owner.release();
    await new Promise(resolve => service.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
});

test('OS lock is released after a crash; stale PID record cannot block restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-fetcher-crash-'));
  const module = new URL('../desktop/single-instance.mjs', import.meta.url).href;
  const code = `const {acquireDesktopInstance}=await import(${JSON.stringify(module)}); await acquireDesktopInstance({dataDir:process.argv[1]}); process.stdout.write('locked\\n'); setInterval(()=>{},10000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, directory], { stdio: ['ignore', 'pipe', 'pipe'] });
  let owner;
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('child lock timeout')), 10000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.stdout.once('data', () => { clearTimeout(timeout); resolve(); });
    });
    child.kill('SIGKILL');
    await once(child, 'exit');
    owner = await acquireDesktopInstance({ dataDir: directory });
    assert.equal(owner.alreadyRunning, false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    if (owner) await owner.release();
    await rm(directory, { recursive: true, force: true });
  }
});
