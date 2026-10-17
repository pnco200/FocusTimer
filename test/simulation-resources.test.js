import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_COUNTER, MAX_SEGMENT_BYTES, encodeUtf8, parseSegment, validateOperation } from '../src/protocol/index.js';
import { AdversarialTransport, MemoryStore, SyncRunner, TransactionalRepository } from '../src/simulation/index.js';
import { ids, uuid, upsert, session, segment } from '../test-support/fixtures.js';

function fixture() {
  const descriptor = { application: 'focus-timer', protocolVersion: 1, datasetId: ids.dataset };
  const repository = new TransactionalRepository({ descriptor, writerId: ids.writer });
  const pin = repository.bind({ account: 'bounded-test', locator: 'explicit-target', descriptor });
  const transport = new AdversarialTransport();
  transport.createDataset(pin, descriptor);
  return { descriptor, repository, pin, transport };
}

test('restored authored corpus seals by byte limit as well as operation count without rewriting original writer', () => {
  const descriptor = { application: 'focus-timer', protocolVersion: 1, datasetId: ids.dataset };
  const empty = new TransactionalRepository({ descriptor, writerId: ids.writer });
  const restored = empty.snapshot();
  // This models retained unsegmented authored history loaded by a future restore adapter.
  // It does not use the receive path: restored authored outbox membership must remain publishable.
  for (let n = 1; n <= 1000; n++) {
    const entityId = uuid(n, '44000000');
    const operation = validateOperation(upsert(n, n, {
      entityId, payload: session({ id: entityId, description: '\u0000'.repeat(120) }),
    }));
    restored.operations[operation.opId] = operation;
    restored.entities[entityId] = operation.payload;
    restored.outbox[operation.opId] = { reservation: null };
  }
  restored.highWater = 1000;
  restored.revision = 1000;
  const store = new MemoryStore();
  store.initialize(restored);
  let nextId = 1;
  const repository = new TransactionalRepository({ store, ids: () => uuid(nextId++, '55000000') });
  const pin = repository.bind({ account: 'restore-test', locator: 'explicit-target', descriptor });
  repository.rotateWriter(ids.otherWriter);
  const first = repository.seal(pin, repository.reserve(pin).segmentId);
  const second = repository.seal(pin, repository.reserve(pin).segmentId);
  assert.equal(repository.reserve(pin), null);
  assert.ok(first.operationIds.length < 1000, 'byte limit must split before count limit');
  assert.ok(first.operationIds.length > 1);
  assert.ok(second.operationIds.length > 0);
  for (const publication of [first, second]) {
    assert.ok(publication.bytes.length <= MAX_SEGMENT_BYTES);
    const segment = parseSegment(publication.bytes);
    assert.equal(segment.deviceId, ids.writer);
    assert.ok(segment.operations.every(operation => operation.deviceId === ids.writer));
    for (const operation of segment.operations) assert.deepEqual(operation, restored.operations[operation.opId]);
  }
  const membership = [...first.operationIds, ...second.operationIds];
  assert.equal(membership.length, 1000);
  assert.equal(new Set(membership).size, 1000);
  assert.equal(repository.snapshot().highWater, 1000);
  assert.equal(repository.snapshot().writerId, ids.otherWriter);
});

test('oversized inbound artifact is quarantined without accepting a prefix or retaining unbounded evidence', async () => {
  const { repository, pin, transport } = fixture();
  const bytes = new Uint8Array(MAX_SEGMENT_BYTES + 1).fill(0x20);
  transport.put(pin, bytes, { reference: 'oversized' });
  await new SyncRunner(repository, transport).run();
  const state = repository.snapshot();
  assert.equal(state.blocked.classification, 'malformed');
  assert.equal(state.discoveries[pin.generation].artifacts.oversized.state, 'quarantined');
  assert.equal(Object.keys(state.operations).length, 0);
  assert.equal(Object.keys(state.segments).length, 0);
  assert.equal(state.highWater, 0);
  assert.notEqual(repository.status(), 'Synced');
  repository.artifactFailure(pin, 'bounded-diagnostic', { classification: 'malformed', message: 'Oversized artifact' }, bytes);
  const diagnostic = repository.snapshot().discoveries[pin.generation].artifacts['bounded-diagnostic'];
  assert.equal(diagnostic.rejectedBytes.length, MAX_SEGMENT_BYTES);
  assert.equal(diagnostic.rejectedByteLength, MAX_SEGMENT_BYTES + 1);
});

