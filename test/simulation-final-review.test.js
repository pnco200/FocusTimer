import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeUtf8, MAX_COUNTER, MAX_SEGMENT_BYTES } from '../src/protocol/index.js';
import { AdversarialTransport, InjectedFailure, SyncRunner, TransactionalRepository } from '../src/simulation/index.js';

const id = n => `70000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const date = '2026-10-17T15:00:00.000Z';
const descriptor = { application: 'focus-timer', protocolVersion: 1, datasetId: id(1) };
const recoveryDescriptor = { ...descriptor, datasetId: id(2) };
const wire = value => encodeUtf8(JSON.stringify(value));

function fixture() {
  let next = 10000;
  const repository = new TransactionalRepository({ descriptor, writerId: id(3), ids: () => id(next++) });
  const target = { account: 'final-review', locator: 'original-target', datasetId: descriptor.datasetId };
  const pin = repository.bind({ ...target, descriptor });
  repository.acquireOwner('valid-owner');
  return { repository, target, pin };
}

function start(repository, n) {
  const state = repository.snapshot();
  return repository.startActive({ activeId: id(n), startedAt: date, focusDurationMs: 10,
    expectedBindingGeneration: state.bindingGeneration, ownerToken: state.owner.token, ownerGeneration: state.owner.generation });
}

function command(repository, n, extra = {}) {
  const state = repository.snapshot();
  return { commandId: `final-${n}`, activeId: state.active.id, expectedRevision: state.active.revision,
    expectedBindingGeneration: state.bindingGeneration, ownerToken: state.owner.token,
    ownerGeneration: state.owner.generation, entityId: id(n + 1000), opId: id(n + 2000), endedAt: date, ...extra };
}

function exhaust(repository, pin) {
  const entityId = id(500);
  repository.receive(pin, 'maximum', wire({ protocolVersion: 1, datasetId: descriptor.datasetId,
    deviceId: id(4), segmentId: id(501), operations: [{ protocolVersion: 1, schemaVersion: 1,
      opId: id(502), datasetId: descriptor.datasetId, deviceId: id(4), entityType: 'focusSession',
      entityId, operation: 'UPSERT', lamportCounter: MAX_COUNTER,
      payload: { id: entityId, startedAt: date, endedAt: date, focusDurationMs: 1, description: 'retained remote' },
    }] }));
}

test('final review: writer rotation applies to NEW recovery-collection completions without changing old operations', () => {
  const { repository, pin } = fixture();
  exhaust(repository, pin);
  start(repository, 10);
  const first = repository.finishToRecovery(command(repository, 10), { descriptor: recoveryDescriptor, deliberateDestination: true });
  const original = repository.recoverySnapshot(recoveryDescriptor.datasetId).operations[first.opId];
  repository.rotateWriter(id(99));
  start(repository, 11);
  const second = repository.finishToRecovery(command(repository, 11), { descriptor: recoveryDescriptor, deliberateDestination: true });
  const recovery = repository.recoverySnapshot(recoveryDescriptor.datasetId);
  assert.equal(recovery.operations[second.opId].deviceId, id(99));
  assert.deepEqual(recovery.operations[first.opId], original);
  assert.equal(recovery.highWater, 2);
  assert.equal(repository.snapshot().highWater, MAX_COUNTER);
});

test('final review: consumed-active receipt aliases cannot become a new command on another active identity', () => {
  const { repository } = fixture();
  start(repository, 10);
  const firstCommand = command(repository, 10);
  const first = repository.finish(firstCommand);
  // A new command alias for the already consumed active may return its existing
  // outcome or reject stale. If accepted, that same command ID cannot later
  // denote a different active identity and create a second completion.
  const alias = 'alias-for-consumed-active';
  let returned;
  try { returned = repository.finish({ ...firstCommand, commandId: alias }); }
  catch (error) { assert.equal(error.code, 'stale-command'); return; }
  assert.deepEqual(returned, first);
  start(repository, 11);
  const before = repository.snapshot();
  assert.throws(() => repository.finish(command(repository, 11, { commandId: alias })), error => error.code === 'stale-command');
  assert.deepEqual(repository.snapshot(), before);
});

for (const recovery of [false, true]) {
  test(`final review: ${recovery ? 'recovery' : 'ordinary'} receipt alias is atomic before and after commit and retry creates no operation`, () => {
    for (const point of ['begin', 'receipt', 'beforeCommit', 'afterCommit']) {
      const { repository, pin } = fixture();
      if (recovery) exhaust(repository, pin);
      start(repository, 10);
      const originalCommand = command(repository, 10);
      const invoke = (repo, value) => recovery
        ? repo.finishToRecovery(value, { descriptor: recoveryDescriptor, deliberateDestination: true })
        : repo.finish(value);
      const receipt = invoke(repository, originalCommand);
      const alias = { ...originalCommand, commandId: 'atomic-completion-alias' };
      const before = repository.snapshot();
      repository.store.failNext(`${recovery ? 'recoveryFinish' : 'finish'}.${point}`);
      assert.throws(() => invoke(repository, alias), InjectedFailure);
      const reopened = new TransactionalRepository({ store: repository.store });
      const after = reopened.snapshot();
      const expectedCommitted = { ...before,
        commandReceipts: { ...before.commandReceipts, [alias.commandId]: receipt } };
      assert.deepEqual(after, point === 'afterCommit' ? expectedCommitted : before);
      assert.deepEqual(invoke(reopened, alias), receipt);
      assert.deepEqual(reopened.snapshot(), expectedCommitted);
      assert.deepEqual(invoke(reopened, alias), receipt);
      assert.deepEqual(reopened.snapshot(), expectedCommitted);
    }
  });
}

test('final review: accepted recovery receipt alias cannot complete a different active identity or destination', () => {
  const { repository, pin } = fixture();
  exhaust(repository, pin);
  start(repository, 10);
  const firstCommand = command(repository, 10);
  const first = repository.finishToRecovery(firstCommand, { descriptor: recoveryDescriptor, deliberateDestination: true });
  const alias = 'recovery-completion-alias';
  assert.deepEqual(repository.finishToRecovery({ ...firstCommand, commandId: alias },
    { descriptor: recoveryDescriptor, deliberateDestination: true }), first);
  start(repository, 11);
  const before = repository.snapshot();
  const second = command(repository, 11, { commandId: alias });
  assert.throws(() => repository.finishToRecovery(second,
    { descriptor: recoveryDescriptor, deliberateDestination: true }), error => error.code === 'stale-command');
  assert.deepEqual(repository.snapshot(), before);
  assert.throws(() => repository.finishToRecovery({ ...firstCommand, commandId: alias },
    { descriptor: { ...recoveryDescriptor, datasetId: id(99) }, deliberateDestination: true }), error => error.code === 'stale-command');
  assert.deepEqual(repository.snapshot(), before);
});

test('final review: recovery cannot install an empty or nonstring execution-owner fencing token', () => {
  for (const token of ['', null, undefined, 0, {}]) {
    const { repository } = fixture();
    start(repository, 10);
    repository.setOwnerStatus('gone');
    const before = repository.snapshot();
    assert.throws(() => repository.recoverOwner(token), error => error.code === 'invalid-owner');
    assert.deepEqual(repository.snapshot(), before);
  }
});

test('final review: exact bytes without affirmative publication outcome never acknowledge membership', () => {
  for (const outcome of [undefined, null, 'unknown', 'pending', 'success', false]) {
    const { repository, pin } = fixture();
    start(repository, 10);
    repository.finish(command(repository, 10));
    const publication = repository.seal(pin, repository.reserve(pin).segmentId);
    repository.beginAttempt(pin, publication.segmentId);
    const before = repository.snapshot();
    assert.throws(() => repository.confirm(pin, publication.segmentId,
      { outcome, segmentId: publication.segmentId, bytes: publication.bytes }), error => error.code === 'unconfirmed-publication');
    assert.deepEqual(repository.snapshot(), before);
  }
});

test('final review: oversized receive/evidence remain bounded and cannot partly accept an operation', () => {
  const { repository, pin } = fixture();
  const oversized = new Uint8Array(MAX_SEGMENT_BYTES + 100);
  const before = repository.snapshot();
  assert.throws(() => repository.receive(pin, 'oversized', oversized), error => error.classification === 'malformed');
  assert.deepEqual(repository.snapshot(), before);
  repository.artifactFailure(pin, 'oversized', { classification: 'malformed', message: 'size limit' }, oversized);
  const state = repository.snapshot();
  const artifact = state.discoveries[pin.generation].artifacts.oversized;
  assert.equal(artifact.rejectedByteLength, oversized.length);
  assert.equal(artifact.rejectedBytes.length, MAX_SEGMENT_BYTES);
  assert.deepEqual(state.operations, before.operations);
  assert.deepEqual(state.entities, before.entities);
  assert.equal(state.highWater, before.highWater);
});

test('final review: known oversized remote mutation is blocked as integrity without downloading oversized evidence', async () => {
  const { repository, target, pin } = fixture();
  const transport = new AdversarialTransport();
  transport.createDataset(target, descriptor);
  start(repository, 10);
  repository.finish(command(repository, 10));
  await new SyncRunner(repository, transport).run();
  const reference = transport.references(target)[0];
  await new SyncRunner(repository, transport).run(); // Retain physical-reference bytes.
  const before = repository.snapshot();
  transport.replace(target, reference, new Uint8Array(MAX_SEGMENT_BYTES + 1));
  await new SyncRunner(repository, transport).run();
  const state = repository.snapshot();
  assert.equal(state.blocked.classification, 'integrity');
  assert.deepEqual(state.operations, before.operations);
  assert.deepEqual(state.segments, before.segments);
  const artifact = state.discoveries[pin.generation].artifacts[reference];
  assert.equal(artifact.state, 'quarantined');
  assert.ok(!artifact.rejectedBytes || artifact.rejectedBytes.length <= MAX_SEGMENT_BYTES);
});
