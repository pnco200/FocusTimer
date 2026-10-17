import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  encodeUtf8, parseWireJson, parseSession, parseDescriptor, parseOperation, parseSegment,
  ProtocolError, reduceOperations, operationEqual, compareUuid,
} from '../src/protocol/index.js';
import { MemoryStore, TransactionalRepository } from '../src/simulation/index.js';
import { ids, random, shuffle, uuid } from '../test-support/fixtures.js';

const vectors = JSON.parse(await readFile(new URL('../protocol/v1/test-vectors/manifest.json', import.meta.url), 'utf8'));
assert.equal(vectors.format, 'focus-timer-protocol-v1-conformance-vectors');
assert.equal(vectors.version, 1);
const parsers = { session: parseSession, descriptor: parseDescriptor, operation: parseOperation, segment: parseSegment };
const bytesOf = fixture => {
  assert.notEqual(Object.hasOwn(fixture, 'raw'), Object.hasOwn(fixture, 'hex'));
  if (Object.hasOwn(fixture, 'raw')) return encodeUtf8(fixture.raw);
  assert.match(fixture.hex, /^(?:[0-9a-f]{2})*$/);
  return Uint8Array.from(fixture.hex.match(/../g) ?? [], pair => Number.parseInt(pair, 16));
};
const rejectsClass = (action, classification) => assert.throws(action, error => error.classification === classification);

for (const group of ['wire', 'reducers', 'identity', 'ordering', 'resources', 'deliveries', 'lamport']) {
  assert.ok(Array.isArray(vectors[group]) && vectors[group].length > 0, `Missing vector group ${group}`);
  assert.equal(new Set(vectors[group].map(item => item.name)).size, vectors[group].length, `Duplicate vector name in ${group}`);
}

for (const fixture of vectors.wire) test(`wire vector: ${fixture.name}`, () => {
  const parser = parsers[fixture.kind];
  assert.ok(parser, `Unknown wire kind ${fixture.kind}`);
  const bytes = bytesOf(fixture);
  if (fixture.expected === 'valid') assert.deepEqual(parser(bytes), fixture.value);
  else assert.throws(() => parser(bytes), error => error instanceof ProtocolError && error.classification === fixture.expected);
});

for (const fixture of vectors.reducers) test(`reducer vector: ${fixture.name}`, () => {
  const operations = fixture.operations;
  assert.deepEqual(reduceOperations(operations), fixture.expected);
  const next = random(12345);
  for (let i = 0; i < 8; i++) {
    assert.deepEqual(reduceOperations(shuffle([...operations, ...operations.slice(0, 20)], next)), fixture.expected);
  }
});

function repositoryFor(segment) {
  const repository = new TransactionalRepository({
    descriptor: { application: 'focus-timer', protocolVersion: 1, datasetId: segment.datasetId },
    writerId: segment.deviceId, ids: () => uuid(999999),
  });
  const pin = repository.bind({ account: 'fixture-account', locator: 'fixture-location', descriptor: repository.snapshot().descriptor });
  return { repository, pin };
}

for (const fixture of vectors.identity) test(`immutable identity vector: ${fixture.name}`, () => {
  const firstBytes = bytesOf(fixture.first);
  const secondBytes = bytesOf(fixture.second);
  if (fixture.kind === 'operation') {
    const a = parseOperation(firstBytes);
    const b = parseOperation(secondBytes);
    assert.equal(operationEqual(a, b), fixture.expected === 'equal');
    if (fixture.expected === 'equal') assert.deepEqual(reduceOperations([a, b]), reduceOperations([a]));
    else {
      rejectsClass(() => reduceOperations([a, b]), 'integrity');
      rejectsClass(() => reduceOperations([b, a]), 'integrity');
    }
  } else {
    assert.equal(fixture.kind, 'segment');
    const { repository, pin } = repositoryFor(parseSegment(firstBytes));
    repository.receive(pin, 'first-reference', firstBytes);
    const prior = repository.snapshot();
    if (fixture.expected === 'equal') repository.receive(pin, 'second-reference', secondBytes);
    else {
      rejectsClass(() => repository.receive(pin, 'second-reference', secondBytes), 'integrity');
      assert.deepEqual(repository.snapshot(), prior);
    }
  }
});

for (const fixture of vectors.ordering) test(`UUID ordering vector: ${fixture.name}`, () => {
  assert.deepEqual([...fixture.values].sort(compareUuid), fixture.expected);
});

for (const fixture of vectors.resources) test(`resource vector: ${fixture.name}`, () => {
  if (fixture.expected === 'within-limit') parseWireJson(encodeUtf8(fixture.raw), { maxDepth: fixture.maximumContainerDepth });
  else rejectsClass(() => parseWireJson(encodeUtf8(fixture.raw), { maxDepth: fixture.maximumContainerDepth }), 'malformed');
});

