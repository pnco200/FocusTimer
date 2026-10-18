import { test, expect, type Page } from '@playwright/test';
import type {} from './fixtures/remote-harness';

const harnessUrl = 'http://127.0.0.1:4174/e2e/fixtures/remote.html';
async function harness(page: Page) {
  await page.goto(harnessUrl);
  await page.waitForFunction(() => !!window.remoteHarness);
}
async function open(page: Page, name: string) {
  return page.evaluate(name => window.remoteHarness.open(name), name);
}
async function setup(page: Page, withWork = true) {
  const name = crypto.randomUUID(); await harness(page); await open(page, name);
  if (withWork) await page.evaluate(() => window.remoteHarness.finish());
  const binding = await page.evaluate(() => window.remoteHarness.bind());
  return { name, binding };
}
async function reopen(page: Page, name: string) {
  await page.reload(); await page.waitForFunction(() => !!window.remoteHarness); return open(page, name);
}
async function raw(page: Page) {
  return page.evaluate(() => window.remoteHarness.rawSnapshot(window.remoteLocal.db));
}

test('native schema-2 migration retains all local IDs and pending membership without fabricating remote state', async ({ page }) => {
  const name = crypto.randomUUID(); await harness(page);
  const before = await page.evaluate(name => window.remoteHarness.seedSchemaTwo(name), name);
  const state = await open(page, name); const migrated = await raw(page);
  for (const store of ['operations', 'outbox', 'collections', 'history', 'receipts', 'active']) expect(migrated[store]).toEqual(before[store]);
  expect(await page.evaluate(() => window.remoteLocal.db.version)).toBe(3);
  expect(migrated.publications).toEqual([]); expect(migrated.segments).toEqual([]); expect(migrated.artifacts).toEqual([]);
  expect(state.binding).toBeNull(); expect(Object.keys(state.publications)).toEqual([]); expect(Object.keys(state.segments)).toEqual([]);
  expect(Object.values(state.outbox).every((entry: any) => entry.reservation === null)).toBe(true);
  expect(await page.evaluate(() => window.remoteRepository.status())).toBe('Local only');
  await reopen(page, name); expect(await raw(page)).toEqual(migrated);
});

test('aborted native schema-2 upgrade retains the old version and retries without inventing remote state', async ({ page }) => {
  const name = crypto.randomUUID(); await harness(page);
  const before = await page.evaluate(name => window.remoteHarness.seedSchemaTwo(name), name);
  const aborted = await page.evaluate(async name => {
    const createStore = IDBDatabase.prototype.createObjectStore;
    IDBDatabase.prototype.createObjectStore = function (...args: Parameters<typeof createStore>) {
      const store = createStore.apply(this, args);
      if (store.name === 'segments') store.transaction.abort();
      return store;
    };
    let failure = '';
    try { await window.remoteHarness.open(name); } catch (error) { failure = (error as Error).name; }
    finally { IDBDatabase.prototype.createObjectStore = createStore; }
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const version = db.version; const state = await window.remoteHarness.rawSnapshot(db); db.close(); return { failure, version, state };
  }, name);
  expect(aborted.failure).toBe('AbortError'); expect(aborted.version).toBe(2); expect(aborted.state).toEqual(before);
  const migrated = await open(page, name);
  expect(Object.keys(migrated.operations)).toHaveLength(before.operations.length);
  expect(Object.keys(migrated.publications)).toHaveLength(0); expect(Object.keys(migrated.segments)).toHaveLength(0);
});

