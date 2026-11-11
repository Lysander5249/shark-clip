/**
 * Local media task engine. No npm dependencies and no upstream credentials.
 * FFmpeg / ffprobe are external executables, supplied by the host application.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mediaProgress } from './progress.mjs';
import { createProcessWatchdog } from './process-watchdog.mjs';
import { subtitleExportSpec, alignSrt, hasPgsDisplay } from './subtitles.mjs';
import { reserveNamedDirectory } from './output-directory.mjs';
import { sanitizeClipName } from '../public/clip-options.mjs';

const PROBE_TIMEOUT_MS = 30_000;
const TASK_TIMEOUT_MS = 15 * 60_000;
const REMOTE_DEADLINE_MS = 2 * 3600_000;
const REMOTE_STALL_MS = 120_000;
const MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const INPUT_FORMATS = 'matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mpegts,avi';
const KNOWN_COLOR_FIELDS = ['color_range', 'color_space', 'color_transfer', 'color_primaries', 'chroma_location'];

export class MediaError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'MediaError';
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

/** Parse seconds or HH:MM:SS[.mmm]. No implicit unit or locale conversions. */
export function parseTime(value) {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 0 && value <= 604_800) return value;
    throw new MediaError('INVALID_TIME', '时间必须是 0 到 604800 之间的秒数。');
  }
  if (typeof value !== 'string') throw new MediaError('INVALID_TIME', '请输入秒数或 HH:MM:SS.mmm 格式的时间。');
  const text = value.trim();
  if (/^\d+(?:\.\d{1,6})?$/.test(text)) return parseTime(Number(text));
  const short = /^(\d{1,4}):([0-5]\d(?:\.\d{1,6})?)$/.exec(text);
  if (short) return parseTime(Number(short[1]) * 60 + Number(short[2]));
  const match = /^(\d{1,3}):([0-5]\d):([0-5]\d(?:\.\d{1,6})?)$/.exec(text);
  if (!match) throw new MediaError('INVALID_TIME', '时间格式无效，请使用秒数或 HH:MM:SS.mmm，例如 00:42:10.500。');
  return parseTime(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
}

function positiveNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function redact(value, input) {
  let text = String(value ?? '');
  if (input && /^https?:/i.test(input)) text = text.split(input).join('[本机读取网关]');
  return text.replace(/https?:\/\/[^\s"'<>\]\)]+/gi, '[链接已隐藏]')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, 6000);
}

function emit(callback, event) {
  if (typeof callback !== 'function') return;
  try { callback(event); } catch { /* UI callbacks cannot interrupt media cleanup. */ }
}

function assertNotAborted(signal) {
  if (signal?.aborted) throw new MediaError('CANCELLED', '任务已取消。');
}

function timeoutValue(value, fallback) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 100 || value > 24 * 3600_000) {
    throw new MediaError('INVALID_TIMEOUT', '超时设置必须是 100 毫秒到 24 小时之间的整数。');
  }
  return value;
}

/** Every process has bounded diagnostic buffers, a deadline and cancellation. */
function runProcess(executable, args, options = {}) {
  const { signal, input, onProgress, phase, durationSeconds } = options;
  const timeoutMs = timeoutValue(options.timeoutMs, PROBE_TIMEOUT_MS);
  const stallTimeoutMs = options.activityStallTimeoutMs === undefined ? null : timeoutValue(options.activityStallTimeoutMs, REMOTE_STALL_MS);
  assertNotAborted(signal);
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new MediaError('PROCESS_START_FAILED', '无法启动媒体工具。', { reason: redact(error.message, input) }));
      return;
    }
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let progressBuffer = '';
    let progressState = {};
    let lastProgress = {};
    let stopError = null;
    let killTimer;
    let settled = false, watchdog;
    let outputBytes = 0, mediaTimeUs = 0;
    const stop = (error) => {
      if (stopError || settled) return;
      stopError = error;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => { child.kill('SIGKILL'); }, 1500);
      killTimer.unref?.();
    };
    const abort = () => stop(new MediaError('CANCELLED', '任务已取消。'));
    const timer = setTimeout(() => stop(new MediaError(stallTimeoutMs === null ? 'TIMEOUT' : 'REMOTE_DEADLINE_EXCEEDED',
      stallTimeoutMs === null ? '媒体处理超时，任务已停止。' : '远程取片达到整体安全时限，任务已停止。', { timeoutMs })), timeoutMs);
    timer.unref?.();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      watchdog?.dispose();
      signal?.removeEventListener('abort', abort);
    };
    if (stallTimeoutMs !== null) {
      watchdog = createProcessWatchdog({ stallTimeoutMs, pollIntervalMs: Math.min(1000, Math.max(25, Math.floor(stallTimeoutMs / 4))),
        getActivity: () => ({ ...(options.getReceivedBytes ? { receivedBytes: options.getReceivedBytes() } : {}), outputBytes, mediaTimeUs }),
        onStall: () => stop(new MediaError('TRANSFER_STALLED', '远程取片持续没有接收新数据或输出进展，任务已停止。', { stallTimeoutMs })),
        onUnavailable: () => stop(new MediaError('MEDIA_ACTIVITY_UNAVAILABLE', '无法核对远程取片进展，任务已停止。')) });
    }
    child.stdout.on('data', (chunk) => {
      if (typeof options.consumeStdout === 'function') {
        try { options.consumeStdout(chunk); }
        catch (error) { stop(error instanceof MediaError ? error : new MediaError('INVALID_PROBE_OUTPUT', '片段时间核对失败。')); }
      } else if (phase) {
        progressBuffer += chunk.toString('utf8');
        if (progressBuffer.length > MAX_STDOUT_BYTES) {
          stop(new MediaError('PROCESS_OUTPUT_LIMIT', '媒体工具输出异常，已停止任务。'));
          return;
        }
        let newline;
        while ((newline = progressBuffer.indexOf('\n')) !== -1) {
          const line = progressBuffer.slice(0, newline).trim();
          progressBuffer = progressBuffer.slice(newline + 1);
          const separator = line.indexOf('=');
          if (separator === -1) continue;
          progressState[line.slice(0, separator)] = line.slice(separator + 1);
          if (line.startsWith('progress=')) {
            lastProgress = progressState;
            const written = Number(progressState.total_size), mediaTime = Number(progressState.out_time_us);
            if (Number.isSafeInteger(written) && written > outputBytes) outputBytes = written;
            if (Number.isSafeInteger(mediaTime) && mediaTime > mediaTimeUs) mediaTimeUs = mediaTime;
            emit(onProgress, {
              phase, status: 'running', ...mediaProgress(progressState, durationSeconds),
            });
            progressState = {};
          }
        }
      } else {
        stdoutBytes += chunk.byteLength;
        if (stdoutBytes > MAX_STDOUT_BYTES) stop(new MediaError('PROCESS_OUTPUT_LIMIT', '媒体信息过大，已停止读取。'));
        else stdout += chunk.toString('utf8');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_STDERR_BYTES);
    });
    child.on('error', (error) => {
      cleanup();
      reject(stopError ?? new MediaError(error.code === 'ENOENT' ? 'TOOL_NOT_FOUND' : 'PROCESS_START_FAILED',
        error.code === 'ENOENT' ? '未找到 FFmpeg 或 ffprobe，请先安装或指定可执行文件路径。' : '无法启动媒体工具。',
        { tool: path.basename(executable), reason: redact(error.message, input) }));
    });
    child.on('close', (code, processSignal) => {
      if (settled) return;
      cleanup();
      if (stopError) { reject(stopError); return; }
      if (code !== 0) {
        reject(new MediaError('MEDIA_PROCESS_FAILED', '媒体处理失败，请查看诊断信息。', {
          tool: path.basename(executable), exitCode: code, signal: processSignal,
          diagnostic: redact(stderr, input),
        }));
        return;
      }
      resolve({ stdout, diagnostic: redact(stderr, input), progress: lastProgress });
    });
  });
}

