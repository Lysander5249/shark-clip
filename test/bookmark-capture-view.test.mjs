import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as view from '../public/bookmark-capture-view.mjs';
import * as policy from '../public/browser-helper-view.mjs';
import { resumeView } from '../public/resume-view.mjs';
import { setupPlatformLabel } from '../public/setup-view.mjs';
import * as clipOptions from '../public/clip-options.mjs';

const ORIGIN = 'http://127.0.0.1:4321', TOKEN = 'b'.repeat(64), ID = 'a'.repeat(32), RUN = 'c'.repeat(32);
const candidate = { id: ID, provider: 'xunlei', name: '<img src=x onerror=alert(1)>.mkv',
  sourceHost: 'cdn.example.com', size: 10000, receivedAt: 1000 };
const snapshot = (candidates = [candidate], receiptSequence = 1) => ({ available: true,
  bookmarklet: 'javascript:TEST_ONLY', candidates, receiptSequence, lastReceivedAt: Math.max(0, ...candidates.map(item => item.receivedAt)) });
const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
const installSource = await readFile(new URL('../public/bookmark-install.js', import.meta.url), 'utf8');

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {};
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.textContent = '';
    this.style = {}; this.options = [{}, {}]; this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  }
  set innerHTML(_value) { throw new Error('unsafe HTML interpolation'); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  querySelector() { return this.label ||= new Element('span'); }
  focus() {} scrollIntoView() {} pause() {} load() {}
}

function appHarness() {
  const elements = new Map(), timers = [], probes = [], requests = [];
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const tabs = ['browser', 'dav', 'local', 'http'].map(type => { const tab = $(`tab-${type}`); tab.dataset.sourceType = type; return tab; });
  const sourceFields = ['source-url', 'source-username', 'source-password', 'local-path'].map($);
  const formFields = ['start-time', 'end-time', 'handles', 'output-dir', 'clip-name', 'subtitle-stream', 'audio-stream', 'make-mp4', 'budget', 'read-mode', 'reuse-index', 'download-method'].map($);
  const document = { getElementById: $, createElement: tag => new Element(tag), querySelectorAll(selector) {
    if (selector === '[data-source-type]') return tabs;
    if (selector === '.source-field') return sourceFields;
    if (selector === '.source-field, [data-source-type]') return [...sourceFields, ...tabs];
    if (selector === '#extract-form input, #extract-form select') return formFields;
    if (selector === '[data-browser-candidate]') return $('browser-candidates').children;
    return [];
  } };
  const context = vm.createContext({ ...policy, ...view, ...clipOptions, resumeView, setupPlatformLabel, document, window: { location: { origin: ORIGIN } },
    navigator: {}, setTimeout: (callback, milliseconds) => { timers.push({ callback, milliseconds }); return timers.length; },
    clearTimeout() {}, setInterval() {}, clearInterval() {}, matchMedia: () => ({ matches: true }),
    URL, Option: class {}, estimateReadBudget: () => null, historyStatusLabel: () => '', historyRequestedRange: () => null,
    console, recordProbe: payload => probes.push(payload),
  });
  vm.runInContext(appSource.replace(/^import .*;\n/gm, '').replace(/^bootstrap\(\);\s*$/m, '')
    + '\nglobalThis.ui = {state,bootstrap,openBookmarkInstaller,sourcePayload,sourceSignature,refreshBrowserCapture,selectBrowserCandidate,bookmarkHasDraft,updateControls,probeSource};', context);
  Object.assign(context.ui.state, { connected: true, dependenciesReady: true, sourceType: 'browser' });
  $('start-time').value = '00:00:00'; $('end-time').value = '00:01:00'; $('handles').value = '10';
  $('output-dir').value = '/synthetic/output'; $('budget').value = '256'; $('read-mode').value = 'standard'; $('download-method').value = 'indexed';
  context.readState = async path => { requests.push(path); return context.nextState; };
  vm.runInContext('api = async (path, options) => readState(path, options); probeSource = async () => recordProbe(sourcePayload());', context);
  return { context, ui: context.ui, $, timers, probes, requests };
}

