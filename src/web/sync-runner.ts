import { MAX_SEGMENT_BYTES, parseDescriptor, ProtocolError } from '../protocol/index.js';
import { RemoteError } from '../sync/remote.js';
import { RemoteRepository, type Binding, type Publication } from './remote-repository';
import type { Descriptor } from './model';
import { TransportError, type SyncTransport, type PublicationConfirmation } from './sync-transport';

export interface RunOptions { signal?: AbortSignal; maxPages?: number; maxPublications?: number }
const cancelled = () => new TransportError('retryable', 'Synchronization interrupted');
const checkCancellation = (signal?: AbortSignal) => { if (signal?.aborted) throw cancelled(); };
const diagnosed = (error: unknown): error is TransportError | RemoteError | ProtocolError =>
  error instanceof TransportError || error instanceof RemoteError || error instanceof ProtocolError;
const classified = (error: unknown) => diagnosed(error) && error.classification;

/**
 * Awaited adaptation of simulation/runner.js; RemoteRepository owns all durable
 * state transitions and status. Network calls never execute inside IDB transactions.
 * One instance coalesces simultaneous calls; native fences/reservations still protect
 * independent instances/workers. No unload handler or background lifetime is required.
 */
export class SyncRunner {
  private running?: Promise<string>;
  constructor(private repository: RemoteRepository, private transport: SyncTransport) {}

  run(options: RunOptions = {}): Promise<string> {
    if (this.running) return this.running;
    const running = this.execute(options).finally(() => { this.running = undefined; });
    this.running = running;
    return running;
  }

