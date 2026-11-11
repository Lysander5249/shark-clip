import { constants } from 'node:fs';
import { open, writeFile, rename, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeClipName } from '../public/clip-options.mjs';
import { randomUUID } from 'node:crypto';
import { jobMetrics } from './job-metrics.mjs';
import { sanitizeTaskDiagnostics } from './task-diagnostics.mjs';

const terminal = new Set(['completed', 'failed', 'cancelled']);
const HISTORY_RECORD_LIMIT = 100;
// Leave room for legacy pretty-printed histories with full diagnostics.
// The same byte limit applies before committing a new compact history.
const HISTORY_BYTE_LIMIT = 16 * 1024 * 1024;
const subtitleMessages = Object.freeze({
  SUBTITLE_CUT_BOUNDARY: '字幕按成品时间保存；跨取材起点的长字幕可能未包含，请检查字幕首尾。',
  SUBTITLE_IMAGE_FORMAT: '所选轨道是图片字幕，已独立保存原格式；需要支持此格式的播放器，不能直接作为可编辑文字导入。',
  SUBTITLE_STYLE_SIMPLIFIED: 'ASS 字幕已导出为可编辑 SRT，字体、位置和特效样式未保留。',
  SUBTITLE_EMPTY_RANGE: '该片段已读取的数据中没有所选字幕条目；视频已保留。',
  SUBTITLE_EXPORT_FAILED: '独立字幕未能完成导出，视频已保留；可更换字幕轨道后重试。',
});
const text = value => typeof value === 'string' ? value.slice(0, 4096) : undefined;
const absolute = value => typeof value === 'string' && path.isAbsolute(value) && !value.includes('\0') ? value : undefined;
const opaqueId = value => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : undefined;
const taskId = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value) ? value : undefined;
const sourceDigest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
const requestedRange = value => value && typeof value === 'object' && [value.start, value.end, value.handles].every(Number.isFinite) && value.start >= 0 && value.end > value.start && value.handles >= 0 && value.handles <= 600
  ? { start: value.start, end: value.end, handles: value.handles } : undefined;
const streamIndex = value => Number.isSafeInteger(value) && value >= 0;

export function retrySubtitleTrack(track) {
  return {
    codec: typeof track?.codec === 'string' && /^[a-z0-9_]{1,40}$/i.test(track.codec) ? track.codec.toLowerCase() : null,
    language: typeof track?.language === 'string' && /^[a-z0-9_-]{1,32}$/i.test(track.language) ? track.language.toLowerCase() : null,
  };
}

// Keep extraction settings separate from source handles. A null subtitle
// index explicitly records that the user chose not to save subtitles.
export function sanitizeRetrySettings(value) {
  const range = requestedRange(value), outputDir = absolute(value?.outputDir);
  if (!range || !outputDir || !Number.isSafeInteger(value.budgetBytes) || value.budgetBytes < 1 || value.budgetBytes > 65536 * 1024 * 1024
      || !(value.subtitleStreamIndex === null || streamIndex(value.subtitleStreamIndex))) return undefined;
  const fingerprint = sourceDigest(value.sourceFingerprint), resumeFingerprint = sourceDigest(value.resumeFingerprint);
  return { ...range, outputDir, budgetBytes: value.budgetBytes, clipName: sanitizeClipName(typeof value.clipName === 'string' ? value.clipName : ''),
    subtitleStreamIndex: value.subtitleStreamIndex,
    ...(value.subtitleStreamIndex !== null && value.subtitleTrack && { subtitleTrack: retrySubtitleTrack(value.subtitleTrack) }),
    ...(value.audioStreamIndex === null || streamIndex(value.audioStreamIndex) ? { audioStreamIndex: value.audioStreamIndex } : {}),
    makeMp4: value.makeMp4 === true, reuseIndex: value.reuseIndex !== false,
    readMode: ['standard', 'continuous', 'parallel'].includes(value.readMode) ? value.readMode : 'standard',
    downloadMethod: value.downloadMethod === 'direct-stream' ? 'direct-stream' : 'indexed',
    ...(fingerprint ? { sourceFingerprint: fingerprint } : resumeFingerprint ? { resumeFingerprint } : {}),
  };
}

