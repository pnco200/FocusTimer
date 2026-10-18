import { LocalRepository } from '../../src/web/repository';
import { SyncRunner } from '../../src/web/sync-runner';
import { TransportError, type SyncTransport, type TransportFailure } from '../../src/web/sync-transport';
import { pin, type Operation } from '../../src/web/model';
import type { Binding } from '../../src/web/remote-repository';

const stamp = '2026-01-02T03:04:05.000Z';
type Options = { signal?: AbortSignal; maxBytes?: number };
type Phase = 'reserve' | 'seal' | 'confirm' | 'before-acknowledge' | 'recordPage' | 'after-read';

/** Requests go to a Playwright-owned byte store, whose lifetime exceeds this document. */
class HttpTransport implements SyncTransport {
  private async request(method: string, input: unknown, signal?: AbortSignal) {
    const response = await fetch(`/__async/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal,
    });
    const result = await response.json();
    if (!response.ok) throw new TransportError(result.code as TransportFailure);
    return result;
  }
  async readDescriptor(binding: Binding, options: Options) {
    const result = await this.request('descriptor', { binding, maxBytes: options.maxBytes }, options.signal);
    return Uint8Array.from(result.bytes);
  }
  enumerate(binding: Binding, cursor: unknown, options: Options) {
    return this.request('enumerate', { binding, cursor }, options.signal);
  }
  async read(binding: Binding, reference: string, options: Options) {
    const result = await this.request('read', { binding, reference, maxBytes: options.maxBytes }, options.signal);
    const value = { bytes: Uint8Array.from(result.bytes), complete: result.complete };
    if (window.asyncPause === 'after-read') await pause('after-read');
    return value;
  }
  async preparePublication(binding: Binding, publication: { segmentId: string }, options: Options) {
    return (await this.request('prepare', { binding, ...publication }, options.signal)).retryHandle as string;
  }
  async publish(binding: Binding, publication: { segmentId: string; bytes: Uint8Array; retryHandle: string }, options: Options) {
    const result = await this.request('publish', { binding, ...publication, bytes: Array.from(publication.bytes) }, options.signal);
    return { ...result, bytes: Uint8Array.from(result.bytes) };
  }
}

async function open(name: string, datasetId?: string) {
  // The normal initializer creates independent empty replicas, with distinct writers.
  // Sharing the first allocated dataset UUID supplies a common descriptor without an import feature.
  let first = true;
  window.asyncLocal = await LocalRepository.open(name, () => {
    if (first) { first = false; if (datasetId) return datasetId; }
    return crypto.randomUUID();
  });
  await window.asyncLocal.initialize();
  window.asyncRepository = window.asyncLocal.remote();
  window.asyncTransport = new HttpTransport();
  window.asyncRunner = new SyncRunner(window.asyncRepository, window.asyncTransport);
  return window.asyncLocal.syncState();
}

async function bind() {
  const { descriptor } = await window.asyncLocal.syncState();
  return window.asyncRepository.bind({ account: 'browser-test', locator: 'byte-store', descriptor });
}

async function finish(description = 'Native async work') {
  const { active } = await window.asyncLocal.acquireOwner(crypto.randomUUID());
  const started = await window.asyncLocal.saveActive(pin(active), {
    ...active, id: crypto.randomUUID(), startedAt: stamp, state: 'paused', focusMs: 123.75, description,
  });
  return window.asyncLocal.finish(pin(started), 123.75, stamp, description);
}

async function edit(entityId: string, description: string) {
  const winner = (await window.asyncLocal.view()).history.find(row => row.id === entityId)!.winner;
  return window.asyncLocal.edit(winner.datasetId, winner.opId, { ...winner.payload!, description });
}

async function remove(entityId: string) {
  const winner = (await window.asyncLocal.view()).history.find(row => row.id === entityId)!.winner;
  return window.asyncLocal.delete(winner.datasetId, entityId, winner.opId);
}

function operation(datasetId: string, description: string): Operation {
  const entityId = crypto.randomUUID();
  return { protocolVersion: 1, schemaVersion: 1, datasetId, opId: crypto.randomUUID(), deviceId: crypto.randomUUID(),
    entityType: 'focusSession', entityId, operation: 'UPSERT', lamportCounter: 50,
    payload: { id: entityId, startedAt: stamp, endedAt: stamp, focusDurationMs: 456, description } };
}

function segment(datasetId: string, operations: Operation[]) {
  return Array.from(new TextEncoder().encode(JSON.stringify({ protocolVersion: 1, datasetId,
    deviceId: operations[0].deviceId, segmentId: crypto.randomUUID(), operations })));
}

async function pause(phase: Phase) {
  window.asyncPhase = phase;
  // Deliberately never resolved. A document reload destroys this execution lifetime.
  await new Promise<void>(() => {});
}

function start(phase?: Phase, options: { maxPages?: number; maxPublications?: number } = {}) {
  window.asyncPause = phase;
  window.asyncPhase = undefined; window.asyncDone = false; window.asyncError = undefined;
  if (phase && phase !== 'after-read') {
    const method = phase === 'before-acknowledge' ? 'acknowledge' : phase;
    const repository = window.asyncRepository as unknown as Record<string, (...args: any[]) => Promise<any>>;
    const original = repository[method].bind(window.asyncRepository);
    repository[method] = async (...args: any[]) => {
      if (phase === 'before-acknowledge') await pause(phase);
      const result = await original(...args);
      if (phase === 'recordPage' && !args[2].references.length) return result;
      await pause(phase);
      return result;
    };
  }
  window.asyncAbort = new AbortController();
  void window.asyncRunner.run({ ...options, signal: window.asyncAbort.signal })
    .then(status => { window.asyncResult = status; })
    .catch(error => { window.asyncError = error.code ?? error.message; })
    .finally(() => { window.asyncDone = true; });
}

const harness = { open, bind, finish, edit, remove, operation, segment, start };
declare global {
  interface Window {
    asyncHarness: typeof harness;
    asyncLocal: LocalRepository;
    asyncRepository: ReturnType<LocalRepository['remote']>;
    asyncTransport: HttpTransport;
    asyncRunner: SyncRunner;
    asyncPause?: Phase;
    asyncPhase?: Phase;
    asyncAbort: AbortController;
    asyncDone: boolean;
    asyncResult?: unknown;
    asyncError?: string;
  }
}
window.asyncHarness = harness;
