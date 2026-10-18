import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { LocalRepository } from '../src/web/repository';
import { pin, type Descriptor, type Operation } from '../src/web/model';
import type { RemoteRepository } from '../src/web/remote-repository';
import { SyncRunner } from '../src/web/sync-runner';
import { encodeUtf8, MAX_SEGMENT_BYTES } from '../src/protocol/index.js';
import { AsyncAdversarialTransport } from '../test-support/async-transport';

// Every test exercises the production native IDB requests/transactions and async
// runner. The transport is the only simulation; no in-memory repository is used.
const repositories: LocalRepository[] = [];
const uuid = (n: number) => `93000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const stamp = '2026-10-18T12:00:00.000Z';
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });
async function open(name: string = crypto.randomUUID(), datasetId?: string) {
  let first = true;
  const repo = await LocalRepository.open(name, () => {
    if (first && datasetId) { first = false; return datasetId; }
    first = false; return crypto.randomUUID();
  });
  repositories.push(repo); await repo.initialize(); return repo;
}
async function fixture(transport = new AsyncAdversarialTransport()) {
  const repo = await open(); const remote = repo.remote(); const descriptor = (await repo.view()).collection.descriptor;
  const target = { account: 'test-account', locator: 'test-root', descriptor };
  transport.createDataset(target, descriptor); const binding = await remote.bind(target);
  return { repo, remote, descriptor, target, binding, transport, runner: new SyncRunner(remote, transport) };
}
async function finish(repo: LocalRepository, description = 'Completed locally') {
  let { active } = await repo.acquireOwner(crypto.randomUUID());
  active = await repo.saveActive(pin(active), { ...active, id: crypto.randomUUID(), startedAt: stamp, state: 'paused', focusMs: 123 });
  const session = await repo.finish(pin(active), 123, stamp, description);
  const operation = (await repo.syncState()).operations.find(value => value.entityId === session.id)!;
  return { session, operation };
}
function operation(datasetId: string, n: number): Operation {
  const entityId = uuid(10000 + n);
  return { protocolVersion: 1, schemaVersion: 1, opId: uuid(20000 + n), datasetId, deviceId: uuid(2),
    entityType: 'focusSession', entityId, operation: 'UPSERT', lamportCounter: n,
    payload: { id: entityId, startedAt: stamp, endedAt: stamp, focusDurationMs: 123, description: `Remote ${n}` } };
}
function wire(descriptor: Descriptor, n: number, operations = [operation(descriptor.datasetId, n)]) {
  return encodeUtf8(JSON.stringify({ protocolVersion: 1, datasetId: descriptor.datasetId,
    deviceId: operations[0].deviceId, segmentId: uuid(30000 + n), operations }));
}
function cancelAfter(remote: RemoteRepository, method: string, controller: AbortController) {
  const target = remote as unknown as Record<string, (...args: any[]) => Promise<any>>;
  const original = target[method].bind(remote);
  target[method] = async (...args) => { const result = await original(...args); controller.abort(); return result; };
}
async function settle(repo: LocalRepository, transport: AsyncAdversarialTransport) {
  const runner = new SyncRunner(repo.remote(), transport);
  for (let n = 0; n < 5; n++) if (await runner.run() === 'Synced') return;
  throw new Error(`Replica did not settle: ${await repo.remote().status()}`);
}

it('converges two independent IndexedDB replicas after offline edits/deletes, delayed duplicated/reordered pages, lost upload response and reload', async () => {
  const transport = new AsyncAdversarialTransport({ pageSize: 1, order: 'reverse', duplicateDelivery: 2,
    duplicatePublications: true, publicationDelay: 3 });
  const a = await fixture(transport); let left = a.repo; let right = await open(crypto.randomUUID(), a.descriptor.datasetId);
  await right.remote().bind(a.target);
  expect((await left.syncState()).writerId).not.toBe((await right.syncState()).writerId);
  for (const repo of [left, right]) {
    const kept = await finish(repo, 'Offline original'); const removed = await finish(repo, 'Offline to delete');
    await repo.edit(a.descriptor.datasetId, kept.operation.opId, { ...kept.session, description: 'Offline edited' });
    await repo.delete(a.descriptor.datasetId, removed.session.id, removed.operation.opId);
  }
  const expected = [...(await left.syncState()).operations, ...(await right.syncState()).operations]
    .sort((x, y) => x.opId.localeCompare(y.opId));
  transport.queue('publish', { type: 'response-lost' });
  expect(await a.runner.run()).toBe('Offline / Retry pending');
  const lost = Object.values((await a.remote.snapshot()).publications)[0];
  expect(lost.state).toBe('unknown'); expect(transport.references(a.binding)).toHaveLength(1);
  const leftName = left.db.name; const rightName = right.db.name; left.close(); right.close();
  left = await open(leftName); right = await open(rightName);
  transport.queue('enumerate', { type: 'partial', count: 0 });
  await new SyncRunner(left.remote(), transport).run();
  await new SyncRunner(right.remote(), transport).run(); transport.advance(3);
  await settle(left, transport); await settle(right, transport); await settle(left, transport);
  const [one, two] = await Promise.all([left.remote().snapshot(), right.remote().snapshot()]);
  expect(Object.values(one.operations).sort((x, y) => x.opId.localeCompare(y.opId))).toEqual(expected);
  for (const key of ['operations', 'entities', 'tombstones', 'highWater', 'outbox'] as const) expect(two[key]).toEqual(one[key]);
  expect(Object.keys(one.operations)).toHaveLength(8); expect(Object.keys(one.entities)).toHaveLength(2);
  expect(one.tombstones).toHaveLength(2); expect(one.highWater).toBe(4); expect(one.outbox).toEqual({});
  for (const repo of [left, right]) {
    expect(await repo.remote().pendingReferences((await repo.remote().captureBinding())!)).toEqual([]);
    expect((await repo.view()).history).toHaveLength(2); expect(await repo.remote().status()).toBe('Synced');
    expect(Object.values((await repo.remote().snapshot()).publications).every(value => value.state === 'acknowledged')).toBe(true);
  }
  const retries = transport.calls.filter(call => call.method === 'publish' && call.segmentId === lost.segmentId);
  expect(retries).toHaveLength(2); expect(retries[1].bytes).toEqual(lost.bytes); expect(retries[1].retryHandle).toBe(retries[0].retryHandle);
  expect(transport.calls.filter(call => call.method === 'preparePublication' && call.segmentId === lost.segmentId)).toHaveLength(1);
  expect(transport.references(a.binding)).toHaveLength(3); // One accepted retry deliberately created a physical duplicate.
});

it('keeps edits and completions authored during upload pending outside the exact acknowledged membership', async () => {
  const f = await fixture(); const initial = await finish(f.repo); const hold = f.transport.holdNext('publish');
  const running = f.runner.run(); await hold.entered;
  await f.repo.edit(f.descriptor.datasetId, initial.operation.opId, { ...initial.session, description: 'Edited during upload' });
  await finish(f.repo, 'Finished during upload'); hold.release();
  expect(await running).toBe('Changes saved locally / Pending');
  const snapshot = await f.remote.snapshot(); const publication = Object.values(snapshot.publications)[0];
  expect(publication.state).toBe('acknowledged'); expect(publication.operationIds).toEqual([initial.operation.opId]);
  expect(Object.keys(snapshot.outbox)).toHaveLength(2);
  expect(Object.values(snapshot.outbox).every(value => value.reservation === null)).toBe(true);
  await settle(f.repo, f.transport); expect(Object.keys((await f.remote.snapshot()).operations)).toHaveLength(3);
});

it('persists empty continued and partial pages, resumes the durable cursor after reopen and consumes every page', async () => {
  const f = await fixture(new AsyncAdversarialTransport({ pageSize: 1 }));
  for (const n of [1, 2, 3]) f.transport.put(f.binding, wire(f.descriptor, n));
  f.transport.queue('enumerate', { type: 'partial', count: 0 });
  expect(await f.runner.run({ maxPages: 1 })).not.toBe('Synced');
  let pass = (await f.remote.snapshot()).discoveries[f.binding.generation];
  expect(pass.enumerationComplete).toBe(false); expect(pass.checkpoint).toBeTypeOf('string'); expect(pass.artifacts).toEqual({});
  const checkpoint = pass.checkpoint; f.repo.close(); const reopened = await open(f.repo.db.name);
  f.transport.queue('enumerate', { type: 'partial', count: 1 });
  await new SyncRunner(reopened.remote(), f.transport).run({ maxPages: 1 });
  const enumerations = f.transport.calls.filter(call => call.method === 'enumerate'); expect(enumerations[1].continuation).toBe(checkpoint);
  pass = (await reopened.remote().snapshot()).discoveries[f.binding.generation]; expect(pass.enumerationComplete).toBe(false);
  expect(Object.keys((await reopened.remote().snapshot()).operations)).toHaveLength(1);
  await settle(reopened, f.transport); expect(Object.keys((await reopened.remote().snapshot()).operations)).toHaveLength(3);
});

it('restarts a rejected opaque cursor and later full reconciliation discovers previously invisible content', async () => {
  const f = await fixture(new AsyncAdversarialTransport({ pageSize: 1 }));
  f.transport.put(f.binding, wire(f.descriptor, 1)); f.transport.put(f.binding, wire(f.descriptor, 2));
  f.transport.put(f.binding, wire(f.descriptor, 3), { visibleAt: 2 });
  await f.runner.run({ maxPages: 1 }); f.transport.queue('enumerate', { type: 'reject-cursor' });
  expect(await f.runner.run()).toBe('Synced'); expect(Object.keys((await f.remote.snapshot()).operations)).toHaveLength(2);
  f.transport.advance(2); expect(await f.runner.run()).toBe('Synced');
  expect(Object.keys((await f.remote.snapshot()).operations)).toHaveLength(3);
});

it('does not accept a prefix of an incomplete read and resumes the unresolved download before discovery', async () => {
  const f = await fixture(); const first = operation(f.descriptor.datasetId, 1); const second = operation(f.descriptor.datasetId, 2);
  const reference = f.transport.put(f.binding, wire(f.descriptor, 1, [first, second]));
  f.transport.queue('read', { type: 'truncated' }); expect(await f.runner.run()).toBe('Offline / Retry pending');
  let snapshot = await f.remote.snapshot(); expect(snapshot.operations).toEqual({});
  expect(snapshot.discoveries[f.binding.generation].artifacts[reference].state).toBe('pending');
  f.repo.close(); const reopened = await open(f.repo.db.name); f.transport.calls.length = 0;
  await settle(reopened, f.transport); snapshot = await reopened.remote().snapshot();
  expect(Object.keys(snapshot.operations)).toHaveLength(2);
  expect(f.transport.calls.findIndex(call => call.method === 'read')).toBeLessThan(f.transport.calls.findIndex(call => call.method === 'enumerate'));
});

it('commits a persisted pending download even when the following resumed listing fails', async () => {
  const f = await fixture(new AsyncAdversarialTransport({ pageSize: 1 }));
  f.transport.put(f.binding, wire(f.descriptor, 1)); f.transport.put(f.binding, wire(f.descriptor, 2));
  f.transport.queue('read', { type: 'error', code: 'retryable' }); await f.runner.run();
  expect((await f.remote.snapshot()).operations).toEqual({});
  f.transport.queue('enumerate', { type: 'error', code: 'retryable' });
  expect(await f.runner.run()).toBe('Offline / Retry pending');
  expect(Object.keys((await f.remote.snapshot()).operations)).toHaveLength(1);
  await settle(f.repo, f.transport); expect(Object.keys((await f.remote.snapshot()).operations)).toHaveLength(2);
});

it('persists the first concurrently prepared creation identity and uses it for both competing workers', async () => {
  const f = await fixture(new AsyncAdversarialTransport({ uniquePreparationHandles: true })); await finish(f.repo);
  const preparing = f.transport.holdNext('preparePublication'); const one = f.runner.run(); await preparing.entered;
  const secondRepo = await open(f.repo.db.name); const uploading = f.transport.holdNext('publish');
  const two = new SyncRunner(secondRepo.remote(), f.transport).run(); await uploading.entered;
  const durable = Object.values((await f.remote.snapshot()).publications)[0]; expect(durable.retryHandle).toBeTypeOf('string');
  preparing.release(); await one; uploading.release(); await two; await settle(f.repo, f.transport);
  const attempts = f.transport.calls.filter(call => call.method === 'publish'); expect(attempts).toHaveLength(2);
  expect(attempts.every(call => call.retryHandle === durable.retryHandle)).toBe(true);
  expect(f.transport.calls.filter(call => call.method === 'preparePublication')).toHaveLength(2);
  expect(f.transport.references(f.binding)).toHaveLength(1);
});

it.each(['sealed', 'unknown', 'confirmed'] as const)('resumes a persisted %s publication before a later listing failure', async state => {
  const f = await fixture(); await finish(f.repo); const reserved = await f.remote.reserve(f.binding);
  const sealed = await f.remote.seal(f.binding, reserved!.segmentId);
  let handle: string | undefined;
  if (state !== 'sealed') {
    handle = await f.transport.preparePublication(f.binding, { segmentId: sealed.segmentId }, {});
    await f.remote.retainRetryHandle(f.binding, sealed.segmentId, handle);
    await f.remote.beginAttempt(f.binding, sealed.segmentId);
    const accepted = await f.transport.publish(f.binding, { segmentId: sealed.segmentId, bytes: sealed.bytes!, retryHandle: handle }, {});
    if (state === 'unknown') await f.remote.unknown(f.binding, sealed.segmentId);
    else await f.remote.confirm(f.binding, sealed.segmentId, accepted);
  }
  f.repo.close(); const reopened = await open(f.repo.db.name); f.transport.calls.length = 0;
  f.transport.queue('enumerate', { type: 'error', code: 'retryable' });
  expect(await new SyncRunner(reopened.remote(), f.transport).run()).toBe('Offline / Retry pending');
  const snapshot = await reopened.remote().snapshot(); expect(snapshot.publications[sealed.segmentId].state).toBe('acknowledged');
  expect(snapshot.outbox).toEqual({}); expect(snapshot.discoveries[f.binding.generation].error).toBe('retryable');
  const attempts = f.transport.calls.filter(call => call.method === 'publish');
  if (state === 'confirmed') expect(attempts).toEqual([]);
  else {
    expect(attempts).toHaveLength(1); expect(attempts[0]).toMatchObject({ segmentId: sealed.segmentId, bytes: sealed.bytes });
    expect(f.transport.calls.findIndex(call => call.method === 'publish')).toBeLessThan(f.transport.calls.findIndex(call => call.method === 'enumerate'));
    if (handle) { expect(attempts[0].retryHandle).toBe(handle); expect(f.transport.calls.filter(call => call.method === 'preparePublication')).toEqual([]); }
  }
  await settle(reopened, f.transport);
});

it('publishes preexisting eligible work after a resumed upload while keeping upload-time authoring pending', async () => {
  const f = await fixture(); const initial = await finish(f.repo); const reserved = await f.remote.reserve(f.binding);
  await f.remote.seal(f.binding, reserved!.segmentId); const preexisting = await finish(f.repo, 'Before resumed upload');
  f.repo.close(); const reopened = await open(f.repo.db.name); const hold = f.transport.holdNext('publish');
  const running = new SyncRunner(reopened.remote(), f.transport).run(); await hold.entered;
  await reopened.edit(f.descriptor.datasetId, initial.operation.opId, { ...initial.session, description: 'During resumed upload' });
  await finish(reopened, 'New completion during resumed upload'); hold.release();
  expect(await running).toBe('Changes saved locally / Pending'); const snapshot = await reopened.remote().snapshot();
  const publications = Object.values(snapshot.publications); expect(publications).toHaveLength(2);
  expect(publications.every(value => value.state === 'acknowledged')).toBe(true);
  expect(publications.flatMap(value => value.operationIds).sort()).toEqual([initial.operation.opId, preexisting.operation.opId].sort());
  expect(Object.keys(snapshot.outbox)).toHaveLength(2); expect(Object.values(snapshot.outbox).every(value => value.reservation === null)).toBe(true);
  await settle(reopened, f.transport); expect(Object.keys((await reopened.remote().snapshot()).operations)).toHaveLength(4);
});

it('allows cancellation after identity allocation but before persistence without publishing content', async () => {
  const f = await fixture(new AsyncAdversarialTransport({ uniquePreparationHandles: true })); await finish(f.repo);
  const controller = new AbortController(); const prepare = f.transport.preparePublication.bind(f.transport);
  f.transport.preparePublication = async (...args) => { const identity = await prepare(...args); controller.abort(); return identity; };
  expect(await f.runner.run({ signal: controller.signal })).toBe('Offline / Retry pending');
  const publication = Object.values((await f.remote.snapshot()).publications)[0];
  expect(publication.state).toBe('sealed'); expect(publication.retryHandle).toBeUndefined();
  expect(f.transport.references(f.binding)).toEqual([]); expect(f.transport.calls.filter(call => call.method === 'publish')).toEqual([]);
  f.transport.preparePublication = prepare; f.repo.close(); const reopened = await open(f.repo.db.name); await settle(reopened, f.transport);
  expect(f.transport.calls.filter(call => call.method === 'preparePublication')).toHaveLength(2);
  expect(Object.values((await reopened.remote().snapshot()).publications)[0].retryHandle).toMatch(/:2$/);
});

it('requires exact affirmative confirmation and leaves mismatching responses unacknowledged', async () => {
  const f = await fixture(); await finish(f.repo); const publish = f.transport.publish.bind(f.transport);
  f.transport.publish = async (...args) => { const confirmation = await publish(...args); confirmation.bytes[0] ^= 1; return confirmation; };
  expect(await f.runner.run()).toBe('Recovery required'); const snapshot = await f.remote.snapshot();
  expect(snapshot.blocked?.classification).toBe('integrity'); expect(Object.keys(snapshot.outbox)).toHaveLength(1);
  expect(Object.values(snapshot.publications)[0].state).toBe('in-flight');
});

it('cannot acknowledge an unknown accepted upload whose stored bytes are unavailable for retry confirmation', async () => {
  const f = await fixture(); await finish(f.repo);
  f.transport.queue('publish', { type: 'response-lost' });
  expect(await f.runner.run()).toBe('Offline / Retry pending');
  const publication = Object.values((await f.remote.snapshot()).publications)[0];
  f.transport.setObjectAvailable(f.binding, f.transport.references(f.binding)[0], false);
  expect(await f.runner.run()).toBe('Recovery required');
  const snapshot = await f.remote.snapshot();
  expect(snapshot.publications[publication.segmentId].state).toBe('unknown');
  expect(Object.keys(snapshot.outbox)).toEqual(publication.operationIds);
  expect(snapshot.blocked?.classification).toBe('missing-object');
  expect(snapshot.tombstones).toEqual([]);
});

it('retains a discovery obligation after a reference-free exact confirmation until a later full pass proves coverage', async () => {
  const f = await fixture(); await finish(f.repo); const publish = f.transport.publish.bind(f.transport);
  f.transport.publish = async (...args) => { const { references: _references, ...confirmation } = await publish(...args); return confirmation; };
  expect(await f.runner.run()).toBe('Changes saved locally / Pending');
  const publication = Object.values((await f.remote.snapshot()).publications)[0];
  expect(publication.state).toBe('acknowledged'); expect(publication.remoteReferences).toEqual([]);
  expect((await f.remote.snapshot()).outbox).toEqual({}); await settle(f.repo, f.transport);
  expect(Object.values((await f.remote.snapshot()).publications)[0].remoteReferences).toHaveLength(1);
});

it.each(['receive', 'confirm', 'unknown', 'runFailure'] as const)('propagates native %s transaction failures without diagnosing remote corruption', async boundary => {
  const f = await fixture();
  if (boundary === 'receive') f.transport.put(f.binding, wire(f.descriptor, 1));
  else if (boundary !== 'runFailure') await finish(f.repo);
  if (boundary === 'unknown') f.transport.queue('publish', { type: 'response-lost' });
  if (boundary === 'runFailure') f.transport.queue('readDescriptor', { type: 'error', code: 'retryable' });
  const points = { receive: 'receive.operations', confirm: 'confirm.coverage', unknown: 'unknown.intent', runFailure: 'runFailure.error' };
  let reached = false;
  f.repo.fault = point => { if (point === points[boundary]) { reached = true; throw new Error('Native transaction failure'); } };
  await expect(f.runner.run()).rejects.toThrow('Native transaction failure'); f.repo.fault = undefined;
  expect(reached).toBe(true); const snapshot = await f.remote.snapshot(); expect(snapshot.blocked).toBeNull();
  expect(Object.values(snapshot.discoveries[f.binding.generation].artifacts).some(value => value.state === 'quarantined')).toBe(false);
  expect(snapshot.discoveries[f.binding.generation].error).toBeNull();
  if (boundary === 'receive') expect(snapshot.operations).toEqual({});
  if (['confirm', 'unknown'].includes(boundary)) expect(Object.values(snapshot.publications)[0].state).toBe('in-flight');
  f.repo.close(); const reopened = await open(f.repo.db.name); await settle(reopened, f.transport);
});

it.each(['malformed', 'unsupported'] as const)('quarantines whole %s segments without applying a valid first operation', async classification => {
  const f = await fixture(); const valid = operation(f.descriptor.datasetId, 1);
  const bad = { ...operation(f.descriptor.datasetId, 2), ...(classification === 'malformed' ? { lamportCounter: 0 } : { schemaVersion: 2 }) };
  const bytes = wire(f.descriptor, 1, [valid, bad as Operation]); const reference = f.transport.put(f.binding, bytes);
  await f.runner.run(); const snapshot = await f.remote.snapshot();
  expect(snapshot.operations).toEqual({}); expect(snapshot.entities).toEqual({}); expect(snapshot.highWater).toBe(0);
  expect(snapshot.blocked?.classification).toBe(classification);
  expect(snapshot.discoveries[f.binding.generation].artifacts[reference]).toMatchObject({ state: 'quarantined', rejectedBytes: bytes });
  expect(await f.remote.status()).toBe(classification === 'unsupported' ? 'Unsupported data / Upgrade required' : 'Recovery required');
});

it.each(['missing', 'changed', 'oversized'] as const)('rechecks an omitted known reference that is %s without inventing a domain DELETE', async kind => {
  const f = await fixture(); const original = wire(f.descriptor, 1); const reference = f.transport.put(f.binding, original);
  expect(await f.runner.run()).toBe('Synced'); const accepted = (await f.remote.snapshot()).operations;
  if (kind === 'missing') f.transport.setObjectAvailable(f.binding, reference, false);
  else {
    f.transport.setVisibleAt(f.binding, reference, 100);
    f.transport.replace(f.binding, reference, kind === 'oversized' ? new Uint8Array(MAX_SEGMENT_BYTES + 1) : wire(f.descriptor, 2));
  }
  expect(await f.runner.run()).toBe('Recovery required'); const snapshot = await f.remote.snapshot();
  expect(snapshot.operations).toEqual(accepted); expect(snapshot.tombstones).toEqual([]);
  expect(snapshot.blocked?.classification).toBe(kind === 'missing' ? 'missing-object' : 'integrity');
  expect(snapshot.discoveries[f.binding.generation].artifacts[reference].originalBytes).toEqual(original);
  expect(f.transport.calls.filter(call => call.method === 'read').every(call => call.maxBytes === MAX_SEGMENT_BYTES)).toBe(true);
});

it.each(['authorization', 'access', 'missing-dataset', 'retryable'] as const)('persists classified %s descriptor failure and resumes only permitted failures', async code => {
  const f = await fixture(); await finish(f.repo); f.transport.queue('readDescriptor', { type: 'error', code });
  const status = await f.runner.run(); const snapshot = await f.remote.snapshot();
  expect(snapshot.discoveries[f.binding.generation].error).toBe(code); expect(Object.keys(snapshot.outbox)).toHaveLength(1);
  expect(status).toBe(code === 'authorization' ? 'Authorization required'
    : ['access', 'missing-dataset'].includes(code) ? 'Recovery required' : 'Offline / Retry pending');
  if (['authorization', 'retryable'].includes(code)) await settle(f.repo, f.transport);
});

it('rejects changed descriptor identity before any publication or remote receive', async () => {
  const f = await fixture(); await finish(f.repo);
  f.transport.replaceDescriptor(f.binding, encodeUtf8(JSON.stringify({ ...f.descriptor, datasetId: uuid(900) })));
  expect(await f.runner.run()).toBe('Recovery required');
  expect((await f.remote.snapshot()).blocked?.classification).toBe('integrity');
  expect(f.transport.calls.map(call => call.method)).toEqual(['readDescriptor']);
});

it.each(['reserve', 'seal', 'confirm'] as const)('cancels after durable %s and resumes it after reopen without fabricating acknowledgement', async boundary => {
  const f = await fixture(); await finish(f.repo); const controller = new AbortController(); cancelAfter(f.remote, boundary, controller);
  expect(await f.runner.run({ signal: controller.signal })).toBe('Offline / Retry pending');
  const snapshot = await f.remote.snapshot(); const publication = Object.values(snapshot.publications)[0];
  expect(publication.state).toBe({ reserve: 'reserved', seal: 'sealed', confirm: 'confirmed' }[boundary]);
  expect(Object.keys(snapshot.outbox)).toHaveLength(1); const attempts = f.transport.calls.filter(call => call.method === 'publish').length;
  f.repo.close(); const reopened = await open(f.repo.db.name); await settle(reopened, f.transport);
  expect(Object.keys((await reopened.remote().snapshot()).outbox)).toHaveLength(0);
  if (boundary === 'confirm') expect(f.transport.calls.filter(call => call.method === 'publish')).toHaveLength(attempts);
});

it.each(['publish', 'publishAccepted'] as const)('cancels during %s and retries the persisted identity and exact bytes after reload', async boundary => {
  const f = await fixture(); await finish(f.repo); const controller = new AbortController(); const hold = f.transport.holdNext(boundary);
  const running = f.runner.run({ signal: controller.signal }); await hold.entered; controller.abort(); hold.release();
  expect(await running).toBe('Offline / Retry pending'); const publication = Object.values((await f.remote.snapshot()).publications)[0];
  expect(publication.state).toBe('unknown'); expect(f.transport.references(f.binding)).toHaveLength(boundary === 'publishAccepted' ? 1 : 0);
  f.repo.close(); const reopened = await open(f.repo.db.name); await settle(reopened, f.transport);
  const attempts = f.transport.calls.filter(call => call.method === 'publish'); expect(attempts).toHaveLength(2);
  expect(attempts[1]).toMatchObject({ segmentId: publication.segmentId, bytes: publication.bytes, retryHandle: attempts[0].retryHandle });
  expect(f.transport.references(f.binding)).toHaveLength(1);
});

it.each(['enumerate', 'recordPage', 'read'] as const)('cancels at %s without losing discovered work or accepting uncommitted bytes', async boundary => {
  const f = await fixture(); const reference = f.transport.put(f.binding, wire(f.descriptor, 1)); const controller = new AbortController();
  let held: ReturnType<AsyncAdversarialTransport['holdNext']> | undefined;
  if (boundary === 'enumerate') held = f.transport.holdNext('enumerate');
  else if (boundary === 'recordPage') cancelAfter(f.remote, 'recordPage', controller);
  else {
    const read = f.transport.read.bind(f.transport);
    f.transport.read = async (...args) => { const result = await read(...args); controller.abort(); return result; };
  }
  const running = f.runner.run({ signal: controller.signal });
  if (held) { await held.entered; controller.abort(); held.release(); }
  expect(await running).toBe('Offline / Retry pending'); const snapshot = await f.remote.snapshot(); expect(snapshot.operations).toEqual({});
  if (boundary !== 'enumerate') expect(snapshot.discoveries[f.binding.generation].artifacts[reference].state).toBe('pending');
  if (boundary === 'recordPage') expect(f.transport.calls.filter(call => call.method === 'read')).toHaveLength(0);
  f.repo.close(); const reopened = await open(f.repo.db.name); await settle(reopened, f.transport);
  expect(Object.keys((await reopened.remote().snapshot()).operations)).toHaveLength(1);
});

it('stops a worker whose binding generation changes while descriptor access is awaited', async () => {
  const f = await fixture(); const hold = f.transport.holdNext('readDescriptor'); const running = f.runner.run(); await hold.entered;
  const current = await f.remote.bind(f.target); const before = await f.remote.snapshot(); hold.release(); await running;
  expect(await f.remote.snapshot()).toEqual(before); expect(current.generation).toBe(f.binding.generation + 1);
  expect(f.transport.calls.map(call => call.method)).toEqual(['readDescriptor']);
  expect(await new SyncRunner(f.remote, f.transport).run()).toBe('Synced');
});

it('fences a stale accepted upload after explicit same-target resume and retries its exact retained intent', async () => {
  const f = await fixture(); await finish(f.repo); const hold = f.transport.holdNext('publishAccepted');
  const running = f.runner.run(); await hold.entered;
  const current = await f.remote.bind({ ...f.target, resumePublications: true }); const before = await f.remote.snapshot();
  expect(Object.values(before.publications)[0].state).toBe('unknown');
  hold.release(); await running; expect(await f.remote.snapshot()).toEqual(before);
  expect(current.generation).toBe(f.binding.generation + 1); await settle(f.repo, f.transport);
  const attempts = f.transport.calls.filter(call => call.method === 'publish'); expect(attempts).toHaveLength(2);
  expect(attempts[1]).toMatchObject({ segmentId: attempts[0].segmentId, bytes: attempts[0].bytes, retryHandle: attempts[0].retryHandle });
  expect(f.transport.references(current)).toHaveLength(1);
});