test('two native dedicated workers cannot reserve the same operation', async ({ page }) => {
  const { name, binding } = await setup(page);
  const outcomes = await page.evaluate(({ name, binding }) => window.remoteHarness.reserveInWorkers(name, binding), { name, binding });
  expect(outcomes.every(result => !result.error)).toBe(true);
  const reservations = outcomes.filter(result => result.publication);
  expect(reservations).toHaveLength(1); expect(outcomes.filter(result => result.publication === null)).toHaveLength(1);
  const state = await page.evaluate(() => window.remoteRepository.snapshot());
  const publication = reservations[0].publication!;
  expect(publication.operationIds).toHaveLength(1);
  expect(state.outbox[publication.operationIds[0]].reservation).toBe(publication.segmentId);
  expect(Object.keys(state.publications)).toEqual([publication.segmentId]);
});

test('reservation and sealed bytes survive committed-response loss and document reload', async ({ page }) => {
  const { name, binding } = await setup(page);
  const error = await page.evaluate(async binding => {
    window.remoteLocal.fault = point => { if (point === 'after-commit') throw new Error('Lost reservation response'); };
    try { await window.remoteRepository.reserve(binding); return ''; }
    catch (error) { return (error as Error).message; }
    finally { window.remoteLocal.fault = undefined; }
  }, binding);
  expect(error).toBe('Lost reservation response');
  const reserved = await page.evaluate(() => window.remoteRepository.snapshot());
  const [publication] = Object.values(reserved.publications) as any[];
  expect(publication.state).toBe('reserved'); expect(publication.bytes).toBeNull();
  const restored = await reopen(page, name); expect(restored).toEqual(reserved);
  const sealed = await page.evaluate(async ({ binding, segmentId }) => {
    const publication = await window.remoteRepository.seal(binding, segmentId);
    return { segmentId: publication.segmentId, bytes: Array.from(publication.bytes!), operationIds: publication.operationIds };
  }, { binding, segmentId: publication.segmentId });
  expect(sealed.segmentId).toBe(publication.segmentId); expect(sealed.operationIds).toEqual(publication.operationIds);
  const afterSeal = await raw(page); await reopen(page, name); expect(await raw(page)).toEqual(afterSeal);
  const retried = await page.evaluate(async ({ binding, segmentId }) => Array.from((await window.remoteRepository.seal(binding, segmentId)).bytes!), { binding, segmentId: publication.segmentId });
  expect(retried).toEqual(sealed.bytes);
});

test('native reservation abort rolls back publication identity and every membership', async ({ page }) => {
  const { binding } = await setup(page); const before = await raw(page);
  const result = await page.evaluate(async binding => {
    let hit = false;
    window.remoteLocal.fault = (point, tx) => { if (point === 'reserve.membership') { hit = true; tx.abort(); } };
    try { await window.remoteRepository.reserve(binding); return { hit, aborted: false }; }
    catch { return { hit, aborted: true }; }
    finally { window.remoteLocal.fault = undefined; }
  }, binding);
  expect(result).toEqual({ hit: true, aborted: true }); expect(await raw(page)).toEqual(before);
});

