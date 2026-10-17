import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_COUNTER, encodeUtf8, parseSegment } from '../src/protocol/index.js';
import {
  AdversarialTransport, InjectedFailure, MemoryStore, SyncRunner, TransactionalRepository,
} from '../src/simulation/index.js';

const id = value => `${value.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`;
const descriptor = { application: 'focus-timer', protocolVersion: 1, datasetId: id(1) };
const target = { account: 'account-a', locator: 'collection-a' };
const time = '2026-10-17T15:20:00.000Z';
const end = '2026-10-17T16:20:00.000Z';
function ids(start = 100000) { let value = start; return () => id(value++); }

function fixture({ writer = id(2), seed = 100000, bound = true, store = new MemoryStore() } = {}) {
  const repository = new TransactionalRepository({ store, descriptor, writerId: writer, ids: ids(seed) });
  if (bound && !repository.captureBinding()) repository.bind({ ...target, descriptor });
  return repository;
}

function ownerCommand(repository) {
  if (!repository.snapshot().owner) repository.acquireOwner('owner-a');
  const state = repository.snapshot();
  return { ownerToken: state.owner.token, ownerGeneration: state.owner.generation,
    expectedBindingGeneration: state.bindingGeneration };
}

function prepareFinish(repository, number = 1, description = 'Study') {
  const owner = ownerCommand(repository);
  const active = repository.startActive({ ...owner, activeId: id(1000 + number), startedAt: time,
    focusDurationMs: 1234, description, state: 'running' });
  return { ...owner, activeId: active.id, expectedRevision: active.revision, commandId: `finish-${number}`,
    endedAt: end, entityId: id(10000 + number), opId: id(20000 + number) };
}

function add(repository, number = 1, description = 'Study') {
  return repository.finish(prepareFinish(repository, number, description));
}

function operation(number, { entity = id(500), counter = number, writer = id(3), description = `remote-${number}`, kind = 'UPSERT' } = {}) {
  return { protocolVersion: 1, schemaVersion: 1, opId: id(30000 + number), datasetId: descriptor.datasetId,
    deviceId: writer, entityType: 'focusSession', entityId: entity, operation: kind, lamportCounter: counter,
    ...(kind === 'UPSERT' ? { payload: { id: entity, startedAt: time, endedAt: end, focusDurationMs: 1000, description } } : {}) };
}

function segment(number, operations, extra = {}) {
  return encodeUtf8(JSON.stringify({ protocolVersion: 1, datasetId: descriptor.datasetId,
    deviceId: operations[0]?.deviceId ?? id(3), segmentId: id(40000 + number), operations, ...extra }));
}

function transportFor(repository, options) {
  const transport = new AdversarialTransport(options);
  transport.createDataset(repository.captureBinding(), descriptor);
  return transport;
}

const isCode = code => error => error.code === code || error.classification === code;

async function crashMatrix(t, make, act, prefix) {
  const expectedRepository = make();
  expectedRepository.store.clearTrace();
  act(expectedRepository);
  const expected = expectedRepository.snapshot();
  const points = expectedRepository.store.trace.filter(point => point.startsWith(`${prefix}.`));
  assert.ok(points.length >= 4);
  for (const point of points) {
    await t.test(point, () => {
      const repository = make();
      const before = repository.snapshot();
      repository.store.failNext(point);
      assert.throws(() => act(repository), InjectedFailure);
      const reopened = new TransactionalRepository({ store: repository.store, ids: ids() });
      assert.deepEqual(reopened.snapshot(), point.endsWith('.afterCommit') ? expected : before);
    });
  }
}

test('Finish commits domain, immutable operation, high-water, outbox, receipt and active consumption atomically', async t => {
  await crashMatrix(t, () => {
    const repository = fixture();
    repository.command = prepareFinish(repository);
    return repository;
  }, repository => repository.finish(repository.command), 'finish');
});

test('edit and DELETE transaction failures leave no partial state', async t => {
  for (const kind of ['edit', 'delete']) {
    await t.test(kind, async t => {
      await crashMatrix(t, () => { const repository = fixture(); add(repository); return repository; }, repository => {
        const entityId = id(10001);
        const command = { entityId, baseOpId: repository.entityVersion(entityId), expectedBindingGeneration: 1, opId: id(9999) };
        if (kind === 'edit') repository.edit({ ...command, payload: { ...repository.snapshot().entities[entityId], description: 'New' } });
        else repository.delete(command);
      }, kind);
    });
  }
});

test('whole segment receive atomically commits accepted operations, projection, tombstone, clock, dedup and applied marker', async t => {
  const bytes = segment(1, [operation(1), operation(2, { entity: id(501), kind: 'DELETE' }), operation(3, { counter: 80 })]);
  await crashMatrix(t, () => fixture(), repository => repository.receive(repository.captureBinding(), 'remote-a', bytes), 'receive');
});

