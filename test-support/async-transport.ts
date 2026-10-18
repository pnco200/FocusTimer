import { encodeUtf8, parseSegment } from '../src/protocol/index.js';
import type { Descriptor } from '../src/web/model';
import type { Binding } from '../src/web/remote-repository';
import { TransportError, type SyncTransport, type RequestOptions, type ReadOptions,
  type PublicationRequest, type PublicationConfirmation, type EnumerationPage } from '../src/web/sync-transport';

type Method = 'readDescriptor' | 'enumerate' | 'read' | 'preparePublication' | 'publish' | 'publishAccepted';
type Code = ConstructorParameters<typeof TransportError>[0];
type Event = { type: 'error'; code: Code } | { type: 'partial'; count: number }
  | { type: 'reject-cursor' } | { type: 'truncated'; length?: number }
  | { type: 'response-lost' } | { type: 'hold'; entered: () => void; released: Promise<void> };
type Target = Pick<Binding, 'account' | 'locator'>;
interface StoredObject { bytes: Uint8Array; segmentId?: string; visibleAt: number; readableAt: number; available: boolean }
interface Dataset { descriptor: Uint8Array; objects: Map<string, StoredObject>; available: boolean }
const key = (target: Target) => JSON.stringify([target.account, target.locator]);
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, i) => value === b[i]);

/** Test-only async storage with deliberately weaker listing and delivery guarantees. */
export class AsyncAdversarialTransport implements SyncTransport {
  private datasets = new Map<string, Dataset>();
  private scripts = new Map<Method, Event[]>();
  private cursors = new Map<string, { target: string; references: string[]; index: number }>();
  private nextReference = 1;
  private nextCursor = 1;
  private nextHandle = 1;
  private handles = new Map<string, { target: string; segmentId: string }>();
  now = 0;
  calls: Array<{ method: Method; target: Binding; [detail: string]: unknown }> = [];
  pageSize: number;
  order: 'forward' | 'reverse';
  duplicateDelivery: number;
  duplicatePublications: boolean;
  publicationDelay: number;
  uniquePreparationHandles: boolean;

  constructor({ pageSize = 100, order = 'forward', duplicateDelivery = 1, duplicatePublications = false,
    publicationDelay = 0, uniquePreparationHandles = false }: { pageSize?: number; order?: 'forward' | 'reverse'; duplicateDelivery?: number;
      duplicatePublications?: boolean; publicationDelay?: number; uniquePreparationHandles?: boolean } = {}) {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new Error('Invalid test page size');
    this.pageSize = pageSize; this.order = order; this.duplicateDelivery = duplicateDelivery;
    this.duplicatePublications = duplicatePublications; this.publicationDelay = publicationDelay;
    this.uniquePreparationHandles = uniquePreparationHandles;
  }

  createDataset(target: Target, descriptor: Descriptor | Uint8Array) {
    if (this.datasets.has(key(target))) throw new Error('Dataset already exists');
    this.datasets.set(key(target), { descriptor: descriptor instanceof Uint8Array ? descriptor.slice()
      : encodeUtf8(JSON.stringify(descriptor)), objects: new Map(), available: true });
  }
  private dataset(target: Target) {
    const dataset = this.datasets.get(key(target));
    if (!dataset?.available) throw new TransportError('missing-dataset');
    return dataset;
  }
  advance(amount = 1) { this.now += amount; }
  setDatasetAvailable(target: Target, available: boolean) {
    const dataset = this.datasets.get(key(target));
    if (!dataset) throw new Error('Unknown test dataset');
    dataset.available = available;
  }
  replaceDescriptor(target: Target, bytes: Uint8Array) { this.dataset(target).descriptor = bytes.slice(); }
  put(target: Target, bytes: Uint8Array, { reference = `object-${this.nextReference++}`, visibleAt = this.now,
    readableAt = this.now } = {}) {
    const dataset = this.dataset(target);
    if (dataset.objects.has(reference)) throw new Error('Reference already exists');
    let segmentId: string | undefined;
    try { segmentId = parseSegment(bytes).segmentId; } catch { /* Malformed artifacts are intentional test inputs. */ }
    dataset.objects.set(reference, { bytes: bytes.slice(), segmentId, visibleAt, readableAt, available: true });
    return reference;
  }
  private object(target: Target, reference: string) {
    const object = this.dataset(target).objects.get(reference);
    if (!object) throw new TransportError('missing-object');
    return object;
  }
  replace(target: Target, reference: string, bytes: Uint8Array) { this.object(target, reference).bytes = bytes.slice(); }
  setObjectAvailable(target: Target, reference: string, available: boolean) { this.object(target, reference).available = available; }
  setVisibleAt(target: Target, reference: string, visibleAt: number) { this.object(target, reference).visibleAt = visibleAt; }
  references(target: Target) { return [...this.dataset(target).objects.keys()]; }
  bytes(target: Target, reference: string) { return this.object(target, reference).bytes.slice(); }
  queue(method: Method, event: Event) {
    const queue = this.scripts.get(method) ?? []; queue.push(event); this.scripts.set(method, queue);
  }
  holdNext(method: Method) {
    let entered!: () => void; let release!: () => void;
    const arrived = new Promise<void>(resolve => { entered = resolve; });
    const released = new Promise<void>(resolve => { release = resolve; });
    this.queue(method, { type: 'hold', entered, released });
    return { entered: arrived, release };
  }
  private aborted(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('Operation cancelled', 'AbortError'); }
  private async before(method: Method, target: Binding, options: RequestOptions, detail: Record<string, unknown> = {}) {
    this.aborted(options.signal);
    this.calls.push({ method, target: structuredClone(target), ...structuredClone(detail) });
    await Promise.resolve(); // Every provider boundary yields, even without an injected event.
    this.aborted(options.signal);
    const event = this.scripts.get(method)?.shift();
    if (event?.type === 'hold') {
      event.entered();
      const signal = options.signal;
      if (signal) {
        let abort!: () => void;
        try {
          await Promise.race([event.released, new Promise<never>((_resolve, reject) => {
            abort = () => reject(new DOMException('Operation cancelled', 'AbortError'));
            signal.addEventListener('abort', abort, { once: true });
          })]);
        } finally { signal.removeEventListener('abort', abort); }
      } else await event.released;
      this.aborted(signal);
      return;
    }
    if (event?.type === 'error') throw new TransportError(event.code);
    return event;
  }
  private bounded(bytes: Uint8Array, options: ReadOptions) {
    if (bytes.length > options.maxBytes) throw new TransportError('malformed', 'Object exceeds requested byte bound', { byteLength: bytes.length });
    return bytes.slice();
  }