async function checkedInput(sourceInput, { localOnly = false } = {}) {
  if (typeof sourceInput !== 'string' || !sourceInput || sourceInput.includes('\0')) {
    throw new MediaError('INVALID_SOURCE', '请选择本地视频文件或本机受控读取地址。');
  }
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(sourceInput)) {
    let url;
    try { url = new URL(sourceInput); } catch { throw new MediaError('INVALID_SOURCE', '读取地址格式无效。'); }
    if (localOnly || url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || !url.port || url.username || url.password || url.hash) {
      throw new MediaError('UNSAFE_SOURCE', '媒体引擎只接受本地文件或本机受控 HTTP 网关；请勿粘贴公网直链和账号凭据。');
    }
    return { input: url.href, kind: 'gateway', name: null, sizeBytes: null };
  }
  if (!path.isAbsolute(sourceInput)) throw new MediaError('INVALID_SOURCE', '本地文件必须使用完整绝对路径。');
  let stat;
  try { stat = await fs.stat(sourceInput); } catch {
    throw new MediaError('SOURCE_NOT_FOUND', '来源文件不存在或没有读取权限。');
  }
  if (!stat.isFile() || stat.size <= 0) throw new MediaError('INVALID_SOURCE', '来源必须是非空的普通视频文件。');
  return { input: sourceInput, kind: 'local', name: path.basename(sourceInput), sizeBytes: stat.size };
}

function inputOptions(source) {
  // Whitelisted demuxers do not follow playlist / concat / subtitle URLs.
  return [
    '-protocol_whitelist', 'file,http,tcp',
    '-format_whitelist', INPUT_FORMATS,
    // Let the bounded upstream reader report its 30 s inactivity error first.
    // The independent process deadline still limits the total probe duration.
    ...(source.kind === 'gateway' ? ['-rw_timeout', '35000000', '-multiple_requests', '0'] : []),
    '-probesize', '8388608', '-analyzeduration', '10000000',
  ];
}

function safeString(value, input, max = 160) {
  return typeof value === 'string' ? redact(value, input).slice(0, max) : null;
}

function normalizeStream(stream, input) {
  if (!stream || typeof stream !== 'object' || !Number.isInteger(stream.index) || stream.index < 0
    || !['video', 'audio', 'subtitle', 'attachment', 'data'].includes(stream.codec_type)) return null;
  const result = {
    index: stream.index, type: stream.codec_type, codec: safeString(stream.codec_name, input),
    codecLongName: safeString(stream.codec_long_name, input), profile: safeString(stream.profile, input),
    durationSeconds: positiveNumber(stream.duration), startSeconds: Number.isFinite(Number(stream.start_time)) ? Number(stream.start_time) : null,
    timeBase: safeString(stream.time_base, input), bitrate: positiveNumber(stream.bit_rate),
    language: safeString(stream.tags?.language, input, 32),
    default: stream.disposition?.default === 1, attachedPicture: stream.disposition?.attached_pic === 1,
  };
  if (stream.codec_type === 'video') {
    Object.assign(result, {
      width: positiveNumber(stream.width), height: positiveNumber(stream.height),
      pixelFormat: safeString(stream.pix_fmt, input), frameRate: safeString(stream.avg_frame_rate, input),
      bitsPerRawSample: positiveNumber(stream.bits_per_raw_sample),
      color: Object.fromEntries(KNOWN_COLOR_FIELDS.map((key) => [key, safeString(stream[key], input)])),
      sideDataTypes: Array.isArray(stream.side_data_list)
        ? stream.side_data_list.map((item) => safeString(item?.side_data_type, input)).filter(Boolean).slice(0, 32) : [],
    });
  } else if (stream.codec_type === 'audio') {
    Object.assign(result, {
      sampleRate: positiveNumber(stream.sample_rate), channels: positiveNumber(stream.channels),
      channelLayout: safeString(stream.channel_layout, input), sampleFormat: safeString(stream.sample_fmt, input),
    });
  }
  return result;
}

async function probeChecked(source, options = {}) {
  assertNotAborted(options.signal);
  const result = await runProcess(options.ffprobePath ?? 'ffprobe', [
    '-v', 'error', ...inputOptions(source), '-show_format', '-show_streams', '-of', 'json', source.input,
  ], { signal: options.signal, input: source.input, timeoutMs: options.probeTimeoutMs ?? PROBE_TIMEOUT_MS });
  let data;
  try { data = JSON.parse(result.stdout); } catch {
    throw new MediaError('INVALID_PROBE_OUTPUT', 'ffprobe 返回了无法解析的媒体信息。');
  }
  if (!data || !Array.isArray(data.streams) || data.streams.length > 128 || !data.format || typeof data.format !== 'object') {
    throw new MediaError('INVALID_PROBE_OUTPUT', '媒体信息结构无效或轨道数量异常。');
  }
  const streams = data.streams.map((stream) => normalizeStream(stream, source.input)).filter(Boolean);
  if (!streams.some((stream) => stream.type === 'video' && !stream.attachedPicture && stream.codec)) {
    throw new MediaError('NO_VIDEO_STREAM', '文件中没有可用的视频轨道。');
  }
  return {
    format: safeString(data.format.format_name, source.input),
    durationSeconds: positiveNumber(data.format.duration),
    startSeconds: Number.isFinite(Number(data.format.start_time)) ? Number(data.format.start_time) : null,
    sizeBytes: positiveNumber(data.format.size), bitrate: positiveNumber(data.format.bit_rate),
    streams, warnings: result.diagnostic ? [result.diagnostic] : [],
  };
}

