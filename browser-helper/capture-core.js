/* Shared, credential-free validation; loaded as a classic MAIN-world script and
 * imported by the extension worker. No account request or browser storage read. */
(() => {
  const MAX_URL = 8192, MAX_CANDIDATES = 12, MAX_NODES = 600;
  const ORIGINAL_KEYS = new Set(['web_content_link', 'dlink', 'download_url', 'download_link', 'file_url',
    'file_download_url', 'original_url', 'origin_url']);
  const FILE_EXTENSION = /\.(?:mkv|mp4|m4v|mov|avi|webm|m2ts)$/i;
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const cleanText = value => typeof value === 'string'
    ? value.slice(0, 1024).replace(/[\u0000-\u001f\u007f-\u009f]/g, '').slice(0, 256) : '';
  function providerForPage(value) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
      return { 'pan.xunlei.com': 'xunlei', 'pan.baidu.com': 'baidu' }[url.hostname] || null;
    } catch { return null; }
  }
  function publicPageUrl(value) {
    if (typeof value !== 'string' || value.length > 4096 || !providerForPage(value)) return null;
    const url = new URL(value); url.search = ''; url.hash = ''; return url.href;
  }
  function originalUrl(value) {
    if (typeof value !== 'string' || !value || value.length > MAX_URL || /[\u0000-\u0020\u007f-\u009f\\]/.test(value)) return null;
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443') return null;
      if (['localhost', 'api-pan.xunlei.com', 'pan.baidu.com', 'pan.xunlei.com'].includes(url.hostname)
          || /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname) || url.hostname.includes(':')) return null;
      if (/\.(?:m3u8|mpd|m4s)(?:$|\/)/i.test(url.pathname) || /(?:^|\/)streaming(?:\/|$)/i.test(url.pathname)
          || /^m3u8/i.test(url.searchParams.get('type') || '') || url.searchParams.get('method') === 'streaming') return null;
      return url.href;
    } catch { return null; }
  }
  function safeSize(value) {
    if (typeof value === 'string' && /^(?:0|[1-9]\d{0,15})$/.test(value)) value = Number(value);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  function xunleiFile(value) {
    if (!record(value) || value.kind !== 'drive#file' || value.space !== undefined && value.space !== '') return null;
    if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(value.id)
        || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 512
        || /[\u0000-\u001f\u007f-\u009f]/.test(value.name)) return null;
    const size = safeSize(value.size);
    if (!size || !(typeof value.mime_type === 'string' && /^video\//i.test(value.mime_type)
        || /\.(?:mkv|mp4|m4v|mov|avi|webm|m2ts|ts)$/i.test(value.name))) return null;
    return { id: value.id, name: value.name, size };
  }
  const sameXunleiFile = (a, b) => Boolean(a && b && a.id === b.id && a.name === b.name && a.size === b.size);
  function fileHints(node, inherited = {}) {
    if (!record(node)) return inherited;
    const name = cleanText(node.name ?? node.file_name ?? node.server_filename ?? inherited.name);
    const size = safeSize(node.size ?? node.file_size ?? inherited.size);
    return { ...(name ? { name } : {}), ...(size !== null ? { size } : {}) };
  }
  function sanitizeCandidate(value) {
    if (!record(value)) return null;
    const url = originalUrl(value.url); if (!url) return null;
    return { url, ...fileHints(value) };
  }
  function metadataCandidates(payload) {
    const results = [], seen = new Set(); let visited = 0;
    function add(value, hints) {
      const url = originalUrl(typeof value === 'string' ? value : record(value) ? value.url : null);
      if (!url || seen.has(url) || results.length >= MAX_CANDIDATES) return;
      seen.add(url); results.push({ url, ...hints });
    }
    function walk(value, depth, inherited) {
      if (++visited > MAX_NODES || depth > 8 || results.length >= MAX_CANDIDATES) return;
      if (Array.isArray(value)) { for (const item of value.slice(0, 100)) walk(item, depth + 1, inherited); return; }
      if (!record(value)) return;
      const hints = fileHints(value, inherited);
      for (const [key, child] of Object.entries(value).slice(0, 100)) {
        if (ORIGINAL_KEYS.has(key.toLowerCase())) add(child, hints);
        // Deliberately do not interpret play_url, arbitrary message strings,
        // cookies, Authorization, or a generic JSON "url" as an original file.
        if (typeof child === 'object' && child !== null) walk(child, depth + 1, hints);
      }
    }
    walk(payload, 0, {}); return results;
  }
  function resourceCandidate(value, name) {
    const url = originalUrl(value); if (!url || !FILE_EXTENSION.test(new URL(url).pathname)) return null;
    let fallback = '';
    try { fallback = decodeURIComponent(new URL(url).pathname.split('/').at(-1)); } catch {}
    return { url, ...(cleanText(name || fallback) ? { name: cleanText(name || fallback) } : {}) };
  }
  function parsePairingUrl(value) {
    if (typeof value !== 'string' || value.length > 256) throw new Error('PAIRING_INVALID');
    let url; try { url = new URL(value.trim()); } catch { throw new Error('PAIRING_INVALID'); }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
        || url.pathname !== '/browser-pair' || url.search || !/^#[a-f0-9]{64}$/.test(url.hash)) throw new Error('PAIRING_INVALID');
    const port = Number(url.port); if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('PAIRING_INVALID');
    return { origin: url.origin, token: url.hash.slice(1) };
  }
  function checkedPairing(value) {
    if (!record(value) || typeof value.origin !== 'string' || typeof value.token !== 'string') throw new Error('PAIRING_INVALID');
    const parsed = parsePairingUrl(`${value.origin}/browser-pair#${value.token}`);
    if (parsed.origin !== value.origin) throw new Error('PAIRING_INVALID'); return parsed;
  }
  function candidatePayload({ pageUrl, candidates, userAgent = '' }) {
    const provider = providerForPage(pageUrl), page = publicPageUrl(pageUrl);
    if (!provider || !page || !Array.isArray(candidates)) throw new Error('PAGE_UNSUPPORTED');
    const seen = new Set(), accepted = [];
    const ua = typeof userAgent === 'string' && /^[\x20-\x7e]{1,512}$/.test(userAgent) ? userAgent : '';
    for (const candidate of candidates.slice(0, MAX_CANDIDATES)) {
      const clean = sanitizeCandidate(candidate); if (!clean || seen.has(clean.url)) continue;
      seen.add(clean.url);
      accepted.push({ ...clean, headers: { ...(ua ? { 'User-Agent': ua } : {}), Referer: page } });
    }
    const result = { schemaVersion: 1, provider, pageUrl: page, candidates: accepted };
    // The receiver also enforces its own limit. Keep each sender batch below it.
    while (new TextEncoder().encode(JSON.stringify(result)).byteLength > 60000 && result.candidates.length) result.candidates.pop();
    return result;
  }
  globalThis.ClipFetcherCaptureCore = Object.freeze({ MAX_CANDIDATES, providerForPage, publicPageUrl, originalUrl,
    safeSize, xunleiFile, sameXunleiFile, sanitizeCandidate, metadataCandidates, resourceCandidate, parsePairingUrl, checkedPairing, candidatePayload });
})();
