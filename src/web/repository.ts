import {
  nextCounter, operationEqual, validateDescriptor, validateInteger,
  validateOperation, validateSession, validateUuid, MAX_COUNTER, MAX_DURATION_MS,
} from '../protocol/index.js';
import { authoredSession, editedSession, localOperation, materializeOperations } from '../sync/local.js';
import {
  emptyActive, historyOrder, LocalError, validateActive,
  type Active, type ActivePin, type Collection, type HistoryEntry, type Installation,
  type LocalView, type Operation, type Session, type Descriptor,
} from './model';
import { createUuid } from './ids';
import { STORES, request, transaction, type Store } from './idb';
import { RemoteRepository, type Binding, type JoinPlan } from './remote-repository';
import { RemoteError, samePin } from '../sync/remote.js';

export const DATABASE_VERSION = 3;
interface OutboxEntry { datasetId: string; opId: string; reservation: string | null }
interface CompletionReceipt {
  activeId: string; session: Session; datasetId: string; opId: string;
  // Absent on original v1 receipts; never invent a source for legacy recovery Finish.
  sourceDatasetId?: string;
}

/** One real IDB transaction per domain command; never performs network or timer waits. */
export class LocalRepository {
  // Synchronous failure hook exercises actual transaction aborts, including after every conceptual write.
  fault?: (point: string, transaction: IDBTransaction) => void;
  private constructor(public readonly db: IDBDatabase, private ids: () => string) {}

