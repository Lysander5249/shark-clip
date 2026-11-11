/* Isolated-world bridge: only the active tab/session can send candidate data. */
(() => {
  if (globalThis.__clipFetcherBridgeV1) return;
  globalThis.__clipFetcherBridgeV1 = true;
  let sessionId = '';
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'capture:start' && typeof message.sessionId === 'string' && /^[a-f0-9-]{20,80}$/.test(message.sessionId)) {
      sessionId = message.sessionId;
      window.postMessage({ source: 'clip-fetcher:command:v1', command: 'start', sessionId }, location.origin);
      respond({ ok: true });
    } else if (message?.type === 'capture:stop') {
      window.postMessage({ source: 'clip-fetcher:command:v1', command: 'stop', sessionId }, location.origin);
      sessionId = ''; respond({ ok: true });
    } else if (sessionId && message?.sessionId === sessionId && message.type === 'capture:list') {
      window.postMessage({ source: 'clip-fetcher:command:v1', command: 'list', sessionId }, location.origin);
      respond({ ok: true });
    } else if (sessionId && message?.sessionId === sessionId && message.type === 'capture:detail') {
      const file = message.file;
      if (typeof message.operationId !== 'string' || !/^[a-f0-9-]{20,80}$/.test(message.operationId)
          || typeof file?.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(file.id)
          || typeof file.name !== 'string' || file.name.length > 512 || !Number.isSafeInteger(file.size) || file.size < 1) {
        respond({ ok: false }); return;
      }
      window.postMessage({ source: 'clip-fetcher:command:v1', command: 'detail', sessionId,
        operationId: message.operationId, file: { id: file.id, name: file.name, size: file.size } }, location.origin);
      respond({ ok: true });
    }
  });
  window.addEventListener('message', event => {
    const data = event.data;
    if (!sessionId || event.source !== window || event.origin !== location.origin || data?.sessionId !== sessionId) return;
    if (data.source === 'clip-fetcher:files:v1' && Array.isArray(data.files)) {
      const files = data.files.slice(0, 50).filter(file => file && typeof file === 'object').map(file => ({
        id: typeof file.id === 'string' ? file.id.slice(0, 257) : '',
        name: typeof file.name === 'string' ? file.name.slice(0, 513) : '',
        size: Number.isSafeInteger(file.size) ? file.size : null,
      }));
      chrome.runtime.sendMessage({ type: 'capture:files', sessionId, available: data.available === true, files }).catch(() => {}); return;
    }
    if (data.source === 'clip-fetcher:detail-result:v1') {
      chrome.runtime.sendMessage({ type: 'capture:detail-result', sessionId,
        operationId: typeof data.operationId === 'string' ? data.operationId.slice(0, 81) : '',
        fileId: typeof data.fileId === 'string' ? data.fileId.slice(0, 257) : '',
        code: typeof data.code === 'string' ? data.code.slice(0, 60) : '',
      }).catch(() => {}); return;
    }
    if (data.source !== 'clip-fetcher:candidates:v1' || !Array.isArray(data.candidates)) return;
    const candidates = data.candidates.slice(0, 12).map(value => value && typeof value === 'object' ? {
      url: typeof value.url === 'string' ? value.url.slice(0, 8193) : null,
      name: typeof value.name === 'string' ? value.name.slice(0, 257) : undefined,
      size: Number.isSafeInteger(value.size) ? value.size : undefined,
    } : null).filter(Boolean);
    chrome.runtime.sendMessage({ type: 'capture:candidates', sessionId, candidates }).catch(() => {});
  });
})();
