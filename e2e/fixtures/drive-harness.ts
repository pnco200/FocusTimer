import { LocalRepository } from '../../src/web/repository';
import { GoogleDriveAuthorization, DRIVE_FILE_SCOPE, type GoogleIdentityServices } from '../../src/web/google-drive-auth';
import { GoogleDriveClient } from '../../src/web/google-drive-transport';
import { GoogleDriveSync } from '../../src/web/google-drive-sync';
import { pin } from '../../src/web/model';

let repository: LocalRepository;
let sync: GoogleDriveSync;
let grantedScope = DRIVE_FILE_SCOPE;
const stamp = '2026-10-19T12:00:00.000Z';
async function open(name: string) {
  repository = await LocalRepository.open(name); await repository.initialize();
  const gis: GoogleIdentityServices = { initTokenClient: config => ({ requestAccessToken() {
    queueMicrotask(() => config.callback({ access_token: 'SYNTHETIC-TRANSIENT-TOKEN', expires_in: 3600, scope: grantedScope }));
  } }) };
  const authorization = new GoogleDriveAuthorization({ clientId: 'synthetic-web-client', gis });
  const api = new GoogleDriveClient(account => authorization.credentials(account), { maxRetries: 0 });
  sync = new GoogleDriveSync(repository, 'synthetic-web-client', authorization, api);
  await sync.initialize(false);
}
async function finish(description: string) {
  const { active } = await repository.acquireOwner(crypto.randomUUID());
  const started = await repository.saveActive(pin(active), { ...active, id: crypto.randomUUID(),
    startedAt: stamp, state: 'paused', focusMs: 1234, description });
  return repository.finish(pin(started), 1234, stamp, description);
}
async function edit(entityId: string, description: string) {
  const row = (await repository.view()).history.find(row => row.id === entityId)!;
  return repository.edit(row.datasetId, row.winner.opId, { ...row.winner.payload!, description });
}
async function remove(entityId: string) {
  const row = (await repository.view()).history.find(row => row.id === entityId)!;
  return repository.delete(row.datasetId, entityId, row.winner.opId);
}
async function snapshot() {
  return JSON.parse(JSON.stringify({ graph: await repository.remote().snapshot(), view: await repository.view(),
    status: sync.status, message: sync.message, candidates: sync.candidates,
    authorized: sync.authorized, connected: sync.connected }, (_key, value) => value instanceof Uint8Array ? [...value] : value));
}
async function persisted() {
  const tx = repository.db.transaction([...repository.db.objectStoreNames], 'readonly');
  const values = await Promise.all([...repository.db.objectStoreNames].map(store => new Promise(resolve => {
    const request = tx.objectStore(store).getAll(); request.onsuccess = () => resolve(request.result);
  })));
  return JSON.stringify({ values, archive: await repository.archive() });
}
const harness = { open, finish, edit, remove, snapshot, persisted,
  connect: () => sync.connect(), create: () => sync.create(), synchronize: () => sync.sync(),
  join: (index = 0) => sync.join(sync.candidates![index]),
  scope: (value: string) => { grantedScope = value; },
};
declare global { interface Window { driveHarness: typeof harness } }
window.driveHarness = harness;
