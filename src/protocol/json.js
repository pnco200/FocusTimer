import { DEFAULT_MAX_PARSE_BYTES, MAX_COUNTER, MAX_DEPTH } from './constants.js';
import { malformed, ResourceLimitError } from './errors.js';
import { decodeUtf8 } from './utf8.js';

/**
 * RFC 8259 with v1's integer lexemes, scalar strings and decoded-name uniqueness.
 * The byte ceiling is application policy; Infinity explicitly opts out.
 */
export function parseWireJson(bytes, { maxBytes = DEFAULT_MAX_PARSE_BYTES, maxDepth = MAX_DEPTH } = {}) {
  if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw new TypeError('maxBytes must be a nonnegative safe integer or Infinity');
  }
  if (!(bytes instanceof Uint8Array)) malformed('Wire input must be UTF-8 bytes');
  if (bytes.length > maxBytes) throw new ResourceLimitError(maxBytes, bytes.length);
  const source = decodeUtf8(bytes);
  let pos = 0;
  const fail = () => malformed(`Invalid JSON at offset ${pos}`);
  const white = () => { while (pos < source.length && ' \t\r\n'.includes(source[pos])) pos++; };
  const hex4 = () => {
    const token = source.slice(pos, pos + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(token)) fail();
    pos += 4;
    return Number.parseInt(token, 16);
  };
  const string = () => {
    if (source[pos++] !== '"') fail();
    const pieces = [];
    let start = pos;
    while (pos < source.length) {
      const char = source[pos++];
      if (char === '"') { pieces.push(source.slice(start, pos - 1)); return pieces.join(''); }
      if (char.charCodeAt(0) < 0x20) fail();
      if (char !== '\\') continue;
      pieces.push(source.slice(start, pos - 1));
      const escape = source[pos++];
      const simple = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (Object.hasOwn(simple, escape)) pieces.push(simple[escape]);
      else if (escape === 'u') {
        const unit = hex4();
        if (unit >= 0xd800 && unit <= 0xdbff) {
          if (source.slice(pos, pos + 2) !== '\\u') fail();
          pos += 2;
          const low = hex4();
          if (low < 0xdc00 || low > 0xdfff) fail();
          pieces.push(String.fromCodePoint(0x10000 + (unit - 0xd800) * 1024 + low - 0xdc00));
        } else if (unit >= 0xdc00 && unit <= 0xdfff) fail();
        else pieces.push(String.fromCharCode(unit));
      } else fail();
      start = pos;
    }
    fail();
  };
  const value = depth => {
    white();
    const char = source[pos];
    if (char === '{' || char === '[') {
      if (depth + 1 > maxDepth) malformed('Container depth limit exceeded');
      pos++;
      white();
      if (char === '[') {
        const array = [];
        if (source[pos] === ']') { pos++; return array; }
        for (;;) {
          array.push(value(depth + 1));
          white();
          if (source[pos] === ']') { pos++; return array; }
          if (source[pos++] !== ',') fail();
        }
      }
      const object = Object.create(null);
      if (source[pos] === '}') { pos++; return object; }
      for (;;) {
        white();
        if (source[pos] !== '"') fail();
        const key = string();
        if (Object.hasOwn(object, key)) malformed('Duplicate decoded JSON object name');
        white();
        if (source[pos++] !== ':') fail();
        object[key] = value(depth + 1);
        white();
        if (source[pos] === '}') { pos++; return object; }
        if (source[pos++] !== ',') fail();
      }
    }
    if (char === '"') return string();
    for (const [token, result] of [['true', true], ['false', false], ['null', null]]) {
      if (source.startsWith(token, pos)) { pos += token.length; return result; }
    }
    if (char >= '0' && char <= '9') {
      const start = pos++;
      if (char !== '0') while (source[pos] >= '0' && source[pos] <= '9') pos++;
      // Range check as decimal text BEFORE conversion, never after rounding.
      const token = source.slice(start, pos);
      const maximum = String(MAX_COUNTER);
      if (token.length > maximum.length || (token.length === maximum.length && token > maximum)) {
        malformed('Integer exceeds exact safe range');
      }
      return Number(token);
    }
    fail();
  };
  const result = value(0);
  white();
  if (pos !== source.length) fail();
  return result;
}