function receiverHarness({ href = `${ORIGIN}/bookmark/receive#${TOKEN}`, fetcher, closeError = false } = {}) {
  const status = { textContent: '' }, closeButton = new Element('button'), closeHint = new Element('p'); closeHint.hidden = true;
  const listeners = new Map(), posts = [], imports = [], timers = new Map(), history = [];
  let nextTimer = 0, closed = 0;
  const opener = { postMessage(message, origin) { posts.push({ message, origin }); } };
  const window = { location: { href }, opener, document: { getElementById: id => ({ 'bookmark-receive-state': status, 'bookmark-receive-close': closeButton, 'bookmark-receive-close-hint': closeHint })[id] },
    history: { replaceState(_state, _title, path) { history.push(path); window.location.href = new URL(path, href).href; } },
    addEventListener(name, callback) { listeners.set(name, callback); }, removeEventListener(name) { listeners.delete(name); },
    close() { closed++; if (closeError) throw new Error('browser refused'); },
    get localStorage() { throw new Error('capability must not be persisted'); },
    get sessionStorage() { throw new Error('capability must not be persisted'); },
  };
  const instance = view.startBookmarkReceiver({ window,
    crypto: { getRandomValues(bytes) { bytes.fill(7); return bytes; } },
    fetch: async (url, options) => { imports.push({ url, options }); return fetcher ? fetcher(url, options) : { ok: true, json: async () => ({ ok: true, accepted: 1 }) }; },
    setTimer(callback, milliseconds) { const id = ++nextTimer; timers.set(id, { callback, milliseconds }); return id; },
    clearTimer(id) { timers.delete(id); },
  });
  const nonce = posts.find(item => item.message.type === 'clip-fetcher:bookmark-ready')?.message.receiverNonce;
  const payload = { schemaVersion: 1, provider: 'xunlei', pageUrl: 'https://pan.xunlei.com/drive',
    candidates: [{ url: 'https://cdn.example.com/original.mkv?signature=SYNTHETIC_ONLY', name: 'original.mkv', size: 10000,
      headers: { 'User-Agent': 'Synthetic Browser', Referer: 'https://pan.xunlei.com/drive' } }] };
  const frame = (overrides = {}) => ({ type: 'clip-fetcher:bookmark-candidates', schemaVersion: 1, runId: RUN,
    receiverNonce: nonce, payload, ...overrides });
  const send = (data = frame(), overrides = {}) => listeners.get('message')?.({ source: opener, origin: 'https://pan.xunlei.com', data, ...overrides });
  return { instance, window, opener, status, posts, imports, timers, history, nonce, payload, frame, send, closeHint,
    close: () => closeButton.listeners.click(), pagehide: () => listeners.get('pagehide')?.(), closed: () => closed };
}

test('state reconstruction keeps the bookmark only in RAM and omits all signed source details', () => {
  const result = view.bookmarkCaptureState(snapshot([{ ...candidate, url: 'PRIVATE_URL', headers: { Cookie: 'PRIVATE_COOKIE' } }, candidate]));
  assert.equal(result.available, true); assert.equal(result.bookmarklet, 'javascript:TEST_ONLY');
  assert.deepEqual(result.candidates, [candidate]);
  assert.doesNotMatch(JSON.stringify(result.candidates), /PRIVATE|Cookie|headers|url/);
  for (const bookmarklet of ['https://evil.example/', 'data:text/html,bad', '', null])
    assert.equal(view.bookmarkCaptureState({ available: true, bookmarklet }).available, false);
  assert.deepEqual(view.bookmarkCaptureState(snapshot([{ ...candidate, sourceHost: 'https://signed.example/?secret=PRIVATE' }])).candidates, []);
});

test('one reliable new candidate selects once; duplicate and stale receipts never select again', () => {
  const inbox = view.createBookmarkInboxView(), state = snapshot();
  assert.equal(inbox.receive(snapshot([], 0)).action, 'baseline');
  assert.deepEqual(inbox.receive(state), { action: 'select', candidate });
  assert.deepEqual(inbox.receive(state), { action: 'unchanged' });
  assert.deepEqual(inbox.receive({ ...state, receiptSequence: 0 }), { action: 'stale' });
  assert.deepEqual(inbox.receive({ ...state, receiptSequence: 2 }), { action: 'unchanged' });
  const next = { ...candidate, id: 'd'.repeat(32), receivedAt: 2000 };
  assert.deepEqual(inbox.receive(snapshot([candidate, next], 3)), { action: 'select', candidate: next });
});