test('discovery checkpoint never precedes durable pending references', async t => {
  await crashMatrix(t, () => {
    const repository = fixture();
    repository.beginPass(repository.captureBinding());
    return repository;
  }, repository => repository.recordPage(repository.captureBinding(), 1,
    { references: ['a', 'b'], continuation: 'opaque-cursor', complete: false }), 'discover');
});

for (const transition of ['reserve', 'seal', 'attempt', 'unknown', 'confirm', 'ack']) {
  test(`publication ${transition} is atomic across every injected persistence boundary`, async t => {
    await crashMatrix(t, () => {
      const repository = fixture();
      add(repository);
      const pin = repository.captureBinding();
      if (transition !== 'reserve') {
        repository.publication = repository.reserve(pin);
        if (transition !== 'seal') repository.publication = repository.seal(pin, repository.publication.segmentId);
        if (['unknown', 'confirm', 'ack'].includes(transition)) repository.beginAttempt(pin, repository.publication.segmentId);
        if (transition === 'ack') repository.confirm(pin, repository.publication.segmentId,
          { outcome: 'confirmed', segmentId: repository.publication.segmentId, bytes: repository.publication.bytes });
      }
      return repository;
    }, repository => {
      const pin = repository.captureBinding();
      if (transition === 'reserve') repository.reserve(pin);
      else if (transition === 'confirm') repository.confirm(pin, repository.publication.segmentId,
        { outcome: 'confirmed', segmentId: repository.publication.segmentId, bytes: repository.publication.bytes });
      else if (transition === 'ack') repository.acknowledge(pin, repository.publication.segmentId);
      else if (transition === 'attempt') repository.beginAttempt(pin, repository.publication.segmentId);
      else repository[transition](pin, repository.publication.segmentId);
    }, transition);
  });
}

test('completion receipt handles duplicate Finish, lost local commit response and reopened repository', () => {
  const repository = fixture();
  const command = prepareFinish(repository);
  repository.store.failNext('finish.afterCommit');
  assert.throws(() => repository.finish(command), InjectedFailure);
  const reopened = new TransactionalRepository({ store: repository.store, ids: ids() });
  const receipt = reopened.finish(command);
  assert.deepEqual(reopened.finish({ ...command, commandId: 'another-retry' }), receipt);
  assert.equal(Object.keys(reopened.snapshot().operations).length, 1);
  assert.equal(reopened.snapshot().active, null);
  assert.equal(reopened.snapshot().highWater, 1);
});

test('active revision and owner fencing reject delayed checkpoints and obsolete Finish', () => {
  const repository = fixture();
  const command = prepareFinish(repository);
  const active = repository.checkpointActive({ ...command, focusDurationMs: 2000 });
  assert.throws(() => repository.finish(command), isCode('stale-active'));
  assert.throws(() => repository.checkpointActive({ ...command, focusDurationMs: 9000 }), isCode('stale-active'));
  repository.setOwnerStatus('unknown');
  assert.throws(() => repository.recoverOwner('owner-b'), isCode('owner-recovery-required'));
  const recovered = repository.recoverOwner('owner-b', { deliberate: true });
  assert.equal(recovered.active.state, 'paused');
  assert.equal(recovered.active.focusDurationMs, 2000);
  assert.equal(recovered.active.revision, active.revision + 1);
  assert.throws(() => repository.finish({ ...command, expectedRevision: recovered.active.revision }), isCode('stale-owner'));
  assert.equal(repository.snapshot().highWater, 0);
});

test('new tab attaches to live execution owner and cannot infer death from missing heartbeats', () => {
  const repository = fixture();
  prepareFinish(repository);
  const before = repository.snapshot().active;
  const attached = repository.acquireOwner('second-tab');
  assert.equal(attached.kind, 'attached');
  assert.equal(attached.owner.token, 'owner-a');
  assert.deepEqual(repository.snapshot().active, before);
  assert.throws(() => repository.recoverOwner('second-tab', { deliberate: true }), isCode('owner-recovery-required'));
  repository.setOwnerStatus('gone');
  const recovered = repository.recoverOwner('second-tab');
  assert.equal(recovered.active.state, 'paused');
  assert.equal(recovered.active.focusDurationMs, before.focusDurationMs);
});

test('local unchanged edits, repeated DELETE and unknown DELETE create no operations', () => {
  const repository = fixture();
  add(repository);
  const entityId = id(10001);
  const command = { entityId, baseOpId: repository.entityVersion(entityId), expectedBindingGeneration: 1 };
  assert.equal(repository.edit({ ...command, payload: repository.snapshot().entities[entityId] }).changed, false);
  assert.equal(repository.snapshot().highWater, 1);
  assert.equal(repository.delete(command).changed, true);
  assert.equal(repository.delete(command).changed, false);
  assert.equal(repository.delete({ ...command, entityId: id(999) }).changed, false);
  assert.equal(repository.snapshot().highWater, 2);
  assert.deepEqual(repository.materialized(), { entities: [], tombstones: [entityId] });
});

