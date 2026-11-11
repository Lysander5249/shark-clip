/* Diagnostic presentation never infers cloud bandwidth or changes policy. */
export function transferDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return '—';
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`;
  return `${(milliseconds / 1000).toFixed(2)} 秒`;
}

export function transferConclusion(report) {
  const complete = report?.status === 'completed';
  const separate = [2, 3].includes(report?.schemaVersion) && report.sampling?.strategy === 'non_overlapping_ranges';
  const verified = separate && report.integrity?.headChecked === true && report.integrity?.rangesVerified === true;
  const prefix = complete && verified ? '四个不同位置的读取与范围核对已完成，仍不能确定并发提速。'
    : complete && !separate ? '这是重复区间的旧版诊断，不能用于判断并发提速。'
      : '本次没有完成全部对照，不能判断并发提速。';
  const warning = report?.orderEffect?.flagged === true
    ? '样本出现明显耗时差异或极短读取，可能受位置、缓存或网络影响。' : '';
  return `${prefix}${warning}文件位置、既有缓存与上游预取未控制；表中是本工具的局部接收速度，不是迅雷或百度上游带宽。下载策略保持原设置。`;
}

const TIMING_FAILURE_CODES = new Set(['CANCELLED', 'TIMEOUT', 'SOURCE_CHANGED', 'RANGE_UNSUPPORTED',
  'RANGE_INVALID', 'AUTH_REQUIRED', 'REMOTE_HTTP', 'BUDGET_EXCEEDED', 'RESUME_WRITE_FAILED']);
const TIMING_STAGES = Object.freeze({ completed: '读取完成', waiting_response: '等待响应头',
  response_validation: '核对响应头', waiting_first_data: '等待首段', body: '接收正文' });
const WAIT_FIELDS = ['waitingResponseRequests', 'waitingFirstDataRequests', 'receivingRequests', 'waitingMoreDataRequests'];
const safeCount = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const validSequence = value => Number.isSafeInteger(value) && value > 0;
export const TRANSFER_TIMING_EXPLANATION = '每行是一次 Range 读取尝试，可能包含重定向链。响应头等待包含连接、重定向及本机调度；首段等待在未收到正文时计至停止，头部核对失败时不适用。正文阶段包含后续停顿与本机处理。并发请求的分项耗时会重叠，不能相加当作总墙钟用时，也不能据此确定云盘上游慢的原因。';

/** Fixed numeric fields only. A sibling receiving data cannot hide another wait. */
export function transferLiveWaitText(counts) {
  if (!counts || !WAIT_FIELDS.every(key => safeCount(counts[key]) !== null)) return null;
  return `等待响应头 ${counts.waitingResponseRequests} · 等待首段 ${counts.waitingFirstDataRequests} · 近期收到数据 ${counts.receivingRequests} · 等待后续数据 ${counts.waitingMoreDataRequests}。近期收到数据指最近 1 秒有数据到达，不代表持续传输。`;
}

/** Build presentation from a closed set of fields, never transport objects. */
export function transferTimingView(report) {
  const source = report?.requestTimings;
  const available = source?.schemaVersion === 1 && Array.isArray(source.requests);
  if (!available) return { available: false, message: report?.schemaVersion === 3
    ? '本次未取得逐次读取时序；无法判断在哪个阶段等待。' : '旧记录无此数据。',
    explanation: TRANSFER_TIMING_EXPLANATION, rows: [] };
  const head = new Set(Array.isArray(report.headRequestSequences) ? report.headRequestSequences.filter(validSequence) : []);
  const belongs = new Map();
  for (const round of (Array.isArray(report.rounds) ? report.rounds.slice(0, 4) : [])) {
    if (!Number.isInteger(round?.index) || round.index < 1 || round.index > 4 || !Array.isArray(round.requestSequences)) continue;
    for (const sequence of round.requestSequences.filter(validSequence)) {
      if (belongs.has(sequence)) belongs.set(sequence, '归属未确定');
      else belongs.set(sequence, `第 ${round.index} 轮`);
    }
  }
  const rows = source.requests.slice(0, 32).filter(record => validSequence(record?.sequence)).map(record => {
    const receivedBytes = safeCount(record.receivedBytes);
    const hasBody = record.headersReceived === true && record.headersVerified === true && receivedBytes > 0;
    const canWaitForBody = record.headersReceived === true && record.headersVerified === true;
    const failureCode = TIMING_FAILURE_CODES.has(record.failureCode) ? record.failureCode : null;
    const outcome = record.outcome === 'completed' ? '完成' : record.outcome === 'failed'
      ? failureCode === 'CANCELLED' ? '已停止' : `失败${failureCode ? ` · ${failureCode}` : ''}` : '未记录';
    const owner = head.has(record.sequence) ? belongs.has(record.sequence) ? '归属未确定' : '文件头' : belongs.get(record.sequence) || '归属未记录';
    const firstDataWait = canWaitForBody ? transferDuration(record.firstDataWaitMs) : '—';
    return { sequence: record.sequence, reading: `#${record.sequence} · ${owner}`, outcome,
      elapsed: transferDuration(record.elapsedMs), responseWait: transferDuration(record.responseWaitMs),
      firstDataWait: `${firstDataWait}${canWaitForBody && !hasBody && firstDataWait !== '—' ? '（未收到）' : ''}`,
      bodyTransfer: hasBody ? transferDuration(record.bodyTransferMs) : '—', receivedBytes,
      terminalStage: Object.hasOwn(TIMING_STAGES, record.terminalStage) ? TIMING_STAGES[record.terminalStage] : '未记录' };
  }).sort((a, b) => a.sequence - b.sequence);
  const dropped = safeCount(source.droppedRequests);
  return { available: true, message: `已记录 ${rows.length} 次读取尝试${dropped ? `；另有 ${dropped} 条较早时序已释放` : ''}。${rows.length ? '按派发序号显示，完成顺序可能不同。' : '本次没有已结算的读取尝试。'}`,
    explanation: TRANSFER_TIMING_EXPLANATION, rows };
}
