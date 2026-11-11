/* Local application UI. Credentials and source URLs stay in memory only. */
'use strict';

import { estimateReadBudget } from './budget.mjs';
import { createDiagnosticReport, formatJobDiagnostics } from './job-diagnostics.mjs';
import { resumeView, historyRequestedRange } from './resume-view.mjs';
import { transferDuration, transferConclusion, transferTimingView, transferLiveWaitText } from './transfer-check-view.mjs';
import { setupHealthView, setupPlatformLabel, setupCheckAddress } from './setup-view.mjs';
import { browserDownloadMethod, extractionUiPolicy, downloadMethodLabel } from './browser-helper-view.mjs';
import { bookmarkCaptureState, createBookmarkInboxView, renderBookmarkCandidates } from './bookmark-capture-view.mjs';
import { defaultClipName, sanitizeClipName } from './clip-options.mjs';
import { createQueueWorkspace } from './queue-workspace.mjs';

const $ = (id) => document.getElementById(id);
const state = {
  token: '', connected: false, dependenciesReady: true, sourceType: 'browser', windowsEdge: false, windowsXunleiOnly: false,
  sourceId: null, sourceSignature: null, probe: null, probing: false, picking: null, queueSource: null, setupGuideClosedFor: '', queueActionPending: false,
  job: null, busy: false, submitting: false, queuedJobIds: new Set(), startedAt: null, finishedAt: null, pollTimer: null, elapsedTimer: null,
  pollFailures: 0, cancelRequested: false, toastTimer: null, samplePath: null,
  providers: [], providerId: 'xunlei', magnet: null, preparingMagnet: false,
  history: [], loadingHistory: false, historyRequest: 0, lastHistoryJob: null,
  budgetRecommendationMiB: null, diagnosticReport: null, manualDiagnosticCopy: false,
  resumeAction: null, clipNameEdited: false, clipNameSourceKey: null,
  setupChecking: false, setupReport: null, setupGuideInitialized: false,
  transferCheck: null, transferChecking: false, transferCheckPoll: null, transferCheckCancelling: false, transferCheckPollFailed: false,
  dav: { connectionId: null, rootUrl: '', directoryUrl: '', parentUrl: null, entries: [], selectedUrl: '', selectedName: '', loading: false, requestId: 0 },
  browser: { available: false, bookmarklet: '', candidates: [], selectedId: '', selected: null, generation: 0,
    requestId: 0, loading: false, timer: null, draftDirty: false, notice: '', installOpening: '' },
};
let queueWorkspace = null;
const bookmarkInbox = createBookmarkInboxView();
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);

function setVisible(id, visible) { $(id).hidden = !visible; }
function showError(id, message) {
  $(id).textContent = redact(message); setVisible(id, Boolean(message));
  if (id === 'probe-error' && !message) {
    $('probe-diagnostic').open = false;
    $('probe-diagnostic-text').textContent = '';
    setVisible('probe-diagnostic', false);
  }
}
function redact(value) {
  let message = String(value || '操作未完成，请重试。');
  for (const id of ['source-password', 'dav-password']) {
    const password = $(id).value;
    if (password) message = message.split(password).join('••••');
  }
  return message.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1••••@');
}
function toast(message) {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message;
  setVisible('toast', true);
  state.toastTimer = setTimeout(() => setVisible('toast', false), 3500);
}

async function api(path, { method = 'GET', body } = {}) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    headers['X-Session-Token'] = state.token;
  }
  let response;
  try { response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' }); }
  catch { throw new Error('无法连接本机服务。请确认启动窗口仍在运行，然后刷新页面。'); }
  let data;
  try { data = await response.json(); }
  catch { throw new Error('本机服务未返回有效结果。请查看启动窗口，确认服务正常运行。'); }
  if (!response.ok) {
    const error = new Error(data.error?.message || data.message || `请求未完成（${response.status}）。`);
    error.code = data.error?.code;
    error.status = response.status;
    error.diagnostics = data.error?.diagnostics;
    error.mediaDiagnostic = data.error?.mediaDiagnostic;
    throw error;
  }
  return data;
}

function dependencyAvailable(value) {
  if (typeof value === 'boolean') return value;
  if (value === null) return false;
  if (value && typeof value === 'object') {
    for (const key of ['available', 'found', 'ok']) if (typeof value[key] === 'boolean') return value[key];
    if (value.error && !value.path) return false;
  }
  return true;
}

function applyWindowsEdition() {
  const cloudNames = state.windowsXunleiOnly ? '迅雷云盘' : '迅雷云盘或百度网盘';
  const labels = {
    'setup-summary': state.windowsXunleiOnly ? 'Windows x64 · Edge · 迅雷' : 'Windows x64 · Edge · 迅雷 / 百度',
    'setup-step-one': `在 Microsoft Edge 中登录自己的${cloudNames}。`,
    'setup-step-two': '按 Ctrl+Shift+B 显示收藏夹栏，把抓链按钮拖入一次。',
    'setup-step-three': '抓链遇到问题时，可从「我的云盘」通过 CloudDrive2 取材。',
    'dav-provider-scope': cloudNames,
    'browser-provider-intro': `在保存书签的 Edge 配置文件中登录${cloudNames}。抓链时保持 Shark 运行。`,
    'bookmark-step-install': '首次按 Ctrl+Shift+B 显示 Edge 收藏夹栏，拖入按钮。',
    'bookmark-step-trigger': `在${cloudNames}点抓链书签，再播放或下载影片。`,
    'bookmark-install-hint': '按钮无法拖动时，可在 Edge 中打开安装页。',
  };
  for (const [id, label] of Object.entries(labels)) $(id).textContent = label;
  setVisible('bookmark-install-chrome', false);
  setVisible('edge-xunlei-entry', true);
  setVisible('edge-baidu-entry', !state.windowsXunleiOnly);
  setVisible('edge-download-hint', true);
}

async function bootstrap() {
  try {
    const data = await api('/api/bootstrap');
    if (!data.sessionToken) throw new Error('本机服务未提供会话凭证，请重启服务。');
    state.token = data.sessionToken;
    state.connected = true;
    if (data.version) $('app-version').textContent = data.version;
    const historyNotice = data.historyReadWarning
      ? '本机历史记录读取失败，原历史文件已保留。本次新增记录仅在当前会话可见。请检查历史文件后重启 Shark。'
      : data.historyWarning ? '本机历史记录或续传缓存处理异常。请检查数据目录及其权限。' : '';
    $('history-notice').textContent = historyNotice;
    setVisible('history-notice', Boolean(historyNotice));
    $('setup-summary').textContent = setupPlatformLabel(data.platform);
    state.windowsXunleiOnly = data.edition === 'windows-edge-xunlei';
    state.windowsEdge = state.windowsXunleiOnly || data.edition === 'windows-edge-cloud';
    if (state.windowsEdge) applyWindowsEdition();
    const providerIds = state.windowsXunleiOnly ? ['xunlei'] : ['xunlei', 'baidu'];
    state.providers = Array.isArray(data.providers) ? data.providers.filter((provider) => providerIds.includes(provider.id)) : [];
    renderProviders();
    const defaults = data.defaults || {};
    if (defaults.outputDir) $('output-dir').value = defaults.outputDir;
    if (Number.isFinite(defaults.budgetMiB)) $('budget').value = defaults.budgetMiB;
    if (Number.isFinite(defaults.handles)) $('handles').value = defaults.handles;
    if (typeof defaults.makeMp4 === 'boolean') $('make-mp4').checked = defaults.makeMp4;
    if (defaults.samplePath) state.samplePath = defaults.samplePath;
    const deps = data.dependencies || {};
    const missing = ['ffmpeg', 'ffprobe'].filter((name) => name in deps && !dependencyAvailable(deps[name]));
    state.dependenciesReady = missing.length === 0;
    if (missing.length) {
      showError('connection-notice', `${missing.join('、')} 不可用。请重新解压完整安装包；开发运行请检查运行环境配置。`);
      $('dependency-state').textContent = '运行环境尚未就绪';
      $('dependency-state').classList.add('readiness-warning');
      $('probe-state').textContent = '请先检查视频处理组件';
      $('setup-guide').open = true;
    } else {
      $('dependency-state').textContent = '本机服务已连接';
      $('probe-state').textContent = '等待选择源文件';
    }
    if (queueWorkspace) {
      const snapshot = data.queue || data;
      queueWorkspace.hydrate(snapshot);
      initializeSetupGuide(snapshot.recentJobs?.length > 0);
    } else if (data.activeJob?.id) {
      state.startedAt = parseStartedAt(data.activeJob.startedAt || data.activeJob.createdAt) || Date.now();
      renderJob(data.activeJob);
      if (!terminalStatuses.has(data.activeJob.status)) beginPolling(data.activeJob.id);
    }
    if (data.transferCheck?.id) {
      renderTransferCheck(data.transferCheck);
      if (!terminalStatuses.has(data.transferCheck.status)) pollTransferCheck(data.transferCheck.id);
    }
    if (!queueWorkspace) loadHistory();
  } catch (error) {
    state.connected = false;
    showError('connection-notice', error.message);
    $('probe-state').textContent = '本机服务连接失败';
    $('dependency-state').textContent = '本机服务未连接 · 请检查启动窗口';
    $('dependency-state').classList.add('readiness-warning');
    $('output-dir').placeholder = '服务连接后显示默认目录';
  }
  updateRange();
  updateControls();
  if (state.connected) refreshBrowserCapture();
}

async function checkSetup() {
  if (state.setupChecking || state.busy || state.transferChecking || state.probing || state.picking || state.resumeAction || state.dav.loading || !state.connected) return;
  const davUrl = setupCheckAddress($('dav-url').value);
  if (!davUrl) {
    invalidateSetup();
    $('setup-check-state').textContent = '请填写不含账号、密码、查询参数或片段的本机 WebDAV 地址。账号密码只填写在下方连接表单。';
    return;
  }
  state.setupChecking = true;
  state.setupReport = null;
  setVisible('setup-check-results', false);
  $('setup-check-state').textContent = '正在检查视频处理组件、保存位置和本机 WebDAV…';
  updateControls();
  try {
    const report = await api('/api/setup/check', { method: 'POST', body: { outputDir: $('output-dir').value, davUrl } });
    const view = setupHealthView(report, { windowsEdge: state.windowsEdge, xunleiOnly: state.windowsXunleiOnly });
    if (!view) throw new Error('检查结果格式不正确，请重新打开最新版工具。');
    state.setupReport = report;
    state.dependenciesReady = report.tools?.ffmpeg === true && report.tools?.ffprobe === true;
    $('dependency-state').textContent = state.dependenciesReady ? '本机服务已连接 · FFmpeg / FFprobe' : '运行环境尚未就绪';
    $('dependency-state').classList.toggle('readiness-warning', !state.dependenciesReady);
    showError('connection-notice', state.dependenciesReady ? '' : '视频处理组件不可用，请重新解压完整安装包；开发运行请检查配置。');
    const results = $('setup-check-results'); results.replaceChildren();
    for (const item of view.items) {
      const row = document.createElement('li'); row.className = `setup-result setup-${item.tone}`;
      const label = document.createElement('strong'); label.textContent = item.label;
      const detail = document.createElement('span'); detail.textContent = item.detail;
      row.append(label, detail); results.append(row);
    }
    $('setup-check-state').textContent = view.headline;
    setVisible('setup-check-results', true);
  } catch (error) { $('setup-check-state').textContent = redact(error.message); }
  finally { state.setupChecking = false; updateControls(); }
}

function invalidateSetup() {
  if (!state.setupReport) return;
  state.setupReport = null;
  setVisible('setup-check-results', false);
  $('setup-check-state').textContent = '地址或保存位置已更改，请重新检查。';
}

