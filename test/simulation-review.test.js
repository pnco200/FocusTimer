import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeUtf8, MAX_COUNTER, parseSegment } from '../src/protocol/index.js';
import { AdversarialTransport, InjectedFailure, MemoryStore, SyncRunner, TransactionalRepository } from '../src/simulation/index.js';

const id = n => `90000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const descriptor = { application: 'focus-timer', protocolVersion: 1, datasetId: id(1) };
const date = '2026-10-17T15:00:00.000Z';
const wire = value => encodeUtf8(JSON.stringify(value));
const upsert = (n, { entityId = id(n + 500), counter = n, description = `record ${n}` } = {}) => ({
  protocolVersion: 1, schemaVersion: 1, opId: id(n), datasetId: descriptor.datasetId,
  deviceId: id(3), entityType: 'focusSession', entityId, operation: 'UPSERT', lamportCounter: counter,
  payload: { id: entityId, startedAt: date, endedAt: date, focusDurationMs: 1, description },
});
const segment = (n, operations) => wire({ protocolVersion: 1, datasetId: descriptor.datasetId,
  deviceId: id(3), segmentId: id(n), operations });

function fixture(options = {}) {
  let next = 10_000;
  const ids = () => id(next++);
  const store = new MemoryStore();
  const repository = new TransactionalRepository({ store, descriptor, writerId: id(2), ids });
  const transport = new AdversarialTransport(options);
  const target = { account: 'review-account', locator: 'review-root', datasetId: descriptor.datasetId };
  transport.createDataset(target, descriptor);
  const pin = repository.bind({ ...target, descriptor });
  return { repository, store, transport, target, pin, ids,
    reopen: () => new TransactionalRepository({ store, ids }) };
}

function start(repository, n, extra = {}) {
  const state = repository.snapshot();
  if (!state.owner) repository.acquireOwner('review-owner');
  const current = repository.snapshot();
  return repository.startActive({ activeId: id(n), startedAt: date, focusDurationMs: 100,
    expectedBindingGeneration: current.bindingGeneration, ownerToken: current.owner.token,
    ownerGeneration: current.owner.generation, ...extra });
}

function finishCommand(repository, n, extra = {}) {
  const state = repository.snapshot();
  return { commandId: `review-command-${n}`, activeId: state.active.id,
    expectedRevision: state.active.revision, expectedBindingGeneration: state.bindingGeneration,
    ownerToken: state.owner.token, ownerGeneration: state.owner.generation,
    entityId: id(n + 1000), opId: id(n + 2000), endedAt: date, ...extra };
}

function complete(repository, n, extra = {}) {
  start(repository, n);
  return repository.finish(finishCommand(repository, n, extra));
}

test('review: a new completion must reject a reused live or terminal entity identity atomically', () => {
  for (const deleted of [false, true]) {
    const { repository } = fixture();
    const first = complete(repository, 10);
    if (deleted) repository.delete({ entityId: first.entityId, baseOpId: first.opId, expectedBindingGeneration: 1, opId: id(99) });
    start(repository, 11);
    const before = repository.snapshot();
    assert.throws(() => repository.finish(finishCommand(repository, 11, { entityId: first.entityId })));
    assert.deepEqual(repository.snapshot(), before);
  }
});

test('review: consumed active identities cannot be reused to obtain an unrelated old completion receipt', () => {
  const { repository } = fixture();
  complete(repository, 10);
  const before = repository.snapshot();
  assert.throws(() => start(repository, 10));
  assert.deepEqual(repository.snapshot(), before);
});

test('review: reused command receipt cannot consume a different active session', () => {
  const { repository } = fixture();
  complete(repository, 10);
  start(repository, 11);
  const before = repository.snapshot();
  assert.throws(() => repository.finish(finishCommand(repository, 11, { commandId: 'review-command-10' })), error => error.code === 'stale-command');
  assert.deepEqual(repository.snapshot(), before);
});

test('review: null active-description checkpoint cannot bypass validation and become durable', () => {
  const { repository } = fixture();
  start(repository, 10, { description: 'retained draft' });
  const state = repository.snapshot();
  assert.throws(() => repository.checkpointActive({ activeId: state.active.id,
    expectedRevision: state.active.revision, expectedBindingGeneration: state.bindingGeneration,
    ownerToken: state.owner.token, ownerGeneration: state.owner.generation,
    focusDurationMs: 100, description: null }));
  assert.deepEqual(repository.snapshot(), state);
});

test('review: opaque prototype-looking discovery references are durable own keys without prototype pollution', () => {
  const { repository, pin } = fixture();
  const pass = repository.beginPass(pin);
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  try {
    repository.recordPage(pin, pass.passId, { references: ['__proto__', 'constructor', 'toString'], complete: true, continuation: null });
    const artifacts = repository.snapshot().discoveries[pin.generation].artifacts;
    for (const reference of ['__proto__', 'constructor', 'toString']) {
      assert.equal(Object.hasOwn(artifacts, reference), true);
      assert.equal(artifacts[reference].state, 'pending');
    }
    assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
  } finally {
    for (const key of Reflect.ownKeys(Object.prototype)) if (!Object.hasOwn(before, key)) delete Object.prototype[key];
    for (const key of ['state', 'error']) {
      if (Object.hasOwn(Object, key)) delete Object[key];
      if (Object.hasOwn(Object.prototype.toString, key)) delete Object.prototype.toString[key];
    }
  }
});

test('review: stale in-flight success cannot acknowledge after disconnect; deliberate original-target resume keeps exact bytes', async () => {
  const { repository, transport, target, pin } = fixture();
  const first = complete(repository, 10);
  const hold = transport.holdNext('publish');
  const running = new SyncRunner(repository, transport).run();
  await hold.entered;
  const oldPublication = Object.values(repository.snapshot().publications)[0];
  const nextTarget = { account: 'different-account', locator: 'different-root', datasetId: descriptor.datasetId };
  transport.createDataset(nextTarget, descriptor);
  repository.disconnect();
  assert.throws(() => repository.bind({ ...nextTarget, descriptor }), error => error.code === 'pending-publication-rebind-required');
  const second = complete(repository, 11);
  hold.release();
  await running;
  const state = repository.snapshot();
  assert.ok(state.outbox[first.opId]);
  assert.ok(state.outbox[second.opId]);
  assert.notEqual(state.publications[oldPublication.segmentId].state, 'acknowledged');
  assert.equal(transport.references(target).length, 1);
  assert.equal(transport.references(nextTarget).length, 0);
  assert.ok(transport.calls.filter(call => call.method === 'publish').every(call => call.target.account === target.account));
  assert.notEqual(repository.status(), 'Synced');
  const resumed = repository.bind({ ...target, descriptor, resumePublications: true });
  assert.notEqual(resumed.generation, pin.generation);
  assert.throws(() => repository.acknowledge(pin, oldPublication.segmentId), error => error.code === 'stale-binding');
  await new SyncRunner(repository, transport).run({ maxPublications: 1 });
  const afterResume = repository.snapshot();
  assert.equal(afterResume.publications[oldPublication.segmentId].state, 'acknowledged');
  assert.deepEqual(afterResume.publications[oldPublication.segmentId].bytes, oldPublication.bytes);
  assert.equal(afterResume.outbox[first.opId], undefined);
  assert.ok(afterResume.outbox[second.opId]);
  const attempts = transport.calls.filter(call => call.method === 'publish');
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].segmentId, attempts[1].segmentId);
  assert.deepEqual(attempts[0].bytes, attempts[1].bytes);
  assert.equal(transport.references(nextTarget).length, 0);
});

test('review: two reserved publications and a new operation retain exact acknowledgement membership', () => {
  const { repository, pin, reopen } = fixture();
  const one = complete(repository, 10);
  const two = complete(repository, 11);
  const otherWorker = reopen();
  const a = repository.seal(pin, repository.reserve(pin, { maxOperations: 1 }).segmentId);
  const b = otherWorker.seal(pin, otherWorker.reserve(pin, { maxOperations: 1 }).segmentId);
  const three = complete(repository, 12);
  repository.beginAttempt(pin, a.segmentId);
  const beforeInvalidConfirmation = repository.snapshot();
  assert.throws(() => repository.confirm(pin, a.segmentId, { outcome: 'confirmed', segmentId: a.segmentId, bytes: b.bytes }), error => error.classification === 'integrity');
  assert.deepEqual(repository.snapshot(), beforeInvalidConfirmation);
  repository.confirm(pin, a.segmentId, { outcome: 'confirmed', segmentId: a.segmentId, bytes: a.bytes });
  repository.acknowledge(pin, a.segmentId);
  repository.acknowledge(pin, a.segmentId);
  const remaining = Object.keys(repository.snapshot().outbox);
  assert.equal(remaining.length, 2);
  assert.ok(remaining.includes(three.opId));
  assert.ok(remaining.includes(b.operationIds[0]));
  assert.ok(!remaining.includes(a.operationIds[0]));
  assert.deepEqual(new Set([...a.operationIds, ...b.operationIds]), new Set([one.opId, two.opId]));
});

test('review: concurrent prevalidated receivers recheck immutable op content against transactional state', () => {
  const { repository, pin, reopen } = fixture();
  const a = segment(100, [upsert(20, { description: 'winner by first durable acceptance only for conflict detection' })]);
  const b = segment(101, [upsert(20, { description: 'conflicting immutable content' })]);
  parseSegment(a);
  parseSegment(b); // Both structural validations happen before either durable acceptance.
  const otherWorker = reopen();
  repository.receive(pin, 'a', a);
  const accepted = repository.snapshot();
  assert.throws(() => otherWorker.receive(pin, 'b', b), error => error.classification === 'integrity');
  assert.deepEqual(repository.snapshot(), accepted);
});

test('review: changing a known immutable artifact to malformed or unsupported bytes is an integrity fault', async () => {
  for (const replacement of [encodeUtf8('{'), wire({ ...JSON.parse(new TextDecoder().decode(segment(100, [upsert(20)]))), protocolVersion: 2 })]) {
    const { repository, transport, target } = fixture();
    const reference = transport.put(target, segment(100, [upsert(20)]));
    await new SyncRunner(repository, transport).run();
    assert.equal(repository.status(), 'Synced');
    const before = repository.snapshot();
    transport.replace(target, reference, replacement);
    await new SyncRunner(repository, transport).run();
    const after = repository.snapshot();
    assert.equal(after.blocked.classification, 'integrity');
    assert.deepEqual(after.operations, before.operations);
    assert.deepEqual(after.entities, before.entities);
    assert.deepEqual(after.segments, before.segments);
    assert.notEqual(repository.status(), 'Synced');
  }
});

test('review: malformed or unsupported inbound data blocks automatic publication while local commands stay durable', async () => {
  for (const raw of [encodeUtf8('{'), wire({ ...JSON.parse(new TextDecoder().decode(segment(100, [upsert(20)]))), future: true })]) {
    const { repository, transport, target } = fixture();
    const first = complete(repository, 10);
    transport.put(target, raw);
    await new SyncRunner(repository, transport).run();
    assert.ok(repository.snapshot().blocked);
    assert.ok(repository.snapshot().outbox[first.opId]);
    const second = complete(repository, 11);
    assert.ok(repository.snapshot().outbox[second.opId]);
    await new SyncRunner(repository, transport).run();
    assert.equal(transport.calls.filter(call => call.method === 'publish').length, 0);
    assert.equal(Object.keys(repository.snapshot().operations).length, 2);
    assert.notEqual(repository.status(), 'Synced');
  }
});

test('review: receive failure at every persistence boundary is all-or-nothing after reopening', () => {
  const points = ['begin', 'identities', 'operations', 'projection', 'highWater', 'dedup', 'applied', 'beforeCommit', 'afterCommit'];
  for (const point of points) {
    const { repository, store, pin, reopen } = fixture();
    const pass = repository.beginPass(pin);
    repository.recordPage(pin, pass.passId, { references: ['inbound'], complete: true, continuation: null });
    const before = repository.snapshot();
    store.failNext(`receive.${point}`);
    assert.throws(() => repository.receive(pin, 'inbound', segment(100, [upsert(20), upsert(21)])), InjectedFailure);
    const after = reopen().snapshot();
    if (point === 'afterCommit') {
      assert.equal(Object.keys(after.operations).length, 2);
      assert.equal(Object.keys(after.entities).length, 2);
      assert.equal(after.highWater, 21);
      assert.equal(after.discoveries[pin.generation].artifacts.inbound.state, 'applied');
      assert.ok(after.segments[id(100)]);
    } else assert.deepEqual(after, before);
  }
});

test('review: crash after durable pending/cursor checkpoint resumes the undispatched download and remaining pages', async () => {
  const { repository, store, transport, target, pin, reopen } = fixture({ pageSize: 1 });
  transport.put(target, segment(100, [upsert(20)]), { reference: 'first' });
  transport.put(target, segment(101, [upsert(21)]), { reference: 'second' });
  store.failNext('discover.afterCommit');
  await assert.rejects(new SyncRunner(repository, transport).run(), InjectedFailure);
  const crashed = repository.snapshot();
  assert.equal(Object.keys(crashed.operations).length, 0);
  assert.equal(crashed.discoveries[pin.generation].artifacts.first.state, 'pending');
  assert.ok(crashed.discoveries[pin.generation].checkpoint);
  const recovered = reopen();
  await new SyncRunner(recovered, transport).run();
  assert.equal(recovered.status(), 'Synced');
  assert.equal(recovered.materialized().entities.length, 2);
});

test('review: exhausted dataset cannot partially complete or clear its active session', () => {
  const { repository, pin } = fixture();
  repository.receive(pin, 'maximum', segment(100, [upsert(20, { counter: MAX_COUNTER })]));
  start(repository, 10);
  const before = repository.snapshot();
  assert.throws(() => repository.finish(finishCommand(repository, 10)), error => error.code === 'counter-exhausted');
  assert.deepEqual(repository.snapshot(), before);
  assert.equal(repository.status(), 'Recovery required');
});

test('review: recovery Finish requires exhausted source and deliberate different local destination', () => {
  const recoveryDescriptor = { ...descriptor, datasetId: id(7000) };
  for (const scenario of ['not-exhausted', 'not-deliberate', 'same-dataset']) {
    const { repository, pin } = fixture();
    if (scenario !== 'not-exhausted') repository.receive(pin, 'maximum', segment(100, [upsert(20, { counter: MAX_COUNTER })]));
    start(repository, 10);
    const before = repository.snapshot();
    const command = finishCommand(repository, 10);
    assert.throws(() => repository.finishToRecovery(command, {
      descriptor: scenario === 'same-dataset' ? descriptor : recoveryDescriptor,
      deliberateDestination: scenario !== 'not-deliberate',
    }));
    assert.deepEqual(repository.snapshot(), before);
  }
});

test('review: recovery completion is atomic across source consumption, receipt, new collection, operation, clock, and outbox', () => {
  const recoveryDescriptor = { ...descriptor, datasetId: id(7000) };
  for (const point of ['begin', 'collection', 'operation', 'projection', 'highWater', 'outbox', 'domain', 'completion', 'beforeCommit', 'afterCommit']) {
    const { repository, store, pin, reopen } = fixture();
    repository.receive(pin, 'maximum', segment(100, [upsert(20, { counter: MAX_COUNTER })]));
    start(repository, 10, { description: 'recovery completion' });
    const before = repository.snapshot();
    const command = finishCommand(repository, 10);
    store.failNext(`recoveryFinish.${point}`);
    assert.throws(() => repository.finishToRecovery(command, { descriptor: recoveryDescriptor, deliberateDestination: true }), InjectedFailure);
    const restored = reopen();
    const after = restored.snapshot();
    if (point !== 'afterCommit') { assert.deepEqual(after, before); continue; }
    assert.equal(after.active, null);
    assert.deepEqual(after.operations, before.operations);
    assert.deepEqual(after.entities, before.entities);
    assert.deepEqual(after.tombstones, before.tombstones);
    assert.deepEqual(after.outbox, before.outbox);
    assert.deepEqual(after.binding, before.binding);
    assert.equal(after.highWater, MAX_COUNTER);
    const recovery = restored.recoverySnapshot(recoveryDescriptor.datasetId);
    assert.equal(recovery.highWater, 1);
    assert.equal(recovery.binding, null);
    assert.equal(Object.keys(recovery.entities).length, 1);
    assert.equal(Object.keys(recovery.operations).length, 1);
    assert.equal(Object.keys(recovery.outbox).length, 1);
    const receipt = after.commandReceipts[command.commandId];
    assert.equal(receipt.datasetId, recoveryDescriptor.datasetId);
    assert.deepEqual(restored.finishToRecovery(command, { descriptor: recoveryDescriptor, deliberateDestination: true }), receipt);
    assert.deepEqual(restored.snapshot(), after);
  }
});

test('review: a temporarily unavailable transport dataset can be explicitly restored without changing its corpus', () => {
  const { transport, target } = fixture();
  const reference = transport.put(target, segment(100, [upsert(20)]));
  const original = transport.bytes(target, reference);
  transport.setDatasetAvailable(target, false);
  transport.setDatasetAvailable(target, true);
  assert.deepEqual(transport.bytes(target, reference), original);
});
