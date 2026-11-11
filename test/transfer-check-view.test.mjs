import test from 'node:test';
import assert from 'node:assert/strict';
import { transferDuration, transferConclusion, transferTimingView, transferLiveWaitText } from '../public/transfer-check-view.mjs';

test('transfer view preserves millisecond samples instead of displaying zero seconds', () => {
  assert.equal(transferDuration(3), '3 毫秒');
  assert.equal(transferDuration(54_277), '54.28 秒');
  assert.equal(transferDuration(0), '0 毫秒');
  for (const value of [null, NaN, Infinity, -1, '3']) assert.equal(transferDuration(value), '—');
});

test('transfer view does not promote mixed medians or infer upstream bandwidth from fast samples', () => {
  const report = { schemaVersion: 2, status: 'completed', sampling: { strategy: 'non_overlapping_ranges' },
    integrity: { headChecked: true, rangesVerified: true }, orderEffect: { flagged: true },
    throughput: { serialMedianBytesPerSecond: 255777360, parallelMedianBytesPerSecond: 490133598 } };
  const text = transferConclusion(report);
  assert(text.includes('仍不能确定并发提速'));
  assert(text.includes('明显耗时差异或极短读取'));
  assert(text.includes('不是迅雷或百度上游带宽'));
  assert(!text.includes('中位') && !text.includes('255777360') && !text.includes('490133598'));
  for (const status of ['failed', 'cancelled', 'running']) {
    assert(transferConclusion({ ...report, status }).includes('没有完成全部对照'));
  }
  assert(transferConclusion({ ...report, schemaVersion: 1 }).includes('重复区间的旧版诊断'));
  assert(transferConclusion({ ...report, integrity: { headChecked: true } }).includes('没有完成全部对照'));
  assert(transferConclusion({ ...report, schemaVersion: 3 }).includes('四个不同位置的读取与范围核对已完成'));
  assert(transferConclusion({ ...report, schemaVersion: 3 }).includes('仍不能确定并发提速'));
});

const timingRecord = (sequence, extra = {}) => ({ sequence, outcome: 'completed', failureCode: null,
  terminalStage: 'completed', headersReceived: true, headersVerified: true,
  receivedBytes: 1048576, elapsedMs: 1800, responseWaitMs: 200, firstDataWaitMs: 300,
  bodyTransferMs: 1300, ...extra });
const timingReport = records => ({ schemaVersion: 3, status: 'completed', headRequestSequences: [1],
  rounds: [{ index: 1, requestSequences: [2, 3] }, { index: 2, requestSequences: [4, 5] }],
  requestTimings: { schemaVersion: 1, limit: 32, requestsRecorded: records.length, droppedRequests: 0, requests: records } });

test('request timing view preserves sequence ownership independently of completion order', () => {
  const result = transferTimingView(timingReport([timingRecord(5), timingRecord(1), timingRecord(4), timingRecord(3), timingRecord(2)]));
  assert.equal(result.available, true);
  assert.deepEqual(result.rows.map(row => row.reading), ['#1 · 文件头', '#2 · 第 1 轮', '#3 · 第 1 轮', '#4 · 第 2 轮', '#5 · 第 2 轮']);
  assert.equal(result.rows[0].elapsed, '1.80 秒');
  assert.equal(result.rows[0].responseWait, '200 毫秒');
  assert.equal(result.rows[0].firstDataWait, '300 毫秒');
  assert.equal(result.rows[0].bodyTransfer, '1.30 秒');
  assert(result.message.includes('完成顺序可能不同'));
  assert(result.explanation.includes('可能包含重定向链'));
  assert(result.explanation.includes('不能相加当作总墙钟用时'));
  assert(result.explanation.includes('本机处理'));
});

test('timing view distinguishes missing phases, no first data and rejected response headers', () => {
  const result = transferTimingView(timingReport([
    timingRecord(1, { outcome: 'failed', failureCode: 'TIMEOUT', terminalStage: 'waiting_response', headersReceived: false,
      headersVerified: false, receivedBytes: 0, elapsedMs: 2000, responseWaitMs: 2000, firstDataWaitMs: null, bodyTransferMs: null }),
    timingRecord(2, { outcome: 'failed', failureCode: 'CANCELLED', terminalStage: 'waiting_first_data', receivedBytes: 0,
      elapsedMs: 1700, firstDataWaitMs: 1500, bodyTransferMs: null }),
    timingRecord(3, { outcome: 'failed', failureCode: 'RANGE_INVALID', terminalStage: 'response_validation', headersVerified: false,
      receivedBytes: 0, firstDataWaitMs: 7, bodyTransferMs: null }),
    timingRecord(4, { outcome: 'failed', failureCode: 'RANGE_INVALID', terminalStage: 'body', receivedBytes: 128 }),
  ]));
  assert.equal(result.rows[0].firstDataWait, '—'); assert.equal(result.rows[0].bodyTransfer, '—');
  assert.equal(result.rows[0].terminalStage, '等待响应头');
  assert.equal(result.rows[1].firstDataWait, '1.50 秒（未收到）');
  assert.equal(result.rows[1].bodyTransfer, '—'); assert.equal(result.rows[1].outcome, '已停止');
  assert.equal(result.rows[1].terminalStage, '等待首段');
  assert.equal(result.rows[2].firstDataWait, '—'); assert.equal(result.rows[2].bodyTransfer, '—');
  assert.equal(result.rows[2].terminalStage, '核对响应头');
  assert.equal(result.rows[3].receivedBytes, 128); assert.equal(result.rows[3].bodyTransfer, '1.30 秒');
  assert.equal(result.rows[3].outcome, '失败 · RANGE_INVALID');
  assert(result.explanation.includes('未收到正文时计至停止'));
  assert(result.explanation.includes('头部核对失败时不适用'));
});

