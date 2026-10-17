import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeUtf8 } from '../src/protocol/index.js';
import { AdversarialTransport, InjectedFailure, SyncRunner, TransactionalRepository } from '../src/simulation/index.js';

const id = n => `61000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const descriptor = { application: 'focus-timer', protocolVersion: 1, datasetId: id(1) };
const date = '2026-10-17T00:00:00.000Z';
const wire = value => encodeUtf8(JSON.stringify(value));

function fixture() {
  let next = 10000;
  const ids = () => id(next++);
  const repository = new TransactionalRepository({ descriptor, writerId: id(2), ids });
  const pin = repository.bind({ account: 'regression-account', locator: 'regression-root', descriptor });
  const transport = new AdversarialTransport();
  transport.createDataset(pin, descriptor);
  return { repository, pin, transport, ids };
}

function operation(number, description = 'remote text') {
  return { protocolVersion: 1, schemaVersion: 1, opId: id(100 + number), datasetId: descriptor.datasetId,
    deviceId: id(3), entityType: 'focusSession', entityId: id(200 + number), operation: 'UPSERT', lamportCounter: number,
    payload: { id: id(200 + number), startedAt: date, endedAt: date, focusDurationMs: 1, description } };
}

const segment = (segmentId, operations) => wire({ protocolVersion: 1, datasetId: descriptor.datasetId,
  deviceId: operations[0].deviceId, segmentId, operations });

function complete(repository) {
  const { owner } = repository.acquireOwner('regression-owner');
  const active = repository.startActive({ activeId: id(10), startedAt: date, focusDurationMs: 10,
    description: 'local', ownerToken: owner.token, ownerGeneration: owner.generation, expectedBindingGeneration: 1 });
  return repository.finish({ commandId: 'finish-local', activeId: active.id, expectedRevision: active.revision,
    ownerToken: owner.token, ownerGeneration: owner.generation, expectedBindingGeneration: 1,
    entityId: id(11), opId: id(12), endedAt: date });
}

for (const description of ['', '  preserve exact  ', '\u0085\u3000', 'e\u0301']) {
  test(`F3: received ${JSON.stringify(description)} survives exact no-op and independent field edits`, () => {
    const { repository, pin } = fixture();
    const received = operation(1, description);
    repository.receive(pin, 'received', segment(id(500), [received]));
    const command = { entityId: received.entityId, baseOpId: received.opId, expectedBindingGeneration: 1 };
    const before = repository.snapshot();
    assert.deepEqual(repository.edit({ ...command, payload: received.payload }), { changed: false, opId: received.opId });
    assert.deepEqual(repository.snapshot(), before);
    for (const [field, value] of [['focusDurationMs', 25], ['startedAt', '0001-01-01T00:00:00.000Z'], ['endedAt', '9999-12-31T23:59:59.999Z']]) {
      const winner = repository.snapshot().entities[received.entityId];
      const result = repository.edit({ ...command, baseOpId: repository.entityVersion(received.entityId), payload: { ...winner, [field]: value } });
      assert.equal(result.changed, true);
      assert.deepEqual(repository.snapshot().operations[result.opId].payload, { ...winner, [field]: value });
      assert.equal(repository.snapshot().entities[received.entityId].description, description);
    }
  });
}

test('F3: a changed description receives authoring rules; normalized no-op allocates no operation', () => {
  const { repository, pin } = fixture();
  const received = operation(1, '  preserved  ');
  repository.receive(pin, 'received', segment(id(500), [received]));
  const command = { entityId: received.entityId, baseOpId: received.opId, expectedBindingGeneration: 1 };
  const result = repository.edit({ ...command, payload: { ...received.payload, description: ' \u3000new title\u0085 ' } });
  assert.equal(repository.snapshot().entities[received.entityId].description, 'new title');
  const before = repository.snapshot();
  assert.deepEqual(repository.edit({ ...command, baseOpId: result.opId,
    payload: { ...before.entities[received.entityId], description: '  new title  ' } }), { changed: false, opId: result.opId });
  assert.deepEqual(repository.snapshot(), before);
});

test('F4: reservation crash then conflicting remote identity blocks before sealing or sending bytes', async () => {
  const { repository, pin, transport, ids } = fixture();
  complete(repository);
  repository.store.failNext('reserve.afterCommit');
  assert.throws(() => repository.reserve(pin), InjectedFailure);
  const reserved = Object.values(repository.snapshot().publications)[0];
  const remoteBytes = segment(reserved.segmentId, [operation(1)]);
  transport.put(pin, remoteBytes, { reference: 'opposing-segment' });
  const reopened = new TransactionalRepository({ store: repository.store, ids });
  await new SyncRunner(reopened, transport).run();
  const after = reopened.snapshot();
  assert.equal(after.blocked.classification, 'integrity');
  assert.deepEqual(after.segments[reserved.segmentId].bytes, remoteBytes);
  assert.equal(after.publications[reserved.segmentId].bytes, null);
  assert.equal(after.publications[reserved.segmentId].state, 'reserved');
  assert.equal(transport.calls.filter(call => call.method === 'publish').length, 0);
  assert.equal(after.outbox[id(12)].reservation, reserved.segmentId);
  assert.notEqual(reopened.status(), 'Synced');
});

test('F4: sealed-first arrival rejects opposing segment atomically before any remote operation is applied', () => {
  const { repository, pin } = fixture();
  complete(repository);
  const sealed = repository.seal(pin, repository.reserve(pin).segmentId);
  const before = repository.snapshot();
  assert.throws(() => repository.receive(pin, 'opposing', segment(sealed.segmentId, [operation(1)])), error => error.classification === 'integrity');
  assert.deepEqual(repository.snapshot(), before);
});
