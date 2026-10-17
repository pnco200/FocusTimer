import { malformed } from './errors.js';

/** No runtime codec dependency: reject overlong encodings, surrogates, BOM and truncation. */
export function decodeUtf8(bytes) {
  if (!(bytes instanceof Uint8Array)) malformed('Wire input must be UTF-8 bytes');
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) malformed('UTF-8 BOM');
  const chunks = [];
  let scalars = [];
  for (let i = 0; i < bytes.length;) {
    const lead = bytes[i++];
    let value;
    let extra;
    let minimum;
    if (lead <= 0x7f) { value = lead; extra = 0; minimum = 0; }
    else if (lead >= 0xc2 && lead <= 0xdf) { value = lead & 0x1f; extra = 1; minimum = 0x80; }
    else if (lead >= 0xe0 && lead <= 0xef) { value = lead & 0x0f; extra = 2; minimum = 0x800; }
    else if (lead >= 0xf0 && lead <= 0xf4) { value = lead & 7; extra = 3; minimum = 0x10000; }
    else malformed('Invalid UTF-8 leading byte');
    if (i + extra > bytes.length) malformed('Truncated UTF-8');
    for (let j = 0; j < extra; j++) {
      const next = bytes[i++];
      if ((next & 0xc0) !== 0x80) malformed('Invalid UTF-8 continuation');
      value = value * 64 + (next & 0x3f);
    }
    if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
      malformed('Invalid UTF-8 scalar');
    }
    scalars.push(value);
    if (scalars.length === 4096) { chunks.push(String.fromCodePoint(...scalars)); scalars = []; }
  }
  if (scalars.length) chunks.push(String.fromCodePoint(...scalars));
  return chunks.join('');
}

export function scalarCount(value) {
  if (typeof value !== 'string') malformed('Expected scalar string');
  let count = 0;
  for (let i = 0; i < value.length; i++, count++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const low = value.charCodeAt(++i);
      if (!(low >= 0xdc00 && low <= 0xdfff)) malformed('Unpaired surrogate');
    } else if (unit >= 0xdc00 && unit <= 0xdfff) malformed('Unpaired surrogate');
  }
  return count;
}

export function encodeUtf8(value) {
  scalarCount(value);
  let length = 0;
  for (const char of value) {
    const scalar = char.codePointAt(0);
    length += scalar < 0x80 ? 1 : scalar < 0x800 ? 2 : scalar < 0x10000 ? 3 : 4;
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const char of value) {
    const scalar = char.codePointAt(0);
    if (scalar < 0x80) bytes[offset++] = scalar;
    else if (scalar < 0x800) {
      bytes[offset++] = 0xc0 | (scalar >> 6);
      bytes[offset++] = 0x80 | (scalar & 0x3f);
    } else if (scalar < 0x10000) {
      bytes[offset++] = 0xe0 | (scalar >> 12);
      bytes[offset++] = 0x80 | ((scalar >> 6) & 0x3f);
      bytes[offset++] = 0x80 | (scalar & 0x3f);
    } else {
      bytes[offset++] = 0xf0 | (scalar >> 18);
      bytes[offset++] = 0x80 | ((scalar >> 12) & 0x3f);
      bytes[offset++] = 0x80 | ((scalar >> 6) & 0x3f);
      bytes[offset++] = 0x80 | (scalar & 0x3f);
    }
  }
  return bytes;
}
