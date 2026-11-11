import test from 'node:test';
import assert from 'node:assert/strict';
import { createBrowserHelperController } from '../controller.mjs';
const EXTENSION = 'a'.repeat(32), TOKEN = 'b'.repeat(64), ORIGIN = 'http://127.0.0.1:43100';
const PAIRING = `${ORIGIN}/browser-pair#${TOKEN}`, SESSION = '11111111-2222-4333-a444-555555555555';
function deferred() { let resolve, reject; const promise = new Promise((yes,no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function storage() {
  const values = {};
  return { values, async get(name) { return name === null ? { ...values } : { [name]: values[name] }; },
    async set(items) { Object.assign(values, items); }, async remove(name) { delete values[name]; } };
}
function setup({ fetch: customFetch, injection } = {}) {
  const local = storage(), session = storage(), calls = [], injections = [], messages = [];
  const tab = { id: 7, url: 'https://pan.xunlei.com/folder?private=EXAMPLE#private', title: 'private title' };
  const chromeApi = { runtime: { id: EXTENSION, getURL: file => `chrome-extension://${EXTENSION}/${file}` },
    storage: { local, session }, tabs: {
      async get(id) { assert.equal(id, 7); return { ...tab }; },
      async sendMessage(id, message) { messages.push({ id, message }); return { ok: true }; },
    }, scripting: { async executeScript(value) { injections.push(value); if (injection) await injection(value); } } };
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (customFetch) return customFetch(url, options, calls);
    const result = url.endsWith('/pair') ? { ok: true, schemaVersion: 1, providers: ['baidu','xunlei'] }
      : { ok: true, accepted: JSON.parse(options.body).candidates.length };
    return Response.json(result);
  };
  const controller = createBrowserHelperController({ chromeApi, fetchImpl, userAgent: 'Synthetic Chrome', uuid: () => SESSION });
  const popup = { id: EXTENSION, url: chromeApi.runtime.getURL('popup.html') };
  const bridge = { id: EXTENSION, frameId: 0, tab: { id: 7 }, url: tab.url };
  return { controller, chromeApi, local, session, tab, calls, injections, messages, popup, bridge,
    pair: () => controller.handle({ type: 'helper:pair', pairingUrl: PAIRING }, popup),
    start: () => controller.handle({ type: 'helper:start', tabId: 7 }, popup),
    send: (changes = {}, sender = bridge) => controller.handle({ type: 'capture:candidates', sessionId: SESSION,
      candidates: [{ url: 'https://cdn.example.test/original.mkv?sign=SYNTHETIC_PRIVATE', name: 'movie.mkv', size: 4096 }], ...changes }, sender) };
}

test('pairing remains explicit and cannot be triggered by an ordinary website or content frame', async () => {
  const h = setup();
  const forbidden = await h.controller.handle({ type: 'helper:pair', pairingUrl: PAIRING }, h.bridge);
  assert.equal(forbidden.code, 'REQUEST_INVALID'); assert.equal(h.calls.length, 0);
  const malformed = await h.controller.handle({ type: 'helper:pair', pairingUrl: PAIRING.replace('127.0.0.1','evil.test') }, h.popup);
  assert.equal(malformed.code, 'PAIRING_INVALID'); assert.equal(h.calls.length, 0);
  assert.equal((await h.pair()).ok, true);
  assert.equal(h.calls[0].url, ORIGIN + '/api/browser-helper/pair');
  assert.equal(h.calls[0].options.headers['X-Browser-Pairing'], TOKEN);
  assert.equal(h.calls[0].options.credentials, 'omit'); assert.equal(h.calls[0].options.redirect, 'error');
  assert.deepEqual(JSON.parse(h.calls[0].options.body), { schemaVersion: 1 });
  assert.deepEqual(h.session.values.pairing, { origin: ORIGIN, token: TOKEN }); assert.deepEqual(h.local.values, {});
});

test('a rejected pairing is not saved and raw server/network messages never reach the popup', async () => {
  const h = setup({ fetch: () => new Response('PRIVATE_SERVER_MESSAGE', { status: 403 }) });
  const result = await h.pair(); assert.equal(result.code, 'PAIRING_EXPIRED');
  assert.equal(h.session.values.pairing, undefined); assert.deepEqual(h.local.values, {}); assert.doesNotMatch(JSON.stringify(result), /PRIVATE_SERVER/);
});

test('start uses the existing official tab and injects bounded observers without opening a login/player page', async () => {
  const h = setup(); await h.pair(); assert.equal((await h.start()).ok, true);
  assert.deepEqual(h.injections.map(item => [item.world, item.files]), [['ISOLATED',['bridge.js']], ['MAIN',['capture-core.js','capture-main.js']]]);
  assert.ok(h.injections.every(item => item.target.tabId === 7 && item.target.frameIds[0] === 0));
  const state = await h.controller.handle({ type: 'helper:state', tabId: 7 }, h.popup);
  assert.equal(state.capture.active, true); assert.equal(state.provider, 'xunlei');
  assert.doesNotMatch(JSON.stringify(state), new RegExp(TOKEN));
  assert.equal(h.calls.length, 2); assert.ok(h.calls.every(item => item.url.startsWith(ORIGIN + '/api/browser-helper/')));
});

test('current-tab metadata sends one sanitized candidate batch and keeps URLs only in request memory', async () => {
  const h = setup(); await h.pair(); await h.start();
  const result = await h.send(); assert.deepEqual(result, { ok: true, accepted: 1 });
  const outgoing = h.calls.at(-1);
  assert.equal(outgoing.url, ORIGIN + '/api/browser-helper/candidates');
  const payload = JSON.parse(outgoing.options.body);
  assert.equal(payload.pageUrl, 'https://pan.xunlei.com/folder');
  assert.deepEqual(payload.candidates[0].headers, { 'User-Agent': 'Synthetic Chrome', Referer: 'https://pan.xunlei.com/folder' });
  assert.doesNotMatch(JSON.stringify(h.local.values) + JSON.stringify(h.session.values), /SYNTHETIC_PRIVATE|cdn\.example/);
  const repeat = await h.send(); assert.deepEqual(repeat, { ok: true, accepted: 0 }); assert.equal(h.calls.length, 3);
});

test('wrong sessions, subframes, moved tabs and arbitrary external senders cannot hand off a file', async () => {
  const h = setup(); await h.pair(); await h.start();
  assert.equal((await h.send({ sessionId: 'old-session' })).accepted, 0);
  assert.equal((await h.send({}, { ...h.bridge, frameId: 1 })).code, 'REQUEST_INVALID');
  assert.equal((await h.send({}, { ...h.bridge, id: 'other-extension' })).code, 'REQUEST_INVALID');
  h.tab.url = 'https://pan.baidu.com/disk/main';
  assert.equal((await h.send()).code, 'PAGE_CHANGED'); assert.equal(h.calls.length, 2);
});

test('stop remains available while the start handshake is pending and prevents later injection', async () => {
  const seen = deferred(); let count = 0;
  const h = setup({ fetch: (url, options) => {
    if (++count === 1) return Response.json({ ok: true, schemaVersion: 1, providers: ['xunlei','baidu'] });
    seen.resolve(); return new Promise((resolve,reject) => {
      if (options.signal.aborted) reject(new Error('cancelled'));
      options.signal.addEventListener('abort', () => reject(new Error('PRIVATE_ABORT_REASON')), { once: true });
    });
  } });
  await h.pair(); const start = h.start(); await seen.promise;
  assert.equal((await h.controller.handle({ type: 'helper:stop', tabId: 7 }, h.popup)).ok, true);
  const result = await start; assert.equal(result.code, 'CANCELLED'); assert.equal(h.injections.length, 0);
  assert.equal(h.session.values['clip-capture-7'].active, false);
});

test('stop cancels an in-flight handoff and stale queued observations cannot revive capture', async () => {
  const sent = deferred();
  const h = setup({ fetch: (url, options) => {
    if (url.endsWith('/pair')) return Response.json({ ok: true, schemaVersion: 1, providers: ['xunlei','baidu'] });
    sent.resolve(); return new Promise((resolve,reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  await h.pair(); await h.start(); const sending = h.send(); await sent.promise;
  await h.controller.handle({ type: 'helper:stop', tabId: 7 }, h.popup);
  assert.equal((await sending).code, 'CANCELLED'); assert.equal((await h.send()).accepted, 0);
  assert.equal(h.session.values['clip-capture-7'].active, false);
});

test('reset forgets pairing and disables every capture without changing site credentials', async () => {
  const h = setup(); await h.pair(); await h.start();
  assert.equal((await h.controller.handle({ type: 'helper:reset' }, h.popup)).ok, true);
  assert.deepEqual(h.local.values, {}); assert.deepEqual(h.session.values, {});
  assert.equal((await h.send()).accepted, 0);
  assert.equal((await h.start()).code, 'PAIRING_MISSING');
});

test('Baidu uses the same controller path while unsupported sites cannot start', async () => {
  const h = setup(); await h.pair(); h.tab.url = 'https://pan.baidu.com/disk/main#my-files'; h.bridge.url = h.tab.url;
  assert.equal((await h.start()).ok, true); assert.equal((await h.send()).accepted, 1);
  assert.equal(JSON.parse(h.calls.at(-1).options.body).provider, 'baidu');
  await h.controller.removed(7); h.tab.url = 'https://unrelated.example/';
  assert.equal((await h.start()).code, 'PAGE_UNSUPPORTED');
});

test('a browser without temporary session storage is rejected instead of persisting a pairing token', async () => {
  const h=setup(); delete h.chromeApi.storage.session;
  const result=await h.pair(); assert.equal(result.code,'BROWSER_UNSUPPORTED'); assert.deepEqual(h.local.values,{});
});

async function selectedFile(h) {
  return h.controller.handle({ type:'capture:files',sessionId:SESSION,available:true,
    files:[{id:'file_A',name:'movie.mkv',size:4096,web_content_link:'PRIVATE_OLD_URL',token:'PRIVATE_TOKEN'},
      {id:'bad\nID',name:'bad',size:2}] },h.bridge);
}
test('Xunlei file listing is metadata-only and an explicit selection is forwarded to the isolated bridge',async()=>{
  const h=setup();await h.pair();await h.start();await selectedFile(h);
  const state=await h.controller.handle({type:'helper:state',tabId:7},h.popup);
  assert.equal(state.capture.adapterAvailable,true);assert.deepEqual(state.capture.files,[{id:'file_A',name:'movie.mkv',size:4096}]);
  assert.doesNotMatch(JSON.stringify(state),/PRIVATE_OLD_URL|PRIVATE_TOKEN/);
  assert.equal((await h.controller.handle({type:'helper:detail',tabId:7,fileId:'not-listed'},h.popup)).code,'DETAIL_UNAVAILABLE');
  assert.equal((await h.controller.handle({type:'helper:detail',tabId:7,fileId:'file_A'},h.popup)).ok,true);
  const request=h.messages.at(-1).message;
  assert.equal(request.type,'capture:detail');assert.equal(request.sessionId,SESSION);
  assert.deepEqual(request.file,{id:'file_A',name:'movie.mkv',size:4096});
  assert.equal(h.calls.length,2,'the worker must not directly call a cloud API for the detail action');
});

test('concurrent detail clicks dispatch only once and late/unknown result messages cannot change the selected operation',async()=>{
  const h=setup();await h.pair();await h.start();await selectedFile(h);
  const results=await Promise.all([1,2].map(()=>h.controller.handle({type:'helper:detail',tabId:7,fileId:'file_A'},h.popup)));
  assert.equal(results.filter(result=>result.ok).length,1);assert.equal(results.find(result=>!result.ok).code,'DETAIL_BUSY');
  assert.equal(h.messages.filter(item=>item.message.type==='capture:detail').length,1);
  await h.controller.handle({type:'capture:detail-result',sessionId:SESSION,operationId:'old',fileId:'file_A',code:'DETAIL_READY'},h.bridge);
  assert.equal(h.session.values['clip-capture-7'].detail.status,'running');
  const malformed=await h.controller.handle({type:'capture:detail-result',sessionId:SESSION,operationId:SESSION,fileId:'file_A',code:'PRIVATE_RAW_ERROR'},h.bridge);
  assert.equal(malformed.code,'REQUEST_INVALID');
  await h.controller.handle({type:'capture:detail-result',sessionId:SESSION,operationId:SESSION,fileId:'file_A',code:'DETAIL_READY'},h.bridge);
  assert.equal(h.session.values['clip-capture-7'].detail.status,'ready');
  await h.controller.handle({type:'helper:stop',tabId:7},h.popup);
  await h.controller.handle({type:'capture:detail-result',sessionId:SESSION,operationId:SESSION,fileId:'file_A',code:'DETAIL_READY'},h.bridge);
  assert.equal(h.session.values['clip-capture-7'].active,false);
});

test('pairing-page handshake requires exact top-frame loopback URL and the actual current tab',async()=>{
  const h=setup();h.tab.url=PAIRING;
  const sender={id:EXTENSION,frameId:0,url:PAIRING,tab:{id:7,url:PAIRING}};
  for(const changed of [{frameId:1},{url:'https://pan.xunlei.com/'},{tab:{id:7,url:PAIRING.replace(TOKEN,'c'.repeat(64))}},{id:'other-extension'}]){
    assert.equal((await h.controller.handle({type:'helper:pair-page',pairingUrl:PAIRING},{...sender,...changed})).code,'REQUEST_INVALID');
  }
  assert.equal(h.calls.length,0);
  h.tab.url='https://pan.baidu.com/';
  assert.equal((await h.controller.handle({type:'helper:pair-page',pairingUrl:PAIRING},sender)).code,'PAGE_CHANGED');
  h.tab.url=PAIRING;
  assert.equal((await h.controller.handle({type:'helper:pair-page',pairingUrl:PAIRING},sender)).ok,true);
  assert.deepEqual(h.session.values.pairing,{origin:ORIGIN,token:TOKEN});assert.deepEqual(h.local.values,{});
});

test('same pairing keeps active observation while an explicitly confirmed new pairing stops old observation',async()=>{
  const h=setup();await h.pair();await h.start();await h.pair();
  assert.equal(h.session.values['clip-capture-7'].active,true);
  const next=`http://127.0.0.1:43101/browser-pair#${'c'.repeat(64)}`;
  assert.equal((await h.controller.handle({type:'helper:pair',pairingUrl:next},h.popup)).ok,true);
  assert.equal(h.session.values['clip-capture-7'],undefined);
  assert.equal(h.session.values.pairing.origin,'http://127.0.0.1:43101');
  assert.equal(h.messages.at(-1).message.type,'capture:stop');
});