test('Finish and edits during upload and after confirmation remain pending through competing acknowledgements', async ({ page, context }) => {
  const { name, binding } = await setup(page);
  const publication = await page.evaluate(async binding => {
    const publication = await window.remoteRepository.reserve(binding);
    await window.remoteRepository.seal(binding, publication!.segmentId);
    return window.remoteRepository.beginAttempt(binding, publication!.segmentId);
  }, binding);
  await page.evaluate(async () => {
    const winner = (await window.remoteLocal.view()).history[0].winner;
    await window.remoteLocal.edit(winner.datasetId, winner.opId, { ...winner.payload!, description: 'Edited during upload' });
    await window.remoteHarness.finish('Finished during upload');
  });
  await page.evaluate(async ({ binding, segmentId }) => {
    const publication = (await window.remoteRepository.publications(binding)).find(value => value.segmentId === segmentId)!;
    await window.remoteRepository.confirm(binding, segmentId, { outcome: 'confirmed', segmentId, bytes: publication.bytes!, references: ['physical-upload'] });
    const view = await window.remoteLocal.view();
    const winner = view.history.find(entry => entry.winner.payload!.description === 'Finished during upload')!.winner;
    await window.remoteLocal.edit(winner.datasetId, winner.opId, { ...winner.payload!, description: 'Edited after confirmation' });
  }, { binding, segmentId: publication.segmentId });
  const beforeAck = await page.evaluate(() => window.remoteLocal.syncState());
  expect(beforeAck.outbox).toHaveLength(4);
  const second = await context.newPage(); await harness(second); await open(second, name);
  const acknowledge = (tab: Page) => tab.evaluate(({ binding, segmentId }) => window.remoteRepository.acknowledge(binding, segmentId), { binding, segmentId: publication.segmentId });
  await Promise.all([acknowledge(page), acknowledge(second)]);
  const afterAck = await page.evaluate(() => window.remoteRepository.snapshot());
  expect(Object.keys(afterAck.operations)).toHaveLength(4); expect(Object.keys(afterAck.outbox)).toHaveLength(3);
  expect(publication.operationIds.every(id => !(id in afterAck.outbox))).toBe(true);
  expect(Object.values(afterAck.outbox).every((row: any) => row.reservation === null)).toBe(true);
  expect(afterAck.publications[publication.segmentId].state).toBe('acknowledged');
});

test('unknown publication outcome survives reload and retries the same segment ID and exact bytes', async ({ page }) => {
  const { name, binding } = await setup(page);
  // Test-process byte storage survives page destruction. Its first committed
  // publication loses the response; retry verifies content before confirmation.
  const physical = new Map<string, number[]>();
  function publish(value: { segmentId: string; bytes: number[] }) {
    const retained = physical.get(value.segmentId);
    if (retained) {
      expect(value.bytes).toEqual(retained);
      return { outcome: 'already-present', ...value, references: ['verified-retry'] };
    }
    physical.set(value.segmentId, [...value.bytes]);
    throw new Error('Publication response lost');
  }
  const attempted = await page.evaluate(async binding => {
    const reservation = (await window.remoteRepository.reserve(binding))!;
    await window.remoteRepository.seal(binding, reservation.segmentId);
    const publication = await window.remoteRepository.beginAttempt(binding, reservation.segmentId);
    return { segmentId: publication.segmentId, bytes: Array.from(publication.bytes!) };
  }, binding);
  expect(() => publish(attempted)).toThrow('Publication response lost');
  expect(physical.get(attempted.segmentId)).toEqual(attempted.bytes);
  await page.evaluate(async ({ binding, segmentId }) => window.remoteRepository.unknown(binding, segmentId), { binding, segmentId: attempted.segmentId });
  const recovered = await reopen(page, name); expect(recovered.publications[attempted.segmentId].state).toBe('unknown');
  const retry = await page.evaluate(async ({ binding, segmentId }) => {
    const publication = await window.remoteRepository.beginAttempt(binding, segmentId);
    return { segmentId: publication.segmentId, bytes: Array.from(publication.bytes!), attempts: publication.attempts };
  }, { binding, segmentId: attempted.segmentId });
  expect(retry.segmentId).toBe(attempted.segmentId); expect(retry.bytes).toEqual(attempted.bytes); expect(retry.attempts).toBe(2);
  expect(Object.keys(recovered.outbox)).toHaveLength(1);
  const verified = publish(retry);
  await page.evaluate(async ({ binding, verified }) => {
    await window.remoteRepository.confirm(binding, verified.segmentId, { ...verified, bytes: new Uint8Array(verified.bytes) });
    await window.remoteRepository.acknowledge(binding, verified.segmentId);
  }, { binding, verified });
  const acknowledged = await page.evaluate(() => window.remoteRepository.snapshot());
  expect(acknowledged.publications[attempted.segmentId].state).toBe('acknowledged');
  expect(Object.keys(acknowledged.outbox)).toHaveLength(0); expect(physical.size).toBe(1);
});