test('busy, current source, unsubmitted draft and ambiguous arrivals require an explicit file choice', () => {
  for (const context of [{ locked: true }, { hasDraft: true }, { active: false }, { ready: false }]) {
    const inbox = view.createBookmarkInboxView();
    inbox.receive(snapshot([], 0));
    assert.equal(inbox.receive(snapshot(), context).action, context.locked ? 'received-busy' : 'received-draft');
    assert.equal(inbox.receive(snapshot(), {}).action, 'unchanged', 'unlocking never applies a deferred candidate');
  }
  const other = { ...candidate, id: 'd'.repeat(32) };
  for (const candidates of [[candidate, other], [{ ...candidate, receivedAt: 0 }], [{ ...candidate, size: undefined }]]) {
    const inbox = view.createBookmarkInboxView(); inbox.receive(snapshot([], 0));
    assert.equal(inbox.receive(snapshot(candidates)).action, 'choose');
  }
});

test('candidate choices are file names in text nodes and a disabled choice cannot fire', () => {
  const container = new Element(), selected = [];
  view.renderBookmarkCandidates(container, [candidate], { document: { createElement: tag => new Element(tag) }, onSelect: value => selected.push(value.id) });
  assert.equal(container.children[0].textContent, candidate.name); assert.equal(container.children[0].children.length, 0);
  container.children[0].listeners.click(); assert.deepEqual(selected, [ID]);
  view.renderBookmarkCandidates(container, [candidate], { disabled: true, document: { createElement: tag => new Element(tag) }, onSelect: value => selected.push(value.id) });
  container.children[0].listeners.click(); assert.deepEqual(selected, [ID]);
});

test('the actual app polls every second and automatically checks one fresh candidate without downloading', async () => {
  const { context, ui, $, probes, requests, timers } = appHarness();
  context.nextState = snapshot([], 0); await ui.refreshBrowserCapture(); requests.length = 0;
  context.nextState = snapshot();
  await ui.refreshBrowserCapture(); await Promise.resolve();
  assert.deepEqual(requests, ['/api/bookmark-capture/state']); assert.equal(probes.length, 1);
  assert.equal(JSON.stringify(probes[0]), JSON.stringify({ type: 'browser', value: ID }));
  assert.equal(ui.state.browser.selectedId, ID); assert.equal($('bookmark-capture-link').href, 'javascript:TEST_ONLY');
  assert.equal($('bookmark-capture-link').draggable, true); assert.equal(timers.at(-1).milliseconds, 1000);
  assert.equal(ui.state.job, null); await ui.refreshBrowserCapture(); assert.equal(probes.length, 1);
});

test('the actual app preserves a running job, its source and editable future range on receipt', async () => {
  const { context, ui, $, probes } = appHarness();
  context.nextState = snapshot([], 0); await ui.refreshBrowserCapture();
  Object.assign(ui.state, { busy: true, sourceId: 'current-source', job: { id: 'current-job', status: 'running' }, pollTimer: 44 });
  ui.state.browser.selectedId = 'e'.repeat(32); $('start-time').value = '12'; $('end-time').value = '34';
  context.nextState = snapshot(); await ui.refreshBrowserCapture();
  assert.equal(probes.length, 0); assert.equal(ui.state.sourceId, 'current-source'); assert.equal(ui.state.job.id, 'current-job');
  assert.equal(ui.state.pollTimer, 44); assert.equal(ui.state.browser.selectedId, 'e'.repeat(32));
  assert.equal($('start-time').value, '12'); assert.equal($('end-time').value, '34');
  assert.equal($('browser-helper-state').textContent, '已收到候选，当前下载继续。');
  ui.state.busy = false; await ui.refreshBrowserCapture(); assert.equal(probes.length, 0);
});

test('an unsubmitted draft is protected, while one explicit file click checks that choice only once', async () => {
  const { context, ui, $, probes } = appHarness();
  context.nextState = snapshot([], 0); await ui.refreshBrowserCapture();
  $('start-time').listeners.input(); assert.equal(ui.state.browser.draftDirty, true);
  context.nextState = snapshot(); await ui.refreshBrowserCapture(); assert.equal(probes.length, 0);
  $('browser-candidates').children[0].listeners.click(); await Promise.resolve();
  assert.equal(probes.length, 1); assert.equal(ui.state.browser.selectedId, ID); assert.equal(ui.state.browser.draftDirty, false);
  await ui.refreshBrowserCapture(); assert.equal(probes.length, 1);
});

