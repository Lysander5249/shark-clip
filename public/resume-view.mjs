/* Local resume UI. Only the backend can verify source/cache compatibility. */
const terminalStatuses = new Set(['completed', 'failed', 'cancelled']);
const reasonMessages = {
  unsupported: '当前来源无法安全确认版本，本次不保存跨重启续传缓存。',
  unsupported_source: '当前来源尚不支持跨重启续传。',
  unsupported_format: '跨重启续传目前适用于远程 MKV 文件。',
  missing_validator: '来源未提供可验证的固定版本标识，本次不保存跨重启续传缓存。',
  no_strong_etag: '来源未提供可验证的固定版本标识，本次不保存跨重启续传缓存。',
  cache_missing: '续传缓存已不存在，需重新创建取材任务。',
  cache_invalid: '缓存校验未通过，无法继续使用。',
  source_changed: '当前来源与缓存记录的版本不同，无法合并继续。',
  discarded: '本机续传缓存已清除。',
  completed: '取材已完成。',
};
function nonnegative(value) { return Number.isSafeInteger(value) && value >= 0 ? value : null; }

export function resumeView(job, { checkedSource = false, locked = false, connected = false } = {}) {
  const resume = job?.resume;
  if (!resume || typeof resume !== 'object' || Array.isArray(resume) || typeof resume.available !== 'boolean') return null;
  const available = resume.available;
  const discardable = available || resume.discardable === true;
  const terminal = terminalStatuses.has(job.status);
  if (!available && (!resume.reason || resume.reason === 'completed' || resume.reason === 'discarded')) return null;
  const requested = resume.requested;
  const range = requested && typeof requested === 'object'
    && Number.isFinite(requested.start) && requested.start >= 0
    && Number.isFinite(requested.end) && requested.end > requested.start
    && Number.isFinite(requested.handles) && requested.handles >= 0
    ? { start: requested.start, end: requested.end, handles: requested.handles } : null;
  const active = available && !terminal;
  return {
    available,
    active,
    title: available ? active ? '正在保存续传进度' : '可继续下载' : discardable ? '缓存需要清理' : '本任务未启用跨重启续传',
    reason: available ? null : reasonMessages[resume.reason] || '当前来源暂不支持安全的跨重启续传。',
    cachedBytes: nonnegative(resume.cachedBytes),
    totalBytes: nonnegative(resume.totalBytes),
    receivedBytes: nonnegative(resume.receivedBytes),
    budgetBytes: nonnegative(resume.budgetBytes),
    budgetUsedBytes: nonnegative(resume.budgetUsedBytes),
    uncertainBytes: nonnegative(resume.uncertainBytes),
    resumeCount: nonnegative(resume.resumeCount) || 0,
    range,
    outputDir: typeof resume.outputDir === 'string' ? resume.outputDir : '',
    showActions: available && terminal && job.status !== 'completed',
    showDiscard: discardable && terminal && job.status !== 'completed',
    canResume: available && terminal && job.status !== 'completed' && connected && checkedSource && !locked,
    canDiscard: discardable && terminal && job.status !== 'completed' && connected && !locked,
    instruction: available ? active
      ? '停止后会保留已校验的本机缓存。再次启动工具后，可在「顺序队列与记录」的历史记录中继续。'
      : checkedSource
        ? '已检查当前源文件。继续时会再次核对它是否与缓存来自同一版本，并沿用原任务的时间范围、保存位置和接收上限。'
        : '请重新连接云盘，选择并检查同一份源文件，再点击「继续下载」。续传沿用原任务的时间范围、保存位置和接收上限。'
      : '',
  };
}

export function historyStatusLabel(job) {
  if (job?.resume?.discardable === true && job.resume.available === false && terminalStatuses.has(job.status)) return '需清理 →';
  if (job?.resume?.available === true && terminalStatuses.has(job.status) && job.status !== 'completed') return '可继续 →';
  return ({ completed: '查看文件 →', failed: '未完成', cancelled: '已停止', running: '进行中', queued: '排队中' })[job?.status] || '查看 →';
}

export function historyRequestedRange(job) {
  return job?.result?.requested || job?.resume?.requested || null;
}
