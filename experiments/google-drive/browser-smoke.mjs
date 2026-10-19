// LOCAL apparatus evidence only. Every Google/GIS response below is synthetic.
// Start serve.py first. No actual credentials, Google account or Drive is used.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';

const browser = await chromium.launch({
  ...(process.env.PROOF_CHROMIUM_PATH ? { executablePath: process.env.PROOF_CHROMIUM_PATH } : {}),
  headless: true, args: ['--no-sandbox'],
});
const context = await browser.newContext();
const files = new Map(), creates = [], ids = [];
let sequence = 0, currentAccount = 'synthetic-account';
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await context.route('https://accounts.google.com/**', route => route.fulfill({
  contentType: 'application/javascript', body: `
  globalThis.proofCallbacks = [];
  globalThis.google = { accounts: { oauth2: {
    initTokenClient(options) {
      if (options.include_granted_scopes !== false || options.scope !== 'https://www.googleapis.com/auth/drive.file') throw Error('scope proof failed');
      globalThis.proofCallbacks.push(options.callback);
      return { requestAccessToken() { if (!globalThis.holdProofAuth) options.callback({ access_token:'synthetic-apparatus-token', expires_in:3600, scope:options.scope }); } };
    }, hasGrantedAllScopes() { return true; }, revoke(_token, callback) { callback(); }
  } } };`,
}));
await context.route('https://www.googleapis.com/**', async route => {
  const request = route.request(), url = new URL(request.url());
  const send = (body, status = 200, type = 'application/json') => route.fulfill({ status, contentType: type,
    headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS', 'cache-control': 'no-store' },
    body: typeof body === 'string' ? body : JSON.stringify(body) });
  if (request.method() === 'OPTIONS') return send('');
  if (url.pathname.endsWith('/about')) return send({ user: { permissionId: currentAccount } });
  if (url.pathname.endsWith('/generateIds')) {
    const generated = Array.from({ length: Number(url.searchParams.get('count')) }, () => `synthetic_${++sequence}`);
    ids.push(...generated); return send({ ids: generated });
  }
  if (request.method() === 'POST') {
    let metadata, text;
    const body = request.postData();
    if (url.pathname.startsWith('/upload/')) {
      metadata = JSON.parse(body.match(/charset=UTF-8\r\n\r\n([\s\S]*?)\r\n--/)[1]);
      text = body.match(/Content-Type: application\/json\r\n\r\n([\s\S]*?)\r\n--/)[1];
    } else metadata = JSON.parse(body);
    // Inspect real committed browser IndexedDB before the simulated provider accepts.
    const durable = await page.evaluate(() => new Promise((resolve, reject) => {
      const open = indexedDB.open('focus-timer-google-drive-proof-v1', 1);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('intents');
        const get = tx.objectStore('intents').getAll();
        tx.oncomplete = () => { resolve(get.result); db.close(); };
        tx.onabort = () => reject(Error('local read failed'));
      };
    }));
    const retained = durable.find(row => [row.remoteId, row.rootId, row.segmentsId, row.descriptorId].includes(metadata.id));
    assert.ok(!JSON.stringify(durable).includes('synthetic-apparatus-token'), 'tokens must not enter IndexedDB');
    assert.ok(retained, 'generated ID must be durable before create');
    if (text !== undefined) assert.equal(text, retained.text, 'only exact retained bytes may be uploaded');
    creates.push({ id: metadata.id, text });
    if (files.has(metadata.id)) return send({ error: { errors: [] } }, 409);
    files.set(metadata.id, { ...metadata, text, trashed: false, isAppAuthorized: true, version: '1',
      ...(text === undefined ? {} : { size: String(Buffer.byteLength(text)) }) });
    return send({ id: metadata.id });
  }
  if (url.pathname.endsWith('/files')) {
    const query = url.searchParams.get('q');
    const parent = query.match(/^'([^']+)' in parents/)?.[1];
    const matches = [...files.values()].filter(file => parent ? file.parents?.includes(parent) : file.properties?.kind === 'root');
    const offset = Number(url.searchParams.get('pageToken')?.replace('opaque-apparatus-', '') ?? 0);
    return send({ files: matches.slice(offset, offset + 2), incompleteSearch: false,
      ...(offset + 2 < matches.length ? { nextPageToken: `opaque-apparatus-${offset + 2}` } : {}) });
  }
  const id = url.pathname.split('/').at(-1), file = files.get(id);
  if (!file) return send({ error: { errors: [{ reason: 'notFound' }] } }, 404);
  return url.searchParams.get('alt') === 'media' ? send(file.text, 200, 'application/json') : send(file);
});