test('global receipt monitoring leaves the initial DAV tab alone and switches only for a new reliable arrival', async () => {
  const { context, ui, probes, timers } = appHarness(); ui.state.sourceType = 'dav';
  context.nextState = snapshot(); await ui.refreshBrowserCapture();
  assert.equal(ui.state.sourceType, 'dav'); assert.equal(probes.length, 0, 'initial poll cannot replay an old receipt');
  assert.equal(timers.at(-1).milliseconds, 1000, 'monitoring continues outside the browser tab');
  const next = { ...candidate, id: 'd'.repeat(32), receivedAt: 2000 };
  context.nextState = snapshot([candidate, next], 2); await ui.refreshBrowserCapture(); await Promise.resolve();
  assert.equal(ui.state.sourceType, 'browser'); assert.equal(ui.state.browser.selectedId, next.id); assert.equal(probes.length, 1);
  context.nextState = snapshot([], 0); await ui.refreshBrowserCapture();
  assert.equal(ui.state.browser.selectedId, next.id, 'a stale or expired list never clears the current source');
});

test('a fresh global receipt cannot replace an existing DAV source or a queued task', async () => {
  for (const mode of ['source', 'queued']) {
    const { context, ui, probes } = appHarness(); ui.state.sourceType = 'dav';
    context.nextState = snapshot([], 0); await ui.refreshBrowserCapture();
    if (mode === 'source') { ui.state.sourceId = 'dav-source'; ui.state.dav.selectedUrl = 'http://127.0.0.1/private.mkv'; }
    else ui.state.queuedJobIds.add('queued-task');
    context.nextState = snapshot(); await ui.refreshBrowserCapture();
    assert.equal(ui.state.sourceType, 'dav'); assert.equal(probes.length, 0);
    if (mode === 'source') assert.equal(ui.state.sourceId, 'dav-source'); else assert.equal(ui.state.queuedJobIds.size, 1);
  }
});

test('a successful real app probe shows the original file and enables manual extraction without starting it', async () => {
  const { context, ui, $ } = appHarness();
  ui.state.browser.selectedId = ID; ui.state.browser.selected = candidate;
  context.probeReply = { sourceId: 'checked-original', source: { label: 'original.mkv', rangeVerified: true, size: 10000 },
    media: { duration: 100, format: 'matroska', video: { codec: 'h264', width: 1920, height: 1080 }, audio: [] },
    metrics: { receivedBytes: 128 }, directStreamAvailable: true };
  vm.runInContext('api = async () => probeReply;', context);
  await ui.probeSource();
  assert.equal(ui.state.sourceId, 'checked-original'); assert.equal($('media-name').textContent, 'original.mkv');
  assert.equal($('source-kind').textContent, '浏览器抓链'); assert.equal($('media-info').hidden, false);
  assert.equal($('browser-selected').textContent, '原文件已就绪，不会自动开始下载。');
  assert.equal($('start-button').disabled, false); assert.equal(ui.state.job, null);
});

test('dragging the device bookmark preserves native link title data and blocks an unavailable link', async () => {
  const { context, ui, $ } = appHarness(); context.nextState = snapshot([], 0); await ui.refreshBrowserCapture();
  const data = new Map(), transfer = { setData(type, value) { data.set(type, value); } };
  $('bookmark-capture-link').listeners.dragstart({ dataTransfer: transfer, preventDefault() { throw new Error('ready drag was blocked'); } });
  assert.equal($('bookmark-capture-link').href, 'javascript:TEST_ONLY');
  assert.equal(data.size, 0, 'native drag payload must retain the anchor title');
  ui.state.browser.available = false; let blocked = false;
  $('bookmark-capture-link').listeners.dragstart({ dataTransfer: transfer, preventDefault() { blocked = true; } });
  assert.equal(blocked, true);
});

test('receiver removes its fragment, verifies both official origins and acknowledges before closing', async () => {
  const harness = receiverHarness();
  assert.deepEqual(harness.history, ['/bookmark/receive']); assert(!harness.window.location.href.includes(TOKEN));
  assert.equal(harness.nonce.length, 32);
  assert.deepEqual(harness.posts.map(item => item.origin), ['https://pan.xunlei.com', 'https://pan.baidu.com']);
  await harness.send(); assert.equal(harness.imports.length, 1);
  const { url, options } = harness.imports[0];
  assert.equal(url, '/api/bookmark-capture/import'); assert.equal(options.headers['X-Bookmark-Token'], TOKEN);
  assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error'); assert.equal(options.referrerPolicy, 'origin');
  assert.equal(harness.posts.at(-1).message.accepted, 1); assert.equal(harness.closed(), 0);
  assert.doesNotMatch(JSON.stringify(harness.posts), new RegExp(TOKEN + '|SYNTHETIC_ONLY|Cookie'));
  [...harness.timers.values()].find(timer => timer.milliseconds === 100).callback(); assert.equal(harness.closed(), 1);
  harness.instance.dispose();
});

