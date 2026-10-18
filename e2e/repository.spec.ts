import { test, expect, type Page } from '@playwright/test';
import { legacyFixture, stamp } from './fixtures/legacy';
import type {} from './fixtures/repository-harness';

const harnessUrl = 'http://127.0.0.1:4174/e2e/fixtures/repository.html';
async function harness(page: Page) {
  // Repository isolation tests deliberately have no lifetime locks or app queues.
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined }));
  await page.goto(harnessUrl); await page.waitForFunction(() => !!window.storageHarness);
}
async function open(page: Page, name: string, initialize = true) {
  return page.evaluate(async ({ name, initialize }) => {
    const repo = window.storageRepository = await window.storageHarness.LocalRepository.open(name);
    if (initialize) return repo.initialize();
    return null;
  }, { name, initialize });
}
async function snapshot(page: Page) {
  return page.evaluate(() => window.storageHarness.rawSnapshot(window.storageRepository.db));
}
async function begin(page: Page) {
  return page.evaluate(async stamp => {
    const { active } = await window.storageRepository.acquireOwner(crypto.randomUUID());
    return window.storageRepository.saveActive(window.storageHarness.pin(active), {
      ...active, id: active.id ?? crypto.randomUUID(), startedAt: active.startedAt ?? stamp, state: 'paused', focusMs: 123.75, description: 'Browser work',
    });
  }, stamp);
}

test('native fresh install, committed reload, writer/high-water durability and active-free sync snapshot', async ({ page }) => {
  const name = crypto.randomUUID(); await harness(page); const initial = await open(page, name); const active = await begin(page);
  const session = await page.evaluate(async ({ active, stamp }) => window.storageRepository.finish(window.storageHarness.pin(active), 123.75, stamp, 'Browser work'), { active, stamp });
  const before = await snapshot(page);
  expect(before.operations).toHaveLength(1); expect(before.outbox).toHaveLength(1); expect(before.receipts).toHaveLength(1);
  expect(before.active[0].state).toBe('idle'); expect(session.focusDurationMs).toBe(123);
  await page.reload(); await page.waitForFunction(() => !!window.storageHarness); const reopened = await open(page, name);
  expect(reopened!.installation).toEqual(initial!.installation); expect(reopened!.collection.highWater).toBe(1);
  expect(await snapshot(page)).toEqual(before);
  const sync = await page.evaluate(() => window.storageRepository.syncState());
  expect(Object.keys(sync).sort()).toEqual(['descriptor', 'highWater', 'operations', 'outbox', 'writerId']);
});

test('native schema-1 upgrade preserves exact history/journal/tombstones/receipts and is idempotent after reopen', async ({ page }) => {
  const name = crypto.randomUUID(); await harness(page); await page.evaluate(name => window.storageHarness.seedLegacy(name), name);
  const fixture = legacyFixture(); await open(page, name); const raw = await snapshot(page);
  for (const store of ['collections', 'history', 'operations', 'outbox', 'receipts'] as const) expect(raw[store]).toEqual(fixture[store]);
  expect(raw.active).toEqual([fixture.active]); expect(raw.evidence).toEqual([]);
  await page.reload(); await page.waitForFunction(() => !!window.storageHarness); await open(page, name);
  expect(await snapshot(page)).toEqual(raw);
  const session = await page.evaluate(async stamp => {
    const { active } = await window.storageRepository.acquireOwner(crypto.randomUUID());
    return window.storageRepository.finish(window.storageHarness.pin(active), 987.75, stamp, active.description);
  }, stamp);
  const after = await snapshot(page); expect(after.collections[0].highWater).toBe(8);
  expect(after.operations).toHaveLength(5); expect(session.description).toBe('Paused draft');
});

