import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import {
  ProtocolError, MAX_COUNTER, MAX_DURATION_MS, MAX_SEGMENT_BYTES, encodeUtf8, decodeUtf8,
  parseWireJson, parseSession, parseDescriptor, parseOperation, parseSegment,
  validateUuid, uuidBytes, compareUuid, validateTimestamp, scalarCount,
  validateSession, validateOperation, authorDescription, compareVersions,
  operationEqual, reduceOperations, incorporateHighWater, nextCounter, CounterExhaustedError,
} from '../src/protocol/index.js';
import { ids, uuid, session, upsert, deletion, segment, random, shuffle } from '../test-support/fixtures.js';

const wire = value => encodeUtf8(JSON.stringify(value));
const rejects = (action, classification = 'malformed') => assert.throws(action, error => error instanceof ProtocolError && error.classification === classification);

test('closed shapes return independent snapshots; positive focus is independent of chronology', () => {
  const value = session({ startedAt: '9999-12-31T23:59:59.999Z', endedAt: '0001-01-01T00:00:00.000Z', focusDurationMs: 1, description: '' });
  assert.deepEqual(parseSession(wire(value)), value);
  const original = upsert();
  const clone = validateOperation(original);
  clone.payload.description = 'new';
  assert.equal(original.payload.description, 'Database study');
  rejects(() => validateSession(Object.assign(Object.create({}), session())));
  const inherited = Object.create({ description: 'inherited' });
  Object.assign(inherited, session());
  delete inherited.description;
  rejects(() => validateSession(inherited));
});

for (const [name, transform] of [
  ['missing', s => { delete s.description; }], ['null', s => { s.description = null; }],
  ['wrong type', s => { s.focusDurationMs = '1'; }], ['zero', s => { s.focusDurationMs = 0; }],
  ['negative zero', s => { s.focusDurationMs = -0; }], ['above duration', s => { s.focusDurationMs = MAX_DURATION_MS + 1; }],
  ['NaN', s => { s.focusDurationMs = NaN; }], ['Infinity', s => { s.focusDurationMs = Infinity; }],
]) test(`session rejects ${name}`, () => { const value = session(); transform(value); rejects(() => validateSession(value)); });

test('unknown persistent fields and semantic selectors are unsupported', () => {
  rejects(() => parseSession(wire(session({ createdAt: '2026-10-17T00:00:00.000Z' }))), 'unsupported');
  for (const change of [{ protocolVersion: 2 }, { schemaVersion: 2 }, { entityType: 'timer' }, { operation: 'PATCH' }, { metadata: {} }]) {
    rejects(() => parseOperation(wire(upsert(1, 1, change))), 'unsupported');
  }
  rejects(() => parseDescriptor(wire({ application: 'other', protocolVersion: 1, datasetId: ids.dataset })));
});

test('complete snapshot required and DELETE forbids payload, including null', () => {
  const incomplete = upsert();
  delete incomplete.payload.startedAt;
  rejects(() => parseOperation(wire(incomplete)));
  assert.deepEqual(parseOperation(wire(deletion())), deletion());
  rejects(() => parseOperation(wire({ ...deletion(), payload: null })));
  rejects(() => parseOperation(wire({ ...deletion(), payload: session() })));
  rejects(() => parseOperation(wire(upsert(1, 1, { payload: session({ id: uuid(999) }) }))));
});

for (const value of [
  ids.entity.toUpperCase().replace('44000000', '44AAAAAA'), `{${ids.entity}}`, `urn:uuid:${ids.entity}`,
  '00000000-0000-0000-0000-000000000000', 'ffffffff-ffff-ffff-ffff-ffffffffffff',
  '44000000-0000-1000-8000-000000000001', '44000000-0000-6000-8000-000000000001',
  '44000000-0000-4000-7000-000000000001', '44000000-0000-4000-c000-000000000001',
  '44000000-0000-4000-8000-000000000001\n',
]) test(`reject invalid UUID ${JSON.stringify(value)}`, () => rejects(() => validateUuid(value)));

test('UUID ordering is unsigned RFC/network byte ordering, never Guid endian order', () => {
  const ascending = ['00000001-0000-4000-8000-000000000001', '01000000-0000-4000-8000-000000000001', '7fffffff-0000-4000-8000-000000000001', '80000000-0000-4000-8000-000000000001', 'ffffffff-0000-7000-bfff-ffffffffffff'];
  assert.deepEqual([...ascending].reverse().sort(compareUuid), ascending);
  assert.deepEqual([...uuidBytes(ascending[0])].slice(0, 4), [0, 0, 0, 1]);
  assert.equal(validateUuid(ascending.at(-1)), ascending.at(-1));
});