test('receiver tolerates only the observed official popup trace parameter and removes it before handoff', async () => {
  const harness = receiverHarness({ href: `${ORIGIN}/bookmark/receive?__trace_id__=${'a'.repeat(32)}#${TOKEN}` });
  assert.deepEqual(harness.history, ['/bookmark/receive']); assert.equal(harness.posts.length, 2);
  await harness.send(); assert.equal(harness.imports.length, 1); harness.instance.dispose();
  for (const query of ['?__trace_id__=bad', '?__trace_id__=' + 'a'.repeat(32) + '&other=1', '?token=PRIVATE']) {
    const invalid = receiverHarness({ href: `${ORIGIN}/bookmark/receive${query}#${TOKEN}` });
    assert.equal(invalid.posts.length, 0); assert.equal(invalid.imports.length, 0); invalid.instance.dispose();
  }
});

test('receiver ignores wrong source, wrong origin, stale nonce and a replaced opener without importing', async () => {
  const harness = receiverHarness();
  await harness.send(harness.frame(), { source: {} });
  for (const origin of ['null', 'https://evil.example', 'https://pan.xunlei.com.evil.example', 'https://login.xunlei.com', 'http://pan.xunlei.com'])
    await harness.send(harness.frame(), { origin });
  await harness.send(harness.frame({ receiverNonce: 'd'.repeat(32) }));
  harness.window.opener = {}; await harness.send();
  assert.equal(harness.imports.length, 0); assert.equal(harness.posts.length, 2); harness.instance.dispose();
});

test('receiver binds one run, deduplicates in-flight imports and resends only that run acknowledgement', async () => {
  let resolveImport;
  const harness = receiverHarness({ fetcher: () => new Promise(resolve => { resolveImport = resolve; }) });
  const first = harness.send(); await harness.send(); assert.equal(harness.imports.length, 1);
  resolveImport({ ok: true, json: async () => ({ ok: true, accepted: 1 }) }); await first;
  await harness.send(); assert.equal(harness.imports.length, 1); assert.equal(harness.posts.at(-1).message.accepted, 1);
  const count = harness.posts.length; await harness.send(harness.frame({ runId: 'd'.repeat(32) })); assert.equal(harness.posts.length, count);
  harness.instance.dispose();
});

test('Baidu accepts only its matching page context; secret headers and query-bearing page context are rejected', async () => {
  for (const mode of ['header', 'page']) {
    const harness = receiverHarness();
    const payload = mode === 'header'
      ? { ...harness.payload, candidates: [{ ...harness.payload.candidates[0], headers: { Cookie: 'PRIVATE_COOKIE' } }] }
      : { ...harness.payload, pageUrl: 'https://pan.xunlei.com/drive?secret=PRIVATE' };
    await harness.send(harness.frame({ payload }));
    assert.equal(harness.posts.at(-1).message.code, 'INVALID_MESSAGE'); assert.equal(harness.imports.length, 0);
    const count = harness.posts.length;
    await harness.send(harness.frame({ runId: 'd'.repeat(32) })); assert.equal(harness.posts.length, count);
    assert.doesNotMatch(harness.status.textContent, /PRIVATE/); harness.instance.dispose();
  }
  const harness = receiverHarness();
  const baidu = { schemaVersion: 1, provider: 'baidu', pageUrl: 'https://pan.baidu.com/disk/main', candidates: [{ url: 'https://cdn.example.com/file.mkv' }] };
  await harness.send(harness.frame({ payload: baidu }), { origin: 'https://pan.baidu.com' });
  assert.equal(harness.imports.length, 1); assert.equal(JSON.parse(harness.imports[0].options.body).provider, 'baidu');
  assert.doesNotMatch(harness.status.textContent, /PRIVATE/); harness.instance.dispose();
});