test('known artifact becoming oversized is an integrity fault and preserves all accepted facts', async () => {
  const { repository, pin, transport } = fixture();
  const reference = transport.put(pin, encodeUtf8(JSON.stringify(segment())));
  await new SyncRunner(repository, transport).run();
  const before = repository.snapshot();
  transport.replace(pin, reference, new Uint8Array(MAX_SEGMENT_BYTES + 1));
  await new SyncRunner(repository, transport).run();
  const after = repository.snapshot();
  assert.equal(after.blocked.classification, 'integrity');
  for (const field of ['operations', 'entities', 'tombstones', 'highWater', 'segments', 'outbox']) assert.deepEqual(after[field], before[field]);
});

test('oversized descriptor blocks publication with no ingestion or healthy status', async () => {
  const { repository, pin, transport } = fixture();
  transport.replaceDescriptor(pin, new Uint8Array(MAX_SEGMENT_BYTES + 1));
  await new SyncRunner(repository, transport).run();
  assert.equal(repository.snapshot().blocked.classification, 'malformed');
  assert.equal(transport.calls.filter(call => call.method === 'publish').length, 0);
  assert.notEqual(repository.status(), 'Synced');
});

test('receive requires byte input for unknown and known references and leaves durable state unchanged', () => {
  const { repository, pin } = fixture();
  repository.receive(pin, 'known', encodeUtf8(JSON.stringify(segment())));
  const before = repository.snapshot();
  for (const reference of ['known', 'unknown']) for (const invalid of [null, undefined, [], '{}', {}]) {
    assert.throws(() => repository.receive(pin, reference, invalid), error => error.classification === 'malformed');
    assert.deepEqual(repository.snapshot(), before);
  }
});

test('empty and receive-only replicas reconcile without allocating an unnecessary new identity', async () => {
  for (const hasRemoteHistory of [false, true]) {
    const { repository, pin, transport } = fixture(); // Deliberately no authoring ID factory.
    if (hasRemoteHistory) transport.put(pin, encodeUtf8(JSON.stringify(segment())));
    await new SyncRunner(repository, transport).run();
    assert.equal(repository.status(), 'Synced');
    assert.equal(repository.materialized().entities.length, hasRemoteHistory ? 1 : 0);
    assert.equal(repository.reserve(pin), null);
  }
});

function finishWithoutFactory(repository) {
  const owner = repository.acquireOwner('explicit-command-owner').owner;
  const active = repository.startActive({ activeId: uuid(500), startedAt: '2026-10-17T00:00:00.000Z',
    focusDurationMs: 1, description: 'Retained', expectedBindingGeneration: 1,
    ownerToken: owner.token, ownerGeneration: owner.generation });
  const command = { commandId: 'explicit-finish', activeId: active.id, expectedRevision: active.revision,
    expectedBindingGeneration: 1, ownerToken: owner.token, ownerGeneration: owner.generation,
    entityId: uuid(501), opId: uuid(502), endedAt: '2026-10-17T00:00:00.000Z' };
  return { command, receipt: repository.finish(command) };
}

test('no-op commands and committed Finish retries need no new identity or Lamport allocation', () => {
  const { repository } = fixture();
  const { command, receipt } = finishWithoutFactory(repository);
  const reopened = new TransactionalRepository({ store: repository.store });
  const { entityId, opId, ...retry } = command;
  assert.deepEqual(reopened.finish(retry), receipt);
  const before = reopened.snapshot();
  const unchanged = reopened.edit({ entityId, baseOpId: opId, expectedBindingGeneration: 1, payload: before.entities[entityId] });
  assert.equal(unchanged.changed, false);
  assert.equal(reopened.delete({ entityId: uuid(999), expectedBindingGeneration: 1 }).changed, false);
  assert.deepEqual(reopened.snapshot(), before);
});

test('invalid generated segment identity cannot durably reserve authored outbox membership', () => {
  const { repository, pin } = fixture();
  finishWithoutFactory(repository);
  const invalidWriter = new TransactionalRepository({ store: repository.store, ids: () => 'invalid-segment-id' });
  const before = repository.snapshot();
  assert.throws(() => invalidWriter.reserve(pin), error => error.classification === 'malformed');
  assert.deepEqual(repository.snapshot(), before);
});

test('disconnect does not hide exhausted local dataset recovery requirements or rewind high-water', () => {
  const { repository, pin } = fixture();
  repository.receive(pin, 'maximum-counter', encodeUtf8(JSON.stringify(segment([upsert(1, MAX_COUNTER)]))));
  repository.disconnect();
  const reopened = new TransactionalRepository({ store: repository.store });
  assert.equal(reopened.snapshot().highWater, MAX_COUNTER);
  assert.equal(reopened.captureBinding(), null);
  assert.equal(reopened.status(), 'Recovery required');
});
