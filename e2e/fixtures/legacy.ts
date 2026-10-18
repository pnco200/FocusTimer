// Literal schema-1 data from the previously shipped local repository shape.
// Independent of the new migration/repository and shared by native + engine tests.
const uuid = (n: number) => `10000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
export const stamp = '2026-10-17T15:00:00.000Z';
export function legacyFixture() {
  const datasetId = uuid(1), writerId = uuid(2);
  const session = (id: number, description: string) => ({ id: uuid(id), startedAt: stamp, endedAt: stamp, focusDurationMs: 1234, description });
  const first = session(3, '  Keep exact imported text  '), second = session(4, 'Deleted');
  const operation = (n: number, payload: typeof first, kind: 'UPSERT' | 'DELETE' = 'UPSERT') => ({
    protocolVersion: 1, schemaVersion: 1, opId: uuid(10 + n), datasetId, deviceId: writerId,
    entityType: 'focusSession', entityId: payload.id, operation: kind, lamportCounter: n,
    ...(kind === 'UPSERT' ? { payload } : {}),
  });
  const operations = [operation(1, first), operation(2, { ...first, focusDurationMs: 61234 }), operation(3, second), operation(4, second, 'DELETE')];
  const collections = [{ descriptor: { application: 'focus-timer', protocolVersion: 1, datasetId }, highWater: 7 }];
  const installation = { version: 1, writerId, selectedDatasetId: datasetId };
  const active = { id: uuid(30), revision: 9, datasetId, startedAt: stamp, description: 'Paused draft',
    focusMs: 987.75, state: 'paused', owner: { token: uuid(31), generation: 4 } };
  const history = [operations[1], operations[3]].map(winner => ({ datasetId, id: winner.entityId, winner }));
  const outbox = operations.map(op => ({ datasetId, opId: op.opId, reservation: null }));
  const receipts = [{ activeId: uuid(32), datasetId, opId: operations[0].opId, session: first }];
  return { installation, collections, active, history, operations, outbox, receipts, evidence: [] };
}

export async function seedLegacy(name: string) {
  const fixture = legacyFixture();
  return writeLegacyFixture({ name, fixture });
}

// Self-contained so the production-origin test can run it before loading React.
export async function writeLegacyFixture({ name, fixture }: { name: string; fixture: ReturnType<typeof legacyFixture> }) {
  const opening = indexedDB.open(name, 1);
  opening.onupgradeneeded = () => {
    const db = opening.result;
    db.createObjectStore('meta');
    db.createObjectStore('collections', { keyPath: 'descriptor.datasetId' }); db.createObjectStore('active');
    db.createObjectStore('history', { keyPath: ['datasetId', 'id'] }).createIndex('dataset', 'datasetId');
    const ops = db.createObjectStore('operations', { keyPath: ['datasetId', 'opId'] });
    ops.createIndex('dataset', 'datasetId'); ops.createIndex('entity', ['datasetId', 'entityId']);
    db.createObjectStore('outbox', { keyPath: ['datasetId', 'opId'] });
    db.createObjectStore('receipts', { keyPath: 'activeId' }); db.createObjectStore('evidence', { autoIncrement: true });
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => { opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
  const tx = db.transaction([...db.objectStoreNames], 'readwrite');
  tx.objectStore('meta').put(fixture.installation, 'installation'); tx.objectStore('active').put(fixture.active, 'current');
  for (const store of ['collections', 'history', 'operations', 'outbox', 'receipts', 'evidence'] as const) {
    for (const row of fixture[store]) tx.objectStore(store).add(row);
  }
  await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); });
  db.close();
  return fixture;
}

export async function rawSnapshot(db: IDBDatabase) {
  const tx = db.transaction([...db.objectStoreNames]);
  const result: Record<string, any[]> = {};
  await Promise.all([...db.objectStoreNames].map(async name => {
    result[name] = await new Promise<any[]>((resolve, reject) => {
      const req = tx.objectStore(name).getAll(); req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
  }));
  return result;
}
