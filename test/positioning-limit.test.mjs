import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, rm, stat, readdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server.mjs';

const run = promisify(execFile);
const sample = fileURLToPath(new URL('../examples/示例视频.mkv', import.meta.url));

test('a remote MKV without a seek index stops after bounded metadata reads without scanning media', { timeout: 45000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-positioning-'));
  const file = path.join(directory, 'no-index.mkv');
  let app, fixture;
  t.after(async () => {
    await app?.close();
    if (fixture) { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); }
    await rm(directory, { recursive: true, force: true });
  });
  // Matroska live mode intentionally omits Cues and duration. This synthetic
  // source exercises the expensive late seek without cloud accounts or films.
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-stream_loop', '39', '-i', sample, '-t', '600', '-map', '0', '-c', 'copy', '-f', 'matroska', '-live', '1', file]);
  const size = (await stat(file)).size;
  assert(size > 64 * 1024 * 1024);
  fixture = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
    if (!match) { res.writeHead(400).end(); return; }
    const start = Number(match[1]), end = match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end(); return; }
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, ETag: '"no-index-fixture"' });
    const stream = createReadStream(file, { start, end });
    res.once('close', () => stream.destroy());
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const outputDir = path.join(directory, 'exports');
  app = await startServer({ outputDir });
  const boot = await fetch(app.url + '/api/bootstrap').then(response => response.json());
  const post = async (route, data) => {
    const response = await fetch(app.url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': boot.sessionToken }, body: JSON.stringify(data) });
    const result = await response.json();
    assert(response.ok, JSON.stringify(result));
    return result;
  };
  const source = await post('/api/probe', { source: { type: 'http', value: `http://127.0.0.1:${fixture.address().port}/no-index.mkv` }, budgetMiB: 64 });
  const created = await post('/api/jobs', { sourceId: source.sourceId, start: 540, end: 550, handles: 0, budgetMiB: 256 });
  let job;
  for (let i = 0; i < 700; i++) {
    job = await fetch(`${app.url}/api/jobs/${created.id}`).then(response => response.json());
    if (['completed', 'failed', 'cancelled'].includes(job.status)) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'INDEX_UNAVAILABLE');
  assert.equal(job.progress, null);
  assert.equal(job.metrics.budgetBytes, 256 * 1024 * 1024);
  assert(job.metrics.receivedBytes <= 4 * 1024 * 1024);
  assert(job.metrics.receivedBytes < size);
  assert.equal(job.result, undefined);
  assert(!(await readdir(outputDir)).some(name => name.startsWith('clip-')));
});
