import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';

export function createLocalMediaRegistry() {
  const assets = new Map(), paths = new Map();
  return {
    async register(filename) {
      const resolved = await realpath(filename);
      if (!resolved.toLowerCase().endsWith('.mp4')) return undefined;
      if (paths.has(resolved)) return paths.get(resolved);
      const info = await stat(resolved);
      if (!info.isFile() || info.size < 1) return undefined;
      const key = randomBytes(24).toString('hex');
      const url = `/api/local-media/${key}`;
      assets.set(key, { filename: resolved, size: info.size, mtimeMs: info.mtimeMs });
      paths.set(resolved, url);
      return url;
    },
    async serve(req, res, key) {
      const asset = assets.get(key);
      if (!asset || !['GET', 'HEAD'].includes(req.method)) { res.writeHead(404); res.end(); return; }
      let info;
      try { info = await stat(asset.filename); } catch {}
      if (!info?.isFile() || info.size !== asset.size || info.mtimeMs !== asset.mtimeMs) { res.writeHead(404); res.end(); return; }
      let start = 0, end = info.size - 1;
      const range = req.headers.range;
      if (range) {
        const match = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!match || (!match[1] && !match[2])) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
        if (!match[1]) { start = Math.max(0, info.size - Number(match[2])); }
        else { start = Number(match[1]); if (match[2]) end = Math.min(Number(match[2]), end); }
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= info.size) { res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); res.end(); return; }
      }
      res.writeHead(range ? 206 : 200, { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1, 'Cache-Control': 'no-store', ...(range ? { 'Content-Range': `bytes ${start}-${end}/${info.size}` } : {}) });
      if (req.method === 'HEAD') { res.end(); return; }
      const stream = createReadStream(asset.filename, { start, end });
      stream.on('error', () => res.destroy());
      res.once('close', () => stream.destroy());
      stream.pipe(res);
    },
    clear() { assets.clear(); paths.clear(); },
  };
}
