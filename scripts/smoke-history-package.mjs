import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { hashFile } from './build-common.mjs';

const version = '0.3.24-preview.1';
assert(process.argv[2], 'Usage: node scripts/smoke-history-package.mjs <built .app>');
const application = await realpath(process.argv[2]);
const code = path.join(application, 'Contents/Resources/app');
const pkg = JSON.parse(await readFile(path.join(code, 'package.json'), 'utf8'));
assert.equal(pkg.version, version);
const binary = name => path.join(code, 'bin', name);
const exec = promisify(execFile);
const scratch = await mkdtemp(path.join(os.tmpdir(), 'clip-history-package-'));
const dataDir = path.join(scratch, 'state');
const outputDir = path.join(scratch, 'outputs');

async function launchDesktop() {
  // The packaged desktop entry point uses its bundled tools and single-instance
  // lock. Explicit directories keep both runs separate from the user's app.
  const child = spawn(binary('node'), [path.join(code, 'desktop/main.mjs')], {
    cwd: scratch,
    env: {
      PATH: '/usr/bin:/bin',
      TMPDIR: scratch,
      CLIP_FETCHER_NATIVE_DIALOGS: '0',
      CLIP_FETCHER_OUTPUT_DIR: outputDir,
      CLIP_FETCHER_DATA_DIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  const stopped = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  async function stop() {
    let timer;
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      timer = setTimeout(() => child.kill('SIGKILL'), 8000).unref();
    }
    try { return await stopped; }
    finally { clearTimeout(timer); }
  }
  let timer;
  try {
    const started = new Promise((resolve, reject) => {
      let stdout = '';
      timer = setTimeout(() => reject(new Error(`Packaged desktop did not start: ${stderr}`)), 30000);
      child.stdout.on('data', chunk => {
        stdout = (stdout + chunk).slice(-4000);
        const ready = /^CLIP_FETCHER_URL=(http:\/\/127\.0\.0\.1:\d+)\r?\n/m.exec(stdout);
        if (ready) resolve(ready[1]);
      });
    });
    const exitedEarly = stopped.then(({ code, signal, error }) => {
      throw error || new Error(`Packaged desktop exited before startup (${code ?? signal}): ${stderr}`);
    });
    return { url: await Promise.race([started, exitedEarly]), stop };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function request(url, route, { body, token, expected = 200 } = {}) {
  const response = await fetch(url + route, {
    redirect: 'error',
    signal: AbortSignal.timeout(20000),
    ...(body === undefined ? {} : {
      method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json', 'X-Session-Token': token },
      body: JSON.stringify(body),
    }),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${route}: ${data.error?.code || ''} ${data.error?.message || ''}`);
  return data;
}

async function connect({ url }) {
  const boot = await request(url, '/api/bootstrap');
  assert.equal(boot.version, version);
  assert.equal(boot.defaults.handles, 5);
  assert.equal(boot.defaults.outputDir, outputDir);
  assert.equal(boot.defaults.samplePath, path.join(code, 'examples/示例视频.mkv'));
  return { boot, api: (route, options) => request(url, route, { token: boot.sessionToken, ...options }) };
}

async function waitForBatch(api, ids) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const queue = await api('/api/jobs/queue');
    if (!queue.activeJob && queue.queuedJobs.length === 0) {
      const byId = new Map(queue.recentJobs.map(job => [job.id, job]));
      if (ids.every(id => byId.has(id))) return ids.map(id => byId.get(id));
    }
    await delay(50);
  }
  assert.fail('The packaged queue did not settle within one minute.');
}

async function exportedFiles(directory) {
  const names = (await readdir(directory)).sort();
  return Promise.all(names.map(async name => {
    const filename = path.join(directory, name);
    const info = await stat(filename);
    assert(info.isFile() && info.size > 0, `Export is missing or empty: ${name}`);
    return { name, sha256: await hashFile(filename) };
  }));
}

async function assertHistory(api, kept, removedId) {
  const expected = kept.map(job => job.id).sort();
  const queue = await api('/api/jobs/queue');
  const history = await api('/api/jobs/history');
  assert.equal(queue.activeJob, null);
  assert.deepEqual(queue.queuedJobs, []);
  assert.deepEqual(queue.recentJobs.map(job => job.id).sort(), expected);
  assert.deepEqual(history.jobs.map(job => job.id).sort(), expected);
  const missing = await api(`/api/jobs/${removedId}`, { expected: 404 });
  assert.equal(missing.error.code, 'JOB_MISSING');
  for (const original of kept) {
    const restored = history.jobs.find(job => job.id === original.id);
    assert.equal(restored.status, 'completed');
    assert.deepEqual(restored.requested, original.requested);
    assert.equal(restored.result.candidatePath, original.result.candidatePath);
    assert((await stat(restored.result.candidatePath)).size > 0);
  }
}

let desktop;
try {
  desktop = await launchDesktop();
  const { boot, api } = await connect(desktop);
  const page = await fetch(`${desktop.url}/`, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  assert.equal(page.status, 200);
  const handlesInput = /<input\b[^>]*\bid="handles"[^>]*>/.exec(await page.text())?.[0] || '';
  assert.match(handlesInput, /\bvalue="5"/, 'The packaged page must also start at five seconds.');

  const probe = await api('/api/probe', { body: { source: { type: 'local', value: boot.defaults.samplePath } } });
  assert(probe.media.duration >= 13, 'The local sample must cover the default handles test.');
  const token = () => randomBytes(16).toString('hex');
  const jobs = [
    { clipName: '顺序测试一', start: 6, end: 8 },
    { clipName: '顺序测试二', start: 3, end: 5, handles: 1, makeMp4: true },
    { clipName: '顺序测试三', start: 9, end: 10, handles: 0 },
  ].map(job => ({ ...job, clientItemId: token() }));
  const batch = { sourceId: probe.sourceId, clientBatchId: token(), jobs };
  const submit = () => api('/api/jobs/batch', { body: batch, expected: 202 });
  const created = await submit();
  assert.deepEqual(created.jobs.map(job => job.clientItemId), jobs.map(job => job.clientItemId));
  assert(created.jobs.slice(1).every(job => job.status === 'queued' && !job.startedAt));
  const done = await waitForBatch(api, created.jobs.map(job => job.id));
  for (const [index, job] of done.entries()) {
    assert.equal(job.status, 'completed', JSON.stringify(job.error));
    assert(Date.parse(job.queuedAt) <= Date.parse(job.startedAt));
    assert(Date.parse(job.startedAt) <= Date.parse(job.finishedAt));
    if (index > 0) assert(Date.parse(done[index - 1].finishedAt) <= Date.parse(job.startedAt));
    assert((await stat(job.result.candidatePath)).size > 0);
  }
  assert.deepEqual(done.map(job => job.requested.handles), [5, 1, 0]);
  assert.deepEqual(done.map(job => job.result.fetched), [{ start: 1, end: 13 }, { start: 2, end: 6 }, { start: 9, end: 10 }]);

  const [first, removed, last] = done;
  const kept = [first, last];
  const folder = path.dirname(removed.result.candidatePath);
  assert(removed.result.compatiblePath, 'The deleted record should include an MP4 work copy.');
  const originals = await exportedFiles(folder);
  for (const file of [removed.result.candidatePath, removed.result.compatiblePath]) {
    await exec(binary('ffmpeg'), ['-v', 'error', '-xerror', '-i', file, '-map', '0:v:0', '-an', '-sn', '-f', 'null', '-'], { timeout: 30000 });
  }

  const deleted = await api(`/api/jobs/${removed.id}/delete-history`, { body: {} });
  assert.deepEqual(deleted, { ok: true, id: removed.id });
  const retried = await submit();
  assert.deepEqual(retried.jobs.map(job => job.id), kept.map(job => job.id));
  await assertHistory(api, kept, removed.id);
  assert.deepEqual(await exportedFiles(folder), originals);
  const saved = JSON.parse(await readFile(path.join(dataDir, 'tasks.json'), 'utf8'));
  assert.deepEqual(saved.jobs.map(job => job.id).sort(), kept.map(job => job.id).sort());

  assert.equal((await desktop.stop()).code, 0);
  desktop = await launchDesktop();
  const restarted = await connect(desktop);
  assert.notEqual(restarted.boot.sessionToken, boot.sessionToken);
  await assertHistory(restarted.api, kept, removed.id);
  assert.deepEqual(await exportedFiles(folder), originals);
  assert.deepEqual((await readdir(outputDir)).sort(), jobs.map(job => job.clipName).sort());
  assert.equal((await desktop.stop()).code, 0);
  desktop = null;

  console.log(JSON.stringify({
    status: 'passed', version,
    scope: 'packaged desktop Node entry point and bundled FFmpeg/ffprobe with the local example',
    defaultHandlesSeconds: 5,
    explicitHandlesHonored: true,
    initiallyQueuedItems: 3,
    serialOrderVerified: true,
    deletedTerminalHistory: true,
    deletedRecordExportsByteIdentical: true,
    batchRetryDidNotRestoreDeletedJob: true,
    deletedRecordAbsentAfterRestart: true,
    otherRecordsPreservedAfterRestart: true,
    realCloudTested: false,
  }));
} finally {
  await desktop?.stop();
  await rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
}
