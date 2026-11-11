import './capture-core.js';
const Core = globalThis.ClipFetcherCaptureCore;
const PREFIX = 'clip-capture-';
const MESSAGES = Object.freeze({
  PAIRING_INVALID: '请粘贴原工具本次生成的完整配对地址。',
  PAIRING_MISSING: '请先在原工具的“浏览器直连”中复制地址，完成一次配对。',
  PAIRING_EXPIRED: '配对已失效或工具已连接其他助手，请在原工具重新生成配对地址。',
  PAGE_UNSUPPORTED: '请切换到已登录的百度网盘或迅雷云盘网页。',
  PAGE_CHANGED: '网页已切换，请在当前网盘页面重新开始识别。',
  TOOL_UNAVAILABLE: '暂时无法连接片段取材，请确认原工具已打开。',
  TOOL_RESPONSE_INVALID: '原工具返回了无效结果，请重新配对。',
  SOURCE_REJECTED: '原工具未接收这批文件入口，请在工具中查看连接状态。',
  CAPTURE_UNAVAILABLE: '此网页暂时无法开始识别，请刷新网页后重试。',
  CANCELLED: '已停止识别。',
  REQUEST_INVALID: '助手请求无效。',
  BROWSER_UNSUPPORTED: '当前浏览器缺少临时会话存储，请使用 Chrome 或 Edge 120 及以上版本。',
  DETAIL_UNAVAILABLE: '迅雷官方文件状态暂不可用，请先在网页打开影片目录，再刷新列表。',
  DETAIL_BUSY: '正在读取所选影片，请等待完成或停止识别。',
});
const DETAIL_MESSAGES = Object.freeze({
  DETAIL_READY: '已读取本次原文件入口，候选会发送到原工具核验。',
  DETAIL_BUSY: MESSAGES.DETAIL_BUSY,
  DETAIL_CHANGED: '影片或网页状态已改变，请刷新列表并重新选择。',
  DETAIL_REQUEST_FAILED: '官方详情动作未完成，请查看网页提示；旧下载路径仍可使用。',
  DETAIL_ORIGINAL_UNAVAILABLE: '本次详情没有提供原文件入口，未改用播放流；旧下载路径仍可使用。',
  DETAIL_TIMEOUT: '读取官方文件入口超时，请检查网页提示后重试。',
  DETAIL_CANCELLED: '已停止识别，本次入口结果已丢弃。',
});
const fail = code => Object.assign(new Error(MESSAGES[code] || MESSAGES.REQUEST_INVALID), { code });
const safeTabId = id => Number.isSafeInteger(id) && id >= 0;
async function readResponse(response) {
  let reader;
  try {
    reader = response.body?.getReader(); if (!reader) throw fail('TOOL_RESPONSE_INVALID');
    const parts = []; let total = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      if (next.value.byteLength > 8192 - total) throw fail('TOOL_RESPONSE_INVALID');
      total += next.value.byteLength; parts.push(next.value);
    }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { throw fail('TOOL_RESPONSE_INVALID'); }
  finally { try { await reader?.cancel(); } catch {} }
}

/** Dependency-injected transport, shared by the real MV3 worker and tests.
 * Only pairing data is persistent; candidate URLs stay in request memory. */
