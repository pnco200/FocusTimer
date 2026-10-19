import { test, expect, type BrowserContext, type Route, type Page } from '@playwright/test';
import type {} from './fixtures/drive-harness';

const url = 'http://127.0.0.1:4174/e2e/fixtures/drive.html';
type Metadata = { id: string; mimeType: string; trashed: boolean; parents?: string[]; properties: Record<string, string>; size?: string };
/** Synthetic Drive HTTP state lives in Playwright, beyond any document's execution. */
class SyntheticDrive {
  objects = new Map<string, { metadata: Metadata; bytes?: Buffer }>();
  creates: { id: string; kind: string; conflict: boolean }[] = [];
  account = 'synthetic-account';
  loseNextSegment = false;
  unreadable = new Set<string>();
  private ids = 0;
  async attach(context: BrowserContext) {
    await context.route('https://www.googleapis.com/**', route => this.handle(route));
  }
  private async handle(route: Route) {
    const request = route.request(); const target = new URL(request.url());
    const respond = (value: unknown, status = 200) => route.fulfill({ status, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' },
      body: JSON.stringify(value) });
    if (request.method() === 'OPTIONS') { await respond({}); return; }
    expect(request.headers().authorization).toBe('Bearer SYNTHETIC-TRANSIENT-TOKEN');
    expect(target.search).not.toContain('TOKEN');
    if (target.pathname.endsWith('/about')) { await respond({ user: { permissionId: this.account } }); return; }
    if (target.pathname.endsWith('/generateIds')) {
      await respond({ ids: Array.from({ length: Number(target.searchParams.get('count')) }, () => `remote_${++this.ids}`) }); return;
    }
    if (request.method() === 'POST') {
      let metadata: Metadata; let bytes: Buffer | undefined;
      const body = request.postDataBuffer()!;
      if (target.searchParams.get('uploadType') === 'multipart') {
        const parts = body.toString('utf8').split('\r\n\r\n');
        metadata = JSON.parse(parts[1].split('\r\n--')[0]);
        bytes = Buffer.from(parts.slice(2).join('\r\n\r\n').split('\r\n--')[0], 'utf8');
      } else metadata = JSON.parse(body.toString('utf8'));
      const conflict = this.objects.has(metadata.id);
      this.creates.push({ id: metadata.id, kind: metadata.properties.kind, conflict });
      if (conflict) { await respond({}, 409); return; }
      this.objects.set(metadata.id, { metadata: { ...metadata, trashed: false, ...(bytes ? { size: String(bytes.length) } : {}) }, bytes });
      if (metadata.properties.kind === 'segment' && this.loseNextSegment) {
        this.loseNextSegment = false; this.unreadable.add(metadata.id); await route.abort('failed'); return;
      }
      await respond({ id: metadata.id }); return;
    }
    if (target.pathname.endsWith('/files')) {
      const query = target.searchParams.get('q')!; const parent = /^'([^']+)' in parents/.exec(query)?.[1];
      const files = [...this.objects.values()].map(row => row.metadata).filter(meta => !meta.trashed &&
        (parent ? meta.parents?.includes(parent) : meta.properties.kind === 'root'));
      const token = target.searchParams.get('pageToken');
      // The first page is deliberately empty and continued; later pages are short.
      if (token === null) { await respond({ files: [], nextPageToken: 'opaque:0/+ ' }); return; }
      const offset = token === 'opaque:0/+ ' ? 0 : Number(token.slice(7));
      const complete = offset + 2 >= files.length;
      await respond({ files: files.slice(offset, offset + 2), ...(complete ? {} : { nextPageToken: `opaque:${offset + 2}` }) }); return;
    }
    const id = target.pathname.split('/').at(-1)!; const object = this.objects.get(id);
    if (!object || this.unreadable.has(id)) { await respond({ error: { errors: [{ reason: 'notFound' }] } }, 404); return; }
    if (target.searchParams.get('alt') === 'media') {
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: object.bytes }); return;
    }
    await respond(object.metadata);
  }
}

async function open(page: Page, name: string) {
  await page.goto(url); await page.waitForFunction(() => !!window.driveHarness);
  await page.evaluate(name => window.driveHarness.open(name), name);
}
async function snapshot(page: Page) { return page.evaluate(() => window.driveHarness.snapshot()); }

