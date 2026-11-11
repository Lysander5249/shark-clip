// Read Matroska's small seek tables directly. Media blocks are never scanned.
// https://www.matroska.org/technical/elements.html
const ID = { ebml: 0x1a45dfa3, segment: 0x18538067, seek: 0x114d9b74, info: 0x1549a966, tracks: 0x1654ae6b, cues: 0x1c53bb6b, cluster: 0x1f43b675 };
class UnusableIndex extends Error {}
const invalid = () => { throw new UnusableIndex(); };
function vint(buffer, offset, id = false) {
  if (offset >= buffer.length) invalid();
  let length = 1;
  while (length <= 8 && !(buffer[offset] & (1 << (8 - length)))) length++;
  if (length > (id ? 4 : 8) || offset + length > buffer.length) invalid();
  let value = BigInt(id ? buffer[offset] : buffer[offset] & ((1 << (8 - length)) - 1));
  for (let i = 1; i < length; i++) value = (value << 8n) | BigInt(buffer[offset + i]);
  const unknown = !id && value === (1n << BigInt(length * 7)) - 1n;
  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return { length, value: unknown ? null : Number(value) };
}
function element(buffer, offset) {
  const id = vint(buffer, offset, true), size = vint(buffer, offset + id.length);
  const data = offset + id.length + size.length;
  return { id: id.value, data, size: size.value, end: size.value === null ? null : data + size.value };
}
function children(buffer, start = 0, end = buffer.length) {
  const result = [];
  for (let p = start; p < end;) {
    const e = element(buffer, p);
    if (e.end === null || e.end > end || result.length >= 200000) invalid();
    result.push(e); p = e.end;
  }
  return result;
}
function uint(buffer, e) {
  if (!e || e.size < 1 || e.size > 8) invalid();
  let value = 0;
  for (const byte of buffer.subarray(e.data, e.end)) value = value * 256 + byte;
  if (!Number.isSafeInteger(value)) invalid();
  return value;
}

function encodeElement(id, payload) {
  let hex = id.toString(16); if (hex.length % 2) hex = '0' + hex;
  let width = 1;
  while (BigInt(payload.length) >= (1n << BigInt(7 * width)) - 1n) width++;
  const size = Buffer.alloc(width); let value = BigInt(payload.length) | (1n << BigInt(7 * width));
  for (let i = width - 1; i >= 0; i--) { size[i] = Number(value & 255n); value >>= 8n; }
  return Buffer.concat([Buffer.from(hex, 'hex'), size, payload]);
}