test('authoring trims only prescribed whitespace, supplies exact default, and validates before trim', () => {
  const repository = fixture();
  add(repository, 1, '\u0085\u3000');
  assert.equal(repository.materialized().entities[0].description, 'Untitled session.');
  add(repository, 2, '\ufeff  kept  \ufeff');
  assert.equal(repository.snapshot().entities[id(10002)].description, '\ufeff  kept  \ufeff');
  const state = repository.snapshot();
  assert.throws(() => repository.edit({ entityId: id(10001), baseOpId: repository.entityVersion(id(10001)),
    expectedBindingGeneration: 1, payload: { ...state.entities[id(10001)], description: ' '.repeat(121) } }), isCode('malformed'));
  assert.deepEqual(repository.snapshot(), state);
});

test('remote winner and terminal delete invalidate a stale history editor', () => {
  const repository = fixture();
  add(repository);
  const entityId = id(10001);
  const old = repository.entityVersion(entityId);
  const edited = { ...repository.snapshot().entities[entityId], description: 'stale form' };
  repository.receive(repository.captureBinding(), 'remote-edit', segment(1, [operation(1, { entity: entityId, counter: 50 })]));
  assert.throws(() => repository.edit({ entityId, baseOpId: old, payload: edited, expectedBindingGeneration: 1 }), isCode('stale-editor'));
  repository.receive(repository.captureBinding(), 'remote-delete', segment(2, [operation(2, { entity: entityId, counter: 1, kind: 'DELETE' })]));
  assert.throws(() => repository.edit({ entityId, baseOpId: repository.entityVersion(entityId), payload: edited,
    expectedBindingGeneration: 1 }), isCode('stale-editor'));
  assert.deepEqual(repository.materialized().tombstones, [entityId]);
  assert.equal(repository.snapshot().highWater, 50);
});

test('losing and post-delete operations advance durable high-water and local next command observes it', () => {
  const repository = fixture();
  const remote = [operation(1, { kind: 'DELETE', counter: 1 }), operation(2, { counter: 800 })];
  repository.receive(repository.captureBinding(), 'tombstone', segment(1, remote));
  assert.equal(repository.snapshot().highWater, 800);
  assert.deepEqual(repository.materialized().entities, []);
  add(repository);
  assert.equal(repository.snapshot().operations[id(20001)].lamportCounter, 801);
  const reopened = new TransactionalRepository({ store: repository.store, ids: ids() });
  reopened.rotateWriter(id(88));
  add(reopened, 2);
  assert.equal(reopened.snapshot().operations[id(20002)].lamportCounter, 802);
});

test('counter exhaustion aborts Finish without consuming active work or changing outbox', () => {
  const repository = fixture();
  repository.receive(repository.captureBinding(), 'maximum', segment(1, [operation(1, { counter: MAX_COUNTER })]));
  const command = prepareFinish(repository);
  const before = repository.snapshot();
  assert.throws(() => repository.finish(command), isCode('counter-exhausted'));
  assert.deepEqual(repository.snapshot(), before);
  assert.equal(repository.status(), 'Recovery required');
});

test('two worker repositories sharing a store allocate distinct transactional counters', async () => {
  const first = fixture();
  const second = new TransactionalRepository({ store: first.store, ids: ids(200000) });
  add(first);
  const entityId = id(10001);
  const base = first.entityVersion(entityId);
  const result = await Promise.allSettled([first, second].map((repository, index) => Promise.resolve().then(() => repository.edit({
    entityId, baseOpId: base, payload: { ...repository.snapshot().entities[entityId], description: `edit-${index}` },
    expectedBindingGeneration: 1, opId: id(80000 + index),
  }))));
  assert.equal(result.filter(value => value.status === 'fulfilled').length, 1);
  assert.equal(result.find(value => value.status === 'rejected').reason.code, 'stale-editor');
  add(second, 2);
  assert.deepEqual(Object.values(first.snapshot().operations).map(value => value.lamportCounter).sort(), [1, 2, 3]);
});

test('competing receivers recheck conflicting op identities inside the acceptance transaction', () => {
  const first = fixture();
  const second = new TransactionalRepository({ store: first.store, ids: ids(200000) });
  const a = operation(1);
  const b = { ...a, payload: { ...a.payload, description: 'conflicting immutable op' } };
  first.receive(first.captureBinding(), 'first', segment(1, [a]));
  const before = first.snapshot();
  assert.throws(() => second.receive(second.captureBinding(), 'second', segment(2, [operation(2, { entity: id(502) }), b])), isCode('integrity'));
  assert.deepEqual(first.snapshot(), before);
});

