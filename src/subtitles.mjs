/** Independent subtitle export policy. No network access, rendering or OCR. */
const TEXT = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
export function subtitleExportSpec(codec) {
  if (TEXT.has(codec)) return { extension: 'srt', format: 'srt', encoder: 'subrip', kind: 'text' };
  if (codec === 'hdmv_pgs_subtitle') return { extension: 'sup', format: 'sup', encoder: 'copy', kind: 'image' };
  if (codec === 'dvd_subtitle') return { extension: 'mks', format: 'matroska', encoder: 'copy', kind: 'image' };
  return null;
}
function milliseconds(text) {
  const match = /^(-?)(\d{2,4}):([0-5]\d):([0-5]\d)[,.](\d{3})$/.exec(text);
  if (!match) return null;
  const result = ((Number(match[2]) * 60 + Number(match[3])) * 60 + Number(match[4])) * 1000 + Number(match[5]);
  return match[1] ? -result : result;
}
function stamp(value) {
  const rounded = Math.max(0, Math.round(value));
  return `${String(Math.floor(rounded / 3600000)).padStart(2, '0')}:${String(Math.floor(rounded / 60000) % 60).padStart(2, '0')}:${String(Math.floor(rounded / 1000) % 60).padStart(2, '0')},${String(rounded % 1000).padStart(3, '0')}`;
}
/** Shift using a locally verified AV packet offset, then clip to the actual exported duration. */
export function alignSrt(text, { offsetSeconds = 0, durationSeconds } = {}) {
  if (typeof text !== 'string' || !Number.isFinite(offsetSeconds) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error('INVALID_SUBTITLE_TIMELINE');
  const blocks = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n\s*\n/);
  const cues = [];
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split('\n');
    if (/^\d+$/.test(lines[0].trim())) lines.shift();
    const match = /^(\S+)\s+-->\s+(\S+)(?:\s.*)?$/.exec(lines.shift() || '');
    if (!match || !lines.length) throw new Error('INVALID_SUBTITLE_TIMELINE');
    const start = milliseconds(match[1]), end = milliseconds(match[2]);
    if (start === null || end === null || end <= start) throw new Error('INVALID_SUBTITLE_TIMELINE');
    const clippedStart = Math.max(0, Math.round(start + offsetSeconds * 1000)), clippedEnd = Math.round(Math.min(durationSeconds * 1000, end + offsetSeconds * 1000));
    if (clippedEnd <= clippedStart || !lines.join('\n').trim()) continue;
    cues.push({ start: clippedStart, end: clippedEnd, text: lines.join('\n') });
  }
  return { text: cues.map((cue, i) => `${i + 1}\n${stamp(cue.start)} --> ${stamp(cue.end)}\n${cue.text}\n`).join('\n'), cues: cues.length };
}

/** Validate SUP segment framing and detect at least one PGS presentation with objects. */
export function hasPgsDisplay(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('INVALID_PGS_SUBTITLE');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 0, displayed = false;
  while (position < bytes.length) {
    if (bytes.length - position < 13 || bytes[position] !== 0x50 || bytes[position + 1] !== 0x47) throw new Error('INVALID_PGS_SUBTITLE');
    const type = bytes[position + 10], length = view.getUint16(position + 11);
    const start = position + 13, end = start + length;
    if (end > bytes.length) throw new Error('INVALID_PGS_SUBTITLE');
    if (type === 0x16) {
      if (length < 11) throw new Error('INVALID_PGS_SUBTITLE');
      const count = bytes[start + 10]; let cursor = start + 11;
      for (let object = 0; object < count; object++) {
        if (cursor + 8 > end) throw new Error('INVALID_PGS_SUBTITLE');
        const cropped = (bytes[cursor + 3] & 0x80) !== 0;
        cursor += cropped ? 16 : 8;
        if (cursor > end) throw new Error('INVALID_PGS_SUBTITLE');
      }
      if (cursor !== end) throw new Error('INVALID_PGS_SUBTITLE');
      if (count > 0) displayed = true;
    }
    position = end;
  }
  return displayed;
}
