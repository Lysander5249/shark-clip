import test from 'node:test';
import assert from 'node:assert/strict';
import { providers, prepareMagnet, ProviderError } from '../src/providers.mjs';

const hash = '0123456789abcdef0123456789abcdef01234567';
const magnet = `magnet:?xt=urn:btih:${hash}`;
const prepare = value => prepareMagnet({ providerId: 'xunlei', magnet: value });
const invalid = code => error => error instanceof ProviderError && error.code === code;

test('provider list distinguishes verified Xunlei from unverified Baidu and manual imports', () => {
  assert.deepEqual(providers.map(({ id, availability }) => ({ id, availability })), [
    { id: 'xunlei', availability: 'verified' },
    { id: 'baidu', availability: 'needs-verification' },
  ]);
  for (const provider of providers) {
    assert.equal(provider.bridgeSupported, true);
    assert.equal(provider.magnetImport, 'manual');
    assert.equal(new URL(provider.cloudUrl).protocol, 'https:');
    assert.ok(provider.steps.length >= 3);
    assert.ok(Object.isFrozen(provider.steps));
    assert.ok(Object.isFrozen(provider));
  }
  assert.ok(Object.isFrozen(providers));
  assert.match(providers[1].note, /尚未/);
  assert.match(providers[1].steps[0], /不保证任意账号/);
});

test('valid hex topic preserves trackers and decodes a bounded display name without submitting', () => {
  const input = `${magnet.toUpperCase().replace('MAGNET:', 'magnet:').replace('?XT=', '?xt=')}&dn=${encodeURIComponent('示例 视频.mkv')}&tr=${encodeURIComponent('https://tracker.example/announce')}`;
  const result = prepare(input);
  assert.equal(result.infoHash, hash);
  assert.equal(result.displayName, '示例 视频.mkv');
  assert.equal(result.providerId, 'xunlei');
  assert.equal(result.automaticImport, false);
  assert.equal(result.cloudUrl, 'https://pan.xunlei.com/');
  assert.equal(new URL(result.magnet).searchParams.get('tr'), 'https://tracker.example/announce');
});

test('base32 BTIH converts to the same canonical 40-character hex hash', () => {
  // Independent RFC 4648 test vector: ASCII "foob" is MZXW6YQ=.
  // The 20-byte input below consists of five "foob" blocks.
  const base32 = 'MZXW6YTGN5XWEZTPN5RGM33PMJTG633C';
  assert.equal(prepare(`magnet:?xt=urn:btih:${base32}`).infoHash, Buffer.from('foobfoobfoobfoobfoob').toString('hex'));
  assert.equal(prepare(`magnet:?xt=urn:btih:${base32.toLowerCase()}`).infoHash, Buffer.from('foobfoobfoobfoobfoob').toString('hex'));
  assert.equal(prepare('magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').infoHash, '0'.repeat(40));
  assert.equal(prepare('magnet:?xt=urn:btih:77777777777777777777777777777777').infoHash, 'f'.repeat(40));
});

test('Baidu preparation only returns manual instructions and isolated copies', () => {
  const result = prepareMagnet({ providerId: 'baidu', magnet });
  assert.equal(result.providerId, 'baidu');
  assert.equal(result.displayName, hash);
  assert.equal(result.automaticImport, false);
  assert.match(result.instructions.join('\n'), /如不支持/);
  result.instructions.push('caller changes do not alter definitions');
  assert.equal(providers[1].steps.length, 4);
});

test('unknown provider IDs are rejected before preparing a URL', () => {
  for (const providerId of ['quark', 'https://example.org', '__proto__', '', null, undefined]) {
    assert.throws(() => prepareMagnet({ providerId, magnet }), invalid('PROVIDER_INVALID'));
  }
});

test('missing, ambiguous, malformed or unsupported magnet topics are rejected', () => {
  for (const input of [undefined, null, 123, {}, '', 'https://example.org/', 'file:///tmp/example',
    `magnet://example.org?xt=urn:btih:${hash}`, `magnet:video?xt=urn:btih:${hash}`,
    'magnet:?dn=no-topic', 'magnet:?xt=urn:btmh:1220abc', 'magnet:?xt=urn:btih:abc',
    `magnet:?XT=urn:btih:${hash}`, `${magnet}&xt=urn:btih:${hash}`,
    `${magnet}&xt=urn:sha1:abc`, `magnet:?xt=urn:btih:${'g'.repeat(40)}`,
    `magnet:?xt=urn:btih:${'0'.repeat(32)}`, `${magnet}#fragment`,
    `${magnet}&dn=broken%`, `${magnet}&dn=invalid%C0%AF`]) {
    assert.throws(() => prepare(input), invalid('MAGNET_INVALID'), String(input));
  }
});

test('literal and encoded controls, surrounding whitespace and oversized input are rejected', () => {
  for (const input of [` ${magnet}`, `${magnet} `, `${magnet}\n`,
    `${magnet}&dn=bad\u0000name`, `${magnet}&dn=bad\u0085name`,
    `${magnet}&dn=bad%0aname`, `${magnet}&dn=bad%C2%85name`,
    `${magnet}&%0akey=value`, `${magnet}&dn=${'a'.repeat(8192)}`]) {
    assert.throws(() => prepare(input), invalid('MAGNET_INVALID'));
  }
});