for (const fixture of vectors.deliveries) test(`physical delivery vector: ${fixture.name}`, () => {
  const artifacts = new Map(fixture.artifacts.map(artifact => [artifact.reference, bytesOf(artifact)]));
  const { repository, pin } = repositoryFor(parseSegment(artifacts.values().next().value));
  for (let pass = 0; pass < fixture.passes.length; pass++) {
    for (const reference of fixture.passes[pass]) {
      assert.ok(artifacts.has(reference));
      repository.receive(pin, reference, artifacts.get(reference));
    }
    const expected = fixture.expectedAfterPass?.[pass] ?? fixture.expected;
    assert.deepEqual({ ...repository.materialized(), highWater: repository.snapshot().highWater }, expected);
  }
});

for (const fixture of vectors.lamport) test(`Lamport sequence vector: ${fixture.name}`, () => {
  const store = new MemoryStore();
  let nextId = 1000000;
  const allocateId = () => uuid(nextId++);
  const descriptor = { application: 'focus-timer', protocolVersion: 1, datasetId: ids.dataset };
  let repository = new TransactionalRepository({ store, descriptor, writerId: ids.otherWriter, ids: allocateId });
  // Fixture metadata represents an already persisted dataset clock, even when
  // retained history is shorter. This setup is not an authored mutation.
  store.transaction('fixtureClock', state => { state.highWater = fixture.initialHighWater; });
  const pin = repository.bind({ account: 'fixture-account', locator: 'fixture-location', descriptor });
  const { owner } = repository.acquireOwner('fixture-owner');
  let retainedDelivery;

  for (const step of fixture.steps) {
    if (step.action === 'accept') {
      const segmentId = allocateId();
      retainedDelivery = {
        reference: `fixture-segment-${segmentId}`,
        bytes: encodeUtf8(JSON.stringify({ protocolVersion: 1, datasetId: step.operation.datasetId,
          deviceId: step.operation.deviceId, segmentId, operations: [step.operation] })),
      };
      repository.receive(pin, retainedDelivery.reference, retainedDelivery.bytes);
      assert.deepEqual(repository.snapshot().operations[step.operation.opId], step.operation);
    } else if (step.action === 'local') {
      const active = repository.startActive({
        ownerToken: owner.token, ownerGeneration: owner.generation, expectedBindingGeneration: pin.generation,
        activeId: allocateId(), startedAt: '2026-10-17T15:20:00.000Z', focusDurationMs: 1,
        description: 'Fixture local mutation',
      });
      const command = {
        commandId: `fixture-finish-${active.id}`, activeId: active.id, expectedRevision: active.revision,
        ownerToken: owner.token, ownerGeneration: owner.generation, expectedBindingGeneration: pin.generation,
        entityId: allocateId(), opId: allocateId(), endedAt: '2026-10-17T15:20:01.000Z',
      };
      const before = repository.snapshot();
      if (step.expectedError) {
        assert.throws(() => repository.finish(command), error => error.code === step.expectedError);
        assert.deepEqual(repository.snapshot(), before, 'exhausted Finish must leave durable state intact');
      } else {
        const receipt = repository.finish(command);
        const state = repository.snapshot();
        assert.equal(receipt.opId, command.opId);
        assert.equal(state.operations[receipt.opId].lamportCounter, step.expectedCounter);
        assert.equal(state.operations[receipt.opId].deviceId, before.writerId);
        assert.deepEqual(state.outbox[receipt.opId], { reservation: null });
        assert.equal(state.entities[receipt.entityId].id, receipt.entityId);
        assert.equal(state.active, null);
      }
    } else if (step.action === 'restart') {
      const before = repository.snapshot();
      const previous = repository;
      repository = new TransactionalRepository({ store, ids: allocateId });
      assert.notEqual(repository, previous);
      assert.equal(repository.store, store);
      assert.deepEqual(repository.snapshot(), before, 'reopening must retain the complete durable dataset');
    } else if (step.action === 'rotate-writer') {
      const before = repository.snapshot();
      const writerId = allocateId();
      assert.notEqual(writerId, before.writerId);
      repository.rotateWriter(writerId);
      assert.deepEqual(repository.snapshot(), { ...before, writerId }, 'rotation changes only future writer identity');
    } else {
      assert.equal(step.action, 'rebuild-projection');
      assert.ok(retainedDelivery, 'the rebuild fixture must supply retained remote corpus');
      const before = repository.snapshot();
      // No public rebuild command exists. Discard only the disposable projection
      // caches, then exercise the actual receive projection path by redelivery.
      store.transaction('fixtureDropProjection', state => { state.entities = {}; state.tombstones = []; });
      repository.receive(pin, retainedDelivery.reference, retainedDelivery.bytes);
      const after = repository.snapshot();
      assert.deepEqual(after.entities, before.entities);
      assert.deepEqual(after.tombstones, before.tombstones);
      assert.deepEqual(after.operations, before.operations);
      assert.deepEqual(after.outbox, before.outbox);
    }
    assert.equal(repository.snapshot().highWater, step.expectedHighWater);
  }
});
