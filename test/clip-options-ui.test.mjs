import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as clipOptions from '../public/clip-options.mjs';
import * as policy from '../public/browser-helper-view.mjs';
import * as bookmarks from '../public/bookmark-capture-view.mjs';
import { resumeView } from '../public/resume-view.mjs';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');
class Element {
  constructor(tag = 'div') {
    this.tagName = tag; this.value = ''; this.textContent = ''; this.children = []; this.options = [{}, {}];
    this.dataset = {}; this.listeners = {}; this.attributes = {}; this.style = {};
    this.hidden = false; this.disabled = false; this.checked = false;
    this.classList = { add() {}, remove() {}, toggle() {}, contains() { return false; } };
  }
  set innerHTML(_value) { throw new Error('unsafe HTML'); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  hasAttribute(key) { return key in this.attributes; }
  removeAttribute(key) { delete this.attributes[key]; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; this.options = [...children]; }
  add(option) { this.children.push(option); this.options.push(option); }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  querySelector() { return this.label ||= new Element('span'); }
  focus() {} scrollIntoView() {} pause() {} load() {}
}
function harness() {
  const elements = new Map(), requests = [];
  const $ = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  const types = ['dav', 'browser', 'local', 'http'];
  const tabs = types.map(type => { const tab = $(`tab-${type}`); tab.dataset.sourceType = type; return tab; });
  const fields = ['start-time', 'end-time', 'handles', 'output-dir', 'audio-stream', 'subtitle-stream', 'clip-name', 'make-mp4', 'budget', 'read-mode', 'reuse-index', 'download-method'].map($);
  const sourceFields = ['source-url', 'source-username', 'source-password', 'local-path'].map($);
  const document = { getElementById: $, createElement: tag => new Element(tag), querySelectorAll(selector) {
    if (selector === '[data-source-type]') return tabs;
    if (selector === '.source-field') return sourceFields;
    if (selector === '.source-field, [data-source-type]') return [...sourceFields, ...tabs];
    if (selector === '#extract-form input, #extract-form select') return fields;
    return [];
  } };
  const context = vm.createContext({ ...clipOptions, ...policy, ...bookmarks, resumeView, document,
    window: { location: { origin: 'http://127.0.0.1:12345' } }, URL, console,
    navigator: { clipboard: { writeText: async () => {} } },
    setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {},
    matchMedia: () => ({ matches: true }), Option: class { constructor(text, value) { this.text = text; this.value = value; } },
    estimateReadBudget: () => null, historyStatusLabel: () => '', historyRequestedRange: () => null,
    recordRequest: (route, options) => { requests.push({ route, options }); return { id: `queued-${requests.length}`, status: 'queued' }; },
  });
  vm.runInContext(appSource.replace(/^import .*;\n/gm, '').replace(/^bootstrap\(\);\s*$/m, '') + '\nglobalThis.ui = { state, sourceSignature, renderMedia, updateRange, updateControls, updateClipName, updateSubtitleHint, invalidateSource, startJob, resultEntries, renderResults };', context);
  vm.runInContext('api = async (route, options) => recordRequest(route, options); loadHistory = async () => {};', context);
  const ui = context.ui;
  Object.assign(ui.state, { connected: true, dependenciesReady: true, sourceType: 'browser', sourceId: 'checked' });
  Object.assign(ui.state.browser, { selectedId: 'a'.repeat(32), selected: { name: '电影甲.mkv' } });
  ui.state.sourceSignature = ui.sourceSignature();
  $('start-time').value = '10'; $('end-time').value = '20'; $('handles').value = '0';
  $('budget').value = '256'; $('output-dir').value = '/fixtures/output'; $('read-mode').value = 'standard'; $('download-method').value = 'direct-stream';
  const probe = { source: { label: '电影甲.mkv', size: 100000 }, directStreamAvailable: true,
    media: { duration: 60, format: 'matroska', streams: [
      { index: 0, type: 'video', codec: 'h264', width: 1280, height: 720 },
      { index: 1, type: 'audio', codec: 'aac', language: 'eng' },
      { index: 2, type: 'subtitle', codec: 'ass', language: 'chi' },
      { index: 3, type: 'subtitle', codec: 'hdmv_pgs_subtitle', language: 'eng' },
    ] } };
  ui.state.probe = probe;
  return { context, ui, $, requests, probe };
}

test('extraction form places one editable name before submit and keeps subtitles separate from video', () => {
  assert(html.indexOf('id="clip-name"') < html.indexOf('id="start-button"'));
  assert.match(html, /默认“电影名＋截取时段”/);
  assert.match(html, /id="subtitle-stream"/);
  assert.doesNotMatch(html, /id="(?:rename|burn-subtitle)/);
  assert.doesNotMatch(appSource, /createElement\('track'\)/);
});

test('default name follows user times and excludes handles, while a manually edited name survives time changes', () => {
  const { ui, $, probe } = harness();
  ui.renderMedia(probe);
  assert.equal($('clip-name').value, clipOptions.defaultClipName('电影甲.mkv', 10, 20));
  $('handles').value = '5'; ui.updateRange();
  assert.equal($('clip-name').value, clipOptions.defaultClipName('电影甲.mkv', 10, 20));
  $('start-time').value = '12'; ui.updateRange();
  assert.equal($('clip-name').value, clipOptions.defaultClipName('电影甲.mkv', 12, 20));
  $('clip-name').value = '我的剪辑素材'; $('clip-name').listeners.input();
  $('end-time').value = '25'; ui.updateRange();
  assert.equal($('clip-name').value, '我的剪辑素材');
  $('clip-name').value = ''; $('clip-name').listeners.input(); $('clip-name').listeners.blur();
  assert.equal($('clip-name').value, clipOptions.defaultClipName('电影甲.mkv', 12, 25));
});

test('changing the source resets an edited name and subtitle choice without reusing the old movie name', () => {
  const { ui, $, probe } = harness(); ui.renderMedia(probe);
  $('clip-name').value = '电影甲的自定义片段'; $('clip-name').listeners.input();
  $('subtitle-stream').value = '2';
  ui.state.browser.selectedId = 'b'.repeat(32); ui.state.browser.selected = { name: '电影乙.mkv' };
  ui.invalidateSource();
  assert.equal($('clip-name').value, clipOptions.defaultClipName('电影乙.mkv', 10, 20));
  assert.equal($('subtitle-stream').value, ''); assert.equal($('subtitle-option').hidden, true);
});

test('subtitle options default to none, identify language and picture tracks, and explain absent subtitles', () => {
  const { ui, $, probe } = harness(); ui.renderMedia(probe);
  assert.equal($('subtitle-stream').value, ''); assert.equal($('subtitle-stream').options.length, 3);
  assert.match($('subtitle-stream').options[1].text, /中文.*ASS.*文本字幕/);
  assert.match($('subtitle-stream').options[2].text, /英文.*图片字幕/);
  $('subtitle-stream').value = '3'; ui.updateSubtitleHint(); assert.match($('subtitle-hint').textContent, /不能直接作为可编辑的 SRT/);
  $('subtitle-stream').value = '2'; ui.updateSubtitleHint(); assert.match($('subtitle-hint').textContent, /独立 SRT/);
  ui.state.probe = { ...probe, media: { ...probe.media, streams: [] } }; ui.renderMedia(ui.state.probe); ui.updateControls();
  assert.equal($('subtitle-stream').disabled, true); assert.match($('subtitle-hint').textContent, /未发现内封字幕/);
});

test('unsupported subtitle codecs cannot be selected or submitted as a supported SRT track', async () => {
  const { ui, $, probe, requests } = harness();
  ui.state.probe = { ...probe, media: { ...probe.media, streams: [{ index: 9, type: 'subtitle', codec: 'dvb_subtitle', language: 'eng' }] } };
  ui.renderMedia(ui.state.probe); ui.updateControls();
  assert.equal($('subtitle-stream').options[1].disabled, true); assert.equal($('subtitle-stream').disabled, true);
  assert.match($('subtitle-stream').options[1].text, /暂不支持/);
  $('subtitle-stream').value = '9'; ui.state.busy = true; await ui.startJob({ preventDefault() {} });
  assert.equal(requests.length, 0); assert.match($('form-error').textContent, /字幕轨道/);
});

test('queued same-movie submission snapshots name and chosen subtitle without altering the running job', async () => {
  const { ui, $, probe, requests } = harness(); ui.renderMedia(probe);
  ui.state.busy = true; ui.state.job = { id: 'currently-running', status: 'running' };
  $('clip-name').value = '独立名称'; $('clip-name').listeners.input(); $('subtitle-stream').value = '2';
  ui.updateControls(); assert.equal($('clip-name').disabled, false); assert.equal($('subtitle-stream').disabled, false);
  await ui.startJob({ preventDefault() {} });
  assert.equal(requests.length, 1); assert.equal(requests[0].route, '/api/jobs');
  assert.equal(requests[0].options.body.clipName, '独立名称'); assert.equal(requests[0].options.body.subtitleStreamIndex, 2);
  assert.equal(requests[0].options.body.start, 10); assert.equal(requests[0].options.body.end, 20);
  assert.equal(ui.state.job.id, 'currently-running');
  $('clip-name').value = '另一条'; $('subtitle-stream').value = '';
  assert.equal(requests[0].options.body.clipName, '独立名称'); assert.equal(requests[0].options.body.subtitleStreamIndex, 2);
});

test('no-subtitle submission omits the option, and a stale track cannot be sent', async () => {
  const { ui, $, probe, requests } = harness(); ui.renderMedia(probe); ui.state.busy = true;
  await ui.startJob({ preventDefault() {} });
  assert.equal(requests.length, 1); assert.equal('subtitleStreamIndex' in requests[0].options.body, false);
  assert.equal(requests[0].options.body.clipName, clipOptions.defaultClipName('电影甲.mkv', 10, 20));
  $('subtitle-stream').value = '99'; await ui.startJob({ preventDefault() {} });
  assert.equal(requests.length, 1); assert.match($('form-error').textContent, /当前原文件中的字幕/);
});

test('independent subtitles are separate result artifacts with individual folder and clipboard actions', async () => {
  const { ui, $, requests } = harness();
  const result = { candidatePath: '/fixtures/name.mkv', subtitlePaths: ['/fixtures/name.zh.srt', '/fixtures/name.en.sup'],
    subtitleResults: [{ path: '/fixtures/name.zh.srt', kind: 'text' }, { path: '/fixtures/name.en.sup', kind: 'image' }] };
  const entries = ui.resultEntries(result);
  assert.equal(entries.length, 3); assert.equal(entries[1].type, 'SRT'); assert.equal(entries[2].label, '独立图片字幕');
  assert.match(entries[2].detail, /不能直接作为可编辑 SRT/);
  ui.renderResults(result);
  const subtitleCard = $('result-files').children[1];
  const actions = subtitleCard.children.at(-1);
  assert.equal(actions.children[0].textContent, '复制文件路径'); assert.equal(actions.children[1].textContent, '在文件夹中显示');
  await actions.children[1].listeners.click();
  assert.equal(requests.at(-1).route, '/api/reveal'); assert.equal(requests.at(-1).options.body.path, '/fixtures/name.zh.srt');
});
