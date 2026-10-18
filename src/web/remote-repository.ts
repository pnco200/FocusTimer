import { MAX_COUNTER, MAX_OPERATIONS, MAX_SEGMENT_BYTES, nextCounter, operationEqual, parseSegment,
  validateDescriptor, validateOperation, validateUuid, decodeUtf8 } from '../protocol/index.js';
import { materializeOperations } from '../sync/local.js';
import { RemoteError, sameBytes, samePin, sameDestination, makeReservation, sealedBytes,
  validateConfirmation, validateBindingTarget, coveragePending, remoteStatus } from '../sync/remote.js';
import { request, transaction, type Fault } from './idb';
import type { Active, Collection, Descriptor, Installation, Operation } from './model';

export interface Binding {
  provider?: string; account: string; locator: string; datasetId: string; generation: number;
}
export interface Publication {
  datasetId: string; segmentId: string; writerId: string; binding: Binding;
  operations: Operation[]; operationIds: string[]; bytes: Uint8Array | null;
  state: 'reserved' | 'sealed' | 'in-flight' | 'unknown' | 'confirmed' | 'acknowledged';
  attempts: number; remoteReferences?: string[];
  retryHandle?: string;
}
interface Segment { datasetId: string; segmentId: string; bytes: Uint8Array; operationIds: string[] }
interface Artifact {
  datasetId: string; reference: string; originalBytes: Uint8Array | null; segmentId: string | null;
  state: 'pending' | 'applied' | 'quarantined'; error: string | null; verifiedPass?: number;
  seenPass?: number; rejectedBytes?: Uint8Array; rejectedByteLength?: number;
}
interface Pass {
  binding: Binding | null; passId: number; checkpoint: unknown; enumerationComplete: boolean;
  reconciled: boolean; inProgress: boolean; error: string | null; lastSuccess: number | null;
}
interface Remote {
  datasetId: string; binding: Binding | null; lastBinding: Binding | null;
  bindingGeneration: number; blocked: { classification: string; reason: string; reference?: string } | null;
  pass: Pass;
}
interface Pending { datasetId: string; opId: string; reservation: string | null }
interface Failure { code?: string; classification?: string; message?: string }
interface Context { installation: Installation; collection: Collection; remote: Remote }
const fresh = (datasetId: string): Remote => ({ datasetId, binding: null, lastBinding: null,
  bindingGeneration: 0, blocked: null, pass: { binding: null, passId: 0, checkpoint: null,
    enumerationComplete: false, reconciled: false, inProgress: false, error: null, lastSuccess: null } });
const keyed = <T>(values: T[], key: (value: T) => string) => Object.fromEntries(values.map(value => [key(value), value]));

/** Async persistence boundary only. No transport assertions, credentials, scheduler, or network calls. */
export class RemoteRepository {
  constructor(private db: IDBDatabase, private ids: () => string, private fault: () => Fault | undefined) {}

  private get<T>(tx: IDBTransaction, store: string, key: IDBValidKey): Promise<T | undefined> {
    return request(tx.objectStore(store).get(key));
  }
  private all<T>(tx: IDBTransaction, store: string, datasetId: string): Promise<T[]> {
    return request(tx.objectStore(store).index('dataset').getAll(datasetId));
  }
  private put(tx: IDBTransaction, store: string, value: unknown) { return request(tx.objectStore(store).put(value)); }
  private step(tx: IDBTransaction, point: string) { this.fault()?.(point, tx); }
  private async context(tx: IDBTransaction): Promise<Context> {
    const installation = await this.get<Installation>(tx, 'meta', 'installation');
    if (!installation) throw new RemoteError('recovery', 'Initialize local storage first');
    const collection = await this.get<Collection>(tx, 'collections', installation.selectedDatasetId);
    if (!collection) throw new RemoteError('recovery', 'Missing collection');
    return { installation, collection,
      remote: await this.get<Remote>(tx, 'remote', installation.selectedDatasetId) ?? fresh(installation.selectedDatasetId) };
  }
  private check(remote: Remote, pin: Binding, allowBlocked = false) {
    if (!samePin(remote.binding, pin)
      || (remote.binding?.provider ?? 'abstract') !== (pin?.provider ?? 'abstract')) throw new RemoteError('stale-binding');
    if (!allowBlocked && remote.blocked) throw new RemoteError('binding-blocked', remote.blocked.reason);
  }
  private read<T>(work: (tx: IDBTransaction, ctx: Context) => Promise<T>) {
    return transaction(this.db, 'readonly', async tx => work(tx, await this.context(tx)));
  }
  private write<T>(kind: string, pin: Binding | null, work: (tx: IDBTransaction, ctx: Context) => Promise<T>, allowBlocked = false) {
    pin = structuredClone(pin);
    return transaction(this.db, 'readwrite', async tx => {
      const ctx = await this.context(tx);
      if (pin) this.check(ctx.remote, pin, allowBlocked);
      const result = await work(tx, ctx);
      await this.put(tx, 'remote', ctx.remote);
      this.step(tx, `${kind}.end`);
      return result;
    }, (point, tx) => this.fault()?.(point, tx));
  }
  private async publication(tx: IDBTransaction, pin: Binding, segmentId: string) {
    const publication = await this.get<Publication>(tx, 'publications', [pin.datasetId, segmentId]);
    if (!publication || !samePin(publication.binding, pin)) throw new RemoteError('stale-publication');
    return publication;
  }