test('legacy and unavailable timing records remain explicitly unavailable without invented zero timings', () => {
  for (const schemaVersion of [1, 2]) {
    const view = transferTimingView({ schemaVersion, status: 'completed' });
    assert.equal(view.available, false); assert.deepEqual(view.rows, []);
    assert.equal(view.message, '旧记录无此数据。');
  }
  const unavailable = transferTimingView({ schemaVersion: 3, requestTimings: null });
  assert.equal(unavailable.available, false); assert.deepEqual(unavailable.rows, []);
  assert(unavailable.message.includes('未取得逐次读取时序'));
  const empty = transferTimingView(timingReport([]));
  assert.equal(empty.available, true); assert.deepEqual(empty.rows, []);
  assert(empty.message.includes('没有已结算的读取尝试'));
});

test('timing presentation copies only fixed scalar fields and rejects unknown failure or stage text', () => {
  const report = timingReport([timingRecord(1, { outcome: 'failed', failureCode: 'PRIVATE_AUTH_HEADER', terminalStage: 'PRIVATE_SOURCE_URL',
    url: 'PRIVATE_SOURCE_URL', headers: { Authorization: 'PRIVATE_AUTH_HEADER' }, source: { password: 'PRIVATE_PASSWORD' },
    error: { message: 'PRIVATE_PASSWORD' } }), timingRecord(2, { terminalStage: 'toString' }), timingRecord(3, { sequence: 'PRIVATE_SOURCE_URL' })]);
  report.url = 'PRIVATE_SOURCE_URL'; report.source = { password: 'PRIVATE_PASSWORD' }; report.rounds[0].url = 'PRIVATE_SOURCE_URL';
  const view = transferTimingView(report);
  assert.equal(view.rows.length, 2); assert.equal(view.rows[0].outcome, '失败');
  assert.equal(view.rows[0].terminalStage, '未记录'); assert.equal(view.rows[1].terminalStage, '未记录');
  const text = JSON.stringify(view);
  for (const secret of ['PRIVATE_SOURCE_URL', 'PRIVATE_AUTH_HEADER', 'PRIVATE_PASSWORD', 'Authorization', 'toString']) assert(!text.includes(secret));
  assert.deepEqual(Object.keys(view.rows[0]).sort(), ['sequence', 'reading', 'outcome', 'elapsed', 'responseWait', 'firstDataWait', 'bodyTransfer', 'receivedBytes', 'terminalStage'].sort());
  report.requestTimings.requests[0].receivedBytes = 999;
  assert.equal(view.rows[0].receivedBytes, 1048576);
});

test('timing view respects bounded records and reports evictions without fabricating ownership', () => {
  const report = timingReport(Array.from({ length: 40 }, (_, i) => timingRecord(i + 10)));
  report.requestTimings.droppedRequests = 8;
  const view = transferTimingView(report);
  assert.equal(view.rows.length, 32); assert(view.message.includes('8 条较早时序已释放'));
  assert(view.rows.every(row => row.reading.includes('归属未记录')));
  const conflict = timingReport([timingRecord(1), timingRecord(2)]);
  conflict.rounds[0].requestSequences.push(1);
  conflict.rounds[1].requestSequences.push(2);
  assert(transferTimingView(conflict).rows.every(row => row.reading.includes('归属未确定')));
});

test('live wait presentation shows all four request counts with an explicit recent-data heuristic', () => {
  const counts = { waitingResponseRequests: 1, waitingFirstDataRequests: 1, receivingRequests: 1, waitingMoreDataRequests: 1,
    source: 'PRIVATE_SOURCE_URL', headers: 'PRIVATE_AUTH_HEADER' };
  const text = transferLiveWaitText(counts);
  for (const label of ['等待响应头 1', '等待首段 1', '近期收到数据 1', '等待后续数据 1', '最近 1 秒', '不代表持续传输']) assert(text.includes(label));
  assert(!text.includes('PRIVATE'));
  assert(transferLiveWaitText({ ...counts, waitingResponseRequests: 0 }).includes('等待响应头 0'));
  for (const invalid of [null, {}, { ...counts, waitingResponseRequests: -1 }, { ...counts, waitingMoreDataRequests: '1' }, { ...counts, receivingRequests: Infinity }])
    assert.equal(transferLiveWaitText(invalid), null);
});