test('two independent tabs serialize counters and reject competing same-base editors without Web Locks', async ({ page, context }) => {
  const name = crypto.randomUUID(); await harness(page); await page.evaluate(name => window.storageHarness.seedLegacy(name), name); await open(page, name);
  const second = await context.newPage(); await harness(second); await open(second, name);
  const fixture = legacyFixture(); const base = fixture.operations[1];
  // Both commands use the same base read before either write starts.
  const attempt = (tab: Page, description: string) => tab.evaluate(async ({ base, description }) => {
    try { return { ok: await window.storageRepository.edit(base.datasetId, base.opId, { ...base.payload!, description }) }; }
    catch (error) { return { code: (error as { code: string }).code }; }
  }, { base, description });
  const outcomes = await Promise.all([attempt(page, 'Tab A'), attempt(second, 'Tab B')]);
  expect(outcomes.filter(x => x.ok)).toHaveLength(1); expect(outcomes.filter(x => x.code === 'stale-editor')).toHaveLength(1);
  const active = await begin(page);
  await page.evaluate(async ({ active, stamp }) => window.storageRepository.finish(window.storageHarness.pin(active), 123, stamp, 'Second entity'), { active, stamp });
  const view = await page.evaluate(() => window.storageRepository.view());
  await Promise.all(view.history.map((entry, i) => (i ? second : page).evaluate(async entry => {
    return window.storageRepository.edit(entry.datasetId, entry.winner.opId, { ...entry.winner.payload!, description: `${entry.winner.payload!.description} changed` });
  }, entry)));
  const state = await page.evaluate(() => window.storageRepository.syncState());
  expect(state.highWater).toBe(11);
  expect(state.operations.map(x => x.lamportCounter).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 8, 9, 10, 11]);
  expect(state.outbox).toHaveLength(8);
});

test('obsolete active owners cannot Finish; racing duplicate Finish returns one durable outcome after reload', async ({ page, context }) => {
  const name = crypto.randomUUID(); await harness(page); await open(page, name); const stale = await begin(page);
  const second = await context.newPage(); await harness(second); await open(second, name);
  const recovered = await second.evaluate(() => window.storageRepository.acquireOwner(crypto.randomUUID()));
  const staleResult = await page.evaluate(async ({ stale, stamp }) => {
    try { await window.storageRepository.finish(window.storageHarness.pin(stale), 10, stamp, 'Obsolete'); return ''; }
    catch (error) { return (error as { code: string }).code; }
  }, { stale, stamp });
  expect(staleResult).toBe('stale-owner');
  const finish = (tab: Page, description: string) => tab.evaluate(async ({ active, description, stamp }) =>
    window.storageRepository.finish(window.storageHarness.pin(active), 123, stamp, description), { active: recovered.active, description, stamp });
  const outcomes = await Promise.all([finish(page, 'A'), finish(second, 'B')]); expect(outcomes[0]).toEqual(outcomes[1]);
  await second.reload(); await second.waitForFunction(() => !!window.storageHarness); await open(second, name);
  expect(await finish(second, 'Retry')).toEqual(outcomes[0]);
  const state = await snapshot(second); expect(state.operations).toHaveLength(1); expect(state.outbox).toHaveLength(1); expect(state.receipts).toHaveLength(1);
});

for (const point of ['operations', 'history', 'outbox', 'collections', 'receipts', 'active', 'before-commit']) {
  test(`native Finish transaction.abort at ${point} retains every old record after reopen`, async ({ page }) => {
    const name = crypto.randomUUID(); await harness(page); await open(page, name); const active = await begin(page); const before = await snapshot(page);
    const failure = await page.evaluate(async ({ active, point, stamp }) => {
      const repo = window.storageRepository;
      repo.fault = (actual, tx) => { if (actual === point) tx.abort(); };
      try { await repo.finish(window.storageHarness.pin(active), 123, stamp, 'Aborted'); return 'unexpected success'; }
      catch { return 'aborted'; }
      finally { repo.fault = undefined; }
    }, { active, point, stamp });
    expect(failure).toBe('aborted'); await page.reload(); await page.waitForFunction(() => !!window.storageHarness); await open(page, name);
    expect(await snapshot(page)).toEqual(before);
  });
}

