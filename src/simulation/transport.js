import { MAX_SEGMENT_BYTES, encodeUtf8, parseSegment } from '../protocol/index.js';
import { sameBytes } from './repository.js';

const clone = value => structuredClone(value);
const targetKey = target => JSON.stringify([target.account, target.locator]);

export class TransportError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'TransportError';
    this.code = code;
    this.classification = ['malformed', 'unsupported', 'integrity'].includes(code) ? code : undefined;
  }
}

/** Deterministic byte storage. Its opaque cursors are deliberately local adapter state. */
export class AdversarialTransport {
  #datasets = new Map();
  #scripts = new Map();
  #cursors = new Map();
  #nextReference = 1;
  #nextCursor = 1;
  now = 0;
  calls = [];

  constructor({ pageSize = 100, order = 'forward', duplicateDelivery = 1, duplicatePublications = false } = {}) {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new TransportError('invalid-page-size');
    this.pageSize = pageSize;
    this.order = order;
    this.duplicateDelivery = duplicateDelivery;
    this.duplicatePublications = duplicatePublications;
  }

  createDataset(target, descriptor) {
    const key = targetKey(target);
    if (this.#datasets.has(key)) throw new TransportError('already-exists');
    const bytes = descriptor instanceof Uint8Array ? descriptor : encodeUtf8(JSON.stringify(descriptor));
    this.#datasets.set(key, { descriptor: Uint8Array.from(bytes), objects: new Map(), available: true });
  }

  advance(amount = 1) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new TransportError('invalid-time');
    this.now += amount;
  }

  #dataset(target) {
    const dataset = this.#datasets.get(targetKey(target));
    if (!dataset || !dataset.available) throw new TransportError('missing-dataset');
    return dataset;
  }

  setDatasetAvailable(target, available) {
    const dataset = this.#datasets.get(targetKey(target));
    if (!dataset) throw new TransportError('missing-dataset');
    dataset.available = available;
  }
  replaceDescriptor(target, bytes) { this.#dataset(target).descriptor = Uint8Array.from(bytes); }

  put(target, bytes, { reference = `artifact-${this.#nextReference++}`, visibleAt = this.now, readableAt = this.now } = {}) {
    const dataset = this.#dataset(target);
    if (dataset.objects.has(reference)) throw new TransportError('already-exists');
    let segmentId;
    try { segmentId = parseSegment(bytes).segmentId; } catch { /* Invalid artifacts are intentional test inputs. */ }
    dataset.objects.set(reference, { bytes: Uint8Array.from(bytes), segmentId, visibleAt, readableAt, available: true });
    return reference;
  }

  replace(target, reference, bytes) {
    const object = this.#dataset(target).objects.get(reference);
    if (!object) throw new TransportError('missing-object');
    object.bytes = Uint8Array.from(bytes);
  }

  setObjectAvailable(target, reference, available) {
    const object = this.#dataset(target).objects.get(reference);
    if (!object) throw new TransportError('missing-object');
    object.available = available;
  }

  setVisibleAt(target, reference, visibleAt) {
    const object = this.#dataset(target).objects.get(reference);
    if (!object) throw new TransportError('missing-object');
    object.visibleAt = visibleAt;
  }

  references(target) { return [...this.#dataset(target).objects.keys()]; }
  bytes(target, reference) {
    const object = this.#dataset(target).objects.get(reference);
    if (!object) throw new TransportError('missing-object');
    return Uint8Array.from(object.bytes);
  }

  queue(method, event) {
    const events = this.#scripts.get(method) ?? [];
    events.push(event);
    this.#scripts.set(method, events);
  }

  /** Hold a precise network boundary to deterministically interleave another worker/command. */
  holdNext(method) {
    let signalEntered;
    let release;
    const entered = new Promise(resolve => { signalEntered = resolve; });
    const released = new Promise(resolve => { release = resolve; });
    this.queue(method, { type: 'hold', entered: signalEntered, released });
    return { entered, release };
  }

  async #before(method, target, detail = {}) {
    this.calls.push({ method, target: clone(target), ...clone(detail) });
    const event = (this.#scripts.get(method) ?? []).shift();
    if (event?.type === 'hold') {
      event.entered();
      await event.released;
      return undefined;
    }
    if (event?.type === 'error') throw new TransportError(event.code ?? 'retryable');
    return event;
  }

  async readDescriptor(target) {
    await this.#before('readDescriptor', target);
    const bytes = this.#dataset(target).descriptor;
    if (bytes.length > MAX_SEGMENT_BYTES) throw new TransportError('malformed', 'Descriptor exceeds the v1 byte bound');
    return Uint8Array.from(bytes);
  }

  async enumerate(target, continuation = null) {
    const event = await this.#before('enumerate', target, { continuation });
    const dataset = this.#dataset(target);
    let scan;
    if (continuation === null) {
      let references = [...dataset.objects.entries()]
        .filter(([, object]) => object.available && object.visibleAt <= this.now).map(([reference]) => reference);
      if (this.order === 'reverse') references.reverse();
      references = references.flatMap(reference => Array(this.duplicateDelivery).fill(reference));
      scan = { target: targetKey(target), references, index: 0 };
    } else {
      scan = this.#cursors.get(continuation);
      if (!scan || scan.target !== targetKey(target)) throw new TransportError('invalid-cursor');
      this.#cursors.delete(continuation);
    }
    if (event?.type === 'reject-cursor') throw new TransportError('invalid-cursor');
    const count = event?.type === 'partial' ? event.count : this.pageSize;
    const references = scan.references.slice(scan.index, scan.index + count);
    scan.index += references.length;
    const complete = event?.type !== 'partial' && scan.index >= scan.references.length;
    if (complete) return { references, continuation: null, complete: true };
    const next = `opaque-page-${this.#nextCursor++}`;
    this.#cursors.set(next, scan);
    return { references, continuation: next, complete: false };
  }

  async read(target, reference) {
    const event = await this.#before('read', target, { reference });
    const object = this.#dataset(target).objects.get(reference);
    if (!object || !object.available) throw new TransportError('missing-object');
    if (object.readableAt > this.now) throw new TransportError('retryable');
    if (object.bytes.length > MAX_SEGMENT_BYTES) {
      const error = new TransportError('malformed', 'Artifact exceeds the v1 byte bound');
      error.byteLength = object.bytes.length;
      throw error;
    }
    const bytes = Uint8Array.from(object.bytes);
    if (event?.type === 'truncated') return { bytes: bytes.slice(0, event.length ?? Math.max(0, bytes.length - 1)), complete: false };
    return { bytes, complete: true };
  }

  async publish(target, publication) {
    const event = await this.#before('publish', target, { segmentId: publication.segmentId, bytes: publication.bytes });
    const dataset = this.#dataset(target);
    const segment = parseSegment(publication.bytes);
    if (segment.segmentId !== publication.segmentId || segment.datasetId !== target.datasetId) throw new TransportError('integrity');
    const matches = [...dataset.objects.entries()].filter(([, object]) => object.segmentId === publication.segmentId);
    if (matches.some(([, object]) => !sameBytes(object.bytes, publication.bytes))) throw new TransportError('integrity');
    const references = matches.map(([reference]) => reference);
    if (!matches.length || this.duplicatePublications) references.push(this.put(target, publication.bytes));
    if (event?.type === 'response-lost') throw new TransportError('unknown', 'Publication succeeded; its response was lost');
    return { outcome: matches.length ? 'already-present' : 'confirmed', segmentId: publication.segmentId,
      bytes: Uint8Array.from(publication.bytes), references };
  }
}
