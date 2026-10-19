import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { encodeUtf8, MAX_COUNTER } from '../src/protocol/index.js';
import { LocalRepository } from '../src/web/repository';
import { pin, type Descriptor, type Operation } from '../src/web/model';
import type { BootstrapIntent } from '../src/web/remote-repository';
import { SyncRunner } from '../src/web/sync-runner';
import { AsyncAdversarialTransport } from '../test-support/async-transport';
import { rawSnapshot, stamp } from '../e2e/fixtures/legacy';

const repositories: LocalRepository[] = [];
const id = (n: number) => `84000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const descriptor = (datasetId = id(1)): Descriptor => ({ application: 'focus-timer', protocolVersion: 1, datasetId });
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });
async function open(name: string = crypto.randomUUID(), ids?: () => string) {
  const repository = await LocalRepository.open(name, ids); repositories.push(repository);
  await repository.initialize(); return repository;
}
async function finish(repository: LocalRepository, description = 'Source session') {
  let { active } = await repository.acquireOwner(crypto.randomUUID());
  active = await repository.saveActive(pin(active), { ...active, id: crypto.randomUUID(), state: 'paused', startedAt: stamp, focusMs: 123 });
  const session = await repository.finish(pin(active), 123, stamp, description);
  return (await repository.syncState()).operations.find(value => value.entityId === session.id)!;
}
function operation(datasetId: string, entityId: string, n: number, kind: 'UPSERT' | 'DELETE' = 'UPSERT'): Operation {
  return { protocolVersion: 1, schemaVersion: 1, datasetId, deviceId: id(2), opId: id(100 + n),
    entityType: 'focusSession', entityId, operation: kind, lamportCounter: n,
    ...(kind === 'UPSERT' ? { payload: { id: entityId, startedAt: stamp, endedAt: stamp,
      focusDurationMs: 987, description: 'Target session' } } : {}) };
}
function wire(datasetId: string, n: number, operations: Operation[]) {
  return encodeUtf8(JSON.stringify({ protocolVersion: 1, datasetId, deviceId: id(2), segmentId: id(1000 + n), operations }));
}
async function intent(repository: LocalRepository, locator = 'root-a') {
  const { collection } = await repository.view();
  return { version: 1, account: 'account-a', locator, descriptor: collection.descriptor,
    descriptorBytes: encodeUtf8(JSON.stringify(collection.descriptor)) } as BootstrapIntent;
}
async function joinFixture(repository: LocalRepository, targetDescriptor = descriptor()) {
  const source = await repository.view();
  const state = await repository.remote().bindingState();
  const input = { provider: 'google-drive', account: 'account-a', locator: 'target-root', descriptor: targetDescriptor,
    expectedSourceDatasetId: source.collection.descriptor.datasetId, expectedGeneration: state.bindingGeneration };
  const transport = new AsyncAdversarialTransport({ pageSize: 1 });
  transport.createDataset(input, targetDescriptor);
  return { input, transport, stage: await repository.stageJoin(input) };
}
const hydrate = (stage: Awaited<ReturnType<LocalRepository['stageJoin']>>, transport: AsyncAdversarialTransport) =>
  new SyncRunner(stage.repository, transport).run({ maxPublications: 0 });

it('two connections retain one noncredential bootstrap intent and exact bytes through reload', async () => {
  const repository = await open(); const second = await open(repository.db.name);
  const first = await intent(repository);
  const extra = { ...first, access_token: 'do-not-retain', Authorization: 'do-not-retain' };
  const results = await Promise.all([
    repository.remote().retainBootstrapIntent(extra, { expectedGeneration: 0 }),
    second.remote().retainBootstrapIntent({ ...first, locator: 'losing-allocation' }, { expectedGeneration: 0 }),
  ]);
  expect(results[0]).toEqual(results[1]);
  expect(results[0].locator).toBe('root-a');
  first.descriptorBytes.fill(0);
  const snapshot = await rawSnapshot(repository.db);
  expect(JSON.stringify(snapshot)).not.toContain('do-not-retain');
  repository.close(); second.close();
  const reopened = await open(repository.db.name);
  expect(await reopened.remote().getBootstrapIntent('account-a')).toEqual(results[0]);
  expect(await reopened.archive()).not.toHaveProperty('locator');
});

it('bootstrap refuses account changes, changed exact descriptor bytes, and stale generation or selection', async () => {
  const repository = await open(); const value = await intent(repository);
  await repository.remote().retainBootstrapIntent(value, { expectedGeneration: 0 });
  await expect(repository.remote().retainBootstrapIntent({ ...value, account: 'account-b' })).rejects.toMatchObject({ code: 'authorization' });
  await expect(repository.remote().getBootstrapIntent('account-b')).rejects.toMatchObject({ code: 'authorization' });
  await expect(repository.remote().retainBootstrapIntent({ ...value, descriptorBytes: encodeUtf8(` ${JSON.stringify(value.descriptor)}`) })).rejects.toMatchObject({ code: 'integrity' });
  await repository.remote().disconnect();
  await expect(repository.remote().retainBootstrapIntent(value, { expectedGeneration: 0 })).rejects.toMatchObject({ code: 'stale-binding' });
  await repository.newCollection();
  await expect(repository.remote().retainBootstrapIntent(value, { expectedGeneration: 0 })).rejects.toMatchObject({ code: 'dataset-mismatch' });
  expect(await repository.remote().getBootstrapIntent()).toBeNull();
});

it('bootstrap abort rolls back the chosen IDs and committed response loss retains them', async () => {
  const repository = await open(); const value = await intent(repository);
  repository.fault = (point, tx) => { if (point === 'bootstrap.intent') tx.abort(); };
  await expect(repository.remote().retainBootstrapIntent(value)).rejects.toThrow();
  repository.fault = undefined;
  expect(await repository.remote().getBootstrapIntent()).toBeNull();
  repository.fault = point => { if (point === 'after-commit') throw new Error('lost result'); };
  await expect(repository.remote().retainBootstrapIntent(value)).rejects.toThrow('lost result');
  repository.fault = undefined;
  expect(await repository.remote().retainBootstrapIntent({ ...value, locator: 'unused-ids' })).toEqual(value);
});

it('disconnected retained binding exposes the current generation and preserves unknown publication handles', async () => {
  const repository = await open(); const { collection } = await repository.view();
  const binding = await repository.remote().bind({ provider: 'google-drive', account: 'account-a', locator: 'root-a', descriptor: collection.descriptor });
  await finish(repository);
  const reserved = await repository.remote().reserve(binding);
  const sealed = await repository.remote().seal(binding, reserved!.segmentId);
  await repository.remote().retainRetryHandle(binding, sealed.segmentId, 'allocated-drive-id');
  await repository.remote().beginAttempt(binding, sealed.segmentId);
  await repository.remote().unknown(binding, sealed.segmentId);
  await repository.remote().disconnect();
  const state = await repository.remote().bindingState();
  expect(state).toMatchObject({ binding: null, lastBinding: binding, bindingGeneration: binding.generation + 1 });
  await expect(repository.remote().bind({ ...binding, descriptor: collection.descriptor,
    expectedGeneration: binding.generation, resumePublications: true })).rejects.toMatchObject({ code: 'stale-binding' });
  const rebound = await repository.remote().bind({ ...binding, descriptor: collection.descriptor,
    expectedGeneration: state.bindingGeneration, resumePublications: true });
  const [publication] = await repository.remote().publications(rebound);
  expect(publication).toMatchObject({ state: 'unknown', retryHandle: 'allocated-drive-id', operationIds: sealed.operationIds });
  expect(publication.bytes).toEqual(sealed.bytes);
});

it('a staged join hydrates while source commands remain usable and publishes no provisional source operations', async () => {
  const repository = await open(); const source = await finish(repository);
  const before = await repository.syncState();
  const f = await joinFixture(repository);
  const targetOperation = operation(f.input.descriptor.datasetId, id(50), 50);
  f.transport.put(f.input, wire(f.input.descriptor.datasetId, 1, [targetOperation]));
  expect(await hydrate(f.stage, f.transport)).toBe('Synced');
  expect((await repository.view()).collection.descriptor.datasetId).toBe(source.datasetId);
  expect(await repository.syncState()).toEqual(before);
  expect((await f.stage.repository.snapshot()).operations).toEqual({ [targetOperation.opId]: targetOperation });
  await expect(f.stage.repository.reserve(f.stage.binding)).rejects.toMatchObject({ code: 'join-not-complete' });
  expect(f.transport.calls.some(value => value.method === 'preparePublication' || value.method === 'publish')).toBe(false);
  expect(await repository.pendingJoin()).toMatchObject({ id: f.stage.plan.id, hydration: { reconciled: true } });
});

it('adoption uses fresh source edits/completions, preserves target winners/tombstones, and never transplants source deletes', async () => {
  const repository = await open();
  const edited = await finish(repository, 'Before edit');
  const deleted = await finish(repository, 'Deleted while hydrating');
  const targetWins = await finish(repository, 'Local conflict');
  const targetDeleted = await finish(repository, 'Target already deleted');
  const f = await joinFixture(repository);
  const remoteWinner = operation(f.input.descriptor.datasetId, targetWins.entityId, 91);
  const remoteDelete = operation(f.input.descriptor.datasetId, targetDeleted.entityId, 92, 'DELETE');
  f.transport.put(f.input, wire(f.input.descriptor.datasetId, 1, [remoteWinner, remoteDelete]));
  await hydrate(f.stage, f.transport);
  await repository.edit(edited.datasetId, edited.opId, { ...edited.payload!, description: 'After edit' });
  await repository.delete(deleted.datasetId, deleted.entityId, deleted.opId);
  const late = await finish(repository, 'Finished after hydration');
  const source = await repository.syncState();
  const view = await repository.commitJoin(f.stage.plan.id);
  const target = await repository.syncState();
  expect(view.history.map(value => value.winner.payload!.description).sort()).toEqual(['After edit', 'Finished after hydration', 'Target session']);
  const adopted = target.operations.filter(value => value.deviceId === source.writerId);
  expect(adopted.map(value => value.entityId).sort()).toEqual([edited.entityId, late.entityId].sort());
  expect(adopted.every(value => value.lamportCounter > remoteDelete.lamportCounter && value.datasetId === f.input.descriptor.datasetId)).toBe(true);
  expect(target.operations).toContainEqual(remoteWinner);
  expect(target.operations).toContainEqual(remoteDelete);
  expect(target.operations.some(value => value.entityId === deleted.entityId)).toBe(false);
  expect(await repository.archiveCollection(source.descriptor.datasetId)).toMatchObject({ dataset: source.descriptor, unsegmentedOperations: source.operations });
  expect(await repository.retainedCollections()).toContainEqual({ descriptor: source.descriptor });
  expect(await repository.pendingJoin()).toBeNull();
  await repository.initialize();
});

it('idle cutover catches a source finish after hydration and fences old timer/editor commands', async () => {
  const repository = await open(); const source = await finish(repository);
  let { active } = await repository.acquireOwner(crypto.randomUUID());
  active = await repository.saveActive(pin(active), { ...active, id: crypto.randomUUID(), state: 'paused', startedAt: stamp, focusMs: 45 });
  const f = await joinFixture(repository); await hydrate(f.stage, f.transport);
  await expect(repository.commitJoin(f.stage.plan.id)).rejects.toMatchObject({ code: 'active-not-idle' });
  const session = await repository.finish(pin(active), 45, stamp, 'Late finish');
  const oldIdle = (await repository.view()).active;
  const view = await repository.commitJoin(f.stage.plan.id);
  expect(view.history.some(value => value.id === session.id)).toBe(true);
  expect(view.active.owner).toEqual(oldIdle.owner);
  expect(view.active.revision).toBeGreaterThan(oldIdle.revision);
  await expect(repository.saveActive(pin(oldIdle), oldIdle)).rejects.toMatchObject({ code: 'stale-active' });
  await expect(repository.edit(source.datasetId, source.opId, source.payload!)).rejects.toMatchObject({ code: 'stale-editor' });
  await expect(f.stage.repository.assertPin(f.stage.binding)).rejects.toMatchObject({ code: 'stale-join' });
});

it('join resumes a durable pagination checkpoint after reload before atomic adoption', async () => {
  const repository = await open(); await finish(repository);
  const f = await joinFixture(repository);
  for (let n = 1; n <= 2; n++) f.transport.put(f.input, wire(f.input.descriptor.datasetId, n, [operation(f.input.descriptor.datasetId, id(50 + n), n)]));
  await new SyncRunner(f.stage.repository, f.transport).run({ maxPages: 1, maxPublications: 0 });
  expect((await repository.pendingJoin())?.hydration).toMatchObject({ passId: 1, enumerationComplete: false });
  const checkpoint = Object.values((await f.stage.repository.snapshot()).discoveries)[0].checkpoint;
  repository.close();
  const reopened = await open(repository.db.name);
  const resumed = await reopened.stageJoin(f.input);
  expect(resumed.plan.id).toBe(f.stage.plan.id);
  expect(resumed.binding).toEqual(f.stage.binding);
  await hydrate(resumed, f.transport);
  expect(f.transport.calls.filter(value => value.method === 'enumerate').at(-1)?.continuation).toEqual(checkpoint);
  expect((await reopened.commitJoin(resumed.plan.id)).history).toHaveLength(3);
});

it('concurrent local join staging shares one durable plan and target binding', async () => {
  const repository = await open();
  const source = await repository.view();
  const input = { provider: 'google-drive', account: 'account-a', locator: 'target-root', descriptor: descriptor(),
    expectedSourceDatasetId: source.collection.descriptor.datasetId, expectedGeneration: 0 };
  const second = await open(repository.db.name);
  const [left, right] = await Promise.all([repository.stageJoin(input), second.stageJoin(input)]);
  expect(left.plan.id).toBe(right.plan.id);
  expect(left.binding).toEqual(right.binding);
  expect((await repository.view()).collection.descriptor.datasetId).toBe(input.expectedSourceDatasetId);
});

it.each(['join.operations', 'join.cutover', 'before-commit'])('join failure at %s retains the source and rolls back all adoption operations', async point => {
  const repository = await open(); await finish(repository);
  const f = await joinFixture(repository); await hydrate(f.stage, f.transport);
  const before = await rawSnapshot(repository.db);
  repository.fault = (at, tx) => { if (at === point) tx.abort(); };
  await expect(repository.commitJoin(f.stage.plan.id)).rejects.toThrow();
  repository.fault = undefined;
  expect(await rawSnapshot(repository.db)).toEqual(before);
  expect((await repository.commitJoin(f.stage.plan.id)).history).toHaveLength(1);
  const completed = await rawSnapshot(repository.db);
  await repository.commitJoin(f.stage.plan.id);
  expect(await rawSnapshot(repository.db)).toEqual(completed);
});

it('lost committed join response is idempotent after reload', async () => {
  const repository = await open(); await finish(repository);
  const f = await joinFixture(repository); await hydrate(f.stage, f.transport);
  repository.fault = point => { if (point === 'after-commit') throw new Error('cutover result lost'); };
  await expect(repository.commitJoin(f.stage.plan.id)).rejects.toThrow('cutover result lost');
  repository.fault = undefined;
  const before = await rawSnapshot(repository.db); repository.close();
  const reopened = await open(repository.db.name);
  await reopened.commitJoin(f.stage.plan.id);
  expect(await rawSnapshot(reopened.db)).toEqual(before);
  expect((await reopened.syncState()).operations).toHaveLength(1);
});

it('incomplete hydration, cancellation, selected-source changes and source generation changes cannot cut over', async () => {
  const repository = await open(); const f = await joinFixture(repository);
  await expect(repository.commitJoin(f.stage.plan.id)).rejects.toMatchObject({ code: 'join-incomplete' });
  await repository.cancelJoin(f.stage.plan.id);
  await expect(f.stage.repository.assertPin(f.stage.binding)).rejects.toMatchObject({ code: 'stale-join' });
  const resumed = await repository.stageJoin(f.input); await hydrate(resumed, f.transport);
  await repository.remote().disconnect();
  await expect(repository.commitJoin(resumed.plan.id)).rejects.toMatchObject({ code: 'stale-binding' });
  await expect(resumed.repository.assertPin(resumed.binding)).rejects.toMatchObject({ code: 'stale-join' });
  await repository.newCollection();
  await expect(repository.commitJoin(resumed.plan.id)).rejects.toMatchObject({ code: 'stale-join' });
});

it('exhausted target clock aborts adoption without losing source work', async () => {
  const repository = await open(); await finish(repository);
  const f = await joinFixture(repository);
  f.transport.put(f.input, wire(f.input.descriptor.datasetId, 1, [{ ...operation(f.input.descriptor.datasetId, id(60), 1), lamportCounter: MAX_COUNTER }]));
  await hydrate(f.stage, f.transport);
  const before = await rawSnapshot(repository.db);
  await expect(repository.commitJoin(f.stage.plan.id)).rejects.toThrow();
  expect(await rawSnapshot(repository.db)).toEqual(before);
  expect((await repository.view()).history).toHaveLength(1);
});
