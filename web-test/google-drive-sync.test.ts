import 'fake-indexeddb/auto';
import { afterEach, expect, it } from 'vitest';
import { GoogleDriveSync } from '../src/web/google-drive-sync';
import { GoogleDriveAuthorization, DRIVE_FILE_SCOPE, type GoogleIdentityServices } from '../src/web/google-drive-auth';
import { GoogleDriveClient, DRIVE_FOLDER_MIME, driveProperties, encodeDriveLocator, type DriveMetadata } from '../src/web/google-drive-transport';
import { LocalRepository } from '../src/web/repository';
import { pin, type Descriptor } from '../src/web/model';

const repos: LocalRepository[] = [];
const controllers: GoogleDriveSync[] = [];
afterEach(() => { for (const controller of controllers.splice(0)) controller.stop(); for (const repo of repos.splice(0)) repo.close(); });
const stamp = '2026-10-19T12:00:00.000Z';
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const error = (status: number) => json({ error: { errors: [{ reason: status === 404 ? 'notFound' : 'authError' }], message: 'PRIVATE-PROVIDER-DATA' } }, status);
async function open(name: string = crypto.randomUUID()) { const repo = await LocalRepository.open(name); repos.push(repo); await repo.initialize(); return repo; }
async function finish(repo: LocalRepository, description = 'Synthetic focus') {
  let { active } = await repo.acquireOwner(crypto.randomUUID());
  active = await repo.saveActive(pin(active), { ...active, id: crypto.randomUUID(), startedAt: stamp, state: 'paused', focusMs: 1234 });
  return repo.finish(pin(active), 1234, stamp, description);
}
function server() {
  const objects = new Map<string, { metadata: DriveMetadata; bytes?: Uint8Array }>();
  const posts: string[] = [];
  const requests: string[] = [];
  let generated = 0;
  let account = 'account-A';
  let loseNextSegment = false;
  let unavailable = false;
  let incompleteSearch = false;
  let beforePost: ((id: string) => Promise<void>) | undefined;
  let beforeRead: (() => Promise<void>) | undefined;
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    requests.push(url.href);
    if (url.pathname.endsWith('/about')) return json({ user: { permissionId: account } });
    if (unavailable) return error(401);
    if (url.pathname.endsWith('/generateIds')) return json({ ids: Array.from({ length: Number(url.searchParams.get('count')) }, () => `drive_${++generated}`) });
    if (init.method === 'POST') {
      let metadata: DriveMetadata; let bytes: Uint8Array | undefined;
      if (init.body instanceof Blob) {
        const body = await init.body.text(); const boundary = new Headers(init.headers).get('Content-Type')!.split('boundary=')[1];
        const parts = body.split(`--${boundary}`);
        metadata = JSON.parse(parts[1].split('\r\n\r\n')[1].slice(0, -2));
        bytes = new TextEncoder().encode(parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4, -2));
      } else metadata = JSON.parse(String(init.body));
      posts.push(metadata.id); await beforePost?.(metadata.id);
      if (objects.has(metadata.id)) return error(409);
      objects.set(metadata.id, { metadata: { ...metadata, trashed: false }, bytes });
      if (metadata.properties?.kind === 'segment' && loseNextSegment) { loseNextSegment = false; throw new TypeError('private lost response'); }
      return json({ id: metadata.id });
    }
    if (url.pathname.endsWith('/files')) {
      const parent = url.searchParams.get('q')?.match(/^'([^']+)' in parents/)?.[1];
      return json({ incompleteSearch, files: [...objects.values()].map(value => value.metadata).filter(value => parent ? value.parents?.includes(parent) : value.properties?.kind === 'root') });
    }
    const item = objects.get(url.pathname.split('/').at(-1)!); if (!item) return error(404);
    if (url.searchParams.get('alt') === 'media') { await beforeRead?.(); return new Response(new Uint8Array(item.bytes!)); }
    return json(item.metadata);
  };
  function seed(descriptor: Descriptor) {
    const rootId = `seed_root_${++generated}`, segmentsId = `seed_segments_${generated}`, descriptorId = `seed_descriptor_${generated}`;
    for (const [id, kind, parent] of [[rootId, 'root', null], [segmentsId, 'segments', rootId], [descriptorId, 'descriptor', rootId]] as const) {
      objects.set(id, { metadata: { id, mimeType: kind === 'descriptor' ? 'application/json' : DRIVE_FOLDER_MIME,
        properties: driveProperties(kind, descriptor.datasetId), trashed: false, ...(parent ? { parents: [parent] } : {}) },
      ...(kind === 'descriptor' ? { bytes: new TextEncoder().encode(JSON.stringify(descriptor)) } : {}) });
    }
    return encodeDriveLocator({ rootId, segmentsId, descriptorId });
  }
  function composition(repo: LocalRepository, automatic = true) {
    const callbacks: Parameters<GoogleIdentityServices['initTokenClient']>[0][] = [];
    const gis: GoogleIdentityServices = { initTokenClient(config) { callbacks.push(config); return { requestAccessToken() {
      if (automatic) queueMicrotask(() => config.callback({ access_token: 'MEMORY-ONLY-SECRET', expires_in: 3600, scope: DRIVE_FILE_SCOPE }));
    } }; } };
    const authorization = new GoogleDriveAuthorization({ clientId: 'official-web-client', gis, fetcher });
    const client = new GoogleDriveClient(value => authorization.credentials(value), { fetcher, maxRetries: 0 });
    const sync = new GoogleDriveSync(repo, 'official-web-client', authorization, client); controllers.push(sync);
    return { sync, callbacks, authorization };
  }
  return { objects, posts, requests, seed, composition, setAccount(value: string) { account = value; },
    loseSegment() { loseNextSegment = true; }, setUnauthorized(value: boolean) { unavailable = value; },
    setIncompleteSearch(value: boolean) { incompleteSearch = value; },
    beforePost(fn: typeof beforePost) { beforePost = fn; }, beforeRead(fn: typeof beforeRead) { beforeRead = fn; } };
}