export async function probeMedia({ sourceInput, signal, ffprobePath, probeTimeoutMs } = {}) {
  const source = await checkedInput(sourceInput);
  return probeChecked(source, { signal, ffprobePath, probeTimeoutMs });
}

/** Confirm that a bounded input can seek near a target; this does not calibrate clip boundaries. */
export async function probePosition({ sourceInput, start, videoTrackIndex, ffprobePath = 'ffprobe', signal, probeTimeoutMs = PROBE_TIMEOUT_MS } = {}) {
  assertNotAborted(signal);
  if (!Number.isFinite(start) || start < 0) {
    throw new MediaError('INVALID_TIME', '定位检查的开始时间必须是大于等于零的有限秒数。');
  }
  if (videoTrackIndex !== undefined && (!Number.isSafeInteger(videoTrackIndex) || videoTrackIndex < 0)) {
    throw new MediaError('INVALID_TRACK', '定位检查的视频轨道编号必须是大于等于零的整数。');
  }
  const source = await checkedInput(sourceInput);
  let result;
  try {
    result = await runProcess(ffprobePath, [
      '-v', 'error', ...inputOptions(source), '-select_streams', videoTrackIndex === undefined ? 'V:0' : String(videoTrackIndex),
      '-probesize', '1048576', '-analyzeduration', '1000000',
      '-read_intervals', `${start}%+#1`, '-show_packets',
      '-show_entries', 'packet=pts_time,dts_time,pos,flags', '-of', 'json', source.input,
    ], { signal, input: source.input, timeoutMs: probeTimeoutMs });
  } catch (error) {
    if (['CANCELLED', 'TIMEOUT', 'INVALID_TIMEOUT'].includes(error?.code)) throw error;
    throw new MediaError('POSITION_UNCONFIRMED', '未能确认目标时间附近的视频数据，已停止定位检查。需要进一步检查该文件的索引读取。');
  }
  let data;
  try { data = JSON.parse(result.stdout); } catch { /* A safe error below covers malformed output. */ }
  const numeric = value => (typeof value === 'number' || (typeof value === 'string' && value.trim()))
    && Number.isFinite(Number(value)) ? Number(value) : null;
  if (data && Array.isArray(data.packets) && data.packets.length <= 128) {
    for (const packet of data.packets) {
      if (!packet || typeof packet !== 'object') continue;
      const timestampSeconds = numeric(packet.pts_time) ?? numeric(packet.dts_time);
      if (timestampSeconds === null || timestampSeconds < Math.max(0, start - 60) || timestampSeconds > start + 15) continue;
      const position = numeric(packet.pos);
      return {
        timestampSeconds,
        positionBytes: Number.isSafeInteger(position) && position >= 0 ? position : null,
        keyframe: typeof packet.flags === 'string' && packet.flags.includes('K'),
      };
    }
  }
  throw new MediaError('POSITION_UNCONFIRMED', '未能确认目标时间附近的视频数据，已停止定位检查。需要进一步检查该文件的索引读取。');
}

export async function detectTools({ ffmpegPath = 'ffmpeg', ffprobePath = 'ffprobe', signal } = {}) {
  const results = await Promise.allSettled([
    runProcess(ffmpegPath, ['-version'], { signal, timeoutMs: 5000 }),
    runProcess(ffprobePath, ['-version'], { signal, timeoutMs: 5000 }),
  ]);
  const describe = (result) => result.status === 'fulfilled'
    ? { available: true, version: redact(result.value.stdout.split('\n')[0]).slice(0, 300) }
    : { available: false, error: result.reason instanceof MediaError ? result.reason.toJSON() : { code: 'UNKNOWN', message: '工具检查失败。' } };
  return { ffmpeg: describe(results[0]), ffprobe: describe(results[1]) };
}

function chooseTracks(media, options) {
  const videos = media.streams.filter((stream) => stream.type === 'video' && !stream.attachedPicture);
  const audios = media.streams.filter((stream) => stream.type === 'audio');
  const video = options.videoTrackIndex === undefined ? (videos.find((stream) => stream.default) ?? videos[0])
    : videos.find((stream) => stream.index === options.videoTrackIndex);
  const audio = options.audioTrackIndex === null ? null : options.audioTrackIndex === undefined ? (audios.find((stream) => stream.default) ?? audios[0] ?? null)
    : audios.find((stream) => stream.index === options.audioTrackIndex);
  if (!video || (options.audioTrackIndex !== undefined && options.audioTrackIndex !== null && !audio)) {
    throw new MediaError('INVALID_TRACK', '所选音视频轨道不存在。');
  }
  return { video, audio };
}

function checkedJobId(jobId) {
  const value = jobId ?? `clip-${Date.now()}-${randomUUID().slice(0, 8)}`;
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)) {
    throw new MediaError('INVALID_JOB_ID', '任务标识只允许字母、数字、短横线和下划线，长度不超过 80。');
  }
  return value;
}

function checkedClipName(value, { allowNumberedCopy = false } = {}) {
  if (value === undefined) return null;
  const canonical = typeof value === 'string' && value && sanitizeClipName(value) === value;
  // The server adds a bounded copy number when creating another local MP4.
  const numbered = !canonical && allowNumberedCopy && typeof value === 'string' && /^(.*) \(([2-9]|[1-9]\d|100)\)$/.exec(value);
  if (!canonical && !(numbered && numbered[1] && sanitizeClipName(numbered[1]) === numbered[1])) {
    throw new MediaError('INVALID_CLIP_NAME', '素材名称无效，请使用不含路径的简短文件名。');
  }
  return value;
}

function chooseSubtitle(media, index) {
  if (index === undefined || index === null) return null;
  if (!Number.isSafeInteger(index) || index < 0) throw new MediaError('INVALID_SUBTITLE_TRACK', '所选字幕轨道无效。');
  const track = media.streams.find(stream => stream.type === 'subtitle' && stream.index === index);
  if (!track) throw new MediaError('INVALID_SUBTITLE_TRACK', '所选字幕轨道不存在，请重新检查源文件。');
  const spec = subtitleExportSpec(track.codec);
  if (!spec) throw new MediaError('SUBTITLE_FORMAT_UNSUPPORTED', '此字幕格式暂不支持独立导出，请取消字幕选项后取片。');
  return { track, spec };
}