function selectedProvider() { return state.providers.find((provider) => provider.id === state.providerId); }
function renderProviders() {
  const container = $('provider-options');
  container.replaceChildren();
  for (const provider of state.providers) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `provider-option${provider.id === state.providerId ? ' selected' : ''}`;
    button.dataset.provider = provider.id;
    button.setAttribute('aria-pressed', String(provider.id === state.providerId));
    const symbol = document.createElement('span'); symbol.className = 'provider-symbol'; symbol.textContent = provider.id === 'xunlei' ? 'ϟ' : '∞'; symbol.setAttribute('aria-hidden', 'true');
    const text = document.createElement('span');
    const name = document.createElement('strong'); name.textContent = provider.name;
    const hint = document.createElement('small'); hint.textContent = '通过 CloudDrive2 连接';
    text.append(name, hint);
    const badge = document.createElement('span'); badge.className = 'tag'; badge.textContent = state.windowsEdge ? '备用' : provider.availability === 'verified' ? '已验证' : '待验证';
    button.append(symbol, text, badge);
    button.addEventListener('click', () => {
      if (state.busy || state.transferChecking || state.probing || state.picking || state.dav.loading || state.preparingMagnet || provider.id === state.providerId) return;
      state.providerId = provider.id;
      state.magnet = null;
      setVisible('magnet-guide', false);
      showError('magnet-error', '');
      clearDavSelection();
      if (state.dav.connectionId) {
        listDav(state.dav.rootUrl);
      } else {
        $('dav-connection-details').open = true;
      }
      renderProviders();
      updateControls();
    });
    container.append(button);
  }
  const provider = selectedProvider();
  $('provider-note').textContent = state.windowsEdge && provider
    ? `可通过 CloudDrive2 连接${provider.name}。使用 Edge 抓链时可以跳过此入口。`
    : provider?.note || '云盘接入信息暂不可用，请重启最新版服务，或使用本地文件入口。';
}
async function prepareMagnet() {
  if (state.preparingMagnet || state.busy || state.transferChecking || state.picking || !state.connected) return;
  showError('magnet-error', '');
  state.magnet = null;
  setVisible('magnet-guide', false);
  state.preparingMagnet = true;
  updateControls();
  try {
    const result = await api('/api/magnets/prepare', { method: 'POST', body: { providerId: state.providerId, magnet: $('magnet-input').value.trim() } });
    state.magnet = result;
    $('magnet-name').textContent = result.displayName || '磁力链接已准备好';
    const instructions = $('magnet-instructions'); instructions.replaceChildren();
    for (const instruction of result.instructions || []) { const item = document.createElement('li'); item.textContent = instruction; instructions.append(item); }
    const cloud = new URL(result.cloudUrl);
    if (cloud.protocol !== 'https:') throw new Error('官方网盘入口地址无效，请重试。');
    $('open-cloud').href = cloud.href;
    setVisible('magnet-guide', true);
  } catch (error) { state.magnet = null; showError('magnet-error', error.message); }
  finally { state.preparingMagnet = false; updateControls(); }
}
async function copyMagnet() {
  if (!state.magnet?.magnet) return;
  try { await navigator.clipboard.writeText(state.magnet.magnet); toast('磁力链接已复制，请到官方网盘提交云端下载。'); }
  catch { toast('浏览器无法访问剪贴板，请直接复制上方磁力链接。'); }
}