/** null means the bounded parser cannot verify this index; use the normal demuxer. */
export async function locateMatroskaCue({ read, size, start, end, videoOrdinal = 0, videoStreamIndex, videoCodec, signal, metadataCache }) {
  if (typeof read !== 'function' || !Number.isSafeInteger(size) || size < 16 || !Number.isFinite(start) || start < 0 || !Number.isSafeInteger(videoOrdinal) || videoOrdinal < 0
    || (end !== undefined && (!Number.isFinite(end) || end <= start || end - start > 600))
    || (videoStreamIndex !== undefined && (!Number.isSafeInteger(videoStreamIndex) || videoStreamIndex < 0))) return null;
  const cache = []; let received = 0, operations = 0, hitBytes = 0, hitReads = 0;
  const metadataIds = new Set([ID.ebml, ID.segment, ID.seek, ID.info, ID.tracks, ID.cues]);
  function reused(position, length) {
    const data = metadataCache?.get(position, length);
    if (!Buffer.isBuffer(data) || data.length !== length) return null;
    hitBytes += length; hitReads++;
    return data;
  }
  async function bytes(position, length, { metadata = false, fresh = false, force = false } = {}) {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 1 || position + length > size || !Number.isSafeInteger(position + length)) invalid();
    if (metadata) {
      const data = reused(position, length);
      if (data) return data;
    }
    const hit = !force && cache.find(c => (!fresh || c.fresh) && position >= c.position && position + length <= c.position + c.data.length);
    if (hit) return hit.data.subarray(position - hit.position, position - hit.position + length);
    const wanted = Math.min(size - position, Math.max(length, 4096));
    if (received + wanted > 4 * 1024 * 1024 || ++operations > 64) invalid();
    const data = await read(position, wanted);
    if (!Buffer.isBuffer(data) || data.length !== wanted) invalid();
    signal?.throwIfAborted();
    received += data.length; cache.push({ position, data, fresh });
    return data.subarray(0, length);
  }
  async function header(position, { fresh = false, force = false } = {}) {
    let headerData;
    if (metadataCache && !fresh) {
      // A committed range contains only confirmed metadata. Decode its exact
      // header width without requesting bytes beyond a header-only Segment.
      const first = metadataCache.get(position, 1);
      if (first) {
        let idWidth = 1;
        while (idWidth <= 4 && !(first[0] & (1 << (8 - idWidth)))) idWidth++;
        const partial = idWidth <= 4 && metadataCache.get(position, idWidth + 1);
        if (partial) {
          let sizeWidth = 1;
          while (sizeWidth <= 8 && !(partial[idWidth] & (1 << (8 - sizeWidth)))) sizeWidth++;
          const exact = sizeWidth <= 8 && metadataCache.get(position, idWidth + sizeWidth);
          if (exact && metadataIds.has(element(exact, 0).id)) {
            headerData = exact; hitBytes += exact.length; hitReads++;
          }
        }
      }
    }
    headerData ||= await bytes(position, Math.min(16, size - position), { fresh, force });
    const e = element(headerData, 0);
    const data = position + e.data, end = e.size === null ? size : data + e.size;
    if (!Number.isSafeInteger(end) || end > size) invalid();
    const result = { ...e, position, data, end };
    if (!fresh && metadataIds.has(e.id)) metadataCache?.put(position, headerData.subarray(0, e.data));
    return result;
  }
  async function payload(e, { fresh = false } = {}) {
    if (e.size === null || e.size > 4 * 1024 * 1024 || e.size < 1) invalid();
    const metadata = !fresh && metadataIds.has(e.id) && e.id !== ID.segment;
    const data = await bytes(e.data, e.size, { metadata, fresh });
    if (metadata) metadataCache?.put(e.data, data);
    return data;
  }
  try {
    const ebml = await header(0);
    if (ebml.id !== ID.ebml || ebml.size === null) return null;
    const segment = await header(ebml.end);
    if (segment.id !== ID.segment) return null;
    const base = segment.data, locations = new Map(), seekHeads = [], visited = new Set();
    for (let p = base, count = 0; p < segment.end && count < 32; count++) {
      const e = await header(p);
      if (e.id === ID.cluster) break;
      locations.set(e.id, e.position);
      if (e.id === ID.seek) seekHeads.push(e.position);
      if (e.size === null) break;
      p = e.end;
    }
    while (seekHeads.length) {
      const position = seekHeads.shift();
      if (visited.has(position)) continue;
      if (visited.size >= 8) invalid();
      visited.add(position);
      const h = await header(position);
      if (h.id !== ID.seek) invalid();
      const b = await payload(h);
      for (const entry of children(b).filter(e => e.id === 0x4dbb)) {
        const c = children(b, entry.data, entry.end);
        const id = uint(b, c.find(e => e.id === 0x53ab));
        const at = base + uint(b, c.find(e => e.id === 0x53ac));
        if (!Number.isSafeInteger(at) || at < base || at >= segment.end) invalid();
        if (id === ID.seek) seekHeads.push(at);
        else if (!locations.has(id)) locations.set(id, at);
      }
    }
    async function table(id) {
      if (!locations.has(id)) invalid();
      const e = await header(locations.get(id));
      if (e.id !== id) invalid();
      return payload(e);
    }
    const info = await table(ID.info), timeScaleElement = children(info).find(e => e.id === 0x2ad7b1);
    const scale = timeScaleElement ? uint(info, timeScaleElement) : 1000000;
    if (!(scale > 0 && scale <= 1000000000)) invalid();
    const tracks = await table(ID.tracks);
    const trackEntries = children(tracks).filter(e => e.id === 0xae).map(e => children(tracks, e.data, e.end));
    const videos = trackEntries.filter(c => uint(tracks, c.find(e => e.id === 0x83)) === 1);
    // Matroska's demuxer creates native streams in TrackEntry order, then appends
    // attached pictures. An explicit stream index avoids cover/video ordinals.
    const chosen = videoStreamIndex === undefined ? videos[videoOrdinal] : trackEntries[videoStreamIndex];
    if (!chosen || uint(tracks, chosen.find(e => e.id === 0x83)) !== 1) invalid();
    const codecElement = chosen.find(e => e.id === 0x86);
    const expectedCodecs = { hevc: 'V_MPEGH/ISO/HEVC', h264: 'V_MPEG4/ISO/AVC', av1: 'V_AV1', vp9: 'V_VP9', vp8: 'V_VP8', mpeg2video: 'V_MPEG2' };
    if (videoCodec && (!codecElement || tracks.subarray(codecElement.data, codecElement.end).toString() !== expectedCodecs[videoCodec])) return null;
    const trackNumber = uint(tracks, chosen.find(e => e.id === 0xd7));
    const cues = await table(ID.cues); let selected, next, previousTime = -1, previousPosition = -1, count = 0;
    const points = [];
    for (const point of children(cues).filter(e => e.id === 0xbb)) {
      const c = children(cues, point.data, point.end);
      const time = uint(cues, c.find(e => e.id === 0xb3)) * scale / 1e9;
      for (const entry of c.filter(e => e.id === 0xb7)) {
        const fields = children(cues, entry.data, entry.end);
        if (uint(cues, fields.find(e => e.id === 0xf7)) !== trackNumber) continue;
        const position = base + uint(cues, fields.find(e => e.id === 0xf1));
        if (!Number.isFinite(time) || time < previousTime || position < previousPosition || !Number.isSafeInteger(position) || position < base || position >= segment.end) invalid();
        previousTime = time; previousPosition = position; count++;
        points.push({ timestampSeconds: time, positionBytes: position });
        if (time <= start) selected = { timestampSeconds: time, positionBytes: position };
        else if (!next) next = { timestampSeconds: time, positionBytes: position };
      }
    }
    if (!selected || count < 2 || start - selected.timestampSeconds > 60) return null;
    if (end !== undefined) {
      // Include a preceding GOP for codec/audio preroll; timestamps and encoded
      // packets remain untouched in the independent local window.
      selected = points.findLast(point => point.timestampSeconds <= Math.max(0, start - 2)) || points[0];
      if (selected.timestampSeconds > start || start - selected.timestampSeconds > 60) return null;
      next = points.find(point => point.timestampSeconds > start);
    }
    // Metadata hits must never replace the current version/range check of the
    // chosen media. Ignore even local metadata prefetch overlap here.
    const cluster = await header(selected.positionBytes, { fresh: Boolean(metadataCache), force: Boolean(metadataCache) });
    if (cluster.id !== ID.cluster) return null;
    let clusterTime;
    for (let p = cluster.data, i = 0; p < cluster.end && i < 16; i++) {
      const e = await header(p, { fresh: Boolean(metadataCache) });
      if (e.end > cluster.end || e.size === null) invalid();
      if (e.id === 0xe7) { clusterTime = uint(await payload(e, { fresh: Boolean(metadataCache) }), { data: 0, end: e.size, size: e.size }) * scale / 1e9; break; }
      if ([0xa3, 0xa0].includes(e.id)) break;
      p = e.end;
    }
    // A cue may point inside a cluster. Block's signed timestamp is at most 32767 ticks.
    if (clusterTime === undefined || selected.timestampSeconds < clusterTime - 32768 * scale / 1e9 || selected.timestampSeconds > clusterTime + 32767 * scale / 1e9) return null;
    let window;
    if (end !== undefined) {
      let sourceEnd;
      const terminal = points.find(point => point.timestampSeconds >= end + 2 && point.positionBytes > selected.positionBytes);
      if (terminal) {
        const last = await header(terminal.positionBytes, { fresh: Boolean(metadataCache), force: Boolean(metadataCache) });
        if (last.id !== ID.cluster || last.size === null) return null;
        sourceEnd = last.end;
      } else {
        // At EOF, copy through the final clusters, stopping before footer tables.
        const lastPosition = points.at(-1).positionBytes;
        const footer = [...locations.values()].filter(position => position > lastPosition);
        sourceEnd = footer.length ? Math.min(...footer) : segment.end;
      }
      if (sourceEnd <= selected.positionBytes || sourceEnd > segment.end || cluster.size === null) return null;
      const ebmlBytes = await bytes(0, ebml.end, { metadata: Boolean(metadataCache) });
      metadataCache?.put(0, ebmlBytes);
      window = {
        prefix: Buffer.concat([ebmlBytes, Buffer.from('1853806701ffffffffffffff', 'hex'), encodeElement(ID.info, info), encodeElement(ID.tracks, tracks)]),
        sourceStart: selected.positionBytes, sourceEnd,
        timelineStartSeconds: clusterTime, timelineEndSeconds: terminal?.timestampSeconds ?? end,
      };
    }
    signal?.throwIfAborted();
    return { ...selected, method: 'matroska-cues', trackNumber, entries: count, indexBytes: received, nextTimestampSeconds: next?.timestampSeconds ?? null, ...(window ? { window } : {}), ...(metadataCache ? { metadataCache: { hitBytes, hitReads } } : {}) };
  } catch (error) {
    if (error instanceof UnusableIndex) return null;
    throw error;
  }
}