test('same-target reconnect fences stale confirmations and acknowledgements and refuses retained-corpus retarget', async ({ page }) => {
  const { binding } = await setup(page);
  const result = await page.evaluate(async binding => {
    const remote = window.remoteRepository;
    const publication = (await remote.reserve(binding))!; const sealed = await remote.seal(binding, publication.segmentId);
    await remote.beginAttempt(binding, publication.segmentId);
    await remote.disconnect();
    const descriptor = (await window.remoteLocal.syncState()).descriptor;
    const fresh = await remote.bind({ account: binding.account, locator: binding.locator, descriptor, resumePublications: true });
    const codes: string[] = [];
    for (const work of [
      () => remote.confirm(binding, publication.segmentId, { outcome: 'confirmed', segmentId: publication.segmentId, bytes: sealed.bytes!, references: ['stale-physical'] }),
      () => remote.acknowledge(binding, publication.segmentId),
      () => remote.bind({ account: binding.account, locator: 'another-root', descriptor, resumePublications: true }),
    ]) {
      try { await work(); codes.push('unexpected success'); } catch (error) { codes.push((error as { code: string }).code); }
    }
    return { fresh, codes, publication: (await remote.publications(fresh))[0], state: await remote.snapshot() };
  }, binding);
  expect(result.fresh.generation).toBeGreaterThan(binding.generation);
  expect(result.codes.slice(0, 2)).toEqual(['stale-binding', 'stale-binding']);
  expect(['destination-transfer-required', 'pending-publication-rebind-required']).toContain(result.codes[2]);
  expect(result.publication.state).toBe('unknown'); expect(result.publication.binding).toEqual(result.fresh);
  expect(Object.keys(result.state.outbox)).toHaveLength(1);
});

test('reservation commit then crash and conflicting receive blocks sealing before any publication attempt', async ({ page }) => {
  const { name, binding } = await setup(page);
  const reservation = await page.evaluate(binding => window.remoteRepository.reserve(binding), binding);
  await reopen(page, name);
  const accepted = await page.evaluate(async ({ binding, segmentId }) => {
    const operation = window.remoteHarness.operation(binding.datasetId);
    const bytes = window.remoteHarness.segment(binding.datasetId, [operation], segmentId);
    await window.remoteRepository.receive(binding, 'opposing-artifact', bytes);
    return { bytes: Array.from(bytes), opId: operation.opId };
  }, { binding, segmentId: reservation!.segmentId });
  const beforeSeal = await raw(page);
  const result = await page.evaluate(async ({ binding, segmentId }) => {
    try { await window.remoteRepository.seal(binding, segmentId); return ''; } catch (error) { return (error as { code: string }).code; }
  }, { binding, segmentId: reservation!.segmentId });
  expect(result).toBe('integrity'); expect(await raw(page)).toEqual(beforeSeal);
  const state = await page.evaluate(() => window.remoteRepository.snapshot());
  expect(state.publications[reservation!.segmentId].bytes).toBeNull(); expect(state.publications[reservation!.segmentId].attempts).toBe(0);
  const acceptedBytes = await page.evaluate(async segmentId => Array.from((await window.remoteRepository.snapshot()).segments[segmentId].bytes), reservation!.segmentId);
  expect(acceptedBytes).toEqual(accepted.bytes);
  expect(state.operations[accepted.opId]).toBeTruthy(); expect(Object.keys(state.outbox)).toHaveLength(1);
});

