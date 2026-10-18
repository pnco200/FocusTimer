import { test, expect, type Page } from '@playwright/test';
import { validateOperation, validateUuid } from '../src/protocol/index.js';
import { legacyFixture, writeLegacyFixture } from './fixtures/legacy';

async function stored(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('focus-timer-local-v1');
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    try {
      const tx = db.transaction(['meta', 'collections', 'active', 'operations', 'evidence']);
      const read = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
      const [installation, collections, active, operations, evidence] = await Promise.all([
        read(tx.objectStore('meta').get('installation')), read(tx.objectStore('collections').getAll()),
        read(tx.objectStore('active').get('current')), read(tx.objectStore('operations').getAll()), read(tx.objectStore('evidence').getAll()),
      ]);
      return { installation, collections, active, operations, evidence };
    } finally { db.close(); }
  });
}

async function corruptInstallation(page: Page) {
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>(resolve => { const req = indexedDB.open('focus-timer-local-v1'); req.onsuccess = () => resolve(req.result); });
    const tx = db.transaction('meta', 'readwrite');
    const req = tx.objectStore('meta').get('installation');
    req.onsuccess = () => tx.objectStore('meta').put({ ...req.result, version: 99 }, 'installation');
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    db.close();
  });
}

test('production startup upgrades existing schema-1 history and active work without reauthoring it', async ({ page }) => {
  await page.route('**/migration-setup', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Migration setup</title>' }));
  await page.goto('/migration-setup');
  const fixture = legacyFixture();
  await page.evaluate(writeLegacyFixture, { name: 'focus-timer-local-v1', fixture });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await expect(page.getByText('Keep exact imported text', { exact: false })).toBeVisible();
  const after = await stored(page);
  expect(after.installation).toEqual(fixture.installation);
  expect(after.collections).toEqual(fixture.collections); expect(after.operations).toEqual(fixture.operations);
  expect(after.active.id).toBe(fixture.active.id); expect(after.active.focusMs).toBe(fixture.active.focusMs);
  expect(after.active.description).toBe(fixture.active.description); expect(after.active.state).toBe('paused');
  await page.reload(); await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  expect((await stored(page)).operations).toEqual(fixture.operations);
});

test('without native randomUUID, a fresh history supports timer, edit, delete and restart with valid v1 identities', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  const initial = await stored(page);
  await page.getByLabel('What are you focusing on?').fill('LAN-compatible work');
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await page.waitForTimeout(100);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const activeId = (await stored(page)).active.id;
  await page.reload();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  expect((await stored(page)).active.id).toBe(activeId);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByRole('button', { name: 'Finish session', exact: true }).click();
  await page.getByRole('button', { name: 'Edit LAN-compatible work', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Description', { exact: true }).fill('Updated work');
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Delete Updated work', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete session', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  const after = await stored(page);
  expect(after.installation).toEqual(initial.installation);
  expect(after.operations.map(op => op.operation).sort()).toEqual(['DELETE', 'UPSERT', 'UPSERT']);
  expect(after.operations).toHaveLength(3);
  for (const op of after.operations) expect(validateOperation(op)).toEqual(op);
  for (const id of [after.installation.writerId, after.installation.selectedDatasetId, after.active.owner.token, activeId]) {
    expect(validateUuid(id)).toBe(id);
  }
  await expect(page.getByText('Updated work', { exact: true })).toHaveCount(0);
});

test('new history recovery without randomUUID reports unavailable randomness and succeeds after retry', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined });
    const values = crypto.getRandomValues.bind(crypto);
    Object.defineProperty(crypto, 'getRandomValues', { get: () => (window as unknown as { disableEntropy?: boolean }).disableEntropy ? undefined : values });
  });
  await page.goto('/'); await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  const initial = await stored(page);
  await corruptInstallation(page); await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Your saved sessions need attention');
  await page.locator('summary').filter({ hasText: /^Advanced recovery$/ }).click();
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.evaluate(() => { (window as unknown as { disableEntropy: boolean }).disableEntropy = true; });
  await page.getByRole('button', { name: 'Start a new history', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('can’t create secure session IDs');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Focus Timer couldn’t start');
  const failed = await stored(page);
  expect(failed.collections).toEqual(initial.collections); expect(failed.installation.version).toBe(99); expect(failed.evidence).toEqual([]);
  await page.evaluate(() => { (window as unknown as { disableEntropy: boolean }).disableEntropy = false; });
  await page.getByRole('button', { name: 'Start a new history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  const fresh = await stored(page);
  expect(fresh.installation.selectedDatasetId).not.toBe(initial.installation.selectedDatasetId);
  expect(validateUuid(fresh.installation.selectedDatasetId)).toBe(fresh.installation.selectedDatasetId);
  expect(fresh.installation.writerId).toBe(initial.installation.writerId);
  expect(fresh.collections).toHaveLength(2); expect(fresh.evidence).toHaveLength(1);
  expect(fresh.evidence[0].installation).toEqual(failed.installation);
});

test('missing cryptographic APIs are an actionable startup failure, including when creating a new history', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined });
    Object.defineProperty(crypto, 'getRandomValues', { value: undefined });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Focus Timer couldn’t start');
  await expect(page.getByRole('alert')).toContainText('updated browser with secure random number support');
  await page.locator('summary').filter({ hasText: /^Advanced recovery$/ }).click();
  page.once('dialog', dialog => { void dialog.accept(); });
  await page.getByRole('button', { name: 'Start a new history', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('can’t create secure session IDs');
  const empty = await stored(page); expect(empty.collections).toEqual([]); expect(empty.installation).toBeUndefined();
});

test('unavailable IndexedDB is explained as a browser capability failure', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Focus Timer couldn’t start');
  await expect(page.getByRole('alert')).toContainText('Allow this site to save data, or try another browser');
  await page.locator('summary').filter({ hasText: /^Advanced recovery$/ }).click();
  await expect(page.getByRole('button', { name: 'Start a new history', exact: true })).toBeDisabled();
});
