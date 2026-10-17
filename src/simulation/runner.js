import { parseDescriptor } from '../protocol/index.js';
import { InjectedFailure, SimulationError } from './repository.js';
import { TransportError } from './transport.js';

/** Generic reconciliation/publication orchestration; no provider or browser dependencies. */
export class SyncRunner {
  constructor(repository, transport) {
    this.repository = repository;
    this.transport = transport;
  }

  async #receive(pin, reference) {
    this.repository.assertPin(pin);
    let response;
    try {
      response = await this.transport.read(pin, reference);
      this.repository.assertPin(pin);
      if (!response.complete) throw new TransportError('retryable', 'Incomplete artifact read');
      this.repository.receive(pin, reference, response.bytes);
    } catch (error) {
      if (error instanceof InjectedFailure || error.code === 'stale-binding') throw error;
      const artifacts = this.repository.snapshot().discoveries[pin.generation]?.artifacts;
      if (error.byteLength && artifacts && Object.hasOwn(artifacts, reference) && artifacts[reference].originalBytes) {
        error = new SimulationError('integrity', 'Known physical artifact changed to oversized bytes');
      }
      if (error.classification) this.repository.artifactFailure(pin, reference, error, response?.bytes);
      throw error;
    }
  }

  async #publish(pin, publication) {
    const repository = this.repository;
    if (publication.state === 'reserved') publication = repository.seal(pin, publication.segmentId);
    if (publication.state === 'confirmed') {
      repository.acknowledge(pin, publication.segmentId);
      return;
    }
    const attempt = repository.beginAttempt(pin, publication.segmentId);
    try {
      repository.assertPin(pin);
      const confirmation = await this.transport.publish(pin, attempt);
      repository.confirm(pin, publication.segmentId, confirmation);
      repository.acknowledge(pin, publication.segmentId);
    } catch (error) {
      if (error instanceof InjectedFailure || error.code === 'stale-binding') throw error;
      if (!error.classification) repository.unknown(pin, publication.segmentId);
      throw error;
    }
  }

  async run({ maxPages = Infinity, maxPublications = Infinity } = {}) {
    const repository = this.repository;
    const pin = repository.captureBinding();
    if (!pin) return repository.status();
    try {
      repository.assertPin(pin);
      let pass = repository.beginPass(pin);
      const descriptorBytes = await this.transport.readDescriptor(pin);
      repository.verifyDescriptor(pin, parseDescriptor(descriptorBytes));
      let pages = 0;
      let restarted = false;
      while (!pass.enumerationComplete && pages < maxPages) {
        repository.assertPin(pin);
        let page;
        try {
          page = await this.transport.enumerate(pin, pass.checkpoint);
        } catch (error) {
          if (error.code !== 'invalid-cursor' || restarted) throw error;
          repository.restartEnumeration(pin);
          pass = repository.snapshot().discoveries[pin.generation];
          restarted = true;
          continue;
        }
        pass = repository.recordPage(pin, pass.passId, page);
        pages += 1;
        for (const reference of repository.pendingReferences(pin)) await this.#receive(pin, reference);
      }
      if (!pass.enumerationComplete) return repository.status();
      for (const reference of repository.pendingReferences(pin)) await this.#receive(pin, reference);
      // A full list omitting a known reference must not bypass integrity/availability checks.
      for (const reference of repository.omittedReferences(pin)) await this.#receive(pin, reference);
      let published = 0;
      for (const publication of repository.publications(pin)) {
        if (published >= maxPublications) break;
        await this.#publish(pin, publication);
        published += 1;
      }
      while (published < maxPublications) {
        const reservation = repository.reserve(pin);
        if (!reservation) break;
        await this.#publish(pin, reservation);
        published += 1;
      }
      repository.completePass(pin);
    } catch (error) {
      if (error instanceof InjectedFailure) throw error; // Simulated crash: do no subsequent persistence.
      if (error.code !== 'stale-binding' && error.code !== 'binding-blocked') {
        try { repository.runFailure(pin, error); } catch (failure) {
          if (failure.code !== 'stale-binding') throw failure;
        }
      }
    }
    return repository.status();
  }
}