test('native immutable-key ConstraintError aborts completion without overwriting the original operation', async ({ page }) => {
  const name = crypto.randomUUID(); await harness(page); await page.evaluate(name => window.storageHarness.seedLegacy(name), name); await open(page, name); const before = await snapshot(page);
  const result = await page.evaluate(async ({ name, stamp }) => {
    const op = (await window.storageRepository.syncState()).operations[0]; window.storageRepository.close();
    const repo = window.storageRepository = await window.storageHarness.LocalRepository.open(name, () => op.opId);
    const active = (await repo.view()).active;
    try { await repo.finish(window.storageHarness.pin(active), 123, stamp, 'Collision', crypto.randomUUID()); return ''; }
    catch (error) { return (error as Error).name; }
  }, { name, stamp });
  expect(result).toBe('ConstraintError'); expect(await snapshot(page)).toEqual(before);
});

test('response lost after native commit replays the same completion through its persisted receipt', async ({ page }) => {
  const name = crypto.randomUUID(); await harness(page); await open(page, name); const active = await begin(page);
  await page.evaluate(async ({ active, stamp }) => {
    const repo = window.storageRepository; repo.fault = point => { if (point === 'after-commit') throw new Error('lost response'); };
    try { await repo.finish(window.storageHarness.pin(active), 123, stamp, 'Original'); } catch { /* ambiguous result */ }
  }, { active, stamp });
  const committed = await snapshot(page);
  await page.reload(); await page.waitForFunction(() => !!window.storageHarness); await open(page, name);
  const replay = await page.evaluate(async ({ active, stamp }) => window.storageRepository.finish(window.storageHarness.pin(active), 999, stamp, 'Retried'), { active, stamp });
  expect(replay.description).toBe('Original'); expect(await snapshot(page)).toEqual(committed);
});

for (const boundary of ['operations', 'receipts']) {
  test(`closing a context during an uncommitted Finish after ${boundary} cannot leave partial effects`, async ({ page, context }) => {
    const name = crypto.randomUUID(); await harness(page); await open(page, name); const active = await begin(page); const before = await snapshot(page);
    await page.evaluate(({ active, stamp, boundary }) => {
      const repo = window.storageRepository;
      repo.fault = (point, tx) => {
        if (point !== boundary) return;
        // Keep this *native* transaction pending until the document is destroyed.
        // These requests do not change state; no timer/network await is used.
        const keepOpen = () => { const req = tx.objectStore('meta').count(); req.onsuccess = keepOpen; };
        keepOpen(); window.storagePhase = 'uncommitted';
      };
      void repo.finish(window.storageHarness.pin(active), 123, stamp, 'Interrupted').catch(() => {});
    }, { active, stamp, boundary });
    await page.waitForFunction(() => window.storagePhase === 'uncommitted'); await page.close({ runBeforeUnload: false });
    const successor = await context.newPage(); await harness(successor); await open(successor, name);
    expect(await snapshot(successor)).toEqual(before);
  });
}

test('aborted versionchange restores schema 1 and original data; the real upgrade can retry', async ({ page }) => {
  const name = crypto.randomUUID(); await harness(page); await page.evaluate(name => window.storageHarness.seedLegacy(name), name);
  const result = await page.evaluate(async name => {
    const original = IDBObjectStore.prototype.createIndex;
    IDBObjectStore.prototype.createIndex = function (...args: Parameters<typeof original>) {
      const index = original.apply(this, args);
      if (this.name === 'receipts') this.transaction.abort();
      return index;
    };
    let failure = '';
    try { await window.storageHarness.LocalRepository.open(name); }
    catch (error) { failure = (error as Error).name; }
    finally { IDBObjectStore.prototype.createIndex = original; }
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open(name); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const version = db.version; const raw = await window.storageHarness.rawSnapshot(db); db.close(); return { failure, version, raw };
  }, name);
  expect(result.failure).toBe('AbortError'); expect(result.version).toBe(1); expect(result.raw.operations).toEqual(legacyFixture().operations);
  await open(page, name); expect((await snapshot(page)).operations).toEqual(result.raw.operations);
});