function sourceValue() {
  if (state.sourceType === 'dav') return state.dav.selectedUrl;
  if (state.sourceType === 'browser') return state.browser.selectedId;
  return state.sourceType === 'http' ? $('source-url').value.trim() : $('local-path').value;
}
function sourceSignature() {
  return JSON.stringify([state.sourceType, sourceValue(), state.sourceType === 'dav' ? state.dav.connectionId : '', state.sourceType === 'dav' ? state.providerId : '', state.sourceType === 'http' ? $('source-username').value : '', state.sourceType === 'http' ? $('source-password').value : '', state.sourceType === 'browser' ? state.browser.generation : '']);
}
function sourcePayload() {
  const source = { type: state.sourceType, value: sourceValue() };
  if (state.sourceType === 'browser') {
    if (!source.value) throw new Error('请先在网盘点击抓链书签，收到候选后检查源文件。');
    return source;
  }
  if (state.sourceType === 'dav') {
    if (!state.dav.connectionId) throw new Error('请先连接 CloudDrive2，再选择自己的云盘文件。');
    if (!source.value) throw new Error('请在云盘目录中选择一个 MKV 或 MP4 视频文件。');
    source.connectionId = state.dav.connectionId;
    return source;
  }
  if (!source.value) throw new Error(state.sourceType === 'http' ? '请填写 HTTP / WebDAV 原文件地址。' : '请选择视频文件或填写完整路径。');
  if (state.sourceType === 'http') {
    let url;
    try { url = new URL(source.value); } catch { throw new Error('请输入完整的 HTTP 或 HTTPS 原文件地址。'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('目前仅接受 HTTP / HTTPS 原文件地址。磁力链接请先转入云盘。');
    if ($('source-username').value) source.username = $('source-username').value;
    if ($('source-password').value) source.password = $('source-password').value;
  }
  return source;
}
function readBudget() {
  const value = Number($('budget').value);
  if (!Number.isFinite(value) || value < 1 || value > 65536) throw new Error('读取预算需为 1–65536 MiB。');
  return value;
}
function invalidateSource() {
  state.queueSource = null; state.setupGuideClosedFor = '';
  if (state.sourceSignature === sourceSignature()) return;
  state.sourceId = null;
  state.probe = null;
  if (!state.transferChecking) {
    state.transferCheck = null;
    setVisible('transfer-check-results', false);
    setVisible('transfer-check-live-waits', false);
    showError('transfer-check-error', '');
  }
  setVisible('media-info', false);
  setVisible('audio-option', false);
  $('audio-stream').replaceChildren(new Option('使用默认音轨', ''));
  $('subtitle-stream').replaceChildren(new Option('不保存字幕文件', ''));
  $('subtitle-stream').value = '';
  setVisible('subtitle-option', false);
  showError('probe-error', '');
  if (state.connected && state.dependenciesReady) {
    $('probe-state').textContent = state.sourceType === 'dav' && !state.dav.selectedUrl
      ? state.dav.connectionId ? '请在云盘目录中选择视频' : '先连接云盘并选择视频'
      : '来源已变更，请检查源文件';
  }
  updateRange();
  updateControls();
}
function selectSource(type) {
  if (type === state.sourceType) return;
  if (state.busy || state.submitting || state.queuedJobIds.size || state.transferChecking || state.probing || state.picking) return;
  if (state.sourceType === 'dav' && type !== 'dav' && state.dav.loading) {
    state.dav.requestId += 1;
    state.dav.loading = false;
    $('dav-status').textContent = state.dav.connectionId ? '已连接 · 仅本次会话' : '连接已中断，请重新连接';
    $('dav-list-status').textContent = state.dav.connectionId ? '目录加载已中断，可点击刷新重试。' : '';
  }
  showSourceTab(type);
  invalidateSource();
  clearTimeout(state.browser.timer);
  if (state.connected) refreshBrowserCapture();
}
function showSourceTab(type) {
  state.sourceType = type;
  for (const tab of document.querySelectorAll('[data-source-type]')) {
    const active = tab.dataset.sourceType === type;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    setVisible(`panel-${tab.dataset.sourceType}`, active);
  }
}

function browserSourceLocked() {
  return Boolean(state.busy || state.submitting || state.queuedJobIds.size || state.transferChecking
    || state.probing || state.picking || state.resumeAction || state.setupChecking || state.dav.loading || state.preparingMagnet);
}
function bookmarkHasDraft() {
  return Boolean(queueWorkspace?.hasDraft() || state.sourceId || sourceValue() || state.browser.draftDirty);
}
function selectBrowserCandidate(candidate, { automatic = false } = {}) {
  if (browserSourceLocked() || !state.connected || !state.dependenciesReady || state.sourceType !== 'browser'
      || state.windowsXunleiOnly && candidate.provider !== 'xunlei'
      || automatic && bookmarkHasDraft()) return false;
  state.browser.selectedId = candidate.id;
  state.browser.selected = candidate;
  state.browser.draftDirty = false;
  state.browser.notice = '已收到候选，正在检查原文件…';
  $('browser-helper-state').textContent = state.browser.notice;
  setVisible('browser-selected', false);
  invalidateSource();
  renderBrowserInbox();
  probeSource().then(() => {
    if (automatic && state.sourceId && state.browser.selectedId === candidate.id && !browserSourceLocked()) {
      if (queueWorkspace) queueWorkspace.focusFirstDraft();
      else $('start-time').focus();
    }
  }).catch(() => showError('browser-helper-error', '未能检查候选，请重新检查源文件。'));
  return true;
}
function renderBrowserInbox() {
  renderBookmarkCandidates($('browser-candidates'), state.browser.candidates, {
    document,
    selectedId: state.browser.selectedId, disabled: browserSourceLocked() || !state.connected || !state.dependenciesReady,
    onSelect: candidate => selectBrowserCandidate(candidate),
  });
  $('browser-candidates').hidden = !state.browser.candidates.length
    || state.browser.candidates.length === 1 && state.browser.candidates[0].id === state.browser.selectedId;
}
async function refreshBrowserCapture() {
  if (!state.connected || state.browser.loading) return false;
  clearTimeout(state.browser.timer);
  const request = ++state.browser.requestId;
  state.browser.loading = true;
  try {
    const data = bookmarkCaptureState(await api('/api/bookmark-capture/state'));
    if (request !== state.browser.requestId) return false;
    if (state.windowsXunleiOnly) data.candidates = data.candidates.filter(candidate => candidate.provider === 'xunlei');
    const decision = bookmarkInbox.receive(data, { ready: state.connected && state.dependenciesReady && data.available,
      locked: browserSourceLocked(), hasDraft: bookmarkHasDraft() });
    if (decision.action === 'stale') return false;
    state.browser.available = data.available;
    state.browser.bookmarklet = data.available ? data.bookmarklet : '';
    state.browser.candidates = data.candidates;
    if (decision.action === 'received-busy') state.browser.notice = state.busy || state.queuedJobIds.size
      ? '已收到候选，当前下载继续。' : '已收到候选，当前操作继续。稍后可选择文件。';
    else if (decision.action === 'received-draft') state.browser.notice = '已收到候选，当前素材和取材设置已保留。需要时在下方选择文件。';
    else if (decision.action === 'choose') state.browser.notice = '收到多个候选，请在下方选择一个文件，工具会自动检查。';
    const status = $('browser-helper-state');
    const message = !data.available ? '本机抓链入口尚未就绪，请保持工具运行。'
      : state.browser.notice || (state.sourceType === 'browser' && state.sourceId ? ''
        : data.candidates.length ? '请选择候选文件' : '等待抓链');
    if (status.textContent !== message) status.textContent = message;
    showError('browser-helper-error', '');
    renderBrowserInbox();
    if (decision.action === 'select') {
      if (state.sourceType !== 'browser' && !bookmarkHasDraft() && !browserSourceLocked()) selectSource('browser');
      selectBrowserCandidate(decision.candidate, { automatic: true });
    } else if (['received-busy', 'received-draft', 'choose'].includes(decision.action) && state.sourceType !== 'browser') toast(state.browser.notice);
    return data.available;
  } catch {
    if (request === state.browser.requestId) showError('browser-helper-error', '未能读取本机收件箱，工具运行期间会自动重试。');
    return false;
  } finally {
    if (request === state.browser.requestId) {
      state.browser.loading = false;
      updateControls();
      if (state.connected) state.browser.timer = setTimeout(refreshBrowserCapture, 1000);
    }
  }
}

async function openBookmarkInstaller(browser) {
  if (!state.connected || state.browser.installOpening || !['chrome', 'edge'].includes(browser)
      || state.windowsEdge && browser !== 'edge') return;
  if (state.windowsEdge) {
    showError('edge-bookmark-open-error', '');
    setVisible('edge-bookmark-manual', false);
  }
  state.browser.installOpening = browser; updateControls();
  try { await api('/api/bookmark-capture/open', { method: 'POST', body: { browser } }); }
  catch (error) {
    if (state.windowsEdge) {
      showError('edge-bookmark-open-error', error.code === 'BROWSER_MISSING'
        ? '未找到 Microsoft Edge。请从下方的微软官网下载安装。'
        : '未能自动打开 Edge。请在已安装的 Edge 中手动打开抓链安装页。');
      $('edge-bookmark-address').textContent = `${window.location.origin}/bookmark/install`;
      setVisible('edge-bookmark-manual', true);
    } else toast(error.message);
  }
  finally { state.browser.installOpening = ''; updateControls(); }
}

function clearDavSelection() {
  state.dav.selectedUrl = '';
  state.dav.selectedName = '';
  setVisible('dav-selected', false);
  for (const entry of document.querySelectorAll('[data-dav-entry]')) {
    entry.classList.remove('selected');
    entry.setAttribute('aria-pressed', 'false');
  }
  invalidateSource();
}
function resetDavConnection() {
  const previous = state.dav.connectionId;
  state.dav.requestId += 1;
  state.dav.connectionId = null;
  state.dav.loading = false;
  state.dav.rootUrl = '';
  state.dav.directoryUrl = '';
  state.dav.parentUrl = null;
  state.dav.entries = [];
  clearDavSelection();
  $('dav-status').textContent = '连接设置已变更，请重新连接';
  $('connection-summary').textContent = '尚未连接';
  setVisible('dav-browser', false);
  showError('dav-error', '');
  if (previous && state.connected) void api('/api/dav/disconnect', { method: 'POST', body: { connectionId: previous } }).catch(() => {});
  updateControls();
}
function displayDavPath(url) {
  try { return decodeURIComponent(new URL(url).pathname).replace(/^\/dav\/?/, '/') || '/'; }
  catch { return '/'; }
}
function davErrorMessage(error) {
  if (['DAV_CONNECTION_EXPIRED', 'DAV_SESSION_EXPIRED', 'DAV_CONNECTION_NOT_FOUND', 'DAV_CONNECTION_MISSING'].includes(error.code)) {
    return '云盘连接已失效，请重新填写 CloudDrive2 密码并连接。';
  }
  const primaryStatus = error.diagnostics?.primary?.status;
  const independent = error.diagnostics?.independent;
  if ([401, 403].includes(primaryStatus) && independent) {
    const independentStatus = independent.status;
    if (primaryStatus === 401 && independentStatus === 401) {
      return '本工具与系统 curl 均收到 HTTP 401。CloudDrive2 未接受这组 WebDAV 凭据。请检查当前 CloudDrive2 登录邮箱与此处填写的账号是否一致，以及 WebDAV 是否允许 CloudDrive 账号访问。';
    }
    if (primaryStatus === 403 && independentStatus === 403) {
      return '本工具与系统 curl 均收到 HTTP 403。CloudDrive2 拒绝访问，请检查 WebDAV 根目录与访问权限。';
    }
    if (Number.isInteger(independentStatus) && independentStatus >= 200 && independentStatus < 300) {
      return `系统 curl 已通过${primaryStatus === 401 ? '认证' : '访问检查'}（HTTP ${independentStatus}），本工具收到 HTTP ${primaryStatus}。本工具连接存在兼容问题，请将此提示发回。`;
    }
    if (Number.isInteger(independentStatus)) {
      return `本工具收到 HTTP ${primaryStatus}，系统 curl 收到 HTTP ${independentStatus}。两次连接结果不同，请将此提示发回，以便继续排查。`;
    }
    const diagnosticStates = {
      UNAVAILABLE: '系统 curl 不可用，未取得独立诊断结果',
      TIMEOUT: '系统 curl 诊断超时，未取得 HTTP 响应',
      CANCELLED: '系统 curl 诊断已取消，未取得 HTTP 响应',
      TRANSPORT_ERROR: '系统 curl 连接未完成，未取得 HTTP 响应',
    };
    const nextStep = primaryStatus === 401
      ? '请检查当前 CloudDrive2 登录邮箱与此处填写的账号是否一致，以及 WebDAV 账号访问设置。'
      : '请检查 CloudDrive2 的 WebDAV 根目录与访问权限。';
    return `本工具收到 HTTP ${primaryStatus}；${diagnosticStates[independent.code] || '系统 curl 未取得有效 HTTP 响应'}。${nextStep}`;
  }
  if (error.code === 'ACCESS_DENIED' || /\b403\b/.test(error.message)) {
    return 'WebDAV 访问被拒绝（HTTP 403）。请在 CloudDrive2「WebDAV」页检查根目录及访问权限。';
  }
  if (['DAV_AUTH_FAILED', 'DAV_UNAUTHORIZED', 'DAV_AUTH', 'UNAUTHORIZED', 'AUTH_REQUIRED'].includes(error.code) || /\b401\b/.test(error.message)) {
    return 'CloudDrive2 拒绝了 WebDAV 认证（HTTP 401）。请先在 CloudDrive2「WebDAV」页检查是否允许 CloudDrive 账号访问；启用时再核对账号与密码。';
  }
  return error.message;
}
async function connectDav(event) {
  event.preventDefault();
  if (state.busy || state.transferChecking || state.probing || state.picking || state.dav.loading || !state.connected) return;
  showError('dav-error', '');
  const url = $('dav-url').value.trim();
  const username = $('dav-username').value.trim();
  let password = $('dav-password').value;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('请输入完整的 HTTP / HTTPS WebDAV 地址。');
    if (parsed.username || parsed.password) throw new Error('地址中不要包含账号或密码，请填写在下方独立输入框。');
    if (!['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) throw new Error('此入口只连接本机 CloudDrive2，请使用 localhost、127.0.0.1 或 [::1] 地址。');
    if (!username || !password) throw new Error('请填写 CloudDrive2 的账号和密码。');
  } catch (error) {
    showError('dav-error', error instanceof TypeError ? '请输入有效的 CloudDrive2 WebDAV 地址。' : error.message);
    return;
  }
  resetDavConnection();
  const requestId = ++state.dav.requestId;
  state.dav.loading = true;
  $('dav-status').textContent = '正在连接并诊断…';
  updateControls();
  try {
    const request = api('/api/dav/connect', { method: 'POST', body: { url, username, password } });
    $('dav-password').value = '';
    password = '';
    const result = await request;
    if (requestId !== state.dav.requestId) {
      if (result.connectionId) void api('/api/dav/disconnect', { method: 'POST', body: { connectionId: result.connectionId } }).catch(() => {});
      return;
    }
    if (!result.connectionId) throw new Error('未获得有效云盘连接，请重试。');
    applyDavDirectory(result);
    $('dav-status').textContent = 'WebDAV 已连接 · 仅本次会话';
    $('connection-summary').textContent = 'WebDAV 已连接 · 点击可修改';
    $('dav-connection-details').open = false;
    $('setup-guide').open = false;
  } catch (error) {
    if (requestId !== state.dav.requestId) return;
    $('dav-status').textContent = '连接未完成';
    $('connection-summary').textContent = '连接未完成';
    showError('dav-error', davErrorMessage(error));
  } finally {
    if (requestId === state.dav.requestId) {
      state.dav.loading = false;
      updateControls();
    }
  }
}
function applyDavDirectory(result) {
  state.dav.connectionId = result.connectionId || state.dav.connectionId;
  state.dav.rootUrl = result.rootUrl || state.dav.rootUrl;
  state.dav.directoryUrl = result.directoryUrl || state.dav.rootUrl;
  state.dav.parentUrl = result.parentUrl || null;
  state.dav.entries = Array.isArray(result.entries) ? result.entries : [];
  if (state.sourceType === 'dav' && !state.dav.selectedUrl) $('probe-state').textContent = '请在云盘目录中选择视频';
  setVisible('dav-browser', true);
  renderDavEntries();
}
async function listDav(url) {
  if (state.busy || state.transferChecking || state.probing || state.picking || state.dav.loading || !state.dav.connectionId || !url) return;
  const requestId = ++state.dav.requestId;
  const connectionId = state.dav.connectionId;
  clearDavSelection();
  state.dav.loading = true;
  $('dav-list-status').textContent = '正在读取当前目录…';
  showError('dav-error', '');
  updateControls();
  try {
    const result = await api('/api/dav/list', { method: 'POST', body: { connectionId, url } });
    if (requestId !== state.dav.requestId || connectionId !== state.dav.connectionId) return;
    applyDavDirectory(result);
  } catch (error) {
    if (requestId !== state.dav.requestId) return;
    $('dav-list-status').textContent = '未能读取目录，可返回上一级或刷新重试。';
    showError('dav-error', davErrorMessage(error));
  } finally {
    if (requestId === state.dav.requestId) {
      state.dav.loading = false;
      updateControls();
    }
  }
}
function renderDavEntries() {
  const list = $('dav-entries');
  list.replaceChildren();
  $('dav-current-path').textContent = displayDavPath(state.dav.directoryUrl);
  $('dav-current-path').title = displayDavPath(state.dav.directoryUrl);
  const entries = [...state.dav.entries].sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || String(a.name).localeCompare(String(b.name), 'zh-CN'));
  $('dav-list-status').textContent = entries.length ? `${entries.length} 项 · 选择文件夹打开，选择视频后检查源文件` : '当前目录暂无文件，可返回上一级或刷新。';
  const providerName = selectedProvider()?.name || '网盘';
  const authorizationHint = state.providerId === 'baidu'
    ? '百度授权已切换到目标账号'
    : `${providerName}已授权到存有影片的账号`;
  $('dav-empty-help').textContent = `请先在 CloudDrive2 中打开并刷新同一目录。若那里也为空，请在${providerName}官网确认文件位置，并核对 CloudDrive2 授权的账号；若 CloudDrive2 已显示文件、只有这里为空，请点击「刷新目录」。本工具连接成功只表示本机 WebDAV 可访问，不代表${authorizationHint}。`;
  setVisible('dav-empty-help', entries.length === 0);
  for (const entry of entries) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    const isVideo = /\.(?:mkv|mp4|mov|m4v|ts|m2ts|avi|webm)$/i.test(entry.name || '');
    button.type = 'button';
    button.className = `dav-entry${entry.url === state.dav.selectedUrl ? ' selected' : ''}`;
    button.dataset.davEntry = '';
    button.dataset.davSelectable = String(entry.isDirectory || isVideo);
    button.title = entry.name;
    button.setAttribute('aria-pressed', String(!entry.isDirectory && entry.url === state.dav.selectedUrl));
    if (!entry.isDirectory && !isVideo) button.disabled = true;
    const symbol = document.createElement('span'); symbol.className = 'dav-entry-symbol'; symbol.textContent = entry.isDirectory ? '目录' : isVideo ? '视频' : '文件';
    const name = document.createElement('span'); name.className = 'dav-entry-name'; name.textContent = entry.name || '未命名';
    const meta = document.createElement('span'); meta.className = 'dav-entry-meta'; meta.textContent = entry.isDirectory ? '›' : Number.isFinite(Number(entry.size)) && Number(entry.size) > 0 ? formatBytes(Number(entry.size)) : '';
    button.append(symbol, name, meta);
    button.addEventListener('click', () => {
      if (state.busy || state.transferChecking || state.probing || state.picking || state.dav.loading) return;
      if (entry.isDirectory) { listDav(entry.url); return; }
      state.dav.requestId += 1;
      state.dav.selectedUrl = entry.url;
      state.dav.selectedName = entry.name;
      $('dav-selected-name').textContent = `已选：${entry.name}`;
      setVisible('dav-selected', true);
      invalidateSource();
      renderDavEntries();
      $('probe-state').textContent = '已选择云端原文件，请点击检查';
    });
    item.append(button); list.append(item);
  }
}

async function probeSource() {
  if (state.busy || state.transferChecking || state.probing || state.picking || !state.connected) return;
  showError('probe-error', '');
  showError('form-error', '');
  let source, budgetMiB;
  try { source = sourcePayload(); budgetMiB = readBudget(); }
  catch (error) { showError('probe-error', error.message); return; }
  const signature = sourceSignature();
  state.probing = true;
  state.sourceId = null;
  state.probe = null;
  updateBudgetSuggestion();
  setVisible('media-info', false);
  $('probe-state').textContent = '读取容器信息与索引…';
  $('probe-button').classList.add('loading');
  $('probe-button').querySelector('.button-label').textContent = '正在检查';
  updateControls();
  try {
    const result = await api('/api/probe', { method: 'POST', body: { source, budgetMiB } });
    if (signature !== sourceSignature()) return;
    if (!result.sourceId) throw new Error('源文件检查未返回可用标识，请重试。');
    state.sourceId = result.sourceId;
    state.sourceSignature = signature;
    state.probe = result;
    if (state.sourceType === 'browser') $('download-method').value = result.directStreamAvailable === true ? 'direct-stream' : 'indexed';
    renderMedia(result);
    if (state.sourceType === 'browser') {
      state.browser.notice = '';
      $('browser-helper-state').textContent = '';
      $('browser-selected').textContent = '原文件已就绪，不会自动开始下载。';
      setVisible('browser-selected', true);
    }
    $('probe-state').textContent = '';
  } catch (error) {
    if (signature !== sourceSignature()) return;
    $('probe-state').textContent = '未能检查源文件';
    showError('probe-error', error.message);
    if (state.sourceType === 'browser') {
      state.browser.notice = '候选尚未通过原文件检查，可在下方查看原因或重新选择。';
      $('browser-helper-state').textContent = state.browser.notice;
      setVisible('browser-selected', false);
    }
    const diagnostic = error.mediaDiagnostic;
    if (diagnostic && ['ffprobe', 'ffmpeg'].includes(diagnostic.tool) && typeof diagnostic.diagnostic === 'string' && diagnostic.diagnostic.trim()) {
      $('probe-diagnostic-text').textContent = redact(`${diagnostic.tool} · 退出代码 ${Number.isInteger(diagnostic.exitCode) ? diagnostic.exitCode : '未知'}\n${diagnostic.diagnostic}`);
      setVisible('probe-diagnostic', true);
    }
  } finally {
    state.probing = false;
    $('probe-button').classList.remove('loading');
    $('probe-button').querySelector('.button-label').textContent = '检查源文件';
    updateRange();
    updateControls();
  }
}

function mediaDuration() {
  const media = state.probe?.media;
  const duration = Number(media?.duration ?? media?.durationSeconds ?? media?.format?.duration);
  return Number.isFinite(duration) && duration > 0 ? duration : null;
}
function renderMedia(result) {
  const media = result.media || {};
  const source = result.source || {};
  const streams = media.streams || [];
  const video = streams.find((stream) => (stream.type === 'video' || stream.codec_type === 'video') && !stream.attachedPicture) || media.video || {};
  const audio = streams.filter((stream) => stream.type === 'audio' || stream.codec_type === 'audio');
  const size = Number(source.size ?? media.sizeBytes ?? media.format?.size);
  $('media-name').textContent = source.label || (state.sourceType === 'dav' ? state.dav.selectedName : state.sourceType === 'browser' ? state.browser.selected?.name : '') || basename(sourceValue()) || '文件已就绪';
  $('source-kind').textContent = state.sourceType === 'dav' ? `${selectedProvider()?.name || '云盘'} / CloudDrive2` : state.sourceType === 'browser' ? '浏览器抓链' : state.sourceType === 'http' ? 'HTTP / WebDAV' : '本地 / 挂载';
  $('media-duration').textContent = mediaDuration() ? formatTime(mediaDuration()) : '未知';
  $('media-codec').textContent = (video.codec_name || video.codec || '未知').toUpperCase();
  $('media-resolution').textContent = video.width && video.height ? `${video.width} × ${video.height}` : '未知';
  $('media-size').textContent = Number.isFinite(size) && size > 0 ? formatBytes(size) : '未知';
  const parts = [];
  if (audio.length) parts.push(`${audio.length} 条音轨`);
  const received = receivedBytes(result.metrics);
  if (state.sourceType !== 'local' && received !== null) parts.push(`检查接收 ${formatBytes(received)}`);
  const transfer = video.color_transfer || video.color?.color_transfer;
  if (transfer === 'smpte2084') parts.push('检测到 PQ / HDR 标记；导出后仍需验证显示效果');
  else if (transfer === 'arib-std-b67') parts.push('检测到 HLG 标记；导出后仍需验证显示效果');
  if (state.sourceType !== 'local') parts.push(source.rangeVerified ? '已核对所需区间响应；其他位置以实际读取为准；上游流量未知' : '范围读取能力以任务实际结果为准；上游流量未知');
  else parts.push('若为云盘挂载文件，上游流量由挂载软件决定');
  $('media-extra').textContent = parts.join(' · ');
  const audioSelect = $('audio-stream');
  audioSelect.replaceChildren(new Option('使用默认音轨', ''));
  for (const stream of audio) {
    const language = stream.language || stream.tags?.language || '';
    const title = stream.title || stream.tags?.title || '';
    const codec = (stream.codec || stream.codec_name || '').toUpperCase();
    const channels = stream.channels ? `${stream.channels} 声道` : '';
    const label = [`音轨 ${audio.indexOf(stream) + 1}`, title, language, codec, channels].filter(Boolean).join(' · ');
    if (Number.isInteger(stream.index)) audioSelect.add(new Option(label, String(stream.index)));
  }
  setVisible('audio-option', audio.length > 0);
  renderSubtitleOptions(streams);
  updateClipName();
  $('media-info').open = true;
  setVisible('media-info', true);
}

function clipSourceLabel() {
  return state.probe?.source?.label || (state.sourceType === 'dav' ? state.dav.selectedName
    : state.sourceType === 'browser' ? state.browser.selected?.name : basename(sourceValue())) || '片段';
}
function updateClipName() {
  const signature = sourceSignature();
  if (state.clipNameSourceKey !== signature) { state.clipNameEdited = false; state.clipNameSourceKey = signature; $('clip-name').value = ''; }
  if (state.clipNameEdited && $('clip-name').value.trim()) return;
  const start = parseTime($('start-time').value), end = parseTime($('end-time').value);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  $('clip-name').value = defaultClipName(clipSourceLabel(), start, end);
}
function subtitleTracks() {
  return (state.probe?.media?.streams || []).filter(stream => stream.type === 'subtitle' || stream.codec_type === 'subtitle');
}
function subtitleSupported(stream) {
  return ['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'hdmv_pgs_subtitle', 'dvd_subtitle'].includes(stream.codec || stream.codec_name);
}
function subtitleKind(stream) {
  return ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'].includes(stream.codec || stream.codec_name) ? 'image' : 'text';
}
function renderSubtitleOptions(streams) {
  const tracks = streams.filter(stream => stream.type === 'subtitle' || stream.codec_type === 'subtitle');
  const select = $('subtitle-stream');
  select.replaceChildren(new Option('不保存字幕文件', '')); select.value = '';
  const languages = { chi: '中文', zho: '中文', zh: '中文', chs: '简体中文', cht: '繁体中文', eng: '英文', en: '英文', jpn: '日文', ja: '日文', kor: '韩文', ko: '韩文' };
  for (const [index, stream] of tracks.entries()) {
    if (!Number.isInteger(stream.index)) continue;
    const language = stream.language || stream.tags?.language || '';
    const codec = (stream.codec || stream.codec_name || '未知格式').toUpperCase();
    const label = [`字幕 ${index + 1}`, languages[language] || language || '语言未标记', codec, subtitleKind(stream) === 'image' ? '图片字幕' : '文本字幕'].join(' · ');
    const option = new Option(label + (subtitleSupported(stream) ? '' : ' · 暂不支持'), String(stream.index));
    option.disabled = !subtitleSupported(stream);
    select.add(option);
  }
  setVisible('subtitle-option', true);
  updateSubtitleHint();
}
function updateSubtitleHint() {
  const selected = subtitleTracks().find(stream => String(stream.index) === $('subtitle-stream').value);
  $('subtitle-hint').textContent = !subtitleTracks().length ? '原文件未发现内封字幕。视频将正常下载，不会生成字幕文件。'
    : !subtitleTracks().some(subtitleSupported) ? '原文件有字幕，但当前格式暂不支持独立导出。视频仍可正常下载。'
    : !selected ? '默认不保存字幕。选中后另存独立文件，不嵌入或烧录到视频。'
      : !subtitleSupported(selected) ? '当前字幕格式暂不支持独立导出，请选择其他字幕轨道或不保存字幕。'
      : subtitleKind(selected) === 'image' ? '此轨道是图片字幕，将另存独立原格式文件，不能直接作为可编辑的 SRT 文字。视频保持无字幕。'
        : '将同时保存独立 SRT 字幕文件，并按成品片段时间对齐。视频保持无字幕，可自行选择是否使用字幕。'
          + (['ass', 'ssa'].includes(selected.codec || selected.codec_name) ? ' ASS 转为 SRT 后不保留字体、位置等样式。' : '');
}

function parseTime(value) {
  const text = String(value).trim();
  if (!/^(?:\d+:){0,2}\d+(?:\.\d+)?$/.test(text)) return NaN;
  const parts = text.split(':').map(Number);
  if (parts.length > 1 && parts.at(-1) >= 60) return NaN;
  if (parts.length === 3 && parts[1] >= 60) return NaN;
  return parts.reduce((seconds, part) => seconds * 60 + part, 0);
}
function readRange() {
  const start = parseTime($('start-time').value);
  const end = parseTime($('end-time').value);
  const handles = Number($('handles').value);
  if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('请使用有效时间，例如 00:42:10、42:10 或 2530。');
  if (end <= start) throw new Error('结束时间需要晚于开始时间。');
  if (!Number.isFinite(handles) || handles < 0 || handles > 300) throw new Error('前后余量需为 0–300 秒。');
  const duration = mediaDuration();
  if (duration && start >= duration) throw new Error('开始时间超出源文件时长。');
  if (duration && end > duration + 0.1) throw new Error(`结束时间超出源文件时长（${formatTime(duration)}）。`);
  return { start, end, handles, paddedStart: Math.max(0, start - handles), paddedEnd: duration ? Math.min(duration, end + handles) : end + handles };
}
function updateRange() {
  const summary = $('range-summary');
  summary.replaceChildren();
  const dot = document.createElement('span');
  dot.className = 'range-dot';
  summary.append(dot);
  const text = document.createElement('span');
  try {
    const range = readRange();
    text.append('预计提取 ');
    const strong = document.createElement('strong');
    strong.textContent = `${formatTime(range.paddedStart)} → ${formatTime(range.paddedEnd)}`;
    text.append(strong);
    const length = document.createElement('span');
    length.className = 'range-duration';
    length.textContent = `约 ${humanDuration(range.paddedEnd - range.paddedStart)} · 实际边界受关键帧影响`;
    text.append(length);
  } catch (error) { text.textContent = error.message; }
  summary.append(text);
  updateClipName();
  updateBudgetSuggestion();
}

function formatBudgetMiB(value) {
  return value >= 1024 && value % 1024 === 0 ? `${value / 1024} GiB` : `${value} MiB`;
}

function updateBudgetSuggestion() {
  if (queueWorkspace) { setVisible('budget-suggestion', false); state.budgetRecommendationMiB = null; return; }
  state.budgetRecommendationMiB = null;
  setVisible('budget-suggestion', false);
  if (state.sourceType === 'local' || !state.probe || !state.sourceId || state.sourceSignature !== sourceSignature()) return;
  let range;
  try { range = readRange(); } catch { return; }
  const media = state.probe.media || {};
  const estimate = estimateReadBudget({
    sizeBytes: Number(state.probe.source?.size ?? media.sizeBytes ?? media.format?.size),
    durationSeconds: mediaDuration(),
    startSeconds: range.start,
    endSeconds: range.end,
    handlesSeconds: range.handles,
  });
  if (!estimate) return;
  const currentMiB = Number($('budget').value);
  const validBudget = Number.isFinite(currentMiB) && currentMiB >= 1 && currentMiB <= 65536;
  const currentText = validBudget ? formatBudgetMiB(currentMiB) : '尚未填写有效值';
  $('budget-estimate').textContent = `所选时段按文件平均码率估算约 ${formatBytes(estimate.estimatedBytes)}（含前后余量）；当前 HTTP 接收上限：${currentText}。`;
  const warnings = [];
  if (validBudget && currentMiB * 1024 * 1024 < estimate.estimatedBytes) warnings.push('当前上限小于估算片段大小，任务可能提前停止。');
  if (estimate.exceedsLimit) warnings.push('估算建议超过可设置的 64 GiB 上限，请缩短时段分次获取。');
  $('budget-estimate-warning').textContent = warnings.join(' ');
  setVisible('budget-estimate-warning', warnings.length > 0);
  state.budgetRecommendationMiB = estimate.recommendedMiB;
  const button = $('apply-budget');
  button.textContent = `采用建议上限（${formatBudgetMiB(estimate.recommendedMiB)}）`;
  button.disabled = Boolean(state.submitting || state.transferChecking || state.probing || state.picking || !state.connected);
  setVisible('apply-budget', !validBudget || currentMiB < estimate.recommendedMiB);
  setVisible('budget-suggestion', true);
}

function updateControls() {
  if (queueWorkspace) state.busy = Boolean(queueWorkspace.hasActivity() || state.queueActionPending || state.job?.id && !terminalStatuses.has(state.job.status));
  const checkedSource = Boolean(state.sourceId && state.sourceSignature === sourceSignature());
  const policy = extractionUiPolicy({ ...state, submitting: state.submitting,
    queued: state.queuedJobIds.size > 0, checkedSource });
  const locked = policy.sourceLocked;
  const available = state.connected && state.dependenciesReady;
  for (const element of document.querySelectorAll('.source-field, [data-source-type]')) element.disabled = locked;
  for (const element of document.querySelectorAll('#extract-form input, #extract-form select')) element.disabled = policy.formLocked;
  for (const element of document.querySelectorAll('[data-provider]')) element.disabled = locked || state.dav.loading || state.preparingMagnet;
  for (const element of document.querySelectorAll('.dav-connection-field')) element.disabled = locked || state.dav.loading;
  for (const element of document.querySelectorAll('[data-dav-entry]')) {
    element.disabled = locked || state.dav.loading || element.dataset.davSelectable !== 'true';
  }
  $('dav-connect-button').disabled = locked || state.dav.loading || !state.connected || !selectedProvider()?.bridgeSupported;
  $('dav-connect-button').classList.toggle('loading', state.dav.loading && !state.dav.connectionId);
  $('dav-connect-button').textContent = state.dav.loading && !state.dav.connectionId ? '正在连接并诊断…' : state.dav.connectionId ? '重新连接' : '连接云盘';
  $('dav-up-button').disabled = locked || state.dav.loading || !state.dav.parentUrl;
  $('dav-refresh-button').disabled = locked || state.dav.loading || !state.dav.connectionId;
  $('pick-file').disabled = locked || !state.connected;
  $('pick-directory').disabled = locked || !state.connected;
  $('setup-check').disabled = locked || state.dav.loading || state.preparingMagnet || !state.connected;
  $('setup-check').setAttribute('aria-busy', String(state.setupChecking));
  $('setup-check').textContent = state.setupChecking ? '正在检查…' : '检查本机环境';
  for (const [id, kind, label] of [['pick-file', 'file', '选择文件'], ['pick-directory', 'directory', '选择文件夹']]) {
    const picking = state.picking === kind;
    $(id).classList.toggle('loading', picking);
    $(id).setAttribute('aria-busy', String(picking));
    $(id).textContent = picking ? '正在打开…' : label;
  }
  $('prepare-magnet').disabled = locked || state.preparingMagnet || !state.connected || !selectedProvider();
  $('prepare-magnet').classList.toggle('loading', state.preparingMagnet);
  $('magnet-input').disabled = locked || state.preparingMagnet;
  $('compatible-button').disabled = locked || !state.connected;
  const readySource = Boolean(checkedSource || state.queueSource);
  const hasProbeInput = Boolean(sourceValue());
  const showProbe = state.sourceType !== 'browser' || hasProbeInput;
  setVisible('probe-button', showProbe);
  setVisible('probe-state', state.probing || (showProbe && hasProbeInput && !readySource && state.sourceType !== 'browser'));
  setVisible('sample-row', Boolean(state.samplePath && !readySource && !state.probing));
  $('sample-button').disabled = locked || !available || !state.samplePath;
  $('probe-button').disabled = locked || !available || (state.sourceType === 'dav' && (!state.dav.selectedUrl || state.dav.loading)) || !showProbe;
  $('start-button').disabled = !policy.canSubmit;
  $('start-button').querySelector('span').textContent = state.submitting ? '正在提交…' : policy.queueing ? '加入同影片取片队列' : '获取原码片段';
  $('apply-budget').disabled = policy.formLocked || !state.connected || !state.budgetRecommendationMiB;
  setVisible('browser-download-option', state.sourceType === 'browser');
  const directAvailable = state.sourceType === 'browser' && state.probe?.directStreamAvailable === true;
  $('download-method').options[0].disabled = !directAvailable;
  $('download-method').value = browserDownloadMethod(state.probe, $('download-method').value);
  $('download-method').disabled = policy.formLocked || !state.sourceId || state.sourceType !== 'browser';
  $('subtitle-stream').disabled = policy.formLocked || !state.sourceId || !subtitleTracks().some(subtitleSupported);
  $('download-method-hint').textContent = !state.sourceId ? '检查源文件后确认可用方式。'
    : directAvailable ? '流式直连从目标位置持续读取；索引取片保留原有下载方式。新路线的速度与兼容性需以真实片段验证。'
      : '当前来源未通过流式直连能力核验，只能使用索引取片；流式直连需要强文件版本核验。';
  const directSelected = state.sourceType === 'browser' && $('download-method').value === 'direct-stream';
  const supportsContinuous = !directSelected && state.sourceType !== 'local' && state.probe?.media?.format?.includes('matroska');
  $('read-mode').disabled = policy.formLocked || !supportsContinuous;
  $('reuse-index').disabled = policy.formLocked || !supportsContinuous;
  const canCheckTransfer = Boolean(state.sourceId && state.probe?.transferCheckAvailable === true);
  setVisible('transfer-check-panel', canCheckTransfer || Boolean(state.transferCheck || state.transferChecking || state.transferCheckPollFailed));
  $('transfer-check-start').disabled = locked || !available || !canCheckTransfer;
  setVisible('transfer-check-cancel', state.transferChecking);
  $('transfer-check-cancel').disabled = state.transferCheckCancelling || !state.transferCheck?.id;
  $('transfer-check-cancel').textContent = state.transferCheckCancelling ? '正在停止并结算…' : '停止诊断';
  setVisible('transfer-check-retry', state.transferCheckPollFailed);
  if (!state.transferCheck && !state.transferChecking) $('transfer-check-state').textContent = state.sourceId
    ? state.probe?.transferCheckAvailable === true ? '已就绪。四个不同位置各读一次；诊断期间请暂停其他播放器或下载。' : '当前来源不能进行此项诊断。需要支持强版本核对、至少 32 MiB 的云端原文件。'
    : '先检查支持版本核对的云端原文件，再开始诊断。';
  if (!supportsContinuous && !policy.formLocked) $('read-mode').value = 'standard';
  $('submit-hint').textContent = policy.queueing && state.sourceId
    ? `同一影片可继续填写时间并加入队列，任务依次执行。${state.queuedJobIds.size ? `另有 ${state.queuedJobIds.size} 条已提交。` : ''}`
    : state.busy ? '任务进行中，进度显示在下方。' : state.sourceId ? '视频原码复制。请预留足够的本地空间。' : '先检查源文件，再开始获取。';
  const bookmarkLink = $('bookmark-capture-link');
  const bookmarkHref = state.connected && state.browser.available ? state.browser.bookmarklet : '#';
  if (bookmarkLink.href !== bookmarkHref) bookmarkLink.href = bookmarkHref;
  bookmarkLink.draggable = Boolean(state.connected && state.browser.available);
  bookmarkLink.setAttribute('aria-disabled', String(!bookmarkLink.draggable));
  $('bookmark-install-chrome').disabled = state.windowsEdge || !state.connected || Boolean(state.browser.installOpening);
  $('bookmark-install-edge').disabled = !state.connected || Boolean(state.browser.installOpening);
  for (const button of document.querySelectorAll('[data-browser-candidate]')) button.disabled = locked || !available;
  renderResume();
  if (queueWorkspace) {
    queueWorkspace.refresh();
    setVisible('subtitle-option', false); setVisible('budget-suggestion', false);
    const source = checkedSource ? { sourceId: state.sourceId, label: clipSourceLabel() } : state.queueSource;
    const name = source?.label || '';
    const summaryName = $('source-summary-name');
    if (summaryName.textContent !== name) {
      summaryName.textContent = name;
      summaryName.title = name;
    }
    const mediaFacts = ['media-duration', 'media-resolution'].map(id => $(id).textContent).filter(value => value && value !== '未知');
    const summaryMeta = $('source-summary-meta');
    const meta = source ? ['已检查', ...mediaFacts].join(' · ') : '';
    if (summaryMeta.textContent !== meta) summaryMeta.textContent = meta;
    setVisible('source-ready-summary', Boolean(source));
    $('queue-default-summary').textContent = `音轨与导出选项 · ${$('audio-stream').value === '' ? '默认音轨' : '已选音轨'} · ${$('make-mp4').checked ? '原码＋MP4' : '仅原码文件'}`;
    if (source && state.setupGuideClosedFor !== source.sourceId) {
      state.setupGuideClosedFor = source.sourceId;
      if (state.dependenciesReady && !state.setupChecking && (!state.setupReport || state.setupReport.storage?.status === 'ready')) $('setup-guide').open = false;
    }
  }
}

function renderTransferCheck(check) {
  if (!check?.id) return;
  showError('transfer-check-error', '');
  state.transferCheck = check;
  state.transferChecking = !terminalStatuses.has(check.status);
  state.transferCheckPollFailed = false;
  if (!state.transferChecking) state.transferCheckCancelling = false;
  const progress = check.progress, report = check.report;
  const received = report?.metrics?.receivedBytes ?? progress?.receivedBytes ?? 0;
  const phase = { checking_head: '正在核对文件版本', round_started: '正在开始下一轮', reading: '正在读取样本', round_completed: '本轮读取完成', settled: '读取已结算' }[progress?.phase] || '正在准备';
  const mode = progress?.mode === 'parallel' ? '两路并发请求' : progress?.mode === 'serial' ? '串行读取' : '';
  $('transfer-check-state').textContent = state.transferChecking
    ? `${phase}${progress?.roundIndex ? ` · 第 ${progress.roundIndex}/4 轮${mode ? ` · ${mode}` : ''}` : ''} · 本工具已接收 ${formatBytes(received)}；上游预取量未知。`
    : `${check.status === 'completed' ? '诊断已完成' : check.status === 'cancelled' ? '诊断已停止，读取已结算' : '诊断未完成，读取已结算'} · 本工具实际接收 ${formatBytes(received)}。`;
  const waitText = transferLiveWaitText(report?.metrics?.liveWaitCounts ?? progress?.liveWaitCounts);
  $('transfer-check-live-waits').textContent = waitText || '';
  setVisible('transfer-check-live-waits', Boolean(waitText));
  if (report) {
    const body = $('transfer-check-rounds'); body.replaceChildren();
    const labels = { not_started: '未开始', running: '读取中', completed: '完成', failed: '失败', cancelled: '停止' };
    for (const round of (Array.isArray(report.rounds) ? report.rounds.slice(0, 4) : [])) {
      const row = document.createElement('tr');
      const window = report.sampling?.windows?.find(item => item.index === round.index);
      const position = Number.isFinite(window?.positionFraction) ? `约 ${(window.positionFraction * 100).toFixed(0)}%` : '—';
      for (const text of [String(round.index), position, round.mode === 'parallel' ? '两路并发' : '串行读取',
        round.status !== 'not_started' ? transferDuration(round.elapsedMs) : '—',
        Number.isFinite(round.throughputBytesPerSecond) ? `${formatBytes(round.throughputBytesPerSecond)}/秒` : '—',
        labels[round.status] || '未完成']) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      body.append(row);
    }
    $('transfer-check-conclusion').textContent = transferConclusion(report);
    const timings = transferTimingView(report);
    $('transfer-check-timing-state').textContent = timings.message;
    $('transfer-check-timing-explanation').textContent = timings.explanation;
    const timingBody = $('transfer-check-timings'); timingBody.replaceChildren();
    for (const timing of timings.rows) {
      const row = document.createElement('tr');
      for (const text of [timing.reading, timing.outcome, timing.elapsed, timing.responseWait,
        timing.firstDataWait, timing.bodyTransfer, timing.receivedBytes === null ? '未知' : formatBytes(timing.receivedBytes), timing.terminalStage]) {
        const cell = document.createElement('td'); cell.textContent = text; row.append(cell);
      }
      timingBody.append(row);
    }
    setVisible('transfer-check-timing-table-wrap', timings.rows.length > 0);
    if (check.status === 'failed' || check.status === 'cancelled') $('transfer-check-timing-details').open = true;
    $('transfer-check-json').textContent = JSON.stringify(report, null, 2);
    setVisible('transfer-check-results', true);
    if (report.errorCode && check.status === 'failed') showError('transfer-check-error', `读取未完成（${/^[A-Z][A-Z0-9_]{0,60}$/.test(report.errorCode) ? report.errorCode : 'TRANSFER_CHECK_FAILED'}）。请查看诊断记录中的已完成轮次。`);
  }
  updateControls();
}

async function startTransferCheck() {
  if (state.busy || state.transferChecking || state.probing || state.picking || state.resumeAction || !state.connected) return;
  if (!state.sourceId || state.sourceSignature !== sourceSignature() || state.probe?.transferCheckAvailable !== true) return;
  state.transferChecking = true; state.transferCheck = null; state.transferCheckCancelling = false; state.transferCheckPollFailed = false;
  clearTimeout(state.transferCheckPoll);
  setVisible('transfer-check-results', false);
  setVisible('transfer-check-live-waits', false);
  showError('transfer-check-error', '');
  $('transfer-check-state').textContent = '正在开始诊断，正式下载策略保持原设置…';
  updateControls();
  try {
    const check = await api('/api/transfer-checks', { method: 'POST', body: { sourceId: state.sourceId } });
    if (!check.id) throw new Error('未获得诊断标识，请刷新页面查看服务状态。');
    renderTransferCheck(check);
    if (!terminalStatuses.has(check.status)) pollTransferCheck(check.id);
  } catch (error) {
    showError('transfer-check-error', error.message);
    // A lost creation response may still have started reads on the backend.
    await recoverTransferCheck();
  }
}

async function recoverTransferCheck() {
  try {
    const bootstrap = await api('/api/bootstrap');
    if (bootstrap.transferCheck?.id) {
      renderTransferCheck(bootstrap.transferCheck);
      pollTransferCheck(bootstrap.transferCheck.id);
    } else {
      state.transferChecking = false; state.transferCheckPollFailed = false;
      $('transfer-check-state').textContent = '当前没有活动诊断。若未取回本次结果，可重新开始。';
      updateControls();
    }
  } catch {
    state.transferCheckPollFailed = true;
    $('transfer-check-state').textContent = '尚未核实服务器是否已开始读取，请重新读取状态。诊断最长 8 分钟后自动停止。';
    updateControls();
  }
}

async function pollTransferCheck(id) {
  clearTimeout(state.transferCheckPoll);
  try {
    const check = await api(`/api/transfer-checks/${encodeURIComponent(id)}`);
    if (state.transferCheck?.id !== id) return;
    renderTransferCheck(check);
    if (!terminalStatuses.has(check.status)) state.transferCheckPoll = setTimeout(() => pollTransferCheck(id), 1000);
  } catch (error) {
    if (state.transferCheck?.id !== id) return;
    // A lost response does not mean the server stopped its bounded reads.
    state.transferCheckPollFailed = true;
    showError('transfer-check-error', `${error.message} 诊断可能仍在进行，请重新读取状态或停止诊断。`);
    updateControls();
  }
}

async function cancelTransferCheck() {
  if (!state.transferChecking || !state.transferCheck?.id || state.transferCheckCancelling) return;
  state.transferCheckCancelling = true; updateControls();
  const id = state.transferCheck.id;
  try {
    const check = await api(`/api/transfer-checks/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: {} });
    if (state.transferCheck?.id !== id) return;
    clearTimeout(state.transferCheckPoll);
    renderTransferCheck(check);
    if (!terminalStatuses.has(check.status)) pollTransferCheck(id);
  } catch (error) {
    state.transferCheckCancelling = false;
    showError('transfer-check-error', error.message);
    updateControls();
  }
}

async function copyTransferCheck() {
  if (!state.transferCheck?.report) return;
  try { await navigator.clipboard.writeText(JSON.stringify(state.transferCheck.report, null, 2)); toast('脱敏速度诊断已复制'); }
  catch {
    const content = $('transfer-check-json'); content.parentElement.open = true;
    const range = document.createRange(); range.selectNodeContents(content);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    content.focus(); toast('已选中诊断记录，请手动复制。');
  }
}

async function startJob(event) {
  event.preventDefault();
  if (queueWorkspace) return;
  if (state.submitting || state.transferChecking || state.probing || state.picking || state.resumeAction || state.setupChecking) return;
  showError('form-error', '');
  let range, budgetMiB, outputDir, clipName, subtitleStreamIndex;
  try {
    if (!state.sourceId || state.sourceSignature !== sourceSignature()) throw new Error('请先检查当前源文件。');
    range = readRange(); budgetMiB = readBudget();
    outputDir = $('output-dir').value;
    if (!outputDir) throw new Error('请填写本地保存目录。');
    clipName = sanitizeClipName($('clip-name').value) || defaultClipName(clipSourceLabel(), range.start, range.end);
    $('clip-name').value = clipName;
    if ($('subtitle-stream').value !== '') {
      subtitleStreamIndex = Number($('subtitle-stream').value);
      if (!Number.isInteger(subtitleStreamIndex) || !subtitleTracks().some(stream => stream.index === subtitleStreamIndex && subtitleSupported(stream))) throw new Error('请选择当前原文件中的字幕轨道。');
    }
  } catch (error) { showError('form-error', error.message); return; }
  const keepCurrentPolling = state.busy || state.queuedJobIds.size > 0;
  state.submitting = true;
  $('start-button').classList.add('loading');
  updateControls();
  try {
    const requestBody = {
      sourceId: state.sourceId, start: range.start, end: range.end, handles: range.handles,
      outputDir, clipName, makeMp4: $('make-mp4').checked, budgetMiB, readMode: $('read-mode').value, reuseIndex: $('reuse-index').checked,
    };
    if (state.sourceType === 'browser') {
      requestBody.downloadMethod = browserDownloadMethod(state.probe, $('download-method').value);
      if (requestBody.downloadMethod === 'direct-stream') { requestBody.readMode = 'standard'; requestBody.reuseIndex = false; }
    }
    if ($('audio-stream').value !== '') requestBody.audioStreamIndex = Number($('audio-stream').value);
    if (subtitleStreamIndex !== undefined) requestBody.subtitleStreamIndex = subtitleStreamIndex;
    const job = await api('/api/jobs', { method: 'POST', body: requestBody });
    if (!job.id) throw new Error('任务未返回有效标识，请重试。');
    if (keepCurrentPolling) {
      state.queuedJobIds.add(job.id);
      toast('已加入同影片取片队列，当前任务结束后依次处理。');
      loadHistory();
      return;
    }
    state.startedAt = parseStartedAt(job.startedAt || job.createdAt) || Date.now();
    state.cancelRequested = false;
    renderJob(job);
    beginPolling(job.id);
    scrollToTask();
  } catch (error) {
    showError('form-error', error.message);
  } finally {
    state.submitting = false;
    $('start-button').classList.remove('loading');
    updateControls();
  }
}

function parseStartedAt(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}
function scrollToTask() {
  $('task-panel').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
}
function beginPolling(id) {
  clearTimeout(state.pollTimer);
  clearInterval(state.elapsedTimer);
  state.pollFailures = 0;
  setVisible('retry-poll-button', false);
  state.elapsedTimer = setInterval(updateElapsed, 1000);
  pollJob(id);
}
async function pollJob(id) {
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(id)}`);
    if (state.job?.id !== id) return;
    state.pollFailures = 0;
    renderJob(job);
    if (!terminalStatuses.has(job.status)) state.pollTimer = setTimeout(() => pollJob(id), 850);
  } catch (error) {
    if (state.job?.id !== id) return;
    state.pollFailures += 1;
    if (state.pollFailures < 4) {
      $('task-stage').textContent = '连接暂时中断，正在重连任务…';
      state.pollTimer = setTimeout(() => pollJob(id), 1500 * state.pollFailures);
    } else {
      showError('task-error', `${error.message} 任务状态尚未确认，请重新连接后再操作。`);
      setVisible('retry-poll-button', true);
    }
  }
}
function updateElapsed() {
  if (queueWorkspace && state.job) {
    const timing = queueWorkspace.queueTime(state.job), ms = timing.working ?? timing.waiting;
    let label = state.job.status === 'queued' ? '等待中' : '—';
    if (ms !== null) {
      const seconds = Math.max(0, Math.floor(ms / 1000));
      label = `${timing.working !== null ? '实际处理' : '排队'} ${seconds >= 3600 ? formatTime(seconds) : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`}`;
    }
    $('task-elapsed').textContent = label;
    return;
  }
  if (!state.startedAt) return;
  if (state.job && terminalStatuses.has(state.job.status) && !state.finishedAt) {
    $('task-elapsed').textContent = '已结束';
    return;
  }
  const seconds = Math.max(0, Math.floor(((state.finishedAt || Date.now()) - state.startedAt) / 1000));
  $('task-elapsed').textContent = seconds >= 3600 ? formatTime(seconds) : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
const stageNames = {
  checking: '检查来源版本',
  positioning: '按时间索引定位', fetch: '读取目标片段', probe: '检查本地片段', extract: '本地原码裁切', validate: '核验导出片段',
  queued: '等待取材', preparing: '准备文件与输出目录', probing: '检查文件信息',
  extracting: '获取原码候选片段', extracting_candidate: '获取原码候选片段',
  candidate: '获取原码候选片段', fetching: '获取原码候选片段', remuxing: '封装原码候选片段',
  converting: '生成 MP4 工作副本', compatible: '生成 MP4 工作副本', making_mp4: '生成 MP4 工作副本',
  verifying: '核验导出片段', validating: '核验导出片段', finalizing: '保存取材记录',
  completed: '片段已保存在本地', cancelled: '获取已停止', failed: '本次取材未完成',
};
function progressValue(progress) {
  if (typeof progress === 'number' && Number.isFinite(progress)) return Math.max(0, Math.min(100, progress));
  if (progress && typeof progress === 'object') {
    if (Number.isFinite(progress.percent)) return Math.max(0, Math.min(100, progress.percent));
    if (Number.isFinite(progress.ratio)) return Math.max(0, Math.min(100, progress.ratio * 100));
  }
  return null;
}
function receivedBytes(metrics) {
  const value = Number(metrics?.receivedBytes ?? metrics?.downloadedBytes);
  return Number.isFinite(value) && value >= 0 ? value : null;
}
function jobErrorMessage(job) {
  const message = typeof job.error === 'string' ? job.error : job.error?.message;
  if (job.error?.code !== 'BUDGET_EXCEEDED') return message || '';
  const usage = [];
  const bytes = receivedBytes(job.metrics);
  const limit = Number(job.metrics?.budgetBytes);
  if (bytes !== null) usage.push(`本次已接收 ${formatBytes(bytes)}`);
  if (Number.isFinite(limit) && limit > 0) usage.push(`本次上限 ${formatBytes(limit)}`);
  return [
    message || '本次任务因 HTTP 接收上限而停止。',
    usage.length ? `${usage.join('，')}。` : '',
    '可在「读取上限与导出说明」中提高上限，或缩短取材时间；确认来源和时间后，再点击「获取原码片段」创建新任务。提高上限不能保证任务完成。',
  ].filter(Boolean).join(' ');
}
function renderJobDiagnostics(job, changedJob) {
  const view = formatJobDiagnostics(job);
  state.diagnosticReport = createDiagnosticReport(job, { version: $('app-version').textContent });
  setVisible('task-diagnostics', Boolean(view));
  setVisible('task-diagnostic-report', Boolean(state.diagnosticReport));
  if (changedJob || !view) state.manualDiagnosticCopy = false;
  if (changedJob || !view) $('task-diagnostic-report').open = false;
  $('task-reading-state').textContent = view?.summary || '';
  $('task-network-timing').textContent = view?.networkTiming || '';
  $('task-stage-timing').textContent = view?.stageTiming || '';
  $('task-index-reuse').textContent = view?.indexReuse || '';
  setVisible('task-index-reuse', Boolean(view?.indexReuse));
  setVisible('task-network-timing', Boolean(view?.networkTiming));
  setVisible('task-stage-timing', Boolean(view?.stageTiming));
  if (!state.manualDiagnosticCopy) $('task-diagnostic-json').textContent = state.diagnosticReport ? JSON.stringify(state.diagnosticReport, null, 2) : '';
}
async function copyJobDiagnostics() {
  if (!state.diagnosticReport) return;
  const text = JSON.stringify(state.diagnosticReport, null, 2);
  state.manualDiagnosticCopy = false;
  try {
    await navigator.clipboard.writeText(text);
    toast('脱敏诊断已复制');
  } catch {
    $('task-diagnostic-report').open = true;
    const content = $('task-diagnostic-json');
    content.textContent = text;
    // Keep this selected snapshot intact while subsequent polls update the
    // live statistics. Closing the report restores the live JSON view.
    state.manualDiagnosticCopy = true;
    content.focus({ preventScroll: true });
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange(); range.selectNodeContents(content);
      selection.removeAllRanges(); selection.addRange(range);
    }
    toast(selection?.toString() === text ? '已选中诊断，请按 ⌘C 或 Ctrl+C 复制。' : '自动复制不可用，请选中诊断报告的文字后复制。');
  }
}
function renderResume() {
  const checkedSource = Boolean(state.sourceId && state.sourceSignature === sourceSignature());
  const view = resumeView(state.job, {
    checkedSource, connected: state.connected,
    locked: browserSourceLocked(),
  });
  setVisible('task-resume', Boolean(view));
  if (!view) return;
  $('task-resume-title').textContent = view.title;
  const cached = view.cachedBytes === null ? '缓存大小待确认' : `已校验缓存 ${formatBytes(view.cachedBytes)}${view.totalBytes > 0 ? ` / 目标 ${formatBytes(view.totalBytes)}` : ''}`;
  $('task-resume-summary').textContent = view.available ? `${cached}${view.resumeCount ? ` · 已恢复 ${view.resumeCount} 次` : ''}` : [view.reason, view.showDiscard && view.cachedBytes !== null ? `保留缓存 ${formatBytes(view.cachedBytes)}` : ''].filter(Boolean).join(' ');
  const range = view.range;
  $('task-resume-range').textContent = view.available ? [range ? `${formatTime(range.start)} → ${formatTime(range.end)} · 前后各 ${range.handles} 秒余量` : '', view.outputDir ? `保存位置：${view.outputDir}` : ''].filter(Boolean).join('；') : '';
  setVisible('task-resume-range', Boolean($('task-resume-range').textContent));
  const budget = [];
  if (view.available && view.budgetUsedBytes !== null) budget.push(`累计计入上限 ${formatBytes(view.budgetUsedBytes)}${view.budgetBytes > 0 ? ` / ${formatBytes(view.budgetBytes)}` : ''}`);
  if (view.available && view.uncertainBytes > 0) budget.push(`其中 ${formatBytes(view.uncertainBytes)} 为异常退出前未确认的请求预留，按保守用量计入；不代表实际已接收`);
  $('task-resume-budget').textContent = budget.join('。');
  setVisible('task-resume-budget', budget.length > 0);
  $('task-resume-instructions').textContent = view.instruction;
  setVisible('task-resume-instructions', Boolean(view.instruction));
  setVisible('task-resume-cache-note', view.available || view.showDiscard);
  setVisible('resume-button', view.showActions);
  setVisible('discard-resume-button', view.showDiscard);
  $('resume-button').disabled = !view.canResume;
  $('resume-button').textContent = state.resumeAction === 'resume' ? '正在核对并恢复…' : '继续下载';
  $('discard-resume-button').disabled = !view.canDiscard;
  $('discard-resume-button').textContent = state.resumeAction === 'discard' ? '正在清除…' : '清除续传缓存';
}
async function resumeJob() {
  const job = state.job;
  const checkedSource = Boolean(state.sourceId && state.sourceSignature === sourceSignature());
  if (!resumeView(job, { checkedSource, connected: state.connected, locked: browserSourceLocked() })?.canResume) return;
  state.resumeAction = 'resume';
  showError('task-error', '');
  updateControls();
  try {
    const resumed = await api(`/api/jobs/${encodeURIComponent(job.id)}/resume`, { method: 'POST', body: { sourceId: state.sourceId } });
    if (!resumed.id) throw new Error('未获得续传任务标识，请刷新任务后重试。');
    state.startedAt = parseStartedAt(resumed.startedAt) || Date.now();
    state.cancelRequested = false;
    state.lastHistoryJob = null;
    renderJob(resumed, { track: true });
    if (!queueWorkspace && !terminalStatuses.has(resumed.status)) beginPolling(resumed.id);
    scrollToTask();
  } catch (error) { showError('task-error', error.message); }
  finally { state.resumeAction = null; updateControls(); }
}
async function discardResume() {
  const job = state.job;
  if (!resumeView(job, { connected: state.connected, locked: browserSourceLocked() })?.canDiscard) return;
  state.resumeAction = 'discard';
  showError('task-error', '');
  updateControls();
  try {
    const updated = await api(`/api/jobs/${encodeURIComponent(job.id)}/discard-resume`, { method: 'POST', body: {} });
    const record = updated.id && updated.status ? updated : await api(`/api/jobs/${encodeURIComponent(job.id)}`);
    if (state.job?.id === job.id) renderJob(record);
    await loadHistory();
    toast('本机续传缓存已清除。');
  } catch (error) { showError('task-error', error.message); }
  finally { state.resumeAction = null; updateControls(); }
}
function renderJob(job, { track = false } = {}) {
  if (track) queueWorkspace?.observe(job, { track });
  const previousJob = state.job;
  state.job = job;
  state.queuedJobIds.delete(job.id);
  state.finishedAt = parseStartedAt(job.finishedAt || job.completedAt);
  const jobBusy = !terminalStatuses.has(job.status);
  const waiting = job.status === 'queued';
  const stoppedMp4 = job.status === 'cancelled' && job.result?.candidatePath && !job.result.compatiblePath;
  state.busy = jobBusy || Boolean(queueWorkspace?.hasActivity());
  setVisible('task-details-shell', true);
  setVisible('task-empty', false);
  setVisible('task-content', true);
  const name = job.clipName || job.sourceLabel || job.result?.sourceLabel;
  const range = job.requested || historyRequestedRange(job);
  const rangeLabel = range && Number.isFinite(range.start) && Number.isFinite(range.end)
    ? `${formatTime(range.start)} → ${formatTime(range.end)}${Number.isFinite(range.handles) ? ` · 前后各 ${range.handles} 秒` : ''}` : '';
  $('task-selection').textContent = [name, rangeLabel].filter(Boolean).join(' · ');
  setVisible('task-selection', Boolean($('task-selection').textContent));
  const badge = $('task-badge');
  const titles = { queued: '等待取材', running: '正在获取片段', completed: '素材已准备好', failed: '获取未完成', cancelled: '任务已停止' };
  const badges = { queued: '排队中', running: '进行中', completed: '已完成', failed: '未完成', cancelled: '已停止' };
  const resumable = job.resume?.available === true && terminalStatuses.has(job.status) && job.status !== 'completed';
  badge.textContent = resumable ? '可继续' : badges[job.status] || '处理中';
  badge.className = `tag ${job.status === 'completed' ? 'success' : job.status === 'failed' ? 'error' : jobBusy ? 'active' : ''}`;
  $('task-status-title').textContent = stoppedMp4 ? 'MP4 生成已停止'
    : resumable ? '下载已停止，进度已保存' : job.type === 'compatible' && jobBusy && !waiting ? '正在生成本地 MP4'
    : job.downloadMethod === 'direct-stream' && job.status === 'running' ? '正在流式获取片段' : titles[job.status] || '正在处理';
  $('task-stage').textContent = stoppedMp4 ? '原码 MKV 已保存。' : job.status === 'failed' ? '本次任务已停止'
    : redact(job.message || stageNames[job.stage] || (jobBusy ? '正在处理素材…' : stageNames[job.status]) || '任务状态已更新');
  const reportedPercent = job.status === 'completed' ? 100 : progressValue(job.progress);
  const percent = waiting ? 0 : jobBusy && !(reportedPercent > 0) ? null : reportedPercent;
  $('progress-track').classList.toggle('indeterminate', percent === null && jobBusy);
  $('progress-fill').style.width = percent === null ? (jobBusy ? '35%' : '0%') : `${percent}%`;
  if (percent === null) $('progress-track').removeAttribute('aria-valuenow');
  else $('progress-track').setAttribute('aria-valuenow', String(percent));
  $('task-progress-text').textContent = job.status === 'completed' ? '100%'
    : waiting ? '尚未开始下载' : !jobBusy ? '任务已停止'
      : percent !== null ? `当前阶段 ${percent < 1 ? '<1' : Math.round(percent)}%`
        : job.type === 'compatible' ? '正在处理本地片段，进度暂不可估算'
          : '正在定位或读取片段，进度暂不可估算';
  const bytes = receivedBytes(job.metrics);
  const limit = Number(job.metrics?.budgetBytes);
  const hasLimit = Number.isFinite(limit) && limit > 0;
  const recoveries = Number.isSafeInteger(job.recoveryAttempts) && job.recoveryAttempts > 0 ? ` · 已续读 ${job.recoveryAttempts} 次` : '';
  $('task-bytes').textContent = `${bytes === null ? '—' : formatBytes(bytes)}${hasLimit ? ` / 上限 ${formatBytes(limit)}` : ''}${job.type === 'compatible' ? '（本地处理）' : ''}${recoveries}`;
  setVisible('task-upstream-note', job.type !== 'compatible' && (hasLimit || bytes > 0));
  const readModeText = job.readMode === 'parallel' ? '双路读取（实验）' : job.readMode === 'continuous' ? '连续读取' : job.readMode === 'standard' ? '稳健模式' : '';
  $('task-read-mode').textContent = job.downloadMethod === 'direct-stream' ? '流式直连（新测试）'
    : [downloadMethodLabel(job.downloadMethod), readModeText].filter(Boolean).join(' · ');
  setVisible('task-read-mode', Boolean($('task-read-mode').textContent));
  renderJobDiagnostics(job, previousJob?.id !== job.id);
  const error = stoppedMp4 ? '' : jobErrorMessage(job);
  showError('task-error', error || '');
  setVisible('retry-poll-button', false);
  setVisible('cancel-button', !terminalStatuses.has(job.status));
  $('cancel-button').disabled = state.cancelRequested;
  $('cancel-button').textContent = state.cancelRequested ? '正在停止…' : waiting ? '移出队列' : '停止获取';
  const warnings = job.result?.warnings || job.warnings || [];
  const warningText = Array.isArray(warnings) ? warnings.map((warning) => typeof warning === 'string' ? warning : warning.message || '').filter(Boolean).join('；') : String(warnings);
  $('task-warning').textContent = warningText;
  setVisible('task-warning', Boolean(warningText));
  if (!jobBusy && job.result) renderResults(job.result);
  else {
    setVisible('task-results', false);
    clearPreview();
  }
  updateElapsed();
  if (!jobBusy) {
    clearTimeout(state.pollTimer);
    clearInterval(state.elapsedTimer);
    if (job.status === 'cancelled' && !stoppedMp4 && !error && !resumable) $('task-stage').textContent = '已停止。未完成的文件请以任务记录和输出目录为准。';
    const historyKey = `${job.id}:${job.status}`;
    if (!queueWorkspace && state.lastHistoryJob !== historyKey) {
      state.lastHistoryJob = historyKey;
      loadHistory();
    }
  }
  updateControls();
}

function resultEntries(result) {
  const entries = [];
  if (result.candidatePath) entries.push({ path: result.candidatePath, label: '原码候选片段', detail: '视频与音频按原编码复制', type: 'MKV' });
  if (result.compatiblePath) entries.push({ path: result.compatiblePath, label: 'MP4 工作副本', detail: '视频复制 · 有音轨时转 AAC 320 kb/s 双声道', type: 'MP4' });
  for (const subtitlePath of Array.isArray(result.subtitlePaths) ? result.subtitlePaths : []) {
    if (typeof subtitlePath !== 'string' || !subtitlePath) continue;
    const metadata = (Array.isArray(result.subtitleResults) ? result.subtitleResults : []).find(item => item.path === subtitlePath);
    const extension = basename(subtitlePath).split('.').at(-1).toUpperCase();
    const image = metadata?.kind === 'image' || ['SUP', 'SUB', 'IDX', 'MKS'].includes(extension);
    entries.push({ path: subtitlePath, label: image ? '独立图片字幕' : '独立字幕文件',
      detail: image ? '单独保存，需支持该格式的播放器；不能直接作为可编辑 SRT 文字' : '单独保存，可自行在播放器或剪辑软件中选择使用', type: extension });
  }
  if (result.sidecarPath) entries.push({ path: result.sidecarPath, label: '取材记录', detail: '来源、时间范围与处理信息', type: 'JSON' });
  if (!entries.length && result.outputPath) entries.push({ path: result.outputPath, label: '导出片段', type: 'FILE' });
  return entries;
}
function renderResults(result) {
  const container = $('result-files');
  container.replaceChildren();
  const entries = resultEntries(result);
  for (const file of entries) {
    const card = document.createElement('div'); card.className = 'result-file';
    const title = document.createElement('div'); title.className = 'result-file-title';
    const symbol = document.createElement('span'); symbol.className = 'file-symbol'; symbol.textContent = file.type;
    const name = document.createElement('span'); name.className = 'result-file-name'; name.textContent = file.label;
    title.append(symbol, name); card.append(title);
    const meta = document.createElement('p'); meta.className = 'result-file-meta'; meta.textContent = file.detail || ''; card.append(meta);
    const path = document.createElement('p'); path.className = 'result-file-path'; path.textContent = basename(file.path); path.title = file.path; card.append(path);
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'result-copy'; copy.textContent = '复制文件路径';
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(file.path); toast('文件路径已复制'); }
      catch { toast('浏览器无法访问剪贴板，请在访达中查看文件。'); }
    });
    const reveal = document.createElement('button'); reveal.type = 'button'; reveal.className = 'result-copy'; reveal.textContent = '在文件夹中显示';
    reveal.addEventListener('click', async () => {
      reveal.disabled = true;
      try { await api('/api/reveal', { method: 'POST', body: { path: file.path } }); }
      catch (error) { toast(error.message); }
      finally { reveal.disabled = false; }
    });
    const actions = document.createElement('div'); actions.className = 'result-file-actions'; actions.append(copy, reveal);
    card.append(actions); container.append(card);
  }
  $('reveal-button').disabled = !entries.length && !result.outputDir;
  setVisible('compatible-button', Boolean(result.candidatePath && !result.compatiblePath));
  const previewUrl = typeof result.previewUrl === 'string' && /^\/api\/local-media\/[A-Za-z0-9_-]+$/.test(result.previewUrl) ? result.previewUrl : null;
  if (previewUrl) {
    if ($('preview-video').getAttribute('src') !== previewUrl) {
      $('preview-video').pause();
      $('preview-video').src = previewUrl;
    }
    setVisible('local-preview', true);
  } else clearPreview();
  setVisible('task-results', Boolean(entries.length || result.outputDir));
}

function clearPreview() {
  const video = $('preview-video');
  video.pause();
  if (video.hasAttribute('src')) { video.removeAttribute('src'); video.load(); }
  setVisible('local-preview', false);
}
async function makeCompatible() {
  if (state.busy || state.transferChecking || state.probing || state.picking || !state.job?.id || !state.job.result?.candidatePath) return;
  const parentId = state.job.id;
  showError('task-error', '');
  state.queueActionPending = Boolean(queueWorkspace);
  state.busy = true;
  $('compatible-button').classList.add('loading');
  updateControls();
  try {
    const job = await api(`/api/jobs/${encodeURIComponent(parentId)}/compatible`, { method: 'POST', body: {} });
    if (!job.id) throw new Error('未获得 MP4 任务标识，请重试。');
    state.startedAt = parseStartedAt(job.startedAt || job.createdAt) || Date.now();
    state.cancelRequested = false;
    renderJob(job, { track: true });
    if (!queueWorkspace) beginPolling(job.id);
    scrollToTask();
  } catch (error) { state.busy = false; showError('task-error', error.message); }
  finally { state.queueActionPending = false; $('compatible-button').classList.remove('loading'); updateControls(); }
}
function initializeSetupGuide(hasRecords) {
  if (state.setupGuideInitialized) return;
  if (!state.dependenciesReady || !state.windowsEdge && !hasRecords && !state.sourceId && !state.queueSource) $('setup-guide').open = true;
  state.setupGuideInitialized = true;
}
async function loadHistory() {
  if (!state.connected) return;
  if (queueWorkspace) { await queueWorkspace.sync().catch(() => {}); return; }
  const request = ++state.historyRequest;
  state.loadingHistory = true;
  try {
    const result = await api('/api/jobs/history');
    if (request !== state.historyRequest) return;
    state.history = Array.isArray(result.jobs) ? result.jobs : [];
    initializeSetupGuide(state.history.length > 0);
    followQueuedHistory();
  } catch (error) {
    if (request === state.historyRequest) toast(error.message);
  } finally {
    if (request === state.historyRequest) { state.loadingHistory = false; updateControls(); }
  }
}
function followQueuedHistory() {
  if (queueWorkspace) return;
  for (const job of state.history) {
    if (terminalStatuses.has(job.status)) state.queuedJobIds.delete(job.id);
    else if (job.id !== state.job?.id) state.queuedJobIds.add(job.id);
  }
  if (state.busy) return;
  const next = state.history.filter(job => state.queuedJobIds.has(job.id) && !terminalStatuses.has(job.status))
    .sort((a, b) => (a.status === 'running' ? -1 : 0) - (b.status === 'running' ? -1 : 0)
      || (parseStartedAt(a.createdAt) || 0) - (parseStartedAt(b.createdAt) || 0))[0];
  if (!next) return;
  state.startedAt = parseStartedAt(next.startedAt || next.createdAt) || Date.now();
  state.cancelRequested = false;
  renderJob(next);
  beginPolling(next.id);
}
async function cancelJob() {
  const job = state.job;
  if (!job || terminalStatuses.has(job.status) || state.transferChecking || state.cancelRequested) return;
  state.cancelRequested = true;
  $('cancel-button').disabled = true;
  $('cancel-button').textContent = '正在停止…';
  try {
    const response = await api(`/api/jobs/${encodeURIComponent(job.id)}/cancel`, { method: 'POST', body: {} });
    if (state.job?.id === job.id) {
      if (response.status && response.id === job.id) renderJob(response);
      else $('task-stage').textContent = '已发送停止请求，正在等待任务结束…';
    }
    if (queueWorkspace) await queueWorkspace.sync().catch(() => {});
  } catch (error) {
    if (state.job?.id !== job.id) return;
    state.cancelRequested = false;
    $('cancel-button').disabled = false;
    $('cancel-button').textContent = state.job.status === 'queued' ? '移出队列' : '停止获取';
    showError('task-error', error.message);
  }
}
async function revealResults() {
  const result = state.job?.result;
  if (!result) return;
  const path = result.candidatePath || result.compatiblePath || result.outputDir || result.outputPath || result.sidecarPath || result.subtitlePaths?.[0];
  if (!path) return;
  $('reveal-button').disabled = true;
  try { await api('/api/reveal', { method: 'POST', body: { path } }); }
  catch (error) { toast(error.message); }
  finally { $('reveal-button').disabled = false; }
}
async function pickFile() {
  if (state.busy || state.transferChecking || state.probing || state.picking || !state.connected) return;
  state.picking = 'file';
  showError('probe-error', '');
  $('file-picker-status').textContent = '正在打开系统文件选择窗口…';
  updateControls();
  try {
    const result = await api('/api/pick-file', { method: 'POST', body: {} });
    if (result.path) {
      $('local-path').value = result.path;
      invalidateSource();
      $('file-picker-status').textContent = '已选择文件，请检查源文件。';
    } else {
      $('file-picker-status').textContent = '已取消选择，原文件路径保持不变。';
    }
  } catch (error) {
    $('file-picker-status').textContent = '文件选择窗口未能完成，可直接填写完整文件路径。';
    showError('probe-error', error.message);
  } finally {
    state.picking = null;
    updateControls();
  }
}
async function pickDirectory() {
  if (state.busy || state.transferChecking || state.probing || state.picking || !state.connected) return;
  state.picking = 'directory';
  showError('form-error', '');
  $('directory-picker-status').textContent = '正在打开系统文件夹窗口…';
  updateControls();
  try {
    const result = await api('/api/pick-directory', { method: 'POST', body: {} });
    if (result.path) {
      $('output-dir').value = result.path;
      invalidateSetup();
      $('directory-picker-status').textContent = '保存文件夹已更新。';
    } else {
      $('directory-picker-status').textContent = '已取消选择，保存位置保持不变。';
    }
  } catch (error) {
    $('directory-picker-status').textContent = '文件夹窗口未能完成，可在上方直接填写完整文件夹路径。';
    showError('form-error', error.message);
  } finally {
    state.picking = null;
    updateControls();
  }
}
async function trySample() {
  if (!state.samplePath || state.busy || state.transferChecking || state.probing || state.picking) return;
  selectSource('local');
  $('local-path').value = state.samplePath;
  $('start-time').value = '00:00:05';
  $('end-time').value = '00:00:09';
  if (!queueWorkspace) $('handles').value = '1';
  invalidateSource();
  updateRange();
  await probeSource();
  if (state.sourceId) toast(queueWorkspace ? '示例已就绪。填好片段后，点击「开始顺序取材」。' : '示例已就绪。点击「开始获取片段」试用。');
}

function basename(path) {
  if (!path) return '';
  try {
    const url = new URL(path);
    return decodeURIComponent(url.pathname.split('/').filter(Boolean).at(-1) || url.hostname);
  } catch { return String(path).replace(/\\/g, '/').split('/').filter(Boolean).at(-1) || path; }
}
function formatTime(value) {
  if (!Number.isFinite(value)) return '—';
  const seconds = Math.max(0, value);
  const h = Math.floor(seconds / 3600), m = Math.floor((seconds % 3600) / 60), s = Math.floor(seconds % 60);
  const fraction = Math.round((seconds - Math.floor(seconds)) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${fraction && fraction < 1000 ? `.${String(fraction).padStart(3, '0').replace(/0+$/, '')}` : ''}`;
}
function humanDuration(value) {
  const seconds = Math.max(0, Math.round(value));
  if (seconds < 60) return `${seconds} 秒`;
  const hours = Math.floor(seconds / 3600), minutes = Math.floor((seconds % 3600) / 60), rest = seconds % 60;
  return [hours ? `${hours} 小时` : '', minutes ? `${minutes} 分` : '', rest ? `${rest} 秒` : ''].filter(Boolean).join(' ');
}
function formatBytes(value) {
  if (value === null || !Number.isFinite(value)) return '未知';
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  const order = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)) - 1);
  const amount = value / Math.pow(1024, order + 1);
  return `${amount.toFixed(amount >= 100 ? 0 : amount >= 10 ? 1 : 2)} ${units[order]}`;
}