it.each([0, 1, 2])('requires an explicit choice after authorization discovers %s histories', async count => {
  const drive = server(), repo = await open();
  for (let n = 0; n < count; n++) drive.seed({ application: 'focus-timer', protocolVersion: 1, datasetId: crypto.randomUUID() });
  const { sync } = drive.composition(repo); await sync.initialize(false); await sync.connect();
  expect(sync.authorized).toBe(true); expect(sync.candidates).toHaveLength(count);
  expect(await repo.remote().captureBinding()).toBeNull(); expect(drive.posts).toEqual([]);
});

it('creates only after durable intent commit, composes the production runner, and excludes credentials from persistence/exports', async () => {
  const drive = server(), repo = await open(); await finish(repo);
  const { sync } = drive.composition(repo); await sync.initialize(false); await sync.connect();
  drive.beforePost(async () => { expect(await repo.remote().getBootstrapIntent()).not.toBeNull(); });
  await sync.create(); expect(sync.status).toBe('Synced'); expect(sync.lastSynced).not.toBeNull();
  expect((await repo.syncState()).outbox).toEqual([]);
  const tx = repo.db.transaction('meta', 'readonly'); const request = tx.objectStore('meta').getAll();
  const values = await new Promise(resolve => { request.onsuccess = () => resolve(request.result); });
  const retained = JSON.stringify([values, await repo.remote().snapshot(), await repo.archive()]);
  expect(retained).not.toMatch(/MEMORY-ONLY-SECRET|Authorization|access_token|refresh_token/);
  expect(drive.posts).toHaveLength(4);
});

