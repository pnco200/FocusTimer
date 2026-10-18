import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import type {} from './fixtures/async-runner-harness';
import type { Session } from '../src/web/model';

const harnessUrl = 'http://127.0.0.1:4174/e2e/fixtures/async-runner.html';
type Method = 'descriptor' | 'enumerate' | 'read' | 'prepare' | 'publish';
type Input = { binding: { datasetId: string }; cursor?: number | null; reference?: string;
  segmentId?: string; retryHandle?: string; bytes?: number[]; maxBytes?: number };
type Call = Input & { method: Method };

/** Test-server memory survives reloads; the production runner never receives the object map. */
class ByteStore {
  objects = new Map<string, number[]>();
  calls: Call[] = [];
  hidden = new Set<string>();
  private hold?: { method: Method; accepted: boolean; hit: () => void; wait: Promise<void> };
  constructor(readonly datasetId: string) {}

  block(method: Method, accepted = false) {
    let hit!: () => void; let release!: () => void;
    const reached = new Promise<void>(resolve => { hit = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    this.hold = { method, accepted, hit, wait };
    return { reached, release };
  }

  async attach(context: BrowserContext) {
    await context.route('**/__async/*', async route => {
      const method = new URL(route.request().url()).pathname.split('/').at(-1) as Method;
      const input = route.request().postDataJSON() as Input;
      this.calls.push({ method, ...input });
      const hold = this.hold?.method === method ? this.hold : undefined;
      if (hold) this.hold = undefined;
      if (hold && !hold.accepted) { hold.hit(); await hold.wait; }
      let status = 200; let output: unknown;
      if (input.binding.datasetId !== this.datasetId) {
        status = 404; output = { classification: 'missing-dataset', code: 'missing-dataset' };
      } else if (method === 'descriptor') {
        output = { bytes: Array.from(new TextEncoder().encode(JSON.stringify({
          application: 'focus-timer', protocolVersion: 1, datasetId: this.datasetId,
        }))) };
      } else if (method === 'prepare') {
        output = { retryHandle: `creation:${input.segmentId}` };
      } else if (method === 'publish') {
        const reference = `object:${input.segmentId}`;
        if (input.retryHandle !== `creation:${input.segmentId}`) {
          status = 409; output = { classification: 'integrity', code: 'integrity' };
        } else {
          const retained = this.objects.get(reference);
          if (retained && JSON.stringify(retained) !== JSON.stringify(input.bytes)) {
            status = 409; output = { classification: 'integrity', code: 'integrity' };
          } else {
            this.objects.set(reference, [...input.bytes!]);
            output = { outcome: retained ? 'already-present' : 'confirmed', segmentId: input.segmentId,
              bytes: [...input.bytes!], references: [reference] };
          }
        }
      } else if (method === 'read') {
        const bytes = this.objects.get(input.reference!);
        if (!bytes) { status = 404; output = { classification: 'missing-object', code: 'missing-object' }; }
        else output = { bytes: bytes.slice(0, input.maxBytes), complete: bytes.length <= input.maxBytes! };
      } else {
        // An empty continued page, reversed delivery, duplicate references and multiple pages.
        const references = [...this.objects.keys()].filter(key => !this.hidden.has(key)).reverse();
        if (references.length) references.push(references[0]);
        const cursor = input.cursor ?? 0;
        if (!cursor) output = { references: [], complete: false, continuation: 1 };
        else {
          const offset = cursor - 1;
          const complete = offset + 2 >= references.length;
          output = { references: references.slice(offset, offset + 2), complete,
            ...(complete ? {} : { continuation: cursor + 2 }) };
        }
      }
      if (hold?.accepted) { hold.hit(); await hold.wait; }
      // An interrupted fetch may no longer have a route after navigation.
      try { await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(output) }); }
      catch (error) {
        if (!/closed|disposed|cancel|Invalid InterceptionId|Target page|Invalid state/i.test(String(error))) throw error;
      }
    });
  }
}

async function harness(page: Page, name: string, datasetId?: string) {
  await page.goto(harnessUrl);
  await page.waitForFunction(() => !!window.asyncHarness);
  return page.evaluate(({ name, datasetId }) => window.asyncHarness.open(name, datasetId), { name, datasetId });
}
async function reload(page: Page, name: string) {
  await page.reload(); await page.waitForFunction(() => !!window.asyncHarness);
  await page.evaluate(name => window.asyncHarness.open(name), name);
}
async function run(page: Page) {
  await page.evaluate(() => window.asyncHarness.start());
  await page.waitForFunction(() => window.asyncDone);
  expect(await page.evaluate(() => window.asyncError)).toBeUndefined();
  return page.evaluate(() => window.asyncRepository.status());
}
async function snapshot(page: Page) {
  return page.evaluate(async () => {
    const state = await window.asyncRepository.snapshot();
    return { ...state, pass: state.discoveries[state.binding!.generation], entities: state.entities as Record<string, Session> };
  });
}

