const MIB = 1024 * 1024;
const MIN_RECOMMENDED_MIB = 256;
const MAX_RECOMMENDED_MIB = 65536;

/**
 * Estimate muxed input data from the whole file's average rate, including handles.
 * Index lookup, probing and variable bitrate make this a planning estimate only.
 * Selecting fewer output tracks does not reduce the muxed input estimate.
 */
export function estimateReadBudget(input = {}) {
  if (!input || typeof input !== 'object') return null;
  const { sizeBytes, durationSeconds, startSeconds, endSeconds, handlesSeconds } = input;
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0
    || ![durationSeconds, startSeconds, endSeconds, handlesSeconds].every(Number.isFinite)
    || durationSeconds <= 0 || startSeconds < 0 || endSeconds <= startSeconds
    || startSeconds >= durationSeconds || endSeconds > durationSeconds + 0.1
    || handlesSeconds < 0 || handlesSeconds > 300) return null;

  const paddedStart = Math.max(0, startSeconds - handlesSeconds);
  const paddedEnd = Math.min(durationSeconds, endSeconds + handlesSeconds);
  const windowSeconds = paddedEnd - paddedStart;
  if (!(windowSeconds > 0) || windowSeconds > 600) return null;

  // Divide first so valid file sizes cannot overflow through an intermediate product.
  const estimatedBytes = Math.ceil(sizeBytes * (windowSeconds / durationSeconds));
  const targetBytes = Math.max(MIN_RECOMMENDED_MIB * MIB, estimatedBytes * 2 + 64 * MIB);
  let recommendedMiB = MIN_RECOMMENDED_MIB;
  while (recommendedMiB < MAX_RECOMMENDED_MIB && recommendedMiB * MIB < targetBytes) {
    recommendedMiB *= 2;
  }
  return {
    estimatedBytes,
    recommendedMiB,
    exceedsLimit: targetBytes > MAX_RECOMMENDED_MIB * MIB,
  };
}
