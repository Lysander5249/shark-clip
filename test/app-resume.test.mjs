import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdtemp, mkdir, stat, readFile, writeFile, readdir, rm, open } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { locateMatroskaCue } from '../src/matroska-index.mjs';

const run = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const CHUNK = 1024 * 1024;
const SERVER_URL = pathToFileURL(fileURLToPath(new URL('../server.mjs', import.meta.url))).href;

async function eventually(callback, label, milliseconds = 45000) {
  const until = Date.now() + milliseconds;
  while (Date.now() < until) {
    const value = await callback();
    if (value) return value;
    await wait(40);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// A separate backend process is essential: closing a server normally cannot
// establish that a durable checkpoint also survives abrupt process death.
async function childServer(t, root) {
  const script = `import { startServer } from ${JSON.stringify(SERVER_URL)};
    const app = await startServer({ outputDir: process.env.RESUME_TEST_OUTPUT, dataDir: process.env.RESUME_TEST_STATE });
    process.send({ url: app.url });
    process.on('message', async message => { if (message === 'close') { await app.close(); process.exit(0); } });`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, RESUME_TEST_OUTPUT: path.join(root, 'output'), RESUME_TEST_STATE: path.join(root, 'state') },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-10000); });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const done = once(child, 'exit'); child.kill('SIGKILL'); await done;
    }
  });
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code, signal]) => { throw new Error(`Test backend exited ${code}/${signal}: ${stderr}`); }),
  ]);
  const bootstrap = await (await fetch(`${ready.url}/api/bootstrap`)).json();
  async function api(route, value, { allowError = false } = {}) {
    const response = await fetch(ready.url + route, value === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': bootstrap.sessionToken }, body: JSON.stringify(value),
    });
    const data = await response.json();
    if (!response.ok && !allowError) throw new Error(`${route}: ${JSON.stringify(data)}`);
    return data;
  }
  return {
    api,
    async kill() {
      assert.equal(child.exitCode, null);
      const done = once(child, 'exit'); child.kill('SIGKILL');
      const [, signal] = await done; assert.equal(signal, 'SIGKILL');
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const done = once(child, 'exit'); child.send('close'); await done;
    },
  };
}

async function persistedJson(directory) {
  const contents = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const filename = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(filename);
      else if (entry.isFile() && entry.name.endsWith('.json')) contents.push(await readFile(filename, 'utf8'));
    }
  }
  await walk(directory);
  return contents.join('\n');
}

