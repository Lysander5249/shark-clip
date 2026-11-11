import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { openResumeStore, listResumeStores, discardResumeStore, resumePlanHash, resumeIdentityHash } from '../src/resume-store.mjs';

const CHUNK = 1024 * 1024;
const hash = text => createHash('sha256').update(text).digest('hex');
const source = { sourceKey: hash('locator'), size: 10 * CHUNK, etagSha256: hash('"strong-version"'), headSha256: hash('verified-head') };
const plan = { version: 1, sourceStart: CHUNK, sourceEnd: 3 * CHUNK + 17, prefixSha256: hash('mkv-prefix'), timelineStartSeconds: 100, timelineEndSeconds: 160 };
const config = directory => ({ directory, id: 'clip-resume-fixture', identity: source, plan, budgetBytes: 5 * CHUNK, initialReceivedBytes: 1024, initialRequests: 2 });
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'clip-resume-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
const isCode = expected => error => { assert.equal(error.code, expected); return true; };

test('completed exact chunks and numeric accounting survive close/reopen, without trusting in-memory snapshots', async t => {
  const directory = await fixture(t), options = config(directory), store = await openResumeStore(options);
  const bytes = Buffer.alloc(CHUNK, 0x35), tail = Buffer.alloc(17, 0x67);
  const first = await store.reserve(CHUNK); await store.settle(first, CHUNK); await store.put(plan.sourceStart, bytes);
  const last = await store.reserve(17); await store.settle(last, 17); await store.put(plan.sourceEnd - 17, tail);
  const before = store.snapshot();
  assert.equal(before.receivedBytes, CHUNK + 17 + 1024); assert.equal(before.requests, 4);
  assert.equal(before.cachedBytes, CHUNK + 17); assert.equal(before.chargedBytes, before.receivedBytes);
  assert.equal(before.remainingBytes, options.budgetBytes - before.receivedBytes);
  assert.equal(store.has(plan.sourceStart, CHUNK), true); assert.equal(store.has(plan.sourceStart, CHUNK - 1), false);
  assert.equal(await store.get(2 * CHUNK, CHUNK), null);
  before.identity.sourceKey = 'unsafe'; before.ranges[0].sha256 = 'unsafe';
  await store.close();
  const reopened = await openResumeStore({ ...options, plan: undefined, initialReceivedBytes: 999999, initialRequests: 999 });
  t.after(() => reopened.close());
  assert.deepEqual(await reopened.get(plan.sourceStart, CHUNK), bytes); assert.deepEqual(await reopened.get(plan.sourceEnd - 17, 17), tail);
  assert.equal(reopened.snapshot().receivedBytes, CHUNK + 17 + 1024, 'initial counters apply only when first creating a store');
  assert.equal(reopened.snapshot().identity.sourceKey, source.sourceKey);
  assert.deepEqual((await listResumeStores({ directory }))[0], reopened.snapshot());
  assert.equal((await readdir(path.join(directory, options.id))).some(name => name.endsWith('.tmp')), false);
});

