import test from 'node:test';
import assert from 'node:assert/strict';
import { mediaProgress, applyJobProgress } from '../src/progress.mjs';

test('received bytes alone cannot establish media timeline progress', () => {
  for (const out_time_us of [undefined, null, '', 'N/A', '0', '-1000000', 'NaN', 'Infinity', true]) {
    assert.deepEqual(mediaProgress({ out_time_us, total_size: '0' }, 80), {
      outTimeSeconds: null, percent: null, bytesWritten: 0,
    });
  }
});

test('positive output timestamps establish phase progress but cannot mark completion', () => {
  assert.deepEqual(mediaProgress({ out_time_us: '40000000', total_size: '1024' }, 80), {
    outTimeSeconds: 40, percent: 50, bytesWritten: 1024,
  });
  const tinyProgress = mediaProgress({ out_time_us: '1' }, 80).percent;
  assert(tinyProgress > 0 && tinyProgress < 1, 'small positive progress must not be rounded up to a fabricated 1%');
  assert.equal(mediaProgress({ out_time_us: '80000000' }, 80).percent, 99);
  assert.equal(mediaProgress({ out_time_us: '81000000' }, 80).percent, 99);
  for (const duration of [undefined, null, 0, -1, NaN, Infinity, '80']) {
    assert.equal(mediaProgress({ out_time_us: '40000000' }, duration).percent, null);
  }
});

test('invalid output-size reports remain unknown instead of becoming zero', () => {
  for (const total_size of [undefined, null, '', 'N/A', '-1', 'Infinity', true]) {
    assert.equal(mediaProgress({ out_time_us: '1000000', total_size }, 80).bytesWritten, null);
  }
});

test('unknown progress clears an earlier percentage during seek and later validation', () => {
  const job = { stage: 'extract', progress: 73, message: '获取素材' };
  applyJobProgress(job, { phase: 'extract', percent: null });
  assert.equal(job.progress, null, 'explicit unknown must clear progress even within a phase');
  applyJobProgress(job, { phase: 'extract', ...mediaProgress({ out_time_us: '40000000' }, 80) });
  assert.equal(job.progress, 50);
  applyJobProgress(job, { phase: 'extract', message: '继续获取素材' });
  assert.equal(job.progress, 50, 'a message update does not erase known phase progress');
  applyJobProgress(job, { phase: 'validate', message: '核对本地素材' });
  assert.equal(job.progress, null, 'a new phase must not inherit 50% from extraction');
  assert.equal(job.message, '核对本地素材');
  applyJobProgress(job, { phase: 'complete', percent: 100 });
  assert.equal(job.progress, 99, 'only the task owner can publish completed status and 100%');
  applyJobProgress(job, { phase: 'compatible', percent: null });
  assert.equal(job.progress, null, 'MP4 preparation cannot inherit candidate completion');
});

test('invalid reported percentages reset to unknown and finite percentages remain bounded', () => {
  const job = { stage: 'extract', progress: 73 };
  for (const percent of [undefined, null, NaN, Infinity, '73']) {
    applyJobProgress(job, { percent });
    assert.equal(job.progress, null);
  }
  applyJobProgress(job, { percent: -1 });
  assert.equal(job.progress, 0);
  applyJobProgress(job, { percent: 120 });
  assert.equal(job.progress, 99);
});
