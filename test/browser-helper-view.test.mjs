import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as view from '../public/browser-helper-view.mjs';
import * as bookmarkView from '../public/bookmark-capture-view.mjs';
import { resumeView } from '../public/resume-view.mjs';
import * as clipOptions from '../public/clip-options.mjs';

const ORIGIN = 'http://127.0.0.1:12345';
const ID = 'a'.repeat(32);
const pairUrl = `${ORIGIN}/browser-pair#${'b'.repeat(64)}`;
const candidate = { id: ID, provider: 'xunlei', name: '<img src=x onerror=alert(1)>.mkv',
  sourceHost: 'cdn.example.com', size: 12345, receivedAt: 1000, hasContext: true };

class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = {}; this.listeners = {};
    this.value = ''; this.checked = false; this.disabled = false; this.hidden = false;
    this.textContent = ''; this.style = {}; this.options = [{}, {}];
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  set innerHTML(value) { throw new Error('HTML interpolation is forbidden'); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  querySelector() { return this.label ||= new Element('span'); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  scrollIntoView() {}
  pause() {}
  load() {}
}

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

function appHarness() {
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const tabs = ['dav', 'browser', 'local', 'http'].map(type => { const tab = $(`tab-${type}`); tab.dataset.sourceType = type; return tab; });
  const sourceFields = ['source-url', 'source-username', 'source-password', 'local-path'].map($);
  const formFields = ['start-time', 'end-time', 'handles', 'output-dir', 'clip-name', 'subtitle-stream', 'audio-stream', 'make-mp4', 'budget', 'read-mode', 'reuse-index', 'download-method'].map($);
  const document = { getElementById: $, createElement: tag => new Element(tag),
    querySelectorAll(selector) {
      if (selector === '[data-source-type]') return tabs;
      if (selector === '.source-field') return sourceFields;
      if (selector === '.source-field, [data-source-type]') return [...sourceFields, ...tabs];
      if (selector === '#extract-form input, #extract-form select') return formFields;
      return [];
    } };
  let timer = 0;
  const context = vm.createContext({ ...view, ...bookmarkView, ...clipOptions, resumeView,
    document, window: { location: { origin: ORIGIN } }, navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: () => ++timer, clearTimeout() {}, setInterval: () => ++timer, clearInterval() {},
    matchMedia: () => ({ matches: true }), URL, Option: class {}, console,
    estimateReadBudget: () => null, historyStatusLabel: () => '', historyRequestedRange: () => null,
  });
  vm.runInContext(appSource.replace(/^import .*;\n/gm, '').replace(/^bootstrap\(\);\s*$/m, '')
    + '\n globalThis.ui = { state, sourcePayload, sourceSignature, updateControls, startJob, followQueuedHistory, refreshBrowserCapture, selectSource };', context);
  const { state } = context.ui;
  Object.assign(state, { connected: true, dependenciesReady: true, sourceType: 'browser', sourceId: 'checked-source' });
  Object.assign(state.browser, { selectedId: ID, selected: candidate, available: true, bookmarklet: 'javascript:void(0)' });
  state.probe = { directStreamAvailable: true, media: { duration: 100, format: 'matroska' } };
  state.sourceSignature = context.ui.sourceSignature();
  $('start-time').value = '10'; $('end-time').value = '20'; $('handles').value = '0';
  $('output-dir').value = '/local/output'; $('budget').value = '256';
  $('read-mode').value = 'parallel'; $('reuse-index').checked = true;
  $('download-method').value = 'direct-stream';
  return { context, ui: context.ui, $, elements, document };
}

test('browser view accepts only this session pairing URL and reconstructs safe candidate metadata', () => {
  const payload = { url: pairUrl, candidates: [{ ...candidate,
    url: 'https://cdn.example.com/file?signature=PRIVATE', headers: { Authorization: 'PRIVATE' }, pageUrl: 'PRIVATE' }] };
  const result = view.browserHelperState(payload, ORIGIN);
  assert.equal(result.url, pairUrl);
  assert.deepEqual(result.candidates, [candidate]);
  assert.doesNotMatch(JSON.stringify(result.candidates), /PRIVATE|https:|Authorization|pageUrl/);
  for (const url of [`https://evil.example/browser-pair#${'a'.repeat(64)}`,
    `${ORIGIN}/other#${'a'.repeat(64)}`, `${ORIGIN}/browser-pair?token=PRIVATE#${'a'.repeat(64)}`,
    `${ORIGIN}/browser-pair#bad`, 'javascript:alert(1)']) assert.equal(view.browserHelperState({ url }, ORIGIN).url, '');
  const invalid = [{ ...candidate, id: 'raw-url' }, { ...candidate, provider: 'quark' },
    { ...candidate, sourceHost: 'https://secret.example/?token=PRIVATE' }];
  assert.deepEqual(view.browserHelperState({ candidates: invalid }, ORIGIN).candidates, []);
  const duplicate = view.browserHelperState({ candidates: [candidate, candidate] }, ORIGIN);
  assert.equal(duplicate.candidates.length, 1);
});

test('candidate buttons use text nodes and cannot select while disabled', () => {
  const container = new Element(), selected = [];
  const document = { createElement: tag => new Element(tag) };
  view.renderBrowserCandidates(container, [candidate], { document, selectedId: ID, onSelect: value => selected.push(value.id) });
  const button = container.children[0];
  assert.equal(button.children[0].textContent, candidate.name);
  assert.equal(button.children[1].textContent, '迅雷 · cdn.example.com');
  assert.equal(button.attributes['aria-pressed'], 'true');
  button.listeners.click(); assert.deepEqual(selected, [ID]);
  view.renderBrowserCandidates(container, [candidate], { document, disabled: true, onSelect: value => selected.push(value.id) });
  container.children[0].listeners.click(); assert.deepEqual(selected, [ID]);
});

test('only a true capability enables direct stream, with indexed as the conservative fallback', () => {
  assert.equal(view.browserDownloadMethod({ directStreamAvailable: true }, 'direct-stream'), 'direct-stream');
  assert.equal(view.browserDownloadMethod({ directStreamAvailable: true }, 'indexed'), 'indexed');
  for (const value of [false, undefined, 'true', 1, null])
    assert.equal(view.browserDownloadMethod({ directStreamAvailable: value }, 'direct-stream'), 'indexed');
  assert.equal(view.downloadMethodLabel('direct-stream'), '流式直连（新测试）');
  assert.equal(view.downloadMethodLabel('https://private.example/'), '');
});

test('queue policy unlocks only future extraction fields and prevents duplicate submission or source changes', () => {
  const ready = { connected: true, dependenciesReady: true, checkedSource: true };
  assert.deepEqual(view.extractionUiPolicy({ ...ready, busy: true }),
    { formLocked: false, sourceLocked: true, queueing: true, canSubmit: true });
  assert.equal(view.extractionUiPolicy({ ...ready, queued: true }).sourceLocked, true);
  assert.equal(view.extractionUiPolicy({ ...ready, busy: true, checkedSource: false }).canSubmit, false);
  for (const key of ['submitting', 'transferChecking', 'probing', 'picking', 'resumeAction', 'setupChecking']) {
    const result = view.extractionUiPolicy({ ...ready, [key]: true });
    assert.equal(result.formLocked, true, key); assert.equal(result.canSubmit, false, key);
  }
});

test('actual app payload and signature use only the candidate id and reset generation', () => {
  const { ui } = appHarness();
  assert.equal(JSON.stringify(ui.sourcePayload()), JSON.stringify({ type: 'browser', value: ID }));
  const original = ui.sourceSignature();
  ui.state.browser.generation++;
  assert.notEqual(ui.sourceSignature(), original);
  ui.state.browser.selectedId = '';
  assert.throws(() => ui.sourcePayload(), /候选/);
});

test('actual controls allow times/queue submission while current source and probe remain locked', () => {
  const { ui, $ } = appHarness();
  ui.state.busy = true;
  ui.updateControls();
  assert.equal($('start-time').disabled, false);
  assert.equal($('end-time').disabled, false);
  assert.equal($('output-dir').disabled, false);
  assert.equal($('tab-local').disabled, true);
  assert.equal($('probe-button').disabled, true);
  assert.equal($('bookmark-capture-link').draggable, true, 'capture remains available while source replacement is locked');
  assert.equal($('start-button').disabled, false);
  assert.equal($('download-method').value, 'direct-stream');
  assert.equal($('read-mode').disabled, true);
  assert.equal($('reuse-index').disabled, true);
  ui.state.probe.directStreamAvailable = false;
  ui.updateControls();
  assert.equal($('download-method').value, 'indexed');
  assert.equal($('download-method').options[0].disabled, true);
  ui.state.submitting = true;
  ui.updateControls();
  assert.equal($('start-time').disabled, true);
  assert.equal($('start-button').disabled, true);
});

test('actual busy submission preserves the displayed task and poll; a second click cannot double enqueue', async () => {
  const { context, ui, $ } = appHarness();
  Object.assign(ui.state, { busy: true, job: { id: 'current', status: 'running' }, pollTimer: 44, startedAt: 321 });
  const bodies = []; let resolveRequest, historyLoads = 0;
  Object.assign(context, { requestJob: async body => { bodies.push(body); return new Promise(resolve => { resolveRequest = resolve; }); },
    loadedHistory: () => historyLoads++ });
  vm.runInContext("api = async (path, options) => requestJob(options.body); loadHistory = async () => loadedHistory(); toast = () => {};", context);
  const first = ui.startJob({ preventDefault() {} });
  assert.equal(ui.state.submitting, true);
  $('start-time').value = '30';
  await ui.startJob({ preventDefault() {} });
  assert.equal(bodies.length, 1);
  resolveRequest({ id: 'queued-2', status: 'queued' }); await first;
  assert.equal(ui.state.job.id, 'current');
  assert.equal(ui.state.pollTimer, 44);
  assert.equal(ui.state.startedAt, 321);
  assert.equal(ui.state.busy, true);
  assert.equal(ui.state.submitting, false);
  assert.equal(ui.state.queuedJobIds.has('queued-2'), true);
  assert.equal(historyLoads, 1);
  assert.equal(bodies[0].start, 10);
  assert.equal(bodies[0].downloadMethod, 'direct-stream');
  assert.equal(bodies[0].readMode, 'standard');
  assert.equal(bodies[0].reuseIndex, false);
});

test('failed queue submission leaves active cancellation and polling state intact', async () => {
  const { context, ui } = appHarness();
  Object.assign(ui.state, { busy: true, job: { id: 'current', status: 'running' }, pollTimer: 44 });
  vm.runInContext("api = async () => { throw new Error('队列暂时不可用'); };", context);
  await ui.startJob({ preventDefault() {} });
  assert.equal(ui.state.busy, true);
  assert.equal(ui.state.job.id, 'current');
  assert.equal(ui.state.pollTimer, 44);
  assert.equal(ui.state.submitting, false);
  assert.equal(ui.state.queuedJobIds.size, 0);
});

test('existing DAV submission keeps its original source payload and does not request a browser method', async () => {
  const { context, ui } = appHarness();
  ui.state.sourceType = 'dav';
  Object.assign(ui.state.dav, { selectedUrl: 'http://127.0.0.1:29798/dav/movie.mkv', connectionId: 'dav-session' });
  ui.state.sourceSignature = ui.sourceSignature();
  assert.equal(JSON.stringify(ui.sourcePayload()), JSON.stringify({ type: 'dav',
    value: 'http://127.0.0.1:29798/dav/movie.mkv', connectionId: 'dav-session' }));
  let body;
  context.captureBody = value => { body = value; return { id: 'dav-task', status: 'queued' }; };
  vm.runInContext('api = async (path, options) => captureBody(options.body); renderJob = () => {}; beginPolling = () => {}; scrollToTask = () => {};', context);
  await ui.startJob({ preventDefault() {} });
  assert.equal(body.downloadMethod, undefined);
  assert.equal(body.readMode, 'parallel');
  assert.equal(body.reuseIndex, true);
});

test('history follows the queued running task only after current polling has ended', () => {
  const { context, ui } = appHarness();
  const shown = [], polled = [];
  Object.assign(context, { shown, polled });
  vm.runInContext("renderJob = job => { shown.push(job.id); state.job = job; state.busy = true; state.queuedJobIds.delete(job.id); }; beginPolling = id => polled.push(id);", context);
  Object.assign(ui.state, { busy: true, job: { id: 'current', status: 'running' }, history: [
    { id: 'later', status: 'queued', createdAt: '2026-01-01T00:00:02Z' },
    { id: 'next', status: 'running', createdAt: '2026-01-01T00:00:01Z' },
    { id: 'done', status: 'completed' }] });
  ui.state.queuedJobIds.add('done');
  ui.followQueuedHistory(); assert.deepEqual(shown, []);
  assert.equal(ui.state.queuedJobIds.has('done'), false);
  ui.state.busy = false;
  ui.followQueuedHistory();
  assert.deepEqual(shown, ['next']); assert.deepEqual(polled, ['next']);
  assert.equal(ui.state.queuedJobIds.has('later'), true);
});

test('source tabs keep a single browser default and the intended order', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ['tab-browser', 'panel-browser', 'bookmark-capture-link', 'browser-candidates', 'browser-selected', 'download-method', 'browser-download-option'])
    assert(ids.includes(id), id);
  assert.deepEqual([...html.matchAll(/data-source-type="([^"]+)"/g)].map(match => match[1]), ['browser', 'dav', 'local', 'http']);
  assert.match(html, /id="tab-browser"[^>]+aria-selected="true"/);
  assert.match(html, /<div id="source-controls"[^>]*>/);
  assert.doesNotMatch(html, /<details id="source-controls"/);
  assert.doesNotMatch(html, /browser-helper\.zip|开发者模式|复制配对地址/);
  assert.doesNotMatch(appSource, /(?:localStorage|sessionStorage)\./);
});

test('local pairing help exposes a stable extension mount without embedding pairing credentials', async () => {
  const help = await readFile(new URL('../public/browser-helper-help.html', import.meta.url), 'utf8');
  assert.match(help, /<body\b[^>]*data-clip-fetcher-pair-page="1"/);
  assert.match(help, /id="browser-pair-action"/);
  assert.match(help, /安装助手后，这里会出现连接按钮/);
  assert.match(help, /未出现可使用原工具的/);
  assert.doesNotMatch(help, /#[a-f0-9]{64}|sessionToken|pairingToken/);
});