test('operation equality ignores member order and escapes while segment bytes stay immutable', () => {
  const repository = fixture();
  const op = operation(1, { description: 'é' });
  const original = segment(1, [op]);
  repository.receive(repository.captureBinding(), 'first', original);
  const reordered = Object.fromEntries(Object.entries(op).reverse());
  const equivalent = encodeUtf8(JSON.stringify({ protocolVersion: 1, datasetId: descriptor.datasetId, deviceId: op.deviceId,
    segmentId: id(40002), operations: [reordered] }).replace('é', '\\u00e9'));
  repository.receive(repository.captureBinding(), 'second', equivalent);
  assert.equal(Object.keys(repository.snapshot().operations).length, 1);
  const changedBytes = encodeUtf8(` ${new TextDecoder().decode(original)}`);
  assert.throws(() => repository.receive(repository.captureBinding(), 'third', changedBytes), isCode('integrity'));
  assert.throws(() => repository.receive(repository.captureBinding(), 'first', equivalent), isCode('integrity'));
});

test('competing seals reserve disjoint membership and new operations never enter a sealed segment', () => {
  const repository = fixture();
  add(repository, 1);
  add(repository, 2);
  const peer = new TransactionalRepository({ store: repository.store, ids: ids(200000) });
  const pin = repository.captureBinding();
  const first = repository.reserve(pin, { maxOperations: 1 });
  const second = peer.reserve(pin, { maxOperations: 1 });
  assert.notEqual(first.segmentId, second.segmentId);
  assert.notEqual(first.operationIds[0], second.operationIds[0]);
  assert.equal(repository.reserve(pin), null);
  const sealed = repository.seal(pin, first.segmentId);
  add(repository, 3);
  assert.deepEqual(repository.seal(pin, first.segmentId).bytes, sealed.bytes);
  assert.deepEqual(parseSegment(sealed.bytes).operations.map(value => value.opId), first.operationIds);
  assert.equal(repository.snapshot().outbox[id(20003)].reservation, null);
});

test('sealed bytes, immutable values and returned snapshots cannot be changed through mutable aliases', () => {
  const repository = fixture();
  add(repository);
  const pin = repository.captureBinding();
  const reserved = repository.reserve(pin);
  reserved.operations[0].payload.description = 'outside mutation';
  const sealed = repository.seal(pin, reserved.segmentId);
  const original = Uint8Array.from(sealed.bytes);
  sealed.bytes.fill(0);
  const snapshot = repository.snapshot();
  snapshot.publications[reserved.segmentId].bytes.fill(255);
  snapshot.entities[id(10001)].description = 'corrupt';
  assert.deepEqual(repository.seal(pin, reserved.segmentId).bytes, original);
  assert.equal(repository.materialized().entities[0].description, 'Study');
});

test('exact acknowledgement cannot remove later edits or another workers reserved operations', () => {
  const repository = fixture();
  add(repository, 1);
  add(repository, 2);
  const pin = repository.captureBinding();
  const first = repository.seal(pin, repository.reserve(pin, { maxOperations: 1 }).segmentId);
  const second = repository.seal(pin, repository.reserve(pin, { maxOperations: 1 }).segmentId);
  add(repository, 3);
  assert.throws(() => repository.acknowledge(pin, first.segmentId), isCode('unconfirmed-publication'));
  assert.throws(() => repository.confirm(pin, first.segmentId, { outcome: 'confirmed', segmentId: second.segmentId, bytes: second.bytes }), isCode('integrity'));
  repository.beginAttempt(pin, first.segmentId);
  repository.confirm(pin, first.segmentId, { outcome: 'confirmed', segmentId: first.segmentId, bytes: first.bytes });
  repository.acknowledge(pin, first.segmentId);
  assert.deepEqual(Object.keys(repository.snapshot().outbox).sort(), [id(20002), id(20003)]);
  assert.equal(repository.snapshot().outbox[id(20002)].reservation, second.segmentId);
  assert.equal(repository.snapshot().outbox[id(20003)].reservation, null);
});

test('old writer sealed and unsealed publications retain original identity after authoring rotation', () => {
  const repository = fixture();
  add(repository, 1);
  const pin = repository.captureBinding();
  const sealed = repository.seal(pin, repository.reserve(pin).segmentId);
  add(repository, 2);
  repository.rotateWriter(id(44));
  add(repository, 3);
  const old = repository.seal(pin, repository.reserve(pin).segmentId);
  const fresh = repository.seal(pin, repository.reserve(pin).segmentId);
  assert.equal(old.writerId, id(2));
  assert.equal(fresh.writerId, id(44));
  assert.deepEqual(repository.seal(pin, sealed.segmentId).bytes, sealed.bytes);
  assert.equal(repository.snapshot().highWater, 3);
});

test('response loss leaves unknown outcome and restart retries identical publication before exact acknowledgement', async () => {
  const repository = fixture();
  add(repository);
  const transport = transportFor(repository, { duplicatePublications: true });
  transport.queue('publish', { type: 'response-lost' });
  const runner = new SyncRunner(repository, transport);
  assert.equal(await runner.run(), 'Offline / Retry pending');
  const unknown = Object.values(repository.snapshot().publications)[0];
  assert.equal(unknown.state, 'unknown');
  assert.equal(Object.keys(repository.snapshot().outbox).length, 1);
  assert.equal(transport.references(repository.captureBinding()).length, 1);
  const reopened = new TransactionalRepository({ store: repository.store, ids: ids(200000) });
  assert.equal(await new SyncRunner(reopened, transport).run(), 'Synced');
  const attempts = transport.calls.filter(value => value.method === 'publish');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].segmentId, attempts[1].segmentId);
  assert.deepEqual(attempts[0].bytes, attempts[1].bytes);
  assert.equal(Object.keys(reopened.snapshot().outbox).length, 0);
  assert.equal(reopened.materialized().entities.length, 1);
  assert.equal(transport.references(reopened.captureBinding()).length, 2);
  assert.equal(await new SyncRunner(reopened, transport).run(), 'Synced');
  assert.equal(reopened.materialized().entities.length, 1);
});