async function packetTiming(filename, selector, options) {
  const result = await runProcess(options.ffprobePath ?? 'ffprobe', [
    '-v', 'error', '-select_streams', selector, '-read_intervals', '%+#3', '-show_packets', '-show_data_hash', 'sha256',
    '-show_entries', 'packet=pts_time,data_hash', '-of', 'json', filename,
  ], { signal: options.signal, timeoutMs: options.probeTimeoutMs ?? PROBE_TIMEOUT_MS });
  let packets;
  try { packets = JSON.parse(result.stdout).packets; } catch { /* Validated below. */ }
  if (!Array.isArray(packets) || !packets.length || packets.length > 3 || packets.some(packet => !Number.isFinite(Number(packet.pts_time)) || !/^SHA256:[a-f0-9]{64}$/.test(packet.data_hash || ''))) {
    throw new MediaError('SUBTITLE_TIMELINE_UNVERIFIED', '无法核对字幕与视频的共同时间基准。');
  }
  return packets;
}

async function subtitleTimeline(intermediate, candidate, tracks, options) {
  let offset, verifiedPackets = 0;
  for (const selector of ['v:0', ...(tracks.audio ? ['a:0'] : [])]) {
    const [before, after] = await Promise.all([packetTiming(intermediate, selector, options), packetTiming(candidate, selector, options)]);
    if (before.length !== after.length) throw new MediaError('SUBTITLE_TIMELINE_UNVERIFIED', '本地转封装的音视频包不一致，未发布字幕。');
    for (let index = 0; index < before.length; index++) {
      const shift = Number(after[index].pts_time) - Number(before[index].pts_time);
      offset ??= shift;
      if (before[index].data_hash !== after[index].data_hash || Math.abs(shift - offset) > 0.003) {
        throw new MediaError('SUBTITLE_TIMELINE_UNVERIFIED', '字幕与成品的时间基准无法一致核对，未发布字幕。');
      }
      verifiedPackets++;
    }
  }
  return { status: 'verified-local-packet-offset', intermediateToCandidateOffsetSeconds: offset, verifiedPackets };
}

async function exportIndependentSubtitle({ intermediate, candidate, tracks, subtitle, directory, stem, durationSeconds, options }) {
  const { track, spec } = subtitle;
  const outputPath = path.join(directory, `${stem}.${spec.extension}`);
  const temporaryPath = path.join(directory, `.${stem}.subtitle.partial.${spec.extension}`);
  const rawSrt = path.join(directory, `.${stem}.subtitle.raw.partial.srt`);
  try {
    const timeline = await subtitleTimeline(intermediate, candidate, tracks, options);
    emit(options.onProgress, { phase: 'extract', status: 'running', percent: null, message: '在本地保存独立字幕文件，不重新读取云端视频。' });
    const rawOutput = spec.kind === 'text' ? rawSrt : temporaryPath;
    await runProcess(options.ffmpegPath ?? 'ffmpeg', [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-copyts',
      ...(spec.kind === 'image' ? ['-itsoffset', timeline.intermediateToCandidateOffsetSeconds.toFixed(6)] : []),
      '-i', intermediate, '-map', '0:s:0', '-vn', '-an', '-dn', '-c:s', spec.encoder,
      ...(spec.kind === 'image' ? ['-ss', '0', '-t', durationSeconds.toFixed(6), '-avoid_negative_ts', 'disabled'] : []),
      '-map_metadata', '-1', '-map_chapters', '-1', '-f', spec.format, rawOutput,
    ], { signal: options.signal, timeoutMs: options.timeoutMs ?? TASK_TIMEOUT_MS });
    let cues;
    if (spec.kind === 'text') {
      if ((await fs.stat(rawSrt)).size > 8 * 1024 * 1024) throw new MediaError('SUBTITLE_OUTPUT_LIMIT', '字幕文件异常过大，未发布字幕。');
      const aligned = alignSrt(await fs.readFile(rawSrt, 'utf8'), { offsetSeconds: timeline.intermediateToCandidateOffsetSeconds, durationSeconds });
      if (!aligned.cues) throw new MediaError('SUBTITLE_EMPTY_RANGE', '所选字幕在本次获取的片段中没有可保存的字幕条目。');
      cues = aligned.cues;
      await fs.writeFile(temporaryPath, aligned.text, { flag: 'wx', mode: 0o600 });
    }
    const subtitleSize = (await fs.stat(temporaryPath)).size;
    if (!subtitleSize) throw new MediaError('SUBTITLE_EMPTY_RANGE', '所选字幕在本次获取的片段中没有可保存的字幕条目。');
    if (spec.extension === 'sup') {
      if (subtitleSize > 64 * 1024 * 1024) throw new MediaError('SUBTITLE_OUTPUT_LIMIT', '字幕文件异常过大，未发布字幕。');
      if (!hasPgsDisplay(await fs.readFile(temporaryPath))) throw new MediaError('SUBTITLE_EMPTY_RANGE', '本次字幕区间只有清屏或空事件，没有可保存的字幕画面。');
    }
    if (spec.extension === 'mks') {
      const checked = await runProcess(options.ffprobePath ?? 'ffprobe', [
        '-v', 'error', '-select_streams', 's:0', '-read_intervals', '%+#1', '-show_streams', '-show_packets',
        '-show_entries', 'stream=codec_type:packet=pts_time,size', '-of', 'json', temporaryPath,
      ], { signal: options.signal, timeoutMs: options.probeTimeoutMs ?? PROBE_TIMEOUT_MS });
      const parsed = JSON.parse(checked.stdout);
      if (!Array.isArray(parsed.streams) || parsed.streams.length !== 1 || parsed.streams[0].codec_type !== 'subtitle'
          || !Array.isArray(parsed.packets) || !parsed.packets.some(packet => Number(packet.size) > 0))
        throw new MediaError('SUBTITLE_EMPTY_RANGE', '本次区间没有可保存的字幕内容。');
    }
    return { temporaryPath, path: outputPath, format: spec.extension, language: track.language, codec: track.codec, kind: spec.kind,
      ...(cues ? { cues } : {}), timeline };
  } finally {
    await fs.rm(rawSrt, { force: true }).catch(() => {});
    // On success this temporary file remains for the owner's atomic publication.
  }
}

async function assertOutputDirectory(outputDir) {
  if (typeof outputDir !== 'string' || !path.isAbsolute(outputDir) || outputDir.includes('\0')) {
    throw new MediaError('INVALID_OUTPUT', '输出目录必须使用完整绝对路径。');
  }
  try { await fs.mkdir(outputDir, { recursive: true }); } catch (error) {
    if (error.code === 'ENAMETOOLONG') throw new MediaError('OUTPUT_PATH_TOO_LONG', '素材名称或保存路径过长，请缩短名称或选择较短的保存路径。');
    throw new MediaError('OUTPUT_NOT_WRITABLE', '无法创建输出目录，请检查权限和剩余空间；保存路径过长时请缩短后重试。');
  }
}

