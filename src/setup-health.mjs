import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';

export const DEFAULT_DAV_URL = 'http://127.0.0.1:29798/dav/';
const REQUEST_BODY = '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:resourcetype/></d:prop></d:propfind>';
const unsupportedAddress = () => ({ status: 'unsupported_address', code: 'DAV_ADDRESS_UNSUPPORTED',
  message: '请填写本机 CloudDrive2 的 HTTP 或 HTTPS 地址，不要包含账号、密码、查询参数或片段。' });
const unavailable = (code = 'DAV_LOCAL_UNAVAILABLE', message = '本机 WebDAV 未响应，请启动 CloudDrive2 并核对 WebDAV 地址与端口。') => ({ status: 'unavailable', code, message });
const cancelled = () => Object.assign(new Error('本机检查已停止。'), { code: 'CANCELLED' });
const abortIfNeeded = signal => { if (signal?.aborted) throw cancelled(); };

export function setupPlatform(os = process.platform, arch = process.arch) {
  return { os, arch, supportedTarget: os === 'darwin' && arch === 'arm64' || os === 'win32' && arch === 'x64' };
}

function freeBytesFrom(info) {
  if (typeof info?.bavail === 'bigint' && typeof info.bsize === 'bigint') {
    const bytes = info.bavail * info.bsize;
    return bytes >= 0n && bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : null;
  }
  const bytes = info?.bavail * info?.bsize;
  return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes : null;
}

/** A local reversible write check; removes only the unique file it created. */
export async function checkOutputDirectory(outputDir, { signal, filesystem = fs } = {}) {
  if (typeof outputDir !== 'string' || !outputDir || outputDir.length > 8192 || !path.isAbsolute(outputDir)
      || /[\u0000-\u001f\u007f-\u009f]/u.test(outputDir)) {
    return { status: 'error', code: 'OUTPUT_INVALID', message: '保存目录需要有效的完整本地路径。', freeBytes: null };
  }
  abortIfNeeded(signal);
  const probe = path.join(outputDir, `.clip-fetcher-write-check-${randomUUID()}`);
  let handle, owned = false, failure = null, cleanupFailed = false;
  try {
    await filesystem.mkdir(outputDir, { recursive: true });
    abortIfNeeded(signal);
    if (!(await filesystem.stat(outputDir)).isDirectory()) throw new Error('not a directory');
    handle = await filesystem.open(probe, 'wx', 0o600);
    owned = true;
    await handle.writeFile('');
    await handle.close(); handle = null;
    abortIfNeeded(signal);
  } catch (error) { failure = error; }
  finally {
    if (handle) { try { await handle.close(); } catch { cleanupFailed = true; } }
    if (owned) { try { await filesystem.unlink(probe); } catch { cleanupFailed = true; } }
  }
  if (cleanupFailed) return { status: 'error', code: 'OUTPUT_CLEANUP_FAILED',
    message: '保存位置检查的临时文件未能清理，请检查目录权限后重试。', freeBytes: null };
  if (failure?.code === 'CANCELLED' || signal?.aborted) throw cancelled();
  if (failure) return { status: 'error', code: 'OUTPUT_NOT_WRITABLE',
    message: '无法写入保存目录，请选择其他文件夹，或检查权限和剩余空间。', freeBytes: null };
  let freeBytes = null;
  try { freeBytes = freeBytesFrom(await filesystem.statfs(outputDir, { bigint: true })); }
  catch { /* Unknown space is not zero space and does not negate a successful write. */ }
  abortIfNeeded(signal);
  if (freeBytes === 0) return { status: 'error', code: 'OUTPUT_NO_SPACE',
    message: '保存位置当前没有可用空间，请腾出空间或选择其他文件夹。', freeBytes };
  return { status: 'ready', code: 'OUTPUT_READY',
    message: freeBytes === null ? '保存目录可写；系统暂未提供可用空间。' : '保存目录可写；可用空间为当前检查值，取片前仍需预留足够空间。', freeBytes };
}

function localDavAddress(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\u0000-\u0020\u007f\\]/u.test(value)
      || value.includes('?') || value.includes('#')) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
      || url.username || url.password) return null;
  return url;
}

/** Depth:0, no authentication, no redirects, and no directory/body collection. */
export async function checkCloudDrive(davUrl = DEFAULT_DAV_URL, { signal } = {}) {
  const url = localDavAddress(davUrl);
  if (!url) return unsupportedAddress();
  if (signal?.aborted) return unavailable('CANCELLED', '本机 WebDAV 检查已停止。');
  return new Promise(resolve => {
    let request, response, timer, settled = false;
    const finish = result => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      response?.destroy(); request?.destroy(); resolve(result);
    };
    const abort = () => finish(unavailable('CANCELLED', '本机 WebDAV 检查已停止。'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) { abort(); return; }
    timer = setTimeout(() => finish(unavailable('DAV_LOCAL_TIMEOUT', '本机 WebDAV 在 2 秒内没有返回响应，请检查 CloudDrive2 是否运行。')), 2000);
    timer.unref?.();
    try {
      const transport = url.protocol === 'https:' ? https : http;
      request = transport.request(url, { method: 'PROPFIND', autoSelectFamily: false,
        ...(url.hostname === 'localhost' ? { lookup: (_host, _options, callback) => callback(null, '127.0.0.1', 4) } : {}),
        headers: { Depth: '0', 'Accept-Encoding': 'identity', 'Content-Type': 'application/xml; charset=utf-8',
          'Content-Length': Buffer.byteLength(REQUEST_BODY), 'User-Agent': 'ClipFetcher/0.3' } }, res => {
        response = res;
        if ([401, 403, 207].includes(res.statusCode)) finish({ status: 'responding', code: 'DAV_LOCAL_RESPONDING',
          message: '本机 WebDAV 地址已有响应；尚未验证账号登录、云盘目录或影片读取能力。' });
        else if ([301, 302, 303, 307, 308].includes(res.statusCode)) finish(unavailable('DAV_LOCAL_REDIRECT', '本机地址要求跳转；检查不会跟随跳转，请填写直接的 WebDAV 地址。'));
        else finish(unavailable());
      });
      request.once('error', () => finish(unavailable()));
      request.end(REQUEST_BODY);
    } catch { finish(unavailable()); }
  });
}
