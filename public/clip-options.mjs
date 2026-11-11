// Shared by the desktop form and server. This is a filename stem, never a path.
// Leave space below the usual 255-byte component limit for media extensions and
// subtitle language/format suffixes. The caller owns the containing directory.
export const CLIP_NAME_MAX_BYTES = 180;

const GENERATED_EXTENSION = /\.(?:mkv|mp4|m4v|mov|avi|webm|m2ts|mts|ts|mpeg|mpg|wmv|flv|ogv|srt|ass|ssa|vtt|sup|sub|idx|json)$/i;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;

function utf8Length(character) {
  const point = character.codePointAt(0);
  return point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4;
}

function truncateUtf8(value, maximum) {
  let result = '', bytes = 0;
  for (const character of value) {
    const next = utf8Length(character);
    if (bytes + next > maximum) break;
    result += character; bytes += next;
  }
  return result;
}

function stripGeneratedExtensions(value) {
  let result = value;
  while (GENERATED_EXTENSION.test(result)) result = result.replace(GENERATED_EXTENSION, '').trimEnd();
  return result;
}

/** Return a cross-platform filename stem, or '' when no usable name remains. */
export function sanitizeClipName(value) {
  if (typeof value !== 'string') return '';
  let name = value.normalize('NFC')
    // Drop isolated surrogates and invisible direction overrides, retain emoji.
    .replace(/\p{Surrogate}/gu, '')
    .replace(/[\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu, '');
  name = name.split(/[\\/]/).filter(Boolean).at(-1) || '';
  name = name.replace(/[\u0000-\u001f\u007f-\u009f<>:"|?*]/g, '_')
    .replace(/\s+/gu, ' ').trim().replace(/[. ]+$/g, '');
  name = stripGeneratedExtensions(name).replace(/^[. ]+|[. ]+$/g, '');
  if (!name) return '';
  // Windows reserves the first dot-delimited component even with an extension.
  if (DEVICE_NAME.test(name.split('.')[0].trimEnd())) name = '_' + name;
  return stripGeneratedExtensions(truncateUtf8(name, CLIP_NAME_MAX_BYTES)).replace(/[. ]+$/g, '');
}

function sourceTitle(sourceLabel) {
  if (typeof sourceLabel !== 'string') return '电影';
  let title = sourceLabel.split(/[\\/]/).filter(Boolean).at(-1) || '';
  title = stripGeneratedExtensions(title.normalize('NFC').trim());
  // Remove only explicit distribution banners, never arbitrary bracketed titles.
  title = title.replace(/^(?:【[^】]*(?:影视之家|发布|转载|www\.)[^】]*】|\[[^\]]*(?:影视之家|发布|转载|www\.)[^\]]*\])\s*/i, '');
  // A recognizable technical release block may be omitted from a suggestion.
  // Preserve years and other title words; their meaning cannot be inferred safely.
  const release = /[ ._]+(?:(?:2160|1080|720|480)[pi]|UHD|Blu[ ._-]?Ray|BDRemux|BDRip|BRRip|WEB[ ._-]?(?:DL|Rip)|HDTV|DVDRip|Remux|HEVC|x26[45]|H26[45]|TrueHD|Hybrid)(?=[ ._+-]|$)/i.exec(title);
  if (release?.index > 0) title = title.slice(0, release.index).replace(/[._]+/g, ' ');
  return sanitizeClipName(title) || '电影';
}

function filenameTime(seconds) {
  const value = Number(seconds);
  const micros = Number.isFinite(value) && value >= 0 ? Math.round(value * 1e6) : 0;
  const total = Number.isSafeInteger(micros) ? micros : 0;
  const whole = Math.floor(total / 1e6), fraction = total % 1e6;
  const hours = Math.floor(whole / 3600), minutes = Math.floor(whole / 60) % 60, rest = whole % 60;
  const pad = number => String(number).padStart(2, '0');
  return `${pad(hours)}-${pad(minutes)}-${pad(rest)}${fraction ? '.' + String(fraction).padStart(6, '0').replace(/0+$/, '') : ''}`;
}

/** Suggest a name from the user's requested interval, without download handles. */
export function defaultClipName(sourceLabel, startSeconds, endSeconds) {
  const suffix = `_${filenameTime(startSeconds)}_${filenameTime(endSeconds)}`;
  // Time suffixes are ASCII. Truncate the title first so they are never lost.
  const title = truncateUtf8(sourceTitle(sourceLabel), CLIP_NAME_MAX_BYTES - suffix.length).replace(/[. ]+$/g, '') || '电影';
  return sanitizeClipName(title + suffix);
}
