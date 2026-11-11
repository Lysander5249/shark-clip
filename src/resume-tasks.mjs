import path from 'node:path';
import { sanitizeClipName } from '../public/clip-options.mjs';
import { mkdir, open, rename, readFile, stat, rm } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';

const idPattern = /^[a-zA-Z0-9-]{1,80}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const fail = () => Object.assign(new Error('续传任务记录无效，请清除这份缓存后重新取片。'), { code: 'RESUME_METADATA_INVALID' });
export const resumeSourceKey = (type, url, username = '') => createHash('sha256').update(JSON.stringify([type, url, username])).digest('hex');
export function resumeWindowPlan(window) {
  return { version: 1, sourceStart: window.sourceStart, sourceEnd: window.sourceEnd,
    prefixSha256: createHash('sha256').update(window.prefix).digest('hex'),
    timelineStartSeconds: window.timelineStartSeconds, timelineEndSeconds: window.timelineEndSeconds };
}

// Only the source digest and explicit task settings survive a restart. Original
// links, account names, passwords, cookies and remote objects never enter JSON.
export function resumeTaskRecord(job) {
  if (!job || typeof job.id !== 'string' || !idPattern.test(job.id)
      || typeof job.sourceKey !== 'string' || !hashPattern.test(job.sourceKey)) throw fail();
  const p = job.params;
  if (!p || !['start', 'end', 'handles', 'fetchStart', 'fetchEnd'].every(k => Number.isFinite(p[k]))
      || p.start < 0 || p.end <= p.start || p.handles < 0 || p.handles > 600
      || p.fetchStart < 0 || p.fetchEnd <= p.fetchStart || p.fetchEnd - p.fetchStart > 600
      || typeof p.outputDir !== 'string' || !path.isAbsolute(p.outputDir) || p.outputDir.includes('\0')
      || !Number.isSafeInteger(p.budgetBytes) || p.budgetBytes < 1 || p.budgetBytes > 65536 * 1024 * 1024
      || (p.readMode !== undefined && !['standard', 'continuous', 'parallel'].includes(p.readMode))
      || (p.reuseIndex !== undefined && typeof p.reuseIndex !== 'boolean')
      || (p.clipName !== undefined && (typeof p.clipName !== 'string' || !p.clipName || sanitizeClipName(p.clipName) !== p.clipName))
      || (p.subtitleStreamIndex !== undefined && (!Number.isSafeInteger(p.subtitleStreamIndex) || p.subtitleStreamIndex < 0))
      || (p.audioStreamIndex !== undefined && p.audioStreamIndex !== null && (!Number.isSafeInteger(p.audioStreamIndex) || p.audioStreamIndex < 0))) throw fail();
  return { schemaVersion: 1, id: job.id, sourceKey: job.sourceKey,
    sourceLabel: String(job.sourceLabel || '云盘视频').replace(/[\u0000-\u001f]/g, '').slice(0, 160),
    createdAt: typeof job.createdAt === 'string' ? job.createdAt.slice(0, 40) : undefined,
    resumeCount: Number.isSafeInteger(job.resumeCount) && job.resumeCount >= 0 ? Math.min(job.resumeCount, 1000000) : 0,
    params: { start: p.start, end: p.end, handles: p.handles, fetchStart: p.fetchStart, fetchEnd: p.fetchEnd,
      outputDir: p.outputDir, budgetBytes: p.budgetBytes, makeMp4: p.makeMp4 === true,
      ...(p.clipName !== undefined ? { clipName: p.clipName } : {}),
      ...(p.subtitleStreamIndex !== undefined ? { subtitleStreamIndex: p.subtitleStreamIndex } : {}),
      ...(p.audioStreamIndex !== undefined ? { audioStreamIndex: p.audioStreamIndex } : {}),
      ...(p.readMode !== undefined ? { readMode: p.readMode } : {}),
      ...(p.reuseIndex !== undefined ? { reuseIndex: p.reuseIndex } : {}) } };
}

export async function createResumeTaskStore(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = id => { if (!idPattern.test(id || '')) throw fail(); return path.join(directory, id + '.json'); };
  return {
    async save(job) {
      const record = resumeTaskRecord(job), target = filename(record.id), temporary = target + '.' + randomUUID() + '.tmp';
      let handle;
      try {
        handle = await open(temporary, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(record)); await handle.sync(); await handle.close(); handle = null;
        await rename(temporary, target);
        let parent;
        try { parent = await open(directory, 'r'); await parent.sync(); }
        catch (e) { if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(e.code)) throw e; }
        finally { await parent?.close(); }
      } finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }); }
      return record;
    },
    async load(id) {
      try {
        const file = filename(id);
        if ((await stat(file)).size > 16384) throw fail();
        const value = JSON.parse(await readFile(file, 'utf8'));
        if (value.schemaVersion !== 1 || value.id !== id) throw fail();
        return resumeTaskRecord(value);
      } catch (e) { if (e.code === 'ENOENT') return null; throw fail(); }
    },
    async discard(id) { await rm(filename(id), { force: true }); },
  };
}
