import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { LocalRepository } from '../src/web/repository';
import { pin } from '../src/web/model';
import { MemoryStore, TransactionalRepository } from '../src/simulation/index.js';
import { MAX_COUNTER } from '../src/protocol/index.js';
import { rawSnapshot, seedLegacy, stamp } from '../e2e/fixtures/legacy';

const repos: LocalRepository[] = [];
afterEach(() => { for (const repo of repos.splice(0)) repo.close(); });
async function open(name: string = crypto.randomUUID(), ids?: () => string) {
  const repo = await LocalRepository.open(name, ids); repos.push(repo); await repo.initialize(); return repo;
}
async function write(repo: LocalRepository, store: string, value: unknown, key?: IDBValidKey) {
  const tx = repo.db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key);
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
}
async function start(repo: LocalRepository) {
  const { active } = await repo.acquireOwner(crypto.randomUUID());
  return repo.saveActive(pin(active), { ...active, id: crypto.randomUUID(), startedAt: stamp, state: 'paused', focusMs: 123 });
}

it('adopts schema 1 without changing any domain ID, value, pending work, receipt, owner or high-water', async () => {
  const name = crypto.randomUUID(); const fixture = await seedLegacy(name);
  const repo = await open(name); const raw = await rawSnapshot(repo.db);
  expect(repo.db.version).toBe(3);
  for (const store of ['collections', 'history', 'operations', 'outbox', 'receipts'] as const) {
    expect(raw[store]).toEqual([...fixture[store]].sort((a: any, b: any) => (a.opId ?? a.id ?? a.activeId ?? '') < (b.opId ?? b.id ?? b.activeId ?? '') ? -1 : 1));
  }
  expect(raw.active).toEqual([fixture.active]); expect(raw.evidence).toEqual([]);
  const before = await rawSnapshot(repo.db); repo.close(); const reopened = await open(name);
  expect(await rawSnapshot(reopened.db)).toEqual(before);
  const recovered = await reopened.acquireOwner(crypto.randomUUID());
  await reopened.finish(pin(recovered.active), 999, stamp, 'After migration');
  expect((await reopened.syncState()).highWater).toBe(8);
});

it.each(['operations', 'history', 'outbox', 'collections', 'before-commit'])('native edit and delete abort at %s leave the entire database unchanged', async point => {
  for (const kind of ['edit', 'delete'] as const) {
    const repo = await open(); const active = await start(repo); const session = await repo.finish(pin(active), 123, stamp, 'Before');
    const view = await repo.view(); const before = await rawSnapshot(repo.db);
    repo.fault = actual => { if (actual === point) throw new Error('aborted'); };
    await expect(kind === 'edit'
      ? repo.edit(active.datasetId, view.history[0].winner.opId, { ...session, description: 'After' })
      : repo.delete(active.datasetId, session.id, view.history[0].winner.opId)).rejects.toThrow('aborted');
    repo.fault = undefined; expect(await rawSnapshot(repo.db)).toEqual(before);
  }
});

it('committed response loss is replayed from a validated receipt without a second operation, including after reopen', async () => {
  const repo = await open(); const active = await start(repo); const expected = pin(active);
  repo.fault = point => { if (point === 'after-commit') throw new Error('response lost'); };
  await expect(repo.finish(expected, 123, stamp, 'Committed')).rejects.toThrow('response lost');
  repo.fault = undefined; const before = await rawSnapshot(repo.db); repo.close();
  const reopened = await open(repo.db.name);
  expect((await reopened.finish(expected, 999, stamp, 'Retry')).description).toBe('Committed');
  expect(await rawSnapshot(reopened.db)).toEqual(before);
  await expect(reopened.finish({ ...expected, datasetId: crypto.randomUUID() }, 999, stamp, 'Wrong source')).rejects.toMatchObject({ code: 'stale-active' });
});

it('a committed Finish retry allocates neither a new identity nor a version', async () => {
  const repo = await open(); const active = await start(repo); const expected = pin(active);
  const session = await repo.finish(expected, 123, stamp, 'Saved'); const before = await rawSnapshot(repo.db); repo.close();
  const reopened = await open(repo.db.name, () => { throw new Error('No randomness available'); });
  expect(await reopened.finish(expected, 999, stamp, 'Retry')).toEqual(session);
  expect(await rawSnapshot(reopened.db)).toEqual(before);
});

