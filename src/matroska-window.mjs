import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const READ_SIZE = 1024 * 1024;
const MAX_PREFIX_SIZE = 8 * 1024 * 1024;
const IDS = { ebml: 0x1a45dfa3, segment: 0x18538067, info: 0x1549a966, tracks: 0x1654ae6b, cluster: 0x1f43b675, void: 0xec };

class WindowError extends Error {
  constructor(code, message) { super(message); this.name = 'MatroskaWindowError'; this.code = code; }
}
const invalid = () => { throw new WindowError('INVALID_MATROSKA_WINDOW', '目标媒体范围或封装结构无效，已停止读取。'); };
function aborted(signal) {
  if (signal?.aborted) throw new WindowError('CANCELLED', '任务已取消。');
}

// A null result means the next chunk is needed. Only element headers are
// inspected; compressed media blocks are neither parsed nor modified.
function elementHeader(buffer) {
  if (!buffer.length) return null;
  function number(at, isId) {
    if (at >= buffer.length) return null;
    let width = 1;
    while (width <= 8 && !(buffer[at] & (1 << (8 - width)))) width++;
    if (width > (isId ? 4 : 8)) invalid();
    if (at + width > buffer.length) return null;
    let value = BigInt(isId ? buffer[at] : buffer[at] & ((1 << (8 - width)) - 1));
    for (let i = 1; i < width; i++) value = (value << 8n) | BigInt(buffer[at + i]);
    if (!isId && value === (1n << BigInt(7 * width)) - 1n) return { width, value: null };
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
    return { width, value: Number(value) };
  }
  const id = number(0, true);
  if (!id) return null;
  const size = number(id.width, false);
  return size ? { id: id.value, size: size.value, width: id.width + size.width } : null;
}

function checkPrefix(prefix) {
  let at = 0;
  for (const id of [IDS.ebml, IDS.segment, IDS.info, IDS.tracks]) {
    const header = elementHeader(prefix.subarray(at, Math.min(prefix.length, at + 12)));
    if (!header || header.id !== id) invalid();
    at += header.width;
    if (id === IDS.segment) {
      if (header.size !== null) invalid();
    } else {
      if (header.size === null || header.size < 1 || at + header.size > prefix.length) invalid();
      at += header.size;
    }
  }
  if (at !== prefix.length) invalid();
}

function rangeValidator(length) {
  let headerBytes = Buffer.alloc(0), remaining = 0, consumed = 0, clusters = 0;
  return {
    accept(chunk) {
      let offset = 0;
      while (offset < chunk.length) {
        if (remaining) {
          const count = Math.min(remaining, chunk.length - offset);
          offset += count; consumed += count; remaining -= count;
          continue;
        }
        headerBytes = Buffer.concat([headerBytes, chunk.subarray(offset, offset + 1)]);
        offset++; consumed++;
        const header = elementHeader(headerBytes);
        if (!header) continue;
        if (![IDS.cluster, IDS.void].includes(header.id) || header.size === null || header.size > length - consumed) invalid();
        if (header.id === IDS.cluster) {
          if (!header.size) invalid();
          clusters++;
        }
        remaining = header.size;
        headerBytes = Buffer.alloc(0);
      }
    },
    finish() { if (consumed !== length || remaining || headerBytes.length || !clusters) invalid(); },
  };
}

function progress(callback, percent, receivedBytes, totalBytes) {
  if (typeof callback !== 'function') return;
  try {
    callback({ phase: 'fetch', status: 'running', percent, receivedBytes, totalBytes,
      message: percent === 100 ? '目标媒体数据已读取，准备本地处理。' : '按时间索引读取目标片段。' });
  } catch { /* A UI callback must not interrupt cleanup or media delivery. */ }
}

