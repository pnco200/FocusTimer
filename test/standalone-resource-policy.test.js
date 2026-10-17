import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_MAX_PARSE_BYTES, MAX_SEGMENT_BYTES, ProtocolError, ResourceLimitError,
  parseDescriptor, parseOperation, parseSegment, parseSession, parseWireJson,
} from '../src/protocol/index.js';

// Independently constructed wire fixtures; Buffer is only a test encoding oracle.
const session = {
  id: '00000000-0000-4000-8000-000000000001',
  startedAt: '2026-10-17T00:00:00.000Z',
  endedAt: '2026-10-17T00:00:00.001Z',
  focusDurationMs: 1,
  description: '  \u00e9 e\u0301 \ud83d\udcda  ',
};
const operation = {
  protocolVersion: 1, schemaVersion: 1,
  opId: '00000000-0000-4000-8000-000000000002',
  datasetId: '00000000-0000-4000-8000-000000000003',
  deviceId: '00000000-0000-4000-8000-000000000004',
  entityType: 'focusSession', entityId: session.id,
  operation: 'UPSERT', lamportCounter: 1, payload: session,
};
const wire = value => Uint8Array.from(Buffer.from(JSON.stringify(value), 'utf8'));
function padded(bytes, length) {
  const result = new Uint8Array(length).fill(0x20);
  result.set(bytes, length - bytes.length);
  return result;
}
const resourceRefusal = (action, limit, actual) => assert.throws(action, error => {
  assert.ok(error instanceof ResourceLimitError);
  assert.equal(error instanceof ProtocolError, false);
  assert.equal(error.code, 'resource-limit');
  assert.equal(error.resource, 'input-bytes');
  assert.equal(error.limit, limit);
  assert.equal(error.actual, actual);
  assert.equal(error.classification, undefined);
  return true;
});
const protocolRefusal = (action, classification) => assert.throws(action, error =>
  error instanceof ProtocolError && error.classification === classification);

for (const [name, parser, value] of [
  ['session', parseSession, session], ['operation', parseOperation, operation],
]) {
  test(`standalone ${name} accepts exact budget and preserves every scalar`, () => {
    assert.deepEqual(parser(wire(value)), value);
    assert.deepEqual(parser(padded(wire(value), DEFAULT_MAX_PARSE_BYTES)), value);
    const bytes = wire(value);
    assert.deepEqual(parser(bytes, { maxBytes: bytes.length }), value);
    resourceRefusal(() => parser(bytes, { maxBytes: bytes.length - 1 }), bytes.length - 1, bytes.length);
  });

  test(`standalone ${name} byte budget is caller policy, not a protocol validity rule`, () => {
    const bytes = padded(wire(value), DEFAULT_MAX_PARSE_BYTES + 1);
    resourceRefusal(() => parser(bytes), DEFAULT_MAX_PARSE_BYTES, bytes.length);
    assert.deepEqual(parser(bytes, { maxBytes: bytes.length }), value);
    assert.deepEqual(parser(bytes, { maxBytes: Infinity }), value);
  });

  test(`standalone ${name} refuses bytes before malformed UTF-8 decoding`, () => {
    const bytes = new Uint8Array(DEFAULT_MAX_PARSE_BYTES + 1).fill(0xff);
    resourceRefusal(() => parser(bytes), DEFAULT_MAX_PARSE_BYTES, bytes.length);
    protocolRefusal(() => parser(bytes, { maxBytes: Infinity }), 'malformed');
  });
}

test('generic JSON parsing also has a bounded default and explicit opt-out', () => {
  const bytes = padded(Uint8Array.of(0x31), DEFAULT_MAX_PARSE_BYTES + 1);
  resourceRefusal(() => parseWireJson(bytes), DEFAULT_MAX_PARSE_BYTES, bytes.length);
  assert.equal(parseWireJson(bytes, { maxBytes: bytes.length }), 1);
  assert.equal(parseWireJson(bytes, { maxBytes: Infinity }), 1);
});

test('caller byte budget validates independently of wire shape and counts UTF-8 bytes', () => {
  const bytes = wire(session);
  assert.ok(bytes.length > JSON.stringify(session).length);
  for (const maxBytes of [-1, 1.5, NaN, -Infinity, '1000', null]) {
    for (const parser of [parseWireJson, parseSession, parseOperation]) {
      assert.throws(() => parser(bytes, { maxBytes }), TypeError);
    }
  }
  resourceRefusal(() => parseSession(bytes, { maxBytes: 0 }), 0, bytes.length);
  protocolRefusal(() => parseSession('not bytes'), 'malformed');
});

test('within-budget protocol malformation and unsupported fields keep their classifications', () => {
  protocolRefusal(() => parseSession(wire({ ...session, description: '\ud800' })), 'malformed');
  protocolRefusal(() => parseSession(wire({ ...session, futureField: true })), 'unsupported');
  protocolRefusal(() => parseOperation(wire({ ...operation, lamportCounter: 0 })), 'malformed');
  protocolRefusal(() => parseOperation(wire({ ...operation, schemaVersion: 2 })), 'unsupported');
});

test('descriptor and segment caps remain mandatory wire rules with no caller override', () => {
  const descriptor = {
    application: 'focus-timer', protocolVersion: 1, datasetId: operation.datasetId,
  };
  const segment = {
    protocolVersion: 1, datasetId: operation.datasetId, deviceId: operation.deviceId,
    segmentId: '00000000-0000-4000-8000-000000000005', operations: [operation],
  };
  for (const [parser, value] of [[parseDescriptor, descriptor], [parseSegment, segment]]) {
    assert.deepEqual(parser(padded(wire(value), MAX_SEGMENT_BYTES)), value);
    const oversized = padded(wire(value), MAX_SEGMENT_BYTES + 1);
    protocolRefusal(() => parser(oversized), 'malformed');
    protocolRefusal(() => parser(oversized, { maxBytes: Infinity }), 'malformed');
  }
});