  captureBinding() { return this.read(async (_tx, ctx) => ctx.remote.binding); }
  assertPin(pin: Binding) { pin = structuredClone(pin); return this.read(async (_tx, ctx) => this.check(ctx.remote, pin)); }
  async bind(input: { provider?: string; account: string; locator: string; descriptor: Descriptor;
    expectedGeneration?: number; resumePublications?: boolean }): Promise<Binding> {
    const { provider = 'abstract', account, locator, expectedGeneration, resumePublications = false } = structuredClone(input);
    const descriptor = validateDescriptor(input.descriptor) as Descriptor;
    if (![provider, account, locator].every(value => typeof value === 'string' && value.length > 0)) throw new RemoteError('invalid-binding');
    return this.write('bind', null, async (tx, { remote, collection }) => {
      const active = await this.get<Active>(tx, 'active', 'current');
      const publications = await this.all<Publication>(tx, 'publications', remote.datasetId);
      const pending = publications.filter(value => value.state !== 'acknowledged');
      const target = { provider, account, locator, datasetId: descriptor.datasetId };
      const destinationMatches = (value: Binding) => sameDestination(value, target)
        && (value.provider ?? 'abstract') === provider;
      const established = remote.binding ?? remote.lastBinding;
      const retained = publications.length || await request(tx.objectStore('operations').index('dataset').count(remote.datasetId))
        || await request(tx.objectStore('segments').index('dataset').count(remote.datasetId))
        || await request(tx.objectStore('artifacts').index('dataset').count(remote.datasetId));
      validateBindingTarget({ generation: remote.bindingGeneration, active: active?.state !== 'idle',
        datasetId: collection.descriptor.datasetId, pendingPublications: pending, established, retainedCorpus: !!retained },
      { provider, account, locator, descriptor, expectedGeneration: expectedGeneration ?? remote.bindingGeneration, resumePublications });
      remote.bindingGeneration = nextCounter(remote.bindingGeneration);
      remote.binding = { ...target, generation: remote.bindingGeneration };
      remote.lastBinding = structuredClone(remote.binding);
      remote.blocked = null;
      remote.pass = { ...remote.pass, binding: structuredClone(remote.binding), checkpoint: null,
        enumerationComplete: !!established && destinationMatches(established), reconciled: false, inProgress: false, error: null };
      for (const publication of pending) {
        publication.binding = structuredClone(remote.binding);
        if (publication.state === 'in-flight') publication.state = 'unknown';
        await this.put(tx, 'publications', publication);
      }
      this.step(tx, 'bind.binding');
      return remote.binding;
    });
  }
  /** Startup audit inside the caller's native adoption transaction; never invents remote success. */
  async audit(tx: IDBTransaction, datasetId: string, operations: Operation[], pending: Pending[]) {
    const remote = await this.get<Remote>(tx, 'remote', datasetId);
    const journal = new Map(operations.map(value => [value.opId, value]));
    const publications = await this.all<Publication>(tx, 'publications', datasetId);
    const segments = await this.all<Segment>(tx, 'segments', datasetId);
    const artifacts = await this.all<Artifact>(tx, 'artifacts', datasetId);
    const fail = (message: string): never => { throw new RemoteError('recovery', message); };
    if (!remote) {
      if (publications.length || segments.length || artifacts.length || pending.length !== operations.length
        || pending.some(value => !journal.has(value.opId) || value.reservation !== null)) fail('Local pending membership is missing or has unsupported publication state.');
      return;
    }
    if (!Number.isSafeInteger(remote.bindingGeneration) || remote.bindingGeneration < 0
      || (remote.binding && (remote.binding.generation !== remote.bindingGeneration || remote.binding.datasetId !== datasetId))) fail('Invalid binding fence');
    const integer = (value: unknown, min: number, max = MAX_COUNTER) => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
    const bindingValid = (value: Binding) => value && value.datasetId === datasetId && integer(value.generation, 1, remote.bindingGeneration)
      && [value.provider, value.account, value.locator].every(part => typeof part === 'string' && part.length > 0);
    if (remote.datasetId !== datasetId || (remote.binding && !bindingValid(remote.binding))
      || (remote.lastBinding && !bindingValid(remote.lastBinding))
      || (remote.binding && !samePin(remote.binding, remote.lastBinding))
      || (!remote.lastBinding && (publications.length || segments.length || artifacts.length))) fail('Invalid retained binding identity');
    const pass = remote.pass;
    if (!pass || !integer(pass.passId, 0) || !['enumerationComplete', 'reconciled', 'inProgress'].every(key => typeof pass[key as keyof Pass] === 'boolean')
      || (pass.error !== null && typeof pass.error !== 'string')
      || (pass.lastSuccess !== null && !integer(pass.lastSuccess, 1, pass.passId))
      || (remote.lastBinding && !samePin(pass.binding, remote.lastBinding))
      || (pass.reconciled && (!pass.enumerationComplete || pass.inProgress || pass.error || remote.blocked))) fail('Invalid retained discovery state');
    if (remote.blocked && (typeof remote.blocked.classification !== 'string' || typeof remote.blocked.reason !== 'string')) fail('Invalid retained integrity state');
    const accepted = new Set<string>();
    for (const segment of segments) {
      const parsed = parseSegment(segment.bytes);
      if (parsed.datasetId !== datasetId || parsed.segmentId !== segment.segmentId
        || JSON.stringify(segment.operationIds) !== JSON.stringify(parsed.operations.map((value: Operation) => value.opId))) fail('Invalid accepted segment identity');
      for (const operation of parsed.operations as Operation[]) {
        const original = journal.get(operation.opId);
        if (!original || !operationEqual(original, operation)) fail('Accepted segment is missing its immutable operation');
        accepted.add(operation.opId);
      }
    }
    const bySegment = new Map(publications.map(value => [value.segmentId, value]));
    const byPending = new Map(pending.map(value => [value.opId, value]));
    for (const publication of publications) {
      validateUuid(publication.segmentId); validateUuid(publication.writerId);
      if (publication.datasetId !== datasetId || publication.binding.datasetId !== datasetId
        || !bindingValid(publication.binding) || !sameDestination(publication.binding, remote.lastBinding)
        || !integer(publication.attempts, 0)
        || (publication.retryHandle !== undefined && (typeof publication.retryHandle !== 'string' || !publication.retryHandle))
        || (publication.remoteReferences !== undefined && (!Array.isArray(publication.remoteReferences)
          || publication.remoteReferences.some(reference => typeof reference !== 'string' || !reference)))
        || !['reserved', 'sealed', 'in-flight', 'unknown', 'confirmed', 'acknowledged'].includes(publication.state)
        || JSON.stringify(publication.operationIds) !== JSON.stringify(publication.operations.map(value => value.opId))) fail('Invalid publication identity');
      for (const operation of publication.operations) {
        const original = journal.get(operation.opId);
        if (!original || !operationEqual(original, operation)) fail('Publication operation is missing or changed');
        if (publication.state !== 'acknowledged' && byPending.get(operation.opId)?.reservation !== publication.segmentId) fail('Publication membership was lost');
        if (publication.state === 'acknowledged') {
          if (byPending.has(operation.opId)) fail('Acknowledged membership is still pending');
          accepted.add(operation.opId);
        }
      }
      const bytes = sealedBytes(publication); // Also validates reserved complete membership/writer/count.
      if (publication.state === 'reserved' ? publication.bytes !== null : !publication.bytes || !sameBytes(bytes, publication.bytes)) fail('Publication bytes are missing or changed');
      const prior = segments.find(value => value.segmentId === publication.segmentId);
      if (publication.bytes && prior && !sameBytes(publication.bytes, prior.bytes)) fail('Conflicting retained segment bytes');
    }
    for (const row of pending) {
      if (!journal.has(row.opId) || (row.reservation !== null
        && !bySegment.get(row.reservation)?.operationIds.includes(row.opId))) fail('Invalid pending membership');
    }
    if (operations.some(value => !byPending.has(value.opId) && !accepted.has(value.opId))) fail('Operation has neither pending nor accepted evidence');
    for (const artifact of artifacts) {
      if (typeof artifact.reference !== 'string' || !artifact.reference
        || !['pending', 'applied', 'quarantined'].includes(artifact.state)
        || (artifact.state === 'applied' && !artifact.originalBytes)
        || (artifact.verifiedPass !== undefined && !integer(artifact.verifiedPass, 0, pass.passId))
        || (artifact.seenPass !== undefined && !integer(artifact.seenPass, 0, pass.passId))
        || (artifact.rejectedBytes && artifact.rejectedBytes.length > MAX_SEGMENT_BYTES)) fail('Invalid retained artifact state');
      if (!artifact.originalBytes) continue;
      const parsed = parseSegment(artifact.originalBytes);
      const segment = segments.find(value => value.segmentId === artifact.segmentId);
      if (parsed.segmentId !== artifact.segmentId || !segment || !sameBytes(segment.bytes, artifact.originalBytes)) fail('Artifact lost its accepted identity');
    }
  }
  disconnect() {
    return this.write('disconnect', null, async (tx, { remote }) => {
      if ((await this.get<Active>(tx, 'active', 'current'))?.state !== 'idle') throw new RemoteError('active-not-idle');
      remote.bindingGeneration = nextCounter(remote.bindingGeneration); remote.binding = null;
      this.step(tx, 'disconnect.binding');
    });
  }
  /** Optional opportunity membership excludes commands authored while earlier uploads awaited. */
  reserve(pin: Binding, { maxOperations = MAX_OPERATIONS, operationIds }: { maxOperations?: number; operationIds?: string[] } = {}): Promise<Publication | null> {
    pin = structuredClone(pin);
    if (!Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > MAX_OPERATIONS) throw new RemoteError('invalid-reservation-limit');
    const eligibleIds = operationIds === undefined ? undefined : new Set(operationIds);
    return this.write('reserve', pin, async (tx) => {
      const pending = (await this.all<Pending>(tx, 'outbox', pin.datasetId))
        .filter(value => value.reservation === null && (!eligibleIds || eligibleIds.has(value.opId))).sort((a, b) => a.opId < b.opId ? -1 : 1);
      if (!pending.length) return null;
      const segmentId = this.ids(); validateUuid(segmentId);
      if (await this.get(tx, 'publications', [pin.datasetId, segmentId]) || await this.get(tx, 'segments', [pin.datasetId, segmentId])) throw new RemoteError('integrity', 'Segment ID collision');
      const eligible: Operation[] = [];
      for (const row of pending) {
        const operation = await this.get<Operation>(tx, 'operations', [pin.datasetId, row.opId]);
        if (!operation) throw new RemoteError('integrity', 'Pending operation is missing');
        eligible.push(validateOperation(operation) as Operation);
      }
      const publication = makeReservation(pin, segmentId, eligible, maxOperations) as Publication;
      await request(tx.objectStore('publications').add(publication)); this.step(tx, 'reserve.intent');
      for (const opId of publication.operationIds) await this.put(tx, 'outbox', { datasetId: pin.datasetId, opId, reservation: segmentId });
      this.step(tx, 'reserve.membership'); return publication;
    });
  }
  seal(pin: Binding, segmentId: string): Promise<Publication> {
    pin = structuredClone(pin);
    return this.write('seal', pin, async tx => {
      const publication = await this.publication(tx, pin, segmentId);
      if (publication.state !== 'reserved') return publication;
      const bytes = sealedBytes(publication);
      const accepted = await this.get<Segment>(tx, 'segments', [pin.datasetId, segmentId]);
      if (accepted && !sameBytes(accepted.bytes, bytes)) throw new RemoteError('integrity', 'Reserved segment identity conflicts with accepted bytes');
      for (const id of publication.operationIds) {
        if ((await this.get<Pending>(tx, 'outbox', [pin.datasetId, id]))?.reservation !== segmentId) throw new RemoteError('integrity', 'Reservation was lost');
      }
      publication.bytes = bytes; this.step(tx, 'seal.bytes');
      publication.state = 'sealed'; await this.put(tx, 'publications', publication); this.step(tx, 'seal.intent'); return publication;
    });
  }
  publications(pin: Binding) {
    pin = structuredClone(pin);
    return this.read(async (tx, { remote }) => {
      this.check(remote, pin);
      return (await this.all<Publication>(tx, 'publications', pin.datasetId)).filter(value => samePin(value.binding, pin) && value.state !== 'acknowledged');
    });
  }
  pendingOperationIds(pin: Binding) {
    pin = structuredClone(pin);
    return this.read(async (tx, { remote }) => {
      this.check(remote, pin);
      return (await this.all<Pending>(tx, 'outbox', pin.datasetId)).filter(value => value.reservation === null).map(value => value.opId);
    });
  }
  /** First committed creation identity wins. No network work occurs in this transaction. */
  retainRetryHandle(pin: Binding, segmentId: string, handle: string): Promise<Publication> {
    pin = structuredClone(pin);
    if (typeof handle !== 'string' || !handle) throw new RemoteError('invalid-retry-handle');
    return this.write('retryHandle', pin, async tx => {
      const publication = await this.publication(tx, pin, segmentId);
      if (!publication.bytes) throw new RemoteError('invalid-publication-state');
      if (publication.retryHandle === undefined) {
        publication.retryHandle = handle;
        await this.put(tx, 'publications', publication);
      }
      this.step(tx, 'retryHandle.identity'); return publication;
    });
  }
  beginAttempt(pin: Binding, segmentId: string) {
    pin = structuredClone(pin);
    return this.write('attempt', pin, async tx => {
      const publication = await this.publication(tx, pin, segmentId);
      if (!publication.bytes || ['reserved', 'confirmed', 'acknowledged'].includes(publication.state)) throw new RemoteError('invalid-publication-state');
      publication.state = 'in-flight'; publication.attempts = nextCounter(publication.attempts);
      await this.put(tx, 'publications', publication); this.step(tx, 'attempt.intent'); return publication;
    });
  }
  unknown(pin: Binding, segmentId: string) {
    pin = structuredClone(pin);
    return this.write('unknown', pin, async tx => {
      const publication = await this.publication(tx, pin, segmentId);
      if (!['confirmed', 'acknowledged'].includes(publication.state)) publication.state = 'unknown';
      await this.put(tx, 'publications', publication); this.step(tx, 'unknown.intent');
    });
  }
  confirm(pin: Binding, segmentId: string, input: { outcome: string; segmentId: string; bytes: Uint8Array; references?: string[] }) {
    pin = structuredClone(pin);
    const confirmation = structuredClone(input);
    return this.write('confirm', pin, async (tx, { remote }) => {
      const publication = await this.publication(tx, pin, segmentId);
      const retained = await this.get<Segment>(tx, 'segments', [pin.datasetId, segmentId]);
      const references = validateConfirmation(publication, confirmation, retained) as string[];
      for (const reference of references) {
        const artifact = await this.get<Artifact>(tx, 'artifacts', [pin.datasetId, reference]);
        if ((artifact?.originalBytes && !sameBytes(artifact.originalBytes, publication.bytes!))
          || (artifact?.segmentId && artifact.segmentId !== segmentId)) throw new RemoteError('integrity', 'Confirmed physical reference conflicts with known content');
        await this.put(tx, 'artifacts', { ...artifact, datasetId: pin.datasetId, reference,
          originalBytes: publication.bytes, segmentId, state: 'applied', error: null, verifiedPass: remote.pass.passId });
      }
      publication.remoteReferences = [...new Set([...(publication.remoteReferences ?? []), ...references])];
      if (publication.remoteReferences.length) await this.put(tx, 'segments', { datasetId: pin.datasetId, segmentId, bytes: publication.bytes, operationIds: publication.operationIds });
      this.step(tx, 'confirm.coverage');
      if (publication.state !== 'acknowledged') publication.state = 'confirmed';
      await this.put(tx, 'publications', publication); this.step(tx, 'confirm.intent');
    });
  }
  acknowledge(pin: Binding, segmentId: string) {
    pin = structuredClone(pin);
    return this.write('ack', pin, async tx => {
      const publication = await this.publication(tx, pin, segmentId);
      if (publication.state === 'acknowledged') return;
      if (publication.state !== 'confirmed') throw new RemoteError('unconfirmed-publication');
      for (let index = 0; index < publication.operationIds.length; index++) {
        const id = publication.operationIds[index];
        if ((await this.get<Pending>(tx, 'outbox', [pin.datasetId, id]))?.reservation !== segmentId
          || !operationEqual(await this.get(tx, 'operations', [pin.datasetId, id]), publication.operations[index])) throw new RemoteError('integrity', 'Acknowledgement membership mismatch');
        await request(tx.objectStore('outbox').delete([pin.datasetId, id]));
      }
      this.step(tx, 'ack.membership'); publication.state = 'acknowledged';
      await this.put(tx, 'publications', publication); this.step(tx, 'ack.intent');
    });
  }
  verifyDescriptor(pin: Binding, input: Descriptor) {
    pin = structuredClone(pin);
    const descriptor = validateDescriptor(input);
    return this.write('descriptor', pin, async (tx, { collection }) => {
      if (JSON.stringify(descriptor) !== JSON.stringify(validateDescriptor(collection.descriptor))) throw new RemoteError('integrity', 'Bound descriptor changed');
      this.step(tx, 'descriptor.verified');
    });
  }
  private async passSnapshot(tx: IDBTransaction, remote: Remote) {
    const artifacts = await this.all<Artifact>(tx, 'artifacts', remote.datasetId);
    return { ...remote.pass, seen: artifacts.filter(value => value.seenPass === remote.pass.passId).map(value => value.reference),
      artifacts: keyed(artifacts, value => value.reference) };
  }
  beginPass(pin: Binding) {
    pin = structuredClone(pin);
    return this.write('pass', pin, async (tx, { remote }) => {
      const pass = remote.pass;
      if (pass.passId === 0 || pass.enumerationComplete) {
        pass.passId = nextCounter(pass.passId); pass.checkpoint = null;
        pass.enumerationComplete = false; pass.reconciled = false;
      }
      pass.inProgress = true; pass.error = null; this.step(tx, 'pass.start');
      return this.passSnapshot(tx, remote);
    });
  }
  restartEnumeration(pin: Binding) {
    pin = structuredClone(pin);
    return this.write('restartScan', pin, async (tx, { remote }) => {
      remote.pass.checkpoint = null; remote.pass.enumerationComplete = false; remote.pass.reconciled = false;
      for (const artifact of await this.all<Artifact>(tx, 'artifacts', pin.datasetId)) {
        delete artifact.seenPass; await this.put(tx, 'artifacts', artifact);
      }
      this.step(tx, 'restartScan.checkpoint');
    });
  }
  recordPage(pin: Binding, passId: number, input: { references: string[]; complete: boolean; continuation?: unknown }) {
    pin = structuredClone(pin);
    const page = structuredClone(input);
    if (!page || !Array.isArray(page.references) || typeof page.complete !== 'boolean'
      || (!page.complete && page.continuation == null)) throw new RemoteError('invalid-enumeration');
    return this.write('discover', pin, async (tx, { remote }) => {
      const pass = remote.pass;
      if (pass.passId !== passId || pass.enumerationComplete) throw new RemoteError('stale-pass');
      for (const reference of page.references) {
        if (typeof reference !== 'string' || !reference) throw new RemoteError('invalid-reference');
        const artifact = await this.get<Artifact>(tx, 'artifacts', [pin.datasetId, reference]);
        await this.put(tx, 'artifacts', { ...artifact, datasetId: pin.datasetId, reference,
          originalBytes: artifact?.originalBytes ?? null, segmentId: artifact?.segmentId ?? null,
          state: 'pending', error: null, seenPass: passId });
      }
      this.step(tx, 'discover.pending');
      pass.checkpoint = page.continuation; pass.enumerationComplete = page.complete;
      this.step(tx, 'discover.checkpoint'); return this.passSnapshot(tx, remote);
    });
  }
  pendingReferences(pin: Binding) {
    pin = structuredClone(pin);
    return this.read(async (tx, { remote }) => {
      this.check(remote, pin);
      return (await this.all<Artifact>(tx, 'artifacts', pin.datasetId)).filter(value => value.state === 'pending').map(value => value.reference);
    });
  }
  omittedReferences(pin: Binding) {
    pin = structuredClone(pin);
    return this.read(async (tx, { remote }) => {
      this.check(remote, pin);
      return (await this.all<Artifact>(tx, 'artifacts', pin.datasetId)).filter(value => value.seenPass !== remote.pass.passId).map(value => value.reference);
    });
  }
  hasOriginalBytes(pin: Binding, reference: string) {
    pin = structuredClone(pin);
    return this.read(async (tx, { remote }) => {
      this.check(remote, pin);
      return !!(await this.get<Artifact>(tx, 'artifacts', [pin.datasetId, reference]))?.originalBytes;
    });
  }
  async receive(pin: Binding, reference: string, input: Uint8Array) {
    pin = structuredClone(pin);
    if (typeof reference !== 'string' || !reference) throw new RemoteError('invalid-reference');
    if (!(input instanceof Uint8Array)) throw new RemoteError('malformed', 'Expected artifact bytes');
    // Copy bounded input before yielding to the caller; oversized input is never copied.
    if (input.length <= MAX_SEGMENT_BYTES) input = Uint8Array.from(input);
    await this.assertPin(pin);
    // Known physical identity is checked before parsing as well as inside acceptance.
    await this.read(async (tx, { remote }) => {
      this.check(remote, pin);
      const artifact = await this.get<Artifact>(tx, 'artifacts', [pin.datasetId, reference]);
      if (artifact?.originalBytes && !sameBytes(artifact.originalBytes, input)) throw new RemoteError('integrity', 'Known physical artifact changed');
    });
    if (input.length > MAX_SEGMENT_BYTES) throw new RemoteError('malformed', 'Expected bounded artifact bytes');
    const bytes = Uint8Array.from(input);
    const segment = parseSegment(bytes);
    return this.write('receive', pin, async (tx, { remote, collection }) => {
      if (segment.datasetId !== pin.datasetId) throw new RemoteError('malformed', 'Segment belongs to another dataset');
      const artifact = await this.get<Artifact>(tx, 'artifacts', [pin.datasetId, reference]);
      if (artifact?.originalBytes && !sameBytes(artifact.originalBytes, bytes)) throw new RemoteError('integrity', 'Known physical artifact changed');
      const prior = await this.get<Segment>(tx, 'segments', [pin.datasetId, segment.segmentId]);
      const sealed = await this.get<Publication>(tx, 'publications', [pin.datasetId, segment.segmentId]);
      if ((prior && !sameBytes(prior.bytes, bytes)) || (sealed?.bytes && !sameBytes(sealed.bytes, bytes))) throw new RemoteError('integrity', 'Same segmentId has different sealed bytes');
      const additions: Operation[] = [];
      for (const operation of segment.operations as Operation[]) {
        const previous = await this.get<Operation>(tx, 'operations', [pin.datasetId, operation.opId]);
        if (previous && !operationEqual(previous, operation)) throw new RemoteError('integrity', 'Same opId has different semantic values');
        if (!previous) additions.push(operation);
      }
      this.step(tx, 'receive.identities');
      for (const operation of additions) await request(tx.objectStore('operations').add(operation));
      this.step(tx, 'receive.operations');
      // A validated winner/tombstone is an associative summary. Read at most one
      // prior winner per touched entity, rather than all its historical versions.
      // Startup audits this cache against the journal; every writer updates it atomically.
      for (const entityId of new Set<string>(segment.operations.map((operation: Operation) => operation.entityId))) {
        const prior = await this.get<{ winner: Operation }>(tx, 'history', [pin.datasetId, entityId]);
        if (prior) {
          const original = await this.get<Operation>(tx, 'operations', [pin.datasetId, prior.winner.opId]);
          if (!original || !operationEqual(original, prior.winner) || prior.winner.entityId !== entityId) throw new RemoteError('integrity', 'Invalid projection authority');
        }
        const operations = segment.operations.filter((value: Operation) => value.entityId === entityId);
        const winner = materializeOperations(prior ? [prior.winner, ...operations] : operations).winners.get(entityId);
        await this.put(tx, 'history', { datasetId: pin.datasetId, id: entityId, winner });
      }
      this.step(tx, 'receive.projection');
      collection.highWater = Math.max(collection.highWater, ...segment.operations.map((operation: Operation) => operation.lamportCounter));
      await this.put(tx, 'collections', collection); this.step(tx, 'receive.highWater');
      const operationIds = segment.operations.map((operation: Operation) => operation.opId);
      await this.put(tx, 'segments', { datasetId: pin.datasetId, segmentId: segment.segmentId, bytes, operationIds });
      this.step(tx, 'receive.dedup');
      await this.put(tx, 'artifacts', { ...artifact, datasetId: pin.datasetId, reference, originalBytes: bytes,
        segmentId: segment.segmentId, state: 'applied', error: null, verifiedPass: remote.pass.passId });
      if (sealed?.bytes) {
        sealed.remoteReferences = [...new Set([...(sealed.remoteReferences ?? []), reference])];
        await this.put(tx, 'publications', sealed);
      }
      this.step(tx, 'receive.applied'); return { segmentId: segment.segmentId, operationIds };
    });
  }
  artifactFailure(pin: Binding, reference: string, error: Failure, input?: Uint8Array) {
    pin = structuredClone(pin);
    const failure = { classification: error.classification ?? error.code ?? 'malformed', reason: error.message ?? 'Artifact rejected' };
    const rejectedBytes = input instanceof Uint8Array ? input.slice(0, MAX_SEGMENT_BYTES) : undefined;
    const rejectedByteLength = input?.length;
    return this.write('quarantine', pin, async (tx, { remote }) => {
      const artifact = await this.get<Artifact>(tx, 'artifacts', [pin.datasetId, reference]);
      await this.put(tx, 'artifacts', { ...artifact, datasetId: pin.datasetId, reference,
        originalBytes: artifact?.originalBytes ?? null, segmentId: artifact?.segmentId ?? null,
        state: 'quarantined', error: failure.classification,
        ...(rejectedBytes ? { rejectedBytes, rejectedByteLength } : {}) });
      remote.blocked = { ...failure, reference }; remote.pass.inProgress = false; remote.pass.reconciled = false;
      this.step(tx, 'quarantine.evidence');
    }, true);
  }
  runFailure(pin: Binding, error: Failure) {
    pin = structuredClone(pin);
    const failure = { classification: error.code ?? error.classification ?? 'retryable', reason: error.message ?? 'Sync interrupted' };
    return this.write('runFailure', pin, async (tx, { remote }) => {
      remote.pass.error = failure.classification; remote.pass.inProgress = false; remote.pass.reconciled = false;
      if (['missing-dataset', 'missing-object', 'access', 'integrity', 'malformed', 'unsupported'].includes(failure.classification)) remote.blocked = failure;
      this.step(tx, 'runFailure.error');
    }, true);
  }
  completePass(pin: Binding) {
    pin = structuredClone(pin);
    return this.write('complete', pin, async (tx, { remote }) => {
      const artifacts = await this.all<Artifact>(tx, 'artifacts', pin.datasetId);
      const publications = await this.all<Publication>(tx, 'publications', pin.datasetId);
      const unresolved = artifacts.some(value => value.state !== 'applied' || value.verifiedPass !== remote.pass.passId);
      const pending = publications.some(value => value.state !== 'acknowledged') || coveragePending(publications, keyed(artifacts, value => value.reference));
      remote.pass.inProgress = false;
      remote.pass.reconciled = !remote.pass.error && !remote.blocked && remote.pass.enumerationComplete && !unresolved
        && !(await request(tx.objectStore('outbox').index('dataset').count(pin.datasetId))) && !pending;
      if (remote.pass.reconciled) remote.pass.lastSuccess = remote.pass.passId;
      this.step(tx, 'complete.status'); return remote.pass.reconciled;
    });
  }
  status() {
    return this.read(async (tx, { remote, collection }) => remoteStatus({ highWater: collection.highWater,
      binding: remote.binding, blocked: remote.blocked, pass: await this.passSnapshot(tx, remote),
      outbox: await this.all<Pending>(tx, 'outbox', remote.datasetId),
      publications: await this.all<Publication>(tx, 'publications', remote.datasetId) }));
  }
  /** Diagnostic/model comparison snapshot; never exported as portable domain data. */
  snapshot() {
    return this.read(async (tx, { remote, collection, installation }) => {
      const operations = await this.all<Operation>(tx, 'operations', remote.datasetId);
      const reduced = materializeOperations(operations, collection.highWater);
      const pass = await this.passSnapshot(tx, remote);
      return { descriptor: collection.descriptor, writerId: installation.writerId, highWater: collection.highWater,
        operations: keyed(operations, value => value.opId), entities: keyed(reduced.entities, (value: { id: string }) => value.id), tombstones: reduced.tombstones,
        outbox: keyed(await this.all<Pending>(tx, 'outbox', remote.datasetId), value => value.opId),
        publications: keyed(await this.all<Publication>(tx, 'publications', remote.datasetId), value => value.segmentId),
        segments: keyed(await this.all<Segment>(tx, 'segments', remote.datasetId), value => value.segmentId),
        binding: remote.binding, lastBinding: remote.lastBinding, bindingGeneration: remote.bindingGeneration, blocked: remote.blocked,
        discoveries: remote.lastBinding ? { [remote.lastBinding.generation]: pass } : {} };
    });
  }
  /** Full lossless local corpus archive; provider metadata never enters this value. */
  archive() {
    return this.read(async (tx, { remote, collection }) => {
      const segments = await this.all<Segment>(tx, 'segments', remote.datasetId);
      const publications = await this.all<Publication>(tx, 'publications', remote.datasetId);
      const included = new Map(segments.map(value => [value.segmentId, value]));
      for (const publication of publications) if (publication.bytes) {
        const previous = included.get(publication.segmentId);
        if (previous && !sameBytes(previous.bytes, publication.bytes)) throw new RemoteError('integrity', 'Conflicting archive segment identity');
        included.set(publication.segmentId, { ...publication, bytes: publication.bytes });
      }
      const ordered = [...included.values()].sort((a, b) => a.segmentId < b.segmentId ? -1 : 1);
      const covered = new Set(ordered.flatMap(value => value.operationIds));
      return { format: 'focus-timer-dataset-archive', formatVersion: 1, coverage: 'local-replica', dataset: collection.descriptor,
        segments: ordered.map(value => decodeUtf8(value.bytes)),
        unsegmentedOperations: (await this.all<Operation>(tx, 'operations', remote.datasetId)).filter(value => !covered.has(value.opId)).sort((a, b) => a.opId < b.opId ? -1 : 1) };
    });
  }
}
