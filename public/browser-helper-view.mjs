const PROVIDERS = Object.freeze({ xunlei: '迅雷', baidu: '百度网盘' });

export function browserHelperState(payload, origin) {
  let url = '';
  try {
    const value = new URL(payload?.url);
    if (value.origin === origin && value.pathname === '/browser-pair' && !value.search
        && /^#[a-f0-9]{64}$/.test(value.hash) && !value.username && !value.password) url = value.href;
  } catch { /* Keep pairing credentials out of arbitrary navigation. */ }
  const candidates = [];
  const seen = new Set();
  for (const item of Array.isArray(payload?.candidates) ? payload.candidates.slice(0, 50) : []) {
    if (!item || !/^[a-f0-9]{32}$/.test(item.id) || seen.has(item.id) || !Object.hasOwn(PROVIDERS, item.provider)
        || typeof item.sourceHost !== 'string' || item.sourceHost.length > 253
        || !/^[a-z0-9.:[\]-]+$/i.test(item.sourceHost)) continue;
    seen.add(item.id);
    const name = typeof item.name === 'string' && !/(?:https?:\/\/|blob:|data:)/i.test(item.name)
      ? item.name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 256) : '';
    candidates.push({ id: item.id, provider: item.provider, name: name || '浏览器捕获的媒体', sourceHost: item.sourceHost,
      ...(Number.isSafeInteger(item.size) && item.size > 0 ? { size: item.size } : {}),
      receivedAt: Number.isFinite(item.receivedAt) && item.receivedAt >= 0 ? item.receivedAt : 0,
      hasContext: item.hasContext === true });
  }
  return { url, candidates };
}

export function renderBrowserCandidates(container, candidates, { selectedId = '', disabled = false, onSelect, document = globalThis.document } = {}) {
  container.replaceChildren();
  for (const candidate of candidates) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'browser-candidate';
    button.dataset.browserCandidate = candidate.id;
    button.disabled = disabled;
    button.setAttribute('aria-pressed', String(candidate.id === selectedId));
    const name = document.createElement('strong'); name.textContent = candidate.name;
    const detail = document.createElement('small');
    detail.textContent = `${PROVIDERS[candidate.provider] || '网盘'} · ${candidate.sourceHost}`;
    button.append(name, detail);
    button.addEventListener('click', () => { if (!button.disabled) onSelect?.(candidate); });
    container.append(button);
  }
}

export function browserDownloadMethod(probe, requested) {
  return probe?.directStreamAvailable === true && requested === 'direct-stream' ? 'direct-stream' : 'indexed';
}

export function extractionUiPolicy({ busy = false, submitting = false, queued = false, transferChecking = false,
  probing = false, picking = false, resumeAction = false, setupChecking = false,
  connected = false, dependenciesReady = false, checkedSource = false } = {}) {
  const formLocked = Boolean(submitting || transferChecking || probing || picking || resumeAction || setupChecking);
  return { formLocked, sourceLocked: Boolean(formLocked || busy || queued), queueing: Boolean(busy || queued),
    canSubmit: Boolean(!formLocked && connected && dependenciesReady && checkedSource) };
}

export function downloadMethodLabel(value) {
  return value === 'direct-stream' ? '流式直连（新测试）' : value === 'indexed' ? '索引取片' : '';
}