test('receiver reports fixed import/network/timeout failures and never reflects response or token text', async () => {
  for (const fetcher of [async () => ({ ok: false, json: async () => ({ error: { message: TOKEN } }) }),
    async () => { throw new Error(TOKEN); }, async () => ({ ok: true, json: async () => ({ ok: true, accepted: 0 }) })]) {
    const harness = receiverHarness({ fetcher }); await harness.send();
    assert.equal(harness.posts.at(-1).message.accepted, 0); assert(harness.posts.at(-1).message.code);
    assert(!harness.status.textContent.includes(TOKEN)); assert.equal(harness.closed(), 0); harness.instance.dispose();
  }
  const harness = receiverHarness({ fetcher: (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('PRIVATE')), { once: true });
  }) });
  const pending = harness.send(); [...harness.timers.values()].find(timer => timer.milliseconds === 10000).callback(); await pending;
  assert.equal(harness.posts.at(-1).message.code, 'TIMEOUT'); harness.instance.dispose();
  let finishLate;
  const late = receiverHarness({ fetcher: () => new Promise(resolve => { finishLate = resolve; }) });
  const latePending = late.send(); [...late.timers.values()].find(timer => timer.milliseconds === 10000).callback();
  finishLate({ ok: true, json: async () => ({ ok: true, accepted: 1 }) }); await latePending;
  assert.equal(late.posts.at(-1).message.code, 'TIMEOUT'); assert.equal(late.posts.at(-1).message.accepted, 0);
  assert.equal(late.closed(), 0); late.instance.dispose();
});

test('receiver invalid startup and pagehide cannot send or commit a stale import', async () => {
  for (const href of [`https://127.0.0.1:4321/bookmark/receive#${TOKEN}`, `http://localhost:4321/bookmark/receive#${TOKEN}`,
    `https://evil.example/bookmark/receive#${TOKEN}`, `${ORIGIN}/bookmark/receive#bad`, `${ORIGIN}/bookmark/receive?token=PRIVATE#${TOKEN}`]) {
    const harness = receiverHarness({ href }); assert.equal(harness.posts.length, 0); assert.equal(harness.imports.length, 0);
    assert(!harness.status.textContent.includes(TOKEN)); harness.instance.dispose();
  }
  let resolveImport;
  const harness = receiverHarness({ fetcher: () => new Promise(resolve => { resolveImport = resolve; }) });
  const pending = harness.send(); harness.instance.dispose();
  assert.equal(harness.imports[0].options.signal.aborted, true);
  resolveImport({ ok: true, json: async () => ({ ok: true, accepted: 1 }) }); await pending;
  assert.equal(harness.posts.length, 2); assert.equal(harness.closed(), 0);
});

test('the default capture tab has one draggable bookmark and concise help, with no extension or pairing flow', () => {
  const panel = html.slice(html.indexOf('id="panel-browser"'), html.indexOf('id="panel-dav"'));
  assert.match(html, /id="tab-browser"[^>]*>浏览器抓链</);
  assert.match(panel, /id="bookmark-capture-link"[^>]*draggable="true"/);
  assert.match(panel, />片段取材抓链<\/a>/);
  for (const id of ['bookmark-step-install', 'bookmark-step-trigger', 'bookmark-step-receive']) assert(panel.includes(`id="${id}"`));
  assert.doesNotMatch(panel, /扩展|开发者模式|配对|复制地址|Nuxt|browser-helper\.zip/);
  assert.doesNotMatch(appSource, /(?:localStorage|sessionStorage)\./);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]); assert.equal(new Set(ids).size, ids.length);
  assert.match(html, /id="tab-browser"[^>]+aria-selected="true"/);
  assert.match(html, /id="tab-dav"[^>]+aria-selected="false"/);
  assert.doesNotMatch(html, /id="panel-browser"[^>]+hidden/);
  assert.match(html, /id="panel-dav"[^>]+hidden/);
});

