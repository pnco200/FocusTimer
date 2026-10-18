import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_COUNTER, reduceOperations } from '../src/protocol/index.js';
import { LocalRepository } from '../src/web/repository';
import { LocalError, pin, type Active, type LocalView, type Session } from '../src/web/model';
import { Stopwatch, type Clock } from '../src/web/timer';
import { TimerClient } from '../src/web/client';
import { clockText, csvExport, historyExport, statistics } from '../src/web/reporting';

const repos: LocalRepository[] = [];
const stamp = '2026-10-17T15:00:00.000Z';
async function open(name: string = crypto.randomUUID()) {
  const repo = await LocalRepository.open(name); repos.push(repo); await repo.initialize(); return repo;
}
async function timer(repo: LocalRepository, clock: Clock = { monotonic: () => 10, utc: () => stamp }) {
  const { active } = await repo.acquireOwner(crypto.randomUUID()); return new Stopwatch(active, repo, clock);
}
async function rows<T = unknown>(repo: LocalRepository, store: string): Promise<T[]> {
  const tx = repo.db.transaction(store); const req = tx.objectStore(store).getAll();
  return new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
}
async function write(repo: LocalRepository, store: string, value: unknown, key?: IDBValidKey) {
  const tx = repo.db.transaction(store, 'readwrite'); tx.objectStore(store).put(value, key);
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
}
async function complete(repo: LocalRepository, description = 'A session', duration = 1234) {
  const watch = await timer(repo); watch.setDescription(description); await watch.start();
  const session = await repo.finish(pin(watch.active), duration, stamp, description);
  return { session, view: await repo.view() };
}
afterEach(() => { for (const repo of repos.splice(0)) repo.close(); });

