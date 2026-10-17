import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_COUNTER, MAX_DURATION_MS, MAX_SEGMENT_BYTES,
  authorDescription, compareUuid, decodeUtf8, encodeUtf8,
  nextCounter, operationEqual, parseDescriptor, parseOperation,
  parseSegment, parseSession, parseWireJson, reduceOperations,
  scalarCount, uuidBytes, validateTimestamp, validateUuid,
} from '../src/protocol/index.js';

// Independent fixtures/oracle deliberately do not import test helpers or production ordering.
const uuid = n => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const datasetId = uuid(1);
const deviceId = uuid(2);
const session = (entity = 10, description = '') => ({
  id: uuid(entity), startedAt: '9999-12-31T23:59:59.999Z',
  endedAt: '0001-01-01T00:00:00.000Z', focusDurationMs: 1, description,
});
const operation = (op, counter, entity = 10, description = '', kind = 'UPSERT') => ({
  protocolVersion: 1, schemaVersion: 1, opId: uuid(op), datasetId, deviceId,
  entityType: 'focusSession', entityId: uuid(entity), operation: kind,
  lamportCounter: counter, ...(kind === 'UPSERT' ? { payload: session(entity, description) } : {}),
});
const bytes = value => encodeUtf8(JSON.stringify(value));
const malformed = action => assert.throws(action, error => error.classification === 'malformed');
const unsupported = action => assert.throws(action, error => error.classification === 'unsupported');

function* permutations(values) {
  if (values.length === 0) { yield []; return; }
  for (let i = 0; i < values.length; i++) {
    for (const tail of permutations(values.filter((_, j) => j !== i))) yield [values[i], ...tail];
  }
}

function oracle(values, initial = 0) {
  const ids = [...new Set(values.map(value => value.entityId))].sort();
  const entities = [];
  const tombstones = [];
  for (const id of ids) {
    const candidates = values.filter(value => value.entityId === id);
    if (candidates.some(value => value.operation === 'DELETE')) { tombstones.push(id); continue; }
    candidates.sort((a, b) => {
      const difference = BigInt(a.lamportCounter) - BigInt(b.lamportCounter);
      return difference < 0n ? -1 : difference > 0n ? 1 : a.opId < b.opId ? -1 : a.opId > b.opId ? 1 : 0;
    });
    entities.push(candidates.at(-1).payload);
  }
  return { entities, tombstones, highWater: Math.max(initial, ...values.map(value => value.lamportCounter)) };
}

test('independent oracle: all 720 permutations converge with duplicate passes, terminal delete, and ties', () => {
  const values = [
    operation(20, MAX_COUNTER, 10, 'high edit on deleted entity'),
    operation(21, 1, 10, '', 'DELETE'),
    operation(22, 9, 11, 'numeric winner'),
    operation(23, 8, 11, 'later UUID loses'),
    operation(24, 5, 12, 'tie loses'),
    operation(25, 5, 12, 'tie wins'),
  ];
  const expected = oracle(values);
  let count = 0;
  for (const order of permutations(values)) {
    assert.deepEqual(reduceOperations(order), expected);
    assert.deepEqual(reduceOperations([...order, ...order.slice().reverse(), ...order]), expected);
    count++;
  }
  assert.equal(count, 720);
});

test('high-water survives projection rebuilding and exhaustion is explicit', () => {
  assert.deepEqual(reduceOperations([], MAX_COUNTER), { entities: [], tombstones: [], highWater: MAX_COUNTER });
  assert.equal(reduceOperations([operation(20, 1)], 100).highWater, 100);
  assert.equal(nextCounter(MAX_COUNTER - 1), MAX_COUNTER);
  assert.throws(() => nextCounter(MAX_COUNTER), error => error.code === 'counter-exhausted');
});

test('UUID order agrees with unsigned network bytes across mixed-endian and signed-byte traps', () => {
  const values = [
    '00000001-0000-4000-8000-000000000000',
    '00000100-0000-4000-8000-000000000000',
    '00010000-0000-4000-8000-000000000000',
    '01000000-0000-4000-8000-000000000000',
    '7fffffff-ffff-7fff-bfff-ffffffffffff',
    '80000000-0000-4000-8000-000000000000',
    'ffffffff-ffff-7fff-bfff-ffffffffffff',
  ];
  for (let i = 0; i < values.length; i++) {
    assert.deepEqual([...uuidBytes(values[i])], [...Buffer.from(values[i].replaceAll('-', ''), 'hex')]);
    for (let j = 0; j < values.length; j++) assert.equal(compareUuid(values[i], values[j]), Math.sign(i - j));
  }
  for (const suffix of ['\n', '\r', '\r\n', '\u2028', '\0', ' ']) {
    malformed(() => validateUuid(uuid(1) + suffix));
    malformed(() => validateTimestamp('2024-01-01T00:00:00.000Z' + suffix));
  }
});