async function filesWithin(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesWithin(filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

test('indexed remote resume survives a real backend SIGKILL without rereading committed target bytes', { timeout: 150000 }, async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'clip-resume-api-'));
  try {
  const video = path.join(root, 'synthetic.mkv');
  await run('ffmpeg', ['-v', 'error', '-nostdin', '-n',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=20',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=20',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18', '-g', '24', '-keyint_min', '24', '-sc_threshold', '0',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', '-cluster_time_limit', '1000', video], { timeout: 45000 });
  const size = (await stat(video)).size;
  const sourceFile = await open(video, 'r');
  let indexed;
  try {
    indexed = await locateMatroskaCue({ size, start: 6, end: 12, videoStreamIndex: 0, videoCodec: 'h264',
      read: async (position, length) => {
        const data = Buffer.alloc(length);
        assert.equal((await sourceFile.read(data, 0, length, position)).bytesRead, length);
        return data;
      },
    });
  } finally { await sourceFile.close(); }
  assert(indexed?.window);
  const { sourceStart, sourceEnd } = indexed.window;
  assert(sourceEnd - sourceStart > 3 * CHUNK, 'the integration fixture needs multiple durable media blocks');
  let stalling = true, stalled = false;
  let etag = '"resume-fixture-v1"';
  const requests = [];
  const fixture = http.createServer((req, res) => {
    const match = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
    if (!match) { res.writeHead(400).end(); return; }
    const start = Number(match[1]), end = Math.min(Number(match[2]), size - 1);
    requests.push({ start, end, ifMatch: req.headers['if-match'], phase: stalling ? 'before-crash' : 'after-restart' });
    res.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1, ...(etag ? { ETag: etag } : {}) });
    if (stalling && start === sourceStart + CHUNK && end - start + 1 === CHUNK) {
      stalled = true;
      res.flushHeaders();
      const stream = createReadStream(video, { start, end: start + 65535 });
      res.once('close', () => stream.destroy()); stream.pipe(res, { end: false });
      return;
    }
    const stream = createReadStream(video, { start, end });
    res.once('close', () => stream.destroy()); stream.pipe(res);
  });
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  t.after(async () => { fixture.closeAllConnections(); await new Promise(resolve => fixture.close(resolve)); });
  const secret = 'RESUME_URL_MUST_NOT_PERSIST';
  const value = `http://127.0.0.1:${fixture.address().port}/movie.mkv?signature=${secret}`;
  const finish = (app, id) => eventually(async () => {
    const job = await app.api(`/api/jobs/${id}`);
    return ['completed', 'failed', 'cancelled'].includes(job.status) ? job : null;
  }, 'task completion');
  async function interruptNewTask(caseName, budgetMiB = 64, { graceful = false } = {}) {
    stalling = true; stalled = false; etag = '"resume-fixture-v1"';
    const directory = path.join(root, caseName), app = await childServer(t, directory);
    const source = await app.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 32 });
    const job = await app.api('/api/jobs', { sourceId: source.sourceId, start: 6, end: 12, handles: 0, budgetMiB,
      outputDir: path.join(directory, 'saved') });
    await eventually(() => stalled, `${caseName} second media block to stall`);
    const before = await app.api(`/api/jobs/${job.id}`);
    if (graceful) await app.close(); else await app.kill();
    fixture.closeAllConnections(); stalling = false;
    return { directory, job, before };
  }
  async function rejectedResume(app, id, sourceId) {
    const result = await app.api(`/api/jobs/${id}/resume`, { sourceId }, { allowError: true });
    if (result.error) return result.error;
    const done = await finish(app, id);
    assert.equal(done.status, 'failed', 'unsafe cached bytes must never be published');
    return done.error;
  }
  const first = await childServer(t, root);
  const source = await first.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 32 });
  const created = await first.api('/api/jobs', { sourceId: source.sourceId, start: 6, end: 12, handles: 0, budgetMiB: 64, outputDir: path.join(root, 'saved') });
  await eventually(() => stalled, 'second media block to stall');
  const before = await first.api(`/api/jobs/${created.id}`);
  assert.equal(before.status, 'running');
  assert(before.metrics.receivedBytes >= CHUNK);
  await first.kill();
  fixture.closeAllConnections();
  stalling = false;
  const disk = await persistedJson(path.join(root, 'state'));
  assert(!disk.includes(secret), 'persisted state must not contain signed URLs');
  assert(!disk.includes(value), 'persisted state stores a locator digest, never a replayable URL');

  const second = await childServer(t, root);
  const restored = await second.api(`/api/jobs/${created.id}`);
  assert.notEqual(restored.status, 'running', 'a restart must wait for source reauthentication rather than resume automatically');
  assert(restored.resume.uncertainBytes >= CHUNK, 'the unfinished request is labelled separately as conservative budget before resuming');
  assert.equal(restored.result, undefined, 'an incomplete cache must never be advertised as a completed candidate');
  const reopened = await second.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 32 });
  const replayStart = requests.length;
  const resumed = await second.api(`/api/jobs/${created.id}/resume`, { sourceId: reopened.sourceId });
  assert.equal(resumed.id, created.id, 'resumption retains task identity and cumulative accounting');
  assert(Math.abs(Date.now() - Date.parse(resumed.queuedAt)) < 5000, 'a resumed attempt records when it rejoins the queue');
  const completed = await finish(second, created.id);
  assert.equal(completed.status, 'completed', JSON.stringify(completed.error));
  assert(Date.parse(completed.startedAt) >= Date.parse(resumed.queuedAt), 'actual work starts only after admission from the queue');
  assert(completed.metrics.receivedBytes > before.metrics.receivedBytes, 'cumulative accounting cannot reset to the new process');
  assert.equal(completed.metrics.budgetBytes, 64 * CHUNK);
  assert(completed.metrics.receivedBytes <= completed.metrics.budgetBytes);
  const mediaRequests = requests.slice(replayStart).filter(request => request.end - request.start + 1 === CHUNK && request.start >= sourceStart && request.start < sourceEnd);
  assert(mediaRequests.length > 0);
  assert(mediaRequests.every(request => request.start >= sourceStart + CHUNK), 'the committed first target block must be reused from disk');
  assert(mediaRequests.every(request => request.ifMatch === '"resume-fixture-v1"'));
  assert((await stat(completed.result.candidatePath)).size > 0);
  await run('ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-i', completed.result.candidatePath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 45000 });
  assert(!(await persistedJson(path.join(root, 'state'))).includes(secret));
  await second.close();

  await t.test('a changed or missing strong ETag cannot bind an old checkpoint to a newly selected source', async () => {
    const { directory, job } = await interruptNewTask('identity-case');
    const app = await childServer(t, directory);
    for (const nextEtag of ['"resume-fixture-v2"', 'W/"resume-fixture-v1"', null]) {
      etag = nextEtag;
      const source = await app.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 32 });
      const start = requests.length;
      const failure = await rejectedResume(app, job.id, source.sourceId);
      assert.match(failure.code, /^(?:SOURCE_CHANGED|RESUME_(?:CHANGED|SOURCE_MISMATCH|IDENTITY_UNAVAILABLE))$/);
      assert.equal(requests.slice(start).filter(request => request.end - request.start + 1 === CHUNK
        && request.start >= sourceStart && request.start < sourceEnd).length, 0, 'identity rejection precedes target media requests');
    }
    await app.close();
  });

  await t.test('corrupted cached bytes are rejected and explicit discard removes only the checkpoint', async () => {
    const { directory, job } = await interruptNewTask('corruption-case');
    const cacheFiles = (await filesWithin(path.join(directory, 'state'))).filter(filename => filename.endsWith('.bin'));
    assert(cacheFiles.length > 0, 'a committed target block must exist before corruption');
    const bytes = await readFile(cacheFiles[0]); bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await writeFile(cacheFiles[0], bytes);
    const app = await childServer(t, directory);
    const source = await app.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 32 });
    const start = requests.length;
    const failure = await rejectedResume(app, job.id, source.sourceId);
    assert.equal(failure.code, 'RESUME_CORRUPT');
    assert.equal(requests.slice(start).filter(request => request.end - request.start + 1 === CHUNK
      && request.start >= sourceStart && request.start < sourceEnd).length, 0, 'local corruption stops before downloading target bytes');
    await app.api(`/api/jobs/${job.id}/discard-resume`, {});
    assert.equal((await filesWithin(path.join(directory, 'state'))).filter(filename => filename.endsWith('.bin')).length, 0);
    const after = await app.api(`/api/jobs/${job.id}/resume`, { sourceId: source.sourceId }, { allowError: true });
    assert(after.error, 'discarded state must not be recreated implicitly by a resume request');
    assert((await stat(completed.result.candidatePath)).size > 0, 'discard must leave earlier completed video files intact');
    await app.close();
  });

  await t.test('a near-cap resume budgets only the missing media ranges while retaining crash reservations', async () => {
    // Enough for the missing blocks plus the unresolved request charged in full,
    // but intentionally insufficient to download the entire window once again.
    const budgetMiB = (sourceEnd - sourceStart) / CHUNK + 1.5;
    const { directory, job } = await interruptNewTask('near-cap-case', budgetMiB);
    const app = await childServer(t, directory);
    const source = await app.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 32 });
    await app.api(`/api/jobs/${job.id}/resume`, { sourceId: source.sourceId });
    const done = await finish(app, job.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(done.metrics.budgetBytes, Math.floor(budgetMiB * CHUNK));
    assert(done.metrics.receivedBytes <= done.metrics.budgetBytes);
    assert((await stat(done.result.candidatePath)).size > 0);
    await app.close();
  });

  await t.test('normal shutdown preserves complete blocks and old export attempts are never overwritten', async () => {
    const { directory, job, before } = await interruptNewTask('graceful-case', 64, { graceful: true });
    // Reproduce a directory left by a process dying during local export. It may
    // also contain a fully committed movie that was not yet written to history.
    const priorOutput = path.join(directory, 'saved', job.id);
    await mkdir(priorOutput, { recursive: true });
    const sentinel = path.join(priorOutput, 'candidate.partial.mkv');
    const committed = path.join(priorOutput, 'candidate.mkv');
    await writeFile(sentinel, 'INTERRUPTED_EXPORT_MUST_REMAIN_UNTOUCHED');
    await writeFile(committed, 'PREVIOUS_EXPORT_MUST_NEVER_BE_OVERWRITTEN');
    const app = await childServer(t, directory);
    const restored = await app.api(`/api/jobs/${job.id}`);
    assert.equal(restored.status, 'cancelled');
    assert(restored.metrics.receivedBytes >= before.metrics.receivedBytes);
    assert(restored.resume.available);
    assert.equal(restored.resume.uncertainBytes, 0, 'normal settlement records actual received bytes rather than a crash reservation');
    const source = await app.api('/api/probe', { source: { type: 'http', value }, budgetMiB: 32 });
    const start = requests.length;
    await app.api(`/api/jobs/${job.id}/resume`, { sourceId: source.sourceId });
    const done = await finish(app, job.id);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.notEqual(path.dirname(done.result.candidatePath), priorOutput);
    assert.equal(await readFile(sentinel, 'utf8'), 'INTERRUPTED_EXPORT_MUST_REMAIN_UNTOUCHED');
    assert.equal(await readFile(committed, 'utf8'), 'PREVIOUS_EXPORT_MUST_NEVER_BE_OVERWRITTEN');
    assert(requests.slice(start).filter(request => request.end - request.start + 1 === CHUNK
      && request.start >= sourceStart && request.start < sourceEnd).every(request => request.start >= sourceStart + CHUNK));
    await run('ffmpeg', ['-v', 'error', '-xerror', '-nostdin', '-i', done.result.candidatePath, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-'], { timeout: 45000 });
    await app.close();
  });
  } finally {
    // Register this last so server/child cleanup also finishes first on failure.
    t.after(() => rm(root, { recursive: true, force: true }));
  }
});