for (const phase of ['reserve', 'seal', 'confirm', 'before-acknowledge'] as const) {
  test(`document reload after durable ${phase} resumes the exact publication`, async ({ page, context }) => {
    const name = crypto.randomUUID(); const datasetId = crypto.randomUUID();
    const store = new ByteStore(datasetId); await store.attach(context);
    await harness(page, name, datasetId);
    await page.evaluate(async () => { await window.asyncHarness.finish(); await window.asyncHarness.bind(); });
    await page.evaluate(phase => window.asyncHarness.start(phase), phase);
    await page.waitForFunction(phase => window.asyncPhase === phase, phase);
    const before = await snapshot(page);
    const [publication] = Object.values(before.publications);
    expect(publication.state).toBe(phase === 'reserve' ? 'reserved' : phase === 'seal' ? 'sealed' : 'confirmed');
    expect(Object.keys(before.outbox)).toEqual(publication.operationIds);
    const attempts = store.calls.filter(call => call.method === 'publish').length;
    await reload(page, name);
    const restored = await snapshot(page);
    expect(restored.publications[publication.segmentId]).toEqual(publication);
    expect(await run(page)).toBe('Synced');
    const after = await snapshot(page);
    expect(Object.keys(after.operations)).toEqual(publication.operationIds);
    expect(Object.keys(after.outbox)).toEqual([]);
    expect(Object.keys(after.publications)).toEqual([publication.segmentId]);
    expect(after.publications[publication.segmentId].state).toBe('acknowledged');
    if (publication.bytes) expect(after.publications[publication.segmentId].bytes).toEqual(publication.bytes);
    if (publication.state === 'confirmed') expect(store.calls.filter(call => call.method === 'publish')).toHaveLength(attempts);
    expect(store.objects.size).toBe(1);
  });
}

for (const phase of ['recordPage', 'after-read'] as const) {
  test(`document reload at ${phase} retains references and receives the whole segment on restart`, async ({ page, context }) => {
    const name = crypto.randomUUID(); const datasetId = crypto.randomUUID();
    const store = new ByteStore(datasetId); await store.attach(context); await harness(page, name, datasetId);
    const bytes = await page.evaluate(datasetId => window.asyncHarness.segment(datasetId,
      [window.asyncHarness.operation(datasetId, 'Remote after interruption')]), datasetId);
    store.objects.set('remote-content', bytes);
    await page.evaluate(() => window.asyncHarness.bind());
    await page.evaluate(phase => window.asyncHarness.start(phase), phase);
    await page.waitForFunction(phase => window.asyncPhase === phase, phase);
    const before = await snapshot(page);
    expect(before.pass.artifacts['remote-content'].state).toBe('pending');
    expect(Object.keys(before.operations)).toEqual([]);
    expect(Object.keys(before.segments)).toEqual([]);
    await reload(page, name);
    expect((await snapshot(page)).pass.artifacts['remote-content'].state).toBe('pending');
    expect(await run(page)).toBe('Synced');
    const after = await snapshot(page);
    expect(Object.values(after.entities).map(session => session.description)).toEqual(['Remote after interruption']);
    expect(Object.keys(after.operations)).toHaveLength(1); expect(Object.keys(after.segments)).toHaveLength(1);
    expect(after.highWater).toBe(50); expect(Object.keys(after.outbox)).toHaveLength(0);
    expect(after.pass.artifacts['remote-content'].state).toBe('applied');
  });
}

test('reload during accepted publication retries exact bytes while edits remain separate pending work', async ({ page, context }) => {
  const name = crypto.randomUUID(); const datasetId = crypto.randomUUID();
  const store = new ByteStore(datasetId); await store.attach(context); await harness(page, name, datasetId);
  const session = await page.evaluate(async () => {
    const session = await window.asyncHarness.finish('Before upload'); await window.asyncHarness.bind(); return session;
  });
  const upload = store.block('publish', true);
  await page.evaluate(() => window.asyncHarness.start()); await upload.reached;
  const before = await snapshot(page); const [publication] = Object.values(before.publications);
  expect(publication.state).toBe('in-flight'); expect(store.objects.size).toBe(1);
  await page.evaluate(id => window.asyncHarness.edit(id, 'Edited while network response is lost'), session.id);
  await reload(page, name); upload.release();
  const restored = await snapshot(page);
  expect(Object.values(restored.outbox).filter(value => value.reservation === null)).toHaveLength(1);
  expect(await run(page)).toBe('Synced');
  const after = await snapshot(page);
  expect(Object.keys(after.operations)).toHaveLength(2); expect(Object.keys(after.outbox)).toHaveLength(0);
  expect(Object.values(after.entities)[0].description).toBe('Edited while network response is lost');
  const retries = store.calls.filter(call => call.method === 'publish' && call.segmentId === publication.segmentId);
  expect(retries).toHaveLength(2);
  expect(retries[1].bytes).toEqual(retries[0].bytes); expect(retries[1].retryHandle).toBe(retries[0].retryHandle);
  expect(after.publications[publication.segmentId].operationIds).toEqual(publication.operationIds);
  expect(store.objects.size).toBe(2);
});

