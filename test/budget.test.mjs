import test from 'node:test';
import assert from 'node:assert/strict';
import { estimateReadBudget } from '../public/budget.mjs';

const MIB = 1024 * 1024;
const source = {
  sizeBytes: 1024 * MIB, durationSeconds: 100,
  startSeconds: 20, endSeconds: 30, handlesSeconds: 0,
};

test('one minute of a high bitrate movie includes both handles and recommends a bounded margin', () => {
  const result = estimateReadBudget({
    sizeBytes: Math.round(18.7 * 1024 ** 3), durationSeconds: 5904,
    startSeconds: 5160, endSeconds: 5220, handlesSeconds: 10,
  });
  assert(Math.abs(result.estimatedBytes / MIB - 259.47) < 0.01);
  assert.equal(result.recommendedMiB, 1024);
  assert.equal(result.exceedsLimit, false);
});

test('recommendation has a 256 MiB floor and advances to the next power of two', () => {
  assert.deepEqual(estimateReadBudget({ ...source, sizeBytes: MIB }), {
    estimatedBytes: Math.ceil(MIB / 10), recommendedMiB: 256, exceedsLimit: false,
  });
  assert.equal(estimateReadBudget({ ...source, sizeBytes: 960 * MIB }).recommendedMiB, 256);
  assert.equal(estimateReadBudget({ ...source, sizeBytes: 961 * MIB }).recommendedMiB, 512);
});

test('handles are clipped at the beginning and end of the source', () => {
  const beginning = estimateReadBudget({ ...source, startSeconds: 0, endSeconds: 5, handlesSeconds: 10 });
  assert.equal(beginning.estimatedBytes, Math.ceil(source.sizeBytes * 0.15));
  const ending = estimateReadBudget({ ...source, startSeconds: 90, endSeconds: 100, handlesSeconds: 10 });
  assert.equal(ending.estimatedBytes, Math.ceil(source.sizeBytes * 0.2));
  const whole = estimateReadBudget({ ...source, startSeconds: 0, endSeconds: 100, handlesSeconds: 300 });
  assert.equal(whole.estimatedBytes, source.sizeBytes);
});

test('recommendation caps at 65536 MiB and marks estimates beyond that limit', () => {
  const atLimit = estimateReadBudget({ ...source, sizeBytes: 32736 * MIB, startSeconds: 0, endSeconds: 100 });
  assert.equal(atLimit.recommendedMiB, 65536);
  assert.equal(atLimit.exceedsLimit, false);
  const beyond = estimateReadBudget({ ...source, sizeBytes: Number.MAX_SAFE_INTEGER, startSeconds: 0, endSeconds: 100 });
  assert.equal(beyond.recommendedMiB, 65536);
  assert.equal(beyond.exceedsLimit, true);
  assert.equal(beyond.estimatedBytes, Number.MAX_SAFE_INTEGER);
});

test('only valid ranges of at most ten minutes including handles can be estimated', () => {
  assert(estimateReadBudget({ ...source, durationSeconds: 1000, startSeconds: 10, endSeconds: 590, handlesSeconds: 10 }));
  assert.equal(estimateReadBudget({ ...source, durationSeconds: 1000, startSeconds: 10, endSeconds: 590.01, handlesSeconds: 10 }), null);
  for (const changes of [
    { startSeconds: -1 }, { startSeconds: 30 }, { startSeconds: 31 },
    { startSeconds: 100, endSeconds: 101 }, { endSeconds: 100.2 },
    { handlesSeconds: -1 }, { handlesSeconds: 300.01 },
    { durationSeconds: 0 }, { durationSeconds: -10 },
    { sizeBytes: 0 }, { sizeBytes: -1 }, { sizeBytes: 0.5 }, { sizeBytes: Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.equal(estimateReadBudget({ ...source, ...changes }), null, JSON.stringify(changes));
});

test('nonfinite, missing and nonnumeric metadata do not produce a recommendation', () => {
  for (const key of Object.keys(source)) {
    for (const value of [NaN, Infinity, -Infinity, undefined, null, '10']) {
      assert.equal(estimateReadBudget({ ...source, [key]: value }), null, `${key}: ${value}`);
    }
  }
  for (const input of [undefined, null, false, '', {}, []]) assert.equal(estimateReadBudget(input), null);
});

test('selecting one output track does not discount the whole-container input estimate', () => {
  const baseline = estimateReadBudget(source);
  assert.deepEqual(estimateReadBudget({
    ...source, audioStreamIndex: 3, streams: [{ type: 'audio', bitrate: 128000 }],
  }), baseline);
});
