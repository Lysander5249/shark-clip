import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeClipName, defaultClipName, CLIP_NAME_MAX_BYTES } from '../public/clip-options.mjs';

test('user names become a single cross-platform stem, with extensions managed by the tool', () => {
  assert.equal(sanitizeClipName('  片段 一  .MKV  '), '片段 一');
  assert.equal(sanitizeClipName('../secret/镜头.mp4'), '镜头');
  assert.equal(sanitizeClipName('C:\\素材\\镜头.mKv'), '镜头');
  assert.equal(sanitizeClipName('clip.mkv.json'), 'clip');
  assert.equal(sanitizeClipName('a:b?c*d<e>f|g"h'), 'a_b_c_d_e_f_g_h');
  assert.equal(sanitizeClipName('v1.2 scene'), 'v1.2 scene');
  assert.equal(sanitizeClipName('.hidden...  '), 'hidden');
});

test('reserved DOS device names remain safe even with suffixes and trailing spaces', () => {
  for (const name of ['CON', 'nul', 'PRN', 'AUX', 'COM1', 'lpt9', 'COM¹', 'LPT²']) {
    assert.equal(sanitizeClipName(name + '.mkv'), '_' + name);
    assert.equal(sanitizeClipName(name + ' .notes'), '_' + name + ' .notes');
  }
  assert.equal(sanitizeClipName('console'), 'console');
  assert.equal(sanitizeClipName('COM10'), 'COM10');
});

test('normalization preserves ordinary Unicode and complete emoji while removing invisible overrides', () => {
  assert.equal(sanitizeClipName('Cafe\u0301 🎬'), 'Café 🎬');
  assert.equal(sanitizeClipName('a\u202eb\u200bc'), 'abc');
  assert.equal(sanitizeClipName('镜头\ud800😀\udc00'), '镜头😀');
  const value = sanitizeClipName('😀汉'.repeat(100));
  assert.ok(Buffer.byteLength(value) <= CLIP_NAME_MAX_BYTES);
  assert.doesNotMatch(value, /\p{Surrogate}/u);
});

test('empty or unusable values are explicit and never become paths', () => {
  for (const value of [undefined, null, 42, {}, '', '   ', '.', '..', '/\\', '.mkv']) assert.equal(sanitizeClipName(value), '');
  for (const value of ['..\\..\\CON.mkv', '../../clip', '/etc/passwd']) {
    const name = sanitizeClipName(value);
    assert.ok(name && !/[\\/:]/.test(name));
    assert.notEqual(name, '.'); assert.notEqual(name, '..');
  }
});

test('default name uses user interval and keeps fractional precision through microseconds', () => {
  assert.equal(defaultClipName('银翼杀手2049.mkv', 6585, 6665), '银翼杀手2049_01-49-45_01-51-05');
  assert.equal(defaultClipName('场景.MP4', 5.25, 65.123456), '场景_00-00-05.25_00-01-05.123456');
  assert.equal(defaultClipName('场景.mkv', 59.9999996, 360000), '场景_00-01-00_100-00-00');
  assert.equal(defaultClipName('', NaN, undefined), '电影_00-00-00_00-00-00');
});

test('default title only trims explicit release metadata and keeps meaningful title years or brackets', () => {
  assert.equal(defaultClipName('Blade.Runner.2049.2017.Hybrid.2160p.UHD.Blu-ray.Remux.HEVC.mkv', 0, 1), 'Blade Runner 2049 2017_00-00-00_00-00-01');
  assert.equal(defaultClipName('【高清影视之家发布 www.example.com】电影.2024.1080p.BluRay.mkv', 0, 1), '电影 2024_00-00-00_00-00-01');
  assert.equal(defaultClipName('[REC].2007.1080p.BluRay.mkv', 0, 1), '[REC] 2007_00-00-00_00-00-01');
  assert.equal(defaultClipName('2001.A.Space.Odyssey.mkv', 0, 1), '2001.A.Space.Odyssey_00-00-00_00-00-01');
  assert.equal(defaultClipName('The.Year.2000.mkv', 0, 1), 'The.Year.2000_00-00-00_00-00-01');
});

test('long suggested names always retain both time boundaries within the component budget', () => {
  const value = defaultClipName('电影'.repeat(100) + '.mkv', 6585.123456, 6665.654321);
  assert.ok(Buffer.byteLength(value) <= CLIP_NAME_MAX_BYTES);
  assert.ok(value.endsWith('_01-49-45.123456_01-51-05.654321'));
  assert.equal(value, sanitizeClipName(value));
});