test('a process crash preserves committed chunks and charges an unresolved reservation conservatively', async t => {
  const directory = await fixture(t), options = config(directory);
  const moduleURL = new URL('../src/resume-store.mjs', import.meta.url).href;
  const script = `import { openResumeStore } from ${JSON.stringify(moduleURL)};
    const store = await openResumeStore(${JSON.stringify(options)});
    const completed = await store.reserve(${CHUNK}); await store.settle(completed, ${CHUNK});
    await store.put(${plan.sourceStart}, Buffer.alloc(${CHUNK}, 42));
    await store.reserve(7777);
    process.exit(0);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', resolve); });
  assert.equal(exit, 0, stderr);
  const reopened = await openResumeStore(options); t.after(() => reopened.close());
  const saved = reopened.snapshot();
  assert.equal(saved.uncertainBytes, 7777); assert.equal(saved.reservedBytes, 0);
  assert.equal(saved.receivedBytes, CHUNK + 1024); assert.equal(saved.chargedBytes, CHUNK + 1024 + 7777);
  assert.equal(saved.requests, 4); assert.deepEqual(await reopened.get(plan.sourceStart, CHUNK), Buffer.alloc(CHUNK, 42));
  await reopened.close();
  const again = await openResumeStore(options); t.after(() => again.close());
  assert.equal(again.snapshot().uncertainBytes, 7777, 'a subsequent restart must not double charge an already recovered reservation');
});

test('parallel reservations cannot overrun the cap and failed reads charge only received bytes when settled', async t => {
  const directory = await fixture(t), store = await openResumeStore({ ...config(directory), budgetBytes: 2048, initialReceivedBytes: 0 });
  t.after(() => store.close());
  const results = await Promise.allSettled([store.reserve(1536), store.reserve(1536)]);
  assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.code, 'BUDGET_EXCEEDED');
  assert.equal(store.snapshot().remainingBytes, 512);
  await store.settle(results[0].value, 400);
  assert.equal(store.snapshot().chargedBytes, 400); assert.equal(store.snapshot().remainingBytes, 1648);
  await assert.rejects(store.settle(results[0].value, 400), isCode('RESUME_INVALID'));
  const ticket = await store.reserve(1648);
  await assert.rejects(store.settle(ticket, 1649), isCode('RESUME_INVALID'));
  await store.settle(ticket, 1648);
  await assert.rejects(store.reserve(1), isCode('BUDGET_EXCEEDED'));
});

test('fresh identity, plan and budget mismatches refuse reuse, leaving the original checkpoint intact', async t => {
  const directory = await fixture(t), options = config(directory), store = await openResumeStore(options);
  await store.close();
  for (const change of [
    { identity: { ...source, sourceKey: hash('different-account-or-locator') } },
    { identity: { ...source, size: source.size + 1 } },
    { identity: { ...source, etagSha256: hash('different-version') } },
    { identity: { ...source, headSha256: hash('different-head') } },
    { plan: { ...plan, sourceStart: plan.sourceStart + 1 } },
    { plan: { ...plan, prefixSha256: hash('different-prefix') } },
    { plan: { ...plan, timelineEndSeconds: 161 } },
    { budgetBytes: options.budgetBytes + 1 },
    { maxCacheBytes: CHUNK },
  ]) await assert.rejects(openResumeStore({ ...options, ...change }), isCode('RESUME_CHANGED'));
  const reopened = await openResumeStore(options); t.after(() => reopened.close());
  assert.equal(reopened.snapshot().identity.etagSha256, source.etagSha256);
  assert.equal(resumePlanHash({ ...plan, privateToken: 'secret' }), resumePlanHash(plan));
  assert.equal(resumeIdentityHash({ ...source, password: 'secret' }), resumeIdentityHash(source));
});

test('every cached read and restart verify bytes and length, rejecting corrupt media instead of returning it', async t => {
  const directory = await fixture(t), options = config(directory), store = await openResumeStore(options);
  await store.put(plan.sourceStart, Buffer.alloc(CHUNK, 22));
  const filename = path.join(directory, options.id, `${plan.sourceStart}-${CHUNK}.bin`);
  await writeFile(filename, Buffer.alloc(CHUNK, 23));
  await assert.rejects(store.get(plan.sourceStart, CHUNK), isCode('RESUME_CORRUPT'));
  await store.close();
  await assert.rejects(openResumeStore(options), isCode('RESUME_CORRUPT'));
  await writeFile(filename, Buffer.alloc(CHUNK - 1, 22));
  await assert.rejects(openResumeStore(options), isCode('RESUME_CORRUPT'));
  await rm(filename);
  await assert.rejects(openResumeStore(options), error => ['RESUME_CORRUPT', 'ENOENT'].includes(error.code));
  assert.equal(await discardResumeStore({ directory, id: options.id }), true, 'explicit discard works even with damaged media');
});

test('only fixed target chunks can be committed, cache quota is enforced, duplicate data is idempotent', async t => {
  const directory = await fixture(t), store = await openResumeStore({ ...config(directory), maxCacheBytes: CHUNK });
  t.after(() => store.close());
  for (const [offset, bytes] of [[0, CHUNK], [plan.sourceStart + 1, CHUNK], [plan.sourceStart, 1], [plan.sourceEnd, 17], [plan.sourceEnd - 17, 16]]) {
    await assert.rejects(store.put(offset, Buffer.alloc(bytes)), isCode('RESUME_CORRUPT'));
  }
  const data = Buffer.alloc(CHUNK, 33);
  await store.put(plan.sourceStart, data); await store.put(plan.sourceStart, data);
  assert.equal(store.snapshot().ranges.length, 1); assert.equal(store.snapshot().cachedBytes, CHUNK);
  await assert.rejects(store.put(plan.sourceStart, Buffer.alloc(CHUNK, 34)), isCode('RESUME_CHANGED'));
  await assert.rejects(store.put(2 * CHUNK, data), isCode('RESUME_QUOTA'));
});

test('live writers and in-flight reservations prevent unsafe discard; idle explicit discard frees only that task', async t => {
  const directory = await fixture(t), options = config(directory), store = await openResumeStore(options);
  const other = await openResumeStore({ ...options, id: 'unrelated-task' }); await other.close();
  await assert.rejects(openResumeStore(options), isCode('RESUME_BUSY'));
  await assert.rejects(discardResumeStore({ directory, id: options.id }), isCode('RESUME_BUSY'));
  const ticket = await store.reserve(100);
  await assert.rejects(store.discard(), isCode('RESUME_BUSY'));
  await store.settle(ticket, 20); await store.discard();
  assert.deepEqual((await listResumeStores({ directory })).map(item => item.id), ['unrelated-task']);
  await assert.rejects(store.reserve(1), isCode('RESUME_CLOSED'));
  assert.equal(await discardResumeStore({ directory, id: options.id }), false);
  assert.equal(await discardResumeStore({ directory, id: 'unrelated-task' }), true);
});

test('manifest fields use explicit numeric/hash whitelists, never storing authentication or raw server strings', async t => {
  const directory = await fixture(t), options = config(directory);
  const privateFields = { password: 'private-password', username: 'private-user', url: 'https://private.invalid/?token=private-token',
    etag: '"private-server-tag"', metadata: { Authorization: 'Bearer private-authorization' } };
  const store = await openResumeStore({ ...options, ...privateFields, identity: { ...source, ...privateFields }, plan: { ...plan, ...privateFields } });
  await store.close();
  const text = await readFile(path.join(directory, options.id, 'manifest.json'), 'utf8');
  assert(!/private-|https:|password|username|Authorization|metadata|"etag"/.test(text));
  assert.deepEqual(Object.keys(JSON.parse(text).identity).sort(), ['etagSha256', 'headSha256', 'size', 'sourceKey']);
  for (const identity of [{ ...source, etagSha256: null }, { ...source, sourceKey: 'https://signed.invalid' }, { ...source, headSha256: 'weak-head' }]) {
    await assert.rejects(openResumeStore({ ...options, identity }), isCode('RESUME_INVALID'));
  }
  await assert.rejects(openResumeStore({ ...options, identity: { ...source, sourceKey: { password: 'private-value', toString: () => source.sourceKey } } }), isCode('RESUME_INVALID'));
});

test('malformed manifests are listed safely, then can be explicitly discarded; paths and symbolic links cannot escape the cache', async t => {
  const directory = await fixture(t), options = config(directory), store = await openResumeStore(options); await store.close();
  await writeFile(path.join(directory, options.id, 'manifest.json'), '{broken-private-token');
  const [record] = await listResumeStores({ directory });
  assert.deepEqual(record, { id: options.id, error: { code: 'RESUME_CORRUPT' } });
  await assert.rejects(openResumeStore(options), isCode('RESUME_CORRUPT'));
  for (const id of ['..', '../outside', '/absolute', '', 'bad/name']) {
    await assert.rejects(openResumeStore({ ...options, id }), isCode('RESUME_INVALID'));
    await assert.rejects(discardResumeStore({ directory, id }), isCode('RESUME_INVALID'));
  }
  const outside = await fixture(t), marker = path.join(outside, 'marker'); await writeFile(marker, 'keep');
  await symlink(outside, path.join(directory, 'linked-task'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(openResumeStore({ ...options, id: 'linked-task' }), isCode('RESUME_INVALID'));
  await assert.rejects(discardResumeStore({ directory, id: 'linked-task' }), isCode('RESUME_INVALID'));
  assert.equal(await readFile(marker, 'utf8'), 'keep');
});

test('orphan writes are never adopted as verified chunks after restart', async t => {
  const directory = await fixture(t), options = config(directory), store = await openResumeStore(options); await store.close();
  const task = path.join(directory, options.id), orphan = `${plan.sourceStart}-${CHUNK}.bin`, temporary = '.write-11111111-1111-1111-1111-111111111111.tmp';
  await writeFile(path.join(task, orphan), Buffer.alloc(CHUNK, 99)); await writeFile(path.join(task, temporary), 'incomplete');
  const reopened = await openResumeStore(options); t.after(() => reopened.close());
  assert.equal(reopened.has(plan.sourceStart, CHUNK), false); assert.equal(await reopened.get(plan.sourceStart, CHUNK), null);
  assert.equal((await readdir(task)).includes(orphan), false); assert.equal((await readdir(task)).includes(temporary), false);
});