test('a new edit during publication remains pending until separately sealed and acknowledged', async () => {
  const repository = fixture();
  add(repository);
  const transport = transportFor(repository);
  const gate = transport.holdNext('publish');
  const work = new SyncRunner(repository, transport).run({ maxPublications: 1 });
  await gate.entered;
  const entityId = id(10001);
  repository.edit({ entityId, baseOpId: repository.entityVersion(entityId), expectedBindingGeneration: 1,
    payload: { ...repository.snapshot().entities[entityId], description: 'during upload' }, opId: id(90000) });
  gate.release();
  assert.equal(await work, 'Changes saved locally / Pending');
  assert.deepEqual(Object.keys(repository.snapshot().outbox), [id(90000)]);
  assert.equal(repository.snapshot().outbox[id(90000)].reservation, null);
  assert.equal(await new SyncRunner(repository, transport).run(), 'Synced');
});

test('two sync workers may retry same immutable publication without duplicate domain state', async () => {
  const repository = fixture();
  add(repository);
  const peer = new TransactionalRepository({ store: repository.store, ids: ids(200000) });
  const transport = transportFor(repository, { duplicatePublications: true });
  const gate = transport.holdNext('publish');
  const first = new SyncRunner(repository, transport).run();
  await gate.entered;
  await new SyncRunner(peer, transport).run();
  gate.release();
  await first;
  assert.equal(await new SyncRunner(repository, transport).run(), 'Synced');
  const calls = transport.calls.filter(value => value.method === 'publish');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].segmentId, calls[1].segmentId);
  assert.deepEqual(calls[0].bytes, calls[1].bytes);
  assert.equal(repository.materialized().entities.length, 1);
  assert.equal(Object.keys(repository.snapshot().outbox).length, 0);
});

test('disconnect during publication fences stale acknowledgement and requires explicit original-target resume', async () => {
  const repository = fixture();
  add(repository);
  const transport = transportFor(repository);
  const original = repository.captureBinding();
  const gate = transport.holdNext('publish');
  const work = new SyncRunner(repository, transport).run();
  await gate.entered;
  repository.disconnect();
  assert.throws(() => repository.bind({ account: 'account-b', locator: 'collection-b', descriptor }), isCode('pending-publication-rebind-required'));
  gate.release();
  await work;
  assert.equal(Object.keys(repository.snapshot().outbox).length, 1);
  assert.equal(transport.references(original).length, 1);
  const callsBefore = transport.calls.filter(value => value.method === 'publish').length;
  assert.equal(await new SyncRunner(repository, transport).run(), 'Local only');
  assert.equal(transport.calls.filter(value => value.method === 'publish').length, callsBefore);
  const retained = Object.values(repository.snapshot().publications)[0];
  repository.bind({ ...target, descriptor, resumePublications: true });
  assert.equal(await new SyncRunner(repository, transport).run(), 'Synced');
  const resumed = Object.values(repository.snapshot().publications)[0];
  assert.deepEqual(resumed.bytes, retained.bytes);
  assert.equal(resumed.segmentId, retained.segmentId);
  assert.equal(Object.keys(repository.snapshot().outbox).length, 0);
});

test('stale local binding generation is rejected and active work prevents switching', () => {
  const repository = fixture();
  const command = prepareFinish(repository);
  assert.throws(() => repository.bind({ account: 'other', locator: 'other', descriptor }), isCode('active-not-idle'));
  repository.finish(command);
  repository.bind({ ...target, descriptor });
  assert.throws(() => repository.delete({ entityId: id(10001), baseOpId: repository.entityVersion(id(10001)),
    expectedBindingGeneration: 1 }), isCode('stale-binding'));
});

test('full paginated reconciliation tolerates reversed and duplicate discoveries', async () => {
  const repository = fixture();
  const transport = transportFor(repository, { pageSize: 1, order: 'reverse', duplicateDelivery: 2 });
  const pin = repository.captureBinding();
  const a = segment(1, [operation(1)]);
  transport.put(pin, a);
  transport.put(pin, a); // Duplicate physical immutable segment.
  transport.put(pin, segment(2, [operation(2, { counter: 2 })]));
  assert.equal(await new SyncRunner(repository, transport).run(), 'Synced');
  assert.equal(repository.materialized().entities[0].description, 'remote-2');
  assert.equal(Object.keys(repository.snapshot().operations).length, 2);
  assert.equal(transport.calls.filter(value => value.method === 'enumerate').length, 6);
  assert.equal(await new SyncRunner(repository, transport).run(), 'Synced');
});