test('own acknowledged upload missing before first enumeration remains a known obligation and cannot report Synced', async ({ page }) => {
  const { name, binding } = await setup(page);
  await page.evaluate(async binding => {
    const remote = window.remoteRepository;
    const publication = (await remote.reserve(binding))!; const sealed = await remote.seal(binding, publication.segmentId);
    await remote.beginAttempt(binding, publication.segmentId);
    await remote.confirm(binding, publication.segmentId, { outcome: 'confirmed', segmentId: publication.segmentId, bytes: sealed.bytes!, references: ['missing-before-first-list'] });
    await remote.acknowledge(binding, publication.segmentId);
  }, binding);
  await reopen(page, name);
  const result = await page.evaluate(async binding => {
    const remote = window.remoteRepository; const pass = await remote.beginPass(binding);
    await remote.recordPage(binding, pass.passId, { references: [], continuation: null, complete: true });
    const omitted = await remote.omittedReferences(binding); const reconciled = await remote.completePass(binding);
    await remote.runFailure(binding, { code: 'missing-object', message: 'Known confirmed artifact is unavailable' });
    return { omitted, reconciled, status: await remote.status(), state: await remote.snapshot() };
  }, binding);
  expect(result.omitted).toEqual(['missing-before-first-list']); expect(result.reconciled).toBe(false); expect(result.status).toBe('Recovery required');
  expect(Object.keys(result.state.operations)).toHaveLength(1); expect(Object.keys(result.state.outbox)).toHaveLength(0);
  expect(result.state.tombstones).toEqual([]);
});

test('reference-free acknowledgement stays unresolved until a subsequent verified discovery covers it', async ({ page }) => {
  const { name, binding } = await setup(page);
  const publication = await page.evaluate(async binding => {
    const remote = window.remoteRepository; const reservation = (await remote.reserve(binding))!;
    const sealed = await remote.seal(binding, reservation.segmentId); await remote.beginAttempt(binding, reservation.segmentId);
    await remote.confirm(binding, reservation.segmentId, { outcome: 'confirmed', segmentId: reservation.segmentId, bytes: sealed.bytes! });
    await remote.acknowledge(binding, reservation.segmentId);
    return { segmentId: sealed.segmentId, bytes: Array.from(sealed.bytes!) };
  }, binding);
  await reopen(page, name);
  const result = await page.evaluate(async ({ binding, bytes }) => {
    const remote = window.remoteRepository; const first = await remote.beginPass(binding);
    await remote.recordPage(binding, first.passId, { references: [], continuation: null, complete: true });
    const firstComplete = await remote.completePass(binding); const firstStatus = await remote.status();
    const next = await remote.beginPass(binding);
    await remote.recordPage(binding, next.passId, { references: ['found-upload'], continuation: null, complete: true });
    await remote.receive(binding, 'found-upload', Uint8Array.from(bytes));
    return { firstComplete, firstStatus, secondComplete: await remote.completePass(binding), status: await remote.status() };
  }, { binding, bytes: publication.bytes });
  expect(result.firstComplete).toBe(false); expect(result.firstStatus).not.toBe('Synced'); expect(result.secondComplete).toBe(true); expect(result.status).toBe('Synced');
});

test('discovery page pending references and continuation commit together and survive an interrupted continued pass', async ({ page }) => {
  const { name, binding } = await setup(page, false);
  const pass = await page.evaluate(binding => window.remoteRepository.beginPass(binding), binding);
  await page.evaluate(({ binding, passId }) => window.remoteRepository.recordPage(binding, passId, { references: ['first-reference'], continuation: 'page-two', complete: false }), { binding, passId: pass.passId });
  await reopen(page, name);
  const restored = await page.evaluate(async binding => ({ pass: await window.remoteRepository.beginPass(binding), pending: await window.remoteRepository.pendingReferences(binding) }), binding);
  expect(restored.pass.passId).toBe(pass.passId); expect(restored.pass.checkpoint).toBe('page-two'); expect(restored.pending).toEqual(['first-reference']);
  const before = await raw(page);
  const aborted = await page.evaluate(async ({ binding, passId }) => {
    let hit = false;
    window.remoteLocal.fault = (point, tx) => { if (point === 'discover.checkpoint') { hit = true; tx.abort(); } };
    try { await window.remoteRepository.recordPage(binding, passId, { references: ['uncommitted-reference'], continuation: 'page-three', complete: false }); return { hit, aborted: false }; }
    catch { return { hit, aborted: true }; }
    finally { window.remoteLocal.fault = undefined; }
  }, { binding, passId: pass.passId });
  expect(aborted).toEqual({ hit: true, aborted: true }); expect(await raw(page)).toEqual(before);
  const continued = await page.evaluate(async ({ binding, passId }) => {
    const pass = await window.remoteRepository.recordPage(binding, passId, { references: [], continuation: 'page-three', complete: false });
    return { pass, complete: await window.remoteRepository.completePass(binding), status: await window.remoteRepository.status() };
  }, { binding, passId: pass.passId });
  expect(continued.pass.enumerationComplete).toBe(false); expect(continued.pass.checkpoint).toBe('page-three'); expect(continued.complete).toBe(false); expect(continued.status).not.toBe('Synced');
});