for (const value of ['0001-01-01T00:00:00.000Z', '9999-12-31T23:59:59.999Z', '2000-02-29T12:34:56.789Z', '2024-02-29T00:00:00.000Z']) {
  test(`valid timestamp ${value}`, () => assert.equal(validateTimestamp(value), value));
}
for (const value of [
  '0000-01-01T00:00:00.000Z', '1900-02-29T00:00:00.000Z', '2100-02-29T00:00:00.000Z', '2026-02-29T00:00:00.000Z',
  '2026-04-31T00:00:00.000Z', '2026-00-01T00:00:00.000Z', '2026-13-01T00:00:00.000Z', '2026-01-00T00:00:00.000Z',
  '2026-01-01T24:00:00.000Z', '2026-01-01T00:60:00.000Z', '2026-01-01T00:00:60.000Z',
  '2026-01-01t00:00:00.000z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00.00Z', '2026-01-01T00:00:00.0000Z',
  '2026-01-01T00:00:00.000+00:00', '2026-01-01T00:00:00.000Z\n', '+2026-01-01T00:00:00.000Z',
]) test(`invalid timestamp ${JSON.stringify(value)}`, () => rejects(() => validateTimestamp(value)));

for (const token of ['-0', '-1', '+1', '01', '1.0', '1e0', '1E+0', '0.1', 'NaN', 'Infinity', '9007199254740992', '999999999999999999999999999999']) {
  test(`reject integer lexeme ${token}`, () => {
    const raw = JSON.stringify(upsert()).replace('"lamportCounter":1', `"lamportCounter":${token}`);
    rejects(() => parseOperation(encodeUtf8(raw)));
  });
}

test('integer boundaries survive wire parsing exactly', () => {
  for (const counter of [1, MAX_COUNTER]) assert.equal(parseOperation(wire(upsert(1, counter))).lamportCounter, counter);
  for (const duration of [1, MAX_DURATION_MS]) assert.equal(parseSession(wire(session({ focusDurationMs: duration }))).focusDurationMs, duration);
  rejects(() => parseOperation(wire(upsert(1, 0))));
});

test('duplicate decoded JSON names are invalid at every nesting level', () => {
  for (const raw of [
    '{"a":1,"a":1}', '{"a":1,"\\u0061":1}', '{"a":{"x":0,"x":0}}',
    '{"\\ud83d\\ude00":1,"😀":1}', '{"__proto__":0,"__proto__":0}',
  ]) rejects(() => parseWireJson(encodeUtf8(raw)));
});

test('only RFC JSON syntax and whitespace accepted', () => {
  for (const raw of ['', ' ', 'true false', '{a:1}', '{"a":1,}', '[1,]', '/*x*/{}', '\ufeff{}', '\u00a0{}', '"a\nb"', '"\\x00"', '"unterminated', '{"a":undefined}', '{"a":1}\u0000']) {
    rejects(() => parseWireJson(encodeUtf8(raw)));
  }
  assert.equal(parseWireJson(encodeUtf8(' \t\r\n"escaped\\/\\b\\f\\n\\r\\t\\\\\\\"" \n')), 'escaped/\b\f\n\r\t\\"');
});

for (const bytes of [
  [0xef, 0xbb, 0xbf, 123, 125], [0xc0, 0x80], [0xc1, 0xbf], [0xe0, 0x80, 0xaf],
  [0xed, 0xa0, 0x80], [0xf0, 0x80, 0x80, 0xaf], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80],
  [0x80], [0xff], [0xc2], [0xe2, 0x82], [0xf0, 0x90, 0x80], [0xe2, 0x28, 0xa1],
]) test(`reject invalid UTF-8 ${bytes.map(b => b.toString(16)).join(' ')}`, () => rejects(() => decodeUtf8(Uint8Array.from(bytes))));

test('Unicode scalar boundary counts, valid escapes and preservation without normalization', () => {
  assert.equal(scalarCount('😀'.repeat(120)), 120);
  assert.equal(parseSession(wire(session({ description: '😀'.repeat(120) }))).description.length, 240);
  rejects(() => parseSession(wire(session({ description: '😀'.repeat(121) }))));
  for (const raw of ['"\\ud800"', '"\\udfff"', '"\\ud800\\u0041"', '"\\ud800x"', '"\\udfff\\ud800"']) rejects(() => parseWireJson(encodeUtf8(raw)));
  for (const text of ['\ud800', '\udfff']) {
    rejects(() => encodeUtf8(text));
    rejects(() => validateSession(session({ description: text })));
  }
  assert.equal(parseWireJson(encodeUtf8('"\\udbff\\udfff"')), String.fromCodePoint(0x10ffff));
  const composed = parseSession(wire(session({ description: '\u00e9' })));
  const decomposed = parseSession(wire(session({ description: 'e\u0301' })));
  assert.notEqual(composed.description, decomposed.description);
  assert.equal(scalarCount(decomposed.description), 2);
  assert.equal(parseSession(wire(session({ description: ' \t\u0000\ufeff ' }))).description, ' \t\u0000\ufeff ');
});