test('empty partial page with continuation cannot be mistaken for completed discovery', async () => {
  const repository = fixture();
  const transport = transportFor(repository);
  transport.put(repository.captureBinding(), segment(1, [operation(1)]));
  transport.queue('enumerate', { type: 'partial', count: 0 });
  const runner = new SyncRunner(repository, transport);
  assert.equal(await runner.run({ maxPages: 1 }), 'Syncing');
  const pass = repository.snapshot().discoveries[1];
  assert.equal(pass.enumerationComplete, false);
  assert.notEqual(pass.checkpoint, null);
  assert.equal(pass.reconciled, false);
  assert.equal(repository.materialized().entities.length, 0);
  assert.equal(await runner.run(), 'Synced');
  assert.equal(repository.materialized().entities.length, 1);
});

test('interrupted enumeration retains pending downloads and opaque continuation across reopening', async () => {
  const repository = fixture();
  const transport = transportFor(repository, { pageSize: 1 });
  transport.put(repository.captureBinding(), segment(1, [operation(1)]));
  transport.put(repository.captureBinding(), segment(2, [operation(2, { entity: id(501) })]));
  transport.queue('read', { type: 'error', code: 'retryable' });
  assert.equal(await new SyncRunner(repository, transport).run(), 'Offline / Retry pending');
  const state = repository.snapshot();
  assert.equal(state.discoveries[1].artifacts['artifact-1'].state, 'pending');
  assert.notEqual(state.discoveries[1].checkpoint, null);
  assert.equal(Object.keys(state.operations).length, 0);
  const reopened = new TransactionalRepository({ store: repository.store, ids: ids() });
  assert.equal(await new SyncRunner(reopened, transport).run(), 'Synced');
  assert.equal(reopened.materialized().entities.length, 2);
});

test('rejected continuation falls back to full reconciliation without losing durable pending references', async () => {
  const repository = fixture();
  const transport = transportFor(repository, { pageSize: 1 });
  for (let number = 1; number <= 3; number += 1) transport.put(repository.captureBinding(), segment(number, [operation(number, { entity: id(500 + number) })]));
  const runner = new SyncRunner(repository, transport);
  await runner.run({ maxPages: 1 });
  transport.queue('enumerate', { type: 'reject-cursor' });
  assert.equal(await runner.run(), 'Synced');
  assert.equal(repository.materialized().entities.length, 3);
});

test('crash after durable discovery checkpoint but before acceptance resumes whole segment safely', async () => {
  const repository = fixture();
  const transport = transportFor(repository);
  transport.put(repository.captureBinding(), segment(1, [operation(1), operation(2, { entity: id(501), kind: 'DELETE' })]));
  repository.store.failNext('receive.operations');
  await assert.rejects(new SyncRunner(repository, transport).run(), InjectedFailure);
  const state = repository.snapshot();
  assert.equal(state.discoveries[1].enumerationComplete, true);
  assert.equal(state.discoveries[1].artifacts['artifact-1'].state, 'pending');
  assert.deepEqual(state.operations, {});
  const reopened = new TransactionalRepository({ store: repository.store, ids: ids() });
  assert.equal(await new SyncRunner(reopened, transport).run(), 'Synced');
  assert.equal(Object.keys(reopened.snapshot().operations).length, 2);
  assert.equal(reopened.snapshot().discovery, undefined);
});

test('delayed older artifacts and objects appearing mid-enumeration are eventually discovered', async () => {
  const repository = fixture();
  const transport = transportFor(repository, { pageSize: 1 });
  const pin = repository.captureBinding();
  transport.put(pin, segment(5, [operation(5, { counter: 50 })]));
  transport.put(pin, segment(1, [operation(1, { entity: id(501), counter: 1 })]), { visibleAt: 5 });
  const runner = new SyncRunner(repository, transport);
  await runner.run({ maxPages: 1 });
  transport.put(pin, segment(2, [operation(2, { entity: id(502), counter: 2 })]));
  await runner.run();
  transport.advance(5);
  assert.equal(await runner.run(), 'Synced');
  assert.equal(repository.materialized().entities.length, 3);
  assert.equal(repository.snapshot().highWater, 50);
});

test('artifact appearing during an unfinished snapshot enumeration is caught by a later full pass', async () => {
  const repository = fixture();
  const transport = transportFor(repository, { pageSize: 1 });
  const pin = repository.captureBinding();
  transport.put(pin, segment(1, [operation(1, { entity: id(501) })]));
  transport.put(pin, segment(2, [operation(2, { entity: id(502) })]));
  const runner = new SyncRunner(repository, transport);
  await runner.run({ maxPages: 1 });
  transport.put(pin, segment(3, [operation(3, { entity: id(503) })]));
  assert.equal(await runner.run(), 'Synced');
  assert.equal(repository.materialized().entities.length, 2);
  assert.equal(await runner.run(), 'Synced');
  assert.equal(repository.materialized().entities.length, 3);
});

