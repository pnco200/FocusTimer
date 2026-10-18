import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { LocalRepository } from '../src/web/repository';
import { emptyActive, pin, type Operation } from '../src/web/model';
import { MemoryStore, TransactionalRepository } from '../src/simulation/index.js';
import { encodeUtf8, MAX_COUNTER, MAX_OPERATIONS, MAX_SEGMENT_BYTES, parseSegment } from '../src/protocol/index.js';
import { legacyFixture, rawSnapshot, stamp, writeLegacyFixture } from '../e2e/fixtures/legacy';

// These are integration tests of the production requests/transactions. MemoryStore
// is only an independent oracle in the explicit lifecycle parity case below.
const repos: LocalRepository[] = [];
const id = (n: number) => `92000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
afterEach(() => { for (const repo of repos.splice(0)) repo.close(); });
async function open(name: string = crypto.randomUUID(), ids?: () => string) {
  const repo = await LocalRepository.open(name, ids); repos.push(repo); await repo.initialize(); return repo;
}
async function fixture() {
  const ids: string[] = [];
  const repo = await open(crypto.randomUUID(), () => ids.shift() ?? crypto.randomUUID());
  const remote = repo.remote();
  const view = await repo.view();
  const target = { account: 'test-account', locator: 'test-root', descriptor: view.collection.descriptor };
  const binding = await remote.bind(target);
  return { repo, remote, ids, binding, target, descriptor: view.collection.descriptor };
}
async function finish(repo: LocalRepository, description = 'Local session') {
  let { active } = await repo.acquireOwner(crypto.randomUUID());
  active = await repo.saveActive(pin(active), { ...active, id: crypto.randomUUID(), startedAt: stamp, state: 'paused', focusMs: 123 });
  const session = await repo.finish(pin(active), 123, stamp, description);
  const operation = (await repo.syncState()).operations.find(op => op.entityId === session.id)!;
  return { session, operation };
}
function operation(datasetId: string, n: number, description = 'Remote session', deviceId = id(3)): Operation {
  const entityId = id(10000 + n);
  return { protocolVersion: 1, schemaVersion: 1, opId: id(20000 + n), datasetId, deviceId,
    entityType: 'focusSession', entityId, operation: 'UPSERT', lamportCounter: n,
    payload: { id: entityId, startedAt: stamp, endedAt: stamp, focusDurationMs: 123, description } };
}
function wire(datasetId: string, segmentId: string, operations: Operation[]) {
  return encodeUtf8(JSON.stringify({ protocolVersion: 1, datasetId, deviceId: operations[0].deviceId, segmentId, operations }));
}
async function sealed(f: Awaited<ReturnType<typeof fixture>>) {
  const reserved = await f.remote.reserve(f.binding);
  return f.remote.seal(f.binding, reserved!.segmentId);
}
function confirmation(publication: any, references: string[] = ['physical-object']) {
  return { outcome: 'confirmed', segmentId: publication.segmentId, bytes: publication.bytes, references };
}
const stripProvider = (value: any): any => value instanceof Uint8Array ? [...value] : Array.isArray(value) ? value.map(stripProvider)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'provider').map(([key, item]) => [key, stripProvider(item)])) : value;
function remoteGraph(state: any) {
  const result: Record<string, any> = {};
  for (const key of ['descriptor', 'writerId', 'highWater', 'operations', 'entities', 'tombstones', 'outbox', 'publications', 'segments', 'binding', 'lastBinding', 'bindingGeneration', 'blocked']) result[key] = state[key];
  result.outbox = Object.fromEntries(Object.entries(state.outbox).map(([opId, row]: [string, any]) => [opId, { reservation: row.reservation }]));
  result.segments = Object.fromEntries(Object.entries(state.segments).map(([segmentId, row]: [string, any]) => [segmentId, { bytes: row.bytes, operationIds: row.operationIds }]));
  const generation = state.binding?.generation ?? state.lastBinding?.generation;
  const discovery = generation ? state.discoveries[generation] : undefined;
  result.discovery = discovery ? { ...discovery, seen: [...discovery.seen].sort(),
    artifacts: Object.fromEntries(Object.entries(discovery.artifacts).map(([reference, row]: [string, any]) => {
      const { datasetId: _datasetId, seenPass: _seenPass, ...artifact } = row; return [reference, artifact];
    })) } : undefined;
  return stripProvider(result);
}
async function transaction(db: IDBDatabase, stores: string[], work: (tx: IDBTransaction) => void) {
  const tx = db.transaction(stores, 'readwrite');
  const done = new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
  work(tx); await done;
}

it('schema 2 upgrade retains IDs, values, outbox and receipts without inventing remote success, and reopens idempotently', async () => {
  const name = crypto.randomUUID(); const old = legacyFixture();
  old.active = { ...old.active, ...emptyActive(old.installation.selectedDatasetId) } as typeof old.active;
  await writeLegacyFixture({ name, fixture: old });
  const opening = indexedDB.open(name, 2);
  opening.onupgradeneeded = () => {
    opening.transaction!.objectStore('outbox').createIndex('dataset', 'datasetId');
    opening.transaction!.objectStore('receipts').createIndex('dataset', 'datasetId');
    opening.transaction!.objectStore('meta').put({ version: 2 }, 'repository');
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
  const before = await rawSnapshot(db); db.close();
  const repo = await open(name); const after = await rawSnapshot(repo.db);
  expect(repo.db.version).toBe(3);
  for (const store of ['collections', 'history', 'operations', 'outbox', 'receipts', 'active', 'evidence']) expect(after[store]).toEqual(before[store]);
  const state = await repo.remote().snapshot();
  expect(state.binding).toBeNull(); expect(state.bindingGeneration).toBe(0);
  expect(state.publications).toEqual({}); expect(state.segments).toEqual({}); expect(state.discoveries).toEqual({});
  expect(Object.keys(state.outbox).sort()).toEqual(old.outbox.map(row => row.opId).sort());
  expect(Object.values(state.outbox).every((row: any) => row.reservation === null)).toBe(true);
  expect(await repo.remote().status()).toBe('Local only');
  const adopted = await rawSnapshot(repo.db); repo.close();
  const reopened = await open(name); await reopened.initialize(); expect(await rawSnapshot(reopened.db)).toEqual(adopted);
});

it('independent connections reserve disjoint exact membership, with no active operation assigned twice', async () => {
  const f = await fixture();
  for (let n = 0; n < 3; n++) await finish(f.repo, `Work ${n}`);
  const second = await open(f.repo.db.name);
  const reservations = await Promise.all([f.remote.reserve(f.binding, { maxOperations: 2 }), second.remote().reserve(f.binding, { maxOperations: 2 })]);
  const membership = reservations.flatMap(value => value!.operationIds);
  expect(membership).toHaveLength(3); expect(new Set(membership).size).toBe(3);
  expect(await f.remote.reserve(f.binding)).toBeNull();
  const state = await second.remote().snapshot();
  for (const publication of reservations) for (const opId of publication!.operationIds) expect(state.outbox[opId].reservation).toBe(publication!.segmentId);
});

it('reservation commit response loss survives reopen and sealing keeps its original segment and membership', async () => {
  const f = await fixture(); await finish(f.repo);
  f.repo.fault = point => { if (point === 'after-commit') throw new Error('reservation response lost'); };
  await expect(f.remote.reserve(f.binding)).rejects.toThrow('reservation response lost');
  f.repo.fault = undefined;
  const reserved = Object.values((await f.remote.snapshot()).publications)[0] as any;
  expect(reserved.state).toBe('reserved'); expect(reserved.bytes).toBeNull(); f.repo.close();
  const reopened = await open(f.repo.db.name, () => { throw new Error('must reuse identity'); });
  const actual = await reopened.remote().seal(f.binding, reserved.segmentId);
  expect(actual.segmentId).toBe(reserved.segmentId); expect(actual.operationIds).toEqual(reserved.operationIds);
  expect(parseSegment(actual.bytes!).operations).toEqual(reserved.operations);
});

it('sealed and unknown outcomes survive reopen and retries return the identical bytes and segment ID', async () => {
  const f = await fixture(); await finish(f.repo); const publication = await sealed(f);
  const exactBytes = publication.bytes!.slice();
  publication.bytes!.fill(0); publication.operationIds.length = 0;
  const first = await f.remote.beginAttempt(f.binding, publication.segmentId);
  expect(first.bytes).toEqual(exactBytes); expect(first.attempts).toBe(1);
  await f.remote.unknown(f.binding, publication.segmentId); f.repo.close();
  const reopened = await open(f.repo.db.name, () => { throw new Error('must reuse identity'); });
  const pending = await reopened.remote().publications(f.binding);
  expect(pending[0].state).toBe('unknown');
  const retry = await reopened.remote().beginAttempt(f.binding, publication.segmentId);
  expect(retry.bytes).toEqual(exactBytes); expect(retry.segmentId).toBe(first.segmentId); expect(retry.attempts).toBe(2);
  expect(Object.keys((await reopened.remote().snapshot()).outbox)).toEqual(first.operationIds);
});

it('Finish/edit during upload and new work before competing acknowledgements remain pending outside confirmed membership', async () => {
  const f = await fixture(); const first = await finish(f.repo); const publication = await sealed(f);
  await f.remote.beginAttempt(f.binding, publication.segmentId);
  await f.repo.edit(f.descriptor.datasetId, first.operation.opId, { ...first.session, description: 'Edited while uploading' });
  await finish(f.repo, 'Finished while uploading');
  await f.remote.confirm(f.binding, publication.segmentId, confirmation(publication));
  await finish(f.repo, 'Finished after confirmation');
  const other = await open(f.repo.db.name);
  await Promise.all([f.remote.acknowledge(f.binding, publication.segmentId), other.remote().acknowledge(f.binding, publication.segmentId)]);
  const state = await f.remote.snapshot();
  expect(state.publications[publication.segmentId].state).toBe('acknowledged');
  expect(Object.keys(state.outbox)).toHaveLength(3);
  expect(state.outbox[first.operation.opId]).toBeUndefined();
  expect(Object.values(state.outbox).every((row: any) => row.reservation === null)).toBe(true);
  expect(Object.keys(state.operations)).toHaveLength(4);
});

it('same-target reconnect fences stale workers and converts retained in-flight work to exact unknown retry', async () => {
  const f = await fixture(); await finish(f.repo); const publication = await sealed(f);
  await f.remote.beginAttempt(f.binding, publication.segmentId);
  await expect(f.remote.bind(f.target)).rejects.toMatchObject({ code: 'pending-publication-rebind-required' });
  const current = await f.remote.bind({ ...f.target, resumePublications: true });
  expect(current.generation).toBe(f.binding.generation + 1);
  const before = await rawSnapshot(f.repo.db);
  await expect(f.remote.confirm(f.binding, publication.segmentId, confirmation(publication))).rejects.toMatchObject({ code: 'stale-binding' });
  expect(await rawSnapshot(f.repo.db)).toEqual(before);
  const retry = await f.remote.beginAttempt(current, publication.segmentId);
  expect(retry.bytes).toEqual(publication.bytes); expect(retry.binding).toEqual(current);
  await f.remote.disconnect();
  await expect(f.remote.bind({ ...f.target, locator: 'other-root', resumePublications: true })).rejects.toMatchObject({ code: 'pending-publication-rebind-required' });
});

it('received-only retained corpus rejects account/root retarget after disconnect and reopen', async () => {
  const f = await fixture(); const op = operation(f.descriptor.datasetId, 7);
  await f.remote.receive(f.binding, 'received', wire(f.descriptor.datasetId, id(40), [op]));
  await f.remote.disconnect(); f.repo.close(); const reopened = await open(f.repo.db.name); const remote = reopened.remote();
  const before = await rawSnapshot(reopened.db);
  for (const changed of [{ account: 'other-account' }, { locator: 'other-root' }]) {
    await expect(remote.bind({ ...f.target, ...changed })).rejects.toMatchObject({ code: 'destination-transfer-required' });
    expect(await rawSnapshot(reopened.db)).toEqual(before);
  }
  const binding = await remote.bind(f.target); expect(binding.generation).toBeGreaterThan(f.binding.generation);
  expect((await remote.snapshot()).operations[op.opId]).toEqual(op);
});

it('reservation → crash → conflicting receive prevents sealing opposing bytes under one segment identity', async () => {
  const f = await fixture(); await finish(f.repo); const reserved = await f.remote.reserve(f.binding); f.repo.close();
  const reopened = await open(f.repo.db.name); const remote = reopened.remote();
  const opposing = wire(f.descriptor.datasetId, reserved!.segmentId, [operation(f.descriptor.datasetId, 9)]);
  await remote.receive(f.binding, 'opposing', opposing); const before = await rawSnapshot(reopened.db);
  await expect(remote.seal(f.binding, reserved!.segmentId)).rejects.toMatchObject({ code: 'integrity' });
  expect(await rawSnapshot(reopened.db)).toEqual(before);
  const state = await remote.snapshot(); expect(state.publications[reserved!.segmentId].bytes).toBeNull();
  expect(state.segments[reserved!.segmentId].bytes).toEqual(opposing);
});

it('sealing first makes conflicting receive atomic and keeps its attempted artifact unapplied', async () => {
  const f = await fixture(); await finish(f.repo); const publication = await sealed(f);
  const before = await rawSnapshot(f.repo.db);
  await expect(f.remote.receive(f.binding, 'opposing', wire(f.descriptor.datasetId, publication.segmentId, [operation(f.descriptor.datasetId, 9)]))).rejects.toMatchObject({ code: 'integrity' });
  expect(await rawSnapshot(f.repo.db)).toEqual(before);
});

it.each(['reserve.membership', 'seal.bytes', 'attempt.intent', 'unknown.intent', 'confirm.coverage', 'ack.membership'])('native publication abort at %s rolls back the complete lifecycle transition', async point => {
  const f = await fixture(); await finish(f.repo);
  let publication: any;
  if (point !== 'reserve.membership') publication = await f.remote.reserve(f.binding);
  if (!['reserve.membership', 'seal.bytes'].includes(point)) publication = await f.remote.seal(f.binding, publication.segmentId);
  if (['unknown.intent', 'confirm.coverage', 'ack.membership'].includes(point)) await f.remote.beginAttempt(f.binding, publication.segmentId);
  if (point === 'ack.membership') await f.remote.confirm(f.binding, publication.segmentId, confirmation(publication));
  const before = await rawSnapshot(f.repo.db); let reached = false;
  f.repo.fault = (actual, tx) => { if (actual === point) { reached = true; tx.abort(); } };
  const invoke = () => {
    switch (point) {
      case 'reserve.membership': return f.remote.reserve(f.binding);
      case 'seal.bytes': return f.remote.seal(f.binding, publication.segmentId);
      case 'attempt.intent': return f.remote.beginAttempt(f.binding, publication.segmentId);
      case 'unknown.intent': return f.remote.unknown(f.binding, publication.segmentId);
      case 'confirm.coverage': return f.remote.confirm(f.binding, publication.segmentId, confirmation(publication));
      default: return f.remote.acknowledge(f.binding, publication.segmentId);
    }
  };
  await expect(invoke()).rejects.toBeDefined(); f.repo.fault = undefined;
  expect(reached).toBe(true); expect(await rawSnapshot(f.repo.db)).toEqual(before);
  await invoke();
});

it('confirmation requires exact sealed bytes and exact acknowledgement refuses a changed membership atomically', async () => {
  const f = await fixture(); await finish(f.repo); const publication = await sealed(f);
  const before = await rawSnapshot(f.repo.db);
  const changed = publication.bytes!.slice(); changed[changed.length - 1] ^= 1;
  await expect(f.remote.confirm(f.binding, publication.segmentId, { ...confirmation(publication), bytes: changed })).rejects.toMatchObject({ code: 'integrity' });
  expect(await rawSnapshot(f.repo.db)).toEqual(before);
  await expect(f.remote.acknowledge(f.binding, publication.segmentId)).rejects.toMatchObject({ code: 'unconfirmed-publication' });
  expect(await rawSnapshot(f.repo.db)).toEqual(before);
  await f.remote.confirm(f.binding, publication.segmentId, confirmation(publication));
  const opId = publication.operationIds[0];
  await transaction(f.repo.db, ['outbox'], tx => tx.objectStore('outbox').put({ datasetId: f.descriptor.datasetId, opId, reservation: null }));
  const damaged = await rawSnapshot(f.repo.db);
  await expect(f.remote.acknowledge(f.binding, publication.segmentId)).rejects.toMatchObject({ code: 'integrity' });
  expect(await rawSnapshot(f.repo.db)).toEqual(damaged);
});

it('confirmation that conflicts with a later physical reference rolls back earlier coverage writes and the confirmed state', async () => {
  const f = await fixture(); await finish(f.repo); const publication = await sealed(f);
  await f.remote.receive(f.binding, 'existing-object', wire(f.descriptor.datasetId, id(49), [operation(f.descriptor.datasetId, 7)]));
  const before = await rawSnapshot(f.repo.db);
  await expect(f.remote.confirm(f.binding, publication.segmentId, confirmation(publication, ['new-object', 'existing-object']))).rejects.toMatchObject({ code: 'integrity' });
  expect(await rawSnapshot(f.repo.db)).toEqual(before);
  expect((await f.remote.snapshot()).publications[publication.segmentId].state).toBe('sealed');
});

it('recorded page references and continuation commit together and survive interruption; an empty continued page is incomplete', async () => {
  const f = await fixture(); const pass = await f.remote.beginPass(f.binding);
  const page = { references: ['constructor', '__proto__'], continuation: 'next-page', complete: false };
  f.repo.fault = point => { if (point === 'discover.pending') throw new Error('interrupted'); };
  const before = await rawSnapshot(f.repo.db);
  await expect(f.remote.recordPage(f.binding, pass.passId, page)).rejects.toThrow('interrupted');
  expect(await rawSnapshot(f.repo.db)).toEqual(before); f.repo.fault = undefined;
  await f.remote.recordPage(f.binding, pass.passId, page); f.repo.close();
  const reopened = await open(f.repo.db.name); const remote = reopened.remote();
  expect((await remote.beginPass(f.binding)).checkpoint).toBe('next-page');
  expect((await remote.pendingReferences(f.binding)).sort()).toEqual(['__proto__', 'constructor']);
  await remote.recordPage(f.binding, pass.passId, { references: [], continuation: 'still-more', complete: false });
  expect(await remote.completePass(f.binding)).toBe(false);
  expect((await remote.snapshot()).discoveries[f.binding.generation].enumerationComplete).toBe(false);
  await remote.restartEnumeration(f.binding);
  expect((await remote.pendingReferences(f.binding)).sort()).toEqual(['__proto__', 'constructor']);
  expect((await remote.snapshot()).discoveries[f.binding.generation].checkpoint).toBeNull();
});

it('confirmed physical coverage survives ack/reload and an omitted missing upload cannot be reconciled', async () => {
  const f = await fixture(); await finish(f.repo); const publication = await sealed(f);
  await f.remote.confirm(f.binding, publication.segmentId, confirmation(publication, ['not-yet-listed']));
  await f.remote.acknowledge(f.binding, publication.segmentId); f.repo.close();
  const reopened = await open(f.repo.db.name); const remote = reopened.remote(); const pass = await remote.beginPass(f.binding);
  await remote.recordPage(f.binding, pass.passId, { references: [], continuation: null, complete: true });
  expect(await remote.omittedReferences(f.binding)).toEqual(['not-yet-listed']);
  expect(await remote.completePass(f.binding)).toBe(false); expect(await remote.status()).not.toBe('Synced');
  const before = await remote.snapshot();
  await remote.runFailure(f.binding, { code: 'missing-object', message: 'Confirmed content is unavailable' });
  const after = await remote.snapshot(); expect(await remote.status()).toBe('Recovery required');
  expect(after.operations).toEqual(before.operations); expect(after.outbox).toEqual({});
  expect(after.publications[publication.segmentId].remoteReferences).toEqual(['not-yet-listed']);
});

it('reference-free exact acknowledgement keeps a logical obligation until receive atomically verifies coverage', async () => {
  const f = await fixture(); await finish(f.repo); const publication = await sealed(f);
  const pass = await f.remote.beginPass(f.binding);
  await f.remote.recordPage(f.binding, pass.passId, { references: [], continuation: null, complete: true });
  await f.remote.confirm(f.binding, publication.segmentId, confirmation(publication, []));
  await f.remote.acknowledge(f.binding, publication.segmentId);
  expect(await f.remote.completePass(f.binding)).toBe(false); expect(await f.remote.status()).not.toBe('Synced');
  await f.remote.receive(f.binding, 'discovered-later', publication.bytes!);
  expect(await f.remote.completePass(f.binding)).toBe(true); expect(await f.remote.status()).toBe('Synced');
  const state = await f.remote.snapshot(); expect(state.publications[publication.segmentId].remoteReferences).toEqual(['discovered-later']);
  expect(state.outbox).toEqual({}); expect(Object.keys(state.operations)).toEqual(publication.operationIds);
});

it.each(['receive.identities', 'receive.operations', 'receive.projection', 'receive.highWater', 'receive.dedup', 'receive.applied', 'before-commit'])('native receive abort at %s leaves journal, projection, clock, dedup and artifact unchanged', async point => {
  const f = await fixture(); const bytes = wire(f.descriptor.datasetId, id(50), [operation(f.descriptor.datasetId, 71), operation(f.descriptor.datasetId, 72)]);
  const before = await rawSnapshot(f.repo.db); let reached = false;
  f.repo.fault = (actual, tx) => { if (actual === point) { reached = true; tx.abort(); } };
  await expect(f.remote.receive(f.binding, 'atomic', bytes)).rejects.toBeDefined(); f.repo.fault = undefined;
  expect(reached).toBe(true); expect(await rawSnapshot(f.repo.db)).toEqual(before);
  await f.remote.receive(f.binding, 'atomic', bytes);
  const state = await f.remote.snapshot(); expect(state.highWater).toBe(72); expect(Object.keys(state.operations)).toHaveLength(2);
  expect(state.discoveries[f.binding.generation].artifacts.atomic.state).toBe('applied');
});

it('malformed content after a valid-looking prefix accepts no operation and bounded evidence is durably quarantined', async () => {
  const f = await fixture(); const valid = operation(f.descriptor.datasetId, 7);
  const bytes = wire(f.descriptor.datasetId, id(51), [valid, { ...operation(f.descriptor.datasetId, 8), lamportCounter: 0 }]);
  const before = await rawSnapshot(f.repo.db);
  await expect(f.remote.receive(f.binding, 'malformed', bytes)).rejects.toMatchObject({ classification: 'malformed' });
  expect(await rawSnapshot(f.repo.db)).toEqual(before);
  const oversized = new Uint8Array(MAX_SEGMENT_BYTES + 17);
  await f.remote.artifactFailure(f.binding, 'malformed', { classification: 'malformed', message: 'Invalid artifact' }, oversized);
  f.repo.close(); const reopened = await open(f.repo.db.name); const state = await reopened.remote().snapshot();
  expect(state.operations).toEqual({}); expect(state.highWater).toBe(0); expect(state.blocked!.classification).toBe('malformed');
  const artifact = state.discoveries[f.binding.generation].artifacts.malformed;
  expect(artifact.state).toBe('quarantined'); expect(artifact.rejectedBytes).toHaveLength(MAX_SEGMENT_BYTES);
  expect(artifact.rejectedByteLength).toBe(oversized.length); expect(await reopened.remote().status()).toBe('Recovery required');
});

it('duplicate physical and operation delivery preserve one corpus member and terminal tombstone with no inbound outbox', async () => {
  const f = await fixture(); const original = operation(f.descriptor.datasetId, 7, '  Keep exact  ');
  const removed: Operation = { ...original, opId: id(27777), lamportCounter: 8, operation: 'DELETE' }; delete removed.payload;
  const bytes = wire(f.descriptor.datasetId, id(60), [original, removed]);
  await f.remote.receive(f.binding, 'one', bytes); await f.remote.receive(f.binding, 'one', bytes); await f.remote.receive(f.binding, 'two', bytes);
  await f.remote.receive(f.binding, 'different-segment', wire(f.descriptor.datasetId, id(61), [original]));
  const state = await f.remote.snapshot(); expect(Object.keys(state.operations)).toHaveLength(2); expect(state.outbox).toEqual({});
  expect(state.highWater).toBe(8); expect(state.tombstones).toEqual([original.entityId]); expect(state.entities).toEqual({});
  expect(Object.keys(state.segments)).toHaveLength(2); expect((await f.repo.view()).history).toEqual([]);
});

it('two native receive writers recheck immutable op IDs inside their transactions', async () => {
  const f = await fixture(); const other = await open(f.repo.db.name);
  const original = operation(f.descriptor.datasetId, 7); const changed = { ...original, payload: { ...original.payload!, description: 'Opposing values' } };
  const outcomes = await Promise.allSettled([
    f.remote.receive(f.binding, 'one', wire(f.descriptor.datasetId, id(70), [original])),
    other.remote().receive(f.binding, 'two', wire(f.descriptor.datasetId, id(71), [changed])),
  ]);
  expect(outcomes.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
  expect((outcomes.find(result => result.status === 'rejected') as PromiseRejectedResult).reason.code).toBe('integrity');
  const state = await f.remote.snapshot(); expect(Object.keys(state.operations)).toHaveLength(1); expect(Object.keys(state.segments)).toHaveLength(1);
  expect(Object.keys(state.discoveries[f.binding.generation].artifacts)).toHaveLength(1); expect(state.highWater).toBe(7);
});

it('known physical reference and accepted segment identities reject byte changes without accepting a valid prefix', async () => {
  const f = await fixture(); const original = operation(f.descriptor.datasetId, 7);
  const bytes = wire(f.descriptor.datasetId, id(72), [original]); await f.remote.receive(f.binding, 'known', bytes);
  const before = await rawSnapshot(f.repo.db);
  const changed = wire(f.descriptor.datasetId, id(72), [original, operation(f.descriptor.datasetId, 8)]);
  for (const reference of ['known', 'same-segment-new-physical']) {
    await expect(f.remote.receive(f.binding, reference, changed)).rejects.toMatchObject({ code: 'integrity' });
    expect(await rawSnapshot(f.repo.db)).toEqual(before);
  }
  await expect(f.remote.receive(f.binding, 'known', new Uint8Array(MAX_SEGMENT_BYTES + 1))).rejects.toMatchObject({ code: 'integrity' });
  expect(await rawSnapshot(f.repo.db)).toEqual(before);
});

it('count and exact encoded-byte limits split pending operations and retain their original writers', async () => {
  const f = await fixture(); const datasetId = f.descriptor.datasetId;
  const retained = Array.from({ length: MAX_OPERATIONS }, (_, n) => operation(datasetId, n + 1, '\u0000'.repeat(120), id(81)));
  const otherWriter = operation(datasetId, 1001, 'Other original writer', id(82));
  await transaction(f.repo.db, ['operations', 'history', 'outbox', 'collections'], tx => {
    for (const op of [...retained, otherWriter]) {
      tx.objectStore('operations').add(op); tx.objectStore('history').put({ datasetId, id: op.entityId, winner: op });
      tx.objectStore('outbox').add({ datasetId, opId: op.opId, reservation: null });
    }
    tx.objectStore('collections').put({ descriptor: f.descriptor, highWater: 1001 });
  });
  const first = await f.remote.reserve(f.binding); const firstSealed = await f.remote.seal(f.binding, first!.segmentId);
  expect(firstSealed.operationIds.length).toBeGreaterThan(1); expect(firstSealed.operationIds.length).toBeLessThan(MAX_OPERATIONS);
  expect(firstSealed.bytes!.length).toBeLessThanOrEqual(MAX_SEGMENT_BYTES);
  const nextOperation = retained[firstSealed.operationIds.length];
  expect(wire(datasetId, firstSealed.segmentId, [...firstSealed.operations, nextOperation]).length).toBeGreaterThan(MAX_SEGMENT_BYTES);
  const publications = [firstSealed];
  for (;;) {
    const reserved = await f.remote.reserve(f.binding, { maxOperations: 200 }); if (!reserved) break;
    expect(reserved.operationIds.length).toBeLessThanOrEqual(200); publications.push(await f.remote.seal(f.binding, reserved.segmentId));
  }
  const members = publications.flatMap(publication => publication.operationIds);
  expect(members).toHaveLength(1001); expect(new Set(members).size).toBe(1001);
  for (const publication of publications) {
    const parsed = parseSegment(publication.bytes!); expect(parsed.deviceId).toBe(publication.writerId);
    expect((parsed.operations as Operation[]).every(op => op.deviceId === publication.writerId)).toBe(true);
    expect(publication.bytes).toEqual(wire(datasetId, publication.segmentId, publication.operations));
  }
  expect(new Set(publications.map(publication => publication.writerId))).toEqual(new Set([id(81), id(82)]));
  expect((await f.remote.snapshot()).highWater).toBe(1001);
}, 60000);

it('received maximum Lamport high-water survives disconnect/reopen and remains recovery-required', async () => {
  const f = await fixture(); const op = { ...operation(f.descriptor.datasetId, 1), lamportCounter: MAX_COUNTER };
  await f.remote.receive(f.binding, 'maximum', wire(f.descriptor.datasetId, id(90), [op]));
  await f.remote.disconnect(); f.repo.close(); const reopened = await open(f.repo.db.name);
  expect((await reopened.remote().snapshot()).highWater).toBe(MAX_COUNTER); expect(await reopened.remote().status()).toBe('Recovery required');
});

it('representative publication/discovery/receive/reconnect trace matches the verified model after every committed transition', async () => {
  const f = await fixture(); const local = await finish(f.repo);
  const actual = await f.remote.snapshot();
  const store = new MemoryStore(); const modelIds: string[] = [];
  const model = new TransactionalRepository({ store, descriptor: f.descriptor, writerId: actual.writerId, ids: () => modelIds.shift()! } as any);
  // Align initial local corpus only. All compared remote transitions run through
  // each repository's public API; the IDB side never executes MemoryStore code.
  const initial = model.snapshot(); initial.operations[local.operation.opId] = local.operation;
  initial.entities[local.session.id] = local.session; initial.outbox[local.operation.opId] = { reservation: null };
  initial.highWater = local.operation.lamportCounter;
  const populated = new MemoryStore(); populated.initialize(initial);
  const expected = new TransactionalRepository({ store: populated, ids: () => modelIds.shift()! } as any);
  let binding = f.binding; let modelBinding = expected.bind(f.target);
  const compare = async () => {
    expect(remoteGraph(await f.remote.snapshot())).toEqual(remoteGraph(expected.snapshot()));
    expect(await f.remote.status()).toBe(expected.status());
  };
  await compare();
  const segmentId = id(100); f.ids.push(segmentId); modelIds.push(segmentId);
  await f.remote.reserve(binding); expected.reserve(modelBinding); await compare();
  const publication = await f.remote.seal(binding, segmentId); expected.seal(modelBinding, segmentId); await compare();
  await f.remote.beginAttempt(binding, segmentId); expected.beginAttempt(modelBinding, segmentId); await compare();
  await f.remote.unknown(binding, segmentId); expected.unknown(modelBinding, segmentId); await compare();
  await f.remote.beginAttempt(binding, segmentId); expected.beginAttempt(modelBinding, segmentId); await compare();
  const proof = confirmation(publication, []);
  await f.remote.confirm(binding, segmentId, proof); expected.confirm(modelBinding, segmentId, proof); await compare();
  await f.remote.acknowledge(binding, segmentId); expected.acknowledge(modelBinding, segmentId); await compare();
  const pass = await f.remote.beginPass(binding); expected.beginPass(modelBinding); await compare();
  const page = { references: ['__proto__'], continuation: 'page2', complete: false };
  await f.remote.recordPage(binding, pass.passId, page); expected.recordPage(modelBinding, pass.passId, page); await compare();
  await f.remote.receive(binding, '__proto__', publication.bytes!); expected.receive(modelBinding, '__proto__', publication.bytes); await compare();
  const lastPage = { references: [], continuation: null, complete: true };
  await f.remote.recordPage(binding, pass.passId, lastPage); expected.recordPage(modelBinding, pass.passId, lastPage); await compare();
  expect(await f.remote.completePass(binding)).toBe(expected.completePass(modelBinding)); await compare();
  await f.remote.disconnect(); expected.disconnect(); await compare();
  binding = await f.remote.bind(f.target); modelBinding = expected.bind(f.target); await compare();
});

it('inbound discovery, duplicate delivery, terminal deletion and quarantine trace matches deterministic persisted outcomes', async () => {
  const f = await fixture(); const state = await f.remote.snapshot();
  const model = new TransactionalRepository({ descriptor: f.descriptor, writerId: state.writerId } as any);
  const binding = model.bind(f.target);
  const compare = async () => {
    expect(remoteGraph(await f.remote.snapshot())).toEqual(remoteGraph(model.snapshot()));
    expect(await f.remote.status()).toBe(model.status());
  };
  const pass = await f.remote.beginPass(f.binding); model.beginPass(binding); await compare();
  const page = { references: ['first', 'duplicate', 'bad'], continuation: null, complete: true };
  await f.remote.recordPage(f.binding, pass.passId, page); model.recordPage(binding, pass.passId, page); await compare();
  const first = operation(f.descriptor.datasetId, 10);
  const tombstone = { ...operation(f.descriptor.datasetId, 11), entityId: first.entityId, operation: 'DELETE' as const }; delete tombstone.payload;
  const bytes = wire(f.descriptor.datasetId, id(110), [first, tombstone]);
  for (const reference of ['first', 'duplicate']) {
    await f.remote.receive(f.binding, reference, bytes); model.receive(binding, reference, bytes); await compare();
  }
  const badBytes = wire(f.descriptor.datasetId, id(111), [{ ...first, payload: { ...first.payload!, description: 'Conflicting immutable op' } }]);
  await expect(f.remote.receive(f.binding, 'bad', badBytes)).rejects.toMatchObject({ code: 'integrity' });
  expect(() => model.receive(binding, 'bad', badBytes)).toThrow(); await compare();
  const failure = { code: 'integrity', classification: 'integrity', message: 'Same operation identity changed' };
  await f.remote.artifactFailure(f.binding, 'bad', failure, badBytes); model.artifactFailure(binding, 'bad', failure, badBytes); await compare();
  expect(await f.remote.status()).toBe('Recovery required');
});
