import { spawn } from 'node:child_process';

const XML_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
const CONTROL = /\p{Cc}/u;
const result = (code, status = null) => ({ client: 'system-curl', status, code });

function safeUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || CONTROL.test(value) || /[\\?#]/.test(value)) throw new Error('Invalid target');
  const match = /^https?:\/\/([^/]*)(\/.*)?$/i.exec(value);
  if (!match || match[1].includes('@')) throw new Error('Invalid target');
  const rawPath = match[2] || '/';
  for (const part of rawPath.split('/')) {
    let decoded = part;
    for (let i = 0; i < 8; i++) {
      decoded = decodeURIComponent(decoded);
      if (decoded === '.' || decoded === '..' || /[/\\]/.test(decoded) || CONTROL.test(decoded)) throw new Error('Invalid target');
      if (!/%[a-f0-9]{2}/i.test(decoded)) break;
      if (i === 7) throw new Error('Invalid target');
    }
  }
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) throw new Error('Invalid target');
  if (url.pathname !== '/dav' && !url.pathname.startsWith('/dav/')) throw new Error('Invalid target');
  return url.href;
}

function quote(value) {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

// This separate client checks authentication only. Credentials go through the
// child's stdin, never command arguments, files, output or application errors.
export async function diagnoseDavAuth({ url, username = '', password = '', signal } = {}) {
  if (signal?.aborted) return result('CANCELLED');
  let config;
  try {
    if (typeof username !== 'string' || typeof password !== 'string' || username.length > 8192 || password.length > 8192 || CONTROL.test(username) || CONTROL.test(password) || username.includes(':')) throw new Error('Invalid credentials');
    config = `url = ${quote(safeUrl(url))}\nuser = ${quote(`${username}:${password}`)}\n`;
  } catch { return result('TRANSPORT_ERROR'); }

  return new Promise(resolve => {
    let child, timer, done = false, stdout = '', outputBytes = 0;
    function finish(value) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve(value);
    }
    function stop(code) {
      child?.kill();
      finish(result(code));
    }
    function abort() { stop('CANCELLED'); }
    try {
      child = spawn(process.platform === 'win32' ? 'curl.exe' : '/usr/bin/curl', [
        '-q', '--config', '-', '--globoff', '--noproxy', '*', '--basic',
        '--request', 'PROPFIND', '--header', 'Depth: 0',
        '--header', 'Accept-Encoding: identity',
        '--header', 'Content-Type: application/xml; charset=utf-8',
        '--data-binary', XML_BODY, '--output', process.platform === 'win32' ? 'NUL' : '/dev/null',
        '--max-filesize', '1048576', '--max-time', '8', '--connect-timeout', '3',
        '--silent', '--write-out', '%{http_code}',
      ], { shell: false, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch { finish(result('UNAVAILABLE')); return; }
    child.on('error', error => finish(result(error.code === 'ENOENT' ? 'UNAVAILABLE' : 'TRANSPORT_ERROR')));
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 1024) { stop('TRANSPORT_ERROR'); return; }
      stdout += chunk.toString('ascii');
    });
    child.on('close', exitCode => {
      if (exitCode === 28) { finish(result('TIMEOUT')); return; }
      const status = /^([1-5][0-9]{2})$/.exec(stdout.trim());
      finish(exitCode === 0 && status ? result('HTTP_RESPONSE', Number(status[1])) : result('TRANSPORT_ERROR'));
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    timer = setTimeout(() => stop('TIMEOUT'), 9000);
    child.stdin.end(config, 'utf8');
    config = null;
  });
}
