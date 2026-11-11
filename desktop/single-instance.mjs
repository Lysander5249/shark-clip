import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';

const digest = value => createHash('sha256').update(value).digest('hex');
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}
function localUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && Number(url.port) > 0 && !url.username && !url.password && !url.search && !url.hash && ['/', ''].includes(url.pathname) ? url.origin : null;
  } catch { return null; }
}

// A bound local socket is the actual lock. The OS releases it after a crash,
// so stale PID files, PID reuse and two simultaneous launches cannot grant two
// writers access to one data directory. The small JSON file only locates an
// already running panel; it contains a hash of its session token, never the token.
export async function acquireDesktopInstance({ dataDir }) {
  const directory = path.resolve(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'desktop-instance.json');
  const identity = digest(process.platform === 'win32' ? directory.toLowerCase() : directory);
  const port = 49152 + Number.parseInt(identity.slice(0, 6), 16) % 16384;
  const address = process.platform === 'win32'
    ? { path: '\\\\.\\pipe\\ClipFetcher-' + identity }
    : { port, host: '127.0.0.1' };
  const server = net.createServer(socket => { socket.on('error', () => {}); socket.end(); });
  let bound = false;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen({ ...address, exclusive: true }, () => { server.removeListener('error', reject); resolve(); });
    });
    bound = true;
  } catch (error) {
    if (error.code !== 'EADDRINUSE') throw error;
    let record;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        const info = await stat(filename);
        if (info.size > 4096) break;
        record = JSON.parse(await readFile(filename, 'utf8'));
        if (record.identity === identity && alive(record.pid)) break;
      } catch { /* A first launch may still be writing its initial record. */ }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (record?.identity !== identity || !alive(record.pid)) throw new Error('工具的本机启动通道被占用，请稍后再打开。');
    if (!record.url) return { alreadyRunning: true, url: null };
    const url = localUrl(record.url);
    if (!url || typeof record.sessionHash !== 'string') throw new Error('另一个片段取材实例仍在启动，请稍后再打开。');
    try {
      const response = await fetch(url + '/api/bootstrap', { signal: AbortSignal.timeout(2500) });
      const data = await response.json();
      if (!response.ok || typeof data.sessionToken !== 'string' || digest(data.sessionToken) !== record.sessionHash) throw new Error('identity');
    } catch { throw new Error('已有片段取材进程正在运行，但面板暂时无响应。请退出已有应用后再打开。'); }
    return { alreadyRunning: true, url };
  }
  const nonce = randomBytes(16).toString('hex');
  const record = { identity, nonce, pid: process.pid, startedAt: new Date().toISOString(), url: null };
  const writeRecord = async () => {
    const temporary = `${filename}.${nonce}.tmp`;
    await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await rename(temporary, filename);
  };
  try { await writeRecord(); } catch (error) { if (bound) await new Promise(resolve => server.close(resolve)); throw error; }
  let released = false;
  return {
    alreadyRunning: false,
    async ready(url, sessionToken) {
      const safe = localUrl(url);
      if (!safe || typeof sessionToken !== 'string') throw new Error('Invalid instance record');
      record.url = safe;
      record.sessionHash = digest(sessionToken);
      await writeRecord();
    },
    async release() {
      if (released) return;
      released = true;
      try {
        const current = JSON.parse(await readFile(filename, 'utf8'));
        if (current.nonce === nonce) await rm(filename, { force: true });
      } finally { await new Promise(resolve => server.close(resolve)); }
    },
  };
}