test('a blocked old tab preserves schema-1 data and permits upgrade after the connection closes', async ({ page, context }) => {
  const name = crypto.randomUUID(); await harness(page); await page.evaluate(async name => {
    await window.storageHarness.seedLegacy(name);
    window.legacyConnection = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open(name, 1); req.onsuccess = () => resolve(req.result); });
  }, name);
  const second = await context.newPage(); await harness(second);
  const result = await second.evaluate(async name => {
    try { await window.storageHarness.LocalRepository.open(name); return ''; }
    catch (error) { return (error as { code: string }).code; }
  }, name);
  expect(result).toBe('storage-blocked'); await page.evaluate(() => window.legacyConnection!.close());
  await open(second, name); expect((await snapshot(second)).operations).toEqual(legacyFixture().operations);
});

test('migration refuses projection-only data without deleting or reauthoring it', async ({ page }) => {
  const name = crypto.randomUUID(); await harness(page); await page.evaluate(name => window.storageHarness.seedLegacy(name), name); await open(page, name, false);
  await page.evaluate(async () => {
    const db = window.storageRepository.db; const tx = db.transaction('operations', 'readwrite'); tx.objectStore('operations').clear();
    await new Promise<void>(resolve => { tx.oncomplete = () => resolve(); });
  });
  const before = await snapshot(page);
  const code = await page.evaluate(async () => { try { await window.storageRepository.initialize(); return ''; } catch (error) { return (error as { code: string }).code; } });
  expect(code).toBe('recovery'); expect(await snapshot(page)).toEqual(before);
});

for (const kind of ['edit', 'delete'] as const) {
  test(`native ${kind} abort rolls back domain/operation/outbox/high-water together`, async ({ page }) => {
    const name = crypto.randomUUID(); await harness(page); await page.evaluate(name => window.storageHarness.seedLegacy(name), name); await open(page, name);
    const before = await snapshot(page);
    const result = await page.evaluate(async kind => {
      const repo = window.storageRepository; const entry = (await repo.view()).history[0];
      repo.fault = (point, tx) => { if (point === 'outbox') tx.abort(); };
      try {
        if (kind === 'edit') await repo.edit(entry.datasetId, entry.winner.opId, { ...entry.winner.payload!, description: 'Unsaved' });
        else await repo.delete(entry.datasetId, entry.id, entry.winner.opId);
        return 'unexpected success';
      } catch { return 'aborted'; }
      finally { repo.fault = undefined; }
    }, kind);
    expect(result).toBe('aborted'); expect(await snapshot(page)).toEqual(before);
    await page.reload(); await page.waitForFunction(() => !!window.storageHarness); await open(page, name); expect(await snapshot(page)).toEqual(before);
  });
}

test('native adoption abort leaves its marker and repair uncommitted, then resumes on reopen', async ({ page }) => {
  const name = crypto.randomUUID(); await harness(page); await page.evaluate(name => window.storageHarness.seedLegacy(name), name); await open(page, name, false);
  const before = await snapshot(page);
  const result = await page.evaluate(async () => {
    const repo = window.storageRepository; repo.fault = (point, tx) => { if (point === 'meta') tx.abort(); };
    try { await repo.initialize(); return 'unexpected success'; } catch { return 'aborted'; }
    finally { repo.fault = undefined; }
  });
  expect(result).toBe('aborted'); expect(await snapshot(page)).toEqual(before);
  await page.reload(); await page.waitForFunction(() => !!window.storageHarness); await open(page, name);
  expect((await snapshot(page)).operations).toEqual(before.operations);
});