// Explicit field selection keeps source URLs, passwords, leases and controllers out of storage.
export function historyRecord(job) {
  if (!job || !taskId(job.id) || !terminal.has(job.status)) return null;
  // Another cancellation may save all jobs while this task is still settling.
  // Only publish the terminal record after its counters and timer are frozen.
  if (job.diagnosticTracker && !job.finishedAt) return null;
  const requested = requestedRange(job.params ? { start: job.params.start, end: job.params.end, handles: job.params.handles } : job.requested || job.result?.requested);
  const result = job.result;
  const saved = result ? {
    candidatePath: absolute(result.candidatePath), sidecarPath: absolute(result.sidecarPath),
    compatiblePath: absolute(result.compatiblePath), mappingVerified: false,
    subtitlePaths: Array.isArray(result.subtitlePaths) ? result.subtitlePaths.slice(0, 4).map(absolute).filter(Boolean) : [],
    subtitleResults: Array.isArray(result.subtitleResults) ? result.subtitleResults.slice(0, 4).map(item => ({ path: absolute(item?.path), format: text(item?.format), language: text(item?.language), codec: text(item?.codec), kind: item?.kind === 'image' ? 'image' : 'text' })).filter(item => item.path) : [],
    requested: result.requested && { start: Number(result.requested.start), end: Number(result.requested.end), handles: Number(result.requested.handles) },
    fetched: result.fetched && { start: Number(result.fetched.start), end: Number(result.fetched.end) },
    warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 10).map(w => ({ code: text(w.code), message: subtitleMessages[w?.code] || (String(w?.code || '').startsWith('SUBTITLE_') ? '原码片段已保留，独立字幕需要重新检查。' : '原码片段已保留，工作副本需要重新检查。') })) : [],
  } : undefined;
  const metrics = jobMetrics(job);
  const budgetBytes = Number.isSafeInteger(metrics.budgetBytes) && metrics.budgetBytes > 0 && metrics.budgetBytes <= 65536 * 1024 * 1024 ? metrics.budgetBytes : undefined;
  const diagnostics = sanitizeTaskDiagnostics(job.diagnostics && { ...job.diagnostics, status: job.status }, { terminal: true });
  const retryable = job.status === 'failed' || job.status === 'cancelled' && taskId(job.retryOf);
  const retrySettings = retryable && job.type !== 'compatible' && !saved?.candidatePath ? sanitizeRetrySettings(job.retrySettings) : undefined;
  return {
    id: job.id, ...(opaqueId(job.batchId) ? { batchId: job.batchId, ...(opaqueId(job.clientItemId) ? { clientItemId: job.clientItemId } : {}) } : {}), ...(requested ? { requested } : {}), queuedAt: text(job.queuedAt || job.createdAt), sourceLabel: text(job.sourceLabel), ...(typeof (job.params?.clipName || job.clipName) === 'string' ? { clipName: sanitizeClipName(job.params?.clipName || job.clipName) } : {}), startedAt: text(job.startedAt), finishedAt: text(job.finishedAt), type: job.type === 'compatible' ? 'compatible' : 'extract', createdAt: text(job.createdAt),
    status: job.status, stage: job.status, progress: job.status === 'completed' ? 100 : null,
    ...(taskId(job.retryOf) && job.retryOf !== job.id ? { retryOf: job.retryOf } : {}),
    ...(retrySettings ? { retrySettings } : {}),
    ...(['standard', 'continuous', 'parallel'].includes(job.params?.readMode || job.readMode) ? { readMode: job.params?.readMode || job.readMode } : {}),
    ...(['direct-stream', 'indexed'].includes(job.params?.downloadMethod || job.downloadMethod) ? { downloadMethod: job.params?.downloadMethod || job.downloadMethod } : {}),
    ...(Number.isSafeInteger(job.recoveryAttempts) && job.recoveryAttempts > 0 && job.recoveryAttempts <= 1000000 ? { recoveryAttempts: job.recoveryAttempts } : {}),
    ...(diagnostics ? { diagnostics } : {}),
    message: job.status === 'completed' ? '素材已保存在本机' : '任务未完成，可重新选择来源取片',
    error: job.error ? { code: text(job.error.code), message: '任务未完成，可重新选择来源取片。',
      ...(['checking', 'positioning', 'fetch', 'probe', 'extract', 'validate', 'compatible'].includes(job.error.stage) ? { stage: job.error.stage } : {}) } : undefined,
    result: saved,
    metrics: { budgetBytes, receivedBytes: Math.max(0, Number(metrics.receivedBytes) || 0), requests: Math.max(0, Number(metrics.requests) || 0), upstreamBytes: null },
  };
}

async function readHistory(filename) {
  let file;
  try {
    file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (failure) {
    if (failure.code === 'ENOENT') return [];
    throw failure;
  }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > HISTORY_BYTE_LIMIT) throw new Error('Invalid history file size or type');
    const chunks = [];
    // The inclusive end also bounds the read if the file grows after stat.
    for await (const chunk of file.createReadStream({ end: HISTORY_BYTE_LIMIT, autoClose: false })) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    if (bytes.length > HISTORY_BYTE_LIMIT) throw new Error('History file exceeds size limit');
    const data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (data?.schemaVersion !== 1 || !Array.isArray(data.jobs)) throw new Error('Invalid history schema');
    const records = data.jobs.slice(-HISTORY_RECORD_LIMIT).map(historyRecord);
    if (records.includes(null)) throw new Error('Invalid history record');
    return records;
  } finally {
    await file.close();
  }
}

export async function createHistoryStore(directory) {
  if (!directory) return { load: async () => [], save: async () => {} };
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const filename = path.join(directory, 'tasks.json');
  let pending = Promise.resolve(), loadFailure;
  return {
    async load() {
      try {
        return await readHistory(filename);
      } catch (failure) {
        // A failed startup load leaves the caller without the original jobs.
        // Keep writes blocked for this session even if the file is repaired.
        loadFailure ??= Object.assign(new Error('无法读取本机任务记录。原记录已保留。', { cause: failure }), { code: 'HISTORY_READ_FAILED' });
        throw loadFailure;
      }
    },
    save(jobs) {
      const records = [...jobs].map(historyRecord).filter(Boolean).slice(-HISTORY_RECORD_LIMIT);
      const content = JSON.stringify({ schemaVersion: 1, jobs: records });
      const task = pending.catch(() => {}).then(async () => {
        if (loadFailure) throw loadFailure;
        if (Buffer.byteLength(content) > HISTORY_BYTE_LIMIT) throw new Error('History exceeds size limit');
        // The file may have become unreadable after startup. Validate the
        // current on-disk record before replacing it, including on shutdown.
        await readHistory(filename);
        const temporary = path.join(directory, `.tasks-${randomUUID()}.tmp`);
        try {
          await writeFile(temporary, content, { mode: 0o600, flag: 'wx' });
          await rename(temporary, filename);
        } catch (failure) {
          await rm(temporary, { force: true }).catch(() => {});
          throw failure;
        }
      });
      pending = task;
      return task;
    },
  };
}