it('recovers unknown accepted publication after reload using the retained ID and exact membership', async () => {
  const drive = server(); let repo = await open(); await finish(repo);
  let { sync } = drive.composition(repo); await sync.initialize(false); await sync.connect();
  // Prevent immediate read-back after response loss, so the persisted attempt stays unknown.
  drive.loseSegment(); let segmentAccepted = false;
  drive.beforePost(async () => { if (drive.posts.length === 4) segmentAccepted = true; });
  drive.beforeRead(async () => { if (segmentAccepted) throw new TypeError('private verification interrupted'); });
  await sync.create();
  const original = Object.values((await repo.remote().snapshot()).publications)[0];
  expect(original.state).toBe('unknown'); expect((await repo.syncState()).outbox).toHaveLength(1);
  sync.stop(); const name = repo.db.name; repo.close(); repo = await open(name);
  drive.beforeRead(undefined); drive.beforePost(undefined);
  ({ sync } = drive.composition(repo)); await sync.initialize(false);
  expect(sync.status).toBe('Reconnect'); await sync.connect(); expect(sync.status).toBe('Synced');
  const recovered = Object.values((await repo.remote().snapshot()).publications)[0];
  expect(recovered).toMatchObject({ state: 'acknowledged', retryHandle: original.retryHandle, operationIds: original.operationIds });
  expect(recovered.bytes).toEqual(original.bytes);
  expect(drive.posts.filter(id => id === original.retryHandle)).toHaveLength(2);
});

it('joins from another browser with local work, retains its source archive, and converges both directions', async () => {
  const drive = server(), first = await open(), second = await open(); await finish(first, 'First browser'); await finish(second, 'Second browser');
  const left = drive.composition(first).sync; await left.initialize(false); await left.connect(); await left.create();
  const source = (await second.view()).collection.descriptor.datasetId;
  const right = drive.composition(second).sync; await right.initialize(false); await right.connect();
  expect(await second.remote().captureBinding()).toBeNull(); await right.join(right.candidates![0]);
  expect(right.status).toBe('Synced'); await left.sync();
  expect(right.lastSynced).not.toBeNull();
  expect((await first.view()).history).toHaveLength(2); expect((await second.view()).history).toHaveLength(2);
  expect((await second.archiveCollection(source)).unsegmentedOperations).toHaveLength(1);
  expect((await first.remote().snapshot()).operations).toEqual((await second.remote().snapshot()).operations);
});

it('rejects a stale authorization callback after another tab changes the binding generation', async () => {
  const drive = server(), repo = await open(); const { sync, callbacks, authorization } = drive.composition(repo, false);
  await sync.initialize(false); const pending = sync.connect(); await repo.remote().disconnect();
  callbacks[0].callback({ access_token: 'MEMORY-ONLY-SECRET', expires_in: 3600, scope: DRIVE_FILE_SCOPE }); await pending;
  expect(await repo.remote().captureBinding()).toBeNull(); expect(sync.candidates).toBeNull(); expect(drive.posts).toEqual([]);
  expect(sync.message).toContain('Reconnect'); expect(sync.authorized).toBe(false); authorization.clear();
});

it('requires the pinned account on reconnect and never recreates a missing retained root', async () => {
  const drive = server(), repo = await open(); const { sync } = drive.composition(repo); await sync.initialize(false); await sync.connect(); await sync.create();
  const original = await repo.remote().captureBinding(); await sync.disconnect(); const posts = drive.posts.length;
  drive.setAccount('account-B'); await sync.connect(); expect(await repo.remote().captureBinding()).toBeNull(); expect(drive.posts).toHaveLength(posts);
  drive.setAccount('account-A'); const root = [...drive.objects.values()].find(value => value.metadata.properties?.kind === 'root')!;
  drive.objects.delete(root.metadata.id); await sync.connect(); expect(sync.message).toContain('couldn’t be reached');
  expect((await repo.remote().bindingState()).lastBinding?.locator).toBe(original?.locator); expect(drive.posts).toHaveLength(posts);
});