test('capture defaults to Edge on Windows and shows each edition’s supported clouds', async () => {
  const providers = [{ id: 'xunlei', name: '迅雷云盘', note: '普通迅雷说明' }, { id: 'baidu', name: '百度网盘' }];
  for (const edition of ['windows-edge-xunlei', 'windows-edge-cloud', undefined]) {
    const h = appHarness();
    assert.equal(h.ui.state.sourceType, 'browser');
    const opened = [];
    h.context.readState = async (route, options) => {
      if (route === '/api/bootstrap') return { sessionToken: 'fixture', platform: { os: 'win32', arch: 'x64' }, edition, providers };
      if (route === '/api/bookmark-capture/open') {
        opened.push(options.body.browser);
        throw Object.assign(new Error('browser unavailable'), { code: 'BROWSER_MISSING' });
      }
      return route === '/api/jobs/history' ? { jobs: [] } : snapshot([], 0);
    };
    await h.ui.bootstrap();
    if (edition) {
      assert.equal(h.ui.state.sourceType, 'browser');
      assert.match(h.$('browser-provider-intro').textContent, /Edge.*迅雷/);
      assert(h.$('bookmark-install-chrome').hidden);
      assert(!h.$('edge-download-hint').hidden);
      const dual = edition === 'windows-edge-cloud';
      assert.equal(h.$('provider-options').children.length, dual ? 2 : 1);
      assert.equal(h.$('edge-baidu-entry').hidden, !dual);
      assert.equal(h.$('browser-provider-intro').textContent.includes('百度网盘'), dual);
      assert.match(h.$('bookmark-step-install').textContent, /Ctrl\+Shift\+B/);
      await h.ui.openBookmarkInstaller('chrome');
      await h.ui.openBookmarkInstaller('edge');
      assert.deepEqual(opened, ['edge']);
      assert.match(h.$('edge-bookmark-open-error').textContent, /未找到 Microsoft Edge/);
      assert.equal(h.$('edge-bookmark-address').textContent, ORIGIN + '/bookmark/install');
      assert(!h.$('edge-bookmark-manual').hidden);
    } else {
      assert.equal(h.ui.state.sourceType, 'browser');
      assert.equal(h.$('provider-options').children.length, 2);
      await h.ui.openBookmarkInstaller('chrome');
      assert.deepEqual(opened, ['chrome']);
    }
  }
});

test('legacy Windows edition hides Baidu before automatic or manual candidate selection', async () => {
  const h = appHarness();
  h.ui.state.windowsEdge = true;
  h.ui.state.windowsXunleiOnly = true;
  h.context.nextState = snapshot([], 0);
  await h.ui.refreshBrowserCapture();
  const baidu = { ...candidate, id: 'f'.repeat(32), provider: 'baidu' };
  h.context.nextState = snapshot([baidu], 1);
  await h.ui.refreshBrowserCapture();
  assert.equal(h.$('browser-candidates').children.length, 0);
  assert.equal(h.ui.selectBrowserCandidate(baidu), false);
  assert.equal(h.probes.length, 0);
  h.context.nextState = snapshot([baidu, candidate], 2);
  await h.ui.refreshBrowserCapture();
  assert.equal(h.probes.length, 1);
  assert.equal(h.probes[0].value, candidate.id);
});

test('dual-cloud Windows accepts an automatically received Baidu candidate', async () => {
  const h = appHarness();
  h.ui.state.windowsEdge = true;
  h.context.nextState = snapshot([], 0);
  await h.ui.refreshBrowserCapture();
  const baidu = { ...candidate, id: 'f'.repeat(32), provider: 'baidu' };
  h.context.nextState = snapshot([baidu], 1);
  await h.ui.refreshBrowserCapture();
  assert.equal(h.probes.length, 1);
  assert.equal(h.probes[0].value, baidu.id);
});

test('the bookmark installer shows Windows favorites instructions even while its receiver is unavailable', async () => {
  for (const [edition, available] of [
    ['windows-edge-xunlei', true], ['windows-edge-xunlei', false],
    ['windows-edge-cloud', true], ['windows-edge-cloud', false],
  ]) {
    const elements = new Map();
    const getElementById = id => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    };
    const link = getElementById('bookmark-install-link');
    const status = getElementById('bookmark-install-state');
    const context = vm.createContext({ document: { getElementById }, fetch: async () => ({
      ok: true, json: async () => ({ edition, available, bookmarklet: 'javascript:TEST_ONLY' }),
    }) });
    await vm.runInContext(`(async () => {${installSource}})()`, context);
    assert.match(getElementById('bookmark-install-heading').textContent, /Edge 收藏夹栏/);
    assert.match(getElementById('bookmark-install-intro').textContent, /迅雷云盘/);
    assert.equal(getElementById('bookmark-install-intro').textContent.includes('百度网盘'), edition === 'windows-edge-cloud');
    assert(getElementById('bookmark-install-shortcuts').hidden);
    assert(!getElementById('bookmark-install-edge-shortcut').hidden);
    assert.equal(link.draggable, available);
    if (available) assert.equal(link.href, 'javascript:TEST_ONLY');
    else {
      link.listeners.click({ preventDefault() {} });
      assert.match(status.textContent, /抓链入口暂不可用/);
    }
  }
});


