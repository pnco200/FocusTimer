import { LocalRepository } from '../../src/web/repository';
import { pin, type Operation } from '../../src/web/model';
import { rawSnapshot, seedLegacy, stamp } from './legacy';

/** Test page only. Vite serves the production repository directly; none of this is bundled into the application. */
async function open(name: string) {
  window.remoteLocal = await LocalRepository.open(name);
  await window.remoteLocal.initialize();
  window.remoteRepository = window.remoteLocal.remote();
  return window.remoteRepository.snapshot();
}

async function bind() {
  const { descriptor } = await window.remoteLocal.syncState();
  return window.remoteRepository.bind({ account: 'test-account', locator: 'test-root', descriptor });
}

async function finish(description = 'Native publication work') {
  const { active } = await window.remoteLocal.acquireOwner(crypto.randomUUID());
  const started = await window.remoteLocal.saveActive(pin(active), {
    ...active, id: crypto.randomUUID(), startedAt: stamp, state: 'paused', focusMs: 123.75, description,
  });
  return window.remoteLocal.finish(pin(started), 123.75, stamp, description);
}

function operation(datasetId: string, values: Partial<Operation> = {}): Operation {
  const entityId = values.entityId ?? crypto.randomUUID();
  return {
    protocolVersion: 1, schemaVersion: 1, opId: crypto.randomUUID(), datasetId,
    deviceId: crypto.randomUUID(), entityType: 'focusSession', entityId,
    operation: 'UPSERT', lamportCounter: 50,
    payload: { id: entityId, startedAt: stamp, endedAt: stamp, focusDurationMs: 456, description: 'Received exact text' },
    ...values,
  };
}

function segment(datasetId: string, operations: Operation[], segmentId: string = crypto.randomUUID()) {
  return new TextEncoder().encode(JSON.stringify({ protocolVersion: 1, datasetId, deviceId: operations[0].deviceId, segmentId, operations }));
}

async function seedSchemaTwo(name: string) {
  await seedLegacy(name);
  const request = indexedDB.open(name, 2);
  request.onupgradeneeded = () => {
    request.transaction!.objectStore('outbox').createIndex('dataset', 'datasetId');
    request.transaction!.objectStore('receipts').createIndex('dataset', 'datasetId');
    request.transaction!.objectStore('meta').put({ version: 2 }, 'repository');
  };
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const before = await rawSnapshot(db); db.close(); return before;
}

// Dedicated workers have independent module instances, database connections and request queues.
async function reserveInWorkers(name: string, binding: unknown) {
  const source = `import { LocalRepository } from ${JSON.stringify(`${location.origin}/src/web/repository.ts`)};
    self.onmessage = async ({ data }) => {
      let repo;
      try {
        repo = await LocalRepository.open(data.name); await repo.initialize();
        const publication = await repo.remote().reserve(data.binding);
        self.postMessage({ publication });
      } catch (error) { self.postMessage({ error: error.code ?? error.message }); }
      finally { repo?.close(); }
    };`;
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    return await Promise.all([0, 1].map(() => new Promise<{ publication?: any; error?: string }>((resolve, reject) => {
      const worker = new Worker(url, { type: 'module' });
      worker.onmessage = event => { worker.terminate(); resolve(event.data); };
      worker.onerror = event => { worker.terminate(); reject(new Error(event.message)); };
      worker.postMessage({ name, binding });
    })));
  } finally { URL.revokeObjectURL(url); }
}

const harness = { open, bind, finish, operation, segment, seedSchemaTwo, rawSnapshot, reserveInWorkers };
declare global {
  interface Window {
    remoteHarness: typeof harness;
    remoteLocal: LocalRepository;
    remoteRepository: ReturnType<LocalRepository['remote']>;
    remotePhase?: string;
  }
}
window.remoteHarness = harness;
