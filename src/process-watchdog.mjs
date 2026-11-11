const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const ACTIVITY_FIELDS = ['receivedBytes', 'outputBytes', 'mediaTimeUs'];
const interval = value => Number.isSafeInteger(value) && value >= 1 && value <= MAX_INTERVAL_MS;
const count = value => Number.isSafeInteger(value) && value >= 0;

/** Observe actual cumulative work; repeated progress notifications are not activity. */
export function createProcessWatchdog({
  stallTimeoutMs = 120000, pollIntervalMs = 1000, getActivity, onStall, onUnavailable,
  now = () => performance.now(), setIntervalFn = setInterval, clearIntervalFn = clearInterval,
} = {}) {
  if (!interval(stallTimeoutMs) || !interval(pollIntervalMs) || pollIntervalMs > stallTimeoutMs
      || typeof getActivity !== 'function' || typeof onStall !== 'function'
      || (onUnavailable !== undefined && typeof onUnavailable !== 'function')
      || typeof now !== 'function' || typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function') {
    throw Object.assign(new Error('媒体进度监测配置无效。'), { code: 'PROCESS_WATCHDOG_INVALID' });
  }

  let disposed = false, timer = null, lastActivityAt = null, clockHighWater = 0;
  const highest = Object.fromEntries(ACTIVITY_FIELDS.map(key => [key, 0]));
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (timer !== null) {
      try { clearIntervalFn(timer); } catch { /* A disposed observer can no longer sample or report. */ }
      timer = null;
    }
  }
  function stop(code) {
    if (disposed) return;
    dispose();
    const callback = code === 'PROCESS_STALLED' ? onStall : onUnavailable ?? onStall;
    // Never reflect private observer exceptions, and never leave a live timer if a callback throws.
    try { callback({ code, stallTimeoutMs }); } catch { /* The process owner keeps its own final deadline. */ }
  }
  function sample() {
    if (disposed) return;
    let activity, time, valid = 0, growing = false;
    try {
      activity = getActivity();
      time = now();
      if (!activity || typeof activity !== 'object' || Array.isArray(activity)
          || !Number.isFinite(time) || time < 0) throw new Error('INVALID_ACTIVITY');
      for (const key of ACTIVITY_FIELDS) {
        const value = activity[key];
        if (!count(value)) continue;
        valid++;
        if (value > highest[key]) { highest[key] = value; growing = true; }
      }
    } catch { stop('PROCESS_ACTIVITY_UNAVAILABLE'); return; }
    if (!valid) { stop('PROCESS_ACTIVITY_UNAVAILABLE'); return; }
    clockHighWater = Math.max(clockHighWater, time);
    if (lastActivityAt === null || growing) lastActivityAt = clockHighWater;
    if (clockHighWater - lastActivityAt >= stallTimeoutMs) stop('PROCESS_STALLED');
  }

  const watchdog = Object.freeze({ sample, dispose });
  sample();
  if (!disposed) {
    try {
      const handle = setIntervalFn(sample, pollIntervalMs);
      if (disposed) clearIntervalFn(handle);
      else { timer = handle; timer?.unref?.(); }
    }
    catch { stop('PROCESS_ACTIVITY_UNAVAILABLE'); }
  }
  return watchdog;
}