  static async open(name = 'focus-timer-local-v1', ids = createUuid): Promise<LocalRepository> {
    if (typeof globalThis.indexedDB?.open !== 'function') {
      throw new LocalError('storage-unavailable', 'IndexedDB is unavailable.');
    }
    const opening = indexedDB.open(name, DATABASE_VERSION);
    opening.onupgradeneeded = event => {
      const db = opening.result;
      if (event.oldVersion === 0) {
        db.createObjectStore('meta');
        db.createObjectStore('collections', { keyPath: 'descriptor.datasetId' });
        db.createObjectStore('active');
        db.createObjectStore('history', { keyPath: ['datasetId', 'id'] }).createIndex('dataset', 'datasetId');
        const ops = db.createObjectStore('operations', { keyPath: ['datasetId', 'opId'] });
        ops.createIndex('dataset', 'datasetId');
        ops.createIndex('entity', ['datasetId', 'entityId']);
        db.createObjectStore('outbox', { keyPath: ['datasetId', 'opId'] });
        db.createObjectStore('receipts', { keyPath: 'activeId' });
        db.createObjectStore('evidence', { autoIncrement: true });
      }
      // Schema-only upgrade. Domain adoption/validation below is independently
      // atomic and retryable; no completion or operation is invented here.
      if (event.oldVersion < 2) {
        opening.transaction!.objectStore('outbox').createIndex('dataset', 'datasetId');
        opening.transaction!.objectStore('receipts').createIndex('dataset', 'datasetId');
      }
      if (event.oldVersion < 3) {
        db.createObjectStore('remote', { keyPath: 'datasetId' });
        db.createObjectStore('publications', { keyPath: ['datasetId', 'segmentId'] }).createIndex('dataset', 'datasetId');
        db.createObjectStore('segments', { keyPath: ['datasetId', 'segmentId'] }).createIndex('dataset', 'datasetId');
        db.createObjectStore('artifacts', { keyPath: ['datasetId', 'reference'] }).createIndex('dataset', 'datasetId');
      }
    };
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      let blocked = false;
      opening.onerror = () => reject(opening.error);
      opening.onblocked = () => {
        blocked = true;
        reject(new LocalError('storage-blocked', 'An older connection is blocking the database upgrade.'));
      };
      opening.onsuccess = () => {
        if (blocked) opening.result.close();
        else resolve(opening.result);
      };
    });
    // Repositories used without TimerClient must release upgrades too.
    db.onversionchange = () => db.close();
    return new LocalRepository(db, ids);
  }

  close() { this.db.close(); }
  remote() { return new RemoteRepository(this.db, this.ids, () => this.fault); }

  /** A deliberate join hydrates another collection while commands retain the source. */
  async stageJoin(input: { provider?: string; account: string; locator: string; descriptor: Descriptor;
    expectedSourceDatasetId: string; expectedGeneration: number }) {
    input = structuredClone(input);
    const descriptor = validateDescriptor(input.descriptor) as Descriptor;
    const provider = input.provider ?? 'abstract';
    if (![provider, input.account, input.locator].every(value => typeof value === 'string' && !!value)) throw new RemoteError('invalid-binding');
    const plan = await this.transaction('readwrite', async tx => {
      const { installation, collection } = await this.context(tx);
      const sourceDatasetId = installation.selectedDatasetId;
      const source = await this.get<{ bindingGeneration: number }>(tx, 'remote', sourceDatasetId);
      if (sourceDatasetId !== input.expectedSourceDatasetId || (source?.bindingGeneration ?? 0) !== input.expectedGeneration) throw new RemoteError('stale-binding');
      if (sourceDatasetId === descriptor.datasetId) throw new RemoteError('dataset-mismatch', 'Use the retained binding for this history');
      const pending = await this.get<JoinPlan>(tx, 'meta', 'join-plan');
      if (pending?.state === 'hydrating') {
        if (pending.sourceDatasetId !== sourceDatasetId || pending.sourceGeneration !== input.expectedGeneration
          || pending.provider !== provider || pending.account !== input.account || pending.locator !== input.locator
          || JSON.stringify(pending.descriptor) !== JSON.stringify(descriptor)) throw new RemoteError('join-in-progress');
        return pending;
      }
      const existing = await this.get<Collection>(tx, 'collections', descriptor.datasetId);
      if (existing && JSON.stringify(validateDescriptor(existing.descriptor)) !== JSON.stringify(descriptor)) throw new RemoteError('integrity');
      if (!existing) await this.add(tx, 'collections', { descriptor, highWater: 0 });
      const next: JoinPlan = { version: 1, id: this.ids(), sourceDatasetId,
        sourceGeneration: input.expectedGeneration, sourceRevision: collection.highWater,
        descriptor, provider, account: input.account, locator: input.locator, scope: 'all-visible',
        state: 'hydrating', binding: null, hydration: { passId: 0, enumerationComplete: false, reconciled: false } };
      validateUuid(next.id);
      await this.put(tx, 'meta', next, 'join-plan'); return next;
    });
    const repository = new RemoteRepository(this.db, this.ids, () => this.fault, {
      datasetId: descriptor.datasetId, sourceDatasetId: plan.sourceDatasetId,
      sourceGeneration: plan.sourceGeneration, planId: plan.id });
    const state = await repository.bindingState();
    let binding = state.binding;
    if (binding && (binding.provider !== provider || binding.account !== input.account || binding.locator !== input.locator)) {
      throw new RemoteError('destination-transfer-required');
    }
    if (!binding) {
      try {
        binding = await repository.bind({ provider, account: input.account, locator: input.locator,
          descriptor, expectedGeneration: state.bindingGeneration, resumePublications: true });
      } catch (error) {
        if (!(error instanceof RemoteError) || error.code !== 'stale-binding') throw error;
        binding = await repository.captureBinding();
        if (!binding || binding.provider !== provider || binding.account !== input.account || binding.locator !== input.locator) throw error;
      }
    }
    // Recheck source selection even when the target was already durably bound.
    await repository.assertPin(binding);
    return { repository, binding, plan: (await this.pendingJoin())! };
  }

  pendingJoin(): Promise<JoinPlan | null> {
    return this.transaction('readonly', async tx => {
      const plan = await this.get<JoinPlan>(tx, 'meta', 'join-plan');
      return plan?.state === 'hydrating' ? plan : null;
    });
  }

  cancelJoin(planId: string) {
    return this.transaction('readwrite', async tx => {
      const plan = await this.get<JoinPlan>(tx, 'meta', 'join-plan');
      if (plan?.id !== planId || plan.state !== 'hydrating') throw new RemoteError('stale-join');
      plan.state = 'cancelled'; await this.put(tx, 'meta', plan, 'join-plan');
    });
  }

  /** No provisional operations exist: fresh source winners are adopted at atomic idle cutover. */
  async commitJoin(planId: string) {
    await this.transaction('readwrite', async tx => {
      const plan = await this.get<JoinPlan>(tx, 'meta', 'join-plan');
      // Commit response loss may be retried without authoring duplicate operations.
      if (plan?.id === planId && plan.state === 'complete') return;
      const ctx = await this.context(tx);
      if (plan?.id !== planId || plan.state !== 'hydrating' || ctx.installation.selectedDatasetId !== plan.sourceDatasetId) throw new RemoteError('stale-join');
      if (ctx.active.state !== 'idle') throw new RemoteError('active-not-idle');
      const sourceRemote = await this.get<{ bindingGeneration: number }>(tx, 'remote', plan.sourceDatasetId);
      if ((sourceRemote?.bindingGeneration ?? 0) !== plan.sourceGeneration) throw new RemoteError('stale-binding');
      const target = await this.get<Collection>(tx, 'collections', plan.descriptor.datasetId);
      const targetRemote = await this.get<{ binding: Binding | null; blocked: unknown;
        pass: { reconciled: boolean; enumerationComplete: boolean; inProgress: boolean; error: unknown } }>(tx, 'remote', plan.descriptor.datasetId);
      if (!target || JSON.stringify(validateDescriptor(target.descriptor)) !== JSON.stringify(plan.descriptor)
        || !targetRemote || !plan.binding || !samePin(targetRemote.binding, plan.binding)) throw new RemoteError('stale-binding');
      if (!targetRemote.pass.reconciled || !targetRemote.pass.enumerationComplete || targetRemote.pass.inProgress
        || targetRemote.pass.error || targetRemote.blocked) throw new RemoteError('join-incomplete');
      const sourceOperations = (await this.all<Operation>(tx, 'operations', plan.sourceDatasetId)).map(value => validateOperation(value) as Operation);
      const targetOperations = (await this.all<Operation>(tx, 'operations', plan.descriptor.datasetId)).map(value => validateOperation(value) as Operation);
      await this.remote().audit(tx, plan.sourceDatasetId, sourceOperations, await this.all<OutboxEntry>(tx, 'outbox', plan.sourceDatasetId));
      await this.remote().audit(tx, plan.descriptor.datasetId, targetOperations, await this.all<OutboxEntry>(tx, 'outbox', plan.descriptor.datasetId));
      const sourceWinners = materializeOperations(sourceOperations, ctx.collection.highWater).winners as Map<string, Operation>;
      const reducedTarget = materializeOperations(targetOperations, target.highWater);
      const targetWinners = reducedTarget.winners as Map<string, Operation>;
      target.highWater = reducedTarget.highWater;
      const adoptedEntityIds: string[] = [];
      for (const [entityId, winner] of sourceWinners) {
        if (winner.operation !== 'UPSERT' || targetWinners.has(entityId)) continue;
        await this.author(tx, { installation: ctx.installation, collection: target }, entityId, 'UPSERT', winner.payload);
        adoptedEntityIds.push(entityId);
      }
      this.fault?.('join.operations', tx);
      ctx.installation.selectedDatasetId = plan.descriptor.datasetId;
      await this.put(tx, 'meta', ctx.installation, 'installation');
      await this.put(tx, 'active', emptyActive(plan.descriptor.datasetId, nextCounter(ctx.active.revision), ctx.active.owner, ctx.active.description), 'current');
      plan.state = 'complete'; plan.completedSourceRevision = ctx.collection.highWater; plan.adoptedEntityIds = adoptedEntityIds;
      await this.put(tx, 'meta', plan, 'join-plan');
      await this.put(tx, 'evidence', { kind: 'completed-join', plan });
      this.fault?.('join.cutover', tx);
    });
    return this.view();
  }

  retainedCollections() {
    return this.transaction('readonly', async tx => {
      const { installation } = await this.context(tx);
      const collections = await request(tx.objectStore('collections').getAll()) as Collection[];
      return collections.filter(value => value.descriptor.datasetId !== installation.selectedDatasetId)
        .map(value => ({ descriptor: validateDescriptor(value.descriptor) as Descriptor }));
    });
  }

  archiveCollection(datasetId: string) { return this.remote().archiveDataset(datasetId); }

  private async transaction<T>(mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    return transaction(this.db, mode, work, (point, tx) => this.fault?.(point, tx));
  }

  private async get<T>(tx: IDBTransaction, store: Store, key: IDBValidKey): Promise<T> {
    return request(tx.objectStore(store).get(key)) as Promise<T>;
  }
  private async put(tx: IDBTransaction, store: Store, value: unknown, key?: IDBValidKey) {
    await request(tx.objectStore(store).put(value, key));
    this.fault?.(store, tx);
  }
  private async add(tx: IDBTransaction, store: Store, value: unknown) {
    await request(tx.objectStore(store).add(value));
    this.fault?.(store, tx);
  }
  private async all<T>(tx: IDBTransaction, store: Store, datasetId: string): Promise<T[]> {
    return request(tx.objectStore(store).index('dataset').getAll(datasetId)) as Promise<T[]>;
  }
  private async context(tx: IDBTransaction) {
    const installation = await this.get<Installation>(tx, 'meta', 'installation');
    if (!installation || installation.version !== 1) throw new LocalError('recovery', 'Local installation data could not be read.');
    validateUuid(installation.writerId); validateUuid(installation.selectedDatasetId);
    const collection = await this.get<Collection>(tx, 'collections', installation.selectedDatasetId);
    validateDescriptor(collection?.descriptor);
    validateInteger(collection.highWater, 0, MAX_COUNTER);
    const active = validateActive(await this.get<Active>(tx, 'active', 'current'));
    if (active.datasetId !== installation.selectedDatasetId) throw new LocalError('recovery', 'Active timer collection does not match.');
    return { installation, collection, active };
  }

  async initialize(): Promise<LocalView> {
    await this.transaction('readwrite', async tx => {
      if (!await this.get(tx, 'meta', 'installation')) {
        for (const store of STORES) {
          if (await request(tx.objectStore(store).count())) {
            throw new LocalError('recovery', 'Installation metadata is missing. Retained local data has been preserved.');
          }
        }
        await this.createCollection(tx);
      }
      const { installation, collection, active } = await this.context(tx);
      const datasetId = installation.selectedDatasetId;
      const operations = (await this.all<Operation>(tx, 'operations', datasetId)).map(op => validateOperation(op) as Operation);
      // A validated immutable journal is a recovery source, never an excuse to discard damaged data.
      const reduced = materializeOperations(operations, collection.highWater);
      const expected = reduced.winners as Map<string, Operation>;
      const journal = new Map(operations.map(op => [op.opId, op]));
      const history = await this.all<HistoryEntry>(tx, 'history', datasetId);
      for (const entry of history) {
        // In particular, do not delete valid projection-only legacy sessions.
        // Storage migration is not an authorized import/re-authoring decision.
        let winner: Operation;
        try { winner = validateOperation(entry.winner) as Operation; }
        catch {
          if (!expected.has(entry.id)) throw new LocalError('recovery', 'History has no validated journal recovery source.');
          continue;
        }
        const original = journal.get(winner.opId);
        if (winner.datasetId !== datasetId || winner.entityId !== entry.id || !original || !operationEqual(original, winner)) {
          throw new LocalError('recovery', 'History contains an unbacked or conflicting immutable operation.');
        }
      }
      const pending = await this.all<OutboxEntry>(tx, 'outbox', datasetId);
      await this.remote().audit(tx, datasetId, operations, pending);
      for (const receipt of await this.all<CompletionReceipt>(tx, 'receipts', datasetId)) {
        await this.receiptOutcome(tx, receipt);
      }
      if (active.id && await this.get(tx, 'receipts', active.id)) {
        throw new LocalError('recovery', 'An active timer identity was already consumed.');
      }
      if (history.length !== expected.size || history.some(entry => JSON.stringify(entry.winner) !== JSON.stringify(expected.get(entry.id)))) {
        await this.put(tx, 'evidence', { kind: 'projection-repair', datasetId, history });
        for (const entry of history) await request(tx.objectStore('history').delete([datasetId, entry.id]));
        for (const [id, winner] of expected) await this.put(tx, 'history', { datasetId, id, winner });
      }
      collection.highWater = reduced.highWater;
      await this.put(tx, 'collections', collection);
      await this.put(tx, 'meta', { version: DATABASE_VERSION }, 'repository');
    });
    return this.view();
  }

  private async createCollection(tx: IDBTransaction, previous?: Installation) {
    const datasetId = this.ids();
    validateUuid(datasetId);
    const collection: Collection = { descriptor: { application: 'focus-timer', protocolVersion: 1, datasetId }, highWater: 0 };
    const installation: Installation = { version: 1, writerId: previous?.writerId ?? this.ids(), selectedDatasetId: datasetId };
    validateUuid(installation.writerId);
    await request(tx.objectStore('collections').add(collection));
    await this.put(tx, 'meta', installation, 'installation');
    await this.put(tx, 'active', emptyActive(datasetId), 'current');
  }

  /** Explicit recovery only. Keep all old journals, projections, and damaged metadata. */
  async newCollection() {
    await this.transaction('readwrite', async tx => {
      const installation = await this.get<Installation>(tx, 'meta', 'installation');
      const active = await this.get<Active>(tx, 'active', 'current');
      await this.put(tx, 'evidence', { kind: 'deliberate-new-collection', installation, active });
      let previous: Installation | undefined;
      try { validateUuid(installation?.writerId); previous = installation; } catch { /* new installation writer */ }
      await this.createCollection(tx, previous);
    });
  }

  async view(): Promise<LocalView> {
    return this.transaction('readonly', async tx => {
      const ctx = await this.context(tx);
      const history = await this.all<HistoryEntry>(tx, 'history', ctx.installation.selectedDatasetId);
      for (const entry of history) {
        const op = validateOperation(entry.winner) as Operation;
        if (op.entityId !== entry.id || op.datasetId !== entry.datasetId) throw new LocalError('recovery', 'Invalid history projection.');
      }
      return { ...ctx, history: history.filter(entry => entry.winner.operation === 'UPSERT')
        .sort((a, b) => historyOrder(a.winner.payload!, b.winner.payload!)) };
    });
  }

  async acquireOwner(token: string, requireIdle = false): Promise<{ active: Active; recovered: boolean }> {
    validateUuid(token);
    return this.transaction('readwrite', async tx => {
      const { active } = await this.context(tx);
      // Without a lifetime lock, startup may claim an idle timer, but must never
      // recover a started session on the strength of an earlier read or silence.
      if (requireIdle && active.state !== 'idle') throw new LocalError('stale-owner', 'A started timer requires deliberate recovery.');
      const recovered = active.state !== 'idle';
      active.owner = { token, generation: nextCounter(active.owner?.generation ?? 0) };
      active.revision = nextCounter(active.revision);
      if (active.state !== 'idle') active.state = 'paused';
      await this.put(tx, 'active', active, 'current');
      return { active, recovered };
    });
  }

  private async checked(tx: IDBTransaction, expected: ActivePin) {
    const ctx = await this.context(tx);
    const { active } = ctx;
    if (active.owner?.token !== expected.owner.token || active.owner?.generation !== expected.owner.generation) {
      throw new LocalError('stale-owner', 'Another tab owns this timer. Refresh to attach to it.');
    }
    if (active.id !== expected.id || active.revision !== expected.revision || active.datasetId !== expected.datasetId) {
      throw new LocalError('stale-active', 'The timer changed in another command. Refresh before continuing.');
    }
    return ctx;
  }

  async saveActive(expected: ActivePin, next: Active): Promise<Active> {
    expected = structuredClone(expected);
    next = structuredClone(validateActive(next));
    return this.transaction('readwrite', async tx => {
      const { active } = await this.checked(tx, expected);
      if (next.datasetId !== active.datasetId || next.owner?.token !== active.owner?.token || next.owner?.generation !== active.owner?.generation) throw new LocalError('stale-active', 'Active ownership cannot be changed by a command.');
      if (active.id && next.id && (active.id !== next.id || active.startedAt !== next.startedAt)) throw new Error('An active identity/start is immutable.');
      if (next.id && !active.id && await this.get(tx, 'receipts', next.id)) throw new Error('Active identity already consumed.');
      const saved = { ...next, revision: nextCounter(active.revision) };
      await this.put(tx, 'active', saved, 'current');
      return saved;
    });
  }

  private async author(tx: IDBTransaction, ctx: { installation: Installation; collection: Collection }, entityId: string, kind: 'UPSERT' | 'DELETE', payload?: Session) {
    const operation = localOperation({ descriptor: ctx.collection.descriptor, writerId: ctx.installation.writerId,
      highWater: ctx.collection.highWater, opId: this.ids(), entityId, operation: kind, payload }) as Operation;
    const prior = await this.entityOperations(tx, operation.datasetId, entityId);
    const winner = materializeOperations([...prior, operation]).winners.get(entityId);
    await this.add(tx, 'operations', operation); // add, never put: immutable identity constraint
    await this.put(tx, 'history', { datasetId: operation.datasetId, id: entityId, winner });
    await this.add(tx, 'outbox', { datasetId: operation.datasetId, opId: operation.opId, reservation: null });
    ctx.collection.highWater = operation.lamportCounter;
    await this.put(tx, 'collections', ctx.collection);
    return operation;
  }

  private async entityOperations(tx: IDBTransaction, datasetId: string, entityId: string): Promise<Operation[]> {
    return (await request(tx.objectStore('operations').index('entity').getAll([datasetId, entityId])))
      .map(op => validateOperation(op) as Operation);
  }

  private async winner(tx: IDBTransaction, datasetId: string, entityId: string): Promise<Operation | undefined> {
    // The cached projection cannot authorize reviving a tombstone or overwriting a newer base.
    return materializeOperations(await this.entityOperations(tx, datasetId, entityId)).winners.get(entityId);
  }

  private async receiptOutcome(tx: IDBTransaction, receipt: CompletionReceipt): Promise<Session> {
    validateUuid(receipt.activeId); validateUuid(receipt.datasetId); validateUuid(receipt.opId);
    if (receipt.sourceDatasetId !== undefined) validateUuid(receipt.sourceDatasetId);
    const session = validateSession(receipt.session) as Session;
    const operation = await this.get<Operation>(tx, 'operations', [receipt.datasetId, receipt.opId]);
    if (!operation || !operationEqual(operation, { ...operation, operation: 'UPSERT', entityId: session.id, payload: session })) {
      throw new LocalError('recovery', 'Completion receipt does not match its immutable operation.');
    }
    return session;
  }

  async finish(expected: ActivePin, focusMs: number, endedAt: string, description: string, entityId?: string, recoveryDatasetId?: string): Promise<Session> {
    expected = structuredClone(expected);
    return this.transaction('readwrite', async tx => {
      if (!expected.id) throw new Error('Start the timer before finishing.');
      validateUuid(expected.id); validateUuid(expected.datasetId);
      const receipt = await this.get<CompletionReceipt>(tx, 'receipts', expected.id);
      if (receipt) {
        if ((receipt.sourceDatasetId !== undefined && receipt.sourceDatasetId !== expected.datasetId)
          || (recoveryDatasetId !== undefined && receipt.datasetId !== recoveryDatasetId)) {
          throw new LocalError('stale-active', 'The completion retry refers to another collection.');
        }
        return this.receiptOutcome(tx, receipt);
      }
      const ctx = await this.checked(tx, expected);
      entityId ??= this.ids();
      if (!Number.isFinite(focusMs) || focusMs < 0 || focusMs > MAX_DURATION_MS) throw new Error('Focus duration is outside the supported range.');
      const session = authoredSession({ id: entityId, startedAt: ctx.active.startedAt, endedAt,
        focusDurationMs: Math.trunc(focusMs), description }) as Session;
      // Recovery completion also requires a fresh identity in the source corpus.
      if (await this.winner(tx, expected.datasetId, entityId)) throw new Error('Completion requires a fresh session ID.');
      if (recoveryDatasetId) {
        // Deliberate §13 destination: one transaction consumes the original active timer.
        validateUuid(recoveryDatasetId);
        if (ctx.collection.highWater !== MAX_COUNTER) throw new Error('Recovery completion is only available for an exhausted collection.');
        ctx.collection = { descriptor: { application: 'focus-timer', protocolVersion: 1, datasetId: recoveryDatasetId }, highWater: 0 };
        await request(tx.objectStore('collections').add(ctx.collection));
      }
      const entityKey = [ctx.collection.descriptor.datasetId, entityId];
      if (await this.get(tx, 'history', entityKey) || await request(tx.objectStore('operations').index('entity').count(entityKey))) throw new Error('Completion requires a fresh session ID.');
      const operation = await this.author(tx, ctx, entityId, 'UPSERT', session);
      await this.add(tx, 'receipts', { activeId: expected.id, sourceDatasetId: expected.datasetId,
        session, datasetId: operation.datasetId, opId: operation.opId });
      if (recoveryDatasetId) {
        ctx.installation.selectedDatasetId = recoveryDatasetId;
        await this.put(tx, 'meta', ctx.installation, 'installation');
      }
      await this.put(tx, 'active', emptyActive(ctx.installation.selectedDatasetId, nextCounter(ctx.active.revision), ctx.active.owner), 'current');
      return session;
    });
  }

  async edit(datasetId: string, baseOpId: string, candidate: Session): Promise<boolean> {
    const payload = validateSession(candidate) as Session;
    return this.transaction('readwrite', async tx => {
      const ctx = await this.context(tx);
      if (ctx.installation.selectedDatasetId !== datasetId) throw new LocalError('stale-editor', 'The selected collection changed.');
      const winner = await this.winner(tx, datasetId, payload.id);
      if (!winner || winner.operation === 'DELETE' || winner.opId !== baseOpId) throw new LocalError('stale-editor', 'This session changed or was deleted. Close and reopen the editor to review it.');
      const edit = editedSession(winner.payload!, payload);
      if (!edit.changed) return false;
      await this.author(tx, ctx, payload.id, 'UPSERT', edit.payload as Session);
      return true;
    });
  }

  async delete(datasetId: string, entityId: string, baseOpId: string): Promise<boolean> {
    return this.transaction('readwrite', async tx => {
      const ctx = await this.context(tx);
      if (ctx.installation.selectedDatasetId !== datasetId) throw new LocalError('stale-editor', 'The selected collection changed.');
      const winner = await this.winner(tx, datasetId, entityId);
      if (!winner || winner.operation === 'DELETE') return false;
      if (winner.opId !== baseOpId) throw new LocalError('stale-editor', 'This session changed. Review it before deleting.');
      await this.author(tx, ctx, entityId, 'DELETE');
      return true;
    });
  }

  /** Consistent local sync hand-off; excludes every active/runtime field. No transport side effects. */
  async syncState() {
    return this.transaction('readonly', async tx => {
      const { installation, collection } = await this.context(tx);
      const operations = (await this.all<Operation>(tx, 'operations', installation.selectedDatasetId))
        .map(op => validateOperation(op) as Operation).sort((a, b) => a.opId < b.opId ? -1 : 1);
      const outbox = await this.all<OutboxEntry>(tx, 'outbox', installation.selectedDatasetId);
      return { descriptor: collection.descriptor, writerId: installation.writerId, highWater: collection.highWater, operations, outbox };
    });
  }

  async archive() {
    return this.remote().archive();
  }
}