const events = async () => (await page.locator('#log').textContent()).split('\n').filter(Boolean).map(JSON.parse);
async function click(id) { await page.locator(`#${id}`).click(); await page.waitForFunction(id => !document.getElementById(id).disabled, id); }
async function connect(role = 'A') {
  await page.locator(`#client${role}`).fill(`synthetic-web-${role}.apps.googleusercontent.com`);
  await page.locator('#client').selectOption(`client${role}`);
  await click('connect');
  await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Authorized')
    || document.getElementById('log').textContent.includes('authorization-failed'));
  assert.match(await page.locator('#status').textContent(), /^Authorized/);
}
try {
  await page.goto('http://127.0.0.1:8765/experiments/google-drive/');
  await page.waitForFunction(() => document.getElementById('rootIntent').options.length > 0);
  await connect(); await click('prepareRoot');
  const bootstrap = (await events()).find(row => row.event === 'bootstrap-intent-durable-no-content-created');
  assert.equal(files.size, 0, 'preparation cannot publish');
  await page.locator('#rootIntent').selectOption(bootstrap.id);
  await click('folders'); await click('descriptor');
  await page.locator('#rootId').fill(bootstrap.rootId); await click('inspect');
  await click('prepareSegment');
  const publication = (await events()).filter(row => row.event === 'segment-intent-durable-no-content-created').at(-1);
  await page.locator('#publication').selectOption(publication.id); await click('lose');
  assert.ok((await events()).some(row => row.event === 'publication-unconfirmed' && row.code === 'intentionally-lost-accepted-response'));
  const allocatedBeforeReload = ids.length;
  await page.reload(); await connect('B');
  await page.locator('#publication').selectOption(publication.id); await click('retry');
  const confirmed = (await events()).find(row => row.event === 'publication-confirmed-after-exact-readback');
  assert.equal(confirmed.create.status, 409); assert.equal(confirmed.exactBytes, true); assert.equal(confirmed.logicalIdentity, true);
  assert.equal(ids.length, allocatedBeforeReload, 'retry after reload must not allocate another identity');
  assert.equal(creates.filter(row => row.id === publication.remoteId).length, 2);
  await page.locator('#rootId').fill(bootstrap.rootId); await click('inspect');
  for (let i = 0; i < 4; i++) {
    await click('prepareSegment');
    const item = (await events()).filter(row => row.event === 'segment-intent-durable-no-content-created').at(-1);
    await page.locator('#publication').selectOption(item.id); await click('retry');
  }
  await click('startScan'); await click('nextPage'); await click('nextPage'); await click('nextPage');
  assert.deepEqual((await events()).filter(row => row.event === 'manual-scan-page').map(row => row.files.length), [2, 2, 1]);
  assert.equal((await events()).filter(row => row.event === 'manual-scan-page').at(-1).complete, true);
  await click('disconnect'); await page.evaluate(() => { globalThis.holdProofAuth = true; });
  await click('connect'); await click('disconnect');
  await page.evaluate(() => globalThis.proofCallbacks.at(-1)({ access_token: 'synthetic-stale-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/drive.file' }));
  assert.equal(await page.locator('#status').textContent(), 'Disconnected', 'stale callback must not restore authorization');
  const createsBeforeWrongAccount = creates.length;
  currentAccount = 'another-synthetic-account';
  await page.evaluate(() => { globalThis.holdProofAuth = false; });
  await connect(); await page.locator('#publication').selectOption(publication.id); await click('retry');
  assert.equal((await events()).filter(row => row.event === 'action-failed').at(-1).code, 'wrong-account-for-retained-intent');
  assert.equal(creates.length, createsBeforeWrongAccount, 'wrong account must not send retained bytes');
  await click('disconnect'); await page.evaluate(() => { globalThis.holdProofAuth = true; });
  await click('connect');
  await page.evaluate(() => globalThis.proofCallbacks.at(-1)({ access_token: 'synthetic-overbroad-token', expires_in: 3600,
    scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive' }));
  assert.equal((await events()).filter(row => row.event === 'authorization-failed').at(-1).code, 'unexpected-granted-scopes');
  assert.equal(await page.locator('#status').textContent(), 'Disconnected');
  assert.deepEqual(errors, []);
  assert.deepEqual((await events()).filter(row => row.event === 'action-failed').map(row => row.code), ['wrong-account-for-retained-intent']);
  assert.ok(!(await page.locator('#log').textContent()).includes('synthetic-apparatus-token'));
  assert.equal(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 0);
  console.log(JSON.stringify({ evidence: 'LOCAL SYNTHETIC ONLY; no Google provider proof', result: 'passed',
    browser: browser.version(), checks: ['durable IDs before create', 'exact bytes before upload', 'lost response remains unknown',
      'reload and client B retry same ID', '409 requires exact read-back', 'five objects in three pages', 'stale auth callback fenced',
      'wrong account cannot publish retained bytes', 'overbroad token rejected', 'no token in storage/diagnostics', 'no service worker'] }));
} catch (error) {
  console.error(JSON.stringify({ evidence: 'LOCAL SYNTHETIC ONLY', result: 'failed', events: await events(), errors }));
  throw error;
} finally { await browser.close(); }
