import { test, expect, type Page } from '@playwright/test';

async function active(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open('focus-timer-local-v1');
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise<any>((resolve, reject) => {
        const req = db.transaction('active').objectStore('active').get('current');
        req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      });
    } finally { db.close(); }
  });
}

async function startWithoutLifetimeLocks(page: Page) {
  await page.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined });
    Object.defineProperty(crypto, 'randomUUID', { value: undefined });
  });
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Start focus', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Start focus', exact: true }).click();
  await page.waitForTimeout(150);
}

async function visibility(page: Page, state: DocumentVisibilityState) {
  // Isolate hiding from freezing/reloading, which mobile Chrome may do separately.
  await page.evaluate(state => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
  }, state);
}

test('hiding saves the running timer without pausing it or relinquishing ownership', async ({ page }) => {
  await startWithoutLifetimeLocks(page);
  const before = await active(page);
  await visibility(page, 'hidden');
  await expect.poll(async () => (await active(page)).focusMs).toBeGreaterThan(before.focusMs);
  const hidden = await active(page);
  expect(hidden.state).toBe('running'); expect(hidden.owner).toEqual(before.owner);
  await expect(page.getByRole('button', { name: 'Pause', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Continue here', exact: true })).toHaveCount(0);
  await page.waitForTimeout(150); await visibility(page, 'visible'); await page.waitForTimeout(150);
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  const after = await active(page);
  expect(after.id).toBe(before.id); expect(after.startedAt).toBe(before.startedAt);
  expect(after.owner).toEqual(before.owner); expect(after.focusMs).toBeGreaterThan(hidden.focusMs);
});

test('simulated freeze and resume without lifetime locks retain the owner and recover paused without a takeover prompt', async ({ page }) => {
  await startWithoutLifetimeLocks(page);
  const before = await active(page); const documentStarted = await page.evaluate(() => performance.timeOrigin);
  // Playwright forces its pages focused; these DOM events test the fallback,
  // not physical Android scheduling or system sleep.
  await page.evaluate(() => document.dispatchEvent(new Event('freeze')));
  await expect.poll(async () => (await active(page)).focusMs).toBeGreaterThan(0);
  const checkpoint = (await active(page)).focusMs;
  await page.waitForTimeout(250);
  await page.evaluate(() => document.dispatchEvent(new Event('resume')));
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  await expect(page.getByRole('status')).toContainText('interrupted');
  await expect(page.getByRole('button', { name: 'Continue here', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStarted);
  const recovered = await active(page);
  expect(recovered.owner).toEqual(before.owner); expect(recovered.id).toBe(before.id);
  expect(recovered.state).toBe('paused'); expect(recovered.focusMs).toBe(checkpoint);
  await page.waitForTimeout(150);
  expect((await active(page)).focusMs).toBe(recovered.focusMs);
});

test('a one-tab reload without lifetime locks offers saved-session recovery without claiming another tab exists', async ({ page, context }) => {
  await startWithoutLifetimeLocks(page);
  await visibility(page, 'hidden'); await expect.poll(async () => (await active(page)).focusMs).toBeGreaterThan(0);
  const before = await active(page);
  const documentStarted = await page.evaluate(() => performance.timeOrigin);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue here', exact: true })).toBeVisible();
  await expect(page.locator('.owner-notice')).toContainText('Your saved session needs to be recovered');
  await expect(page.locator('.owner-notice')).not.toContainText('other tab');
  expect(context.pages()).toHaveLength(1);
  expect(await page.evaluate(() => performance.timeOrigin)).not.toBe(documentStarted);
  const saved = await active(page);
  expect(saved.id).toBe(before.id); expect(saved.owner).toEqual(before.owner);
  expect(saved.focusMs).toBeGreaterThanOrEqual(before.focusMs);
  await page.waitForTimeout(150); expect((await active(page)).focusMs).toBe(saved.focusMs);
  await page.getByRole('button', { name: 'Continue here', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('If another tab is running the timer');
  await page.getByRole('dialog').getByRole('button', { name: 'Continue here', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
  const recovered = await active(page);
  expect(recovered.id).toBe(saved.id); expect(recovered.focusMs).toBe(saved.focusMs);
  expect(recovered.owner.generation).toBeGreaterThan(saved.owner.generation);
});
