import { performance } from 'node:perf_hooks';

const DEFAULT_STALL_TIMEOUT = 120000;
const MAX_INTERVAL = 24 * 60 * 60 * 1000;
class TransferGuardError extends Error {
  constructor(code, message) { super(message); this.name = 'TransferGuardError'; this.code = code; }
}

function interval(value) { return Number.isSafeInteger(value) && value >= 1 && value <= MAX_INTERVAL; }
function durationLabel(milliseconds) {
  if (milliseconds % 60000 === 0) return `${milliseconds / 60000}分钟`;
  if (milliseconds % 1000 === 0) return `${milliseconds / 1000}秒`;
  return `${milliseconds}毫秒`;
}

/**
 * Stop a transfer only after actual cumulative activity stops increasing.
 * There is deliberately no total-duration deadline. The observer must return
 * real received/written byte counts, never request counts or UI notifications.
 */
export function createTransferGuard({ signal, getActivity, stallTimeoutMs = DEFAULT_STALL_TIMEOUT, pollIntervalMs = 1000 } = {}) {
  if ((signal !== undefined && !(signal instanceof AbortSignal)) || typeof getActivity !== 'function'
      || !interval(stallTimeoutMs) || !interval(pollIntervalMs) || pollIntervalMs > stallTimeoutMs) {
    throw new TransferGuardError('TRANSFER_GUARD_INVALID', '传输活动检查配置无效。');
  }
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let timer = null, disposed = false, stalled = false, highestActivity = 0;
  let lastActivityAt = performance.now();

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (timer !== null) { clearInterval(timer); timer = null; }
    signal?.removeEventListener('abort', dispose);
  }
  function stop(code, message) {
    controller.abort(new TransferGuardError(code, message));
    dispose();
  }
  function sample() {
    if (disposed) return;
    if (combined.aborted) { dispose(); return; }
    let activity;
    try { activity = getActivity(); }
    catch {
      stop('TRANSFER_ACTIVITY_UNAVAILABLE', '无法核对接收和写入进度，任务已停止。');
      return;
    }
    const now = performance.now();
    if (Number.isSafeInteger(activity) && activity >= 0 && activity > highestActivity) {
      highestActivity = activity;
      lastActivityAt = now;
    }
    if (now - lastActivityAt >= stallTimeoutMs) {
      stalled = true;
      stop('TRANSFER_STALLED', `连续${durationLabel(stallTimeoutMs)}没有接收或写入新数据，任务已停止。请检查网络、CloudDrive2 和本地磁盘后重试。`);
    }
  }

  const guard = Object.freeze({ signal: combined, dispose, get stalled() { return stalled; } });
  if (combined.aborted) { dispose(); return guard; }
  signal?.addEventListener('abort', dispose, { once: true });
  sample();
  if (!disposed) {
    timer = setInterval(sample, pollIntervalMs);
    timer.unref?.();
  }
  return guard;
}
