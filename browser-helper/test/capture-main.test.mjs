import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const coreCode = fs.readFileSync(new URL('../capture-core.js', import.meta.url), 'utf8');
const mainCode = fs.readFileSync(new URL('../capture-main.js', import.meta.url), 'utf8');
const SESSION = '11111111-2222-4333-a444-555555555555';
const OTHER = '66666666-7777-4888-a999-000000000000';
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
function harness({ fetchImpl = async () => Response.json({}), href = 'https://pan.xunlei.com/', resources = [] } = {}) {
  const listeners = new Map(), documentEvents = new Map(), timers = new Map(), sent = [], allMessages = [];
  let timerId = 0, fetchCalls = 0, cookieReads = 0;
  const location = { href, origin: new URL(href).origin };
  const window = { fetch: async (...args) => { fetchCalls++; return fetchImpl(...args); }, open() { return 'ordinary-window'; },
    addEventListener(type, callback) { const current = listeners.get(type) || []; current.push(callback); listeners.set(type,current); },
    postMessage(data, origin) {
      allMessages.push(data);
      if (data.source === 'clip-fetcher:candidates:v1') sent.push(data);
      for (const callback of listeners.get('message') || []) callback({ data, source: window, origin });
    },
  };
  const document = { addEventListener(type, callback) { documentEvents.set(type,callback); },
    removeEventListener(type, callback) { if (documentEvents.get(type) === callback) documentEvents.delete(type); },
    querySelectorAll() { return []; }, get cookie() { cookieReads++; throw new Error('MUST_NOT_READ_COOKIE'); } };
  class XHR { open() { return 'ordinary-open'; } send() { return 'ordinary-send'; } addEventListener() {} }
  class PerformanceObserver { constructor(callback) { this.callback = callback; } observe() {} disconnect() {} }
  const context = { window, document, location, XMLHttpRequest: XHR, PerformanceObserver, URL, TextDecoder, TextEncoder,
    Uint8Array, performance: { getEntriesByType: () => resources },
    setTimeout(callback, delay) { const id = ++timerId; timers.set(id,{callback,delay}); return id; }, clearTimeout(id) { timers.delete(id); } };
  vm.createContext(context); vm.runInContext(coreCode,context); vm.runInContext(mainCode,context);
  const originalFetch = window.fetch, originalOpen = window.open;
  const command = (command, sessionId = SESSION, extra = {}) => window.postMessage({ source: 'clip-fetcher:command:v1', command, sessionId, ...extra }, location.origin);
  async function settle() {
    // Let real ReadableStream clone/tee tasks settle, then run only the observer's
    // bounded coalescing timer. No fixture HTTP request or account access occurs.
    for (let n = 0; n < 5; n++) await new Promise(resolve => setImmediate(resolve));
    for (const [id, item] of [...timers]) { if (item.delay >= 20000) continue; timers.delete(id); item.callback(); }
  }
  const expireDetails = () => { for (const [id,item] of [...timers]) if (item.delay >= 20000) { timers.delete(id); item.callback(); } };
  return { window, document, context, sent, allMessages, command, settle, expireDetails, originalFetch, originalOpen,
    counters: () => ({ fetchCalls, cookieReads }) };
}

test('starting observation does not fetch an account endpoint, read cookies or open a player', async () => {
  const h = harness(); h.command('start'); await h.settle();
  assert.deepEqual(h.counters(), { fetchCalls: 0, cookieReads: 0 }); assert.equal(h.sent.length, 0);
  assert.notEqual(h.window.fetch, h.originalFetch);
  h.command('stop'); assert.equal(h.window.fetch, h.originalFetch); assert.equal(h.window.open, h.originalOpen);
});

test('ordinary metadata fetch is returned unchanged while only fresh original fields are handed off', async () => {
  const payload = { name: 'movie.mkv', size: 4096, web_content_link: 'https://cdn.test/movie.mkv?sign=EXAMPLE',
    play_url: 'https://cdn.test/preview.mp4', cookie: 'PRIVATE_COOKIE' };
  const response = Response.json(payload), h = harness({ fetchImpl: async () => response }); h.command('start');
  const result = await h.window.fetch('/ordinary-metadata'); assert.equal(result, response);
  assert.deepEqual(await result.json(), payload); await h.settle();
  assert.equal(h.sent.length, 1); assert.equal(h.sent[0].sessionId, SESSION);
  assert.equal(h.sent[0].candidates[0].url, payload.web_content_link);
  assert.doesNotMatch(JSON.stringify(h.sent), /PRIVATE_COOKIE|preview/);
});

test('late response from an old observation cannot enter a restarted session', async () => {
  const result = deferred(), h = harness({ fetchImpl: () => result.promise }); h.command('start');
  const reading = h.window.fetch('/ordinary-metadata'); h.command('stop'); h.command('start', OTHER);
  result.resolve(Response.json({ web_content_link: 'https://cdn.test/old.mkv' }));
  await reading; await h.settle(); assert.equal(h.sent.length, 0);
});

