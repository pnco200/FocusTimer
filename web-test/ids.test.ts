import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_COUNTER, validateOperation, validateSession, validateUuid } from '../src/protocol/index.js';
import { createUuid } from '../src/web/ids';
import { TimerClient } from '../src/web/client';
import { LocalRepository } from '../src/web/repository';
import { pin } from '../src/web/model';
import { Stopwatch } from '../src/web/timer';

const secureValues = crypto.getRandomValues.bind(crypto);
const repos: LocalRepository[] = [];
afterEach(() => {
  for (const repo of repos.splice(0)) repo.close();
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('central secure UUIDv4 authoring', () => {
  it('uses native randomUUID with its Crypto receiver when available', () => {
    const source = {
      randomUUID: vi.fn(function (this: unknown) { expect(this).toBe(source); return '12345678-1234-4234-8234-123456789abc'; }),
      getRandomValues: vi.fn(),
    };
    vi.stubGlobal('crypto', source);
    expect(validateUuid(createUuid())).toBe('12345678-1234-4234-8234-123456789abc');
    expect(source.randomUUID).toHaveBeenCalledOnce(); expect(source.getRandomValues).not.toHaveBeenCalled();
  });

  it.each([0, 255])('sets RFC v4 and variant bits without losing other random bits (%s)', value => {
    const source = { getRandomValues: vi.fn((bytes: Uint8Array) => bytes.fill(value)) };
    vi.stubGlobal('crypto', source);
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Insecure entropy must never be used'); });
    const id = createUuid();
    expect(validateUuid(id)).toBe(id);
    expect(id).toBe(value === 0 ? '00000000-0000-4000-8000-000000000000' : 'ffffffff-ffff-4fff-bfff-ffffffffffff');
    expect(source.getRandomValues).toHaveBeenCalledOnce();
    expect(source.getRandomValues.mock.calls[0][0]).toBeInstanceOf(Uint8Array);
    expect(source.getRandomValues.mock.calls[0][0]).toHaveLength(16);
  });

  it('formats cryptographic bytes in canonical network order without native randomUUID', () => {
    vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => { bytes.set(Array.from({ length: 16 }, (_, i) => i)); return bytes; } });
    expect(createUuid()).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f');
    vi.stubGlobal('crypto', { getRandomValues: secureValues });
    const ids = Array.from({ length: 100 }, createUuid);
    expect(new Set(ids).size).toBe(100);
    for (const id of ids) expect(validateUuid(id)).toBe(id);
  });

  it.each([undefined, {}])('fails explicitly when no cryptographic randomness is available (%s)', source => {
    vi.stubGlobal('crypto', source);
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Insecure entropy must never be used'); });
    expect(createUuid).toThrow(expect.objectContaining({ code: 'secure-random-unavailable' }));
  });

  it('initializes, reopens, completes, edits, deletes, and creates recovery history without randomUUID', async () => {
    vi.stubGlobal('crypto', { getRandomValues: secureValues });
    const repo = await LocalRepository.open('uuid-fallback-integration'); repos.push(repo);
    const initial = await repo.initialize();
    expect(() => new TimerClient(repo)).not.toThrow();
    const owner = await repo.acquireOwner(createUuid());
    let ms = 0;
    const watch = new Stopwatch(owner.active, repo, { monotonic: () => ms, utc: () => '2026-10-17T15:00:00.000Z' });
    await watch.start(); ms = 1530.125; await watch.pause(); await watch.start(); ms += 2000;
    const session = await watch.finish();
    expect(validateSession(session)).toEqual(session); expect(session.focusDurationMs).toBe(3530);
    const completed = (await repo.view()).history[0];
    await repo.edit(completed.datasetId, completed.winner.opId, { ...session, description: 'Edited' });
    const edited = (await repo.view()).history[0];
    await repo.delete(edited.datasetId, session.id, edited.winner.opId);
    const archive = await repo.archive();
    for (const operation of archive.unsegmentedOperations) expect(validateOperation(operation)).toEqual(operation);
    const ids = [initial.installation.selectedDatasetId, initial.installation.writerId, owner.active.owner!.token,
      session.id, ...archive.unsegmentedOperations.map(op => op.opId)];
    for (const id of ids) expect(validateUuid(id)).toBe(id);
    expect(new Set(ids).size).toBe(ids.length);
    const reopened = await LocalRepository.open(repo.db.name); repos.push(reopened);
    expect((await reopened.initialize()).installation).toEqual(initial.installation);

    // Exercise the explicit counter-exhaustion completion path as well as newCollection.
    const nextOwner = await repo.acquireOwner(createUuid());
    const next = new Stopwatch(nextOwner.active, repo, { monotonic: () => 1, utc: () => '2026-10-17T15:00:00.000Z' });
    await next.start();
    const tx = repo.db.transaction('collections', 'readwrite');
    tx.objectStore('collections').put({ ...initial.collection, highWater: MAX_COUNTER });
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
    const recoveryId = createUuid();
    await repo.finish(pin(next.active), 100, '2026-10-17T15:00:00.000Z', 'Recovery', createUuid(), recoveryId);
    expect((await repo.view()).installation.selectedDatasetId).toBe(recoveryId);
    await repo.newCollection();
    const fresh = await repo.initialize();
    expect(validateUuid(fresh.installation.selectedDatasetId)).toBe(fresh.installation.selectedDatasetId);
    expect(fresh.installation.selectedDatasetId).not.toBe(recoveryId);
    expect(fresh.history).toEqual([]);
  });

  it('reports unavailable fundamental storage explicitly', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(LocalRepository.open()).rejects.toMatchObject({ code: 'storage-unavailable' });
  });
});
