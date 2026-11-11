import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatroskaMetadataCache } from '../src/matroska-metadata-cache.mjs';

const identity = (changes = {}) => ({ sourceKey: '1'.repeat(64), size: 1024, etagSha256: '2'.repeat(64), headSha256: '3'.repeat(64), ...changes });

test('metadata cache publishes atomically, owns bytes, and reports only bounded counters', () => {
  const cache = createMatroskaMetadataCache({ maxBytes: 64, maxEntryBytes: 32 });
  const tx = cache.begin(identity()), input = Buffer.from('metadata');
  assert.equal(tx.put(10, input), true);
  input.fill(0);
  assert.equal(cache.begin(identity()).get(10, 8), null);
  assert.equal(tx.commit(), true);
  const read = cache.begin(identity()), output = read.get(10, 8);
  assert.equal(output.toString(), 'metadata');
  output.fill(1);
  assert.equal(read.get(10, 8).toString(), 'metadata');
  assert.equal(read.get(9, 8), null);
  assert.equal(read.get(10, 9), null);
  assert.equal(tx.commit(), false);
  assert.equal(tx.get(10, 8), null);
  assert.deepEqual(cache.stats(), { entries: 1, bytes: 8, committedBytes: 8, stagedBytes: 0, maxBytes: 64, maxEntryBytes: 32 });
  assert.equal(JSON.stringify(cache.stats()).includes('111111'), false);
});

test('metadata ranges merge overlaps and adjacency using their unique physical bytes', () => {
  const cache = createMatroskaMetadataCache({ maxBytes: 32, maxEntryBytes: 16 });
  const tx = cache.begin(identity());
  tx.put(10, Buffer.from('abcdef'));
  tx.put(14, Buffer.from('efgh'));
  tx.put(18, Buffer.from('ij'));
  tx.put(11, Buffer.from('bcd'));
  assert.equal(tx.commit(), true);
  assert.equal(cache.stats().bytes, 10);
  assert.equal(cache.begin(identity()).get(10, 10).toString(), 'abcdefghij');
});

test('metadata cache refuses malformed identities and isolates every strong identity field', () => {
  const cache = createMatroskaMetadataCache();
  for (const bad of [null, {}, identity({ sourceKey: 'url' }), identity({ etagSha256: 'W/"weak"' }), identity({ headSha256: '' }), identity({ size: 0 }), identity({ size: 1.5 })]) {
    assert.equal(cache.begin(bad), null);
  }
  for (const change of [{ sourceKey: '4'.repeat(64) }, { size: 1025 }, { etagSha256: '5'.repeat(64) }, { headSha256: '6'.repeat(64) }]) {
    const tx = cache.begin(identity()); tx.put(0, Buffer.from('valid')); tx.commit();
    assert.equal(cache.begin(identity(change)).get(0, 5), null);
  }
});

test('entry overflow skips publication and global eviction follows successful LRU reads', () => {
  const cache = createMatroskaMetadataCache({ maxBytes: 12, maxEntryBytes: 8 });
  const tx = cache.begin(identity());
  assert.equal(tx.put(0, Buffer.alloc(8)), true);
  assert.equal(tx.put(8, Buffer.alloc(1)), false);
  assert.equal(tx.commit(), false);
  assert.equal(cache.stats().entries, 0);
  const a = identity(), b = identity({ sourceKey: 'b'.repeat(64) }), c = identity({ sourceKey: 'c'.repeat(64) });
  for (const id of [a, b]) { const put = cache.begin(id); put.put(0, Buffer.alloc(6)); assert(put.commit()); }
  assert(cache.begin(a).get(0, 6));
  const put = cache.begin(c); put.put(0, Buffer.alloc(6)); assert(put.commit());
  assert.equal(cache.begin(b).get(0, 6), null);
  assert(cache.begin(a).get(0, 6)); assert(cache.begin(c).get(0, 6));
  assert.equal(cache.stats().bytes, 12);
});