describe('real IndexedDB API transaction invariants (fake-indexeddb engine)', () => {
  it('creates an account-free collection and writer, then retains identity on reopen', async () => {
    const repo = await open(); const before = await repo.view(); repo.close();
    const reopened = await open(repo.db.name); const after = await reopened.view();
    expect(after).toEqual(before); expect(after.collection.highWater).toBe(0);
    expect(after.installation.writerId).not.toBe(after.installation.selectedDatasetId);
  });
  it('recovers a running checkpoint paused without adding closed time or reusing anchors', async () => {
    const repo = await open(); let ms = 0;
    const watch = await timer(repo, { monotonic: () => ms, utc: () => stamp });
    watch.setDescription('Durable draft'); await watch.start(); ms = 4321.875; await watch.checkpoint();
    const original = watch.active; repo.close(); ms = 9_999_999;
    const reopened = await open(repo.db.name); const recovered = await reopened.acquireOwner(crypto.randomUUID());
    expect(recovered.recovered).toBe(true); expect(recovered.active.state).toBe('paused');
    expect(recovered.active.focusMs).toBe(4321.875); expect(recovered.active.id).toBe(original.id);
    expect(recovered.active.startedAt).toBe(original.startedAt); expect(recovered.active.description).toBe('Durable draft');
    const restored = new Stopwatch(recovered.active, reopened, { monotonic: () => ms, utc: () => stamp });
    ms += 50000; expect(restored.elapsed()).toBe(4321.875);
  });
  it.each(['operations', 'history', 'outbox', 'collections', 'receipts', 'active', 'before-commit'])('failed Finish at %s is wholly rolled back, retaining active work', async point => {
    const repo = await open(); const watch = await timer(repo); await watch.start();
    const before = await repo.view();
    repo.fault = actual => { if (actual === point) throw new DOMException('Disk full', 'QuotaExceededError'); };
    await expect(repo.finish(pin(watch.active), 850.9, stamp, 'Kept')).rejects.toThrow('Disk full');
    repo.fault = undefined;
    expect(await repo.view()).toEqual(before);
    expect(await rows(repo, 'operations')).toHaveLength(0); expect(await rows(repo, 'outbox')).toHaveLength(0);
    expect(await rows(repo, 'receipts')).toHaveLength(0);
    const saved = await repo.finish(pin(watch.active), 850.9, stamp, 'Kept');
    expect(saved.focusDurationMs).toBe(850); expect((await repo.view()).active.state).toBe('idle');
  });
  it('competing duplicate Finish attempts across connections produce one outcome', async () => {
    const repo = await open(); const second = await open(repo.db.name); const watch = await timer(repo); await watch.start();
    const expected = pin(watch.active);
    const outcomes = await Promise.all([repo.finish(expected, 11, stamp, 'first'), second.finish(expected, 999, stamp, 'retry')]);
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(await rows(repo, 'operations')).toHaveLength(1); expect(await rows(repo, 'outbox')).toHaveLength(1);
    repo.close(); const third = await open(repo.db.name);
    expect(await third.finish(expected, 123, stamp, 'after restart')).toEqual(outcomes[0]);
  });
  it('fences a returning obsolete owner and rejects stale active revisions', async () => {
    const repo = await open(); const watch = await timer(repo); await watch.start(); const stale = pin(watch.active);
    await watch.checkpoint(); await expect(repo.saveActive(stale, watch.active)).rejects.toMatchObject({ code: 'stale-active' });
    const prior = pin(watch.active); const owner = await repo.acquireOwner(crypto.randomUUID());
    expect(owner.active.owner!.generation).toBeGreaterThan(prior.owner.generation);
    await expect(repo.finish(prior, 500, stamp, '')).rejects.toMatchObject({ code: 'stale-owner' });
    await expect(repo.saveActive(prior, watch.active)).rejects.toMatchObject({ code: 'stale-owner' });
    expect((await repo.view()).history).toHaveLength(0);
  });
  it('claims an idle timer automatically, preserving its saved draft and fencing an earlier idle owner', async () => {
    const repo = await open(); const watch = await timer(repo);
    watch.setDescription('Saved before starting'); await watch.checkpoint();
    const before = await repo.view(); const other = await open(repo.db.name);
    const token = crypto.randomUUID(); const claimed = await other.acquireOwner(token, true);
    expect(claimed.recovered).toBe(false);
    expect(claimed.active).toEqual({ ...before.active, revision: before.active.revision + 1,
      owner: { token, generation: before.active.owner!.generation + 1 } });
    await expect(watch.start()).rejects.toMatchObject({ code: 'stale-owner' });
    expect((await other.view()).active).toEqual(claimed.active);
    expect(await rows(repo, 'operations')).toEqual([]);
  });
  it.each(['running', 'paused'])('idle-only startup cannot take over a %s timer, even after reading an idle state', async state => {
    const repo = await open(); const watch = await timer(repo); const other = await open(repo.db.name);
    expect((await other.view()).active.state).toBe('idle');
    await watch.start(); if (state === 'paused') await watch.pause();
    const before = await repo.view();
    await expect(other.acquireOwner(crypto.randomUUID(), true)).rejects.toMatchObject({ code: 'stale-owner' });
    expect(await repo.view()).toEqual(before);
  });
  it('serializes a competing start and idle claim so only the current owner can start', async () => {
    const repo = await open(); const watch = await timer(repo); const other = await open(repo.db.name);
    const outcomes = await Promise.allSettled([watch.start(), other.acquireOwner(crypto.randomUUID(), true)]);
    expect(outcomes.map(outcome => outcome.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect((await repo.view()).active.state).toBe(outcomes[0].status === 'fulfilled' ? 'running' : 'idle');
    const rejected = outcomes.find(outcome => outcome.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: 'stale-owner' });
  });
  it('stale editors and confirmed deletes cannot silently overwrite changed/deleted bases', async () => {
    const repo = await open(); const { session, view } = await complete(repo);
    const original = view.history[0];
    expect(await repo.edit(original.datasetId, original.winner.opId, session)).toBe(false);
    expect(await repo.edit(original.datasetId, original.winner.opId, { ...session, description: 'Changed' })).toBe(true);
    await expect(repo.edit(original.datasetId, original.winner.opId, { ...session, focusDurationMs: 12 })).rejects.toMatchObject({ code: 'stale-editor' });
    await expect(repo.delete(original.datasetId, session.id, original.winner.opId)).rejects.toMatchObject({ code: 'stale-editor' });
    const current = (await repo.view()).history[0]; await repo.delete(current.datasetId, session.id, current.winner.opId);
    expect(await repo.delete(current.datasetId, session.id, current.winner.opId)).toBe(false);
    expect(await repo.delete(current.datasetId, crypto.randomUUID(), current.winner.opId)).toBe(false);
    await expect(repo.edit(current.datasetId, current.winner.opId, session)).rejects.toMatchObject({ code: 'stale-editor' });
    const ops = await rows(repo, 'operations'); expect(ops).toHaveLength(3);
    expect(reduceOperations(ops).entities).toEqual([]); expect(reduceOperations(ops).tombstones).toEqual([session.id]);
  });
  it('independent date/duration edits preserve unchanged received text exactly', async () => {
    const repo = await open(); const { session, view } = await complete(repo);
    // Simulate a preserved received value in both authoritative journal and projection.
    const entry = view.history[0]; entry.winner.payload!.description = '';
    await write(repo, 'operations', entry.winner); await write(repo, 'history', entry);
    await repo.edit(entry.datasetId, entry.winner.opId, { ...session, description: '', startedAt: '0001-01-01T00:00:00.000Z', focusDurationMs: 1 });
    const edited = (await repo.view()).history[0].winner.payload!;
    expect(edited.description).toBe(''); expect(edited.endedAt).toBe(session.endedAt); expect(edited.focusDurationMs).toBe(1);
    await repo.edit(entry.datasetId, (await repo.view()).history[0].winner.opId, { ...edited, description: '  新しい 🧠  ' });
    expect((await repo.view()).history[0].winner.payload!.description).toBe('新しい 🧠');
  });
  it('competing edits allocate serialized counters and preserve immutable losing operations/outbox', async () => {
    const repo = await open(); await complete(repo, 'first'); await complete(repo, 'second');
    const other = await open(repo.db.name); const view = await repo.view();
    await Promise.all(view.history.map((entry, i) => (i ? other : repo).edit(entry.datasetId, entry.winner.opId, { ...entry.winner.payload!, description: `Edit ${i}` })));
    const ops = await rows<{ lamportCounter: number }>(repo, 'operations');
    expect(ops.map(op => op.lamportCounter).sort()).toEqual([1, 2, 3, 4]);
    expect((await repo.view()).collection.highWater).toBe(4); expect(await rows(repo, 'outbox')).toHaveLength(4);
  });
  it('repairs a damaged projection only from a validated journal, preserving evidence and high-water', async () => {
    const repo = await open(); const { view } = await complete(repo);
    await write(repo, 'history', { ...view.history[0], winner: { invalid: true } });
    repo.close(); const reopened = await open(repo.db.name);
    expect((await reopened.view()).history).toEqual(view.history); expect(await rows(reopened, 'evidence')).toHaveLength(1);
  });
  it('never silently resets an unreadable journal; explicit recovery retains its source', async () => {
    const repo = await open(); const { view } = await complete(repo);
    const damaged = { ...view.history[0].winner, schemaVersion: 99 };
    await write(repo, 'operations', damaged);
    await expect(repo.initialize()).rejects.toThrow();
    expect(await rows(repo, 'operations')).toEqual([damaged]);
    await repo.newCollection(); await repo.initialize();
    expect((await repo.view()).history).toEqual([]); expect(await rows(repo, 'operations')).toEqual([damaged]);
    expect(await rows(repo, 'evidence')).toHaveLength(1);
  });
  it('orphaned retained records without installation metadata are never treated as a fresh empty database', async () => {
    const repo = await LocalRepository.open(crypto.randomUUID()); repos.push(repo);
    const orphan = { datasetId: crypto.randomUUID(), opId: crypto.randomUUID(), reservation: null };
    await write(repo, 'outbox', orphan);
    await expect(repo.initialize()).rejects.toMatchObject({ code: 'recovery' });
    expect(await rows(repo, 'collections')).toEqual([]); expect(await rows(repo, 'outbox')).toEqual([orphan]);
  });
  it('an unreadable active checkpoint is preserved rather than silently cleared', async () => {
    const repo = await open(); const watch = await timer(repo); await watch.start();
    const damaged = { ...watch.active, owner: null }; await write(repo, 'active', damaged, 'current');
    await expect(repo.initialize()).rejects.toThrow('owner metadata'); expect(await rows(repo, 'active')).toEqual([damaged]);
  });
  it('counter exhaustion preserves active work and deliberate recovery Finish is atomic', async () => {
    const repo = await open(); const watch = await timer(repo); await watch.start();
    const view = await repo.view(); view.collection.highWater = MAX_COUNTER; await write(repo, 'collections', view.collection);
    await expect(repo.finish(pin(watch.active), 55, stamp, 'Original')).rejects.toThrow('exhausted');
    const recoveryId = crypto.randomUUID();
    repo.fault = point => { if (point === 'receipts') throw new Error('Crash'); };
    await expect(repo.finish(pin(watch.active), 55, stamp, 'Original', crypto.randomUUID(), recoveryId)).rejects.toThrow('Crash');
    repo.fault = undefined; expect((await repo.view()).active.id).toBe(watch.active.id);
    expect(await rows(repo, 'collections')).toHaveLength(1);
    await repo.finish(pin(watch.active), 55, stamp, 'Original', crypto.randomUUID(), recoveryId);
    const after = await repo.view(); expect(after.collection.descriptor.datasetId).toBe(recoveryId);
    expect(after.collection.highWater).toBe(1); expect(after.active.state).toBe('idle'); expect(await rows(repo, 'collections')).toHaveLength(2);
  });
  it('dataset archive covers edits and tombstones without active state or installation metadata', async () => {
    const repo = await open(); await complete(repo); let view = await repo.view();
    const entry = view.history[0]; await repo.edit(entry.datasetId, entry.winner.opId, { ...entry.winner.payload!, description: 'Edit' });
    view = await repo.view(); await repo.delete(entry.datasetId, entry.id, view.history[0].winner.opId);
    const archive = await repo.archive(); expect(archive.unsegmentedOperations).toHaveLength(3);
    expect(Object.keys(archive)).toEqual(['format', 'formatVersion', 'coverage', 'dataset', 'segments', 'unsegmentedOperations']);
    expect(reduceOperations(archive.unsegmentedOperations).tombstones).toEqual([entry.id]);
  });
});

describe('stopwatch behavior and exports', () => {
  it('excludes pauses and reset dialog time, keeps start/id on resume, accepts subsecond/reversed clocks', async () => {
    const repo = await open(); let ms = 0; let wall = stamp;
    const watch = await timer(repo, { monotonic: () => ms, utc: () => wall });
    watch.setDescription('  Deep work  '); await watch.start(); const start = watch.active.startedAt; const id = watch.active.id;
    await watch.start(); ms = 300.9; await watch.pause(); await watch.pause();
    ms += 100000; expect(watch.elapsed()).toBe(300.9); await watch.start();
    expect(watch.active.id).toBe(id); expect(watch.active.startedAt).toBe(start);
    ms += 10.9; wall = '2020-01-01T00:00:00.000Z'; const result = await watch.finish();
    expect(result.focusDurationMs).toBe(311); expect(result.description).toBe('Deep work');
    expect(result.endedAt < result.startedAt).toBe(true); expect(watch.description).toBe('');
    watch.setDescription('Keep description'); await watch.start(); ms += 50; await watch.pause(); ms += 9999; await watch.reset();
    expect(watch.elapsed()).toBe(0); expect(watch.description).toBe('Keep description'); expect((await repo.view()).history).toHaveLength(1);
  });
  it('checkpoint latency and rendering throttling do not discard time', async () => {
    const repo = await open(); let ms = 0;
    const watch = await timer(repo, { monotonic: () => ms, utc: () => stamp }); await watch.start();
    repo.fault = point => { if (point === 'before-commit') ms += 90; };
    ms = 5000; await watch.checkpoint(); expect(watch.elapsed()).toBe(5090);
    repo.fault = undefined; ms = 65_432.9;
    expect(watch.elapsed()).toBe(65_432.9); expect((await watch.finish()).focusDurationMs).toBe(65_432);
  });
  it('failed saves retain in-memory timing and draft; failed finish never clears them', async () => {
    const repo = await open(); let ms = 0; const watch = await timer(repo, { monotonic: () => ms, utc: () => stamp });
    await watch.start(); watch.setDescription('Still here'); ms = 123;
    repo.fault = () => { throw new Error('Quota'); };
    await expect(watch.checkpoint()).rejects.toThrow('Quota'); ms = 222;
    await expect(watch.finish()).rejects.toThrow('Quota');
    expect(watch.description).toBe('Still here'); expect(watch.active.state).toBe('running'); expect(watch.elapsed()).toBe(222);
    repo.fault = undefined; expect((await watch.finish()).focusDurationMs).toBe(222);
  });
  it('fallback discards unproven live gap without adding wall time', async () => {
    const repo = await open(); let ms = 0; const watch = await timer(repo, { monotonic: () => ms, utc: () => stamp });
    await watch.start(); ms = 5500; await watch.checkpoint(); ms += 120000; await watch.conservativePause();
    expect(watch.elapsed()).toBe(5500); expect(watch.active.state).toBe('paused');
  });
  it('a successful background checkpoint does not hide an unresolved failed history edit', async () => {
    const repo = await open(); const watch = await timer(repo); const client = new TimerClient(repo);
    client.stopwatch = watch;
    await client.run(async () => { throw new LocalError('stale-editor', 'Session changed; reopen the editor.'); });
    expect(client.error).toContain('reopen');
    await client.run(() => watch.checkpoint(), false); expect(client.error).toContain('reopen');
    await client.run(() => watch.checkpoint()); expect(client.error).toBe('');
  });
  it('queued commands never retarget a newly acquired stopwatch owner', async () => {
    const repo = await open(); const watch = await timer(repo); const client = new TimerClient(repo);
    client.stopwatch = watch;
    let unblock!: () => void;
    const wait = new Promise<void>(resolve => { unblock = resolve; });
    const first = client.run(() => wait); await Promise.resolve();
    let acted = false;
    const queued = client.run(async () => { acted = true; });
    client.stopwatch = null; unblock(); await first; await queued;
    expect(acted).toBe(false); expect(client.error).toContain('another tab');
    expect(client.lastError).toMatchObject({ code: 'stale-owner' });
  });
  it('enforces 120 Unicode scalars before authoring trim and preserves fractional checkpoints', async () => {
    const repo = await open(); const watch = await timer(repo); watch.setDescription('🧠'.repeat(120));
    expect(() => watch.setDescription('🧠'.repeat(121))).toThrow(); await watch.start();
    expect((await repo.finish(pin(watch.active), 1.99, stamp, watch.description)).focusDurationMs).toBe(1);
    await expect(repo.edit((await repo.view()).installation.selectedDatasetId, (await repo.view()).history[0].winner.opId,
      { ...(await repo.view()).history[0].winner.payload!, focusDurationMs: 0 })).rejects.toThrow();
  });
  it('formats hours beyond 24 and exports exact decimal milliseconds with formula protection', () => {
    const session: Session = { id: crypto.randomUUID(), startedAt: stamp, endedAt: stamp, focusDurationMs: 90_000_001, description: '=SUM("x")\nnext' };
    expect(clockText(session.focusDurationMs)).toBe('25:00:00');
    const csv = csvExport([session]); expect(csv).toContain('"\'=SUM(""x"")\nnext"'); expect(csv).toContain('90000.001\r\n');
    const json = historyExport([session]); expect(json[0]).toBe('{'); expect(JSON.parse(json)).toEqual({ format: 'focus-timer-history', formatVersion: 1, sessions: [session] });
  });
  it('uses exact totals beyond safe-number aggregation, Monday bounds and current local finish dates', () => {
    const now = new Date(2026, 9, 17, 12); // Saturday, local calendar
    const session = (date: Date, duration = 3_155_760_000_000): Session => ({ id: crypto.randomUUID(), startedAt: stamp, endedAt: date.toISOString(), focusDurationMs: duration, description: '' });
    const today = session(now, 100); const monday = session(new Date(2026, 9, 12, 0, 0), 200);
    const sunday = session(new Date(2026, 9, 11, 23, 59), 400); const future = session(new Date(2026, 9, 18), 800);
    const result = statistics([today, monday, sunday, future], now);
    expect(result.today.ms).toBe(100n); expect(result.week.ms).toBe(300n); expect(result.all.ms).toBe(1500n);
    const many = Array.from({ length: 4000 }, () => session(now));
    expect(statistics(many, now).all.ms).toBe(12_623_040_000_000_000n);
  });
});