function queueContext() {
  const checked = Boolean(state.sourceId && state.sourceSignature === sourceSignature());
  const restored = state.queueSource;
  const sourceId = checked ? state.sourceId : restored?.sourceId;
  const media = checked ? state.probe?.media : restored?.media;
  const type = checked ? state.sourceType : restored?.type;
  const direct = checked ? state.probe?.directStreamAvailable === true : restored?.directStreamAvailable === true;
  const request = { outputDir: $('output-dir').value, budgetMiB: Number($('budget').value), makeMp4: $('make-mp4').checked, readMode: $('read-mode').value || 'standard', reuseIndex: $('reuse-index').checked };
  if (type === 'browser') { request.downloadMethod = direct && $('download-method').value === 'direct-stream' ? 'direct-stream' : 'indexed'; if (request.downloadMethod === 'direct-stream') { request.readMode = 'standard'; request.reuseIndex = false; } }
  if ($('audio-stream').value !== '') request.audioStreamIndex = Number($('audio-stream').value);
  return { sourceId, label: checked ? clipSourceLabel() : restored?.label, kind: type,
    ready: Boolean(state.connected && state.dependenciesReady && sourceId), connected: state.connected, sourceLocked: browserSourceLocked(),
    blocked: Boolean(state.submitting || state.transferChecking || state.probing || state.picking || state.resumeAction || state.setupChecking || state.queueActionPending),
    duration: Number(media?.duration ?? media?.durationSeconds) || null, sizeBytes: Number(state.probe?.source?.size ?? media?.sizeBytes), request,
    subtitles: (media?.streams || []).filter(t => t.type === 'subtitle' || t.codec_type === 'subtitle').map((t,i) => ({index:t.index,supported:subtitleSupported(t),label:`字幕 ${i+1} · ${t.language || t.tags?.language || '语言未标记'} · ${(t.codec || t.codec_name || '').toUpperCase()}`})) };
}
function initializeQueueWorkspace() {
  if (typeof createQueueWorkspace !== 'function' || !$('queue-editor')) return;
  queueWorkspace = createQueueWorkspace({ editor: $('queue-editor'), status: $('queue-status'), statusBadge: $('queue-nav-status'), api: (route, options) => api(route, options), getContext: queueContext,
    onActivity() { updateControls(); }, onDraftChange() { state.browser.draftDirty = true; },
    onChooseSource() {
      if (browserSourceLocked()) return;
      const title = $('source-title');
      title.focus({ preventScroll: true });
      title.scrollIntoView?.({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    },
    onSource(source) {
      if (state.sourceId || state.probing || !source?.sourceId || !source.media || state.queueSource?.sourceId === source.sourceId) return;
      state.queueSource = source; state.probe = { source: { label: source.label }, media: source.media, directStreamAvailable: source.directStreamAvailable };
      if (['browser','dav','http','local'].includes(source.type)) showSourceTab(source.type);
      if (source.directStreamAvailable) $('download-method').value = 'direct-stream'; renderMedia(state.probe); $('probe-state').textContent = '已恢复当前影片与顺序队列。';
    },
    onFocus(job, { explicit = false } = {}) {
      clearTimeout(state.pollTimer); clearInterval(state.elapsedTimer);
      if (state.job?.id !== job.id || terminalStatuses.has(job.status)) state.cancelRequested = false;
      state.startedAt = parseStartedAt(job.startedAt);
      renderJob(job);
      if (explicit) {
        $('task-details-shell').open = true;
        $('task-details-shell').scrollIntoView?.({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      }
    },
    onRecordRemoved(id) {
      if (state.job?.id !== id || !terminalStatuses.has(state.job.status)) return;
      state.job = null;
      state.startedAt = null;
      state.finishedAt = null;
      state.diagnosticReport = null;
      state.manualDiagnosticCopy = false;
      $('task-badge').textContent = '尚未开始';
      $('task-badge').className = 'tag';
      clearPreview();
      setVisible('task-empty', true);
      setVisible('task-content', false);
      $('task-details-shell').open = false;
      setVisible('task-details-shell', false);
      updateControls();
    },
  });
  for (const id of ['legacy-range-options','legacy-name-option','legacy-submit-options','legacy-budget-option','subtitle-option','budget-suggestion']) setVisible(id, false);
}
initializeQueueWorkspace();

for (const tab of document.querySelectorAll('[data-source-type]')) {
  tab.addEventListener('click', () => selectSource(tab.dataset.sourceType));
  tab.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const types = [...document.querySelectorAll('[data-source-type]')].map((item) => item.dataset.sourceType);
    const index = types.indexOf(state.sourceType);
    const type = event.key === 'Home' ? types[0] : event.key === 'End' ? types.at(-1) : types[(index + (event.key === 'ArrowRight' ? 1 : -1) + types.length) % types.length];
    selectSource(type);
    $(`tab-${state.sourceType}`).focus();
  });
}
for (const element of document.querySelectorAll('.source-field')) element.addEventListener('input', () => {
  state.browser.draftDirty = true;
  if (element.classList.contains('dav-connection-field')) resetDavConnection();
  else invalidateSource();
});
$('dav-connect-form').addEventListener('submit', connectDav);
$('setup-guide-link').addEventListener('click', () => { $('setup-guide').open = true; });
$('setup-check').addEventListener('click', checkSetup);
for (const id of ['output-dir', 'dav-url']) $(id).addEventListener('input', () => { if (id === 'output-dir') state.browser.draftDirty = true; invalidateSetup(); });
$('dav-up-button').addEventListener('click', () => listDav(state.dav.parentUrl));
$('dav-refresh-button').addEventListener('click', () => listDav(state.dav.directoryUrl));
for (const id of ['start-time', 'end-time', 'handles']) $(id).addEventListener('input', () => { state.browser.draftDirty = true; updateRange(); showError('form-error', ''); });
$('clip-name').addEventListener('input', () => { state.clipNameSourceKey = sourceSignature(); state.clipNameEdited = Boolean($('clip-name').value.trim()); state.browser.draftDirty = true; showError('form-error', ''); });
$('clip-name').addEventListener('blur', () => {
  const normalized = sanitizeClipName($('clip-name').value);
  if (normalized) $('clip-name').value = normalized;
  else { state.clipNameEdited = false; updateClipName(); }
});
$('subtitle-stream').addEventListener('change', updateSubtitleHint);
for (const id of ['output-dir', 'budget', 'audio-stream', 'subtitle-stream', 'make-mp4', 'read-mode', 'reuse-index', 'download-method']) {
  $(id).addEventListener('change', () => { state.browser.draftDirty = true; if (queueWorkspace) updateControls(); });
}
$('budget').addEventListener('input', () => { state.browser.draftDirty = true; updateBudgetSuggestion(); });
$('apply-budget').addEventListener('click', () => {
  if (state.submitting || state.transferChecking || state.probing || state.picking || !state.connected || !state.budgetRecommendationMiB) return;
  $('budget').value = state.budgetRecommendationMiB;
  updateBudgetSuggestion();
  showError('form-error', '');
  toast('HTTP 接收上限已调整，请确认取材时间后再开始获取。');
});
$('probe-button').addEventListener('click', probeSource);
$('bookmark-capture-link').addEventListener('click', event => {
  event.preventDefault();
  toast(state.windowsEdge ? '把抓链书签拖到 Edge 收藏夹栏，再到已登录的网盘页面点击使用。' : '把抓链书签拖到浏览器书签栏，再到网盘页面点击使用。');
});
$('bookmark-capture-link').addEventListener('dragstart', event => {
  if (!state.browser.available) { event.preventDefault(); return; }
  // Keep the native anchor drag payload, including its bookmark title.
  // Replacing URI data here drops the title when WebKit hands the link to Chrome.
});
$('download-method').addEventListener('change', updateControls);
$('bookmark-install-chrome').addEventListener('click', () => openBookmarkInstaller('chrome'));
$('bookmark-install-edge').addEventListener('click', () => openBookmarkInstaller('edge'));
$('transfer-check-start').addEventListener('click', startTransferCheck);
$('transfer-check-cancel').addEventListener('click', cancelTransferCheck);
$('transfer-check-retry').addEventListener('click', () => { if (state.transferCheck?.id) pollTransferCheck(state.transferCheck.id); else recoverTransferCheck(); });
$('transfer-check-copy').addEventListener('click', copyTransferCheck);
$('pick-file').addEventListener('click', pickFile);
$('pick-directory').addEventListener('click', pickDirectory);
$('prepare-magnet').addEventListener('click', prepareMagnet);
$('copy-magnet').addEventListener('click', copyMagnet);
$('magnet-input').addEventListener('input', () => { state.magnet = null; setVisible('magnet-guide', false); showError('magnet-error', ''); });
$('compatible-button').addEventListener('click', makeCompatible);
$('sample-button').addEventListener('click', trySample);
$('extract-form').addEventListener('submit', startJob);
$('cancel-button').addEventListener('click', cancelJob);
$('resume-button').addEventListener('click', resumeJob);
$('discard-resume-button').addEventListener('click', discardResume);
$('copy-task-diagnostic').addEventListener('click', copyJobDiagnostics);
$('task-diagnostic-report').addEventListener('toggle', () => {
  if ($('task-diagnostic-report').open) return;
  state.manualDiagnosticCopy = false;
  $('task-diagnostic-json').textContent = state.diagnosticReport ? JSON.stringify(state.diagnosticReport, null, 2) : '';
});
$('reveal-button').addEventListener('click', revealResults);
$('retry-poll-button').addEventListener('click', () => {
  if (!state.job?.id) return;
  showError('task-error', '');
  beginPolling(state.job.id);
});
bootstrap();
