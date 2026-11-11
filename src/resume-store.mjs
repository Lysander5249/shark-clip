import { mkdir, open, readFile, rename, rm, lstat, readdir, link } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const CHUNK_BYTES = 1024 * 1024;
const MAX_BYTES = 65536 * CHUNK_BYTES;
const MAX_MANIFEST_BYTES = 12 * CHUNK_BYTES;
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/;
const HASH = /^[a-f0-9]{64}$/;
const isHash = value => typeof value === 'string' && HASH.test(value);
const isId = value => typeof value === 'string' && ID.test(value);
const sha = value => createHash('sha256').update(value).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const integer = (value, min = 0, max = MAX_BYTES) => Number.isSafeInteger(value) && value >= min && value <= max;
class ResumeStoreError extends Error {
  constructor(code, message) { super(message); this.name = 'ResumeStoreError'; this.code = code; }
}
const fail = (code = 'RESUME_INVALID') => new ResumeStoreError(code, ({
  RESUME_INVALID: '断点记录无效，已停止恢复。',
  RESUME_CHANGED: '源文件或取片计划与断点记录不一致，已停止恢复。',
  RESUME_CORRUPT: '已保存的片段区间校验失败，已停止恢复。',
  RESUME_BUSY: '该断点正被另一任务使用，请先结束原任务。',
  RESUME_CLOSED: '断点存储已关闭。',
  RESUME_QUOTA: '断点缓存已达到空间上限。',
  BUDGET_EXCEEDED: '已达到本工具的累计读取预算，任务已停止。',
}[code] || '无法保存断点，请检查本机空间和目录权限。'));

function identityRecord(value) {
  // The caller must freshly verify a strong ETag before opening a prior store.
  // Only hashes are persisted: no server supplied ETag, URL, account or token.
  if (!value || !isHash(value.sourceKey) || !isHash(value.etagSha256)
      || !isHash(value.headSha256) || !integer(value.size, 1, Number.MAX_SAFE_INTEGER)) throw fail();
  return { sourceKey: value.sourceKey, size: value.size, etagSha256: value.etagSha256, headSha256: value.headSha256 };
}

function planRecord(value) {
  if (!value || value.version !== 1 || !integer(value.sourceStart, 0, Number.MAX_SAFE_INTEGER)
      || !integer(value.sourceEnd, 1, Number.MAX_SAFE_INTEGER) || value.sourceEnd <= value.sourceStart
      || !isHash(value.prefixSha256) || !Number.isFinite(value.timelineStartSeconds) || value.timelineStartSeconds < 0
      || !Number.isFinite(value.timelineEndSeconds) || value.timelineEndSeconds <= value.timelineStartSeconds) throw fail();
  return { version: 1, sourceStart: value.sourceStart, sourceEnd: value.sourceEnd, prefixSha256: value.prefixSha256,
    timelineStartSeconds: value.timelineStartSeconds, timelineEndSeconds: value.timelineEndSeconds };
}

export const resumePlanHash = plan => sha(JSON.stringify(planRecord(plan)));
export const resumeIdentityHash = identity => sha(JSON.stringify(identityRecord(identity)));

function location(directory, id) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory) || directory.includes('\0') || !isId(id)) throw fail();
  return { root: path.resolve(directory), task: path.join(path.resolve(directory), id) };
}

async function regular(filename, max = Number.MAX_SAFE_INTEGER) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw fail('RESUME_CORRUPT');
  return stat;
}

async function directoryOnly(directory, create = false) {
  if (create) await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fail('RESUME_INVALID');
}

async function syncDirectory(directory) {
  let handle;
  try { handle = await open(directory, 'r'); await handle.sync(); }
  catch (error) {
    // Windows and some mounted filesystems do not implement directory fsync.
    if (!['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES'].includes(error.code)) throw error;
  } finally { await handle?.close(); }
}