  private async step<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
    const result = await operation;
    checkCancellation(signal);
    return result;
  }

  private async network<T>(pin: Binding, signal: AbortSignal | undefined,
    work: (target: Binding) => Promise<T>): Promise<T> {
    await this.step(this.repository.assertPin(pin), signal);
    let response: T;
    try { response = await work(structuredClone(pin)); }
    catch (error) {
      if (signal?.aborted) throw cancelled();
      if (error instanceof TransportError) throw error;
      // Arbitrary provider exceptions must not leak credentials or diagnose data damage.
      throw new TransportError('retryable', 'Transport request failed');
    }
    checkCancellation(signal);
    await this.step(this.repository.assertPin(pin), signal);
    return response;
  }

  private async rejectedArtifact(pin: Binding, reference: string, error: unknown, bytes?: Uint8Array): Promise<never> {
    if (error instanceof TransportError && error.byteLength !== undefined && error.byteLength > MAX_SEGMENT_BYTES
      && await this.repository.hasOriginalBytes(pin, reference)) {
      error = new TransportError('integrity', 'Known physical artifact changed to oversized content');
    }
    if (classified(error)) await this.repository.artifactFailure(pin, reference, error as TransportError, bytes);
    throw error;
  }

  private async receive(pin: Binding, reference: string, signal?: AbortSignal) {
    let response: { bytes: Uint8Array; complete: boolean };
    try {
      response = await this.network(pin, signal, target => this.transport.read(target, reference, { maxBytes: MAX_SEGMENT_BYTES, signal }));
    } catch (error) { return this.rejectedArtifact(pin, reference, error); }
    if (response?.complete !== true) throw new TransportError('retryable', 'Incomplete artifact read');
    if (!(response.bytes instanceof Uint8Array)) return this.rejectedArtifact(pin, reference, new TransportError('malformed', 'Expected artifact bytes'));
    if (response.bytes.length > MAX_SEGMENT_BYTES) return this.rejectedArtifact(pin, reference,
      new TransportError('malformed', 'Artifact exceeds byte bound', { byteLength: response.bytes.length }), response.bytes);
    try { await this.step(this.repository.receive(pin, reference, response.bytes), signal); }
    catch (error) {
      // A native storage failure propagates; it is never evidence of remote corruption.
      return this.rejectedArtifact(pin, reference, error, response.bytes);
    }
  }

  private async publish(pin: Binding, publication: Publication, signal?: AbortSignal) {
    const repository = this.repository;
    if (publication.state === 'reserved') publication = await this.step(repository.seal(pin, publication.segmentId), signal);
    if (publication.state === 'acknowledged') return;
    if (publication.state === 'confirmed') {
      await this.step(repository.acknowledge(pin, publication.segmentId), signal);
      return;
    }
    if (publication.retryHandle === undefined) {
      const handle = await this.network(pin, signal, target => this.transport.preparePublication(target, { segmentId: publication.segmentId }, { signal }));
      publication = await this.step(repository.retainRetryHandle(pin, publication.segmentId, handle), signal);
      // Another worker can have confirmed/acknowledged while preparation was pending.
      if (publication.state === 'acknowledged') return;
      if (publication.state === 'confirmed') {
        await this.step(repository.acknowledge(pin, publication.segmentId), signal); return;
      }
    }
    const attempt = await this.step(repository.beginAttempt(pin, publication.segmentId), signal);
    let confirmation: PublicationConfirmation;
    try {
      confirmation = await this.network(pin, signal, target => this.transport.publish(target,
        { segmentId: attempt.segmentId, bytes: attempt.bytes!, retryHandle: attempt.retryHandle! }, { signal }));
    } catch (error) {
      // Once an attempt is durable, interruption cannot establish that bytes were not accepted.
      // Leave native storage failures untouched, including an ambiguous committed transition.
      if (diagnosed(error) && !(error instanceof RemoteError)) await repository.unknown(pin, publication.segmentId);
      throw error;
    }
    await this.step(repository.confirm(pin, publication.segmentId, confirmation), signal);
    await this.step(repository.acknowledge(pin, publication.segmentId), signal);
  }

  private async execute({ signal, maxPages = Infinity, maxPublications = Infinity }: RunOptions): Promise<string> {
    for (const limit of [maxPages, maxPublications]) if (limit !== Infinity && (!Number.isSafeInteger(limit) || limit < 0)) throw new RangeError('Invalid sync work limit');
    const repository = this.repository;
    const pin = await repository.captureBinding();
    if (!pin) return repository.status();
    try {
      checkCancellation(signal);
      await this.step(repository.assertPin(pin), signal);
      let pass = await this.step(repository.beginPass(pin), signal);
      const descriptor = await this.network(pin, signal, target => this.transport.readDescriptor(target, { maxBytes: MAX_SEGMENT_BYTES, signal }));
      if (!(descriptor instanceof Uint8Array) || descriptor.length > MAX_SEGMENT_BYTES) throw new TransportError('malformed', 'Expected bounded descriptor bytes');
      await this.step(repository.verifyDescriptor(pin, parseDescriptor(descriptor) as Descriptor), signal);
      // Durable downloads cannot be starved by a subsequent listing failure.
      for (const reference of await this.step(repository.pendingReferences(pin), signal)) await this.receive(pin, reference, signal);
      const resumed = (await this.step(repository.publications(pin), signal)).slice(0, maxPublications);
      // Resume committed publication obligations before asking for more discoveries.
      // Capture a cutoff before any upload; upload-time commands wait for a later run.
      let eligible = resumed.length ? await this.step(repository.pendingOperationIds(pin), signal) : undefined;
      for (const publication of resumed) await this.publish(pin, publication, signal);
      let pages = 0;
      let restarted = false;
      while (!pass.enumerationComplete && pages < maxPages) {
        let page;
        try { page = await this.network(pin, signal, target => this.transport.enumerate(target, pass.checkpoint, { signal })); }
        catch (error) {
          if (!(error instanceof TransportError) || error.code !== 'invalid-cursor' || restarted) throw error;
          await this.step(repository.restartEnumeration(pin), signal);
          pass = { ...pass, checkpoint: null, enumerationComplete: false };
          restarted = true; continue;
        }
        pass = await this.step(repository.recordPage(pin, pass.passId, page), signal);
        pages++;
        for (const reference of await this.step(repository.pendingReferences(pin), signal)) await this.receive(pin, reference, signal);
      }
      if (pass.enumerationComplete) {
        for (const reference of await this.step(repository.pendingReferences(pin), signal)) await this.receive(pin, reference, signal);
        for (const reference of await this.step(repository.omittedReferences(pin), signal)) await this.receive(pin, reference, signal);
        const publications: Publication[] = [];
        eligible ??= await this.step(repository.pendingOperationIds(pin), signal);
        // Capture eligible work before uploads, so authoring during an upload stays pending.
        while (resumed.length + publications.length < maxPublications) {
          const reservation = await this.step(repository.reserve(pin, { operationIds: eligible }), signal);
          if (!reservation) break;
          publications.push(reservation);
        }
        for (const publication of publications) await this.publish(pin, publication, signal);
      }
      await this.step(repository.completePass(pin), signal);
    } catch (error) {
      // Storage/transaction errors propagate without a remote diagnosis or a false success.
      if (!diagnosed(error)) throw error;
      if (!(error instanceof RemoteError && ['stale-binding', 'binding-blocked', 'stale-pass'].includes(error.code))) {
        try { await repository.runFailure(pin, error); }
        catch (failure) { if (!(failure instanceof RemoteError && failure.code === 'stale-binding')) throw failure; }
      }
    }
    return repository.status();
  }
}