test('transient unreadability and incomplete bytes remain pending without permanent quarantine', async () => {
  const repository = fixture();
  const transport = transportFor(repository);
  transport.put(repository.captureBinding(), segment(1, [operation(1)]), { readableAt: 2 });
  const runner = new SyncRunner(repository, transport);
  assert.equal(await runner.run(), 'Offline / Retry pending');
  assert.equal(repository.snapshot().blocked, null);
  transport.advance(2);
  transport.queue('read', { type: 'truncated', length: 20 });
  assert.equal(await runner.run(), 'Offline / Retry pending');
  assert.equal(repository.snapshot().blocked, null);
  assert.equal(repository.snapshot().discoveries[1].artifacts['artifact-1'].state, 'pending');
  assert.equal(await runner.run(), 'Synced');
});

test('known artifacts are reread and byte changes block ingestion/publication without changing valid history', async () => {
  const repository = fixture();
  const transport = transportFor(repository);
  const pin = repository.captureBinding();
  const bytes = segment(1, [operation(1)]);
  const reference = transport.put(pin, bytes);
  const runner = new SyncRunner(repository, transport);
  assert.equal(await runner.run(), 'Synced');
  const before = repository.materialized();
  add(repository);
  transport.replace(pin, reference, encodeUtf8(` ${new TextDecoder().decode(bytes)}`));
  assert.equal(await runner.run(), 'Recovery required');
  assert.deepEqual(repository.materialized().entities.filter(entity => entity.id === id(500)), before.entities);
  assert.equal(Object.keys(repository.snapshot().outbox).length, 1);
  assert.equal(transport.calls.filter(value => value.method === 'publish').length, 0);
  assert.equal(repository.snapshot().discoveries[1].artifacts[reference].state, 'quarantined');
  const readsBefore = transport.calls.length;
  await runner.run();
  assert.equal(transport.calls.length, readsBefore);
});

test('known reference omitted from listing is availability/integrity checked and absence never emits DELETE', async () => {
  const repository = fixture();
  const transport = transportFor(repository);
  const pin = repository.captureBinding();
  const reference = transport.put(pin, segment(1, [operation(1)]));
  const runner = new SyncRunner(repository, transport);
  assert.equal(await runner.run(), 'Synced');
  transport.setVisibleAt(pin, reference, 100);
  const readsBefore = transport.calls.filter(value => value.method === 'read').length;
  assert.equal(await runner.run(), 'Synced');
  assert.equal(transport.calls.filter(value => value.method === 'read').length, readsBefore + 1);
  const before = repository.materialized();
  transport.setObjectAvailable(pin, reference, false);
  assert.equal(await runner.run(), 'Recovery required');
  assert.deepEqual(repository.materialized(), before);
  assert.equal(Object.values(repository.snapshot().operations).some(value => value.operation === 'DELETE'), false);
});

test('new locator claiming existing segment identity requires immutable byte verification', async () => {
  const repository = fixture();
  const transport = transportFor(repository);
  const pin = repository.captureBinding();
  const original = segment(1, [operation(1)]);
  transport.put(pin, original);
  const runner = new SyncRunner(repository, transport);
  assert.equal(await runner.run(), 'Synced');
  transport.put(pin, encodeUtf8(`${new TextDecoder().decode(original)}\n`));
  assert.equal(await runner.run(), 'Recovery required');
  assert.equal(repository.materialized().entities.length, 1);
});

for (const invalid of ['malformed', 'unsupported', 'identity-conflict']) {
  test(`${invalid} segment is rejected atomically, retained unresolved, and blocks false healthy state`, async () => {
    const repository = fixture();
    const transport = transportFor(repository);
    const pin = repository.captureBinding();
    const original = operation(1);
    repository.receive(pin, 'known', segment(1, [original]));
    transport.put(pin, segment(1, [original]), { reference: 'known' });
    let value;
    if (invalid === 'malformed') value = { ...operation(3), payload: { ...operation(3).payload, focusDurationMs: 0 } };
    else if (invalid === 'unsupported') value = { ...operation(3), schemaVersion: 2 };
    else value = { ...original, payload: { ...original.payload, description: 'same ID different value' } };
    transport.put(pin, segment(2, [operation(2, { entity: id(502) }), value]));
    const before = repository.materialized();
    const status = await new SyncRunner(repository, transport).run();
    assert.equal(status, invalid === 'unsupported' ? 'Unsupported data / Upgrade required' : 'Recovery required');
    assert.deepEqual(repository.materialized(), before);
    assert.equal(Object.keys(repository.snapshot().operations).length, 1);
    const bad = repository.snapshot().discoveries[1].artifacts['artifact-1'];
    assert.equal(bad.state, 'quarantined');
    assert.ok(bad.rejectedBytes instanceof Uint8Array);
    assert.equal(repository.snapshot().discoveries[1].reconciled, false);
  });
}

