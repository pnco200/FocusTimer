import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { LocalRepository } from '../src/web/repository';
import { pin, type Operation } from '../src/web/model';
import { decodeUtf8, encodeUtf8 } from '../src/protocol/index.js';
import { materializeOperations } from '../src/sync/local.js';
import { rawSnapshot, stamp } from '../e2e/fixtures/legacy';

const repositories: LocalRepository[] = [];
const id = (n: number) => `95000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
afterEach(() => {
  vi.restoreAllMocks();
  for (const repository of repositories.splice(0)) repository.close();
});
async function open(name: string = crypto.randomUUID(), ids?: () => string) {
  const repository = await LocalRepository.open(name, ids);
  repositories.push(repository);
  await repository.initialize();
  return repository;
}
async function fixture() {
  const repository = await open();
  const descriptor = (await repository.view()).collection.descriptor;
  const remote = repository.remote();
  const binding = await remote.bind({ provider: 'abstract', account: 'private-account', locator: 'private-root', descriptor });
  return { repository, remote, descriptor, binding };
}
async function finish(repository: LocalRepository, description = 'Local work') {
  let { active } = await repository.acquireOwner(crypto.randomUUID());
  active = await repository.saveActive(pin(active), { ...active, state: 'paused', id: crypto.randomUUID(),
    startedAt: stamp, focusMs: 321 });
  return repository.finish(pin(active), 321, stamp, description);
}
function operation(datasetId: string, n: number, entityId = id(10), counter = n): Operation {
  return { protocolVersion: 1, schemaVersion: 1, datasetId, deviceId: id(1), opId: id(1000 + n),
    entityType: 'focusSession', entityId, operation: 'UPSERT', lamportCounter: counter,
    payload: { id: entityId, startedAt: stamp, endedAt: stamp, focusDurationMs: n + 1, description: `Version ${n}` } };
}
function wire(datasetId: string, segmentId: string, operations: Operation[], whitespace = '') {
  return encodeUtf8(`${whitespace}${JSON.stringify({ protocolVersion: 1, datasetId,
    deviceId: operations[0].deviceId, segmentId, operations })}${whitespace}`);
}
async function seal(f: Awaited<ReturnType<typeof fixture>>) {
  const reservation = await f.remote.reserve(f.binding);
  return f.remote.seal(f.binding, reservation!.segmentId);
}
async function corruptRemote(repository: LocalRepository, datasetId: string, mutate: (row: any) => void) {
  const tx = repository.db.transaction('remote', 'readwrite');
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error);
  });
  const store = tx.objectStore('remote');
  const request = store.get(datasetId);
  request.onsuccess = () => { mutate(request.result); store.put(request.result); };
  await done;
}

it('disconnecting a never-bound local history preserves pending work across reopen and later binding', async () => {
  const repository = await open(); await finish(repository);
  const local = await repository.syncState();
  await repository.remote().disconnect(); await repository.remote().disconnect();
  repository.close(); const reopened = await open(repository.db.name);
  expect(await reopened.syncState()).toEqual(local);
  expect(await reopened.remote().status()).toBe('Local only');
  const before = await reopened.remote().snapshot();
  expect(before.binding).toBeNull(); expect(before.lastBinding).toBeNull(); expect(before.bindingGeneration).toBe(2);
  const binding = await reopened.remote().bind({ account: 'first-account', locator: 'first-root', descriptor: local.descriptor, expectedGeneration: 2 });
  expect(binding.generation).toBe(3); expect(await reopened.remote().status()).toBe('Changes saved locally / Pending');
});

it('reservation captures its caller binding before native requests yield', async () => {
  const f = await fixture(); await finish(f.repository);
  const mutable = structuredClone(f.binding);
  const promise = f.remote.reserve(mutable);
  mutable.datasetId = id(999); mutable.generation += 1; mutable.account = 'changed-account';
  const publication = await promise;
  expect(publication!.datasetId).toBe(f.descriptor.datasetId);
  expect(publication!.binding).toEqual(f.binding);
  const state = await f.remote.snapshot();
  expect(Object.keys(state.publications)).toEqual([publication!.segmentId]);
  expect(state.outbox[publication!.operationIds[0]].reservation).toBe(publication!.segmentId);
});

it('receive snapshots both its pin and input bytes before the first await', async () => {
  const f = await fixture(); const op = operation(f.descriptor.datasetId, 4);
  const bytes = wire(f.descriptor.datasetId, id(40), [op]); const original = bytes.slice();
  const mutable = structuredClone(f.binding);
  const promise = f.remote.receive(mutable, 'mutable-input', bytes);
  mutable.datasetId = id(999); mutable.locator = 'changed-root'; bytes.fill(0);
  await promise;
  const state = await f.remote.snapshot();
  expect(state.operations[op.opId]).toEqual(op);
  expect(state.segments[id(40)].bytes).toEqual(original);
  expect(state.discoveries[f.binding.generation].artifacts['mutable-input'].originalBytes).toEqual(original);
});

it('confirmation snapshots exact caller bytes and coverage references before yielding', async () => {
  const f = await fixture(); await finish(f.repository); const publication = await seal(f);
  const mutable = structuredClone(f.binding);
  const confirmation = { outcome: 'confirmed', segmentId: publication.segmentId,
    bytes: publication.bytes!.slice(), references: ['original-reference'] };
  const promise = f.remote.confirm(mutable, publication.segmentId, confirmation);
  mutable.generation += 1; confirmation.bytes.fill(0); confirmation.references[0] = 'changed-reference';
  await promise;
  const state = await f.remote.snapshot();
  expect(state.publications[publication.segmentId].remoteReferences).toEqual(['original-reference']);
  expect(state.segments[publication.segmentId].bytes).toEqual(publication.bytes);
  expect(state.discoveries[f.binding.generation].artifacts['changed-reference']).toBeUndefined();
});

it('archive retains accepted and unpublished sealed bytes exactly while excluding remote and runtime metadata', async () => {
  const f = await fixture();
  const accepted = wire(f.descriptor.datasetId, id(50), [operation(f.descriptor.datasetId, 7)], ' \n');
  await f.remote.receive(f.binding, 'private-reference', accepted);
  await finish(f.repository, 'Sealed local work'); const publication = await seal(f);
  const pendingSession = await finish(f.repository, 'Unsegmented local work');
  const archive = await f.repository.archive();
  expect(Object.keys(archive).sort()).toEqual(['coverage', 'dataset', 'format', 'formatVersion', 'segments', 'unsegmentedOperations']);
  expect(archive.segments).toHaveLength(2);
  expect(archive.segments).toContain(decodeUtf8(accepted));
  expect(archive.segments).toContain(decodeUtf8(publication.bytes!));
  expect(archive.unsegmentedOperations).toHaveLength(1);
  expect(archive.unsegmentedOperations[0].entityId).toBe(pendingSession.id);
  const text = JSON.stringify(archive);
  for (const secret of ['private-account', 'private-root', 'private-reference', 'bindingGeneration', 'reservation', 'verifiedPass', 'owner', 'activeSessionId']) {
    expect(text).not.toContain(secret);
  }
});

it('receive reduces bounded winner summaries without entity-history getAll and agrees with full retained reduction', async () => {
  const f = await fixture(); const primary = id(10); const terminal = id(11);
  const historical = Array.from({ length: 256 }, (_, index) => operation(f.descriptor.datasetId, index + 1, primary));
  const deletion: Operation = { protocolVersion: 1, schemaVersion: 1, datasetId: f.descriptor.datasetId,
    deviceId: id(1), opId: id(3000), entityType: 'focusSession', entityId: terminal, operation: 'DELETE', lamportCounter: 1 };
  historical.push(deletion, operation(f.descriptor.datasetId, 300, terminal));
  await f.remote.receive(f.binding, 'long-entity-history', wire(f.descriptor.datasetId, id(60), historical));
  const incoming = [operation(f.descriptor.datasetId, 400, primary, 1),
    operation(f.descriptor.datasetId, 401, primary, 700), operation(f.descriptor.datasetId, 402, terminal, 1000)];
  const original = IDBIndex.prototype.getAll;
  const getAll = vi.spyOn(IDBIndex.prototype, 'getAll').mockImplementation(function(this: IDBIndex, ...args: Parameters<IDBIndex['getAll']>) {
    if (this.name === 'entity') throw new Error('Receive loaded unbounded entity history');
    return original.apply(this, args);
  });
  await f.remote.receive(f.binding, 'bounded-update', wire(f.descriptor.datasetId, id(61), incoming));
  getAll.mockRestore();
  const expected = materializeOperations([...historical, ...incoming]);
  const actual = await f.remote.snapshot();
  expect(actual.entities).toEqual(Object.fromEntries(expected.entities.map((entity: { id: string }) => [entity.id, entity])));
  expect(actual.tombstones).toEqual(expected.tombstones);
  expect(actual.highWater).toBe(1000);
  expect(Object.keys(actual.operations)).toHaveLength(historical.length + incoming.length);
});

it.each([
  ['nonboolean reconciliation', (row: any) => { row.pass.reconciled = 'yes'; }],
  ['negative pass identity', (row: any) => { row.pass.passId = -1; }],
  ['empty current account', (row: any) => { row.binding.account = ''; }],
  ['empty retained locator', (row: any) => { row.lastBinding.locator = ''; }],
] as const)('startup refuses damaged remote metadata (%s) and preserves the damaged source', async (_name, mutate) => {
  const f = await fixture(); await finish(f.repository);
  await corruptRemote(f.repository, f.descriptor.datasetId, mutate);
  const before = await rawSnapshot(f.repository.db);
  await expect(f.repository.initialize()).rejects.toBeDefined();
  expect(await rawSnapshot(f.repository.db)).toEqual(before);
});

it('crash after in-flight attempt commit reopens unresolved work and retries the exact sealed publication', async () => {
  const f = await fixture(); await finish(f.repository); const publication = await seal(f);
  f.repository.fault = point => { if (point === 'after-commit') throw new Error('Process lost after attempt commit'); };
  await expect(f.remote.beginAttempt(f.binding, publication.segmentId)).rejects.toThrow('Process lost after attempt commit');
  f.repository.fault = undefined;
  const committed = (await f.remote.snapshot()).publications[publication.segmentId];
  expect(committed.state).toBe('in-flight'); expect(committed.attempts).toBe(1);
  const name = f.repository.db.name; f.repository.close();
  const reopened = await open(name, () => { throw new Error('Retry must not allocate an identity'); });
  const retained = (await reopened.remote().publications(f.binding))[0];
  expect(retained.state).toBe('in-flight'); expect(retained.bytes).toEqual(publication.bytes);
  const retry = await reopened.remote().beginAttempt(f.binding, publication.segmentId);
  expect(retry.segmentId).toBe(publication.segmentId); expect(retry.bytes).toEqual(publication.bytes);
  expect(retry.operationIds).toEqual(publication.operationIds); expect(retry.attempts).toBe(2);
  expect(Object.keys((await reopened.remote().snapshot()).outbox)).toEqual(publication.operationIds);
  expect(await reopened.remote().status()).not.toBe('Synced');
});