it('keeps local changes pending when a token is rejected and resumes through an explicit reconnect', async () => {
  const drive = server(), repo = await open(); const { sync } = drive.composition(repo); await sync.initialize(false); await sync.connect(); await sync.create();
  await finish(repo); drive.setUnauthorized(true); await sync.sync();
  expect(sync.status).toBe('Reconnect'); expect((await repo.syncState()).outbox).toHaveLength(1); expect(sync.message).not.toContain('PRIVATE');
  const requests = drive.requests.length; await sync.opportunity(); expect(drive.requests).toHaveLength(requests);
  drive.setUnauthorized(false); await sync.connect(); expect(sync.status).toBe('Synced'); expect((await repo.syncState()).outbox).toEqual([]);
});

it('does not claim absence or automatically bind after incomplete root discovery', async () => {
  const drive = server(), repo = await open(); const { sync } = drive.composition(repo);
  drive.setIncompleteSearch(true); await sync.initialize(false); await sync.connect();
  expect(sync.discoveryComplete).toBe(false); expect(sync.candidates).toEqual([]); expect(await repo.remote().captureBinding()).toBeNull();
  drive.setIncompleteSearch(false); await sync.discover(); expect(sync.discoveryComplete).toBe(true);
});

it.each([false, true])('reconnect checks known current bytes before resuming publication after a restored root, mutation=%s', async mutate => {
  const drive = server(), repo = await open(); const { sync } = drive.composition(repo);
  await finish(repo); await sync.initialize(false); await sync.connect(); await sync.create();
  const root = [...drive.objects.values()].find(value => value.metadata.properties?.kind === 'root')!;
  drive.objects.delete(root.metadata.id); await finish(repo, 'Pending while inaccessible'); await sync.sync();
  expect(sync.status).toBe('Sync needs attention'); expect(sync.needsReconnect).toBe(true);
  const posts = drive.posts.length; drive.objects.set(root.metadata.id, root);
  if (mutate) {
    const segment = [...drive.objects.values()].find(value => value.metadata.properties?.kind === 'segment')!;
    segment.bytes = new TextEncoder().encode('{}');
  }
  await sync.connect();
  if (mutate) {
    expect(sync.status).toBe('Sync needs attention'); expect(drive.posts).toHaveLength(posts);
    expect((await repo.syncState()).outbox).toHaveLength(1);
    await sync.disconnect(); await sync.connect();
    expect((await repo.remote().bindingState()).blocked).toBe('integrity'); expect(drive.posts).toHaveLength(posts);
  } else { expect(sync.status).toBe('Synced'); expect(drive.posts).toHaveLength(posts + 1); }
});

it('resumes a cancelled join after reload using its pinned account and locator', async () => {
  const drive = server(), first = await open(); await finish(first);
  const left = drive.composition(first).sync; await left.initialize(false); await left.connect(); await left.create();
  let second = await open(); let right = drive.composition(second).sync; await right.initialize(false); await right.connect();
  const sourceId = (await second.view()).collection.descriptor.datasetId;
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>(resolve => { entered = resolve; }); let reads = 0;
  drive.beforeRead(async () => { if (++reads === 2) { entered(); await new Promise<void>(resolve => { release = resolve; }); } });
  const joining = right.join(right.candidates![0]); await barrier; right.cancel(); release(); await joining;
  expect((await second.view()).collection.descriptor.datasetId).toBe(sourceId); expect(await second.pendingJoin()).not.toBeNull();
  expect((await second.syncState()).operations).toEqual([]); const posts = drive.posts.length;
  right.stop(); const name = second.db.name; second.close(); second = await open(name);
  right = drive.composition(second).sync; await right.initialize(false); expect(right.joining).toBe(true);
  drive.setAccount('account-B'); await right.connect(); expect((await second.view()).collection.descriptor.datasetId).toBe(sourceId);
  expect(drive.posts).toHaveLength(posts); drive.setAccount('account-A'); drive.beforeRead(undefined); await right.connect();
  expect(right.joining).toBe(false); expect(right.status).toBe('Synced'); expect((await second.view()).history).toHaveLength(1);
});