test('bound descriptor alteration and inaccessible root stop automatic publication while local commands remain usable', async () => {
  for (const damage of ['descriptor', 'root']) {
    const repository = fixture();
    add(repository);
    const transport = transportFor(repository);
    const pin = repository.captureBinding();
    if (damage === 'descriptor') transport.replaceDescriptor(pin, encodeUtf8(JSON.stringify({ ...descriptor, datasetId: id(999) })));
    else transport.setDatasetAvailable(pin, false);
    assert.equal(await new SyncRunner(repository, transport).run(), 'Recovery required');
    add(repository, 2);
    assert.equal(Object.keys(repository.snapshot().outbox).length, 2);
    assert.equal(transport.calls.filter(value => value.method === 'publish').length, 0);
  }
});

test('authorization and retryable failures preserve local outbox and report truthful distinct status', async () => {
  const repository = fixture();
  add(repository);
  const transport = transportFor(repository);
  const runner = new SyncRunner(repository, transport);
  transport.queue('readDescriptor', { type: 'error', code: 'authorization' });
  assert.equal(await runner.run(), 'Authorization required');
  assert.equal(Object.keys(repository.snapshot().outbox).length, 1);
  transport.queue('readDescriptor', { type: 'error', code: 'retryable' });
  assert.equal(await runner.run(), 'Offline / Retry pending');
  assert.equal(await runner.run(), 'Synced');
  add(repository, 2);
  assert.equal(repository.status(), 'Changes saved locally / Pending');
});

test('independent replicas converge under offline edits/deletes, reversed duplicate delivery and retries', async () => {
  const first = fixture({ writer: id(2), seed: 100000 });
  const second = fixture({ writer: id(3), seed: 200000 });
  const transport = transportFor(first, { pageSize: 2, order: 'reverse', duplicateDelivery: 2, duplicatePublications: true });
  add(first, 1, 'original');
  await new SyncRunner(first, transport).run();
  await new SyncRunner(second, transport).run();
  const entityId = id(10001);
  first.edit({ entityId, baseOpId: first.entityVersion(entityId), expectedBindingGeneration: 1, opId: id(80000),
    payload: { ...first.snapshot().entities[entityId], description: 'offline first edit' } });
  second.delete({ entityId, baseOpId: second.entityVersion(entityId), expectedBindingGeneration: 1, opId: id(80001) });
  for (let number = 2; number <= 15; number += 1) add(number % 2 ? first : second, number, `offline-${number}`);
  const secondEntityId = id(10002);
  second.edit({ entityId: secondEntityId, baseOpId: second.entityVersion(secondEntityId), expectedBindingGeneration: 1, opId: id(80002),
    payload: { ...second.snapshot().entities[secondEntityId], description: 'offline second edit' } });
  const firstDeletedId = id(10003);
  first.delete({ entityId: firstDeletedId, baseOpId: first.entityVersion(firstDeletedId), expectedBindingGeneration: 1, opId: id(80003) });
  transport.queue('publish', { type: 'response-lost' });
  await new SyncRunner(second, transport).run();
  await new SyncRunner(first, transport).run();
  await new SyncRunner(second, transport).run();
  await new SyncRunner(first, transport).run();
  await new SyncRunner(second, transport).run();
  assert.deepEqual(first.materialized(), second.materialized());
  assert.deepEqual(first.materialized().tombstones, [entityId, firstDeletedId]);
  assert.equal(first.materialized().entities.length, 13);
  assert.equal(first.snapshot().highWater, second.snapshot().highWater);
  assert.equal(Object.keys(first.snapshot().operations).length, Object.keys(second.snapshot().operations).length);
  assert.deepEqual(first.snapshot().operations, second.snapshot().operations);
  assert.equal(first.status(), 'Synced');
  assert.equal(second.status(), 'Synced');
});

test('thousands of year-offline operations replay with retained tombstones and losing history', async () => {
  const first = fixture({ seed: 100000 });
  const second = fixture({ writer: id(4), seed: 200000 });
  const transport = transportFor(first, { pageSize: 2, order: 'reverse' });
  const pin = first.captureBinding();
  const all = [];
  for (let number = 1; number <= 2000; number += 1) {
    all.push(operation(number, { entity: id(1000000 + number), counter: number }));
    if (number % 10 === 0) all.push(operation(10000 + number, { entity: id(1000000 + number), counter: 1, kind: 'DELETE' }));
  }
  for (let index = 0; index < all.length; index += 500) transport.put(pin, segment(index + 1, all.slice(index, index + 500)));
  assert.equal(await new SyncRunner(first, transport).run(), 'Synced');
  assert.equal(await new SyncRunner(second, transport).run(), 'Synced');
  assert.deepEqual(first.materialized(), second.materialized());
  assert.equal(first.materialized().entities.length, 1800);
  assert.equal(first.materialized().tombstones.length, 200);
  assert.equal(Object.keys(first.snapshot().operations).length, 2200);
  assert.equal(first.snapshot().highWater, 2000);
});