test('UTF-8 codec roundtrips arbitrary scalar values with a deterministic seed', () => {
  const next = random();
  for (let iteration = 0; iteration < 200; iteration++) {
    let value = 'A'; // BOM is disallowed only at the beginning of a wire document.
    for (let j = 0; j < 120; j++) {
      let scalar = Math.floor(next() * 0x110000);
      if (scalar >= 0xd800 && scalar <= 0xdfff) scalar = 0x20;
      value += String.fromCodePoint(scalar);
    }
    assert.equal(decodeUtf8(encodeUtf8(value)), value);
  }
});

test('authoring trim uses only the fixed set, validates before trimming; parsing preserves values', () => {
  const whitespace = '\u0009\u000a\u000b\u000c\u000d \u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000';
  assert.equal(authorDescription(`${whitespace}title${whitespace}`), 'title');
  assert.equal(authorDescription(whitespace), 'Untitled session.');
  assert.equal(authorDescription('\ufeff\u200b'), '\ufeff\u200b');
  assert.equal(authorDescription('x \ty'), 'x \ty');
  rejects(() => authorDescription(' '.repeat(121)));
  assert.equal(parseSession(wire(session({ description: whitespace }))).description, whitespace);
});

test('segment envelope matches all identities; opIds are unique within each segment', () => {
  rejects(() => parseSegment(wire(segment([upsert(), upsert()]))));
  rejects(() => parseSegment(wire(segment([upsert(), upsert(1, 2)]))));
  rejects(() => parseSegment(wire(segment([upsert(1, 1, { deviceId: ids.otherWriter })]))));
  rejects(() => parseSegment(wire(segment([upsert(1, 1, { datasetId: uuid(5) })]))));
  rejects(() => parseSegment(wire(segment([]))));
});

test('resource limits include whitespace bytes, exact count and container depth', () => {
  const raw = JSON.stringify(segment());
  const exact = encodeUtf8(raw + ' '.repeat(MAX_SEGMENT_BYTES - encodeUtf8(raw).length));
  assert.equal(exact.length, MAX_SEGMENT_BYTES);
  assert.equal(parseSegment(exact).operations.length, 1);
  rejects(() => parseSegment(encodeUtf8(raw + ' '.repeat(MAX_SEGMENT_BYTES + 1 - encodeUtf8(raw).length))));
  const descriptor = JSON.stringify({ application: 'focus-timer', protocolVersion: 1, datasetId: ids.dataset });
  assert.equal(parseDescriptor(encodeUtf8(descriptor + ' '.repeat(MAX_SEGMENT_BYTES - descriptor.length))).datasetId, ids.dataset);
  rejects(() => parseDescriptor(encodeUtf8(descriptor + ' '.repeat(MAX_SEGMENT_BYTES + 1 - descriptor.length))));
  const operations = Array.from({ length: 1000 }, (_, i) => upsert(i + 1));
  assert.equal(parseSegment(wire(segment(operations))).operations.length, 1000);
  rejects(() => parseSegment(wire(segment([...operations, upsert(1001)]))));
  assert.equal(parseWireJson(encodeUtf8('['.repeat(16) + '0' + ']'.repeat(16)))[0][0][0][0][0][0][0][0][0][0][0][0][0][0][0][0], 0);
  rejects(() => parseWireJson(encodeUtf8('['.repeat(17) + '0' + ']'.repeat(17))));
  rejects(() => parseWireJson(encodeUtf8('['.repeat(10000))));
});

test('semantic operation equality ignores only object order and equivalent escapes', () => {
  const a = upsert();
  const b = Object.fromEntries(Object.entries(a).reverse());
  b.payload = Object.fromEntries(Object.entries(a.payload).reverse());
  assert.ok(operationEqual(a, parseOperation(wire(b))));
  const raw = JSON.stringify(a).replace('Database study', '\\u0044atabase study');
  assert.ok(operationEqual(a, parseOperation(encodeUtf8(raw))));
  for (const change of [{ deviceId: ids.otherWriter }, { lamportCounter: 2 }, { payload: session({ description: 'different' }) }]) assert.equal(operationEqual(a, upsert(1, 1, change)), false);
  assert.equal(operationEqual(a, deletion(1, 1)), false);
  rejects(() => reduceOperations([a, upsert(1, 2)]), 'integrity');
  rejects(() => reduceOperations([a, upsert(1, 1, { deviceId: ids.otherWriter })]), 'integrity');
});

