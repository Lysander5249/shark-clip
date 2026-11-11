import test from 'node:test';
import assert from 'node:assert/strict';
import { createDirectObserver, directTelemetry, directReadTimings } from '../src/direct-stream-telemetry.mjs';
import { sanitizeTransferTelemetry, mergeTransferTelemetry } from '../src/task-diagnostics.mjs';
import { sanitizeJobDiagnostics, formatJobDiagnostics } from '../public/job-diagnostics.mjs';

test('direct observation ring stays bounded and exported scalar copies cannot mutate it', () => {
  const metrics = {}, observer = createDirectObserver(metrics);
  for (let i = 0; i < 50; i++) {
    const item = observer.start(); observer.headers(item, 206); observer.validated(item); observer.bytes(item, 100); observer.finish(item, true);
  }
  const timings = directReadTimings(metrics);
  assert.equal(timings.limit, 32); assert.equal(timings.requestsRecorded, 32); assert.equal(timings.droppedRequests, 18);
  assert.equal(timings.requests[0].sequence, 19); assert.equal(timings.requests.at(-1).sequence, 50);
  const totals = directTelemetry(metrics);
  assert.equal(totals.requestsStarted, 50); assert.equal(totals.requestsCompleted, 50); assert.equal(totals.requestsFailed, 0); assert.equal(totals.activeRequests, 0);
  timings.requests[0].httpStatus = 499; timings.requests.push({ url: 'PRIVATE' });
  assert.equal(directReadTimings(metrics).requests.length, 32); assert.equal(directReadTimings(metrics).requests[0].httpStatus, 206);
  assert.equal(directTelemetry({}), null); assert.equal(directReadTimings({}), null);
});

test('a real failure keeps its original classification when cleanup later cancels the request', () => {
  const metrics = {}, observer = createDirectObserver(metrics), item = observer.start();
  observer.headers(item, 206); observer.validated(item); observer.bytes(item, 17);
  observer.failure(item, 'REMOTE_HTTP', { code: 'ECONNRESET', message: 'SECRET https://private/' });
  observer.failure(item, 'CANCELLED', { code: 'PRIVATE' }, 'lease_closed'); observer.finish(item, true);
  const latest = directReadTimings(metrics).requests[0];
  assert.equal(latest.outcome, 'failed'); assert.equal(latest.failureCode, 'REMOTE_HTTP');
  assert.equal(latest.transportCode, 'ECONNRESET'); assert.equal(latest.cancellationReason, null);
  assert.equal(directTelemetry(metrics).requestsCancelled, 0); assert.doesNotMatch(JSON.stringify(latest), /SECRET|https?:/);
});

test('server and clipboard diagnostics retain only approved status codes and transport enums', () => {
  const request = { sequence: 1, outcome: 'failed', failureCode: 'REMOTE_HTTP', terminalStage: 'body',
    headersReceived: true, headersVerified: true, receivedBytes: 12, elapsedMs: 100, responseWaitMs: 20,
    firstDataWaitMs: 10, bodyTransferMs: 70, httpStatus: 503, transportCode: 'ECONNRESET', cancellationReason: 'SECRET',
    url: 'https://PRIVATE/', headers: { Cookie: 'PRIVATE' }, error: 'PRIVATE' };
  const transfer = { schemaVersion: 1, requestsStarted: 1, requestsCompleted: 0, requestsFailed: 1, activeRequests: 0,
    state: 'idle', responseWaitMs: 20, responseBodyMs: 80, readTimings: { schemaVersion: 1, requests: [request] } };
  const safe = sanitizeTransferTelemetry(transfer);
  const clipboard = sanitizeJobDiagnostics({ schemaVersion: 1, sourceKind: 'remote', elapsedMs: 100, stages: {}, status: 'failed', transfer: safe });
  assert.equal(clipboard.transfer.readTimings.requests[0].httpStatus, 503);
  assert.equal(clipboard.transfer.readTimings.requests[0].transportCode, 'ECONNRESET');
  assert.equal(clipboard.transfer.readTimings.requests[0].cancellationReason, null);
  assert.doesNotMatch(JSON.stringify(clipboard), /PRIVATE|SECRET|Cookie|https?:/);
  const rejected = sanitizeTransferTelemetry({ ...transfer, readTimings: { schemaVersion: 1,
    requests: [{ ...request, httpStatus: 999, transportCode: 'https://PRIVATE', cancellationReason: { token: 'PRIVATE' } }] } });
  assert.equal(rejected.readTimings.requests[0].httpStatus, null); assert.equal(rejected.readTimings.requests[0].transportCode, null);
});

test('normal consumer end is distinct from a network failure in totals and user diagnostics', () => {
  const metrics = {}, observer = createDirectObserver(metrics), item = observer.start();
  observer.headers(item, 206); observer.validated(item); observer.bytes(item, 50);
  observer.failure(item, 'CANCELLED', null, 'consumer_closed'); observer.finish(item, false);
  const transfer = sanitizeTransferTelemetry({ ...directTelemetry(metrics), readTimings: directReadTimings(metrics) });
  const merged = mergeTransferTelemetry(transfer, transfer);
  assert.equal(merged.requestsCancelled, 2); assert.equal(merged.requestsConsumerClosed, 2);
  const display = formatJobDiagnostics({ status: 'completed', stage: 'completed', diagnostics: {
    schemaVersion: 1, sourceKind: 'remote', status: 'completed', elapsedMs: 10, stages: {}, transfer } });
  assert.match(display.networkTiming, /读取端提前结束 1 次/); assert.doesNotMatch(display.networkTiming, /失败 1 次/);
});
