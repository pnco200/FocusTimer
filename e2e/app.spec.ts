import { test, expect, type Page } from '@playwright/test';

async function ready(page: Page) {
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
}
async function state(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open('focus-timer-local-v1'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const tx = db.transaction(['active', 'operations', 'outbox', 'receipts', 'history']);
    const read = <T>(request: IDBRequest<T>) => new Promise<T>(resolve => { request.onsuccess = () => resolve(request.result); });
    const active = read(tx.objectStore('active').get('current'));
    const ops = read(tx.objectStore('operations').getAll()); const outbox = read(tx.objectStore('outbox').getAll());
    const receipts = read(tx.objectStore('receipts').getAll()); const history = read(tx.objectStore('history').getAll());
    const result = { active: await active, ops: await ops, outbox: await outbox, receipts: await receipts, history: await history }; db.close(); return result;
  });
}
async function shortSession(page: Page, title = 'Read a chapter') {
  await page.getByLabel('What are you focusing on?').fill(title);
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await page.waitForTimeout(150);
  await page.getByRole('button', { name: 'Finish session', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
}

async function seedEditableSession(page: Page, duration = 1_530_125, reversed = false) {
  const session = await page.evaluate(async ({ duration, reversed }) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const req = indexedDB.open('focus-timer-local-v1'); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    const tx = db.transaction(['meta', 'collections', 'operations', 'history', 'outbox'], 'readwrite');
    const read = <T>(request: IDBRequest<T>) => new Promise<T>(resolve => { request.onsuccess = () => resolve(request.result); });
    const installation = await read(tx.objectStore('meta').get('installation'));
    const collection = await read(tx.objectStore('collections').get(installation.selectedDatasetId));
    const session = { id: crypto.randomUUID(), description: 'Minute adjustment fixture', focusDurationMs: duration,
      startedAt: '2026-10-17T10:00:00.125Z', endedAt: reversed ? '2026-10-17T09:00:00.000Z' : '2026-10-17T10:10:00.375Z' };
    const operation = { protocolVersion: 1, schemaVersion: 1, opId: crypto.randomUUID(), datasetId: installation.selectedDatasetId,
      deviceId: installation.writerId, entityType: 'focusSession', entityId: session.id, operation: 'UPSERT', lamportCounter: ++collection.highWater, payload: session };
    tx.objectStore('operations').add(operation);
    tx.objectStore('history').put({ datasetId: operation.datasetId, id: session.id, winner: operation });
    tx.objectStore('outbox').add({ datasetId: operation.datasetId, opId: operation.opId, reservation: null });
    tx.objectStore('collections').put(collection);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    db.close(); return session;
  }, { duration, reversed });
  await page.reload(); await expect(page.getByRole('button', { name: 'Edit Minute adjustment fixture', exact: true })).toBeVisible();
  return session;
}

test('daily timer, pause exclusion, independent editing, search, exports, and terminal deletion', async ({ page }) => {
  await ready(page);
  await page.getByLabel('What are you focusing on?').fill('  Read a chapter  ');
  await page.getByRole('button', { name: 'Start focus', exact: true }).click(); await page.waitForTimeout(220);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const paused = (await state(page)).active; await page.waitForTimeout(500);
  expect((await state(page)).active.focusMs).toBe(paused.focusMs);
  await page.getByRole('button', { name: 'Resume', exact: true }).click(); await page.waitForTimeout(150);
  await page.getByRole('button', { name: 'Finish session', exact: true }).click();
  await expect(page.getByText('Read a chapter', { exact: true })).toBeVisible();
  const completed = await state(page); const original = completed.ops[0].payload;
  expect(completed.ops).toHaveLength(1); expect(completed.outbox).toHaveLength(1); expect(completed.receipts).toHaveLength(1);
  expect(original.focusDurationMs).toBeGreaterThan(100); expect(original.focusDurationMs).toBeLessThan(Date.parse(original.endedAt) - Date.parse(original.startedAt) - 300);
  await page.getByRole('button', { name: 'Edit Read a chapter', exact: true }).click();
  await page.getByLabel('Adjust duration', { exact: true }).fill('+2');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const changed = (await state(page)).ops.find(op => op.lamportCounter === 2).payload;
  expect(changed.id).toBe(original.id); expect(changed.startedAt).toBe(original.startedAt); expect(changed.endedAt).toBe(original.endedAt); expect(changed.focusDurationMs).toBe(original.focusDurationMs + 120_000);
  await page.getByRole('button', { name: 'Edit Read a chapter', exact: true }).click();
  await page.getByLabel('Adjust duration', { exact: true }).fill('-1');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  const adjusted = (await state(page)).ops.find(op => op.lamportCounter === 3).payload;
  expect(adjusted.startedAt).toBe(original.startedAt); expect(adjusted.endedAt).toBe(original.endedAt);
  expect(adjusted.focusDurationMs).toBe(original.focusDurationMs + 60_000);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await page.getByLabel('Search history').fill('DOES NOT MATCH'); await expect(page.getByText('No matching sessions.')).toBeVisible();
  await page.getByRole('button', { name: 'Export data', exact: false }).click();
  const historyDownload = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export history', exact: false }).click();
  const download = await historyDownload; expect(download.suggestedFilename()).toMatch(/history.*\.json$/);
  const file = await download.createReadStream(); let content = ''; for await (const part of file!) content += part.toString();
  expect(JSON.parse(content).sessions).toHaveLength(1); expect(JSON.parse(content).sessions[0].id).toBe(original.id);
  await page.getByRole('button', { name: 'Close dialog' }).click(); await page.getByLabel('Search history').fill('READ');
  await page.getByRole('button', { name: 'Delete Read a chapter', exact: true }).click();
  await page.getByRole('button', { name: 'Keep session', exact: true }).click(); expect((await state(page)).ops).toHaveLength(3);
  await page.getByRole('button', { name: 'Delete Read a chapter', exact: true }).click(); await page.getByRole('button', { name: 'Delete session', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); expect((await state(page)).ops.some(op => op.operation === 'DELETE')).toBe(true);
});

test('reload recovery retains checkpoint and draft paused, excludes closed time', async ({ page }) => {
  await ready(page); await page.getByLabel('What are you focusing on?').fill('A durable draft');
  await page.getByRole('button', { name: 'Start focus', exact: true }).click(); await page.waitForTimeout(5200);
  const checkpoint = (await state(page)).active; expect(checkpoint.focusMs).toBeGreaterThan(4000);
  await page.reload(); await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  const recovered = (await state(page)).active; expect(recovered.id).toBe(checkpoint.id); expect(recovered.focusMs).toBeGreaterThanOrEqual(checkpoint.focusMs);
  expect(recovered.description).toBe('A durable draft'); await page.waitForTimeout(300);
  expect((await state(page)).active.focusMs).toBe(recovered.focusMs);
});

test('second tab attaches live; deliberate recovery fences old owner and avoids duplicate finish', async ({ page, context }) => {
  await ready(page); await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  const first = (await state(page)).active; const second = await context.newPage(); await second.goto('/');
  await expect(second.getByText('Your timer is open in another tab.', { exact: false })).toBeVisible();
  await expect(second.getByRole('button', { name: 'Pause', exact: true })).toBeDisabled();
  expect((await state(page)).active.state).toBe('running'); expect((await state(page)).active.owner.token).toBe(first.owner.token);
  await second.getByRole('button', { name: 'Continue here', exact: true }).click(); await second.getByRole('dialog').getByRole('button', { name: 'Continue here', exact: true }).click();
  await expect(second.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
  expect((await state(page)).active.owner.generation).toBeGreaterThan(first.owner.generation);
  await second.getByRole('button', { name: 'Resume', exact: true }).click(); await second.waitForTimeout(100);
  await second.getByRole('button', { name: 'Finish session', exact: true }).click(); await expect(second.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  expect((await state(second)).ops).toHaveLength(1);
  await second.close(); await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  expect((await state(page)).ops).toHaveLength(1);
});

test('reset cancellation excludes dialog time and confirmed reset retains description/history', async ({ page }) => {
  await ready(page); await shortSession(page);
  await page.getByLabel('What are you focusing on?').fill('Keep this draft'); await page.getByRole('button', { name: 'Start focus', exact: true }).click(); await page.waitForTimeout(150);
  await page.getByRole('button', { name: 'Reset timer', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible();
  const paused = (await state(page)).active; await page.waitForTimeout(300);
  expect((await state(page)).active.focusMs).toBe(paused.focusMs);
  const beforeCancel = await page.evaluate(() => performance.now());
  await page.getByRole('button', { name: 'Keep session', exact: true }).click(); await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  // A pending draft save may checkpoint after resume. Bound the new focus by
  // the actual post-dialog interval instead of assuming no save has happened.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const afterPause = await page.evaluate(() => performance.now());
  const resumed = (await state(page)).active;
  expect(resumed.focusMs).toBeGreaterThanOrEqual(paused.focusMs);
  expect(resumed.focusMs).toBeLessThanOrEqual(paused.focusMs + afterPause - beforeCancel);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('button', { name: 'Reset timer', exact: true }).click(); await page.getByRole('dialog').getByRole('button', { name: 'Reset timer', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  expect((await state(page)).active.focusMs).toBe(0); expect((await state(page)).ops).toHaveLength(1);
  await expect(page.getByLabel('What are you focusing on?')).toHaveValue('Keep this draft');
});

test('aborted writes show truthful errors and keep active work until a successful retry', async ({ page }) => {
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<typeof original>) {
      if ((window as unknown as { failWrites: boolean }).failWrites) throw new DOMException('Injected quota failure', 'QuotaExceededError');
      return original.apply(this, args);
    };
  });
  await ready(page); await page.getByLabel('What are you focusing on?').fill('Do not lose this');
  await page.getByRole('button', { name: 'Start focus', exact: true }).click(); await page.waitForTimeout(150);
  await page.evaluate(() => { (window as unknown as { failWrites: boolean }).failWrites = true; });
  await page.getByRole('button', { name: 'Finish session', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Keep this tab open');
  await expect(page.getByRole('alert')).not.toContainText('Injected quota failure');
  await expect(page.getByLabel('What are you focusing on?')).toHaveValue('Do not lose this');
  const failed = await state(page); expect(failed.ops).toHaveLength(0); expect(failed.outbox).toHaveLength(0); expect(failed.active.state).toBe('running');
  await page.evaluate(() => { (window as unknown as { failWrites: boolean }).failWrites = false; });
  await page.getByRole('button', { name: 'Finish session', exact: true }).click(); await expect(page.getByRole('alert')).toHaveCount(0);
  expect((await state(page)).ops).toHaveLength(1);
});

test('production shell reloads offline; timer, edits, totals and exports remain available', async ({ page, context }) => {
  await ready(page); await shortSession(page, 'Offline work');
  await page.evaluate(async () => { await navigator.serviceWorker.ready; }); await page.reload();
  await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  await context.setOffline(true); await page.reload();
  await expect(page.getByText('Offline work', { exact: true })).toBeVisible();
  await shortSession(page, 'No network needed');
  await page.getByRole('button', { name: 'Edit Offline work', exact: true }).click();
  await page.getByLabel('Description', { exact: true }).fill('Edited offline'); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Edited offline', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Data & storage', exact: true }).click();
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Export CSV', exact: false }).click();
  expect((await download).suggestedFilename()).toContain('.csv');
  expect((await state(page)).ops).toHaveLength(3);
});

test('responsive light/dark layouts fit viewport; keyboard shortcut leaves text entry alone', async ({ page }, testInfo) => {
  await ready(page); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('What are you focusing on?').fill('Type space'); await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  await page.locator('h1').click(); await page.keyboard.press('Space');
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await page.keyboard.press('Space'); await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await page.screenshot({ path: `.artifacts/web-${testInfo.project.name}.png`, fullPage: true });
  await page.setViewportSize({ width: 320, height: 740 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('owner close releases lifetime lock; attached tab recovers paused automatically', async ({ page, context }) => {
  await ready(page); await page.getByLabel('What are you focusing on?').fill('Survives owner close');
  await page.getByRole('button', { name: 'Start focus', exact: true }).click(); await page.waitForTimeout(200);
  // A draft edit forces a short debounced checkpoint without needing a 5-second wait.
  await page.getByLabel('What are you focusing on?').fill('Survives owner close.'); await page.waitForTimeout(800);
  const saved = (await state(page)).active;
  const second = await context.newPage(); await second.goto('/');
  await expect(second.getByText('Your timer is open in another tab.', { exact: false })).toBeVisible();
  await page.close(); await expect(second.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  const recovered = (await state(second)).active;
  expect(recovered.id).toBe(saved.id); expect(recovered.focusMs).toBeGreaterThanOrEqual(saved.focusMs);
  expect(recovered.owner.generation).toBeGreaterThan(saved.owner.generation);
});

test('stale editor in another tab requires review rather than overwriting', async ({ page, context }) => {
  await ready(page); await shortSession(page, 'Shared history');
  const second = await context.newPage(); await second.goto('/'); await expect(second.getByText('Shared history', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Edit Shared history', exact: true }).click();
  await second.getByRole('button', { name: 'Edit Shared history', exact: true }).click();
  await second.getByLabel('Description', { exact: true }).fill('Changed elsewhere');
  await second.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(second.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel('Adjust duration', { exact: true }).fill('+1'); await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('changed or was deleted');
  expect((await state(page)).ops).toHaveLength(2);
  expect((await state(page)).ops.find(op => op.lamportCounter === 2).payload.description).toBe('Changed elsewhere');
});

test('lifecycle suspension fallback retains a durable checkpoint paused', async ({ page }) => {
  await ready(page); await page.getByRole('button', { name: 'Start focus', exact: true }).click(); await page.waitForTimeout(200);
  await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
  await expect.poll(async () => (await state(page)).active.focusMs).toBeGreaterThan(100);
  const saved = (await state(page)).active.focusMs; await page.waitForTimeout(250);
  await page.evaluate(() => document.dispatchEvent(new Event('resume')));
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  expect((await state(page)).active.focusMs).toBe(saved);
  await expect(page.getByRole('status')).toContainText('interrupted');
});

test('without lifetime locks, a fresh or reloaded idle timer is ready without recovery', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined });
    Object.defineProperty(crypto, 'randomUUID', { value: undefined });
  });
  await ready(page);
  await expect(page.getByRole('button', { name: 'Continue here', exact: true })).toHaveCount(0);
  await expect(page.getByText('Choose “Continue here”', { exact: false })).toHaveCount(0);
  await page.getByLabel('What are you focusing on?').fill('An idle draft');
  await expect.poll(async () => (await state(page)).active.description).toBe('An idle draft');
  const idle = (await state(page)).active;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Continue here', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('What are you focusing on?')).toHaveValue('An idle draft');
  expect((await state(page)).active.owner.generation).toBeGreaterThan(idle.owner.generation);
  await shortSession(page, 'Fallback mode');
  expect((await state(page)).ops).toHaveLength(1);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Continue here', exact: true })).toHaveCount(0);
});

for (const stateName of ['running', 'paused'] as const) {
  test(`without lifetime locks, a ${stateName} session still requires deliberate fenced recovery`, async ({ page, context }) => {
    await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined }));
    await ready(page);
    await page.getByRole('button', { name: 'Start focus', exact: true }).click();
    await page.waitForTimeout(100);
    if (stateName === 'paused') await page.getByRole('button', { name: 'Pause', exact: true }).click();
    const before = (await state(page)).active;
    const second = await context.newPage(); await second.goto('/');
    await expect(second.getByRole('button', { name: stateName === 'running' ? 'Pause' : 'Resume', exact: true })).toBeDisabled();
    await expect(second.getByRole('button', { name: 'Continue here', exact: true })).toBeVisible();
    await expect(second.locator('.owner-notice')).toContainText('Your timer is open in another tab');
    await second.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect((await state(second)).active).toEqual(before);
    await second.getByRole('button', { name: 'Continue here', exact: true }).click();
    await second.getByRole('dialog').getByRole('button', { name: 'Continue here', exact: true }).click();
    await expect(second.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeDisabled();
    const recovered = (await state(second)).active;
    expect(recovered.id).toBe(before.id); expect(recovered.focusMs).toBe(before.focusMs);
    expect(recovered.owner.generation).toBeGreaterThan(before.owner.generation);
    expect((await state(second)).ops).toEqual([]);
  });
}

test('editor keeps timestamps read-only and adjusts exact duration by signed whole minutes', async ({ page }, testInfo) => {
  await ready(page); const base = await seedEditableSession(page);
  await page.getByRole('button', { name: 'Edit Minute adjustment fixture', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('input[type="datetime-local"], input[type="date"], input[type="time"]')).toHaveCount(0);
  await expect(dialog.getByLabel(/Started|Finished|Focused seconds/)).toHaveCount(0);
  await expect(dialog.locator('time').nth(0)).toHaveAttribute('datetime', base.startedAt);
  await expect(dialog.locator('time').nth(1)).toHaveAttribute('datetime', base.endedAt);
  await expect(dialog.locator('.session-details')).toContainText('25 min 30 sec');
  await expect(dialog).not.toContainText('30.125');
  await dialog.getByLabel('Description', { exact: true }).fill('Edited description');
  await dialog.getByLabel('Adjust duration', { exact: true }).fill('+2');
  await expect(dialog.getByLabel('New duration', { exact: true })).toHaveText('27 min 30 sec');
  await page.screenshot({ path: `.artifacts/editor-${testInfo.project.name}.png`, fullPage: true });
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const positive = (await state(page)).ops.find(op => op.lamportCounter === 2).payload;
  expect(positive).toEqual({ ...base, description: 'Edited description', focusDurationMs: base.focusDurationMs + 120_000 });
  await page.getByRole('button', { name: 'Edit Edited description', exact: true }).click();
  await dialog.getByLabel('Adjust duration', { exact: true }).fill('-3');
  await expect(dialog.getByLabel('New duration', { exact: true })).toHaveText('24 min 30 sec');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(dialog).toHaveCount(0);
  const negative = (await state(page)).ops.find(op => op.lamportCounter === 3).payload;
  expect(negative).toEqual({ ...base, description: 'Edited description', focusDurationMs: base.focusDurationMs - 60_000 });
  await page.getByRole('button', { name: 'Edit Edited description', exact: true }).click();
  await expect(dialog.getByLabel('Adjust duration', { exact: true })).toHaveValue('0');
  await dialog.getByRole('button', { name: 'Save changes', exact: true }).click(); await expect(dialog).toHaveCount(0);
  expect((await state(page)).ops).toHaveLength(3);
});

test('editor rejects invalid minutes and nonpositive results without committing', async ({ page }) => {
  await ready(page); const base = await seedEditableSession(page, 120_000);
  await page.getByRole('button', { name: 'Edit Minute adjustment fixture', exact: true }).click();
  const dialog = page.getByRole('dialog'); const input = dialog.getByLabel('Adjust duration', { exact: true });
  for (const invalid of ['1.5', '-0.5', 'abc', '1e2', '', '+', '-2', '-3', '60000000']) {
    await input.fill(invalid);
    await expect(dialog.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
    await expect(dialog.getByRole('alert')).toBeVisible();
    await expect(dialog.getByLabel('New duration', { exact: true })).toHaveCount(0);
  }
  await input.fill('-2');
  await dialog.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect((await state(page)).ops).toHaveLength(1); expect((await state(page)).ops[0].payload).toEqual(base);
  await input.fill('0'); await expect(dialog.getByRole('button', { name: 'Save changes', exact: true })).toBeEnabled();
});

test('editor preserves existing reversed timestamps and blocks authoring a reversed snapshot', async ({ page }) => {
  await ready(page); const base = await seedEditableSession(page, 90_125, true);
  await page.getByRole('button', { name: 'Edit Minute adjustment fixture', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Description', { exact: true }).fill('Attempted edit');
  await dialog.getByLabel('Adjust duration', { exact: true }).fill('+1');
  await expect(dialog.getByRole('alert')).toContainText('finish time is earlier than its start time');
  await expect(dialog.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await dialog.locator('form').evaluate(form => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect((await state(page)).ops).toHaveLength(1); expect((await state(page)).ops[0].payload).toEqual(base);
});

test('data controls use product language; advanced exports remain keyboard accessible and lossless', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, 'persisted', { value: async () => true });
  });
  await ready(page); const base = await seedEditableSession(page);
  await expect(page.locator('.session-duration')).toHaveAttribute('title', '25 min 30 sec');
  await page.getByRole('button', { name: 'Data & storage', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Local data protection enabled.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Protect local data', exact: true })).toBeDisabled();
  await expect(dialog).toContainText('Clearing this browser’s data will remove your sessions.');
  await expect(dialog.getByRole('button', { name: 'Export full data archive', exact: false })).not.toBeVisible();
  const forbidden = /IndexedDB|application shell|checkpoint|eviction|lifecycle|milliseconds|dataset|journal|tombstone|Lamport|UUID|protocol|schema|focusDurationMs|retained operations/i;
  expect(await dialog.innerText()).not.toMatch(forbidden);
  const advanced = dialog.locator('summary').filter({ hasText: /^Advanced$/ });
  await advanced.focus(); await expect(advanced).toBeFocused(); await page.keyboard.press('Enter');
  await expect(dialog.getByRole('button', { name: 'Export full data archive', exact: false })).toBeVisible();
  for (const label of ['Export CSV', 'Export history', 'Export full data archive']) {
    const waiting = page.waitForEvent('download');
    await dialog.getByRole('button', { name: label, exact: false }).click();
    const file = await (await waiting).createReadStream(); let text = '';
    for await (const part of file!) text += part.toString();
    if (label === 'Export CSV') {
      expect(text).toContain('Title,Started (local),Finished (local),Effective time,Effective seconds');
      expect(text).toContain('1530.125\r\n');
    } else if (label === 'Export history') {
      expect(JSON.parse(text)).toEqual({ format: 'focus-timer-history', formatVersion: 1, sessions: [base] });
    } else {
      const archive = JSON.parse(text);
      expect(archive.format).toBe('focus-timer-dataset-archive'); expect(archive.coverage).toBe('local-replica');
      expect(archive.segments).toEqual([]); expect(archive.unsegmentedOperations).toHaveLength(1);
      expect(archive.unsegmentedOperations[0].payload).toEqual(base);
    }
  }
  await dialog.locator('summary').filter({ hasText: /^Timer recovery$/ }).click();
  await expect(dialog).toContainText('pause before closing the app or putting your device to sleep');
  expect(await dialog.innerText()).not.toMatch(forbidden);
  await page.screenshot({ path: `.artifacts/data-${testInfo.project.name}.png`, fullPage: true });
  await dialog.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Data & storage', exact: true })).toBeFocused();
  expect((await state(page)).ops[0].payload).toEqual(base);
});

test('storage and offline limitations remain clear when protection is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.storage, 'persisted', { value: async () => false });
    Object.defineProperty(navigator.storage, 'persist', { value: async () => false });
  });
  await ready(page); await page.getByRole('button', { name: 'Data & storage', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Protect local data', exact: true }).click();
  await expect(dialog.getByRole('status')).toContainText('couldn’t enable extra protection');
  await expect(dialog.getByRole('button', { name: 'Protect local data', exact: true })).toBeEnabled();
  await expect(dialog).not.toContainText('Local data protection enabled');
  await page.evaluate(() => window.dispatchEvent(new Event('focus-timer-offline-unavailable')));
  await expect(dialog).toContainText('reopening may need an internet connection');
});

test('startup failures preserve diagnostic detail without exposing it in product copy', async ({ page }) => {
  await page.addInitScript(() => {
    IDBFactory.prototype.open = function () { throw new DOMException('IndexedDB schema UUID journal diagnostic', 'UnknownError'); };
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Focus Timer couldn’t start');
  await expect(page.getByRole('alert')).toContainText('couldn’t open Focus Timer');
  await expect(page.getByRole('alert')).not.toContainText('IndexedDB');
  await expect(page.getByRole('button', { name: 'Try opening again', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start a new history', exact: true })).not.toBeVisible();
  await page.locator('summary').filter({ hasText: /^Advanced recovery$/ }).click();
  await expect(page.getByText('Your previous history will be kept for recovery', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start a new history', exact: true })).toBeDisabled();
});