it('immutable op ID collision uses a native constraint and rolls back every Finish effect', async () => {
  const name = crypto.randomUUID(); const fixture = await seedLegacy(name);
  const repo = await open(name, () => fixture.operations[0].opId);
  const { active } = await repo.acquireOwner(crypto.randomUUID()); const before = await rawSnapshot(repo.db);
  await expect(repo.finish(pin(active), 9, stamp, 'Collision', crypto.randomUUID())).rejects.toMatchObject({ name: 'ConstraintError' });
  expect(await rawSnapshot(repo.db)).toEqual(before);
});

it('concurrent same-base edits commit one operation and reject the other, without advancing the rejected clock', async () => {
  const repo = await open(); const active = await start(repo); const session = await repo.finish(pin(active), 1, stamp, 'Original');
  const other = await open(repo.db.name); const base = (await repo.view()).history[0].winner.opId;
  const outcomes = await Promise.allSettled([repo.edit(active.datasetId, base, { ...session, description: 'A' }), other.edit(active.datasetId, base, { ...session, description: 'B' })]);
  expect(outcomes.map(x => x.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect((outcomes.find(x => x.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('stale-editor');
  const state = await repo.syncState(); expect(state.highWater).toBe(2); expect(state.operations).toHaveLength(2); expect(state.outbox).toHaveLength(2);
});

it('a stale projection cannot authorize an edit after terminal deletion', async () => {
  const repo = await open(); const active = await start(repo); const session = await repo.finish(pin(active), 1, stamp, 'Original');
  const entry = (await repo.view()).history[0]; await repo.delete(entry.datasetId, entry.id, entry.winner.opId);
  await write(repo, 'history', entry);
  await expect(repo.edit(entry.datasetId, entry.winner.opId, { ...session, description: 'Revive' })).rejects.toMatchObject({ code: 'stale-editor' });
  expect(await repo.delete(entry.datasetId, entry.id, entry.winner.opId)).toBe(false);
  await repo.initialize(); expect((await repo.view()).history).toEqual([]);
  expect((await repo.syncState()).highWater).toBe(2);
});

it('schema adoption never deletes valid history absent from the journal or fabricates replacement operations', async () => {
  const name = crypto.randomUUID(); const fixture = await seedLegacy(name);
  const repo = await LocalRepository.open(name); repos.push(repo);
  const tx = repo.db.transaction('operations', 'readwrite'); tx.objectStore('operations').delete([fixture.operations[1].datasetId, fixture.operations[1].opId]);
  await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
  const before = await rawSnapshot(repo.db);
  await expect(repo.initialize()).rejects.toMatchObject({ code: 'recovery' });
  expect(await rawSnapshot(repo.db)).toEqual(before);
});

it.each(['missing-pending', 'reservation', 'receipt'])('ambiguous %s migration data is retained for recovery', async damage => {
  const name = crypto.randomUUID(); const fixture = await seedLegacy(name); const repo = await LocalRepository.open(name); repos.push(repo);
  if (damage === 'receipt') await write(repo, 'receipts', { ...fixture.receipts[0], session: { ...fixture.receipts[0].session, description: 'Conflict' } });
  else if (damage === 'reservation') await write(repo, 'outbox', { ...fixture.outbox[0], reservation: crypto.randomUUID() });
  else {
    const tx = repo.db.transaction('outbox', 'readwrite'); tx.objectStore('outbox').delete([fixture.outbox[0].datasetId, fixture.outbox[0].opId]);
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
  }
  const before = await rawSnapshot(repo.db);
  await expect(repo.initialize()).rejects.toMatchObject({ code: 'recovery' }); expect(await rawSnapshot(repo.db)).toEqual(before);
});

it('failed schema adoption rolls back its marker and high-water repair and retries idempotently', async () => {
  const name = crypto.randomUUID(); const fixture = await seedLegacy(name); const repo = await LocalRepository.open(name); repos.push(repo);
  await write(repo, 'collections', { ...fixture.collections[0], highWater: 0 }); const before = await rawSnapshot(repo.db);
  repo.fault = point => { if (point === 'meta') throw new Error('interrupted'); };
  await expect(repo.initialize()).rejects.toThrow('interrupted'); expect(await rawSnapshot(repo.db)).toEqual(before);
  repo.fault = undefined; await repo.initialize(); expect((await repo.syncState()).highWater).toBe(4);
  const adopted = await rawSnapshot(repo.db); await repo.initialize(); expect(await rawSnapshot(repo.db)).toEqual(adopted);
});

it('recovery Finish rejects a session ID already present in the original dataset', async () => {
  const name = crypto.randomUUID(); const fixture = await seedLegacy(name); const repo = await open(name);
  await write(repo, 'collections', { ...fixture.collections[0], highWater: MAX_COUNTER });
  const { active } = await repo.acquireOwner(crypto.randomUUID()); const before = await rawSnapshot(repo.db);
  await expect(repo.finish(pin(active), 1, stamp, 'Duplicate', fixture.operations[0].entityId, crypto.randomUUID())).rejects.toThrow('fresh');
  expect(await rawSnapshot(repo.db)).toEqual(before);
});

it('IndexedDB local command results match the verified deterministic model across finish, edit, no-op and terminal delete', async () => {
  const ids: string[] = [];
  const repo = await open(crypto.randomUUID(), () => ids.shift() ?? crypto.randomUUID());
  const view = await repo.view(); const model = new TransactionalRepository({ store: new MemoryStore(), descriptor: view.collection.descriptor, writerId: view.installation.writerId } as any);
  const ownerToken = crypto.randomUUID(); model.acquireOwner(ownerToken);
  let owner = (await repo.acquireOwner(ownerToken)).active;
  const entityId = crypto.randomUUID(); const activeId = crypto.randomUUID(); const opId = crypto.randomUUID();
  owner = await repo.saveActive(pin(owner), { ...owner, id: activeId, startedAt: stamp, state: 'paused', focusMs: 123, description: '  Shared  ' });
  model.startActive({ ownerToken, ownerGeneration: 1, expectedBindingGeneration: 0, activeId, startedAt: stamp, focusDurationMs: 123, description: '  Shared  ' });
  model.finish({ commandId: 'finish', ownerToken, ownerGeneration: 1, expectedBindingGeneration: 0, activeId, expectedRevision: 1, entityId, opId, endedAt: stamp });
  ids.push(opId); const session = await repo.finish(pin(owner), 123, stamp, '  Shared  ', entityId);
  const compare = async () => {
    const actual = await repo.syncState(); const expected = model.snapshot();
    expect(actual.operations).toEqual(Object.values(expected.operations).sort((a: any, b: any) => a.opId < b.opId ? -1 : 1));
    expect(actual.highWater).toBe(expected.highWater);
    expect(actual.outbox.map(x => x.opId).sort()).toEqual(Object.keys(expected.outbox).sort());
    expect((await repo.view()).history.map(x => x.winner.payload)).toEqual(model.materialized().entities);
  };
  await compare();
  expect(await repo.edit(view.installation.selectedDatasetId, opId, session)).toBe(false);
  model.edit({ expectedBindingGeneration: 0, entityId, baseOpId: opId, payload: session }); await compare();
  const editId = crypto.randomUUID(); const payload = { ...session, focusDurationMs: 60123 };
  ids.push(editId); await repo.edit(view.installation.selectedDatasetId, opId, payload);
  model.edit({ expectedBindingGeneration: 0, entityId, baseOpId: opId, payload, opId: editId }); await compare();
  const deleteId = crypto.randomUUID(); ids.push(deleteId); await repo.delete(view.installation.selectedDatasetId, entityId, editId);
  model.delete({ expectedBindingGeneration: 0, entityId, baseOpId: editId, opId: deleteId }); await compare();
  expect(await repo.delete(view.installation.selectedDatasetId, entityId, editId)).toBe(false);
  await compare();
});