test('invalidating or clearing also prevents an in-flight transaction from resurrecting stale bytes', () => {
  const cache = createMatroskaMetadataCache();
  const first = cache.begin(identity()); first.put(0, Buffer.from('old')); first.commit();
  const stale = cache.begin(identity()); stale.put(0, Buffer.from('old'));
  cache.invalidate(identity().sourceKey);
  assert.equal(stale.get(0, 3), null);
  assert.equal(stale.commit(), false);
  assert.equal(cache.stats().bytes, 0);
  const pending = cache.begin(identity()); pending.put(0, Buffer.from('next'));
  cache.clear();
  assert.equal(pending.commit(), false);
  const discarded = cache.begin(identity()); discarded.put(0, Buffer.from('lost')); discarded.discard();
  assert.equal(discarded.commit(), false);
  assert.equal(cache.stats().entries, 0);
});

test('range validation and identity replacement do not leak or revive old entries', () => {
  const cache = createMatroskaMetadataCache();
  const tx = cache.begin(identity());
  for (const [position, bytes] of [[-1, Buffer.alloc(1)], [1024, Buffer.alloc(1)], [0, Buffer.alloc(0)], [0, new Uint8Array(1)], [NaN, Buffer.alloc(1)]]) {
    assert.equal(tx.put(position, bytes), false);
  }
  tx.put(10, Buffer.from('verified')); tx.commit();
  const old = cache.begin(identity()); old.put(10, Buffer.from('verified'));
  const changed = cache.begin(identity({ etagSha256: '7'.repeat(64) }));
  assert.equal(cache.stats().entries, 0);
  assert.equal(old.get(10, 8), null);
  assert.equal(old.commit(), false);
  changed.put(10, Buffer.from('new')); assert(changed.commit());
  assert.equal(cache.begin(identity()).get(10, 3), null);
  assert.throws(() => createMatroskaMetadataCache({ maxBytes: 1, maxEntryBytes: 2 }), RangeError);
});

test('default 4 MiB entries and 16 MiB global boundary are enforced with real byte buffers', () => {
  const MiB = 1024 * 1024, cache = createMatroskaMetadataCache();
  const large = number => identity({ sourceKey: number.toString(16).repeat(64), size: 5 * MiB });
  for (let number = 1; number <= 4; number++) {
    const tx = cache.begin(large(number));
    assert(tx.put(0, Buffer.alloc(4 * MiB, number))); assert(tx.commit());
  }
  assert.equal(cache.stats().bytes, 16 * MiB);
  const evicted = cache.begin(large(1));
  const fifth = cache.begin(large(5)); fifth.put(0, Buffer.alloc(4 * MiB, 5)); assert(fifth.commit());
  assert.equal(cache.stats().bytes, 16 * MiB); assert.equal(cache.stats().entries, 4);
  assert.equal(evicted.get(0, 1), null, 'an open transaction cannot retain an evicted Buffer');
  const oversized = cache.begin(large(6));
  assert.equal(oversized.put(0, Buffer.alloc(4 * MiB + 1)), false);
  assert.equal(oversized.commit(), false);
  assert.equal(cache.stats().bytes, 16 * MiB);
  cache.clear(); assert.equal(cache.stats().bytes, 0);
});

test('concurrent staged metadata shares the global allowance and clear releases every pending owner', () => {
  const cache = createMatroskaMetadataCache({ maxBytes: 16, maxEntryBytes: 8 });
  const a = cache.begin(identity()), b = cache.begin(identity({ sourceKey: 'b'.repeat(64) }));
  assert(a.put(0, Buffer.alloc(8))); assert(b.put(0, Buffer.alloc(8)));
  assert.deepEqual(cache.stats(), { entries: 0, bytes: 16, committedBytes: 0, stagedBytes: 16, maxBytes: 16, maxEntryBytes: 8 });
  const c = cache.begin(identity({ sourceKey: 'c'.repeat(64) }));
  assert.equal(c.put(0, Buffer.alloc(1)), false);
  assert.equal(c.commit(), false); assert.equal(cache.stats().bytes, 16);
  assert(a.commit());
  assert.equal(cache.stats().committedBytes, 8); assert.equal(cache.stats().stagedBytes, 8);
  cache.clear(); assert.equal(cache.stats().bytes, 0);
  assert.equal(b.commit(), false); assert.equal(b.put(0, Buffer.alloc(1)), false);
  const d = cache.begin(identity()); d.put(0, Buffer.alloc(8));
  cache.invalidate(identity().sourceKey); assert.equal(cache.stats().stagedBytes, 0);
  assert.equal(d.commit(), false);
});
