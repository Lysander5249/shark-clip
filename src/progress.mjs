/** Progress describes a media-processing phase, never upstream transfer completion. */
export function mediaProgress(fields, durationSeconds) {
  const rawTime = fields?.out_time_us;
  const microseconds = typeof rawTime === 'number' || (typeof rawTime === 'string' && rawTime.trim())
    ? Number(rawTime) : NaN;
  const outTimeSeconds = Number.isFinite(microseconds) && microseconds > 0 ? microseconds / 1_000_000 : null;
  const percent = Number.isFinite(durationSeconds) && durationSeconds > 0 && outTimeSeconds !== null
    ? Math.min(99, outTimeSeconds / durationSeconds * 100) : null;
  const rawSize = fields?.total_size;
  const size = typeof rawSize === 'number' || (typeof rawSize === 'string' && rawSize.trim()) ? Number(rawSize) : NaN;
  return {
    outTimeSeconds,
    percent,
    bytesWritten: Number.isFinite(size) && size >= 0 ? size : null,
  };
}

/** Reset unknown phase progress instead of retaining a percentage from earlier work. */
export function applyJobProgress(job, event) {
  const stage = event.phase || event.stage || job.stage;
  const changed = stage !== job.stage;
  job.stage = stage;
  if (event.message) job.message = event.message;
  if (Object.hasOwn(event, 'percent')) {
    job.progress = Number.isFinite(event.percent) ? Math.min(99, Math.max(0, event.percent)) : null;
  } else if (changed) job.progress = null;
}