async function createJobDirectory(outputDir, jobId, clipName, signal) {
  assertNotAborted(signal);
  await assertOutputDirectory(outputDir);
  assertNotAborted(signal);
  if (clipName) {
    try { return await reserveNamedDirectory({ outputDir, clipName, signal }); }
    catch (error) { throw new MediaError(error.code || 'OUTPUT_NOT_WRITABLE', error.message); }
  }
  const directory = path.join(outputDir, jobId);
  try { await fs.mkdir(directory); } catch (error) {
    if (error.code === 'EEXIST') throw new MediaError('JOB_EXISTS', '同名任务目录已存在；为保护已有素材，请更换任务名称。');
    if (error.code === 'ENAMETOOLONG') throw new MediaError('OUTPUT_PATH_TOO_LONG', '素材名称或保存路径过长，请缩短名称或选择较短的保存路径。');
    throw new MediaError('OUTPUT_NOT_WRITABLE', '无法创建任务目录，请检查权限和剩余空间；保存路径过长时请缩短后重试。');
  }
  return directory;
}

async function exists(filename) {
  try { await fs.lstat(filename); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function verifyCandidate(filename, sourceMedia, tracks, options = {}) {
  const source = await checkedInput(filename, { localOnly: true });
  const media = await probeChecked(source, options);
  const video = media.streams.find((stream) => stream.type === 'video' && !stream.attachedPicture);
  if (!video || video.codec !== tracks.video.codec || video.width !== tracks.video.width || video.height !== tracks.video.height) {
    throw new MediaError('VIDEO_COPY_MISMATCH', '输出视频的编码或尺寸与原视频不一致，未发布该素材。');
  }
  if (!(media.durationSeconds > 0)) throw new MediaError('EMPTY_CANDIDATE', '输出素材没有有效时长。');
  const audio = media.streams.find((stream) => stream.type === 'audio');
  if (tracks.audio && (!audio || (!options.audioConverted && audio.codec !== tracks.audio.codec))) {
    throw new MediaError('AUDIO_COPY_MISMATCH', '输出素材未保留所选音轨，未发布该素材。');
  }
  // This is a bounded LOCAL validation; the remote movie is not scanned.
  const firstPackets = await runProcess(options.ffprobePath ?? 'ffprobe', [
    '-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+#1',
    '-show_packets', '-show_entries', 'packet=pts_time,dts_time,flags', '-of', 'json', filename,
  ], { signal: options.signal, timeoutMs: options.probeTimeoutMs ?? PROBE_TIMEOUT_MS });
  let packet;
  try { packet = JSON.parse(firstPackets.stdout)?.packets?.[0]; } catch { /* Handled below. */ }
  if (!packet || typeof packet.flags !== 'string' || !packet.flags.includes('K')) {
    throw new MediaError('NON_KEYFRAME_START', '候选素材首包不是可确认的关键帧，无法安全交付；请将开始时间前移后重试。');
  }
  const decoded = await runProcess(options.ffmpegPath ?? 'ffmpeg', [
    '-hide_banner', '-nostdin', '-loglevel', 'error', '-xerror', '-err_detect', 'explode',
    '-i', filename, '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '3',
    '-progress', 'pipe:1', '-nostats', '-f', 'null', '-',
  ], { signal: options.signal, timeoutMs: options.probeTimeoutMs ?? PROBE_TIMEOUT_MS, phase: 'validate' });
  if (!(Number(decoded.progress.frame) > 0)) throw new MediaError('DECODE_FAILED', '候选素材起始画面无法解码。');
  const changedColorFields = KNOWN_COLOR_FIELDS.filter((key) => tracks.video.color?.[key]
    && tracks.video.color[key] !== 'unknown' && tracks.video.color[key] !== video.color?.[key]);
  return {
    media,
    validation: {
      status: 'passed', firstVideoPacketIsKeyframe: true,
      decodedBeginningFrames: Number(decoded.progress.frame),
      fullDecodePerformed: false, originalCoverageVerified: false,
      colorFieldsMatch: changedColorFields.length === 0, changedColorFields,
      hdrDolbyVisionValidation: 'unverified', editorImportValidation: 'unverified',
    },
  };
}

function sourceReference(source, sourceId, sourceDescriptor) {
  const descriptorSize = sourceDescriptor?.sizeBytes;
  return {
    kind: sourceDescriptor?.remote === true ? 'gateway' : source.kind,
    id: typeof sourceId === 'string' ? redact(sourceId).slice(0, 128) : null,
    label: safeString(sourceDescriptor?.label, null, 255) ?? (source.name ? safeString(source.name, null, 255) : null),
    localFileName: sourceDescriptor?.remote === true ? null : (source.name ? safeString(source.name, null, 255) : null),
    sizeBytes: Number.isSafeInteger(descriptorSize) && descriptorSize > 0 ? descriptorSize : source.sizeBytes,
    // No URL, headers, query parameters or credentials are ever persisted.
  };
}

function checkedTargetRange(targetRange, fetchStart, fetchEnd) {
  if (targetRange === undefined) return null;
  if (!targetRange || typeof targetRange !== 'object') {
    throw new MediaError('INVALID_TARGET_RANGE', '目标范围信息无效。');
  }
  const startSeconds = parseTime(targetRange.startSeconds);
  const endSeconds = parseTime(targetRange.endSeconds);
  const handlesSeconds = targetRange.handlesSeconds === undefined ? null : parseTime(targetRange.handlesSeconds);
  if (endSeconds <= startSeconds || startSeconds < fetchStart || endSeconds > fetchEnd) {
    throw new MediaError('INVALID_TARGET_RANGE', '用户目标范围必须完整包含在本次获取范围内。');
  }
  return { startSeconds, endSeconds, durationSeconds: endSeconds - startSeconds, handlesSeconds };
}

function mappingFor(start, end, media) {
  return {
    status: 'unverified', requestedSourceStartSeconds: start, requestedSourceEndSeconds: end,
    actualSourceStartSeconds: null, actualSourceEndSeconds: null,
    localStartSeconds: media.startSeconds, localDurationSeconds: media.durationSeconds,
    sourceToLocalOffsetSeconds: null,
    note: '原码裁切可能回退到前一个关键帧，时间戳会重新归零；首版未标定源帧对应关系，不能把本地 0 秒当作请求起点。',
  };
}

async function writePreparedManifest(filename, manifest) {
  await fs.writeFile(filename, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

async function verifyPreparedCoverage(source, track, start, end, options) {
  let buffer = '', first = Infinity, last = -Infinity, keyBeforeStart = false, packets = 0;
  const [numerator, denominator = 1] = String(track.frameRate || '').split('/').map(Number);
  const tolerance = numerator > 0 && denominator > 0 ? Math.max(0.05, Math.min(0.5, 2 * denominator / numerator)) : 0.1;
  function line(value) {
    const fields = value.trim().split(',');
    if (fields.length < 3 || !fields[0] || fields[0] === 'N/A') return;
    const pts = Number(fields[0]), duration = Number(fields[1]);
    if (!Number.isFinite(pts)) return;
    packets++; first = Math.min(first, pts); last = Math.max(last, pts + (Number.isFinite(duration) && duration > 0 ? duration : 0));
    if (fields[2].includes('K') && pts <= start + tolerance) keyBeforeStart = true;
  }
  await runProcess(options.ffprobePath ?? 'ffprobe', [
    '-v', 'error', ...inputOptions(source), '-select_streams', String(track.index),
    '-show_packets', '-show_entries', 'packet=pts_time,duration_time,flags', '-of', 'csv=p=0', source.input,
  ], { signal: options.signal, input: source.input, timeoutMs: 120000, consumeStdout(chunk) {
    buffer += chunk.toString('utf8'); let newline;
    while ((newline = buffer.indexOf('\n')) !== -1) { line(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); }
    if (buffer.length > 8192) throw new MediaError('INVALID_PROBE_OUTPUT', '片段时间信息异常，已停止。');
  } });
  if (buffer.trim()) line(buffer);
  if (!packets || !keyBeforeStart || first > start + tolerance || last < end - tolerance) {
    throw new MediaError('PREPARED_COVERAGE_INCOMPLETE', '已读取的数据没有完整覆盖目标视频时间，未导出素材。');
  }
  return { status: 'passed', firstVideoTimestampSeconds: first, lastVideoEndSeconds: last, keyframeBeforeRequestedStart: keyBeforeStart, videoPackets: packets, toleranceSeconds: tolerance };
}

/**
 * One input range -> an independently decodable local MKV candidate.
 * The HTTP input must be a host-controlled loopback gateway with its own budget.
 */
export async function exportCandidate(options = {}) {
  const { sourceInput, outputDir, signal, onProgress } = options;
  assertNotAborted(signal);
  const start = parseTime(options.start);
  const end = parseTime(options.end);
  if (end <= start) throw new MediaError('INVALID_RANGE', '结束时间必须晚于开始时间。');
  const targetRange = checkedTargetRange(options.targetRange, start, end);
  const jobId = checkedJobId(options.jobId);
  const clipName = checkedClipName(options.clipName);
  const source = await checkedInput(sourceInput);
  if (options.getRemoteActivity !== undefined && typeof options.getRemoteActivity !== 'function') throw new MediaError('INVALID_TIMEOUT', '远程活动检查配置无效。');
  if (options.absoluteSeek && source.kind !== 'local') throw new MediaError('INVALID_PREPARATION', '按索引准备的片段必须是完整的本地文件。');
  emit(onProgress, { phase: 'probe', status: 'running', percent: null, message: '读取有限媒体信息。' });
  const inputMedia = await probeChecked(source, options);
  const sourceMedia = options.absoluteSeek && options.originalMedia ? options.originalMedia : inputMedia;
  if (sourceMedia.durationSeconds !== null && start >= sourceMedia.durationSeconds) {
    throw new MediaError('RANGE_OUTSIDE_SOURCE', '开始时间已超出视频总时长。');
  }
  if (sourceMedia.durationSeconds !== null && end > sourceMedia.durationSeconds + 0.5) {
    throw new MediaError('RANGE_OUTSIDE_SOURCE', '结束时间超出视频总时长，请缩短范围。');
  }
  const tracks = chooseTracks(sourceMedia, options);
  const subtitle = chooseSubtitle(sourceMedia, options.subtitleStreamIndex);
  let preparationCoverage;
  if (options.absoluteSeek) {
    for (const track of [tracks.video, tracks.audio, subtitle?.track].filter(Boolean)) {
      const inputTrack = inputMedia.streams.find(stream => stream.index === track.index);
      if (!inputTrack || inputTrack.type !== track.type || inputTrack.codec !== track.codec
        || (track.type === 'video' && (inputTrack.width !== track.width || inputTrack.height !== track.height))) {
        throw new MediaError('PREPARED_TRACK_MISMATCH', '已读取片段的轨道与原文件不一致，未导出素材。');
      }
    }
    emit(onProgress, { phase: 'probe', status: 'running', percent: null, message: '在本地核对目标视频的起止时间和关键帧。' });
    preparationCoverage = await verifyPreparedCoverage(source, tracks.video, start, end, options);
  }
  assertNotAborted(signal);
  const directory = await createJobDirectory(outputDir, jobId, clipName, signal);
  const stem = clipName ?? 'candidate';
  const candidatePath = path.join(directory, `${stem}.mkv`);
  const sidecarPath = path.join(directory, `${stem}.json`);
  const temporaryPath = path.join(directory, `${stem}.partial.mkv`);
  const temporarySidecar = path.join(directory, `${stem}.partial.json`);
  const intermediate = path.join(directory, `.${stem}.with-subtitle.partial.mkv`);
  const subtitleTemporary = subtitle ? path.join(directory, `.${stem}.subtitle.partial.${subtitle.spec.extension}`) : null;
  let committedSidecar = false;
  let committedCandidate = false;
  let committedSubtitle = false;
  let subtitleResult = null;
  const subtitleWarnings = [];
  try {
    emit(onProgress, { phase: 'extract', status: 'running', percent: null, message: '定位片段并获取原码候选素材。' });
    await runProcess(options.ffmpegPath ?? 'ffmpeg', [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-n',
      ...inputOptions(source), ...(options.absoluteSeek ? ['-seek_timestamp', '1'] : []), '-ss', start.toFixed(6), '-noaccurate_seek', '-i', source.input,
      '-t', (end - start).toFixed(6), '-map', `0:${tracks.video.index}`,
      ...(tracks.audio ? ['-map', `0:${tracks.audio.index}`] : []),
      ...(subtitle ? ['-map', `0:${subtitle.track.index}`] : []),
      '-c', 'copy', '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1',
      ...(tracks.audio?.language ? ['-metadata:s:a:0', `language=${tracks.audio.language}`] : []),
      '-avoid_negative_ts', 'make_zero', '-progress', 'pipe:1', '-nostats', '-f', 'matroska', subtitle ? intermediate : temporaryPath,
    ], { signal, input: source.input,
      timeoutMs: source.kind === 'gateway' ? timeoutValue(options.remoteDeadlineMs, REMOTE_DEADLINE_MS) : options.timeoutMs ?? TASK_TIMEOUT_MS,
      ...(source.kind === 'gateway' ? { activityStallTimeoutMs: timeoutValue(options.remoteStallTimeoutMs, REMOTE_STALL_MS), getReceivedBytes: options.getRemoteActivity } : {}),
      onProgress, phase: 'extract', durationSeconds: end - start });
    if (subtitle) {
      // Capture AV + one subtitle in a single source read, then remove the subtitle locally.
      // Subtitle synchronization below measures this remux's actual timestamp shift.
      await runProcess(options.ffmpegPath ?? 'ffmpeg', [
        '-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-i', intermediate,
        '-map', '0:v:0', ...(tracks.audio ? ['-map', '0:a:0'] : []), '-sn', '-dn', '-c', 'copy',
        '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1',
        ...(tracks.audio?.language ? ['-metadata:s:a:0', `language=${tracks.audio.language}`] : []),
        '-avoid_negative_ts', 'make_zero', '-f', 'matroska', temporaryPath,
      ], { signal, timeoutMs: options.timeoutMs ?? TASK_TIMEOUT_MS });
    }
    emit(onProgress, { phase: 'validate', status: 'running', percent: null, message: '在本地核对编码、时长和起始画面。' });
    const verified = await verifyCandidate(temporaryPath, sourceMedia, tracks, options);
    if (options.absoluteSeek && verified.media.durationSeconds + 0.5 < end - start) {
      throw new MediaError('CANDIDATE_TOO_SHORT', '导出片段没有覆盖所需时长，未发布该素材。');
    }
    assertNotAborted(signal);
    // A demuxer can sometimes return success after an interrupted network read.
    // The owner of the controlled source must approve publication independently.
    if (options.beforeCommit) await options.beforeCommit();
    assertNotAborted(signal);
    if (subtitle) {
      try {
        subtitleResult = await exportIndependentSubtitle({ intermediate, candidate: temporaryPath, tracks, subtitle,
          directory, stem, durationSeconds: verified.media.durationSeconds, options });
        assertNotAborted(signal);
        await fs.rename(subtitleResult.temporaryPath, subtitleResult.path);
        committedSubtitle = true;
        subtitleWarnings.push({ code: 'SUBTITLE_CUT_BOUNDARY', message: '字幕按成品时间保存；跨取材起点的长字幕可能未包含，请检查字幕首尾。' });
        if (subtitle.spec.kind === 'image') subtitleWarnings.push({ code: 'SUBTITLE_IMAGE_FORMAT', message: '所选轨道是图片字幕，已独立保存原格式；需要支持此格式的播放器，不能直接作为可编辑文字导入。' });
        if (['ass', 'ssa'].includes(subtitle.track.codec)) subtitleWarnings.push({ code: 'SUBTITLE_STYLE_SIMPLIFIED', message: 'ASS 字幕已导出为可编辑 SRT，字体、位置和特效样式未保留。' });
      } catch (error) {
        if (signal?.aborted || error?.code === 'CANCELLED') throw error;
        subtitleResult = null;
        await fs.rm(subtitleTemporary, { force: true }).catch(() => {});
        subtitleWarnings.push({ code: error?.code === 'SUBTITLE_EMPTY_RANGE' ? 'SUBTITLE_EMPTY_RANGE' : 'SUBTITLE_EXPORT_FAILED',
          message: error?.code === 'SUBTITLE_EMPTY_RANGE' ? '该片段已读取的数据中没有所选字幕条目；视频已保留。' : '独立字幕未能完成导出，视频已保留；可更换字幕轨道后重试。' });
      }
    }
    const manifest = {
      schemaVersion: 1, type: 'candidate', jobId, createdAt: new Date().toISOString(), status: 'ready',
      source: sourceReference(source, options.sourceId, options.sourceDescriptor),
      requestedRange: { startSeconds: start, endSeconds: end, durationSeconds: end - start },
      targetRange,
      selectedTracks: { video: tracks.video, audio: tracks.audio, ...(subtitle ? { subtitle: subtitle.track } : {}) },
      omittedTracks: sourceMedia.streams.filter((stream) => ![tracks.video.index, tracks.audio?.index].includes(stream.index))
        .map((stream) => ({ index: stream.index, type: stream.type, codec: stream.codec, language: stream.language })),
      processing: { video: 'copy', audio: tracks.audio ? 'copy' : 'none', container: 'matroska', subtitles: subtitleResult ? 'independent-file' : 'omitted', attachments: 'omitted', chapters: 'omitted', globalMetadata: 'omitted' },
      ...(options.absoluteSeek ? { inputPreparation: { method: 'matroska-index-window', timestampCoordinates: 'original-source', sourceStart: options.preparation?.sourceStart, sourceEnd: options.preparation?.sourceEnd, cueSeconds: options.preparation?.cueSeconds, coverage: preparationCoverage } } : {}),
      mapping: mappingFor(start, end, verified.media),
      output: { file: path.basename(candidatePath), media: verified.media }, validation: verified.validation,
      ...(clipName ? { clipName } : {}),
      subtitles: { requestedStreamIndex: subtitle?.track.index ?? null, status: subtitleResult ? 'exported' : subtitle ? 'unavailable' : 'not-requested',
        timeBase: 'candidate', selectedTrack: subtitle?.track ?? null,
        files: subtitleResult ? [{ file: path.basename(subtitleResult.path), format: subtitleResult.format, codec: subtitleResult.codec, language: subtitleResult.language, kind: subtitleResult.kind, ...(subtitleResult.cues ? { cues: subtitleResult.cues } : {}), timeline: subtitleResult.timeline }] : [], warnings: subtitleWarnings },
      sourceMedia, warnings: [
        '视频文件仅保留所选视频和音轨；字幕可另存独立文件，附件、其他轨道与章节不在视频内。',
        ...subtitleWarnings.map(warning => warning.message),
        '原码输出不代表已通过剪映导入、HDR 或杜比视界验证。',
        ...(source.kind === 'gateway' || options.sourceDescriptor?.remote === true ? ['网络读取预算与统计由本机网关负责；上游真实预取量不能由媒体引擎保证。'] : []),
      ],
    };
    await writePreparedManifest(temporarySidecar, manifest);
    assertNotAborted(signal);
    // The task directory was created exclusively. No existing artifact is overwritten.
    await fs.rename(temporarySidecar, sidecarPath);
    committedSidecar = true;
    await fs.rename(temporaryPath, candidatePath);
    committedCandidate = true;
    emit(onProgress, { phase: 'complete', status: 'completed', percent: 100, message: '原码候选片段已保留，可离线使用。' });
    return { jobId, candidatePath, sidecarPath, media: verified.media, manifest,
      subtitlePaths: subtitleResult ? [subtitleResult.path] : [],
      subtitleResults: subtitleResult ? [{ path: subtitleResult.path, format: subtitleResult.format, codec: subtitleResult.codec, language: subtitleResult.language, kind: subtitleResult.kind }] : [], subtitleWarnings };
  } catch (error) {
    await Promise.allSettled([fs.rm(temporaryPath, { force: true }), fs.rm(temporarySidecar, { force: true }),
      ...(!committedCandidate && committedSidecar ? [fs.rm(sidecarPath, { force: true })] : [])]);
    if (!committedCandidate) await fs.rmdir(directory).catch(() => {});
    if (error instanceof MediaError) throw error;
    if (error.code === 'ENAMETOOLONG') throw new MediaError('OUTPUT_PATH_TOO_LONG', '素材名称或保存路径过长，请缩短名称或选择较短的保存路径。');
    throw new MediaError('OUTPUT_FAILED', '无法保存候选素材，请检查剩余空间和输出目录权限；名称或保存路径过长时请缩短后重试。', { reason: redact(error.message, source.input) });
  } finally {
    await Promise.allSettled([fs.rm(intermediate, { force: true }),
      ...(subtitleTemporary ? [fs.rm(subtitleTemporary, { force: true })] : []),
      ...(!committedCandidate && committedSubtitle && subtitleResult ? [fs.rm(subtitleResult.path, { force: true })] : []),
    ]);
    if (!committedCandidate) await fs.rmdir(directory).catch(() => {});
  }
}

/** A local-only derivative: video stream copy, first audio -> AAC stereo. */
export async function exportCompatibleMp4(options = {}) {
  const { candidatePath, signal, onProgress } = options;
  assertNotAborted(signal);
  emit(onProgress, { phase: 'compatible', status: 'running', percent: null, message: '读取本地主本信息，准备 MP4 工作副本。' });
  const source = await checkedInput(candidatePath, { localOnly: true });
  const sourceMedia = await probeChecked(source, options);
  const tracks = chooseTracks(sourceMedia, {});
  if (!['h264', 'hevc', 'av1'].includes(tracks.video.codec)) {
    throw new MediaError('MP4_VIDEO_UNSUPPORTED', '首版 MP4 派生仅支持 H.264、HEVC 和 AV1 视频原码复制；原码主本已保留。');
  }
  const directory = options.outputDir ?? path.dirname(candidatePath);
  await assertOutputDirectory(directory);
  const jobId = checkedJobId(options.jobId ?? 'compatible');
  const clipName = checkedClipName(options.clipName, { allowNumberedCopy: true });
  const stem = clipName ?? (jobId === 'compatible' ? 'compatible' : `${jobId}.compatible`);
  const outputPath = path.join(directory, `${stem}.mp4`);
  const sidecarPath = path.join(directory, clipName ? `${stem}.mp4.json` : `${stem}.json`);
  const temporaryPath = path.join(directory, `${stem}.${randomUUID()}.partial.mp4`);
  const temporarySidecar = `${temporaryPath}.json`;
  const lockPath = path.join(directory, `.${stem}.lock`);
  let lock;
  try { lock = await fs.open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code === 'EEXIST') throw new MediaError('OUTPUT_BUSY', '同名兼容输出正在处理，请等待任务完成或更换名称。');
    if (error.code === 'ENAMETOOLONG') throw new MediaError('OUTPUT_PATH_TOO_LONG', '素材名称或保存路径过长，请缩短名称或选择较短的保存路径。');
    throw new MediaError('OUTPUT_NOT_WRITABLE', '无法写入兼容输出目录，请检查权限；名称或保存路径过长时请缩短后重试。');
  }
  let committedOutput = false;
  let committedSidecar = false;
  try {
    if (await exists(outputPath) || await exists(sidecarPath)) throw new MediaError('OUTPUT_EXISTS', '兼容输出已存在；为保护已有素材，请更换任务名称。');
    emit(onProgress, { phase: 'compatible', status: 'running', percent: null,
      message: tracks.audio ? '从本地主本复制视频，并将音频转为 AAC 双声道。' : '从本地主本复制视频到 MP4。' });
    await runProcess(options.ffmpegPath ?? 'ffmpeg', [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-n', '-i', source.input,
      '-map', `0:${tracks.video.index}`, ...(tracks.audio ? ['-map', `0:${tracks.audio.index}`] : []),
      '-c:v', 'copy', ...(tracks.video.codec === 'hevc' ? ['-tag:v', 'hvc1'] : []),
      ...(tracks.audio ? ['-c:a', 'aac', '-b:a', '320k', '-ac', '2'] : []),
      '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1',
      ...(tracks.audio?.language ? ['-metadata:s:a:0', `language=${tracks.audio.language}`] : []),
      '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-f', 'mp4', temporaryPath,
    ], { signal, timeoutMs: options.timeoutMs ?? TASK_TIMEOUT_MS, onProgress, phase: 'compatible', durationSeconds: sourceMedia.durationSeconds });
    emit(onProgress, { phase: 'validate', status: 'running', percent: null, message: '在本地核对 MP4 编码、时长和起始画面。' });
    const verified = await verifyCandidate(temporaryPath, sourceMedia, tracks, { ...options, audioConverted: true });
    assertNotAborted(signal);
    const manifest = {
      schemaVersion: 1, type: 'compatible-derivative', jobId, createdAt: new Date().toISOString(), status: 'ready',
      source: { kind: 'local-candidate', fileName: path.basename(candidatePath) },
      processing: { video: 'copy', audio: tracks.audio ? 'aac-320k-stereo' : 'none', container: 'mp4', hdrToneMapping: 'none' },
      output: { file: path.basename(outputPath), media: verified.media }, validation: verified.validation,
      warnings: ['视频未重新编码；音轨存在时转换为有损 AAC 双声道。', '剪映导入和 HDR / 杜比视界效果仍需在当前版本实际验证。',
        '本地派生文件与主本的帧时间映射尚未标定，不用于自动回算原片入出点。'],
    };
    await writePreparedManifest(temporarySidecar, manifest);
    assertNotAborted(signal);
    await fs.rename(temporarySidecar, sidecarPath);
    committedSidecar = true;
    await fs.rename(temporaryPath, outputPath);
    committedOutput = true;
    emit(onProgress, { phase: 'complete', status: 'completed', percent: 100, message: 'MP4 派生完成，原码主本仍保留。' });
    return { jobId, outputPath, sidecarPath, media: verified.media, manifest };
  } catch (error) {
    if (error instanceof MediaError) throw error;
    if (error.code === 'ENAMETOOLONG') throw new MediaError('OUTPUT_PATH_TOO_LONG', '素材名称或保存路径过长，请缩短名称或选择较短的保存路径。');
    throw new MediaError('COMPATIBLE_FAILED', '兼容输出失败；原码主本仍保留。名称或保存路径过长时请缩短后重试。', { reason: redact(error.message) });
  } finally {
    await Promise.allSettled([fs.rm(temporaryPath, { force: true }), fs.rm(temporarySidecar, { force: true }),
      ...(!committedOutput && committedSidecar ? [fs.rm(sidecarPath, { force: true })] : [])]);
    await lock.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}