test('reloads during pagination and object read retain durable progress until receive commits', async ({ page, context }) => {
  const name = crypto.randomUUID(); const datasetId = crypto.randomUUID();
  const store = new ByteStore(datasetId); await store.attach(context); await harness(page, name, datasetId);
  const bytes = await page.evaluate(datasetId => window.asyncHarness.segment(datasetId,
    [window.asyncHarness.operation(datasetId, 'Read after network interruption')]), datasetId);
  store.objects.set('interrupted-read', bytes); await page.evaluate(() => window.asyncHarness.bind());
  const enumeration = store.block('enumerate');
  await page.evaluate(() => window.asyncHarness.start()); await enumeration.reached;
  expect((await snapshot(page)).pass.checkpoint).toBeNull();
  await reload(page, name); enumeration.release();
  const read = store.block('read');
  await page.evaluate(() => window.asyncHarness.start()); await read.reached;
  const beforeRead = await snapshot(page);
  expect(beforeRead.pass.artifacts['interrupted-read'].state).toBe('pending');
  expect(Object.keys(beforeRead.operations)).toHaveLength(0);
  await reload(page, name); read.release();
  expect(await run(page)).toBe('Synced');
  const after = await snapshot(page);
  expect(Object.values(after.entities).map(session => session.description)).toEqual(['Read after network interruption']);
  expect(Object.keys(after.operations)).toHaveLength(1); expect(after.pass.reconciled).toBe(true);
  expect(store.calls.filter(call => call.method === 'read' && call.reference === 'interrupted-read').length).toBeGreaterThanOrEqual(2);
});

test('two independent native replicas converge after offline edits, terminal deletes, response loss and reloads', async ({ page, context }) => {
  const datasetId = crypto.randomUUID(); const names = [crypto.randomUUID(), crypto.randomUUID()];
  const store = new ByteStore(datasetId); await store.attach(context);
  const second = await context.newPage();
  const initialA = await harness(page, names[0], datasetId); const initialB = await harness(second, names[1], datasetId);
  expect(initialA.writerId).not.toBe(initialB.writerId);
  await page.evaluate(() => window.asyncHarness.bind()); await second.evaluate(() => window.asyncHarness.bind());
  const shared = await page.evaluate(() => window.asyncHarness.finish('Shared starting session'));
  expect(await run(page)).toBe('Synced'); expect(await run(second)).toBe('Synced');

  // Both clients now author only through local production commands while disconnected from transport.
  await page.evaluate(async id => {
    await window.asyncHarness.edit(id, 'Offline first replica edit');
    await window.asyncHarness.finish('First replica retained session');
    const removed = await window.asyncHarness.finish('First replica deleted session');
    await window.asyncHarness.remove(removed.id);
  }, shared.id);
  await second.evaluate(async id => {
    await window.asyncHarness.remove(id);
    const retained = await window.asyncHarness.finish('Second replica initial title');
    await window.asyncHarness.edit(retained.id, 'Second replica retained session');
  }, shared.id);
  const offlineA = await snapshot(page); const offlineB = await snapshot(second);
  const expectedOperations = { ...offlineA.operations, ...offlineB.operations };
  const upload = store.block('publish', true);
  await page.evaluate(() => window.asyncHarness.start()); await upload.reached;
  await reload(page, names[0]); upload.release();
  expect(await run(second)).toBe('Synced');
  await reload(second, names[1]);
  expect(await run(page)).toBe('Synced'); expect(await run(second)).toBe('Synced');
  expect(await run(page)).toBe('Synced');
  const finalA = await snapshot(page); const finalB = await snapshot(second);
  expect(finalA.operations).toEqual(expectedOperations); expect(finalB.operations).toEqual(expectedOperations);
  expect(finalA.entities).toEqual(finalB.entities); expect(finalA.tombstones).toEqual(finalB.tombstones);
  expect(finalA.highWater).toBe(finalB.highWater);
  expect(finalA.highWater).toBe(Math.max(...Object.values(expectedOperations).map(operation => operation.lamportCounter)));
  expect(finalA.tombstones).toHaveLength(2);
  expect(Object.values(finalA.entities).map(session => session.description).sort()).toEqual([
    'First replica retained session', 'Second replica retained session',
  ]);
  for (const state of [finalA, finalB]) {
    expect(Object.keys(state.outbox)).toHaveLength(0); expect(state.pass.reconciled).toBe(true);
    expect(Object.values(state.publications).every(publication => publication.state === 'acknowledged')).toBe(true);
    expect(Object.values(state.pass.artifacts).every(artifact => artifact.state === 'applied')).toBe(true);
  }
  const attempts = store.calls.filter(call => call.method === 'publish');
  const retried = attempts.filter(call => call.segmentId === attempts[1].segmentId);
  expect(retried).toHaveLength(2); expect(retried[0].bytes).toEqual(retried[1].bytes);
  expect(store.calls.some(call => call.method === 'enumerate' && call.cursor === 1)).toBe(true);
  await second.close();
});