for (const boundary of ['receive.operations', 'receive.dedup', 'receive.applied']) {
  test(`native receive transaction abort at ${boundary} leaves corpus/projection/clock/dedup/applied marker unchanged after reload`, async ({ page }) => {
    const { name, binding } = await setup(page, false); const before = await raw(page);
    const result = await page.evaluate(async ({ binding, boundary }) => {
      const operation = window.remoteHarness.operation(binding.datasetId);
      const bytes = window.remoteHarness.segment(binding.datasetId, [operation]); let hit = false;
      window.remoteLocal.fault = (point, tx) => { if (point === boundary) { hit = true; tx.abort(); } };
      try { await window.remoteRepository.receive(binding, 'aborted-artifact', bytes); return { hit, aborted: false }; }
      catch { return { hit, aborted: true }; }
      finally { window.remoteLocal.fault = undefined; }
    }, { binding, boundary });
    expect(result).toEqual({ hit: true, aborted: true }); await reopen(page, name); expect(await raw(page)).toEqual(before);
  });
}

test('destroying a document with a native receive transaction outstanding cannot leave partial accepted effects', async ({ page, context }) => {
  const { name, binding } = await setup(page, false); const before = await raw(page);
  await page.evaluate(binding => {
    const operation = window.remoteHarness.operation(binding.datasetId);
    const bytes = window.remoteHarness.segment(binding.datasetId, [operation]);
    window.remoteLocal.fault = (point, tx) => {
      if (point !== 'receive.applied') return;
      const keepPending = () => { const request = tx.objectStore('meta').count(); request.onsuccess = keepPending; };
      keepPending(); window.remotePhase = 'uncommitted-receive';
    };
    void window.remoteRepository.receive(binding, 'interrupted-receive', bytes).catch(() => {});
  }, binding);
  await page.waitForFunction(() => window.remotePhase === 'uncommitted-receive'); await page.close({ runBeforeUnload: false });
  const successor = await context.newPage(); await harness(successor); await open(successor, name); expect(await raw(successor)).toEqual(before);
});

test('malformed segment after a valid-looking prefix accepts no operation and retains bounded quarantine evidence', async ({ page }) => {
  const { name, binding } = await setup(page, false); const before = await raw(page);
  const result = await page.evaluate(async binding => {
    const operation = window.remoteHarness.operation(binding.datasetId);
    const bytes = window.remoteHarness.segment(binding.datasetId, [operation, { ...operation, opId: crypto.randomUUID(), lamportCounter: 0 }]);
    let code = '';
    try { await window.remoteRepository.receive(binding, 'malformed-artifact', bytes); }
    catch (error) { code = (error as { code?: string; classification?: string }).classification ?? (error as { code: string }).code; }
    const afterRejection = await window.remoteHarness.rawSnapshot(window.remoteLocal.db);
    await window.remoteRepository.artifactFailure(binding, 'malformed-artifact', { classification: code, message: 'Invalid operation after prefix' }, bytes);
    return { code, afterRejection, size: bytes.length };
  }, binding);
  expect(result.code).toBe('malformed'); expect(result.afterRejection).toEqual(before);
  const state = await reopen(page, name); expect(Object.keys(state.operations)).toHaveLength(0); expect(state.highWater).toBe(0);
  expect(state.discoveries[binding.generation].artifacts['malformed-artifact'].rejectedByteLength).toBe(result.size);
  expect(await page.evaluate(() => window.remoteRepository.status())).toBe('Recovery required');
});