/**
 * Prepare only the metadata and first complete Cluster for local probing.
 * Cues, tags, attachments and arbitrary remote positions are not prerequisites.
 * The original Info duration is returned separately: a single-Cluster file
 * cannot establish the duration of the whole remote movie.
 */
export async function planMatroskaProbe({ read, size, signal } = {}) {
  if (typeof read !== 'function' || !Number.isSafeInteger(size) || size < 16) return null;
  const cache = []; let received = 0, operations = 0;
  async function bytes(position, length) {
    signal?.throwIfAborted();
    if (!Number.isSafeInteger(position) || !Number.isSafeInteger(length) || position < 0 || length < 1
        || !Number.isSafeInteger(position + length) || position + length > size) invalid();
    const hit = cache.find(entry => position >= entry.position && position + length <= entry.position + entry.data.length);
    if (hit) return hit.data.subarray(position - hit.position, position - hit.position + length);
    if (received + length > 4 * 1024 * 1024 || ++operations > 64) invalid();
    const data = await read(position, length);
    if (!Buffer.isBuffer(data) || data.length !== length) invalid();
    received += data.length; cache.push({ position, data });
    return data;
  }
  function width(first, maximum) {
    let count = 1;
    while (count <= 8 && !(first & (1 << (8 - count)))) count++;
    if (count > maximum) invalid();
    return count;
  }
  async function header(position) {
    // Read the exact header width, so skipping an attachment or tail table does
    // not even prefetch the beginning of its payload.
    const idWidth = width((await bytes(position, 1))[0], 4);
    const partial = await bytes(position, idWidth + 1);
    const sizeWidth = width(partial[idWidth], 8);
    const e = element(await bytes(position, idWidth + sizeWidth), 0);
    const data = position + e.data, end = e.size === null ? size : data + e.size;
    if (!Number.isSafeInteger(end) || end > size) invalid();
    return { ...e, position, data, end };
  }
  async function payload(e) {
    if (e.size === null || e.size < 1 || e.size > 4 * 1024 * 1024) invalid();
    return bytes(e.data, e.size);
  }
  try {
    const ebml = await header(0);
    if (ebml.id !== ID.ebml || ebml.size === null) return null;
    const segment = await header(ebml.end);
    if (segment.id !== ID.segment) return null;
    const base = segment.data, locations = new Map(), seekHeads = [], visited = new Set();
    let cluster;
    for (let position = base, count = 0; position < segment.end && count < 32; count++) {
      const e = await header(position);
      if (e.id === ID.cluster) { cluster = e; break; }
      if ([ID.info, ID.tracks].includes(e.id) && (e.size === null || e.size < 1 || e.size > 4 * 1024 * 1024)) invalid();
      if ([ID.info, ID.tracks].includes(e.id) && !locations.has(e.id)) locations.set(e.id, e.position);
      if (e.id === ID.seek) seekHeads.push(e.position);
      if (e.size === null) return null;
      position = e.end;
    }
    if (!cluster || cluster.size === null || cluster.size < 1) return null;
    // SeekHead is consulted only for missing required metadata. In particular,
    // its Cues/Tags/Attachments entries never trigger remote footer requests.
    while ((!locations.has(ID.info) || !locations.has(ID.tracks)) && seekHeads.length) {
      const position = seekHeads.shift();
      if (visited.has(position)) continue;
      if (visited.size >= 8) invalid();
      visited.add(position);
      const h = await header(position);
      if (h.id !== ID.seek) invalid();
      const data = await payload(h);
      for (const entry of children(data).filter(e => e.id === 0x4dbb)) {
        const fields = children(data, entry.data, entry.end);
        const id = uint(data, fields.find(e => e.id === 0x53ab));
        if (![ID.info, ID.tracks, ID.seek].includes(id) || locations.has(id)) continue;
        const at = base + uint(data, fields.find(e => e.id === 0x53ac));
        if (!Number.isSafeInteger(at) || at < base || at >= segment.end) invalid();
        if (id === ID.seek) seekHeads.push(at);
        else locations.set(id, at);
      }
    }
    async function table(id) {
      if (!locations.has(id)) invalid();
      const e = await header(locations.get(id));
      if (e.id !== id || e.end > segment.end) invalid();
      return payload(e);
    }
    const info = await table(ID.info), infoFields = children(info);
    const scaleElement = infoFields.find(e => e.id === 0x2ad7b1);
    const scale = scaleElement ? uint(info, scaleElement) : 1000000;
    if (!(scale > 0 && scale <= 1000000000)) invalid();
    let durationSeconds = null;
    const duration = infoFields.find(e => e.id === 0x4489);
    if (duration && [4, 8].includes(duration.size)) {
      const value = duration.size === 4 ? info.readFloatBE(duration.data) : info.readDoubleBE(duration.data);
      const seconds = value * scale / 1e9;
      if (Number.isFinite(seconds) && seconds > 0) durationSeconds = seconds;
    }
    if (durationSeconds === null) return null;
    const tracks = await table(ID.tracks);
    children(tracks); // A truncated Tracks payload cannot form a local header.
    let timestampSeconds;
    for (let position = cluster.data, count = 0; position < cluster.end && count < 16; count++) {
      const e = await header(position);
      if (e.size === null || e.end > cluster.end) invalid();
      if (e.id === 0xe7) {
        const data = await payload(e);
        timestampSeconds = uint(data, { data: 0, end: data.length, size: data.length }) * scale / 1e9;
        break;
      }
      if ([0xa3, 0xa0].includes(e.id)) break;
      position = e.end;
    }
    if (!Number.isFinite(timestampSeconds) || timestampSeconds < 0 || !(timestampSeconds + 1 > timestampSeconds)) return null;
    const prefix = Buffer.concat([await bytes(0, ebml.end), Buffer.from('1853806701ffffffffffffff', 'hex'), encodeElement(ID.info, info), encodeElement(ID.tracks, tracks)]);
    return {
      method: 'matroska-head', indexBytes: received, durationSeconds,
      window: {
        prefix,
        sourceStart: cluster.position, sourceEnd: cluster.end,
        timelineStartSeconds: timestampSeconds,
        // Structural bounds for the materializer, never a duration or coverage
        // measurement. Only durationSeconds above describes the original Info.
        timelineEndSeconds: timestampSeconds + 1,
      },
    };
  } catch (error) {
    if (error instanceof UnusableIndex) return null;
    throw error;
  }
}
