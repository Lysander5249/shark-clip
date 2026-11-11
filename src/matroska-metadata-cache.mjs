// Process-local, version-bound Matroska metadata. Callers stage only the exact
// ranges accepted by the parser and publish after the complete plan is valid.
const MiB = 1024 * 1024;
const hashPattern = /^[a-f0-9]{64}$/;
const schema = 'matroska-metadata-v1';
function identityKey(value) {
  if (!value || !['sourceKey', 'etagSha256', 'headSha256'].every(field => typeof value[field] === 'string' && hashPattern.test(value[field]))
      || !Number.isSafeInteger(value.size) || value.size < 1) return null;
  return JSON.stringify([schema, value.sourceKey, value.size, value.etagSha256, value.headSha256]);
}
function validRange(position, length, size) {
  return Number.isSafeInteger(position) && position >= 0 && Number.isSafeInteger(length) && length > 0
    && Number.isSafeInteger(position + length) && position + length <= size;
}
function mergeRange(ranges, position, data) {
  const end = position + data.length;
  const touching = ranges.filter(range => range.position <= end && range.position + range.data.length >= position);
  const first = Math.min(position, ...touching.map(range => range.position));
  const last = Math.max(end, ...touching.map(range => range.position + range.data.length));
  const merged = Buffer.alloc(last - first);
  for (const range of touching) range.data.copy(merged, range.position - first);
  data.copy(merged, position - first);
  return [...ranges.filter(range => !touching.includes(range)), { position: first, data: merged }].sort((a, b) => a.position - b.position);
}

export function createMatroskaMetadataCache({ maxBytes = 16 * MiB, maxEntryBytes = 4 * MiB } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxEntryBytes) || maxEntryBytes < 1 || maxEntryBytes > maxBytes) {
    throw new RangeError('Invalid Matroska metadata cache capacity');
  }
  // Keys and entries contain hashes and owned buffers only, never connection
  // objects, credentials, raw validators, or remote URLs.
  const entries = new Map(), pending = new Set();
  let totalBytes = 0, pendingBytes = 0, epoch = 0;
  function remove(sourceKey) {
    const entry = entries.get(sourceKey);
    if (entry) { totalBytes -= entry.bytes; entries.delete(sourceKey); }
  }
  function touch(sourceKey, entry) {
    if (entries.get(sourceKey) === entry) { entries.delete(sourceKey); entries.set(sourceKey, entry); }
  }
  function release(state) {
    pendingBytes -= state.bytes;
    state.ranges = []; state.bytes = 0; state.closed = true;
    pending.delete(state);
  }
  function invalidateTransactions() {
    epoch++;
    for (const state of pending) release(state);
  }
  return Object.freeze({
    begin(identity) {
      const key = identityKey(identity);
      if (!key) return null;
      // Copy primitive identity fields; never retain a caller-owned object.
      const sourceKey = identity.sourceKey, size = identity.size;
      if (entries.has(sourceKey) && entries.get(sourceKey).key !== key) { remove(sourceKey); invalidateTransactions(); }
      // A token identifies the initial entry without retaining its Buffer after
      // LRU eviction, clear, or replacement. Long-lived transactions cannot keep
      // evicted metadata alive through an invisible snapshot reference.
      const token = entries.get(sourceKey)?.token, started = epoch;
      const state = { ranges: [], bytes: 0, closed: false };
      pending.add(state);
      return Object.freeze({
        get(position, length) {
          if (state.closed || started !== epoch || !validRange(position, length, size)) return null;
          const entry = entries.get(sourceKey);
          if (!entry || entry.token !== token) return null;
          const range = entry.ranges.find(range => position >= range.position && position + length <= range.position + range.data.length);
          if (!range) return null;
          touch(sourceKey, entry);
          return Buffer.from(range.data.subarray(position - range.position, position - range.position + length));
        },
        put(position, data) {
          if (state.closed || started !== epoch || !Buffer.isBuffer(data) || !validRange(position, data.length, size)) return false;
          // Check the union before copying, including overlap rather than the
          // sum of possibly repeated parser views.
          const overlap = state.ranges.reduce((sum, range) => sum + Math.max(0, Math.min(position + data.length, range.position + range.data.length) - Math.max(position, range.position)), 0);
          const nextBytes = state.bytes + data.length - overlap, additional = nextBytes - state.bytes;
          if (nextBytes > maxEntryBytes) { release(state); return false; }
          // Both committed and staged owned bytes share the global allowance.
          // Parser/network temporary buffers and transient copy allocations are
          // separate from retained cache ownership.
          while (totalBytes + pendingBytes + additional > maxBytes && entries.size) remove(entries.keys().next().value);
          if (totalBytes + pendingBytes + additional > maxBytes) { release(state); return false; }
          state.ranges = mergeRange(state.ranges, position, data); state.bytes = nextBytes;
          pendingBytes += additional;
          return true;
        },
        commit() {
          if (state.closed) return false;
          if (started !== epoch || !state.bytes) { release(state); return false; }
          remove(sourceKey);
          entries.set(sourceKey, { key, token: Symbol(), ranges: state.ranges, bytes: state.bytes });
          totalBytes += state.bytes;
          release(state);
          return true;
        },
        discard() { if (!state.closed) release(state); },
      });
    },
    invalidate(sourceKey) { if (typeof sourceKey === 'string' && hashPattern.test(sourceKey)) { remove(sourceKey); invalidateTransactions(); } },
    clear() { entries.clear(); totalBytes = 0; invalidateTransactions(); },
    stats() { return Object.freeze({ entries: entries.size, bytes: totalBytes + pendingBytes, committedBytes: totalBytes, stagedBytes: pendingBytes, maxBytes, maxEntryBytes }); },
  });
}