test('duplicate physical and operation delivery retain one operation while conflicting immutable IDs are rejected atomically', async ({ page }) => {
  const { binding } = await setup(page, false);
  const result = await page.evaluate(async binding => {
    const remote = window.remoteRepository; const operation = window.remoteHarness.operation(binding.datasetId);
    const segmentId = crypto.randomUUID(); const bytes = window.remoteHarness.segment(binding.datasetId, [operation], segmentId);
    await remote.receive(binding, 'physical-a', bytes); await remote.receive(binding, 'physical-a', bytes);
    await remote.receive(binding, 'physical-b', bytes);
    await remote.receive(binding, 'logical-duplicate', window.remoteHarness.segment(binding.datasetId, [operation]));
    const before = await window.remoteHarness.rawSnapshot(window.remoteLocal.db); const codes: string[] = [];
    for (const [reference, candidate] of [
      ['conflicting-segment', window.remoteHarness.segment(binding.datasetId, [{ ...operation, opId: crypto.randomUUID() }], segmentId)],
      ['conflicting-operation', window.remoteHarness.segment(binding.datasetId, [{ ...operation, payload: { ...operation.payload!, description: 'Changed immutable operation' } }])],
      ['physical-a', new TextEncoder().encode('malformed changed known physical object')],
    ] as const) {
      try { await remote.receive(binding, reference, candidate); codes.push('unexpected success'); }
      catch (error) { codes.push((error as { code?: string; classification?: string }).code ?? (error as { classification: string }).classification); }
    }
    return { codes, before, after: await window.remoteHarness.rawSnapshot(window.remoteLocal.db), state: await remote.snapshot() };
  }, binding);
  expect(result.codes).toEqual(['integrity', 'integrity', 'integrity']); expect(result.after).toEqual(result.before);
  expect(Object.keys(result.state.operations)).toHaveLength(1); expect(Object.keys(result.state.segments)).toHaveLength(2);
  expect(Object.keys(result.state.outbox)).toHaveLength(0); expect(result.state.highWater).toBe(50);
  expect(Object.keys(result.state.discoveries[binding.generation].artifacts)).toHaveLength(3);
});

test('competing native receivers recheck immutable operation identity inside their write transactions', async ({ page, context }) => {
  const { name, binding } = await setup(page, false);
  const operation = await page.evaluate(datasetId => window.remoteHarness.operation(datasetId), binding.datasetId);
  const second = await context.newPage(); await harness(second); await open(second, name);
  const receive = (tab: Page, description: string) => tab.evaluate(async ({ binding, operation, description }) => {
    const bytes = window.remoteHarness.segment(binding.datasetId, [{ ...operation, payload: { ...operation.payload!, description } }]);
    try { await window.remoteRepository.receive(binding, description, bytes); return 'accepted'; }
    catch (error) { return (error as { code: string }).code; }
  }, { binding, operation, description });
  const outcomes = await Promise.all([receive(page, 'Receiver A'), receive(second, 'Receiver B')]);
  expect(outcomes.sort()).toEqual(['accepted', 'integrity']);
  const state = await page.evaluate(() => window.remoteRepository.snapshot());
  expect(Object.keys(state.operations)).toEqual([operation.opId]); expect(Object.keys(state.segments)).toHaveLength(1);
  expect(Object.keys(state.discoveries[binding.generation].artifacts)).toHaveLength(1); expect(state.highWater).toBe(50);
});
