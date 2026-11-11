import test from 'node:test';
import assert from 'node:assert/strict';
import '../capture-core.js';
const Core = globalThis.ClipFetcherCaptureCore;
const original = 'https://download.example.test/original.mkv?signature=SYNTHETIC_PRIVATE_URL';

test('only the two intended official page origins can initiate capture', () => {
  assert.equal(Core.providerForPage('https://pan.xunlei.com/?token=private#folder'), 'xunlei');
  assert.equal(Core.providerForPage('https://pan.baidu.com/disk/main'), 'baidu');
  for (const value of ['http://pan.baidu.com/', 'https://evil.pan.baidu.com/', 'https://pan.baidu.com.evil.test/',
    'https://user:pass@pan.xunlei.com/', 'https://pan.xunlei.com:8443/', 'file:///tmp/a', 'https://pan.quark.cn/'])
    assert.equal(Core.providerForPage(value), null);
  assert.equal(Core.publicPageUrl('https://pan.baidu.com/disk/main?secret=private#file=private'), 'https://pan.baidu.com/disk/main');
});

test('pairing accepts only a bounded explicit loopback origin and exact capability URL', () => {
  const good = `http://127.0.0.1:43100/browser-pair#${'a'.repeat(64)}`;
  assert.deepEqual(Core.parsePairingUrl(good), { origin: 'http://127.0.0.1:43100', token: 'a'.repeat(64) });
  for (const value of [good.replace('127.0.0.1', 'localhost'), good.replace('127.0.0.1', 'evil.test'),
    good.replace('http:', 'https:'), good.replace('/browser-pair', '/other'), good.replace('#', '?secret=#'),
    good.slice(0,-1), good.replace('127.0.0.1', 'user@127.0.0.1'), good.replace(':43100', '')])
    assert.throws(() => Core.parsePairingUrl(value), /PAIRING_INVALID/);
  assert.throws(() => Core.checkedPairing({ origin: 'http://127.0.0.1:43100/other', token: 'a'.repeat(64) }), /PAIRING_INVALID/);
});

test('original metadata hints survive nested files while playback and credential fields stay out', () => {
  const payload = { files: [
    { name: '测试电影.mkv', size: '77098924052', web_content_link: original,
      cookie: 'SYNTHETIC_COOKIE', Authorization: 'SYNTHETIC_AUTH', play_url: 'https://cdn.test/preview.mp4',
      medias: [{ link: { url: 'https://cdn.test/transcoded.mp4' } }] },
    { server_filename: '第二部.mkv', size: 1234, dlink: 'https://pcs.example.test/file/a?sign=EXAMPLE' },
    { name: '重复.mkv', web_content_link: { url: original } },
  ], error_description: 'https://cdn.test/error.mkv' };
  const result = Core.metadataCandidates(payload);
  assert.deepEqual(result, [{ url: original, name: '测试电影.mkv', size: 77098924052 },
    { url: 'https://pcs.example.test/file/a?sign=EXAMPLE', name: '第二部.mkv', size: 1234 }]);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_COOKIE|SYNTHETIC_AUTH|preview|transcoded|error\.mkv/);
});

test('raw strings, preview streams, account endpoints and unsafe URLs never become original candidates', () => {
  for (const url of ['blob:https://pan.baidu.com/id', 'http://cdn.test/original.mkv', 'https://cdn.test/a.m3u8',
    'https://cdn.test/a.mpd?sign=x', 'https://cdn.test/a.m4s', 'https://cdn.test/streaming/file',
    'https://cdn.test/a?type=M3U8_AUTO_720', 'https://cdn.test/a?method=streaming',
    'https://user:pass@cdn.test/a.mkv', 'https://127.0.0.1/a.mkv', 'https://api-pan.xunlei.com/drive/v1/files',
    'https://pan.baidu.com/api/download', 'https://cdn.test/a.mkv#private', 'https://cdn.test/a\n.mkv'])
    assert.equal(Core.originalUrl(url), null, url);
  assert.deepEqual(Core.metadataCandidates({ message: original, play_url: original, url: original }), []);
  assert.equal(Core.resourceCandidate('https://cdn.test/piece.ts'), null);
  assert.equal(Core.resourceCandidate('https://cdn.test/player.js'), null);
  assert.equal(Core.resourceCandidate(original).name, 'original.mkv');
});

test('candidate handoff rebuilds allowed headers and removes page secrets and arbitrary supplied headers', () => {
  const payload = Core.candidatePayload({ pageUrl: 'https://pan.xunlei.com/folder?secret=PRIVATE#token=PRIVATE',
    userAgent: 'Chrome Synthetic', candidates: [{ url: original, name: 'movie\n.mkv', size: 4096,
      headers: { Cookie: 'PRIVATE_COOKIE', Authorization: 'PRIVATE_AUTH' }, extra: 'PRIVATE_EXTRA' }, { url: original }] });
  assert.deepEqual(payload, { schemaVersion: 1, provider: 'xunlei', pageUrl: 'https://pan.xunlei.com/folder',
    candidates: [{ url: original, name: 'movie.mkv', size: 4096,
      headers: { 'User-Agent': 'Chrome Synthetic', Referer: 'https://pan.xunlei.com/folder' } }] });
  assert.doesNotMatch(JSON.stringify(payload), /PRIVATE_COOKIE|PRIVATE_AUTH|PRIVATE_EXTRA|secret=|token=/);
});

test('malformed sizes, deep/cyclic responses and oversized batches remain bounded', () => {
  assert.equal(Core.safeSize('9007199254740992'), null);
  assert.equal(Core.safeSize(-1), null);
  const cyclic = { web_content_link: original }; cyclic.child = cyclic;
  assert.equal(Core.metadataCandidates(cyclic).length, 1);
  const candidates = Array.from({ length: 2000 }, (_, i) => ({ url: `https://cdn.test/${i}.mkv?sig=${'a'.repeat(7000)}`,
    name: '中'.repeat(1000), size: 4096 }));
  const payload = Core.candidatePayload({ pageUrl: 'https://pan.baidu.com/', candidates });
  assert.ok(payload.candidates.length <= 12);
  assert.ok(new TextEncoder().encode(JSON.stringify(payload)).byteLength <= 60000);
});

test('the Xunlei adapter only admits exact ordinary-space video identities',()=>{
  const value={id:'file_A',name:'movie.mkv',size:'4096',kind:'drive#file',space:''};
  assert.deepEqual(Core.xunleiFile(value),{id:'file_A',name:'movie.mkv',size:4096});
  for(const changes of [{kind:'drive#folder'},{space:'safebox'},{space:null},{name:'photo.jpg'},{name:'x\n.mkv'},{size:0},{id:'../file'}])
    assert.equal(Core.xunleiFile({...value,...changes}),null);
  assert.equal(Core.sameXunleiFile(Core.xunleiFile(value),{id:'file_A',name:'changed.mkv',size:4096}),false);
});