test('manual receiver close before capture notifies only official origins and prevents later imports', async () => {
  const h = receiverHarness(); h.close();
  const closed = h.posts.filter(item => item.message.type === 'clip-fetcher:bookmark-closed');
  assert.deepEqual(closed.map(item => item.origin), ['https://pan.xunlei.com', 'https://pan.baidu.com']);
  assert(closed.every(item => item.message.receiverNonce === h.nonce));
  assert.doesNotMatch(JSON.stringify(closed), /SYNTHETIC_ONLY|token|payload/);
  assert.equal(h.closed(), 1); assert.equal(h.closeHint.hidden, false); assert.equal(h.timers.size, 0);
  await h.send(); assert.equal(h.imports.length, 0);
  h.close(); assert.equal(h.posts.length, 4, 'repeated close does not repeat cancellation');
});

test('native window close stops receiver work and aborts an in-flight import without acknowledging late success', async () => {
  let resolveImport;
  const h = receiverHarness({ fetcher: () => new Promise(resolve => { resolveImport = resolve; }) });
  const pending = h.send(); h.pagehide();
  assert.equal(h.imports[0].options.signal.aborted, true); assert.equal(h.timers.size, 0);
  assert.equal(h.posts.at(-1).message.type, 'clip-fetcher:bookmark-closed');
  assert.equal(h.posts.at(-1).origin, 'https://pan.xunlei.com');
  const count = h.posts.length;
  resolveImport({ ok: true, json: async () => ({ ok: true, accepted: 1 }) }); await pending;
  assert.equal(h.posts.length, count); assert.equal(h.closed(), 0);
});

test('receiver close fallback stays usable on invalid pages and after successful auto close is refused', async () => {
  for (const closeError of [false, true]) {
    const invalid = receiverHarness({ href: `${ORIGIN}/bookmark/receive#bad`, closeError }); invalid.close();
    assert.equal(invalid.closeHint.hidden, false); assert.equal(invalid.closed(), 1); assert.equal(invalid.posts.length, 0);
    const h = receiverHarness({ closeError }); await h.send();
    [...h.timers.values()].find(timer => timer.milliseconds === 100).callback();
    assert.equal(h.closeHint.hidden, false); assert.equal(h.closed(), 1); assert.equal(h.timers.size, 0);
    assert.equal(h.posts.filter(item => item.message.type === 'clip-fetcher:bookmark-closed').length, 0);
    assert.match(h.status.textContent, /已交回/);
    h.close(); assert.equal(h.closed(), 2); assert.equal(h.imports.length, 1);
  }
});


test('receiver binds a new bookmark run from its fragment before readiness or close notifications', async () => {
  const h = receiverHarness({ href: `${ORIGIN}/bookmark/receive#${TOKEN}.${RUN}` });
  assert.deepEqual(h.history, ['/bookmark/receive']);
  assert(!h.window.location.href.includes(TOKEN));
  assert(h.posts.every(item => item.message.runId === RUN));
  await h.send(h.frame({ runId: 'd'.repeat(32) }));
  assert.equal(h.imports.length, 0, 'even the first payload must match the run that opened this document');
  h.close();
  const closed = h.posts.filter(item => item.message.type === 'clip-fetcher:bookmark-closed');
  assert.equal(closed.length, 2); assert(closed.every(item => item.message.runId === RUN));
  assert.equal(h.imports.length, 0);
});

test('run-bound receiver accepts only its own payload while legacy token-only bookmarks still work', async () => {
  for (const hash of [`${TOKEN}.${RUN}`, TOKEN]) {
    const h = receiverHarness({ href: `${ORIGIN}/bookmark/receive#${hash}` });
    const ready = h.posts.find(item => item.message.type === 'clip-fetcher:bookmark-ready').message;
    assert.equal(ready.runId, hash === TOKEN ? undefined : RUN);
    await h.send(); assert.equal(h.imports.length, 1);
    assert.equal(h.posts.at(-1).message.accepted, 1); assert.equal(h.posts.at(-1).message.runId, RUN);
    h.instance.dispose();
  }
  for (const suffix of ['.', '.bad', '.' + RUN + '.extra', '.' + RUN.toUpperCase()]) {
    const h = receiverHarness({ href: `${ORIGIN}/bookmark/receive#${TOKEN}${suffix}` });
    assert.equal(h.posts.length, 0); assert.equal(h.imports.length, 0); h.instance.dispose();
  }
});