async function readChunk(read, position, length, signal) {
  aborted(signal);
  let onAbort;
  try {
    const cancellation = new Promise((resolve, reject) => {
      onAbort = () => reject(new WindowError('CANCELLED', '任务已取消。'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    return await Promise.race([Promise.resolve().then(() => { aborted(signal); return read(position, length); }), cancellation]);
  } catch (error) {
    if (error instanceof WindowError) throw error;
    const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,79}$/.test(error.code) ? error.code : 'WINDOW_READ_FAILED';
    throw new WindowError(code, '读取目标片段的数据失败，任务已停止。');
  } finally { signal?.removeEventListener('abort', onAbort); }
}

/**
 * Materialize an already verified, contiguous Matroska cluster window.
 * `plan` may be the locateMatroskaCue result or its `window` property.
 * The budget covers new source reads; prefix bytes were read by the planner.
 * Optional 2/4 MiB network batches preserve the existing 1 MiB cache units and
 * stop at every cache hit; the default remains one unit per read.
 * At most two ordered slots may overlap reads and local commits. A completed
 * out-of-order read still occupies its slot, bounding both traffic and memory.
 * Readers receive an operation signal as their third argument so a failed
 * sibling can stop in-flight I/O before the temporary output is removed.
 * No original SeekHead/Cues are copied, and absolute media timestamps remain
 * untouched. Only the resulting private local file is given to FFmpeg.
 */
export async function materializeMatroskaWindow({ plan, read, directory = os.tmpdir(), signal, onProgress, budgetBytes, cache,
  readBatchBytes = READ_SIZE, readConcurrency = 1 } = {}) {
  aborted(signal);
  const window = plan?.window ?? plan;
  if (!window || typeof read !== 'function' || !Buffer.isBuffer(window.prefix)
      || window.prefix.length < 1 || window.prefix.length > MAX_PREFIX_SIZE
      || !Number.isSafeInteger(window.sourceStart) || window.sourceStart < 0
      || !Number.isSafeInteger(window.sourceEnd) || window.sourceEnd <= window.sourceStart
      || !Number.isFinite(window.timelineStartSeconds) || window.timelineStartSeconds < 0
      || !Number.isFinite(window.timelineEndSeconds) || window.timelineEndSeconds <= window.timelineStartSeconds
      || !Number.isSafeInteger(budgetBytes) || budgetBytes < (cache ? 0 : 1)
      || ![READ_SIZE, 2 * READ_SIZE, 4 * READ_SIZE].includes(readBatchBytes)
      || ![1, 2].includes(readConcurrency)
      || (cache && (typeof cache.get !== 'function' || typeof cache.put !== 'function' || typeof cache.has !== 'function'))
      || typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0')) invalid();
  const prefix = Buffer.from(window.prefix);
  checkPrefix(prefix);
  const length = window.sourceEnd - window.sourceStart;
  if (!Number.isSafeInteger(prefix.length + length)) invalid();
  let missingBytes = 0;
  for (let copied = 0; copied < length; copied += READ_SIZE) {
    aborted(signal);
    const wanted = Math.min(READ_SIZE, length - copied);
    if (!cache || !await cache.has(window.sourceStart + copied, wanted)) missingBytes += wanted;
  }
  if (missingBytes > budgetBytes) throw new WindowError('BUDGET_EXCEEDED', '尚未缓存的目标数据超出本次剩余读取上限，已保留可用续传缓存。');
  const controller = new AbortController();
  const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const pending = new Set(), queue = [];
  let scheduled = 0, firstReadFailure;
  const stopReads = async () => {
    controller.abort();
    await Promise.allSettled([...pending]);
  };
  async function fillQueue() {
    while (queue.length < readConcurrency && scheduled < length) {
      aborted(operationSignal);
      const position = window.sourceStart + scheduled;
      const wanted = Math.min(READ_SIZE, length - scheduled);
      const saved = cache ? await readChunk((offset, size) => cache.get(offset, size), position, wanted, operationSignal) : null;
      let batchLength = wanted;
      if (!saved) {
        while (batchLength < readBatchBytes && position + batchLength < window.sourceEnd) {
          aborted(operationSignal);
          const nextLength = Math.min(READ_SIZE, window.sourceEnd - position - batchLength);
          if (cache && await readChunk((offset, size) => cache.has(offset, size), position + batchLength, nextLength, operationSignal)) break;
          batchLength += nextLength;
        }
      }
      scheduled += batchLength;
      const operation = (saved ? Promise.resolve(saved)
        : readChunk((offset, size) => read(offset, size, operationSignal), position, batchLength, operationSignal))
        .then(data => {
          if (!Buffer.isBuffer(data) || data.length !== batchLength)
            throw new WindowError('WINDOW_READ_FAILED', '目标片段的数据不完整，任务已停止。');
          return { data };
        }).catch(error => {
          // Observe failure immediately, even when an earlier slot is still
          // waiting. The originating error must survive sibling cancellation.
          firstReadFailure ??= error;
          controller.abort();
          return { error };
        });
      pending.add(operation);
      operation.then(() => pending.delete(operation));
      queue.push({ position, cacheHit: Boolean(saved), operation });
    }
  }
  const validator = rangeValidator(length);
  let temporaryDirectory, handle, cleanupPromise;
  const cleanup = () => {
    if (!cleanupPromise) cleanupPromise = (async () => {
      if (handle) { const openHandle = handle; handle = null; await openHandle.close().catch(() => {}); }
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    })();
    return cleanupPromise;
  };
  async function write(buffer) {
    let offset = 0;
    while (offset < buffer.length) {
      aborted(operationSignal);
      const result = await handle.write(buffer, offset, buffer.length - offset, null);
      if (!Number.isSafeInteger(result.bytesWritten) || result.bytesWritten < 1) throw new WindowError('WINDOW_OUTPUT_FAILED', '无法写入目标片段的临时文件，请检查可用空间。');
      offset += result.bytesWritten;
    }
  }
  try {
    temporaryDirectory = await mkdtemp(path.join(directory, 'clip-matroska-window-'));
    const filename = path.join(temporaryDirectory, 'window.mkv');
    handle = await open(filename, 'wx', 0o600);
    await write(prefix);
    progress(onProgress, 0, 0, length);
    let copied = 0;
    await fillQueue();
    while (copied < length) {
      const next = queue.shift();
      if (!next || next.position !== window.sourceStart + copied) invalid();
      const outcome = await next.operation;
      if (outcome.error) throw outcome.error;
      aborted(operationSignal);
      const { data } = outcome;
      for (let offset = 0; offset < data.length; offset += READ_SIZE) {
        aborted(operationSignal);
        const unit = data.subarray(offset, Math.min(offset + READ_SIZE, data.length));
        validator.accept(unit);
        if (cache && !next.cacheHit) {
          try { await cache.put(window.sourceStart + copied, unit); }
          catch (error) { throw new WindowError(error.code || 'RESUME_WRITE_FAILED', '无法保存续传数据，已停止。已有完整缓存仍保留，请检查磁盘空间。'); }
        }
        await write(unit);
        copied += unit.length;
        progress(onProgress, Math.min(99, copied / length * 100), copied, length);
      }
      await fillQueue();
    }
    validator.finish();
    aborted(operationSignal);
    await handle.close(); handle = null;
    progress(onProgress, 100, copied, length);
    return { path: filename, cleanup, bytesWritten: prefix.length + copied };
  } catch (error) {
    const failure = firstReadFailure && !signal?.aborted ? firstReadFailure : error;
    await stopReads();
    await cleanup().catch(() => {});
    if (signal?.aborted) throw new WindowError('CANCELLED', '任务已取消。');
    if (failure instanceof WindowError) throw failure;
    throw new WindowError('WINDOW_OUTPUT_FAILED', '无法保存目标片段的临时文件，请检查可用空间和目录权限。');
  } finally {
    await stopReads();
  }
}
