import { isUtf8 } from 'node:buffer';

// ditto writes UTF-8 name bytes without ZIP's language-encoding flag. Mark the
// existing bytes in both headers; compressed data, permissions and offsets stay
// untouched. Source packages are small, single-disk ZIP32 archives only.
export function markZipNamesUtf8(archive) {
  if (!Buffer.isBuffer(archive)) throw new TypeError('Expected ZIP bytes.');
  const invalid = () => { throw new Error('Invalid or unsupported source ZIP.'); };
  let end = -1;
  for (let p = archive.length - 22; p >= Math.max(0, archive.length - 65557); p--) {
    if (archive.readUInt32LE(p) === 0x06054b50 && p + 22 + archive.readUInt16LE(p + 20) === archive.length) { end = p; break; }
  }
  if (end < 0) invalid();
  const count = archive.readUInt16LE(end + 10);
  const directorySize = archive.readUInt32LE(end + 12), directoryStart = archive.readUInt32LE(end + 16);
  if (archive.readUInt16LE(end + 4) !== 0 || archive.readUInt16LE(end + 6) !== 0
      || archive.readUInt16LE(end + 8) !== count || count === 0xffff
      || directorySize === 0xffffffff || directoryStart === 0xffffffff
      || directoryStart + directorySize !== end) invalid();
  const flagOffsets = [];
  let cursor = directoryStart;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) invalid();
    const nameLength = archive.readUInt16LE(cursor + 28), extraLength = archive.readUInt16LE(cursor + 30), commentLength = archive.readUInt16LE(cursor + 32);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    const local = archive.readUInt32LE(cursor + 42), compressedSize = archive.readUInt32LE(cursor + 20);
    if (next > end || nameLength === 0 || archive.readUInt16LE(cursor + 34) !== 0
        || local === 0xffffffff || compressedSize === 0xffffffff || archive.readUInt32LE(cursor + 24) === 0xffffffff
        || local + 30 > directoryStart || archive.readUInt32LE(local) !== 0x04034b50) invalid();
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength);
    const comment = archive.subarray(next - commentLength, next);
    const localNameLength = archive.readUInt16LE(local + 26), localExtraLength = archive.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    if (dataStart + compressedSize > directoryStart || localNameLength !== nameLength
        || !archive.subarray(local + 30, local + 30 + localNameLength).equals(name)
        || !isUtf8(name) || !isUtf8(comment)) invalid();
    flagOffsets.push(cursor + 8, local + 6);
    cursor = next;
  }
  if (cursor !== end) invalid();
  const result = Buffer.from(archive);
  for (const offset of flagOffsets) result.writeUInt16LE(result.readUInt16LE(offset) | 0x0800, offset);
  return result;
}
