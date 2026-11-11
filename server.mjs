import http from 'node:http';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFile, stat, lstat, realpath, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createRemoteSource } from './src/remote.mjs';
import { createBrowserHelper } from './src/browser-helper.mjs';
import { createBookmarkCapture } from './src/bookmark-capture.mjs';
import { defaultClipName, sanitizeClipName } from './public/clip-options.mjs';
import { createDirectStream } from './src/direct-stream.mjs';
import { listWebDav } from './src/webdav.mjs';
import { diagnoseDavAuth } from './src/dav-diagnostic.mjs';
import { createHistoryStore, retrySubtitleTrack, sanitizeRetrySettings } from './src/history.mjs';
import { createLocalMediaRegistry } from './src/local-media.mjs';
import { providers, prepareMagnet } from './src/providers.mjs';
import { createPathPicker } from './src/picker.mjs';
import { applyJobProgress } from './src/progress.mjs';
import { jobMetrics, finishJobLease, jobTransferTelemetry } from './src/job-metrics.mjs';
import { createTaskDiagnostics, sanitizeTaskDiagnostics } from './src/task-diagnostics.mjs';
import { locateMatroskaCue, planMatroskaProbe } from './src/matroska-index.mjs';
import { createMatroskaMetadataCache } from './src/matroska-metadata-cache.mjs';
import { createIndexReader } from './src/index-reader.mjs';
import { materializeMatroskaWindow } from './src/matroska-window.mjs';
import { openResumeStore, listResumeStores, discardResumeStore, resumeIdentityHash, resumePlanHash } from './src/resume-store.mjs';
import { createResumeTaskStore, resumeSourceKey, resumeWindowPlan } from './src/resume-tasks.mjs';
import { createTransferGuard } from './src/transfer-guard.mjs';
import { runTransferCheck, transferCheckAvailability } from './src/transfer-check.mjs';
import { setupPlatform, checkOutputDirectory, checkCloudDrive, DEFAULT_DAV_URL } from './src/setup-health.mjs';
import { MediaError, detectTools, probeMedia, exportCandidate, exportCompatibleMp4, probePosition, parseTime } from './src/engine.mjs';

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
const DEFAULT_HANDLES_SECONDS = 5;
const identityDigest = parts => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export async function startServer({ port = 0, outputDir = process.env.CLIP_FETCHER_OUTPUT_DIR || path.join(ROOT, '素材'), dataDir = process.env.CLIP_FETCHER_DATA_DIR || path.join(outputDir, '.clip-fetcher-state'), ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', pickFile, pickDirectory, reveal, reuseMatroskaIndex = true, browserSourceFactory = createRemoteSource, browserStreamFactory = createDirectStream, openBrowser, onBookmarkReady, edition } = {}) {
  const windowsXunleiOnly = edition === 'windows-edge-xunlei';
  const windowsEdgeEdition = windowsXunleiOnly || edition === 'windows-edge-cloud';
  const editionInfo = windowsEdgeEdition ? { edition } : {};
  const visibleProviders = windowsXunleiOnly ? providers.filter(provider => provider.id === 'xunlei') : providers;
  const DEFAULT_OUT = outputDir;
  const tools = { ffmpegPath, ffprobePath };
  const history = await createHistoryStore(dataDir);
  const resumeDirectory = path.join(dataDir, 'resume-data');
  const resumeTasks = await createResumeTaskStore(path.join(dataDir, 'resume-jobs'));
  const localMedia = createLocalMediaRegistry();
  const matroskaMetadata = createMatroskaMetadataCache();
  let historyWarning = false, historyReadWarning = false, closing = false, activePromise, closePromise;
  let pendingHistory = Promise.resolve();
  const sessionToken = randomBytes(32).toString('hex');
  const sources = new Map(), jobs = new Map(), leases = new Map();
  // Per-run idempotency: never evict a key and accidentally re-download its batch.
  const batches = new Map();
  const davConnections = new Map();
  const allowedReveals = new Set();
  const queue = [];
  const probes = new Set();
  const transferChecks = new Map(), disconnectingConnections = new Set();
  let activeTransferCheck = null, activeSetupCheck = null, pendingMediaPreparations = 0;
  const mediaPreparations = new Set();
  const shutdown = new AbortController();
  const pickPath = createPathPicker({ pickFile, pickDirectory, signal: shutdown.signal });
  let activeJob = null, origin, dependencies;
  const browserHelper = createBrowserHelper({ origin: () => origin, signal: shutdown.signal });
  let receiptSequence = 0, lastReceivedAt = null;
  const bookmarkCapture = await createBookmarkCapture({ dataDir, origin: () => origin, signal: shutdown.signal,
    ...(windowsXunleiOnly ? { providerIds: ['xunlei'] } : {}),
    onCandidates() {
      receiptSequence++; lastReceivedAt = Date.now();
      if (!activeJob && !queue.some(job => job.status === 'queued') && typeof onBookmarkReady === 'function') {
        try { Promise.resolve(onBookmarkReady()).catch(() => {}); } catch { /* Foregrounding never changes receipt success. */ }
      }
    } });
  const bookmarkTemplate = await readFile(path.join(ROOT, 'bookmark-capture/capture.js'), 'utf8');
  function bookmarkState() {
    const ready = bookmarkCapture.state();
    let bookmarklet = '';
    if (ready.available) {
      const config = bookmarkCapture.config();
      const source = bookmarkTemplate.replace('__CAPTURE_ORIGIN__', JSON.stringify(config.origin)).replace('__CAPTURE_TOKEN__', JSON.stringify(config.token));
      bookmarklet = 'javascript:' + encodeURIComponent('void ' + source);
    }
    return { ...ready, ...editionInfo, bookmarklet, candidates: bookmarkCapture.listCandidates(), receiptSequence, lastReceivedAt };
  }
  const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
  const error = (code, message) => Object.assign(new Error(message), { code });

  async function body(req) {
    if (!req.headers['content-type']?.startsWith('application/json')) throw error('BAD_REQUEST', '请求需要 JSON 数据。');
    let size = 0, result = '';
    for await (const chunk of req) { size += chunk.length; if (size > 64 * 1024) throw error('BAD_REQUEST', '输入数据过长。'); result += chunk; }
    try { return JSON.parse(result || '{}'); } catch { throw error('BAD_REQUEST', '输入格式不正确。'); }
  }
  function budget(value, fallback) {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(n) || n < 1 || n > 65536) throw error('BUDGET_INVALID', '读取预算请设置在 1—65536 MiB 之间。');
    return Math.floor(n * 1024 * 1024);
  }
  const transferCheckBusy = () => error('TRANSFER_CHECK_BUSY', '请等待当前取片、来源检查或有限测速结束，再开始新的操作。');
  const setupCheckBusy = () => error('SETUP_CHECK_BUSY', '请等待当前检查或取片结束，再检查首次使用环境。');
  function assertNoTransferCheck() {
    if (activeTransferCheck) throw transferCheckBusy();
    if (activeSetupCheck) throw setupCheckBusy();
  }
  async function prepareMediaCommand(action) {
    if (closing) throw error('CLOSING', '工具正在关闭。');
    assertNoTransferCheck();
    pendingMediaPreparations++;
    const pending = Promise.resolve().then(action);
    mediaPreparations.add(pending);
    try { return await pending; }
    finally { pendingMediaPreparations--; mediaPreparations.delete(pending); }
  }
  async function checkSetup(data) {
    if (closing) throw error('CLOSING', '工具正在关闭。');
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || Object.keys(data).some(key => !['outputDir', 'davUrl'].includes(key))
        || (Object.hasOwn(data, 'outputDir') && typeof data.outputDir !== 'string')
        || (Object.hasOwn(data, 'davUrl') && typeof data.davUrl !== 'string'))
      throw error('SETUP_OPTIONS_INVALID', '环境检查只接受保存目录和本机 WebDAV 地址。');
    if (activeSetupCheck || activeTransferCheck || activeJob || queue.some(job => job.status === 'queued')
        || probes.size || pendingMediaPreparations) throw setupCheckBusy();
    const check = { promise: null };
    activeSetupCheck = check;
    check.promise = Promise.resolve().then(async () => {
      const [storage, cloudDrive] = await Promise.all([
        checkOutputDirectory(data.outputDir ?? DEFAULT_OUT, { signal: shutdown.signal }),
        checkCloudDrive(data.davUrl ?? DEFAULT_DAV_URL, { signal: shutdown.signal }),
      ]);
      dependencies = await detectTools({ ...tools, signal: shutdown.signal });
      if (closing || shutdown.signal.aborted) throw error('CLOSING', '工具正在关闭。');
      return { schemaVersion: 1, platform: setupPlatform(),
        tools: { ffmpeg: dependencies.ffmpeg.available === true, ffprobe: dependencies.ffprobe.available === true },
        storage, cloudDrive, checkedAt: new Date().toISOString() };
    });
    try { return await check.promise; }
    finally { if (activeSetupCheck === check) activeSetupCheck = null; }
  }
  function publicTransferCheck(check) {
    return { id: check.id, status: check.status, createdAt: check.createdAt, progress: check.progress,
      ...(check.finishedAt ? { finishedAt: check.finishedAt } : {}), ...(check.report ? { report: check.report } : {}) };
  }
  function createTransferCheck(data) {
    if (closing) throw error('CLOSING', '工具正在关闭。');
    if (activeSetupCheck) throw setupCheckBusy();
    if (activeTransferCheck || activeJob || queue.some(job => job.status === 'queued') || probes.size || pendingMediaPreparations) throw transferCheckBusy();
    if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.sourceId !== 'string'
        || Object.keys(data).some(key => key !== 'sourceId'))
      throw error('TRANSFER_CHECK_OPTIONS_INVALID', '请选择已检查的远程来源。');
    const source = sources.get(data.sourceId);
    if (!source) throw error('SOURCE_MISSING', '请先检查并确认来源。');
    if (source.connectionId && disconnectingConnections.has(source.connectionId)) throw transferCheckBusy();
    if (source.type !== 'http' || !transferCheckAvailability(source.remote))
      throw error('TRANSFER_CHECK_UNAVAILABLE', '该来源暂不支持有限测速；需要至少 32 MiB、可核对强版本标识且能安排独立采样区间的远程文件。');
    while (transferChecks.size >= 4) {
      const oldest = [...transferChecks.values()].find(item => ['completed', 'failed', 'cancelled'].includes(item.status));
      if (!oldest) throw transferCheckBusy();
      transferChecks.delete(oldest.id);
    }
    const check = { id: `transfer-${Date.now()}-${randomBytes(3).toString('hex')}`, status: 'running',
      createdAt: new Date().toISOString(), progress: null, controller: new AbortController(), connectionId: source.connectionId };
    transferChecks.set(check.id, check);
    activeTransferCheck = check;
    // Reserve the exclusive slot synchronously, before starting any async work.
    check.promise = Promise.resolve().then(async () => {
      try {
        const report = await runTransferCheck({ remote: source.remote,
          signal: AbortSignal.any([check.controller.signal, shutdown.signal]), onProgress(progress) { check.progress = progress; } });
        if (!report || !['completed', 'failed', 'cancelled'].includes(report.status)) throw error('TRANSFER_CHECK_FAILED', '有限测速未能完成。');
        check.report = report;
        check.status = report.status;
      } catch {
        // Core owns cleanup and returns safe reports for transport failures.
        // Unexpected exceptions never expose raw messages, URLs or credentials.
        check.status = check.controller.signal.aborted || shutdown.signal.aborted ? 'cancelled' : 'failed';
        check.report = { schemaVersion: 3, status: check.status, conclusion: 'inconclusive',
          errorCode: check.status === 'cancelled' ? 'CANCELLED' : 'TRANSFER_CHECK_FAILED' };
      } finally {
        check.finishedAt = new Date().toISOString();
        if (activeTransferCheck === check) activeTransferCheck = null;
      }
    });
    return publicTransferCheck(check);
  }
  async function cancelTransferCheck(check) {
    if (!['completed', 'failed', 'cancelled'].includes(check.status)) {
      check.controller.abort();
      await check.promise;
    }
    return publicTransferCheck(check);
  }
  function publicJob(job) {
    // Do not announce completion/failure while reads are still settling. The
    // terminal snapshot, byte totals and frozen timer become visible together.
    const finishing = ['completed', 'failed', 'cancelled'].includes(job.status) && job.diagnosticTracker && !job.finishedAt;
    const status = finishing ? 'running' : job.status;
    const diagnostics = job.diagnosticTracker
      ? job.diagnosticTracker.snapshot({ status, transfer: jobTransferTelemetry(job), recoveryAttempts: job.recoveryAttempts, indexCache: job.indexCache })
      : sanitizeTaskDiagnostics(job.diagnostics);
    const resume = publicResume(job);
    const retry = publicRetry(job);
    return { id: job.id, type: job.type || 'extract', ...(job.batchId ? { batchId: job.batchId, clientItemId: job.clientItemId } : {}), ...(job.source?.id ? { sourceId: job.source.id } : {}),
      ...((job.params || job.requested) && job.type !== 'compatible' ? { requested: job.requested || { start: job.params.start, end: job.params.end, handles: job.params.handles } } : {}), queuedAt: job.queuedAt || job.createdAt, sourceLabel: job.sourceLabel, clipName: job.params?.clipName || job.clipName, readMode: job.params?.readMode || job.readMode,
      downloadMethod: job.params?.downloadMethod || job.downloadMethod || 'indexed',
      startedAt: job.startedAt, finishedAt: job.finishedAt, status, stage: finishing ? 'finalizing' : job.stage, progress: finishing ? null : job.progress, message: finishing ? '正在结算读取并清理临时文件…' : job.message, error: finishing ? undefined : job.error, result: job.result, metrics: jobMetrics(job), createdAt: job.createdAt, ...(diagnostics ? { diagnostics } : {}), ...(resume ? { resume } : {}),
      ...(retry ? { retry } : {}), ...(job.retryOf ? { retryOf: job.retryOf } : {}), ...(job.recoveryAttempts > 0 ? { recoveryAttempts: job.recoveryAttempts } : {}) };
  }
  function publicResume(job) {
    const snapshot = job.resumeStore?.snapshot() || job.resumeSnapshot;
    if (!snapshot) return job.resumeReason ? { available: false, reason: job.resumeReason, discardable: job.resumeDiscardable === true } : null;
    return { available: !job.resumeBlocked && !job.result?.candidatePath, reason: job.resumeBlocked,
      discardable: true,
      cachedBytes: snapshot.cachedBytes, totalBytes: snapshot.plan?.sourceEnd - snapshot.plan?.sourceStart,
      receivedBytes: snapshot.receivedBytes, budgetBytes: snapshot.budgetBytes, budgetUsedBytes: snapshot.chargedBytes,
      uncertainBytes: snapshot.uncertainBytes + (job.resumeStore ? 0 : snapshot.reservedBytes),
      reservedBytes: job.resumeStore ? snapshot.reservedBytes : 0,
      needsSource: !job.source || !sources.has(job.source.id), resumeCount: job.resumeCount || 0,
      requested: job.params && { start: job.params.start, end: job.params.end, handles: job.params.handles }, outputDir: job.params?.outputDir,
      readMode: ['continuous', 'parallel'].includes(job.params?.readMode) ? job.params.readMode : 'standard' };
  }
  function finishDiagnostics(job) {
    if (!job.diagnosticTracker) return;
    job.diagnosticTracker.finish();
    job.diagnostics = job.diagnosticTracker.snapshot({ status: job.status, transfer: jobTransferTelemetry(job), recoveryAttempts: job.recoveryAttempts, indexCache: job.indexCache });
    delete job.diagnosticTracker;
  }
  function cancelQueuedJob(job) {
    job.controller.abort();
    if (job.status !== 'queued') return;
    job.status = 'cancelled'; job.stage = 'cancelled'; job.finishedAt = new Date().toISOString();
    finishDiagnostics(job);
  }
  function attachLease(remote, byteBudget, signal, options = {}) {
    const key = randomBytes(32).toString('hex');
    const lease = remote.createLease({ budgetBytes: byteBudget, signal, ...options });
    leases.set(key, lease);
    return { ...lease, inputUrl: `${origin}/media/${key}`, async release() { lease.close(); leases.delete(key); await lease.settle(); }, get error() { return lease.error; } };
  }
  function attachBrowserStream(source, byteBudget, signal) {
    const key = randomBytes(32).toString('hex');
    const lease = browserStreamFactory({ ...source.browserDirect, size: source.size,
      etag: source.remote.validator?.etag, budgetBytes: byteBudget, signal });
    leases.set(key, lease);
    return { ...lease, inputUrl: `${origin}/media/${key}`,
      async release() { lease.close(); leases.delete(key); await lease.settle(); }, get error() { return lease.error; } };
  }
  async function normalizeMedia(media) {
    return { ...media, duration: Number(media.durationSeconds ?? media.duration ?? 0), streams: media.streams || [] };
  }
  function davConnection(id) {
    const connection = typeof id === 'string' && davConnections.get(id);
    if (!connection) throw error('DAV_CONNECTION_MISSING', '云盘连接已失效，请重新连接。');
    return connection;
  }
  function rememberDavListing(connection, listing) {
    const directories = [listing.directoryUrl, listing.parentUrl, ...listing.entries.filter(e => e.isDirectory).map(e => e.url)].filter(Boolean);
    const files = listing.entries.filter(e => !e.isDirectory).map(e => e.url);
    if (connection.directories.size + connection.files.size + directories.length + files.length > 20000) throw error('DAV_ENTRY_LIMIT', '本次浏览的目录过多，请重启面板释放连接。');
    for (const url of directories) connection.directories.add(url);
    for (const url of files) connection.files.add(url);
    return { connectionId: connection.id, rootUrl: connection.rootUrl, directoryUrl: listing.directoryUrl, parentUrl: listing.parentUrl, entries: listing.entries };
  }
  async function connectDav(data) {
    if (davConnections.size >= 8) throw error('DAV_CONNECTION_LIMIT', '本次连接数量达到上限，请重启面板释放连接。');
    if (!data || typeof data.url !== 'string' || typeof data.username !== 'string' || typeof data.password !== 'string' || data.username.length > 1024 || data.password.length > 4096 || data.username.includes(':') || /[\r\n\u0000]/.test(data.username + data.password)) throw error('DAV_INPUT_INVALID', '请填写 CloudDrive2 地址、账号和密码。');
    let listing;
    try {
      listing = await listWebDav({ url: data.url.trim(), username: data.username, password: data.password, signal: shutdown.signal });
    } catch (e) {
      if (['AUTH_REQUIRED', 'ACCESS_DENIED'].includes(e.code)) {
        const independent = await diagnoseDavAuth({ url: data.url.trim(), username: data.username, password: data.password, signal: shutdown.signal });
        e.diagnostics = { primary: { client: 'node-http', status: e.code === 'AUTH_REQUIRED' ? 401 : 403 }, independent };
      }
      throw e;
    }
    if (davConnections.size >= 8) throw error('DAV_CONNECTION_LIMIT', '本次连接数量达到上限，请重启面板释放连接。');
    if (shutdown.signal.aborted) throw error('CANCELLED', '连接已取消。');
    const connection = { controller: new AbortController(), id: randomUUID(), rootUrl: listing.baseUrl, username: data.username, password: data.password, directories: new Set(), files: new Set() };
    const result = rememberDavListing(connection, listing);
    davConnections.set(connection.id, connection);
    return result;
  }
  async function browseDav(data) {
    const connection = davConnection(data?.connectionId);
    if (typeof data.url !== 'string' || !connection.directories.has(data.url)) throw error('DAV_PATH_INVALID', '请从当前云盘列表中选择目录。');
    const listing = await listWebDav({ url: data.url, username: connection.username, password: connection.password, signal: AbortSignal.any([shutdown.signal, connection.controller.signal]) });
    if (connection.controller.signal.aborted) throw error('CANCELLED', '云盘连接已断开。');
    return rememberDavListing(connection, listing);
  }
  function probeSource(data) {
    assertNoTransferCheck();
    const promise = performProbeSource(data);
    probes.add(promise);
    promise.then(() => probes.delete(promise), () => probes.delete(promise));
    return promise;
  }
  async function performProbeSource(data) {
    if (sources.size >= 20) throw error('SOURCE_LIMIT', '本次打开的来源过多，请重启面板释放连接。');
    const input = data.source;
    if (!input || !['local', 'http', 'dav', 'browser'].includes(input.type) || typeof input.value !== 'string') throw error('SOURCE_INVALID', '请选择云盘视频、本地文件或原文件地址。');
    const bookmarkCandidate = input.type === 'browser' ? bookmarkCapture.getCandidate(input.value) : null;
    const browserCandidate = input.type === 'browser' ? bookmarkCandidate || browserHelper.getCandidate(input.value) : null;
    if (input.type === 'browser' && (!browserCandidate || windowsXunleiOnly && browserCandidate.provider !== 'xunlei')) {
      const cloud = windowsXunleiOnly ? '迅雷网盘' : '迅雷云盘或百度网盘';
      throw error('BROWSER_SOURCE_MISSING', windowsEdgeEdition
        ? `请在 Edge 打开${cloud}并使用抓链书签重新识别。`
        : '浏览器文件入口已释放或过期，请在浏览器助手中重新识别。');
    }
    const byteBudget = Math.min(budget(data.budgetMiB, 64), 64 * 1024 * 1024);
    const connection = input.type === 'dav' ? davConnection(input.connectionId) : null;
    const controller = new AbortController();
    let probeTimedOut = false;
    const timeout = setTimeout(() => { probeTimedOut = true; controller.abort(); }, 60000);
    const probeSignal = AbortSignal.any([controller.signal, shutdown.signal, ...(connection ? [connection.controller.signal] : [])]);
    let lease, probeWindow, probePlan;
    try {
      let source, inputValue;
      if (input.type === 'local') {
        if (!path.isAbsolute(input.value)) throw error('SOURCE_INVALID', '本地文件需要完整绝对路径，可使用“选择文件”。');
        const filename = await realpath(input.value);
        const s = await stat(filename);
        if (!s.isFile()) throw error('SOURCE_INVALID', '请选择一个视频文件。');
        source = { id: randomUUID(), type: 'local', filename, identity: { size: s.size, mtimeMs: s.mtimeMs }, label: path.basename(filename), size: s.size };
        source.retryFingerprint = identityDigest(['local', filename, s.dev, s.ino, s.size, s.mtimeMs, s.birthtimeMs]);
        inputValue = filename;
      } else {
        let username = input.username || '', password = input.password || '';
        if (input.type === 'dav') {
          if (!connection.files.has(input.value)) throw error('DAV_PATH_INVALID', '请从云盘列表中选择视频文件。');
          ({ username, password } = connection);
        }
        // Establish identity with the head, then validate every range actually
        // needed by the media/index readers. An unrelated midpoint is not a
        // prerequisite for reading a different, independently checked window.
        const originalUrl = browserCandidate?.url || input.value.trim();
        const remote = await (browserCandidate ? browserSourceFactory : createRemoteSource)({ url: originalUrl, username, password,
          ...(browserCandidate ? { requestHeaders: browserCandidate.headers, networkPolicy: 'public-https' } : {}),
          budgetBytes: byteBudget, signal: probeSignal, initialRanges: 'head' });
        if (browserCandidate?.size && browserCandidate.size !== remote.size) throw error('SOURCE_CHANGED', '浏览器记录的文件大小与原文件响应不一致，请重新识别原文件。');
        const remaining = byteBudget - remote.metrics.receivedBytes;
        if (remaining < 1) throw error('BUDGET_EXCEEDED', '来源检查已用完预算。');
        // Probe clients need a validated first block promptly, even when the
        // upstream is slowly filling its cache. Extraction keeps 1 MiB blocks.
        lease = attachLease(remote, remaining, probeSignal, { serveChunkBytes: 64 * 1024 });
        source = { id: randomUUID(), connectionId: input.type === 'dav' ? input.connectionId : undefined, type: 'http', displayType: input.type, remote, label: remote.label, size: remote.size,
          resumeKey: resumeSourceKey(input.type, originalUrl, username),
          ...(browserCandidate ? { label: browserCandidate.name || remote.label,
            browserDirect: { url: originalUrl, headers: { ...browserCandidate.headers } } } : {}) };
        const version = remote.resumeIdentity;
        if (version) {
          const locator = browserCandidate ? [browserCandidate.provider, source.label.normalize('NFC')] : source.resumeKey;
          source.retryFingerprint = identityDigest([input.type, locator, version.size, version.etagSha256, version.headSha256]);
          source.resumeFingerprint = resumeIdentityHash({ ...version, sourceKey: source.resumeKey });
        }
        probePlan = await planMatroskaProbe({ read: (start, length) => lease.read(start, length, probeSignal), size: remote.size, signal: probeSignal });
        if (probePlan) {
          // Keep media probing inside a finite local head window. A demuxer's
          // optional footer/attachment traversal must not block a different
          // indexed target window that does not use those bytes.
          probeWindow = await materializeMatroskaWindow({ plan: probePlan, read: (start, length) => lease.read(start, length, probeSignal), signal: probeSignal, budgetBytes: remaining - lease.metrics.receivedBytes });
          inputValue = probeWindow.path;
        } else inputValue = lease.inputUrl;
      }
      let media;
      try { media = await probeMedia({ ...tools, sourceInput: inputValue, signal: probeSignal, probeTimeoutMs: 45000 }); }
      catch (e) { throw lease?.error || e; }
      if (lease?.error) throw lease.error;
      if (probeSignal.aborted) throw error('CANCELLED', '来源检查已取消，请重新连接。');
      if (probePlan) {
        media = { ...media, durationSeconds: probePlan.durationSeconds, sizeBytes: source.size, bitrate: source.size * 8 / probePlan.durationSeconds };
      }
      source.media = await normalizeMedia(media);
      sources.set(source.id, source);
      return { sourceId: source.id, directStreamAvailable: Boolean(source.browserDirect && source.remote.resumeIdentity),
        transferCheckAvailable: source.type === 'http' && transferCheckAvailability(source.remote), media: source.media, source: { type: source.displayType || source.type, label: source.label, size: source.size, rangeVerified: source.type === 'http', upstreamVerified: false }, metrics: { receivedBytes: (source.remote?.metrics.receivedBytes || 0) + (lease?.metrics.receivedBytes || 0), requests: (source.remote?.metrics.requests || 0) + (lease?.metrics.requests || 0), upstreamBytes: null } };
    } catch (e) {
      if (probeTimedOut) throw error('TIMEOUT', '来源信息读取超过 60 秒，已停止。请检查所选下载路径的文件入口后重试。');
      throw e;
    } finally {
      clearTimeout(timeout);
      try { await probeWindow?.cleanup(); }
      finally { await lease?.release(); }
    }
  }

  async function startNext() {
    if (activeJob || closing) return;
    const job = queue.shift();
    if (!job) return;
    if (job.status === 'cancelled') return startNext();
    activeJob = job;
    job.startedAt = new Date().toISOString();
    job.status = 'running';
    job.stage = 'checking';
    job.progress = null;
    job.message = '检查来源版本';
    job.diagnosticTracker?.enter('checking');
    const { source, params, controller } = job;
    let lease, staged;
    try {
      const onProgress = p => {
        job.diagnosticTracker?.enter(p.phase || p.stage || job.stage);
        applyJobProgress(job, p);
      };
      if (job.type === 'compatible') {
        const info = await stat(params.candidatePath);
        if (info.size !== params.identity.size || info.mtimeMs !== params.identity.mtimeMs) throw error('SOURCE_CHANGED', '本地素材已改变，请重新取片。');
        const compatible = await exportCompatibleMp4({ ...tools, candidatePath: params.candidatePath, clipName: params.clipName, outputDir: path.dirname(params.candidatePath), jobId: job.id, signal: controller.signal, onProgress });
        job.result = { ...params.originalResult, warnings: (params.originalResult.warnings || []).filter(item => String(item?.code || '').startsWith('SUBTITLE_')), compatiblePath: compatible.outputPath };
        await registerResult(job.result);
        job.progress = 100; job.status = 'completed'; job.stage = 'completed'; job.message = 'MP4 工作副本已保存，原码素材保留';
        return;
      }
      let inputValue;
      if (source.type === 'local') {
        const s = await stat(source.filename);
        if (s.size !== source.identity.size || s.mtimeMs !== source.identity.mtimeMs) throw error('SOURCE_CHANGED', '本地文件已改变，请重新检查来源。');
        inputValue = source.filename;
      } else {
        // A restored task has just been re-probed by the user. Its fresh strong
        // identity is checked before opening the cache; every subsequent request
        // is conditional and charged to the same durable budget.
        if (!job.resumeSnapshot) await source.remote.check(controller.signal);
        if (params.downloadMethod === 'direct-stream') {
          lease = attachBrowserStream(source, params.budgetBytes, controller.signal);
          job.lease = lease; inputValue = lease.inputUrl;
          job.resumeReason = 'stream_no_resume';
          job.preparation = { method: 'direct-stream' };
          onProgress({ phase: 'fetch', percent: null, message: '正在从浏览器识别的原文件入口流式取片。' });
        } else {
        const resumable = Boolean(source.remote.resumeIdentity && source.media.format?.includes('matroska'));
        if (job.resumeSnapshot) {
          if (!resumable) throw error('RESUME_IDENTITY_UNAVAILABLE', '来源没有一致的强版本标识，无法安全恢复这份缓存。');
          job.resumeStore = await openResumeStore({ directory: resumeDirectory, id: job.id,
            identity: { ...source.remote.resumeIdentity, sourceKey: source.resumeKey }, budgetBytes: params.budgetBytes });
          job.resumeSnapshot = job.resumeStore.snapshot();
        }
        const previous = job.resumeSnapshot;
        job.metrics = { budgetBytes: params.budgetBytes, receivedBytes: previous?.receivedBytes || 0, requests: previous?.requests || 0, upstreamBytes: null };
        const remainingBudget = params.budgetBytes - (previous?.chargedBytes || 0);
        if (remainingBudget < 1) throw error('BUDGET_EXCEEDED', '本任务的累计读取预算已用完，续传缓存仍保留。');
        lease = attachLease(source.remote, remainingBudget, controller.signal, resumable ? {
          requireStrongValidator: true,
          accounting: { reserve: bytes => job.resumeStore?.reserve(bytes), settle: (ticket, received) => job.resumeStore.settle(ticket, received) },
        } : {});
        job.lease = lease;
        if (source.media.format?.includes('matroska')) {
          // A media process never sees this original network URL again. Cues
          // select a bounded, independent local window with original timestamps.
          const positioningDeadline = AbortSignal.timeout(90000);
          const positioningSignal = AbortSignal.any([controller.signal, positioningDeadline]);
          onProgress({ phase: 'positioning', percent: null, message: '读取时间索引并核对目标位置。' });
          let indexed, metadataTransaction;
          try {
            const reuseIndex = reuseMatroskaIndex === true && params.reuseIndex !== false && resumable;
            job.indexCache = { enabled: reuseIndex, hitBytes: 0, hitReads: 0 };
            // The parser's logical calls may split into several physical reads.
            // Bound actual dispatches and all newly received indexing bytes,
            // including the fresh full bootstrap check, before each operation.
            const readIndex = createIndexReader({ lease, signal: positioningSignal });
            if (reuseIndex) {
              const identity = { ...source.remote.resumeIdentity, sourceKey: source.resumeKey };
              const head = await readIndex(0, Math.min(source.size, 16384));
              if (createHash('sha256').update(head).digest('hex') !== identity.headSha256)
                throw error('SOURCE_CHANGED', '原文件头部已改变，请重新检查来源。');
              metadataTransaction = matroskaMetadata.begin(identity);
            }
            const videos = source.media.streams.filter(stream => stream.type === 'video' && !stream.attachedPicture);
            const video = videos.find(stream => stream.default) || videos[0];
            indexed = await locateMatroskaCue({ read: readIndex, metadataCache: metadataTransaction,
              size: source.size, start: params.fetchStart, end: params.fetchEnd, videoOrdinal: videos.indexOf(video), videoStreamIndex: video?.index, videoCodec: video?.codec, signal: positioningSignal });
            if (indexed?.metadataCache) job.indexCache = { enabled: reuseIndex, ...indexed.metadataCache };
            if (lease.error) throw lease.error;
            positioningSignal.throwIfAborted();
            if (indexed?.window) metadataTransaction?.commit();
          } catch (failure) {
            metadataTransaction?.discard();
            if (positioningDeadline.aborted && !controller.signal.aborted) throw error('TIMEOUT', '等待目标位置的数据超过 90 秒，任务已停止。已接收量可在任务中查看。');
            throw lease.error || failure;
          } finally {
            // commit/discard are idempotent; an unusable parser result must not
            // publish any partially verified metadata.
            if (!indexed?.window) metadataTransaction?.discard();
          }
          if (!indexed?.window) throw error('INDEX_UNAVAILABLE', '未找到可验证的 MKV 时间索引，已停止，避免顺序读取大量无关内容。需要进一步检查此文件的索引结构。');
          if (resumable) {
            const plan = resumeWindowPlan(indexed.window);
            if (job.resumeStore) {
              if (resumePlanHash(job.resumeStore.snapshot().plan) !== resumePlanHash(plan)) throw error('RESUME_CHANGED', '时间索引或目标区间与缓存不一致，已停止恢复。');
            } else {
              // Metadata is whitelisted separately; it cannot contain a replayable
              // remote link or any cloud credentials.
              await resumeTasks.save({ ...job, sourceKey: source.resumeKey });
              job.resumeStore = await openResumeStore({ directory: resumeDirectory, id: job.id,
                identity: { ...source.remote.resumeIdentity, sourceKey: source.resumeKey }, plan, budgetBytes: params.budgetBytes,
                initialReceivedBytes: lease.metrics.receivedBytes, initialRequests: lease.metrics.requests });
            }
          } else job.resumeReason = source.remote.resumeIdentity ? 'unsupported_format' : 'no_strong_etag';
          const readBatchBytes = params.readMode === 'continuous' ? 4 * 1024 * 1024 : 1024 * 1024;
          if (readBatchBytes > 1024 * 1024
              && (job.resumeStore ? job.resumeStore.snapshot().remainingBytes : params.budgetBytes - jobMetrics(job).receivedBytes) > 0) {
            // Index planning stays on the original small requests. Only the
            // verified target window uses larger contiguous physical ranges.
            await finishJobLease(job, lease); lease = null;
            const remaining = job.resumeStore ? job.resumeStore.snapshot().remainingBytes : params.budgetBytes - job.metrics.receivedBytes;
            if (remaining < 1) throw error('BUDGET_EXCEEDED', '定位检查已用完累计读取上限，续传缓存仍保留。');
            lease = attachLease(source.remote, remaining, controller.signal, { readChunkBytes: readBatchBytes,
              ...(resumable ? { requireStrongValidator: true, accounting: {
                reserve: bytes => job.resumeStore.reserve(bytes), settle: (ticket, received) => job.resumeStore.settle(ticket, received),
              } } : {}) });
            job.lease = lease;
          }
          let writtenBytes = 0;
          const transferGuard = createTransferGuard({ signal: controller.signal,
            getActivity: () => lease.metrics.receivedBytes + writtenBytes });
          try {
            staged = await materializeMatroskaWindow({ plan: indexed, read: (start, length, signal) => lease.read(start, length, signal, { maxAttempts: 3, onRetry({ attempt, maxAttempts }) {
              job.recoveryAttempts = (job.recoveryAttempts || 0) + 1;
              onProgress({ phase: 'fetch', message: `上游读取暂时中断，正在续读当前数据块（第 ${attempt - 1}/${maxAttempts - 1} 次重试）。` });
            } }), budgetBytes: job.resumeStore ? job.resumeStore.snapshot().remainingBytes : lease.metrics.budgetBytes - lease.metrics.receivedBytes,
              cache: job.resumeStore, readBatchBytes, readConcurrency: params.readMode === 'parallel' ? 2 : 1, signal: transferGuard.signal, onProgress(event) {
              if (Number.isSafeInteger(event.receivedBytes) && event.receivedBytes > writtenBytes) writtenBytes = event.receivedBytes;
              onProgress(event);
            } });
          } catch (failure) {
            if (transferGuard.signal.aborted && !controller.signal.aborted) throw transferGuard.signal.reason;
            // A local cache/write failure cancels the look-ahead read. Preserve
            // that failure instead of replacing it with sibling CANCELLED;
            // matching transport failures retain their detailed diagnostic.
            throw lease.error?.code === failure.code ? lease.error : failure;
          } finally { transferGuard.dispose(); }
          await finishJobLease(job, lease); lease = null;
          job.preparation = { method: 'matroska-index-window', sourceStart: indexed.window.sourceStart, sourceEnd: indexed.window.sourceEnd, cueSeconds: indexed.timestampSeconds, trackNumber: indexed.trackNumber };
          inputValue = staged.path;
        } else {
          if (params.fetchStart > 0) {
            onProgress({ phase: 'positioning', percent: null, message: '核对目标时间附近的数据。' });
            const videos = source.media.streams.filter(stream => stream.type === 'video' && !stream.attachedPicture);
            const video = videos.find(stream => stream.default) || videos[0];
            try { await probePosition({ ...tools, sourceInput: lease.inputUrl, start: params.fetchStart, videoTrackIndex: video?.index, signal: controller.signal, probeTimeoutMs: 90000 }); }
            catch (failure) { throw lease.error || failure; }
            await finishJobLease(job, lease); lease = null;
            const remaining = params.budgetBytes - job.metrics.receivedBytes;
            if (remaining < 1) throw error('BUDGET_EXCEEDED', '定位检查已用完本次读取上限，任务已停止。');
            lease = attachLease(source.remote, remaining, controller.signal); job.lease = lease;
          }
          inputValue = lease.inputUrl;
        }
        }
      }
      let candidate;
      try {
        candidate = await exportCandidate({ ...tools, audioTrackIndex: params.audioStreamIndex, clipName: params.clipName, subtitleStreamIndex: params.subtitleStreamIndex, sourceInput: inputValue, absoluteSeek: Boolean(staged), preparation: job.preparation, originalMedia: staged ? source.media : undefined, start: params.fetchStart, end: params.fetchEnd, outputDir: params.outputDir,
          jobId: job.resumeCount > 0 ? `${job.id}-r${job.resumeCount}` : job.id,
          sourceId: source.id, sourceDescriptor: { label: source.label, sizeBytes: source.size, remote: source.type === 'http' }, targetRange: { startSeconds: params.start, endSeconds: params.end, handlesSeconds: params.handles }, signal: controller.signal, onProgress, getRemoteActivity: () => lease?.metrics.receivedBytes ?? 0, beforeCommit() { if (lease?.error) throw lease.error; } });
      } catch (e) { throw lease?.error || e; }
      if (lease) await finishJobLease(job, lease);
      lease = null;
      job.result = { candidatePath: candidate.candidatePath, sidecarPath: candidate.sidecarPath, subtitlePaths: candidate.subtitlePaths || [], subtitleResults: candidate.subtitleResults || [], warnings: candidate.subtitleWarnings || [], requested: { start: params.start, end: params.end, handles: params.handles }, fetched: { start: params.fetchStart, end: params.fetchEnd }, mappingVerified: false };
      await registerResult(job.result);
      if (params.makeMp4) {
        try {
          const compatible = await exportCompatibleMp4({ ...tools, candidatePath: candidate.candidatePath, clipName: params.clipName, outputDir: path.dirname(candidate.candidatePath), jobId: job.id, signal: controller.signal, onProgress });
          job.result.compatiblePath = compatible.outputPath;
          await registerResult(job.result);
        } catch (e) {
          if (controller.signal.aborted) throw e;
          job.result.warnings.push({ code: e.code || 'COMPATIBILITY_FAILED', message: '原码片段已保留；MP4 工作副本未生成。' });
        }
      }
      job.progress = 100;
      job.status = 'completed';
      job.stage = 'completed';
      job.message = job.result.warnings.length ? '原码片段已保存，附加文件需要检查' : '片段已保存，可在剪映中试导入';
    } catch (e) {
      if (e.code === 'SOURCE_CHANGED' && source?.resumeKey) matroskaMetadata.invalidate(source.resumeKey);
      if (['RESUME_CORRUPT', 'RESUME_METADATA_INVALID'].includes(e.code)) job.resumeBlocked = 'cache_invalid';
      const failureStage = ['checking', 'positioning', 'fetch', 'probe', 'extract', 'validate', 'compatible'].includes(job.stage) ? job.stage : undefined;
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
      job.stage = job.status;
      job.progress = null;
      job.error = { code: e.code || 'EXPORT_FAILED', stage: failureStage, message: job.status === 'cancelled' ? '任务已取消；已经保存的原码片段仍保留。' : (e.message || '取片失败。'),
        ...(e.details?.diagnostic ? { diagnostic: String(e.details.diagnostic).slice(0, 6000), tool: ['ffmpeg', 'ffprobe'].includes(e.details.tool) ? e.details.tool : undefined } : {}) };
    } finally {
      job.diagnosticTracker?.enter('other');
      try {
        try { if (lease) await finishJobLease(job, lease); }
        catch { if (job.result) job.result.warnings.push({ code: 'READ_SETTLEMENT_FAILED', message: '素材已保存，但读取统计结算未完成。' }); }
        try { await staged?.cleanup(); }
        catch { if (job.result) job.result.warnings.push({ code: 'TEMP_CLEANUP_FAILED', message: '素材已保存，但临时文件清理未完成。' }); }
        if (job.resumeStore) {
          job.resumeSnapshot = job.resumeStore.snapshot();
          try {
            if (job.result?.candidatePath) {
              await job.resumeStore.discard(); await resumeTasks.discard(job.id);
              delete job.resumeSnapshot;
            } else await job.resumeStore.close();
          } catch { historyWarning = true; }
          finally { await job.resumeStore.close().catch(() => { historyWarning = true; }); }
          delete job.resumeStore;
        }
        job.finishedAt = new Date().toISOString(); finishDiagnostics(job);
        if (source && job.status === 'failed' && retrySourceFailed(job)) source.retryStale = true;
        await saveHistory();
      } finally { activeJob = null; if (!closing) scheduleNext(); }
    }
  }

  async function createJob(data) {
    return prepareMediaCommand(() => performCreateJob(data));
  }
  function validateJobRequest(data, source) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw error('BAD_REQUEST', '任务设置无效。');
    const start = parseTime(data.start), end = parseTime(data.end);
    const handles = Number(data.handles ?? DEFAULT_HANDLES_SECONDS);
    if (end <= start || !Number.isFinite(handles) || handles < 0 || handles > 600) throw error('TIME_INVALID', '结束时间需晚于开始时间，余量应在 0—600 秒之间。');
    if (source.media.duration > 0 && (start >= source.media.duration || end > source.media.duration + 0.1)) throw error('TIME_INVALID', '所选时间超过了文件时长。');
    const fetchStart = Math.max(0, start - handles);
    const fetchEnd = source.media.duration > 0 ? Math.min(source.media.duration, end + handles) : end + handles;
    if (fetchEnd - fetchStart > 600) throw error('WINDOW_TOO_LARGE', '每段最多取 10 分钟，请缩小候选范围。');
    const outputDir = data.outputDir || DEFAULT_OUT;
    if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir)) throw error('OUTPUT_INVALID', '保存目录需要完整绝对路径。');
    if (data.clipName !== undefined && typeof data.clipName !== 'string') throw error('CLIP_NAME_INVALID', '请填写有效的素材名称。');
    if (typeof data.clipName === 'string' && data.clipName.length > 2048) throw error('CLIP_NAME_INVALID', '素材名称过长，请缩短后重试。');
    const clipName = sanitizeClipName(data.clipName || '') || defaultClipName(source.label, start, end);
    const subtitleStreamIndex = data.subtitleStreamIndex == null ? undefined : data.subtitleStreamIndex;
    if (subtitleStreamIndex !== undefined && (!Number.isSafeInteger(subtitleStreamIndex)
        || !source.media.streams.some(stream => stream.type === 'subtitle' && stream.index === subtitleStreamIndex)))
      throw error('INVALID_SUBTITLE_TRACK', '所选字幕轨不存在，请重新检查来源。');
    const audioStreamIndex = data.audioStreamIndex;
    if (audioStreamIndex !== undefined && (audioStreamIndex !== null && (!Number.isInteger(audioStreamIndex) || !source.media.streams.some(stream => stream.type === 'audio' && stream.index === audioStreamIndex)))) throw error('INVALID_TRACK', '所选音轨不存在，请重新检查来源。');
    const selectedReadMode = data.readMode ?? 'standard';
    if (!['standard', 'continuous', 'parallel'].includes(selectedReadMode)) throw error('READ_MODE_INVALID', '请选择稳健模式、连续读取或双路读取。');
    const readMode = source.type === 'http' && source.media.format?.includes('matroska') ? selectedReadMode : 'standard';
    if (readMode === 'parallel' && !source.remote.resumeIdentity)
      throw error('READ_MODE_UNAVAILABLE', '双路读取需要可核对强版本标识的远程 MKV；当前来源请使用稳健模式。');
    if (data.reuseIndex !== undefined && typeof data.reuseIndex !== 'boolean') throw error('INDEX_CACHE_INVALID', '索引复用选项需要开启或关闭。');
    const downloadMethod = data.downloadMethod ?? (source.browserDirect && source.remote.resumeIdentity ? 'direct-stream' : 'indexed');
    if (!['direct-stream', 'indexed'].includes(downloadMethod) || downloadMethod === 'direct-stream' && (!source.browserDirect || !source.remote.resumeIdentity))
      throw error('DIRECT_STREAM_UNAVAILABLE', '流式取片需要已检查、支持强版本核对的浏览器原文件入口。可选择原有索引取片。');
    return { start, end, handles, fetchStart, fetchEnd, outputDir, clipName, ...(subtitleStreamIndex !== undefined ? { subtitleStreamIndex } : {}), makeMp4: data.makeMp4 === true,
      audioStreamIndex, readMode, downloadMethod, reuseIndex: data.reuseIndex !== false, budgetBytes: budget(data.budgetMiB, 256) };
  }
  async function checkJobStorage(params) {
    const storage = await checkOutputDirectory(params.outputDir, { signal: shutdown.signal });
    if (storage.status !== 'ready') throw error(storage.code, storage.message);
  }
  function checkAdmissionSource(source) {
    if (closing || shutdown.signal.aborted) throw error('CLOSING', '工具正在关闭。');
    if (sources.get(source.id) !== source) throw error('SOURCE_MISSING', '来源已断开，请重新连接并检查。');
  }
  function retrySourceFailed(job) {
    if (['AUTH_REQUIRED', 'SOURCE_CHANGED'].includes(job.error?.code)) return true;
    if (job.error?.code === 'ENOENT' && job.error.stage === 'checking' && job.source?.type === 'local') return true;
    if (job.error?.code !== 'REMOTE_HTTP') return false;
    const expired = [401, 403, 404, 410, 412];
    const status = /\bHTTP (401|403|404|410|412)\b/.exec(job.error.message)?.[1];
    return Boolean(status || job.diagnostics?.transfer?.readTimings?.requests.some(request =>
      request.outcome === 'failed' && expired.includes(request.httpStatus)));
  }
  function retryEligible(job) {
    return job && job.type !== 'compatible' && (job.status === 'failed' || job.status === 'cancelled' && job.retryOf && job.retrySettings)
      && job !== activeJob && !job.result?.candidatePath && Boolean(job.retrySettings || job.requested);
  }
  function matchesRetrySource(job, source) {
    if (source === job.source) return true;
    if (job.retrySettings?.sourceFingerprint) return job.retrySettings.sourceFingerprint === source.retryFingerprint;
    if (job.retrySettings?.resumeFingerprint) return job.retrySettings.resumeFingerprint === source.resumeFingerprint;
    return null;
  }
  function findRetrySource(job) {
    const queuedSource = activeJob?.source || queue.find(item => item.status === 'queued' && item.type === 'extract')?.source;
    if (queuedSource && !queuedSource.retryStale && sources.get(queuedSource.id) === queuedSource
        && matchesRetrySource(job, queuedSource) === true) return queuedSource;
    if (job.source && sources.get(job.source.id) === job.source && !job.source.retryStale) return job.source;
    return [...sources.values()].reverse().find(source => !source.retryStale && matchesRetrySource(job, source) === true);
  }
  function publicRetry(job) {
    if (!retryEligible(job)) return undefined;
    const source = findRetrySource(job);
    return { ...(source ? { sourceId: source.id } : {}), needsSubtitleSelection: !job.retrySettings,
      needsSourceConfirmation: !source && !job.retrySettings?.sourceFingerprint && !job.retrySettings?.resumeFingerprint,
      ...(job.retryJobId ? { jobId: job.retryJobId } : {}) };
  }
  function retryReplay(job) {
    if (!job.retryJobId) return null;
    const child = jobs.get(job.retryJobId);
    if (!child) throw error('RETRY_ALREADY_SUBMITTED', '这条记录已提交过重试，重试记录已移出列表。');
    return publicJob(child);
  }
  function retryJob(id, data) {
    const original = jobs.get(id);
    const replay = original && retryReplay(original);
    return replay || prepareMediaCommand(() => performRetryJob(id, data));
  }
  async function performRetryJob(id, data) {
    const original = jobs.get(id);
    if (!retryEligible(original) || original.historyDeleting || original.resumeStarting)
      throw error('RETRY_UNAVAILABLE', '这条记录没有可重试的失败取材设置，或正在处理。');
    const replay = retryReplay(original);
    if (replay) return replay;
    if (!data || typeof data !== 'object' || Array.isArray(data)
        || Object.keys(data).some(key => !['sourceId', 'subtitleStreamIndex', 'confirmSource'].includes(key))
        || (Object.hasOwn(data, 'sourceId') && typeof data.sourceId !== 'string')) throw error('BAD_REQUEST', '重试设置无效。');

    const source = data.sourceId ? sources.get(data.sourceId) : findRetrySource(original);
    if (!source || source.retryStale)
      throw error('RETRY_SOURCE_REQUIRED', '请重新选择并检查原影片，再提交重试。');
    const matches = matchesRetrySource(original, source);
    if (matches === false || matches === null && (!original.sourceLabel || original.sourceLabel !== source.label))
      throw error('RETRY_SOURCE_MISMATCH', '所选来源与原记录不符，请检查原来的影片。');
    if (matches === null && data.confirmSource !== true)
      throw error('RETRY_SOURCE_CONFIRM_REQUIRED', '旧记录缺少来源校验信息。请确认所选文件是原来的影片。');

    const settings = original.retrySettings;
    if (!settings && !Object.hasOwn(data, 'subtitleStreamIndex'))
      throw error('RETRY_SUBTITLE_REQUIRED', '旧记录未保存字幕选项，请选择是否另存字幕。');
    const subtitleStreamIndex = settings ? settings.subtitleStreamIndex : data.subtitleStreamIndex;
    if (subtitleStreamIndex !== null) {
      const track = source.media.streams.find(item => item.type === 'subtitle' && item.index === subtitleStreamIndex);
      const expected = settings?.subtitleTrack;
      const actual = retrySubtitleTrack(track);
      if (!track || expected && (expected.codec !== actual.codec || expected.language !== actual.language))
        throw error('RETRY_SUBTITLE_CHANGED', '原字幕轨无法在已检查的文件中核对，请重新检查同一影片。');
    }
    const budgetBytes = settings?.budgetBytes ?? original.metrics?.budgetBytes;
    const params = validateJobRequest({ ...(settings || original.requested), clipName: settings?.clipName || original.clipName,
      readMode: settings?.readMode ?? original.readMode, downloadMethod: settings?.downloadMethod ?? original.downloadMethod,
      subtitleStreamIndex, ...(budgetBytes >= 1024 * 1024 ? { budgetMiB: budgetBytes / (1024 * 1024) } : {}) }, source);
    assertBatchSource(source);
    await checkJobStorage(params);
    if (jobs.get(id) !== original || !retryEligible(original) || original.historyDeleting || original.resumeStarting)
      throw error('RETRY_UNAVAILABLE', '原记录已变化，请刷新后再试。');
    const after = retryReplay(original);
    if (after) return after;
    checkAdmissionSource(source);
    if (source.retryStale) throw error('RETRY_SOURCE_REQUIRED', '请重新检查原影片后再提交重试。');
    assertBatchSource(source);
    reserveJob(1, original);
    const child = makeExtractJob(source, params, { retryOf: id });
    original.retryJobId = child.id;
    enqueueJobs([child]);
    return publicJob(child);
  }
  function extractRetrySettings(source, params) {
    const subtitleTrack = source.media.streams.find(track => track.type === 'subtitle' && track.index === params.subtitleStreamIndex);
    return sanitizeRetrySettings({ ...params, subtitleStreamIndex: params.subtitleStreamIndex ?? null,
      subtitleTrack, sourceFingerprint: source.retryFingerprint });
  }
  function makeExtractJob(source, params, metadata = {}) {
    const createdAt = new Date().toISOString();
    const job = { ...metadata, type: 'extract', sourceLabel: source.label, id: `clip-${Date.now()}-${randomBytes(3).toString('hex')}`, createdAt, queuedAt: createdAt,
      status: 'queued', stage: 'queued', message: '等待取片', progress: null, source, params, controller: new AbortController() };
    job.retrySettings = extractRetrySettings(source, params);
    job.diagnosticTracker = createTaskDiagnostics({ sourceKind: source.type === 'local' ? 'local' : 'remote' });
    return job;
  }
  function enqueueJobs(created) {
    for (const job of created) { jobs.set(job.id, job); queue.push(job); }
    scheduleNext();
  }
  async function performCreateJob(data) {
    if (closing) throw error('CLOSING', '工具正在关闭。');
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw error('BAD_REQUEST', '任务设置无效。');
    const source = sources.get(data.sourceId);
    if (!source) throw error('SOURCE_MISSING', '请先检查并确认来源。');
    const params = validateJobRequest(data, source);
    await checkJobStorage(params); checkAdmissionSource(source);
    reserveJob();
    const job = makeExtractJob(source, params); enqueueJobs([job]);
    return publicJob(job);
  }
  const canonicalBatch = value => JSON.stringify(value, function(_key, item) {
    return item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item;
  });
  function batchRequest(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !['sourceId', 'clientBatchId', 'jobs'].includes(key))
        || typeof data.clientBatchId !== 'string' || !/^[a-f0-9]{32}$/.test(data.clientBatchId)
        || !Array.isArray(data.jobs) || data.jobs.length < 1 || data.jobs.length > 10) throw error('BATCH_INVALID', '请一次提交 1—10 段同一影片的取材设置。');
    const signature = createHash('sha256').update(canonicalBatch(data)).digest('hex');
    const existing = batches.get(data.clientBatchId);
    if (existing && existing.signature !== signature) throw error('BATCH_CHANGED', '这次提交的设置已变化，请先核对原队列。');
    return { signature, existing };
  }
  function assertBatchSource(source) {
    const pending = [activeJob, ...queue].filter(job => job && job.type === 'extract' && (job === activeJob || job.status === 'queued'));
    if (pending.some(job => job.source?.id !== source.id)) throw error('SOURCE_BUSY', '队列正使用另一部影片，请等待完成后再切换。');
  }
  function publicBatch(batch) {
    return { batchId: batch.id, sourceId: batch.sourceId, createdAt: batch.createdAt, jobCount: batch.jobCount, jobs: batch.jobs.map(publicJob) };
  }
  async function createJobBatch(data) {
    const { existing } = batchRequest(data);
    if (existing) return publicBatch(existing);
    return prepareMediaCommand(async () => {
      const { signature, existing: before } = batchRequest(data);
      if (before) return publicBatch(before);
      const source = sources.get(data.sourceId);
      if (!source) throw error('SOURCE_MISSING', '请先检查并确认来源。');
      assertBatchSource(source);
      const seen = new Set(), itemIds = [];
      const params = data.jobs.map((item, index) => {
        try {
          if (!item || typeof item !== 'object' || Array.isArray(item) || Object.hasOwn(item, 'sourceId')) throw error('BATCH_INVALID', '同一批次只能使用已检查的这一部影片。');
          const itemId = item.clientItemId ?? randomBytes(16).toString('hex');
          if (typeof itemId !== 'string' || !/^[a-f0-9]{32}$/.test(itemId) || seen.has(itemId)) throw error('BATCH_INVALID', '片段提交标识无效或重复，请重新提交。');
          seen.add(itemId); itemIds.push(itemId);
          return validateJobRequest(item, source);
        } catch (failure) { failure.message = `第 ${index + 1} 段：${failure.message}`; failure.itemIndex = index; throw failure; }
      });
      // Local path checks only. Queued jobs do not contact the cloud before they start.
      for (let index = 0; index < params.length; index++) {
        try { await checkJobStorage(params[index]); }
        catch (failure) { failure.message = `第 ${index + 1} 段：${failure.message}`; failure.itemIndex = index; throw failure; }
      }
      checkAdmissionSource(source);
      const { existing: after } = batchRequest(data);
      if (after) return publicBatch(after);
      assertBatchSource(source);
      if (batches.size >= 100) throw error('BATCH_LIMIT', '本次运行保留的批次较多，请等待完成后重新打开工具。');
      reserveJob(params.length);
      const created = params.map((item, index) => makeExtractJob(source, item, { batchId: data.clientBatchId, clientItemId: itemIds[index] }));
      const batch = { id: data.clientBatchId, sourceId: source.id, signature, createdAt: new Date().toISOString(), jobCount: created.length, jobs: created };
      batches.set(batch.id, batch); enqueueJobs(created);
      return publicBatch(batch);
    });
  }
  function queueSnapshot() {
    const source = activeJob?.type === 'extract' ? activeJob.source : queue.find(job => job.status === 'queued' && job.type === 'extract')?.source;
    return { activeJob: activeJob ? publicJob(activeJob) : null,
      queuedJobs: queue.filter(job => job.status === 'queued').map(publicJob),
      recentJobs: [...jobs.values()].filter(job => ['completed', 'failed', 'cancelled'].includes(job.status) && job !== activeJob).slice(-100).reverse().map(publicJob),
      activeSource: source ? { sourceId: source.id, label: source.label, type: source.displayType || (source.browserDirect ? 'browser' : source.type), media: source.media,
        directStreamAvailable: Boolean(source.browserDirect && source.remote?.resumeIdentity) } : null,
      batches: [...batches.values()].map(publicBatch), maxQueuedJobs: 10, maxBatchJobs: 10, concurrency: 1 };
  }
  function scheduleNext() {
    setImmediate(() => { if (!activeJob && !closing) activePromise = startNext(); });
  }
  function reserveJob(count = 1, retainedJob) {
    if (queue.filter(job => job.status === 'queued').length + count > 10) throw error('JOB_LIMIT', '等待任务最多 10 条，请先完成部分片段或减少本次提交。');
    const remove = Math.max(0, jobs.size + count - 100);
    const removable = [...jobs.values()].filter(job => ['completed', 'failed', 'cancelled'].includes(job.status) && job !== activeJob && job !== retainedJob && !job.historyDeleting && !job.resumeStarting && !job.resumeSnapshot && !job.resumeDiscardable);
    if (removable.length < remove) throw error('JOB_LIMIT', '保留的续传任务较多，请先完成任务或清除不再需要的续传缓存。');
    for (const job of removable.slice(0, remove)) jobs.delete(job.id);
  }
  async function registerResult(result) {
    if (!result) return;
    for (const filename of [result.candidatePath, result.sidecarPath, result.compatiblePath, ...(result.subtitlePaths || [])].filter(Boolean)) {
      allowedReveals.add(filename); allowedReveals.add(path.dirname(filename));
    }
    if (result.compatiblePath) result.previewUrl = await localMedia.register(result.compatiblePath).catch(() => undefined);
  }
  function updateHistory(removedJobs = new Set()) {
    // Take each snapshot after earlier deletions commit so later task saves
    // cannot put a deleted record back on disk.
    const write = pendingHistory.then(async () => {
      try {
        await history.save([...jobs.values()].filter(job => !removedJobs.has(job)));
        historyWarning = false;
      } catch (failure) {
        historyWarning = true;
        throw failure;
      }
      const affectedBatches = new Set();
      for (const job of removedJobs) {
        jobs.delete(job.id);
        const batch = batches.get(job.batchId);
        if (batch) affectedBatches.add(batch);
      }
      for (const batch of affectedBatches) batch.jobs = batch.jobs.filter(job => !removedJobs.has(job));
    });
    pendingHistory = write.catch(() => {});
    return write;
  }
  async function saveHistory() {
    await updateHistory().catch(() => {});
  }
  const historyHasResume = () => error('HISTORY_HAS_RESUME', '这条记录还有续传缓存，请先清除续传缓存。');
  function historyDeletionBlocker(job) {
    if (!job) return error('JOB_MISSING', '任务不存在。');
    if (closing || job === activeJob || !['completed', 'failed', 'cancelled'].includes(job.status) || job.resumeStarting || job.historyDeleting)
      return error('HISTORY_BUSY', '请等待这条任务结束或当前操作完成，再删除记录。');
    if (job.resumeSnapshot || job.resumeStore || job.resumeDiscardable) return historyHasResume();
    return null;
  }
  async function deleteHistoryRecords(ids, { skipUnavailable = false } = {}) {
    const locked = [];
    const removed = new Set();
    const skipped = [];
    function skip(id, blocker) {
      if (!skipUnavailable) throw blocker;
      skipped.push({ id, code: blocker.code });
    }
    try {
      // Reserve candidates before the first asynchronous cache check, keeping
      // retries, resume operations and other deletions from racing this write.
      for (const id of ids) {
        const job = jobs.get(id), blocker = historyDeletionBlocker(job);
        if (blocker) { skip(id, blocker); continue; }
        job.historyDeleting = true;
        locked.push(job);
      }
      for (const job of locked) {
        // An interrupted cache creation may leave a directory before a
        // snapshot is attached. Keep the record and its cache together.
        const cache = await lstat(path.join(resumeDirectory, job.id)).catch(failure => {
          if (failure.code !== 'ENOENT') throw failure;
        });
        if (closing) throw error('HISTORY_BUSY', '工具正在关闭，请重新打开后再删除记录。');
        if (cache?.isDirectory()) {
          job.resumeReason ||= 'cache_invalid';
          job.resumeDiscardable = true;
          skip(job.id, historyHasResume());
          continue;
        }
        removed.add(job);
      }
      if (removed.size) await updateHistory(removed);
      return { ok: true, ids: [...removed].map(job => job.id), skipped };
    } catch (failure) {
      if (['JOB_MISSING', 'HISTORY_HAS_RESUME', 'HISTORY_BUSY'].includes(failure.code)) throw failure;
      throw error('HISTORY_WRITE_FAILED', '无法保存删除操作，记录已保留。请检查本机数据目录后重试。');
    } finally {
      for (const job of locked) delete job.historyDeleting;
    }
  }
  async function deleteHistoryRecord(id) {
    await deleteHistoryRecords([id]);
    return { ok: true, id };
  }
  async function loadHistory() {
    const records = await history.load().catch(() => {
      historyReadWarning = true;
      historyWarning = true;
      return [];
    });
    for (const job of records) {
      await registerResult(job.result); jobs.set(job.id, job);
    }
    for (const job of jobs.values()) {
      const parent = jobs.get(job.retryOf);
      if (parent) parent.retryJobId = job.id;
    }
    for (const snapshot of await listResumeStores({ directory: resumeDirectory })) {
      let record;
      try { record = await resumeTasks.load(snapshot.id); } catch { /* An invalid descriptor remains explicitly discardable. */ }
      const existing = jobs.get(snapshot.id);
      if (existing?.result?.candidatePath) {
        try { await discardResumeStore({ directory: resumeDirectory, id: snapshot.id }); await resumeTasks.discard(snapshot.id); }
        catch { historyWarning = true; }
        continue;
      }
      if (!record) {
        const status = existing?.status === 'failed' ? 'failed' : 'cancelled';
        jobs.set(snapshot.id, { ...existing, id: snapshot.id, sourceLabel: existing?.sourceLabel || '续传缓存需要清理', type: 'extract',
          status, stage: status, progress: null, resumeReason: 'cache_invalid', resumeDiscardable: true,
          message: '续传设置缺失或损坏，可以清除这份本机缓存。' });
        continue;
      }
      const job = existing || { id: record.id, sourceLabel: record.sourceLabel, createdAt: record.createdAt, type: 'extract', status: 'cancelled', stage: 'cancelled', progress: null };
      job.params = record.params; job.resumeCount = record.resumeCount;
      job.retrySettings ||= sanitizeRetrySettings({ ...record.params, clipName: record.params.clipName || job.clipName,
        subtitleStreamIndex: record.params.subtitleStreamIndex ?? null,
        resumeFingerprint: snapshot.error ? undefined : resumeIdentityHash(snapshot.identity) });
      if (snapshot.error) { job.resumeReason = 'cache_invalid'; job.resumeBlocked = 'cache_invalid'; job.resumeDiscardable = true; }
      else {
        job.resumeSnapshot = snapshot;
        job.metrics = { budgetBytes: snapshot.budgetBytes, receivedBytes: snapshot.receivedBytes, requests: snapshot.requests, upstreamBytes: null };
        job.message = '下载已中断，完整缓存已保留。重新检查同一源文件后可继续。';
      }
      jobs.set(job.id, job);
    }
  }
  async function resumeJob(id, data) {
    return prepareMediaCommand(() => performResumeJob(id, data));
  }
  async function performResumeJob(id, data) {
    const job = jobs.get(id), source = sources.get(data?.sourceId);
    if (!job?.resumeSnapshot || job.result?.candidatePath) throw error('RESUME_MISSING', '这份任务没有可继续的缓存。');
    if (['queued', 'running'].includes(job.status) || activeJob === job || job.resumeStarting || job.historyDeleting) throw error('RESUME_BUSY', '任务正在运行或结算，请勿重复恢复。');
    const retry = jobs.get(job.retryJobId);
    if (retry && (retry === activeJob || ['queued', 'running'].includes(retry.status))) throw error('RESUME_BUSY', '这条记录的重试任务正在排队或运行。');
    if (!source || source.type !== 'http') throw error('SOURCE_MISSING', '请重新连接云盘，选择并检查原来的源文件。');
    if (!source.remote.resumeIdentity) throw error('RESUME_IDENTITY_UNAVAILABLE', '当前来源没有强版本标识，无法安全拼接旧缓存。');
    const identity = { ...source.remote.resumeIdentity, sourceKey: source.resumeKey };
    if (resumeIdentityHash(job.resumeSnapshot.identity) !== resumeIdentityHash(identity)) throw error('RESUME_CHANGED', '所选文件或文件版本与缓存不同，请选择原文件；旧缓存已保留。');
    reserveJob(); job.resumeStarting = true;
    try {
      const record = await resumeTasks.load(id);
      if (!record) throw error('RESUME_MISSING', '未找到续传设置，已停止。');
      const next = await resumeTasks.save({ ...record, resumeCount: record.resumeCount + 1 });
      if (closing) throw error('CLOSING', '工具正在关闭。');
      reserveJob();
      job.params = next.params; job.resumeCount = next.resumeCount; job.source = source;
      job.retrySettings = extractRetrySettings(source, next.params);
      job.controller = new AbortController(); job.status = 'queued'; job.stage = 'queued'; job.progress = null;
      job.queuedAt = new Date().toISOString(); delete job.startedAt;
      job.message = '等待恢复下载；将复用已校验的完整数据块'; delete job.error; delete job.finishedAt;
      delete job.resumeBlocked; delete job.diagnostics; delete job.transferMetrics; delete job.indexCache;
      job.diagnosticTracker = createTaskDiagnostics({ sourceKind: 'remote' });
      queue.push(job); scheduleNext(); return publicJob(job);
    } finally { job.resumeStarting = false; }
  }
  async function discardResume(id) {
    const job = jobs.get(id);
    if (!job) throw error('JOB_MISSING', '任务不存在。');
    if (['queued', 'running'].includes(job.status) || activeJob === job || job.resumeStarting || job.historyDeleting) throw error('RESUME_BUSY', '请先停止任务并等待结算，再清除续传缓存。');
    job.resumeStarting = true;
    try {
      await discardResumeStore({ directory: resumeDirectory, id }); await resumeTasks.discard(id);
      delete job.resumeSnapshot; delete job.resumeBlocked; delete job.resumeReason; delete job.resumeDiscardable;
      return publicJob(job);
    } finally { job.resumeStarting = false; }
  }
  async function createCompatibleJob(id) {
    return prepareMediaCommand(() => performCreateCompatibleJob(id));
  }
  async function performCreateCompatibleJob(id) {
    const original = jobs.get(id);
    const candidatePath = original?.result?.candidatePath;
    if (!candidatePath) throw error('CANDIDATE_MISSING', '没有已保存的原码素材，请先取片。');
    if ([...jobs.values()].some(j => j.type === 'compatible' && j.params?.candidatePath === candidatePath && ['queued', 'running'].includes(j.status))) throw error('OUTPUT_BUSY', '这份素材正在生成 MP4 工作副本。');
    const info = await stat(candidatePath);
    if (closing) throw error('CLOSING', '工具正在关闭。');
    if ([...jobs.values()].some(j => j.type === 'compatible' && j.params?.candidatePath === candidatePath && ['queued', 'running'].includes(j.status))) throw error('OUTPUT_BUSY', '这份素材正在生成 MP4 工作副本。');
    if (!info.isFile()) throw error('CANDIDATE_MISSING', '原码素材已移动，请重新取片。');
    const requestedClipName = original.params?.clipName || original.clipName;
    let compatibleClipName = requestedClipName;
    if (requestedClipName) {
      for (let suffix = 1; suffix <= 100; suffix++) {
        compatibleClipName = suffix === 1 ? requestedClipName : `${requestedClipName} (${suffix})`;
        const paths = [path.join(path.dirname(candidatePath), compatibleClipName + '.mp4'), path.join(path.dirname(candidatePath), compatibleClipName + '.mp4.json')];
        const existing = await Promise.all(paths.map(filename => stat(filename).then(() => true, failure => { if (failure.code === 'ENOENT') return false; throw failure; })));
        if (!existing.some(Boolean)) break;
        if (suffix === 100) throw error('OUTPUT_LIMIT', '同名工作副本较多，请先整理保存文件夹。');
      }
    }
    if (closing) throw error('CLOSING', '工具正在关闭。');
    if ([...jobs.values()].some(j => j.type === 'compatible' && j.params?.candidatePath === candidatePath && ['queued', 'running'].includes(j.status))) throw error('OUTPUT_BUSY', '这份素材正在生成 MP4 工作副本。');
    reserveJob();
    const job = { id: `mp4-${Date.now()}-${randomBytes(3).toString('hex')}`, type: 'compatible', sourceLabel: original.sourceLabel, clipName: original.params?.clipName || original.clipName, result: { ...original.result, compatiblePath: undefined, previewUrl: undefined }, status: 'queued', stage: 'queued', createdAt: new Date().toISOString(), message: '等待生成本地 MP4 工作副本', progress: null, controller: new AbortController(), params: { candidatePath, clipName: compatibleClipName, identity: { size: info.size, mtimeMs: info.mtimeMs }, originalResult: { ...original.result, previewUrl: undefined, compatiblePath: undefined } } };
    job.diagnosticTracker = createTaskDiagnostics({ sourceKind: 'local' });
    jobs.set(job.id, job); queue.push(job); scheduleNext(); return publicJob(job);
  }
  async function handleApi(req, res, route) {
    if (route === '/api/bootstrap' && req.method === 'GET') {
      dependencies ||= await detectTools(tools);
      return json(res, 200, { sessionToken, version: VERSION, platform: setupPlatform(), ...editionInfo, providers: visibleProviders, historyWarning, historyReadWarning, defaults: { outputDir: DEFAULT_OUT, samplePath: path.join(ROOT, 'examples', '示例视频.mkv'), handles: DEFAULT_HANDLES_SECONDS, budgetMiB: 256 }, dependencies, ...queueSnapshot(),
        transferCheck: activeTransferCheck ? publicTransferCheck(activeTransferCheck) : null });
    }
    if (req.method === 'POST' && req.headers['x-session-token'] !== sessionToken) return json(res, 403, { error: { code: 'FORBIDDEN', message: '操作会话已失效，请刷新面板。' } });
    if (route === '/api/bookmark-capture/state' && req.method === 'GET') return json(res, 200, bookmarkState());
    if (route === '/api/browser-helper/state' && req.method === 'GET') return json(res, 200, { ...browserHelper.pairingInfo(), candidates: browserHelper.listCandidates() });
    if (['/api/browser-helper/open', '/api/bookmark-capture/open'].includes(route) && req.method === 'POST') {
      const data = await body(req);
      const browsers = windowsEdgeEdition ? ['edge'] : ['chrome', 'edge'];
      if (!data || !browsers.includes(data.browser) || Object.keys(data).some(key => key !== 'browser'))
        throw error('BROWSER_INVALID', windowsEdgeEdition ? '请使用 Microsoft Edge。' : '请选择 Chrome 或 Edge。');
      const pairingUrl = route === '/api/bookmark-capture/open' ? origin + '/bookmark/install' : browserHelper.pairingInfo().url;
      try {
        if (openBrowser) await openBrowser(data.browser, pairingUrl);
        else if (process.platform === 'darwin') await run('/usr/bin/open', ['-a', data.browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge', pairingUrl]);
        else if (process.platform === 'win32') {
          const relative = data.browser === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
          const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
          let executable;
          for (const root of roots) { const candidate = path.join(root, ...relative); try { await access(candidate); executable = candidate; break; } catch {} }
          if (!executable) throw error('BROWSER_MISSING', '');
          // Confirm launch, then detach without waiting for the user's browser
          // to exit or collecting browser output containing the pairing URL.
          await new Promise((resolve, reject) => {
            const child = spawn(executable, [pairingUrl], { detached: true, stdio: 'ignore' });
            child.once('error', reject); child.once('spawn', () => { child.unref(); resolve(); });
          });
        } else throw error('BROWSER_UNSUPPORTED', '');
      } catch (failure) {
        if (windowsEdgeEdition) {
          if (failure.code === 'BROWSER_MISSING') throw error('BROWSER_MISSING', '未找到 Microsoft Edge，请先安装 Edge，再重新打开片段取材。');
          throw error('BROWSER_OPEN_FAILED', '未能自动打开 Edge。请在 Edge 中打开本机面板，再使用抓链书签。');
        }
        throw error('BROWSER_OPEN_FAILED', '未能打开所选浏览器，请确认已安装，或使用复制配对地址。');
      }
      return json(res, 200, { opened: true });
    }
    if (route === '/api/browser-helper/reset' && req.method === 'POST') { await body(req); return json(res, 200, browserHelper.reset()); }
    if (route === '/api/browser-helper/forget' && req.method === 'POST') { const data = await body(req); return json(res, 200, { removed: browserHelper.forget(data.id) }); }
    if (route === '/api/setup/check' && req.method === 'POST') return json(res, 200, await checkSetup(await body(req)));
    if (route === '/api/magnets/prepare' && req.method === 'POST') {
      const data = await body(req);
      if (windowsXunleiOnly && data?.providerId !== 'xunlei') throw error('PROVIDER_INVALID', '请选择迅雷云盘。');
      return json(res, 200, prepareMagnet(data));
    }
    if (route === '/api/jobs/queue' && req.method === 'GET') return json(res, 200, queueSnapshot());
    if (route === '/api/jobs/batch' && req.method === 'POST') return json(res, 202, await createJobBatch(await body(req)));
    if (route === '/api/jobs/history' && req.method === 'GET') return json(res, 200, { jobs: [...jobs.values()].reverse().map(publicJob) });
    if (route === '/api/transfer-checks' && req.method === 'POST') return json(res, 202, createTransferCheck(await body(req)));
    const transferMatch = /^\/api\/transfer-checks\/([a-zA-Z0-9-]+)(\/cancel)?$/.exec(route);
    if (transferMatch) {
      const check = transferChecks.get(transferMatch[1]);
      if (!check) return json(res, 404, { error: { code: 'TRANSFER_CHECK_MISSING', message: '本次有限测速记录不存在或已释放。' } });
      if (!transferMatch[2] && req.method === 'GET') return json(res, 200, publicTransferCheck(check));
      if (transferMatch[2] && req.method === 'POST') { await body(req); return json(res, 200, await cancelTransferCheck(check)); }
    }
    if (route === '/api/dav/disconnect' && req.method === 'POST') {
      const data = await body(req), connection = davConnections.get(data.connectionId);
      disconnectingConnections.add(data.connectionId);
      try {
        const check = activeTransferCheck;
        if (check && connection && check.connectionId === connection.id) await cancelTransferCheck(check);
        connection?.controller.abort(); davConnections.delete(data.connectionId);
        for (const [id, source] of sources) if (source.connectionId === data.connectionId) {
          matroskaMetadata.invalidate(source.resumeKey); sources.delete(id);
        }
        for (const job of jobs.values()) if (job.source?.connectionId === data.connectionId && ['queued', 'running'].includes(job.status)) cancelQueuedJob(job);
        await saveHistory(); return json(res, 200, { ok: true });
      } finally {
        disconnectingConnections.delete(data.connectionId);
      }
    }
    const compatibleMatch = /^\/api\/jobs\/([a-zA-Z0-9-]+)\/compatible$/.exec(route);
    if (compatibleMatch && req.method === 'POST') { await body(req); return json(res, 202, await createCompatibleJob(compatibleMatch[1])); }
    if (route.startsWith('/api/local-media/')) return localMedia.serve(req, res, route.slice('/api/local-media/'.length));
    if (route === '/api/dav/connect' && req.method === 'POST') return json(res, 200, await connectDav(await body(req)));
    if (route === '/api/dav/list' && req.method === 'POST') return json(res, 200, await browseDav(await body(req)));
    if (route === '/api/probe' && req.method === 'POST') return json(res, 200, await probeSource(await body(req)));
    if (route === '/api/jobs' && req.method === 'POST') return json(res, 202, await createJob(await body(req)));
    const retryMatch = /^\/api\/jobs\/([a-zA-Z0-9-]{1,80})\/retry$/.exec(route);
    if (retryMatch && req.method === 'POST') {
      const data = await body(req);
      return json(res, 202, await retryJob(retryMatch[1], data));
    }
    if (route === '/api/jobs/delete-history' && req.method === 'POST') {
      const data = await body(req), ids = data?.ids;
      if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || Object.keys(data).length !== 1
          || ids.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(id)) || new Set(ids).size !== ids.length)
        throw error('BAD_REQUEST', '请选择 1—100 条不同的历史记录。');
      try {
        return json(res, 200, await deleteHistoryRecords(ids, { skipUnavailable: true }));
      } catch (failure) {
        return json(res, failure.code === 'HISTORY_WRITE_FAILED' ? 500 : 409, { error: { code: failure.code, message: failure.message } });
      }
    }
    const deleteHistoryMatch = /^\/api\/jobs\/([a-zA-Z0-9-]{1,80})\/delete-history$/.exec(route);
    if (deleteHistoryMatch && req.method === 'POST') {
      await body(req);
      try {
        return json(res, 200, await deleteHistoryRecord(deleteHistoryMatch[1]));
      } catch (failure) {
        const status = failure.code === 'JOB_MISSING' ? 404 : failure.code === 'HISTORY_WRITE_FAILED' ? 500 : 409;
        return json(res, status, { error: { code: failure.code, message: failure.message } });
      }
    }
    const resumeMatch = /^\/api\/jobs\/([a-zA-Z0-9-]+)\/(resume|discard-resume)$/.exec(route);
    if (resumeMatch && req.method === 'POST') {
      const data = await body(req);
      return json(res, resumeMatch[2] === 'resume' ? 202 : 200, resumeMatch[2] === 'resume' ? await resumeJob(resumeMatch[1], data) : await discardResume(resumeMatch[1]));
    }
    const match = /^\/api\/jobs\/([a-zA-Z0-9-]+)(\/cancel)?$/.exec(route);
    if (match) {
      const job = jobs.get(match[1]);
      if (!job) return json(res, 404, { error: { code: 'JOB_MISSING', message: '任务不存在。' } });
      if (!match[2] && req.method === 'GET') return json(res, 200, publicJob(job));
      if (match[2] && req.method === 'POST') {
        if (!['completed', 'failed', 'cancelled'].includes(job.status)) cancelQueuedJob(job);
        await saveHistory();
        return json(res, 200, publicJob(job));
      }
    }
    if (['/api/pick-file', '/api/pick-directory'].includes(route) && req.method === 'POST') {
      await body(req);
      const directory = route.endsWith('directory');
      const selected = await pickPath(directory);
      return json(res, 200, { path: selected });
    }
    if (route === '/api/reveal' && req.method === 'POST') {
      const data = await body(req);
      if (!allowedReveals.has(data.path)) throw error('PATH_INVALID', '只能显示工具已保存的素材。');
      await access(data.path);
      if (reveal) await reveal(data.path);
      else if (process.platform === 'darwin') await run('/usr/bin/open', ['-R', data.path]);
      else if (process.platform === 'win32') await run('explorer.exe', ['/select,', data.path]);
      else await run('xdg-open', [path.dirname(data.path)]);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: { code: 'NOT_FOUND', message: '此功能尚未提供。' } });
  }

  await loadHistory();
  const server = http.createServer(async (req, res) => {
    try {
      if (closing) return json(res, 503, { error: { code: 'CLOSING', message: '工具正在关闭。' } });
      if (browserHelper.matches(req)) return await browserHelper.handle(req, res);
      if (bookmarkCapture.matches(req)) return await bookmarkCapture.handle(req, res);
      if (req.headers.host !== new URL(origin).host) return json(res, 403, { error: { code: 'FORBIDDEN', message: '仅允许本机面板访问。' } });
      const url = new URL(req.url, origin);
      // A bookmark's user-initiated popup may navigate from an official cloud
      // page. This one static document has no embedded token or file data.
      const receiverNavigation = req.method === 'GET' && url.pathname === '/bookmark/receive' && /^(?:\?__trace_id__=[a-f0-9]{32})?$/.test(url.search);
      if (!receiverNavigation && ((req.headers.origin && req.headers.origin !== origin) || req.headers['sec-fetch-site'] === 'cross-site')) return json(res, 403, { error: { code: 'FORBIDDEN', message: '仅允许本机面板访问。' } });
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (url.pathname.startsWith('/media/')) {
        const lease = leases.get(url.pathname.slice(7));
        if (!lease) { res.writeHead(404); res.end(); return; }
        return await lease.serve(req, res);
      }
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url.pathname);
      const allowed = new Map([['/', 'index.html'], ['/app.js', 'app.js'], ['/budget.mjs', 'budget.mjs'], ['/job-diagnostics.mjs', 'job-diagnostics.mjs'], ['/resume-view.mjs', 'resume-view.mjs'], ['/transfer-check-view.mjs', 'transfer-check-view.mjs'], ['/setup-view.mjs', 'setup-view.mjs'], ['/styles.css', 'styles.css'],
        ['/shark-fin.svg', 'shark-fin.svg'], ['/shark-wordmark.svg', 'shark-wordmark.svg'],
        ['/browser-helper-view.mjs', 'browser-helper-view.mjs'], ['/browser-helper-help.html', 'browser-helper-help.html'],
        ['/browser-pair', 'browser-helper-help.html'], ['/browser-helper.zip', 'browser-helper.zip'],
        ['/queue-workspace.mjs', 'queue-workspace.mjs'], ['/clip-options.mjs', 'clip-options.mjs'], ['/bookmark-capture-view.mjs', 'bookmark-capture-view.mjs'], ['/bookmark/receive', 'bookmark-receive.html'],
        ['/bookmark-receive.js', 'bookmark-receive.js'], ['/bookmark/install', 'bookmark-install.html'], ['/bookmark-install.js', 'bookmark-install.js']]);
      const filename = allowed.get(url.pathname);
      if (!filename || req.method !== 'GET') { res.writeHead(404); res.end(); return; }
      const data = await readFile(path.join(ROOT, 'public', filename));
      const contentType = filename.endsWith('.zip') ? 'application/zip'
        : filename.endsWith('.html') ? 'text/html; charset=utf-8'
        : filename.endsWith('.svg') ? 'image/svg+xml; charset=utf-8'
        : /\.m?js$/.test(filename) ? 'text/javascript; charset=utf-8'
        : 'text/css; charset=utf-8';
      res.writeHead(200, { 'Content-Type': contentType,
        ...(filename.endsWith('.zip') ? { 'Content-Disposition': 'attachment; filename="clip-fetcher-browser-helper.zip"' } : {}),
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", 'Cache-Control': 'no-store' });
      res.end(data);
    } catch (e) {
      if (res.headersSent) { res.destroy(); return; }
      const mediaTool = e instanceof MediaError ? String(e.details?.tool || '').replace(/\.exe$/i, '').toLowerCase() : '';
      const mediaDiagnostic = ['ffprobe', 'ffmpeg'].includes(mediaTool) && typeof e.details?.diagnostic === 'string'
        ? { tool: mediaTool, exitCode: Number.isInteger(e.details.exitCode) ? e.details.exitCode : null,
          diagnostic: e.details.diagnostic.replace(/https?:\/\/[^\s"'<>\]\)]+/gi, '[链接已隐藏]').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 6000) } : null;
      json(res, 400, { error: { code: e.code || 'INTERNAL_ERROR', message: ['ENOENT', 'EACCES', 'EPERM'].includes(e.code) ? '无法访问该文件或目录，请检查路径和权限。' : e.message || '操作未完成。', ...(Number.isInteger(e.itemIndex) && e.itemIndex >= 0 && e.itemIndex < 10 ? { itemIndex: e.itemIndex } : {}), ...(e.diagnostics ? { diagnostics: e.diagnostics } : {}), ...(mediaDiagnostic ? { mediaDiagnostic } : {}) } });
    }
  });
  async function listenAt(selectedPort) {
    await new Promise((resolve, reject) => {
      const onError = failure => { server.removeListener('listening', onListening); reject(failure); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError); server.once('listening', onListening); server.listen(selectedPort, '127.0.0.1');
    });
  }
  const preferredPort = port === 0 ? bookmarkCapture.preferredPort : null;
  try { await listenAt(preferredPort || port); }
  catch (failure) { if (preferredPort && ['EADDRINUSE', 'EACCES'].includes(failure.code)) await listenAt(0); else { bookmarkCapture.close(); throw failure; } }
  origin = `http://127.0.0.1:${server.address().port}`;
  await bookmarkCapture.bindPort(server.address().port);
  return {
    server, url: origin,
    close() {
      if (closePromise) return closePromise;
      closePromise = (async () => {
        closing = true;
        shutdown.abort();
        browserHelper.close();
        bookmarkCapture.close();
        const transferCheck = activeTransferCheck;
        transferCheck?.controller.abort();
        for (const job of jobs.values()) {
          if (!job.controller || ['completed', 'failed', 'cancelled'].includes(job.status)) continue;
          cancelQueuedJob(job);
        }
        for (const lease of leases.values()) lease.close();
        await transferCheck?.promise;
        await activeSetupCheck?.promise.catch(() => {});
        await Promise.allSettled([...mediaPreparations]);
        await activePromise?.catch(() => {});
        await Promise.allSettled([...probes]);
        await saveHistory();
        localMedia.clear(); matroskaMetadata.clear(); davConnections.clear(); sources.clear(); jobs.clear(); batches.clear(); leases.clear(); transferChecks.clear(); disconnectingConnections.clear(); queue.length = 0;
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      })();
      return closePromise;
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const app = await startServer({ port: Number(process.env.CLIP_FETCHER_PORT || 0) });
  console.log(`片段取材 ${VERSION} · 本机面板 ${app.url}`);
  console.log('关闭此终端或按 Ctrl+C 停止。迅雷上游读取量需单独验证。');
  if (process.argv.includes('--open') && process.platform === 'darwin') run('/usr/bin/open', [app.url]).catch(() => {});
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => app.close().then(() => process.exit(0)));
}
