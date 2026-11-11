const CHUNK = 1024 * 1024;
const MAX_BYTES = 4 * CHUNK;
const MAX_REQUESTS = 64;
const count = value => Number.isSafeInteger(value) && value >= 0;
const failure = (code, message) => Object.assign(new Error(message), { code });
const limit = () => failure('INDEX_LIMIT', '索引读取超过安全上限，已停止，避免读取大量无关内容。');

/**
 * Bound newly received indexing bytes and physical Range dispatches. The lease
 * must be dedicated to sequential index reads, use 1 MiB direct chunks, and
 * retain read()'s default maxAttempts=1. Metadata-cache hits never call here.
 * Construct this before the fresh full-head check so it shares these limits.
 */
export function createIndexReader({ lease, signal } = {}) {
  if (!lease || typeof lease.read !== 'function' || !count(lease.metrics?.receivedBytes)
      || !count(lease.metrics?.requests) || (signal !== undefined && !(signal instanceof AbortSignal))) {
    throw failure('INDEX_READER_INVALID', '索引读取配置无效。');
  }
  const initialBytes = lease.metrics.receivedBytes, initialRequests = lease.metrics.requests;
  let highestBytes = initialBytes, highestRequests = initialRequests, active = false, invalidMetrics = false;

  function observe() {
    const { receivedBytes, requests } = lease.metrics || {};
    if (!count(receivedBytes) || !count(requests) || receivedBytes < highestBytes || requests < highestRequests) {
      invalidMetrics = true;
      return null;
    }
    highestBytes = receivedBytes; highestRequests = requests;
    return { bytes: receivedBytes - initialBytes, requests: requests - initialRequests };
  }

  return async function readIndex(start, length) {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 1
        || !Number.isSafeInteger(start + length)) {
      throw failure('RANGE_INVALID', '索引读取范围无效。');
    }
    const used = observe();
    // Refuse concurrent users: otherwise two preflights could both reserve the
    // final request slots before either read has updated the lease counters.
    if (active || invalidMetrics || !used || used.bytes + length > MAX_BYTES
        || used.requests + Math.ceil(length / CHUNK) > MAX_REQUESTS) throw limit();
    active = true;
    try {
      return await lease.read(start, length, signal);
    } finally {
      // Never roll back failed/partial bytes or requests. Observe after failure
      // as well, and reject any subsequent use if counters were reset.
      observe();
      active = false;
    }
  };
}