async function atomicWrite(directory, filename, content) {
  const temporary = path.join(directory, `.write-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(content); await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, filename); await syncDirectory(directory);
  } finally { await handle?.close().catch(() => {}); await rm(temporary, { force: true }).catch(() => {}); }
}

function rangeRecord(value, plan) {
  if (!value || !integer(value.offset, 0, Number.MAX_SAFE_INTEGER) || !integer(value.length, 1, CHUNK_BYTES)
      || value.offset < plan.sourceStart || value.offset >= plan.sourceEnd
      || (value.offset - plan.sourceStart) % CHUNK_BYTES !== 0
      || value.length !== Math.min(CHUNK_BYTES, plan.sourceEnd - value.offset) || !isHash(value.sha256)) throw fail('RESUME_CORRUPT');
  return { offset: value.offset, length: value.length, sha256: value.sha256 };
}

function manifestRecord(value) {
  if (!value || value.schemaVersion !== 1 || !isId(value.id) || !integer(value.budgetBytes, 1)
      || !integer(value.maxCacheBytes, 1) || !integer(value.receivedBytes) || !integer(value.uncertainBytes)
      || !integer(value.requests, 0, 1e9) || !Array.isArray(value.ranges) || value.ranges.length > 65536
      || !Array.isArray(value.reservations) || value.reservations.length > 1024) throw fail('RESUME_CORRUPT');
  const identity = identityRecord(value.identity), plan = planRecord(value.plan);
  if (plan.sourceEnd > identity.size) throw fail('RESUME_CORRUPT');
  const offsets = new Set(), tickets = new Set();
  const ranges = value.ranges.map(item => {
    const range = rangeRecord(item, plan);
    if (offsets.has(range.offset)) throw fail('RESUME_CORRUPT');
    offsets.add(range.offset); return range;
  }).sort((a, b) => a.offset - b.offset);
  const reservations = value.reservations.map(item => {
    if (!item || typeof item.ticket !== 'string' || !/^[a-f0-9-]{36}$/.test(item.ticket) || tickets.has(item.ticket) || !integer(item.bytes, 1)) throw fail('RESUME_CORRUPT');
    tickets.add(item.ticket); return { ticket: item.ticket, bytes: item.bytes };
  });
  const reservedBytes = reservations.reduce((total, item) => total + item.bytes, 0);
  if (value.receivedBytes + value.uncertainBytes + reservedBytes > value.budgetBytes
      || ranges.reduce((total, item) => total + item.length, 0) > value.maxCacheBytes) throw fail('RESUME_CORRUPT');
  return { schemaVersion: 1, id: value.id, identity, plan, budgetBytes: value.budgetBytes, maxCacheBytes: value.maxCacheBytes,
    receivedBytes: value.receivedBytes, uncertainBytes: value.uncertainBytes, requests: value.requests, ranges, reservations };
}

function publicSnapshot(value) {
  const reservedBytes = value.reservations.reduce((total, item) => total + item.bytes, 0);
  const chargedBytes = value.receivedBytes + value.uncertainBytes + reservedBytes;
  const { reservations, ...safe } = value;
  return clone({ ...safe, reservedBytes, chargedBytes, remainingBytes: value.budgetBytes - chargedBytes,
    cachedBytes: value.ranges.reduce((total, item) => total + item.length, 0) });
}

async function readManifest(task) {
  const filename = path.join(task, 'manifest.json');
  await regular(filename, MAX_MANIFEST_BYTES);
  try { return manifestRecord(JSON.parse(await readFile(filename, 'utf8'))); }
  catch (error) { if (error instanceof ResumeStoreError) throw error; throw fail('RESUME_CORRUPT'); }
}

async function acquireLock(task) {
  const filename = path.join(task, '.lock'), token = randomUUID();
  const candidate = path.join(task, `.lock-${process.pid}-${token}.tmp`);
  let handle;
  try {
    // Publish a fully fsynced owner record atomically. Creating .lock directly
    // could leave an empty, unidentifiable lock if the process died mid-write.
    handle = await open(candidate, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, token })); await handle.sync(); await handle.close(); handle = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await link(candidate, filename);
        return async () => {
          try {
            await regular(filename, 1024);
            if (JSON.parse(await readFile(filename, 'utf8')).token === token) await rm(filename);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await regular(filename, 1024);
        let prior, priorText;
        try { priorText = await readFile(filename, 'utf8'); prior = JSON.parse(priorText); } catch { throw fail('RESUME_BUSY'); }
        if (!integer(prior.pid, 1, 2147483647)) throw fail('RESUME_BUSY');
        try { process.kill(prior.pid, 0); throw fail('RESUME_BUSY'); }
        catch (probe) {
          if (probe.code !== 'ESRCH') throw fail('RESUME_BUSY');
          // Re-read before removing a dead owner's lock; live owners are never stolen.
          if (await readFile(filename, 'utf8') !== priorText) throw fail('RESUME_BUSY');
          await rm(filename);
        }
      }
    }
    throw fail('RESUME_BUSY');
  } finally { await handle?.close().catch(() => {}); await rm(candidate, { force: true }).catch(() => {}); }
}

const chunkName = range => `${range.offset}-${range.length}.bin`;

/** Durable exact-range cache for the indexed MKV target window. Network callers
 * reserve before dispatch and settle after transport termination, including on
 * failure. A crash charges unresolved reservations in full, so restart can never
 * reset the user's byte cap. Passwords and signed URLs are not accepted fields. */
export async function openResumeStore({ directory, id, identity: inputIdentity, plan: inputPlan,
  budgetBytes, initialReceivedBytes = 0, initialRequests = 0, maxCacheBytes = budgetBytes } = {}) {
  const paths = location(directory, id), identity = identityRecord(inputIdentity);
  if (!integer(budgetBytes, 1) || !integer(maxCacheBytes, 1) || !integer(initialReceivedBytes)
      || initialReceivedBytes > budgetBytes || !integer(initialRequests, 0, 1e9)) throw fail();
  await directoryOnly(paths.root, true); await directoryOnly(paths.task, true);
  const unlock = await acquireLock(paths.task);
  let state, closed = false, poisoned = false, pending = Promise.resolve();
  const persist = async next => {
    try {
      const checked = manifestRecord(next);
      await atomicWrite(paths.task, path.join(paths.task, 'manifest.json'), JSON.stringify(checked, null, 2));
      state = checked;
    } catch (error) { poisoned = true; throw error; }
  };
  const serial = action => {
    const operation = pending.catch(() => {}).then(() => {
      if (closed || poisoned) throw fail('RESUME_CLOSED');
      return action();
    });
    pending = operation; return operation;
  };
  try {
    try { state = await readManifest(paths.task); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const plan = planRecord(inputPlan);
      if (plan.sourceEnd > identity.size) throw fail();
      state = { schemaVersion: 1, id, identity, plan, budgetBytes, maxCacheBytes, receivedBytes: initialReceivedBytes,
        uncertainBytes: 0, requests: initialRequests, ranges: [], reservations: [] };
      await persist(state);
    }
    if (state.id !== id || resumeIdentityHash(state.identity) !== resumeIdentityHash(identity)
        || (inputPlan && resumePlanHash(state.plan) !== resumePlanHash(inputPlan))
        || state.budgetBytes !== budgetBytes || state.maxCacheBytes !== maxCacheBytes) throw fail('RESUME_CHANGED');
    const keptNames = new Set(state.ranges.map(chunkName));
    for (const range of state.ranges) {
      const filename = path.join(paths.task, chunkName(range));
      try {
        const stat = await regular(filename, CHUNK_BYTES);
        if (stat.size !== range.length || sha(await readFile(filename)) !== range.sha256) throw fail('RESUME_CORRUPT');
      } catch { throw fail('RESUME_CORRUPT'); }
    }
    // A crash can leave fully written data without a manifest commit. It is not
    // trusted as cached; remove only recognized orphan names, never follow links.
    for (const entry of await readdir(paths.task, { withFileTypes: true })) {
      if ((/^\d+-\d+\.bin$/.test(entry.name) && !keptNames.has(entry.name))
          || /^\.(?:write-[a-f0-9-]+|lock-\d+-[a-f0-9-]+)\.tmp$/.test(entry.name)) {
        if (!entry.isFile() || entry.isSymbolicLink()) throw fail('RESUME_CORRUPT');
        await rm(path.join(paths.task, entry.name));
      }
    }
    if (state.reservations.length) {
      await persist({ ...state, uncertainBytes: state.uncertainBytes + state.reservations.reduce((total, item) => total + item.bytes, 0), reservations: [] });
    }
  } catch (error) { await unlock().catch(() => {}); throw error; }

  return {
    snapshot() { return publicSnapshot(state); },
    has(offset, length) { return !closed && state.ranges.some(item => item.offset === offset && item.length === length); },
    get(offset, length) { return serial(async () => {
      const range = state.ranges.find(item => item.offset === offset && item.length === length);
      if (!range) return null;
      const filename = path.join(paths.task, chunkName(range));
      let data;
      try { const stat = await regular(filename, CHUNK_BYTES); if (stat.size !== length) throw fail('RESUME_CORRUPT'); data = await readFile(filename); }
      catch (error) { if (error instanceof ResumeStoreError) throw error; throw fail('RESUME_CORRUPT'); }
      if (sha(data) !== range.sha256) throw fail('RESUME_CORRUPT');
      return data;
    }); },
    put(offset, data) { return serial(async () => {
      if (!Buffer.isBuffer(data)) throw fail();
      const range = rangeRecord({ offset, length: data.length, sha256: sha(data) }, state.plan);
      const previous = state.ranges.find(item => item.offset === offset);
      if (previous) {
        if (previous.length !== range.length || previous.sha256 !== range.sha256) throw fail('RESUME_CHANGED');
        return publicSnapshot(state);
      }
      if (publicSnapshot(state).cachedBytes + data.length > state.maxCacheBytes) throw fail('RESUME_QUOTA');
      await atomicWrite(paths.task, path.join(paths.task, chunkName(range)), data);
      await persist({ ...state, ranges: [...state.ranges, range] });
      return publicSnapshot(state);
    }); },
    reserve(bytes) { return serial(async () => {
      if (!integer(bytes, 1)) throw fail();
      if (bytes > publicSnapshot(state).remainingBytes) throw fail('BUDGET_EXCEEDED');
      if (state.reservations.length >= 1024 || state.requests >= 1e9) throw fail();
      const ticket = randomUUID();
      await persist({ ...state, requests: state.requests + 1, reservations: [...state.reservations, { ticket, bytes }] });
      return ticket;
    }); },
    settle(ticket, receivedBytes) { return serial(async () => {
      const reservation = state.reservations.find(item => item.ticket === ticket);
      if (!reservation || !integer(receivedBytes, 0, reservation.bytes)) throw fail();
      await persist({ ...state, receivedBytes: state.receivedBytes + receivedBytes,
        reservations: state.reservations.filter(item => item.ticket !== ticket) });
      return publicSnapshot(state);
    }); },
    async close() {
      await pending.catch(() => {});
      if (!closed) { closed = true; await unlock(); }
    },
    async discard() {
      await pending.catch(() => {});
      if (closed) throw fail('RESUME_CLOSED');
      if (state.reservations.length) throw fail('RESUME_BUSY');
      closed = true;
      try { await rm(paths.task, { recursive: true, force: true }); await syncDirectory(paths.root); }
      catch (error) { await unlock().catch(() => {}); throw error; }
    },
  };
}

export async function listResumeStores({ directory } = {}) {
  const { root } = location(directory, 'list');
  try { await directoryOnly(root); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const entries = await readdir(root, { withFileTypes: true }), result = [];
  for (const entry of entries.filter(item => ID.test(item.name)).sort((a, b) => a.name.localeCompare(b.name)).slice(0, 1000)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    try {
      const manifest = await readManifest(path.join(root, entry.name));
      if (manifest.id !== entry.name) throw fail('RESUME_CORRUPT');
      result.push(publicSnapshot(manifest));
    } catch (error) { result.push({ id: entry.name, error: { code: error instanceof ResumeStoreError ? error.code : 'RESUME_CORRUPT' } }); }
  }
  return result;
}

/** Explicitly discard an idle task, including a corrupt manifest. */
export async function discardResumeStore({ directory, id } = {}) {
  const paths = location(directory, id);
  try { await directoryOnly(paths.root); await directoryOnly(paths.task); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const unlock = await acquireLock(paths.task);
  try { await rm(paths.task, { recursive: true, force: true }); await syncDirectory(paths.root); return true; }
  catch (error) { await unlock().catch(() => {}); throw error; }
}
