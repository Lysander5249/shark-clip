import { remoteTelemetry, remoteReadTimings } from './remote.mjs';
import { directTelemetry, directReadTimings } from './direct-stream-telemetry.mjs';
import { mergeTransferTelemetry } from './task-diagnostics.mjs';

// One task can use a bounded positioning lease followed by an extraction lease.
// Both count against the same user-selected cap.
export function jobMetrics(job) {
  const previous = job.metrics || {};
  const active = job.lease?.metrics;
  const counter = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const metrics = {
    budgetBytes: job.params?.budgetBytes ?? previous.budgetBytes ?? active?.budgetBytes,
    receivedBytes: counter(previous.receivedBytes) + counter(active?.receivedBytes),
    requests: counter(previous.requests) + counter(active?.requests),
    upstreamBytes: null,
  };
  const first = previous.positioning, last = active?.positioning;
  if (first || last) {
    const offsets = [first?.maxOffset, last?.maxOffset].filter(Number.isSafeInteger);
    metrics.positioning = {
      firstOffset: first?.firstOffset ?? last?.firstOffset ?? null,
      lastOffset: last?.lastOffset ?? first?.lastOffset ?? null,
      maxOffset: offsets.length ? Math.max(...offsets) : null,
      seekCount: counter(first?.seekCount) + counter(last?.seekCount),
    };
  }
  return metrics;
}

export async function finishJobLease(job, lease) {
  await lease.release();
  if (job.lease === lease) {
    job.metrics = jobMetrics(job);
    job.transferMetrics = jobTransferTelemetry(job);
    delete job.lease;
  }
}

export function jobTransferTelemetry(job) {
  const metrics = job.lease?.metrics;
  const active = remoteTelemetry(metrics) ?? directTelemetry(metrics);
  const readTimings = remoteReadTimings(metrics) ?? directReadTimings(metrics);
  return mergeTransferTelemetry(job.transferMetrics, active && {
    ...active,
    ...(readTimings ? { readTimings } : {}),
  });
}