test('oversized JSON and non-JSON media responses are never consumed as metadata', async () => {
  const huge = JSON.stringify({ web_content_link: 'https://cdn.test/oversize.mkv', padding: 'a'.repeat(2*1024*1024) });
  const h = harness({ fetchImpl: async () => new Response(huge, { headers: { 'Content-Type': 'application/json', 'Content-Length': String(huge.length) } }) });
  h.command('start'); const result = await h.window.fetch('/large-metadata'); await result.body.cancel(); await h.settle();
  assert.equal(h.sent.length, 0);
});

test('visible resource fallback remains restricted and stop discards a pending handoff', async () => {
  const h = harness({ resources: [{ name: 'https://cdn.test/whole.mkv' }, { name: 'https://cdn.test/preview.m3u8' },
    { name: 'https://cdn.test/chunk.ts' }, { name: 'https://cdn.test/app.js' }] });
  h.command('start'); await h.settle(); assert.equal(h.sent.length,1);
  assert.equal(h.sent[0].candidates.length,1); assert.equal(h.sent[0].candidates[0].name,'whole.mkv');
  const second = harness({ resources: [{ name: 'https://cdn.test/whole.mkv' }] });
  second.command('start'); second.command('stop'); await second.settle(); assert.equal(second.sent.length,0);
});

test('observers stay inert on unrelated sites and restoration preserves a later website wrapper', async () => {
  const unsupported = harness({ href: 'https://unrelated.example/' }); unsupported.command('start');
  assert.equal(unsupported.window.fetch, unsupported.originalFetch);
  const h = harness(); h.command('start'); const ours = h.window.fetch;
  const laterWebsiteWrapper = (...args) => ours(...args); h.window.fetch = laterWebsiteWrapper;
  h.command('stop'); assert.equal(h.window.fetch, laterWebsiteWrapper);
  h.command('start', OTHER); await h.window.fetch('/ordinary-metadata'); await h.settle();
  assert.equal(h.counters().fetchCalls,1);
});

const selected = { id: 'file_A', name: 'movie.mkv', size: 4096 };
const rawFile = changes => ({ ...selected, kind: 'drive#file', space: '', mime_type: 'video/x-matroska', ...changes });
const OP = 'aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee';
function withNuxt(h, dispatch) {
  const file = rawFile();
  Object.defineProperty(file, 'web_content_link', { get() { throw new Error('MUST_NOT_READ_OLD_STORE_URL'); } });
  const safebox = { isIn: false };
  Object.defineProperty(safebox,'token',{ get() { throw new Error('MUST_NOT_READ_TOKEN'); } });
  const store = { state: { drive: { all: { file_A: file } }, safebox }, dispatch };
  h.window.$nuxt = { $store: store }; return store;
}
function detailCode(h) { return h.allMessages.filter(item => item.source === 'clip-fetcher:detail-result:v1').at(-1)?.code; }

test('explicit Xunlei selection uses only official DISPLAY dispatch and a fresh matching response', async () => {
  const h = harness({ fetchImpl: async () => Response.json(rawFile({ web_content_link: 'https://cdn.test/FRESH.mkv' })) });
  const calls = [];
  withNuxt(h, async (action, options) => {
    calls.push({ action, options });
    await (await h.window.fetch(`https://api-pan.xunlei.com/drive/v1/files/${options.id}?space=&usage=${options.usage}`, { method: 'get' })).json();
    return 'success';
  });
  h.command('start'); assert.equal(h.counters().fetchCalls,0);
  const files = h.allMessages.find(item => item.source === 'clip-fetcher:files:v1');
  assert.equal(files.available,true); assert.equal(files.files[0].name,'movie.mkv');
  assert.doesNotMatch(JSON.stringify(files), /web_content_link|token|MUST_NOT_READ/);
  h.command('detail',SESSION,{ operationId:OP,file:selected }); await h.settle();
  assert.equal(calls.length,1); assert.equal(calls[0].action,'drive/getFileInfo');
  assert.equal(calls[0].options.id,'file_A'); assert.equal(calls[0].options.usage,'DISPLAY');
  assert.equal(h.sent.length,1); assert.equal(h.sent[0].candidates[0].url,'https://cdn.test/FRESH.mkv');
  assert.equal(detailCode(h),'DETAIL_READY');
});

test('missing fresh original entry cannot inherit a store URL or a success return value', async () => {
  const h = harness({ fetchImpl: async () => Response.json(rawFile()) });
  withNuxt(h, async () => { await (await h.window.fetch('https://api-pan.xunlei.com/drive/v1/files/file_A?space=&usage=DISPLAY')).json(); return 'success'; });
  h.command('start'); h.command('detail',SESSION,{ operationId:OP,file:selected }); await h.settle();
  assert.equal(h.sent.length,0); assert.equal(detailCode(h),'DETAIL_ORIGINAL_UNAVAILABLE');
});