test('Gregorian validation exercises every month in leap/non-leap century and boundary years', () => {
  for (const year of [1, 4, 100, 400, 1600, 1700, 1900, 2000, 2024, 2100, 2400, 9999]) {
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    for (let month = 1; month <= 12; month++) {
      const prefix = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-`;
      assert.equal(validateTimestamp(`${prefix}${days[month - 1]}T23:59:59.999Z`).length, 24);
      malformed(() => validateTimestamp(`${prefix}${String(days[month - 1] + 1).padStart(2, '0')}T00:00:00.000Z`));
    }
  }
  assert.deepEqual(parseSession(bytes(session())), session()); // Positive focus with reversed chronology remains valid.
});

test('UTF-8 codec preserves all scalar width boundaries and rejects overlong/surrogate/truncated forms', () => {
  const scalars = [0, 1, 0x1f, 0x20, 0x7e, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xfeff, 0xfffe, 0xffff, 0x10000, 0x10ffff];
  const text = scalars.map(value => String.fromCodePoint(value)).join('');
  assert.deepEqual(encodeUtf8(text), Uint8Array.from(Buffer.from(text, 'utf8')));
  assert.equal(decodeUtf8(encodeUtf8(text)), text);
  assert.equal(scalarCount(text), scalars.length);
  for (const value of [
    [0x80], [0xbf], [0xc0, 0x80], [0xc1, 0xbf], [0xc2], [0xc2, 0x20],
    [0xe0, 0x80, 0x80], [0xed, 0xa0, 0x80], [0xed, 0xbf, 0xbf], [0xe1, 0x80],
    [0xf0, 0x80, 0x80, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xf5, 0x80, 0x80, 0x80],
    [0xf0, 0x90, 0x80], [0xff], [0xef, 0xbb, 0xbf, 0x7b, 0x7d],
  ]) malformed(() => decodeUtf8(Uint8Array.from(value)));
});

test('strict JSON accepts escaped scalar pairs and rejects malformed lexical alternatives', () => {
  assert.equal(parseWireJson(encodeUtf8('"\\ud83d\\udcda"')), '📚');
  for (const text of [
    '01', '-0', '+1', '1.0', '1e0', '1E+0', 'NaN', 'Infinity', '9007199254740992',
    '"\\ud800"', '"\\udfff"', '"\\ud800\\u0041"', '"\\u000G"', '"\\x41"',
    '{"a":1,"\\u0061":2}', '{"__proto__":1,"\\u005f_proto__":2}',
    '[1,]', '{"a":1,}', '{a:1}', '[truefalse]', 'null null', '\u00a0{}', '\u2028{}', '/*comment*/{}',
  ]) malformed(() => parseWireJson(encodeUtf8(text)));
  assert.equal(parseWireJson(encodeUtf8(String(MAX_COUNTER))), MAX_COUNTER);
  assert.equal(parseWireJson(encodeUtf8('"\\uFEFF"')), '\ufeff');
  assert.equal(parseWireJson(encodeUtf8('['.repeat(16) + '0' + ']'.repeat(16))).length, 1);
  malformed(() => parseWireJson(encodeUtf8('['.repeat(17) + '0' + ']'.repeat(17))));
});

test('authoring uses the frozen whitespace set while ingestion preserves scalar and normalization identity', () => {
  const whitespace = [9, 10, 11, 12, 13, 32, 133, 160, 5760, ...Array.from({ length: 11 }, (_, i) => 8192 + i), 8232, 8233, 8239, 8287, 12288];
  for (const scalar of whitespace) {
    const char = String.fromCodePoint(scalar);
    assert.equal(authorDescription(`${char}x${char}`), 'x');
    assert.equal(authorDescription(char), 'Untitled session.');
    assert.equal(parseSession(bytes(session(10, `${char}x${char}`))).description, `${char}x${char}`);
  }
  assert.equal(authorDescription('\ufeffx\ufeff'), '\ufeffx\ufeff');
  assert.equal(authorDescription('\u200bx\u200b'), '\u200bx\u200b');
  assert.equal(authorDescription('📚'.repeat(120)), '📚'.repeat(120));
  malformed(() => authorDescription(' '.repeat(121))); // Validate before trimming.
  malformed(() => parseSession(bytes(session(10, '📚'.repeat(121)))));
  assert.notEqual(parseSession(bytes(session(10, 'é'))).description, parseSession(bytes(session(10, 'e\u0301'))).description);
});

test('complete snapshots reject every omitted/null field and unknown fields remain unsupported', () => {
  const valid = operation(20, 1);
  for (const key of Object.keys(valid)) {
    const omitted = structuredClone(valid); delete omitted[key];
    malformed(() => parseOperation(bytes(omitted)));
    malformed(() => parseOperation(bytes({ ...valid, [key]: null })));
  }
  for (const key of Object.keys(valid.payload)) {
    const omitted = structuredClone(valid); delete omitted.payload[key];
    malformed(() => parseOperation(bytes(omitted)));
    const nulled = structuredClone(valid); nulled.payload[key] = null;
    malformed(() => parseOperation(bytes(nulled)));
  }
  unsupported(() => parseOperation(bytes({ ...valid, future: {} })));
  unsupported(() => parseOperation(bytes({ ...valid, schemaVersion: 2 })));
  unsupported(() => parseOperation(bytes({ ...valid, entityType: 'other' })));
  const deleted = operation(21, 1, 10, '', 'DELETE');
  malformed(() => parseOperation(bytes({ ...deleted, payload: null })));
  malformed(() => parseOperation(bytes({ ...deleted, payload: valid.payload })));
  assert.equal(parseOperation(bytes({ ...valid, payload: { ...valid.payload, focusDurationMs: MAX_DURATION_MS } })).payload.focusDurationMs, MAX_DURATION_MS);
  malformed(() => parseOperation(bytes({ ...valid, payload: { ...valid.payload, focusDurationMs: MAX_DURATION_MS + 1 } })));
});

test('immutable operation equality includes every envelope field but ignores member/escape order', () => {
  const valid = operation(20, 1, 10, 'é');
  const reversed = Object.fromEntries(Object.entries(valid).reverse());
  reversed.payload = Object.fromEntries(Object.entries(valid.payload).reverse());
  assert.equal(operationEqual(valid, parseOperation(encodeUtf8(JSON.stringify(reversed).replace('é', '\\u00e9')))), true);
  for (const changed of [
    { ...valid, deviceId: uuid(99) },
    { ...valid, lamportCounter: 2 },
    { ...valid, payload: { ...valid.payload, description: 'e\u0301' } },
    { ...valid, payload: { ...valid.payload, focusDurationMs: 2 } },
  ]) {
    assert.equal(operationEqual(valid, changed), false);
    assert.throws(() => reduceOperations([valid, changed]), error => error.classification === 'integrity');
    assert.throws(() => reduceOperations([changed, valid]), error => error.classification === 'integrity');
  }
  const reduced = reduceOperations([valid]);
  reduced.entities[0].description = 'external mutation';
  assert.equal(valid.payload.description, 'é');
});

test('resource limits count exact wire whitespace bytes and segment identity is checked before reduction', () => {
  const descriptor = { application: 'focus-timer', protocolVersion: 1, datasetId };
  const base = JSON.stringify(descriptor);
  const exact = base + ' '.repeat(MAX_SEGMENT_BYTES - encodeUtf8(base).length);
  assert.deepEqual(parseDescriptor(encodeUtf8(exact)), descriptor);
  malformed(() => parseDescriptor(encodeUtf8(exact + ' ')));
  const envelope = { protocolVersion: 1, datasetId, deviceId, segmentId: uuid(30), operations: [operation(20, 1)] };
  for (const value of [
    { ...envelope, operations: [operation(20, 1), operation(20, 1)] },
    { ...envelope, datasetId: uuid(99) },
    { ...envelope, deviceId: uuid(99) },
    { ...envelope, operations: [{ ...operation(20, 1), entityId: uuid(99) }] },
  ]) malformed(() => parseSegment(bytes(value)));
});