  async readDescriptor(target: Binding, options: ReadOptions) {
    await this.before('readDescriptor', target, options, { maxBytes: options.maxBytes });
    return this.bounded(this.dataset(target).descriptor, options);
  }
  async enumerate(target: Binding, continuation: unknown, options: RequestOptions): Promise<EnumerationPage> {
    const event = await this.before('enumerate', target, options, { continuation });
    const dataset = this.dataset(target);
    let scan: { target: string; references: string[]; index: number };
    if (continuation == null) {
      let references = [...dataset.objects.entries()].filter(([, value]) => value.available && value.visibleAt <= this.now)
        .map(([reference]) => reference);
      if (this.order === 'reverse') references.reverse();
      references = references.flatMap(reference => Array<string>(this.duplicateDelivery).fill(reference));
      scan = { target: key(target), references, index: 0 };
    } else {
      const existing = this.cursors.get(String(continuation));
      if (!existing || existing.target !== key(target)) throw new TransportError('invalid-cursor');
      this.cursors.delete(String(continuation)); scan = existing;
    }
    if (event?.type === 'reject-cursor') throw new TransportError('invalid-cursor');
    const count = event?.type === 'partial' ? event.count : this.pageSize;
    const references = scan.references.slice(scan.index, scan.index + count); scan.index += references.length;
    const complete = event?.type !== 'partial' && scan.index >= scan.references.length;
    if (complete) return { references, continuation: null, complete: true };
    const next = `cursor-${this.nextCursor++}`; this.cursors.set(next, scan);
    return { references, continuation: next, complete: false };
  }
  async read(target: Binding, reference: string, options: ReadOptions) {
    const event = await this.before('read', target, options, { reference, maxBytes: options.maxBytes });
    const object = this.object(target, reference);
    if (!object.available) throw new TransportError('missing-object');
    if (object.readableAt > this.now) throw new TransportError('retryable');
    const bytes = this.bounded(object.bytes, options);
    if (event?.type === 'truncated') return { bytes: bytes.slice(0, event.length ?? Math.max(0, bytes.length - 1)), complete: false };
    return { bytes, complete: true };
  }
  async preparePublication(target: Binding, publication: { segmentId: string }, options: RequestOptions) {
    await this.before('preparePublication', target, options, { segmentId: publication.segmentId });
    this.dataset(target);
    const handle = `creation:${publication.segmentId}${this.uniquePreparationHandles ? `:${this.nextHandle++}` : ''}`;
    this.handles.set(handle, { target: key(target), segmentId: publication.segmentId });
    return handle;
  }
  async publish(target: Binding, publication: PublicationRequest, options: RequestOptions): Promise<PublicationConfirmation> {
    const event = await this.before('publish', target, options, { ...publication });
    const dataset = this.dataset(target); const segment = parseSegment(publication.bytes);
    const identity = this.handles.get(publication.retryHandle);
    if (segment.segmentId !== publication.segmentId || segment.datasetId !== target.datasetId
      || identity?.target !== key(target) || identity.segmentId !== publication.segmentId) throw new TransportError('integrity');
    const matches = [...dataset.objects.entries()].filter(([, value]) => value.segmentId === publication.segmentId);
    if (matches.some(([, value]) => !sameBytes(value.bytes, publication.bytes))) throw new TransportError('integrity');
    const references = matches.map(([reference]) => reference);
    if (!matches.length || this.duplicatePublications) references.push(this.put(target, publication.bytes,
      { visibleAt: this.now + this.publicationDelay }));
    await this.before('publishAccepted', target, options, { ...publication });
    if (event?.type === 'response-lost') throw new TransportError('unknown', 'Accepted publication response lost');
    // Affirm only presently readable exact storage content, including after an
    // acceptance barrier. Echoing the upload request would not be verification.
    for (const reference of references) {
      const object = this.object(target, reference);
      if (!object.available) throw new TransportError('missing-object');
      if (object.readableAt > this.now) throw new TransportError('retryable');
      if (!sameBytes(object.bytes, publication.bytes)) throw new TransportError('integrity');
    }
    return { outcome: matches.length ? 'already-present' : 'confirmed', segmentId: publication.segmentId,
      bytes: this.bytes(target, references[0]), references };
  }
}
