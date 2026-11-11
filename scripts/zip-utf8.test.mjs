import test from 'node:test';
import assert from 'node:assert/strict';
import { markZipNamesUtf8 } from './zip-utf8.mjs';

function fixture(names = ['source/README.md', 'source/使用说明.md', 'source/启动片段取材.command']) {
  const locals = [], directory = [], locations = [];
  let offset = 0;
  for (const value of names) {
    const name = Buffer.isBuffer(value) ? value : Buffer.from(value);
    // Include ZIP signatures inside file data: only indexed headers may change.
    const data = Buffer.from('unchanged PK\x03\x04 and PK\x01\x02 payload');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locations.push({ local: offset, central: directory.reduce((sum, b) => sum + b.length, 0) });
    locals.push(local, name, data); directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(names.length, 8); end.writeUInt16LE(names.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(offset, 16);
  return { bytes: Buffer.concat([...locals, central, end]), locations: locations.map(l => ({ ...l, central: l.central + offset })) };
}

test('UTF-8 ZIP marking preserves every byte except local and central name flags', () => {
  const { bytes, locations } = fixture(), original = Buffer.from(bytes);
  const result = markZipNamesUtf8(bytes), expected = Buffer.from(bytes);
  for (const { local, central } of locations) {
    expected.writeUInt16LE(0x0800, local + 6); expected.writeUInt16LE(0x0800, central + 8);
    assert.equal(result.readUInt16LE(local + 6) & 0x0800, 0x0800);
    assert.equal(result.readUInt16LE(central + 8) & 0x0800, 0x0800);
    const length = result.readUInt16LE(central + 28);
    assert.equal(result.subarray(central + 46, central + 46 + length).toString('utf8'), bytes.subarray(local + 30, local + 30 + length).toString('utf8'));
  }
  assert.deepEqual(result, expected);
  assert.deepEqual(bytes, original, 'the input is never partially rewritten');
  assert.deepEqual(markZipNamesUtf8(result), result, 'already-correct archives are unchanged');
});

test('invalid UTF-8 or different local names cannot be relabeled as UTF-8', () => {
  const badEncoding = fixture([Buffer.from([0x63, 0xc3, 0x28])]).bytes;
  assert.throws(() => markZipNamesUtf8(badEncoding), /Invalid or unsupported/);
  const { bytes, locations } = fixture();
  bytes[locations[1].local + 30] ^= 1;
  assert.throws(() => markZipNamesUtf8(bytes), /Invalid or unsupported/);
});

test('truncated, multi-disk and ZIP64 archives fail instead of guessing header locations', () => {
  const { bytes } = fixture();
  assert.throws(() => markZipNamesUtf8(bytes.subarray(0, -1)), /Invalid or unsupported/);
  for (const [offset, size, value] of [[4, 2, 1], [8, 2, 1], [10, 2, 0xffff], [12, 4, 0xffffffff], [16, 4, 0xffffffff]]) {
    const malformed = Buffer.from(bytes), end = malformed.length - 22;
    malformed[size === 2 ? 'writeUInt16LE' : 'writeUInt32LE'](value, end + offset);
    assert.throws(() => markZipNamesUtf8(malformed), /Invalid or unsupported/);
  }
});