test('UPSERT selects one complete snapshot by counter then opId; writer has no tie-break', () => {
  const a = upsert(1, 5, { deviceId: ids.otherWriter, payload: session({ description: 'A', focusDurationMs: 1 }) });
  const b = upsert(2, 5, { payload: session({ description: 'B', focusDurationMs: 2 }) });
  assert.ok(compareVersions(a, b) < 0);
  assert.deepEqual(reduceOperations([a, b]).entities, [b.payload]);
  const c = upsert(3, 4, { payload: session({ description: 'C' }) });
  assert.deepEqual(reduceOperations([b, c, a]).entities, [b.payload]);
  const biggerCounter = upsert(1, 10);
  assert.ok(compareVersions(b, biggerCounter) < 0);
});

test('terminal DELETE wins before/after any UPSERT, including larger counters and stale deletes', () => {
  const before = deletion(2, 1);
  const edit = upsert(3, MAX_COUNTER);
  for (const operations of [[before, edit], [edit, before], [upsert(), edit, before, edit, before]]) {
    assert.deepEqual(reduceOperations(operations), { entities: [], tombstones: [ids.entity], highWater: MAX_COUNTER });
  }
});

test('high-water incorporates losers/deleted entities, persists through rebuild and exhausts exactly', () => {
  const operations = [upsert(1, 99), deletion(2, 1), upsert(3, 999)];
  assert.equal(reduceOperations(operations).highWater, 999);
  assert.equal(reduceOperations(operations, 1000).highWater, 1000);
  assert.equal(reduceOperations([], 1000).highWater, 1000);
  assert.equal(incorporateHighWater(500, 1), 500);
  assert.equal(nextCounter(0), 1);
  assert.equal(nextCounter(MAX_COUNTER - 1), MAX_COUNTER);
  assert.throws(() => nextCounter(MAX_COUNTER), CounterExhaustedError);
});

function* permutations(items) {
  if (!items.length) { yield []; return; }
  for (let i = 0; i < items.length; i++) for (const rest of permutations([...items.slice(0, i), ...items.slice(i + 1)])) yield [items[i], ...rest];
}

test('exhaustive six-operation permutations, duplicates and associative set union converge', () => {
  const other = uuid(200, '44000000');
  const operations = [upsert(), upsert(2, 7), deletion(3, 2), upsert(4, 99), upsert(5, 7, { entityId: other, payload: session({ id: other }) }), upsert(6, 7, { entityId: other, payload: session({ id: other, description: 'winner' }) })];
  const expected = reduceOperations(operations);
  let count = 0;
  for (const permutation of permutations(operations)) {
    assert.deepEqual(reduceOperations(permutation), expected);
    assert.deepEqual(reduceOperations([...permutation, ...permutation]), expected);
    count++;
  }
  assert.equal(count, 720);
  assert.deepEqual(reduceOperations([...operations.slice(3), ...operations.slice(0, 3)]), expected);
});

test('seeded arbitrary orders of thousands of retained operations and long-offline tombstones', () => {
  const next = random(0xdeadbeef);
  const operations = [];
  for (let i = 1; i <= 2500; i++) {
    const id = uuid(i, '44000000');
    const payload = session({ id, endedAt: '2025-10-17T00:00:00.000Z', description: `session ${i}` });
    operations.push(upsert(i * 3, i, { entityId: id, payload }));
    if (i % 4 === 0) operations.push(deletion(i * 3 + 1, 1, { entityId: id }));
    operations.push(upsert(i * 3 + 2, 5000 + i, { entityId: id, payload: { ...payload, endedAt: '2026-10-17T00:00:00.000Z' } }));
  }
  const expected = reduceOperations(operations);
  assert.equal(expected.entities.length, 1875);
  assert.equal(expected.tombstones.length, 625);
  assert.equal(expected.highWater, 7500);
  for (let pass = 0; pass < 12; pass++) assert.deepEqual(reduceOperations(shuffle([...operations, ...operations.slice(0, 300)], next)), expected);
});

test('protocol modules have no runtime imports outside the portable core', async () => {
  const root = new URL('../src/protocol/', import.meta.url);
  for (const file of await readdir(root)) {
    const source = await readFile(new URL(file, root), 'utf8');
    for (const match of source.matchAll(/(?:from|import)\s*['"]([^'"]+)['"]/g)) assert.match(match[1], /^\.\//);
    assert.doesNotMatch(source, /\b(?:window|document|indexedDB|fetch|localStorage|process|Buffer)\s*[.(]/);
  }
});
