import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeUtf8, MAX_SEGMENT_BYTES } from '../src/protocol/index.js';
import { AdversarialTransport, InjectedFailure, SyncRunner, TransactionalRepository } from '../src/simulation/index.js';

const id = n => `a1000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const date = '2026-10-17T15:00:00.000Z';
const descriptor = { application: 'focus-timer', protocolVersion: 1, datasetId: id(1) };
const wire = value => encodeUtf8(JSON.stringify(value));

function fixture() {
  let next = 10000;
  const ids = () => id(next++);
  const repository = new TransactionalRepository({ descriptor, writerId: id(2), ids });
  const target = { account: 'coverage-account', locator: 'coverage-root', datasetId: descriptor.datasetId };
  const transport = new AdversarialTransport();
  transport.createDataset(target, descriptor);
  const pin = repository.bind({ ...target, descriptor });
  return { repository, transport, target, pin,
    reopen: () => new TransactionalRepository({ store: repository.store, ids }) };
}

function complete(repository) {
  repository.acquireOwner('coverage-owner');
  let state = repository.snapshot();
  repository.startActive({ activeId: id(10), startedAt: date, focusDurationMs: 42,
    expectedBindingGeneration: state.bindingGeneration, ownerToken: state.owner.token,
    ownerGeneration: state.owner.generation, description: 'retained local session' });
  state = repository.snapshot();
  return repository.finish({ commandId: 'coverage-finish', activeId: state.active.id,
    expectedRevision: state.active.revision, expectedBindingGeneration: state.bindingGeneration,
    ownerToken: state.owner.token, ownerGeneration: state.owner.generation,
    entityId: id(11), opId: id(12), endedAt: date });
}

function remoteSegment() {
  return wire({ protocolVersion: 1, datasetId: descriptor.datasetId, deviceId: id(3), segmentId: id(30),
    operations: [{ protocolVersion: 1, schemaVersion: 1, opId: id(31), datasetId: descriptor.datasetId,
      deviceId: id(3), entityType: 'focusSession', entityId: id(32), operation: 'UPSERT', lamportCounter: 7,
      payload: { id: id(32), startedAt: date, endedAt: date, focusDurationMs: 9,
        description: 'retained received session' } }] });
}

async function retainCorpus(f, kind) {
  if (kind === 'received only') {
    f.transport.put(f.target, remoteSegment());
    assert.equal(await new SyncRunner(f.repository, f.transport).run(), 'Synced');
    assert.deepEqual(f.repository.snapshot().outbox, {});
    assert.deepEqual(f.repository.snapshot().publications, {});
    return;
  }
  const receipt = complete(f.repository);
  if (kind === 'reserved') f.repository.reserve(f.pin);
  if (kind === 'acknowledged' || kind === 'acknowledged tombstone') {
    if (kind === 'acknowledged tombstone') {
      f.repository.delete({ entityId: receipt.entityId, baseOpId: receipt.opId,
        expectedBindingGeneration: f.pin.generation, opId: id(13) });
    }
    assert.equal(await new SyncRunner(f.repository, f.transport).run(), 'Synced');
    assert.deepEqual(f.repository.snapshot().outbox, {});
  }
}

for (const kind of ['acknowledged', 'received only', 'unreserved', 'reserved', 'acknowledged tombstone']) {
  for (const disconnected of [false, true]) {
    test(`coverage: ${kind} corpus rejects another destination${disconnected ? ' after disconnect/reopen' : ''} and resumes its original target`, async () => {
      const f = fixture();
      await retainCorpus(f, kind);
      let repository = f.repository;
      if (disconnected) {
        repository.disconnect();
        repository = f.reopen();
      }
      const before = repository.snapshot();
      // Changing either part of the destination is unsafe even with no pending
      // publications, no locally authored operations, or no live sessions.
      for (const destination of [
        { ...f.target, locator: 'descriptor-only-other-root' },
        { ...f.target, account: 'other-account' },
      ]) {
        f.transport.createDataset(destination, descriptor);
        assert.throws(() => repository.bind({ ...destination, descriptor, resumePublications: true }),
          error => error.code === (kind === 'reserved'
            ? 'pending-publication-rebind-required' : 'destination-transfer-required'));
        assert.deepEqual(repository.snapshot(), before);
        assert.equal(f.transport.references(destination).length, 0);
      }
      const resumed = repository.bind({ ...f.target, descriptor, resumePublications: true });
      assert.ok(resumed.generation > f.pin.generation);
      assert.equal(await new SyncRunner(repository, f.transport).run(), 'Synced');
      assert.deepEqual(repository.snapshot().operations, before.operations);
      assert.deepEqual(repository.materialized(), {
        entities: Object.values(before.entities), tombstones: before.tombstones,
      });
      assert.deepEqual(repository.snapshot().outbox, {});
    });
  }
}

test('coverage: an empty replica can change destination because it has no retained corpus to transfer', async () => {
  const { repository, target, transport } = fixture();
  assert.equal(await new SyncRunner(repository, transport).run(), 'Synced');
  repository.disconnect();
  const next = { ...target, account: 'empty-next-account', locator: 'empty-next-root' };
  transport.createDataset(next, descriptor);
  repository.bind({ ...next, descriptor });
  assert.equal(await new SyncRunner(repository, transport).run(), 'Synced');
  assert.deepEqual(repository.snapshot().operations, {});
});

for (const fault of ['missing', 'malformed', 'unsupported', 'conflicting bytes', 'oversized']) {
  test(`coverage: own acknowledged upload ${fault} before its first listing prevents Synced and preserves history`, async () => {
    const { repository, target, transport, pin } = fixture();
    complete(repository);
    assert.equal(await new SyncRunner(repository, transport).run(), 'Synced');
    assert.equal(transport.calls.filter(call => call.method === 'enumerate').length, 1);
    const [reference] = transport.references(target);
    const before = repository.snapshot();
    assert.equal(Object.values(before.publications)[0].state, 'acknowledged');
    assert.deepEqual(before.outbox, {});
    // Hide the upload from listing as well: a stale/nonlinearizable list must
    // never erase the publisher's independently known coverage obligation.
    transport.setVisibleAt(target, reference, 100);
    if (fault === 'missing') transport.setObjectAvailable(target, reference, false);
    else if (fault === 'malformed') transport.replace(target, reference, wire({ invalid: true }));
    else if (fault === 'oversized') transport.replace(target, reference, new Uint8Array(MAX_SEGMENT_BYTES + 1));
    else {
      const changed = JSON.parse(new TextDecoder().decode(transport.bytes(target, reference)));
      if (fault === 'unsupported') changed.protocolVersion = 2;
      else changed.operations[0].payload.description = 'opposing immutable bytes';
      transport.replace(target, reference, wire(changed));
    }
    assert.equal(await new SyncRunner(repository, transport).run(), 'Recovery required');
    const after = repository.snapshot();
    assert.ok(after.blocked);
    if (fault !== 'missing') assert.equal(after.blocked.classification, 'integrity');
    assert.deepEqual(after.operations, before.operations);
    assert.deepEqual(after.entities, before.entities);
    assert.deepEqual(after.tombstones, before.tombstones);
    assert.equal(after.highWater, before.highWater);
    assert.deepEqual(after.outbox, {});
    assert.ok(transport.calls.some(call => call.method === 'read' && call.reference === reference));
    assert.equal(repository.captureBinding().generation, pin.generation);
  });
}

test('coverage: delayed listing and an incomplete read retain a retryable own-upload obligation until exact read succeeds', async () => {
  const { repository, target, transport } = fixture();
  complete(repository);
  assert.equal(await new SyncRunner(repository, transport).run(), 'Synced');
  const [reference] = transport.references(target);
  const before = repository.snapshot();
  transport.setVisibleAt(target, reference, 100);
  transport.queue('read', { type: 'truncated', length: 1 });
  assert.equal(await new SyncRunner(repository, transport).run(), 'Offline / Retry pending');
  assert.equal(repository.snapshot().blocked, null);
  assert.deepEqual(repository.snapshot().operations, before.operations);
  assert.deepEqual(repository.snapshot().outbox, {});
  assert.equal(await new SyncRunner(repository, transport).run(), 'Synced');
  assert.equal(transport.calls.filter(call => call.method === 'publish').length, 1);
  assert.equal(transport.calls.filter(call => call.method === 'read' && call.reference === reference).length, 2);
  assert.deepEqual(repository.snapshot().operations, before.operations);
});

test('coverage: acknowledgement commit ambiguity and original-target reconnect retain an upload never yet listed', async () => {
  const f = fixture();
  complete(f.repository);
  f.repository.store.failNext('ack.afterCommit');
  await assert.rejects(new SyncRunner(f.repository, f.transport).run(), InjectedFailure);
  const before = f.repository.snapshot();
  assert.equal(Object.values(before.publications)[0].state, 'acknowledged');
  assert.deepEqual(before.outbox, {});
  const [reference] = f.transport.references(f.target);
  f.transport.setObjectAvailable(f.target, reference, false);
  f.repository.disconnect();
  const reopened = f.reopen();
  reopened.bind({ ...f.target, descriptor, resumePublications: true });
  assert.equal(await new SyncRunner(reopened, f.transport).run(), 'Recovery required');
  assert.deepEqual(reopened.snapshot().operations, before.operations);
  assert.deepEqual(reopened.snapshot().entities, before.entities);
  assert.deepEqual(reopened.snapshot().outbox, {});
  assert.equal(f.transport.calls.filter(call => call.method === 'publish').length, 1);
  assert.ok(f.transport.calls.some(call => call.method === 'read' && call.reference === reference));
});

test('coverage: confirmed upload references survive a crash before acknowledgement and block lost-content acknowledgement', async () => {
  const f = fixture();
  const receipt = complete(f.repository);
  f.repository.store.failNext('confirm.afterCommit');
  await assert.rejects(new SyncRunner(f.repository, f.transport).run(), InjectedFailure);
  const before = f.repository.snapshot();
  assert.equal(Object.values(before.publications)[0].state, 'confirmed');
  assert.ok(before.outbox[receipt.opId]);
  const [reference] = f.transport.references(f.target);
  f.transport.setObjectAvailable(f.target, reference, false);
  const reopened = f.reopen();
  assert.equal(await new SyncRunner(reopened, f.transport).run(), 'Recovery required');
  assert.deepEqual(reopened.snapshot().outbox, before.outbox);
  assert.deepEqual(reopened.snapshot().operations, before.operations);
  assert.equal(Object.values(reopened.snapshot().publications)[0].state, 'confirmed');
  assert.equal(f.transport.calls.filter(call => call.method === 'publish').length, 1);
  assert.ok(f.transport.calls.some(call => call.method === 'read' && call.reference === reference));
});

test('coverage: affirmative confirmation without physical references cannot make an undiscovered own segment healthy', async () => {
  const { repository, pin, target, transport } = fixture();
  complete(repository);
  const pass = repository.beginPass(pin);
  repository.recordPage(pin, pass.passId, { references: [], continuation: null, complete: true });
  const publication = repository.seal(pin, repository.reserve(pin).segmentId);
  const attempt = repository.beginAttempt(pin, publication.segmentId);
  const confirmation = await transport.publish(pin, attempt);
  // An adapter can affirm exact content without providing a physical handle;
  // that is sufficient to ack membership, but not to forget future coverage.
  const { references, ...withoutReferences } = confirmation;
  repository.confirm(pin, publication.segmentId, withoutReferences);
  repository.acknowledge(pin, publication.segmentId);
  assert.deepEqual(repository.snapshot().outbox, {});
  assert.equal(repository.completePass(pin), false);
  assert.notEqual(repository.status(), 'Synced');
  const [reference] = transport.references(target);
  transport.setVisibleAt(target, reference, 100);
  assert.notEqual(await new SyncRunner(repository, transport).run(), 'Synced');
  transport.advance(100);
  assert.equal(await new SyncRunner(repository, transport).run(), 'Synced');
  assert.deepEqual(repository.snapshot().publications[publication.segmentId].remoteReferences, [reference]);
  const artifact = repository.snapshot().discoveries[pin.generation].artifacts[reference];
  assert.equal(artifact.segmentId, publication.segmentId);
  assert.deepEqual(artifact.originalBytes, publication.bytes);
  assert.equal(transport.calls.filter(call => call.method === 'publish').length, 1);
});

test('coverage: conflicting confirmation references roll back every new coverage entry atomically', () => {
  const { repository, pin } = fixture();
  repository.receive(pin, 'known-other-segment', remoteSegment());
  complete(repository);
  const publication = repository.seal(pin, repository.reserve(pin).segmentId);
  repository.beginAttempt(pin, publication.segmentId);
  const before = repository.snapshot();
  assert.throws(() => repository.confirm(pin, publication.segmentId, {
    outcome: 'confirmed', segmentId: publication.segmentId, bytes: publication.bytes,
    references: ['new-ref-before-conflict', 'known-other-segment'],
  }), error => error.classification === 'integrity');
  assert.deepEqual(repository.snapshot(), before);
  assert.equal(Object.hasOwn(repository.snapshot().discoveries[pin.generation].artifacts, 'new-ref-before-conflict'), false);
});

test('coverage: opaque prototype-looking confirmation references are durable own keys and repeated confirmations preserve all obligations', async () => {
  const { repository, pin, target, transport } = fixture();
  complete(repository);
  const pass = repository.beginPass(pin);
  repository.recordPage(pin, pass.passId, { references: [], continuation: null, complete: true });
  const publication = repository.seal(pin, repository.reserve(pin).segmentId);
  const references = ['__proto__', 'constructor', 'toString'];
  for (const reference of references) transport.put(target, publication.bytes, { reference });
  const attempt = repository.beginAttempt(pin, publication.segmentId);
  const confirmation = await transport.publish(pin, attempt);
  const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
  repository.confirm(pin, publication.segmentId, confirmation);
  repository.acknowledge(pin, publication.segmentId);
  confirmation.bytes.fill(0);
  confirmation.references.length = 0;
  repository.confirm(pin, publication.segmentId, { outcome: 'already-present', segmentId: publication.segmentId,
    bytes: publication.bytes, references: ['__proto__', '__proto__'] });
  const after = repository.snapshot();
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
  assert.deepEqual(after.publications[publication.segmentId].remoteReferences, references);
  for (const reference of references) {
    const artifacts = after.discoveries[pin.generation].artifacts;
    assert.equal(Object.hasOwn(artifacts, reference), true);
    assert.equal(artifacts[reference].segmentId, publication.segmentId);
    assert.deepEqual(artifacts[reference].originalBytes, publication.bytes);
    assert.equal(artifacts[reference].verifiedPass, pass.passId);
    assert.equal(artifacts[reference].state, 'applied');
  }
  assert.equal(repository.completePass(pin), true);
  assert.equal(repository.status(), 'Synced');
  // A later hidden object is still checked even when two other exact physical
  // copies of the same logical segment remain available.
  transport.setObjectAvailable(target, 'constructor', false);
  assert.equal(await new SyncRunner(repository, transport).run(), 'Recovery required');
  assert.deepEqual(repository.snapshot().operations, after.operations);
});

test('coverage: failure at confirm.coverage persists neither coverage nor confirmation and exact retry recovers', async () => {
  const f = fixture();
  complete(f.repository);
  const publication = f.repository.seal(f.pin, f.repository.reserve(f.pin).segmentId);
  const attempt = f.repository.beginAttempt(f.pin, publication.segmentId);
  const confirmation = await f.transport.publish(f.pin, attempt);
  const before = f.repository.snapshot();
  f.repository.store.failNext('confirm.coverage');
  assert.throws(() => f.repository.confirm(f.pin, publication.segmentId, confirmation), InjectedFailure);
  assert.deepEqual(f.repository.snapshot(), before);
  assert.equal(f.repository.snapshot().segments[publication.segmentId], undefined);
  assert.equal(f.repository.snapshot().publications[publication.segmentId].remoteReferences, undefined);
  const reopened = f.reopen();
  assert.equal(await new SyncRunner(reopened, f.transport).run(), 'Synced');
  const after = reopened.snapshot();
  assert.equal(after.publications[publication.segmentId].state, 'acknowledged');
  assert.deepEqual(after.publications[publication.segmentId].bytes, publication.bytes);
  assert.deepEqual(after.operations, before.operations);
  assert.deepEqual(after.outbox, {});
  const attempts = f.transport.calls.filter(call => call.method === 'publish');
  assert.equal(attempts.length, 2);
  assert.deepEqual(attempts[0].bytes, attempts[1].bytes);
  assert.equal(f.transport.references(f.target).length, 1);
});

test('coverage: acknowledged segment without a reference stays pending after reconnect until receive durably resolves it', async () => {
  const f = fixture();
  complete(f.repository);
  const pass = f.repository.beginPass(f.pin);
  f.repository.recordPage(f.pin, pass.passId, { references: [], continuation: null, complete: true });
  const publication = f.repository.seal(f.pin, f.repository.reserve(f.pin).segmentId);
  const attempt = f.repository.beginAttempt(f.pin, publication.segmentId);
  const { references, ...confirmation } = await f.transport.publish(f.pin, attempt);
  f.repository.confirm(f.pin, publication.segmentId, confirmation);
  f.repository.acknowledge(f.pin, publication.segmentId);
  assert.equal(f.repository.completePass(f.pin), false);
  f.repository.disconnect();
  const reopened = f.reopen();
  const pin = reopened.bind({ ...f.target, descriptor, resumePublications: true });
  const [reference] = f.transport.references(f.target);
  f.transport.setVisibleAt(f.target, reference, 100);
  assert.equal(await new SyncRunner(reopened, f.transport).run(), 'Changes saved locally / Pending');
  const beforeReceive = reopened.snapshot();
  reopened.store.failNext('receive.applied');
  assert.throws(() => reopened.receive(pin, reference, publication.bytes), InjectedFailure);
  assert.deepEqual(reopened.snapshot(), beforeReceive);
  assert.equal(reopened.completePass(pin), false);
  reopened.receive(pin, reference, publication.bytes);
  assert.equal(reopened.completePass(pin), true);
  assert.equal(reopened.status(), 'Synced');
  const after = reopened.snapshot();
  assert.deepEqual(after.publications[publication.segmentId].remoteReferences, [reference]);
  assert.deepEqual(after.operations, beforeReceive.operations);
  assert.deepEqual(after.outbox, {});
  assert.deepEqual(after.discoveries[pin.generation].artifacts[reference].originalBytes, publication.bytes);
  assert.equal(f.transport.calls.filter(call => call.method === 'publish').length, 1);
  f.transport.setObjectAvailable(f.target, reference, false);
  assert.equal(await new SyncRunner(reopened, f.transport).run(), 'Recovery required');
});