test('production Drive composition joins independent native stores and converges after offline edits and deletion', async ({ page, context, browser }) => {
  const drive = new SyntheticDrive(); await drive.attach(context);
  const second = await browser.newContext(); await drive.attach(second); const other = await second.newPage();
  try {
    const firstName = crypto.randomUUID(); const secondName = crypto.randomUUID();
    await open(page, firstName); await open(other, secondName);
    const first = await page.evaluate(() => window.driveHarness.finish('First profile synthetic session'));
    await other.evaluate(() => window.driveHarness.finish('Second profile synthetic session'));
    await page.evaluate(() => window.driveHarness.connect());
    expect((await snapshot(page)).candidates).toEqual([]);
    await page.evaluate(() => window.driveHarness.create());
    expect((await snapshot(page)).status).toBe('Synced');
    await other.evaluate(() => window.driveHarness.connect());
    expect((await snapshot(other)).candidates).toHaveLength(1);
    expect((await snapshot(other)).connected).toBe(false);
    await other.evaluate(() => window.driveHarness.join());
    expect((await snapshot(other)).view.history).toHaveLength(2);
    await page.evaluate(() => window.driveHarness.synchronize());
    await page.evaluate(id => window.driveHarness.edit(id, 'Offline edit'), first.id);
    await other.evaluate(id => window.driveHarness.remove(id), first.id);
    await page.evaluate(() => window.driveHarness.synchronize());
    await other.evaluate(() => window.driveHarness.synchronize());
    await page.evaluate(() => window.driveHarness.synchronize());
    const left = await snapshot(page); const right = await snapshot(other);
    expect(left.view.history).toHaveLength(1); expect(right.view.history).toHaveLength(1);
    expect(left.graph.entities).toEqual(right.graph.entities); expect(left.graph.tombstones).toEqual(right.graph.tombstones);
    expect(Object.keys(left.graph.operations).sort()).toEqual(Object.keys(right.graph.operations).sort());
    expect(left.graph.outbox).toEqual({}); expect(right.graph.outbox).toEqual({});
    await open(other, secondName);
    expect((await snapshot(other)).authorized).toBe(false);
    await other.evaluate(() => window.driveHarness.connect()); expect((await snapshot(other)).status).toBe('Synced');
    const stored = await other.evaluate(() => window.driveHarness.persisted());
    expect(stored).not.toContain('SYNTHETIC-TRANSIENT-TOKEN'); expect(stored).not.toContain('Authorization');
  } finally { await second.close(); }
});

test('native reload retains unknown publication and retries the same generated ID through 409 exact readback', async ({ page, context }) => {
  const drive = new SyntheticDrive(); await drive.attach(context); const name = crypto.randomUUID();
  await open(page, name); await page.evaluate(() => window.driveHarness.connect()); await page.evaluate(() => window.driveHarness.create());
  await page.evaluate(() => window.driveHarness.finish('Synthetic response-loss session'));
  drive.loseNextSegment = true; await page.evaluate(() => window.driveHarness.synchronize());
  const before = await snapshot(page); const publication = Object.values(before.graph.publications)[0] as { state: string; retryHandle: string; bytes: number[]; operationIds: string[] };
  expect(publication.state).toBe('unknown'); expect(Object.keys(before.graph.outbox)).toEqual(publication.operationIds);
  await open(page, name); drive.unreadable.clear(); await page.evaluate(() => window.driveHarness.connect());
  const after = await snapshot(page); expect(after.status).toBe('Synced'); expect(after.graph.outbox).toEqual({});
  const retained = Object.values(after.graph.publications)[0] as typeof publication;
  expect(retained.bytes).toEqual(publication.bytes); expect(retained.retryHandle).toBe(publication.retryHandle);
  expect(retained.state).toBe('acknowledged');
  const attempts = drive.creates.filter(call => call.kind === 'segment');
  expect(attempts).toEqual([{ id: publication.retryHandle, kind: 'segment', conflict: false },
    { id: publication.retryHandle, kind: 'segment', conflict: true }]);
});

test('native reconnect rejects wrong-account and broad-scope callbacks without sending retained work', async ({ page, context }) => {
  const drive = new SyntheticDrive(); await drive.attach(context); const name = crypto.randomUUID();
  await open(page, name); await page.evaluate(() => window.driveHarness.connect()); await page.evaluate(() => window.driveHarness.create());
  await page.evaluate(() => window.driveHarness.finish('Synthetic unpublished session'));
  const before = await snapshot(page); const creates = drive.creates.length;
  await open(page, name); drive.account = 'another-account';
  await page.evaluate(() => window.driveHarness.connect());
  expect((await snapshot(page)).authorized).toBe(false); expect(drive.creates).toHaveLength(creates);
  drive.account = 'synthetic-account';
  await page.evaluate(() => window.driveHarness.scope('https://www.googleapis.com/auth/drive'));
  await page.evaluate(() => window.driveHarness.connect());
  const after = await snapshot(page); expect(after.authorized).toBe(false); expect(after.graph.outbox).toEqual(before.graph.outbox);
  expect(drive.creates).toHaveLength(creates);
});
