import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { GoogleDriveBootstrap } from '../src/web/google-drive-bootstrap';
import { GoogleDriveClient, driveProperties, decodeDriveLocator, DRIVE_FOLDER_MIME, encodeDriveLocator,
  type DriveMetadata } from '../src/web/google-drive-transport';
import { LocalRepository } from '../src/web/repository';
import type { Descriptor } from '../src/web/model';

type Stored = { metadata: DriveMetadata; bytes?: Uint8Array };
type Call = { url: URL; init: RequestInit };
const repos: LocalRepository[] = [];
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const uuid = (n: number) => `98000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
afterEach(() => { for (const repo of repos.splice(0)) repo.close(); });
async function open(name: string = crypto.randomUUID()) {
  const repo = await LocalRepository.open(name); repos.push(repo); await repo.initialize(); return repo;
}
async function fixture() {
  const repo = await open(); const descriptor = (await repo.view()).collection.descriptor;
  const objects = new Map<string, Stored>(); const calls: Call[] = [];
  let ids = 0;
  let hook: ((call: Call) => Response | void | Promise<Response | void>) | undefined;
  let created: ((id: string) => void) | undefined;
  const add = (id: string, kind: 'root' | 'segments' | 'descriptor', parent?: string, bytes?: Uint8Array, value = descriptor) => {
    objects.set(id, { metadata: { id, mimeType: kind === 'descriptor' ? 'application/json' : DRIVE_FOLDER_MIME,
      trashed: false, properties: driveProperties(kind, value.datasetId), ...(parent ? { parents: [parent] } : {}),
      ...(bytes ? { size: String(bytes.length) } : {}) }, bytes });
  };
  const tree = (root = 'existing', value = descriptor) => {
    add(root, 'root', undefined, undefined, value);
    add(`${root}_segments`, 'segments', root, undefined, value);
    add(`${root}_descriptor`, 'descriptor', root, encode(value), value);
    return { rootId: root, segmentsId: `${root}_segments`, descriptorId: `${root}_descriptor` };
  };
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); const call = { url, init }; calls.push(call);
    const intercepted = await hook?.(call); if (intercepted) return intercepted;
    if (url.pathname.endsWith('/generateIds')) return json({ ids: Array.from({ length: Number(url.searchParams.get('count')) }, () => `generated_${++ids}`) });
    if (init.method === 'POST') {
      let metadata: DriveMetadata; let bytes: Uint8Array | undefined;
      if (init.body instanceof Blob) {
        const body = await init.body.text(); const parts = body.split('\r\n\r\n');
        metadata = JSON.parse(parts[1].split('\r\n--')[0]);
        bytes = new TextEncoder().encode(parts.slice(2).join('\r\n\r\n').split('\r\n--')[0]);
      } else metadata = JSON.parse(String(init.body));
      if (objects.has(metadata.id)) return json({}, 409);
      objects.set(metadata.id, { metadata: { ...metadata, trashed: false, ...(bytes ? { size: String(bytes.length) } : {}) }, bytes });
      created?.(metadata.id); return json({ id: metadata.id });
    }
    if (url.pathname.endsWith('/files')) {
      const query = url.searchParams.get('q')!; const parent = /^'([^']+)' in parents/.exec(query)?.[1];
      return json({ files: [...objects.values()].map(row => row.metadata).filter(meta => meta.trashed === false &&
        (parent ? meta.parents?.includes(parent) : meta.properties?.proof === driveProperties('root', descriptor.datasetId).proof && meta.properties.kind === 'root')) });
    }
    const id = url.pathname.split('/').at(-1)!; const object = objects.get(id);
    if (!object) return json({ error: { errors: [{ reason: 'notFound' }] } }, 404);
    if (url.searchParams.get('alt') === 'media') return new Response(object.bytes ? new Uint8Array(object.bytes) : null);
    return json(object.metadata);
  };
  const client = new GoogleDriveClient(account => {
    expect(account).toBe('account'); return { accessToken: 'transient-token', assertCurrent() {} };
  }, { fetcher, maxRetries: 0 });
  const bootstrap = new GoogleDriveBootstrap(client, repo.remote());
  return { repo, descriptor, objects, calls, add, tree, client, bootstrap,
    hook: (value?: typeof hook) => { hook = value; }, created: (value?: typeof created) => { created = value; } };
}

it('returns zero candidates without creating or binding anything', async () => {
  const f = await fixture();
  expect(await f.bootstrap.discover('account')).toEqual({ candidates: [], complete: true });
  expect(await f.repo.remote().captureBinding()).toBeNull(); expect(f.objects.size).toBe(0);
});

it('returns a single validated candidate for explicit selection without binding it', async () => {
  const f = await fixture(); const locator = f.tree();
  expect(await f.bootstrap.discover('account')).toEqual({ complete: true, candidates: [{ rootId: locator.rootId,
    status: 'ready', descriptor: f.descriptor, locator: encodeDriveLocator(locator) }] });
  expect(await f.repo.remote().captureBinding()).toBeNull();
});

it('surfaces distinct histories and same-history duplicate roots without first-result election', async () => {
  const f = await fixture(); f.tree('one'); f.tree('copy');
  f.tree('other', { ...f.descriptor, datasetId: uuid(5) });
  const result = await f.bootstrap.discover('account');
  expect(result.candidates.map(row => row.rootId)).toEqual(['one', 'copy', 'other']);
  expect(result.candidates.every(row => row.status === 'ready')).toBe(true);
  expect(await f.repo.remote().captureBinding()).toBeNull();
});

it('preserves incomplete, malformed, unsupported and unreadable candidates separately', async () => {
  const f = await fixture(); f.add('partial', 'root'); f.tree('bad'); f.tree('future'); f.tree('denied');
  f.objects.get('bad_descriptor')!.bytes = new TextEncoder().encode('{broken');
  f.objects.get('future_descriptor')!.bytes = encode({ ...f.descriptor, protocolVersion: 2 });
  f.hook(({ url }) => url.pathname.endsWith('/denied') ? json({ error: { errors: [{ reason: 'insufficientFilePermissions' }] } }, 403) : undefined);
  const result = await f.bootstrap.discover('account');
  expect(result.candidates.map(row => [row.rootId, row.status, row.failure])).toEqual([
    ['partial', 'incomplete', 'missing-dataset'], ['bad', 'invalid', 'malformed'],
    ['future', 'invalid', 'unsupported'], ['denied', 'unreadable', 'access'],
  ]);
});

it('rejects ambiguous descriptor or segment-folder components instead of choosing the first', async () => {
  const f = await fixture(); f.tree(); f.add('extra_descriptor', 'descriptor', 'existing', encode(f.descriptor));
  await expect(f.bootstrap.inspect('account', 'existing')).rejects.toMatchObject({ code: 'integrity' });
  f.objects.delete('extra_descriptor'); f.add('extra_segments', 'segments', 'existing');
  await expect(f.bootstrap.inspect('account', 'existing')).rejects.toMatchObject({ code: 'integrity' });
});

it('follows short and empty pages with opaque continuation and retains incompleteSearch from an earlier page', async () => {
  const f = await fixture(); f.tree(); const tokens: (string | null)[] = [];
  f.hook(({ url }) => {
    if (!url.pathname.endsWith('/files') || url.searchParams.get('q')?.includes('in parents')) return;
    const token = url.searchParams.get('pageToken'); tokens.push(token);
    if (token === null) return json({ files: [], nextPageToken: 'opaque /+ token', incompleteSearch: true });
    if (token === 'opaque /+ token') return json({ files: [f.objects.get('existing')!.metadata], nextPageToken: 'last' });
    return json({ files: [] });
  });
  const result = await f.bootstrap.discover('account');
  expect(tokens).toEqual([null, 'opaque /+ token', 'last']); expect(result.complete).toBe(false);
  expect(result.candidates[0].status).toBe('ready');
});

it('validates the retained locator directly when root discovery omits it and never recreates a missing root', async () => {
  const f = await fixture(); const locator = f.tree();
  f.hook(({ url }) => url.pathname.endsWith('/files') && !url.searchParams.get('q')?.includes('in parents') ? json({ files: [] }) : undefined);
  expect((await f.bootstrap.discover('account')).candidates).toEqual([]);
  expect((await f.bootstrap.inspect('account', locator, { expectedDescriptor: f.descriptor })).status).toBe('ready');
  f.objects.delete(locator.rootId);
  await expect(f.bootstrap.inspect('account', locator)).rejects.toMatchObject({ code: 'missing-dataset' });
  expect(f.calls.some(call => call.init.method === 'POST')).toBe(false);
});

it('refuses replaced retained components and mismatched descriptor identity', async () => {
  const f = await fixture(); const locator = f.tree();
  await expect(f.bootstrap.inspect('account', { ...locator, descriptorId: 'replacement' })).rejects.toMatchObject({ code: 'integrity' });
  await expect(f.bootstrap.inspect('account', locator, { expectedDescriptor: { ...f.descriptor, datasetId: uuid(3) } })).rejects.toMatchObject({ code: 'integrity' });
  f.objects.get(locator.segmentsId)!.metadata.parents = ['wrong-parent'];
  await expect(f.bootstrap.inspect('account', locator)).rejects.toMatchObject({ code: 'missing-dataset' });
});

it('persists generated IDs and exact descriptor bytes before remote create and survives local reopen', async () => {
  const f = await fixture(); const intent = await f.bootstrap.prepare('account', f.descriptor, { expectedGeneration: 0 });
  expect(f.objects.size).toBe(0); expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(0);
  f.repo.close(); const reopened = await open(f.repo.db.name);
  const bootstrap = new GoogleDriveBootstrap(f.client, reopened.remote());
  expect(await bootstrap.prepare('account', f.descriptor)).toEqual(intent);
  const result = await bootstrap.create('account');
  expect(result.candidate.locator).toBe(intent.locator); expect(result.discovery.complete).toBe(true);
  expect(await reopened.remote().captureBinding()).toBeNull();
  const { rootId, segmentsId, descriptorId } = decodeDriveLocator(intent.locator);
  expect([...f.objects.keys()]).toEqual([rootId, segmentsId, descriptorId]);
  expect(f.objects.get(descriptorId)!.bytes).toEqual(intent.descriptorBytes);
  expect(f.calls.filter(call => call.url.pathname.endsWith('/generateIds'))).toHaveLength(1);
});

it('lets concurrent preparations use only the first transactionally committed ID triple', async () => {
  const f = await fixture(); const other = await open(f.repo.db.name);
  const second = new GoogleDriveBootstrap(f.client, other.remote());
  const intents = await Promise.all([f.bootstrap.prepare('account', f.descriptor), second.prepare('account', f.descriptor)]);
  expect(intents[0]).toEqual(intents[1]);
  await second.create('account');
  expect([...f.objects.keys()].sort()).toEqual(Object.values(decodeDriveLocator(intents[0].locator)).sort());
});

it('performs no writes remotely when durable creation intent fails to commit', async () => {
  const f = await fixture(); f.repo.fault = (point, tx) => { if (point === 'bootstrap.intent') tx.abort(); };
  await expect(f.bootstrap.prepare('account', f.descriptor)).rejects.toThrow();
  expect(await f.repo.remote().getBootstrapIntent()).toBeNull(); expect(f.objects.size).toBe(0);
  await expect(f.bootstrap.create('account')).rejects.toMatchObject({ code: 'integrity' });
});

it('retains partial trees as incomplete and resumes only their original IDs', async () => {
  const f = await fixture(); const intent = await f.bootstrap.prepare('account', f.descriptor);
  const { segmentsId } = decodeDriveLocator(intent.locator);
  f.hook(async ({ init }) => {
    if (init.method === 'POST' && typeof init.body === 'string' && JSON.parse(init.body).id === segmentsId) return json({ error: { errors: [{ reason: 'insufficientFilePermissions' }] } }, 403);
  });
  await expect(f.bootstrap.create('account')).rejects.toMatchObject({ code: 'access' });
  expect((await f.bootstrap.discover('account')).candidates[0].status).toBe('incomplete');
  f.hook(); await f.bootstrap.create('account');
  expect(f.objects.size).toBe(3); expect(await f.repo.remote().getBootstrapIntent()).toEqual(intent);
  expect(f.calls.filter(call => call.url.pathname.endsWith('/generateIds'))).toHaveLength(1);
});

it('verifies exact readback after accepted-response loss and same-ID 409 retries', async () => {
  const f = await fixture(); const intent = await f.bootstrap.prepare('account', f.descriptor);
  f.created(() => { throw new TypeError('private lost-response details'); });
  expect((await f.bootstrap.create('account')).candidate.locator).toBe(intent.locator);
  f.created(); const before = f.objects.size;
  expect((await f.bootstrap.create('account')).candidate.locator).toBe(intent.locator);
  expect(f.objects.size).toBe(before);
});

it('rejects a 409 descriptor whose logical data matches but exact retained bytes changed', async () => {
  const f = await fixture(); const intent = await f.bootstrap.prepare('account', f.descriptor);
  await f.bootstrap.create('account'); const locator = decodeDriveLocator(intent.locator);
  f.objects.get(locator.descriptorId)!.bytes = new TextEncoder().encode(JSON.stringify(f.descriptor, null, 2));
  await expect(f.bootstrap.create('account')).rejects.toMatchObject({ code: 'integrity' });
  expect(await f.repo.remote().captureBinding()).toBeNull();
});

it('cancels an accepted folder attempt without losing durable IDs or creating later components', async () => {
  const f = await fixture(); const intent = await f.bootstrap.prepare('account', f.descriptor);
  const controller = new AbortController(); f.created(() => controller.abort());
  await expect(f.bootstrap.create('account', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
  expect(f.objects.size).toBe(1); expect(await f.repo.remote().getBootstrapIntent()).toEqual(intent);
  f.created(); await f.bootstrap.create('account'); expect(f.objects.size).toBe(3);
});

it('fences stale generation callbacks before persisting an allocation or creating another component', async () => {
  const f = await fixture(); let current = true;
  f.hook(({ url }) => { if (url.pathname.endsWith('/generateIds')) current = false; });
  await expect(f.bootstrap.prepare('account', f.descriptor, { isCurrent: () => current })).rejects.toMatchObject({ code: 'authorization' });
  expect(await f.repo.remote().getBootstrapIntent()).toBeNull();
  f.hook(); current = true; await f.bootstrap.prepare('account', f.descriptor);
  f.created(() => { current = false; });
  await expect(f.bootstrap.create('account', { isCurrent: () => current })).rejects.toMatchObject({ code: 'authorization' });
  expect(f.objects.size).toBe(1);
});

it('refuses another account when a retained creation intent exists', async () => {
  const f = await fixture(); await f.bootstrap.prepare('account', f.descriptor);
  await expect(f.bootstrap.prepare('another-account', f.descriptor)).rejects.toMatchObject({ code: 'authorization' });
  expect(f.objects.size).toBe(0);
});

it('awaits the durable binding-generation fence between accepted component writes', async () => {
  const f = await fixture(); const intent = await f.bootstrap.prepare('account', f.descriptor);
  let changed = false;
  f.created(() => { changed = true; });
  await expect(f.bootstrap.create('account', { assertCurrent: async () => {
    if (changed) await f.repo.remote().disconnect();
    const state = await f.repo.remote().bindingState();
    if (state.bindingGeneration !== 0) throw Object.assign(new Error('stale target'), { code: 'stale-binding' });
  } })).rejects.toMatchObject({ code: 'stale-binding' });
  expect(f.objects.size).toBe(1);
  expect(await f.repo.remote().getBootstrapIntent()).toEqual(intent);
});
