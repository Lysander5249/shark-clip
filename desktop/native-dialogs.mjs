import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

// Private parent/child stdio channel. It exposes no JavaScript bridge to pages.
export function createNativeDialogs({ input, output, timeoutMs = 300000 }) {
  const pending = new Map();
  let closed = false;
  const reader = createInterface({ input, crlfDelay: Infinity });
  const finish = (id, value) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id); clearTimeout(entry.timer); entry.resolve(value);
  };
  const cancelAll = () => { closed = true; for (const id of pending.keys()) finish(id, null); };
  reader.on('close', cancelAll);
  reader.on('line', line => {
    if (line.length > 16384) return;
    try {
      const data = JSON.parse(line);
      if (!pending.has(data.id)) return;
      if (data.path === null) finish(data.id, null);
      else if (typeof data.path === 'string' && data.path.length <= 8192 && !data.path.includes('\0') && path.isAbsolute(data.path)) finish(data.id, data.path);
    } catch { /* Ignore malformed or unrelated native responses. */ }
  });
  return {
    request(kind) {
      if (!['file', 'directory'].includes(kind)) throw new Error('Invalid native dialog kind');
      if (closed || pending.size) return Promise.resolve(null);
      return new Promise(resolve => {
        const id = randomUUID();
        const timer = setTimeout(() => finish(id, null), timeoutMs);
        pending.set(id, { resolve, timer });
        output.write(`CLIP_FETCHER_NATIVE_REQUEST=${JSON.stringify({ id, kind })}\n`);
      });
    },
    close() { cancelAll(); reader.close(); },
  };
}
