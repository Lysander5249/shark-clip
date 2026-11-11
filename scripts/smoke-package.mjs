import path from 'node:path';
import os from 'node:os';
import { mkdtemp, rm, stat, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';

const input = process.argv[2];
if (!input) throw new Error('Usage: node scripts/smoke-package.mjs path/to/app-or-portable-folder');
const packageRoot = path.resolve(input);
const root = packageRoot.endsWith('.app') ? path.join(packageRoot, 'Contents/Resources/app') : path.join(packageRoot, 'app');
const temp = await mkdtemp(path.join(os.tmpdir(), 'clip-fetcher-smoke-'));
const suffix = process.platform === 'win32' ? '.exe' : '';
const windows = process.platform === 'win32';
const outputDir = path.join(temp, windows ? '片段 素材' : 'exports');
const child = spawn(path.join(root, 'bin', 'node' + suffix), [path.join(root, 'desktop/main.mjs')], {
  env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', CLIP_FETCHER_OUTPUT_DIR: outputDir, CLIP_FETCHER_DATA_DIR: path.join(temp, 'state') }, stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
child.stderr.on('data', data => { stderr = (stderr + data.toString()).slice(-2000); });
try {
  const url = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Packaged service startup timed out')), 30000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Packaged service exited (${code}): ${stderr}`)); });
    child.stdout.on('data', data => {
      buffer += data.toString();
      const match = /^CLIP_FETCHER_URL=(http:\/\/127\.0\.0\.1:\d+)\r?$/m.exec(buffer);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const initial = await fetch(url + '/api/bootstrap').then(response => response.json());
  if (!initial.sessionToken || !initial.dependencies?.ffmpeg?.available || !initial.dependencies?.ffprobe?.available) throw new Error('Bundled media tools not available');
  if (windows) {
    const bookmark = await fetch(url + '/api/bookmark-capture/state').then(response => response.json());
    const expectedProviders = new Map([
      ['windows-edge-xunlei', 'xunlei'],
      ['windows-edge-cloud', 'xunlei,baidu'],
    ]).get(initial.edition);
    if (!expectedProviders || initial.providers?.map(provider => provider.id).join(',') !== expectedProviders
        || bookmark.edition !== initial.edition || !bookmark.available || !bookmark.bookmarklet?.startsWith('javascript:')) {
      throw new Error('The Windows package did not enable its Edge bookmark flow and expected cloud providers');
    }
  }
  const api = async (route, data) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Session-Token': initial.sessionToken }, body: JSON.stringify(data) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || `HTTP ${response.status}`);
    return result;
  };
  const source = await api('/api/probe', { source: { type: 'local', value: path.join(root, 'examples/示例视频.mkv') }, budgetMiB: 256 });
  const settings = { start: 3, end: 6, handles: 1, outputDir, makeMp4: true, budgetMiB: 256 };
  const created = windows
    ? (await api('/api/jobs/batch', { sourceId: source.sourceId, clientBatchId: randomBytes(16).toString('hex'),
      jobs: [{ ...settings, clipName: '第一段 取材' }, { ...settings, start: 7, end: 9, clipName: '第二段 取材', makeMp4: false }] })).jobs
    : [await api('/api/jobs', { sourceId: source.sourceId, ...settings })];
  const ids = created.map(job => job.id);
  if (ids.length !== (windows ? 2 : 1) || ids.some(id => !id)) throw new Error('No job returned by packaged service');
  let jobs;
  for (let attempt = 0; attempt < 120; attempt++) {
    jobs = await Promise.all(ids.map(id => fetch(`${url}/api/jobs/${id}`).then(response => response.json())));
    if (jobs.every(job => ['completed', 'failed', 'cancelled'].includes(job.status))) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  for (const job of jobs || []) {
    if (job.status !== 'completed') throw new Error(`Packaged export did not complete: ${job.error?.message || job.message || job.status}`);
    if (!job.result?.candidatePath || !(await stat(job.result.candidatePath)).size) throw new Error('Packaged MKV output missing');
  }
  const [job, next] = jobs;
  if (windows && !(Date.parse(next.startedAt) >= Date.parse(job.finishedAt))) throw new Error('The Windows package did not process the batch in order');
  for (const file of [job.result.candidatePath, job.result.sidecarPath, job.result.compatiblePath]) if (!file || !(await stat(file)).size) throw new Error('Packaged output missing');
  const manifest = await readFile(job.result.sidecarPath, 'utf8');
  if (manifest.includes('password') || manifest.includes('sessionToken')) throw new Error('Sensitive field in candidate manifest');
  console.log(JSON.stringify({ status: 'passed', platform: process.platform, arch: process.arch, version: initial.version,
    ...(windows ? { edition: initial.edition, cloudProviders: initial.providers.map(provider => provider.id), sequentialBatchAndChineseOutput: true } : {}),
    candidate: 'MKV stream copy', derivative: 'MP4 video copy + AAC', cloudAccountTested: false, nativeWindowTested: false }));
} finally {
  if (child.exitCode === null) {
    child.kill('SIGTERM');
    await Promise.race([once(child, 'exit'), new Promise(resolve => setTimeout(resolve, 6000))]);
    if (child.exitCode === null) child.kill('SIGKILL');
  }
  await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