test('a pre-existing request finishing during a detail action is not its authoritative response', async () => {
  const old = deferred(), dispatch = deferred(), h = harness({ fetchImpl: () => old.promise });
  withNuxt(h, () => dispatch.promise); h.command('start');
  const oldFetch = h.window.fetch('https://api-pan.xunlei.com/drive/v1/files/file_A?space=&usage=DISPLAY');
  h.command('detail',SESSION,{ operationId:OP,file:selected });
  old.resolve(Response.json(rawFile({ web_content_link:'https://cdn.test/PREEXISTING.mkv' })));
  await (await oldFetch).json(); dispatch.resolve('success'); await h.settle();
  // Passive capture may observe the user's earlier ordinary request, but that
  // entry must never make the explicit action report a fresh detail success.
  assert.equal(detailCode(h),'DETAIL_ORIGINAL_UNAVAILABLE');
});

test('a changed file identity before or during dispatch never leaks its result through passive fallback', async () => {
  for (const beforeRequest of [false,true]) {
    const response = deferred(), h = harness({ fetchImpl: () => response.promise }); let store;
    store = withNuxt(h, async () => {
      if (beforeRequest) store.state.drive.all.file_A = rawFile({ size:8192 });
      await (await h.window.fetch('https://api-pan.xunlei.com/drive/v1/files/file_A?space=&usage=DISPLAY')).json(); return 'success';
    });
    h.command('start'); h.command('detail',SESSION,{ operationId:OP,file:selected });
    store.state.drive.all.file_A = rawFile({ size:8192 });
    response.resolve(Response.json(rawFile({ web_content_link:'https://cdn.test/CHANGED.mkv' })));
    await h.settle(); assert.equal(h.sent.length,0); assert.equal(detailCode(h),'DETAIL_CHANGED');
  }
});

test('wrong-id fresh responses and official request failures produce fixed errors without fallback', async () => {
  const h = harness({ fetchImpl: async () => Response.json(rawFile({ id:'file_B',web_content_link:'https://cdn.test/WRONG.mkv' })) });
  withNuxt(h,async()=>{ await (await h.window.fetch('https://api-pan.xunlei.com/drive/v1/files/file_A?space=&usage=DISPLAY')).json(); return 'success'; });
  h.command('start'); h.command('detail',SESSION,{ operationId:OP,file:selected }); await h.settle();
  assert.equal(h.sent.length,0); assert.equal(detailCode(h),'DETAIL_CHANGED');
  const rejected = harness(); withNuxt(rejected,()=>Promise.reject(new Error('PRIVATE_API_ERROR')));
  rejected.command('start'); rejected.command('detail',SESSION,{ operationId:OP,file:selected }); await rejected.settle();
  assert.equal(detailCode(rejected),'DETAIL_REQUEST_FAILED'); assert.doesNotMatch(JSON.stringify(rejected.allMessages),/PRIVATE_API_ERROR/);
});

test('duplicate commands cannot start two official actions and stopping drops the late response', async () => {
  const response = deferred(), h = harness({ fetchImpl: () => response.promise }); let calls=0;
  withNuxt(h,async()=>{ calls++; await (await h.window.fetch('https://api-pan.xunlei.com/drive/v1/files/file_A?space=&usage=DISPLAY')).json(); return 'success'; });
  h.command('start'); h.command('detail',SESSION,{ operationId:OP,file:selected });
  h.command('detail',SESSION,{ operationId:OTHER,file:selected }); assert.equal(detailCode(h),'DETAIL_BUSY'); assert.equal(calls,1);
  h.command('stop'); h.command('start',OTHER);
  response.resolve(Response.json(rawFile({ web_content_link:'https://cdn.test/LATE.mkv' }))); await h.settle();
  assert.equal(h.sent.length,0); assert.equal(detailCode(h),'DETAIL_CANCELLED');
});

test('timeout releases the detail slot and an old resolution cannot affect the next operation', async () => {
  const waiting = deferred(), h = harness(); let calls=0;
  withNuxt(h,()=>{ calls++; return waiting.promise; });
  h.command('start'); h.command('detail',SESSION,{ operationId:OP,file:selected }); h.expireDetails();
  assert.equal(detailCode(h),'DETAIL_TIMEOUT');
  h.command('detail',SESSION,{ operationId:OTHER,file:selected }); assert.equal(calls,2);
  waiting.resolve('success'); await h.settle(); assert.equal(h.sent.length,0); assert.equal(detailCode(h),'DETAIL_ORIGINAL_UNAVAILABLE');
});

test('protected spaces, absent store and Baidu pages do not receive the Xunlei action', async () => {
  for (const restricted of ['file-space','safebox-state','baidu']) {
    const h = harness({ href: restricted === 'baidu' ? 'https://pan.baidu.com/' : 'https://pan.xunlei.com/' }); let calls=0;
    const store=withNuxt(h,()=>{ calls++; return Promise.resolve('success'); });
    if(restricted==='file-space') store.state.drive.all.file_A=rawFile({space:'safebox'});
    if(restricted==='safebox-state') store.state.safebox.isIn=true;
    h.command('start'); h.command('detail',SESSION,{operationId:OP,file:selected}); await h.settle();
    assert.equal(calls,0); assert.equal(h.sent.length,0);
  }
});