export function createBrowserHelperController({ chromeApi, fetchImpl = fetch,
  userAgent = navigator.userAgent, uuid = () => crypto.randomUUID() } = {}) {
  const operations = new Map(), capturing = new Map(), sending = new Map(), dedup = new Map(), sessionWrites = new Map();
  const key = tabId => PREFIX + tabId;
  function temporaryStorage() {
    if (!chromeApi.storage?.session?.get || !chromeApi.storage.session.set || !chromeApi.storage.session.remove) throw fail('BROWSER_UNSUPPORTED');
    return chromeApi.storage.session;
  }
  async function pairing() {
    const stored = (await temporaryStorage().get('pairing')).pairing;
    if (!stored) return null;
    try { return Core.checkedPairing(stored); } catch { await temporaryStorage().remove('pairing'); return null; }
  }
  async function session(tabId) { return (await temporaryStorage().get(key(tabId)))[key(tabId)] || null; }
  function mutateSession(tabId, change) {
    const previous = sessionWrites.get(tabId) || Promise.resolve();
    const next = previous.catch(() => {}).then(async () => {
      const latest = await session(tabId), value = change(latest);
      if (value === null) await temporaryStorage().remove(key(tabId));
      else if (value !== undefined) await temporaryStorage().set({ [key(tabId)]: value });
      return value;
    });
    sessionWrites.set(tabId, next);
    void next.finally(() => { if (sessionWrites.get(tabId) === next) sessionWrites.delete(tabId); }).catch(() => {});
    return next;
  }
  const saveSession = (tabId, value) => mutateSession(tabId, () => value);
  async function stop(tabId, { remove = false } = {}) {
    if (!safeTabId(tabId)) return { ok: true };
    operations.get(tabId)?.controller.abort(); operations.delete(tabId); dedup.delete(tabId);
    capturing.get(tabId)?.controller.abort(); capturing.delete(tabId);
    const previous = await session(tabId);
    try { await chromeApi.tabs.sendMessage(tabId, { type: 'capture:stop' }, { frameId: 0 }); } catch {}
    if (remove) await mutateSession(tabId, () => null);
    else if (previous) await mutateSession(tabId, latest => latest?.sessionId === previous.sessionId
      ? { ...latest, active: false, phase: 'stopped', message: MESSAGES.CANCELLED,
        ...(latest.detail?.status === 'running' ? { detail: { ...latest.detail, status: 'error', code: 'DETAIL_CANCELLED', message: DETAIL_MESSAGES.DETAIL_CANCELLED } } : {}) } : undefined);
    return { ok: true };
  }
  async function post(pair, route, payload, signal) {
    let response;
    try {
      response = await fetchImpl(`${pair.origin}${route}`, {
        method: 'POST', redirect: 'error', credentials: 'omit', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'X-Browser-Pairing': pair.token },
        body: JSON.stringify(payload), signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]),
      });
    } catch { throw fail(signal?.aborted ? 'CANCELLED' : 'TOOL_UNAVAILABLE'); }
    if (!response.ok) {
      try { await response.body?.cancel(); } catch {}
      throw fail([401,403,409].includes(response.status) ? 'PAIRING_EXPIRED' : response.status === 400 ? 'SOURCE_REJECTED' : 'TOOL_UNAVAILABLE');
    }
    return readResponse(response);
  }
  async function confirmPair(pair, signal) {
    const result = await post(pair, '/api/browser-helper/pair', { schemaVersion: 1 }, signal);
    if (result?.ok !== true || result.schemaVersion !== 1 || !Array.isArray(result.providers)
        || !result.providers.includes('xunlei') || !result.providers.includes('baidu')) throw fail('TOOL_RESPONSE_INVALID');
  }
  async function stopAllCaptures() {
    const all = await temporaryStorage().get(null);
    const tabs = new Set([...Object.keys(all).filter(name => name.startsWith(PREFIX)).map(name => Number(name.slice(PREFIX.length))),
      ...operations.keys(), ...capturing.keys()]);
    await Promise.allSettled([...tabs].map(tabId => stop(tabId, { remove: true })));
  }
  async function connectPairing(pairingUrl) {
    temporaryStorage();
    let pair; try { pair = Core.parsePairingUrl(pairingUrl); } catch { throw fail('PAIRING_INVALID'); }
    await confirmPair(pair);
    const previous = await pairing();
    if (previous && (previous.origin !== pair.origin || previous.token !== pair.token)) await stopAllCaptures();
    await temporaryStorage().set({ pairing: pair }); return { ok: true };
  }
  async function currentTab(tabId) {
    if (!safeTabId(tabId)) throw fail('PAGE_UNSUPPORTED');
    let tab; try { tab = await chromeApi.tabs.get(tabId); } catch { throw fail('PAGE_CHANGED'); }
    const provider = Core.providerForPage(tab.url);
    if (!provider) throw fail('PAGE_UNSUPPORTED');
    return { provider, pageUrl: Core.publicPageUrl(tab.url) };
  }
  async function start(tabId) {
    await stop(tabId);
    const ticket = { controller: new AbortController(), id: uuid() }; operations.set(tabId, ticket);
    const stillCurrent = () => { if (operations.get(tabId) !== ticket || ticket.controller.signal.aborted) throw fail('CANCELLED'); };
    try {
      const pair = await pairing(); if (!pair) throw fail('PAIRING_MISSING');
      const tab = await currentTab(tabId); stillCurrent();
      capturing.set(tabId, { sessionId: ticket.id, controller: new AbortController() });
      await saveSession(tabId, { ...tab, sessionId: ticket.id, active: true, phase: 'starting', sentCount: 0,
        files: [], adapterAvailable: false, detail: null, message: '正在连接原工具并准备当前网页。' });
      await confirmPair(pair, ticket.controller.signal); stillCurrent();
      await chromeApi.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', files: ['bridge.js'] }); stillCurrent();
      await chromeApi.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'MAIN', files: ['capture-core.js', 'capture-main.js'] }); stillCurrent();
      const ready = await chromeApi.tabs.sendMessage(tabId, { type: 'capture:start', sessionId: ticket.id }, { frameId: 0 }); stillCurrent();
      if (ready?.ok !== true) throw fail('CAPTURE_UNAVAILABLE');
      stillCurrent();
      await mutateSession(tabId, latest => latest?.sessionId === ticket.id
        ? { ...latest, phase: 'watching', message: '正在识别。迅雷网页可在下方选择影片读取入口；百度网页请进行正常文件操作。' } : undefined);
      return { ok: true };
    } catch (error) {
      if (operations.get(tabId) === ticket) {
        capturing.get(tabId)?.controller.abort(); capturing.delete(tabId);
        await mutateSession(tabId, latest => latest?.sessionId === ticket.id
          ? { ...latest, active: false, phase: 'error', message: MESSAGES[error.code] || MESSAGES.CAPTURE_UNAVAILABLE } : undefined);
        try { await chromeApi.tabs.sendMessage(tabId, { type: 'capture:stop' }, { frameId: 0 }); } catch {}
      }
      throw error;
    } finally { if (operations.get(tabId) === ticket) operations.delete(tabId); }
  }
  async function sendCandidates(message, sender) {
    const tabId = sender.tab?.id;
    if (!safeTabId(tabId) || sender.frameId !== 0 || sender.id !== chromeApi.runtime.id) throw fail('REQUEST_INVALID');
    const saved = await session(tabId);
    if (!saved?.active || message.sessionId !== saved.sessionId) return { ok: true, accepted: 0 };
    const tab = await currentTab(tabId);
    if (tab.provider !== saved.provider || tab.pageUrl !== saved.pageUrl || Core.publicPageUrl(sender.url) !== tab.pageUrl)
      throw fail('PAGE_CHANGED');
    const pair = await pairing(); if (!pair) throw fail('PAIRING_MISSING');
    const fresh = await session(tabId);
    if (!fresh?.active || fresh.sessionId !== saved.sessionId) return { ok: true, accepted: 0 };
    let activeCapture = capturing.get(tabId);
    if (!activeCapture || activeCapture.sessionId !== saved.sessionId) {
      activeCapture?.controller.abort();
      activeCapture = { sessionId: saved.sessionId, controller: new AbortController() }; capturing.set(tabId, activeCapture);
    }
    const payload = Core.candidatePayload({ pageUrl: tab.pageUrl, candidates: message.candidates, userAgent });
    const known = dedup.get(tabId)?.sessionId === saved.sessionId ? dedup.get(tabId).urls : new Set();
    dedup.set(tabId, { sessionId: saved.sessionId, urls: known });
    payload.candidates = payload.candidates.filter(candidate => !known.has(candidate.url)).slice(0, Math.max(0, 100 - known.size));
    if (!payload.candidates.length) return { ok: true, accepted: 0 };
    const result = await post(pair, '/api/browser-helper/candidates', payload, activeCapture.controller.signal);
    if (result?.ok !== true || !Number.isSafeInteger(result.accepted) || result.accepted < 0 || result.accepted > payload.candidates.length)
      throw fail('TOOL_RESPONSE_INVALID');
    for (const candidate of payload.candidates) known.add(candidate.url);
    await mutateSession(tabId, latest => latest?.active && latest.sessionId === saved.sessionId ? { ...latest, phase: 'watching',
      sentCount: latest.sentCount + result.accepted,
      message: `已向原工具发送 ${latest.sentCount + result.accepted} 个文件入口候选，请回到片段取材检查。` } : undefined);
    return { ok: true, accepted: result.accepted };
  }
  async function receive(message, sender) {
    if (message?.type === 'helper:pair-page') {
      if (sender.id !== chromeApi.runtime.id || sender.frameId !== 0 || !safeTabId(sender.tab?.id)
          || message.pairingUrl !== sender.url || message.pairingUrl !== sender.tab.url) throw fail('REQUEST_INVALID');
      try { Core.parsePairingUrl(message.pairingUrl); } catch { throw fail('PAIRING_INVALID'); }
      const actualTab = await chromeApi.tabs.get(sender.tab.id);
      if (actualTab.url !== message.pairingUrl) throw fail('PAGE_CHANGED');
      return connectPairing(message.pairingUrl);
    }
    if (['capture:files', 'capture:detail-result'].includes(message?.type)) {
      const tabId = sender.tab?.id;
      if (!safeTabId(tabId) || sender.frameId !== 0 || sender.id !== chromeApi.runtime.id) throw fail('REQUEST_INVALID');
      const saved = await session(tabId);
      if (!saved?.active || saved.sessionId !== message.sessionId || saved.provider !== 'xunlei') return { ok: true };
      const tab = await currentTab(tabId);
      if (tab.provider !== 'xunlei' || tab.pageUrl !== saved.pageUrl || Core.publicPageUrl(sender.url) !== tab.pageUrl) throw fail('PAGE_CHANGED');
      if (message.type === 'capture:files') {
        if (!Array.isArray(message.files)) throw fail('REQUEST_INVALID');
        const ids = new Set(), files = [];
        for (const file of message.files.slice(0,50)) {
          if (typeof file?.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(file.id) || ids.has(file.id)
              || typeof file.name !== 'string' || !file.name.trim() || file.name.length > 512 || /[\u0000-\u001f\u007f-\u009f]/.test(file.name)
              || !Number.isSafeInteger(file.size) || file.size < 1) continue;
          ids.add(file.id); files.push({ id: file.id, name: file.name, size: file.size });
        }
        await mutateSession(tabId, latest => latest?.active && latest.sessionId === saved.sessionId
          ? { ...latest, files, adapterAvailable: message.available === true } : undefined);
      } else {
        if (!Object.hasOwn(DETAIL_MESSAGES, message.code)) throw fail('REQUEST_INVALID');
        await mutateSession(tabId, latest => latest?.active && latest.sessionId === saved.sessionId
          && latest.detail?.operationId === message.operationId && latest.detail.fileId === message.fileId
          ? { ...latest, detail: { ...latest.detail, status: message.code === 'DETAIL_READY' ? 'ready' : 'error',
            code: message.code, message: DETAIL_MESSAGES[message.code] } } : undefined);
      }
      return { ok: true };
    }
    if (message?.type === 'capture:candidates') {
      const tabId = sender.tab?.id;
      const previous = sending.get(tabId) || Promise.resolve();
      const next = previous.catch(() => {}).then(() => sendCandidates(message, sender)); sending.set(tabId, next);
      try { return await next; }
      finally { if (sending.get(tabId) === next) sending.delete(tabId); }
    }
    if (sender.id !== chromeApi.runtime.id || sender.tab || sender.url !== chromeApi.runtime.getURL('popup.html')) throw fail('REQUEST_INVALID');
    if (message?.type === 'helper:pair') {
      return connectPairing(message.pairingUrl);
    }
    if (message?.type === 'helper:reset') {
      await temporaryStorage().remove('pairing');
      await stopAllCaptures(); return { ok: true };
    }
    if (message?.type === 'helper:start') return start(message.tabId);
    if (message?.type === 'helper:stop') return stop(message.tabId);
    if (message?.type === 'helper:files' || message?.type === 'helper:detail') {
      const tabId = message.tabId, saved = await session(tabId), tab = await currentTab(tabId);
      if (!saved?.active || saved.provider !== 'xunlei' || tab.provider !== 'xunlei' || saved.pageUrl !== tab.pageUrl) throw fail('DETAIL_UNAVAILABLE');
      if (message.type === 'helper:files') {
        await chromeApi.tabs.sendMessage(tabId, { type: 'capture:list', sessionId: saved.sessionId }, { frameId: 0 }); return { ok: true };
      }
      if (!saved.adapterAvailable) throw fail('DETAIL_UNAVAILABLE');
      if (saved.detail?.status === 'running' && Date.now() - saved.detail.startedAt < 25000) throw fail('DETAIL_BUSY');
      const file = saved.files.find(item => item.id === message.fileId); if (!file) throw fail('DETAIL_UNAVAILABLE');
      const operationId = uuid();
      const accepted = await mutateSession(tabId, latest => {
        if (!latest?.active || latest.sessionId !== saved.sessionId) return undefined;
        if (latest.detail?.status === 'running' && Date.now() - latest.detail.startedAt < 25000) throw fail('DETAIL_BUSY');
        if (!Core.sameXunleiFile(latest.files.find(item => item.id === file.id), file)) throw fail('DETAIL_UNAVAILABLE');
        return { ...latest, detail: { operationId, fileId: file.id, startedAt: Date.now(), status: 'running',
          message: '正在通过迅雷官方页面读取所选影片入口。' } };
      });
      if (!accepted) throw fail('CANCELLED');
      try {
        const ready = await chromeApi.tabs.sendMessage(tabId, { type: 'capture:detail', sessionId: saved.sessionId,
          operationId, file }, { frameId: 0 });
        if (ready?.ok !== true) throw fail('CAPTURE_UNAVAILABLE');
      } catch {
        await mutateSession(tabId, latest => latest?.detail?.operationId === operationId
          ? { ...latest, detail: { ...latest.detail, status: 'error', code: 'DETAIL_REQUEST_FAILED', message: DETAIL_MESSAGES.DETAIL_REQUEST_FAILED } } : undefined);
        throw fail('CAPTURE_UNAVAILABLE');
      }
      return { ok: true };
    }
    if (message?.type === 'helper:state') {
      const pair = await pairing();
      let tab = null; try { tab = await currentTab(message.tabId); } catch {}
      let captured = safeTabId(message.tabId) ? await session(message.tabId) : null;
      if (captured?.detail?.status === 'running' && Date.now() - captured.detail.startedAt > 25000) {
        await mutateSession(message.tabId, latest => latest?.detail?.operationId === captured.detail.operationId
          ? { ...latest, detail: { ...latest.detail, status: 'error', code: 'DETAIL_TIMEOUT', message: DETAIL_MESSAGES.DETAIL_TIMEOUT } } : undefined);
        captured = await session(message.tabId);
      }
      return { ok: true, paired: Boolean(pair), toolOrigin: pair?.origin, supported: Boolean(tab), provider: tab?.provider,
        capture: captured && { active: captured.active, phase: captured.phase, sentCount: captured.sentCount, message: captured.message,
          adapterAvailable: captured.adapterAvailable, files: captured.files || [],
          detail: captured.detail && { status: captured.detail.status, code: captured.detail.code, message: captured.detail.message } } };
    }
    throw fail('REQUEST_INVALID');
  }
  return Object.freeze({
    async handle(message, sender) {
      try { return await receive(message, sender); }
      catch (error) {
        const code = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'CAPTURE_UNAVAILABLE';
        if (message?.type === 'capture:candidates' && safeTabId(sender.tab?.id)) {
          const previous = await session(sender.tab.id);
          if (previous?.active && previous.sessionId === message.sessionId) await mutateSession(sender.tab.id,
            latest => latest?.active && latest.sessionId === message.sessionId ? { ...latest, phase: 'error', message: MESSAGES[code] } : undefined);
        }
        return { ok: false, code, message: MESSAGES[code] };
      }
    },
    removed(tabId) { return stop(tabId, { remove: true }); },
  });
}
