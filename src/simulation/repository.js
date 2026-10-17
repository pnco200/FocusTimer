import {
  MAX_COUNTER, MAX_OPERATIONS, MAX_SEGMENT_BYTES, authorDescription, encodeUtf8,
  operationEqual, parseSegment, reduceOperations, validateDescriptor,
  validateOperation, validateSession,
} from '../protocol/index.js';

const clone = value => structuredClone(value);
const sameBytes = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
const samePin = (a, b) => a && b && a.generation === b.generation
  && a.account === b.account && a.locator === b.locator && a.datasetId === b.datasetId;
const sameDestination = (a, b) => a && b && a.account === b.account
  && a.locator === b.locator && a.datasetId === b.datasetId;
const own = (object, key) => Object.hasOwn(object, key);
const getOwn = (object, key) => own(object, key) ? object[key] : undefined;
const putOwn = (object, key, value) => Object.defineProperty(object, key,
  { value, writable: true, enumerable: true, configurable: true });

export class SimulationError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'SimulationError';
    this.code = code;
    this.classification = ['malformed', 'unsupported', 'integrity'].includes(code) ? code : undefined;
  }
}

export class InjectedFailure extends Error {
  constructor(point) {
    super(`Injected persistence failure: ${point}`);
    this.name = 'InjectedFailure';
    this.point = point;
  }
}

/** Synchronous serial transactions over cloned state; the handle survives repository reopening. */
export class MemoryStore {
  #state;
  #failure;
  #busy = false;
  trace = [];

  read() { return clone(this.#state); }
  failNext(point) { this.#failure = point; }
  clearTrace() { this.trace.length = 0; }

  #step = point => {
    this.trace.push(point);
    if (this.#failure === point) {
      this.#failure = undefined;
      throw new InjectedFailure(point);
    }
  };

  transaction(kind, work) {
    if (this.#busy) throw new SimulationError('nested-transaction');
    this.#busy = true;
    try {
      this.#step(`${kind}.begin`);
      const draft = clone(this.#state);
      const result = work(draft, label => this.#step(`${kind}.${label}`));
      this.#step(`${kind}.beforeCommit`);
      this.#state = draft;
      this.#step(`${kind}.afterCommit`);
      return clone(result);
    } finally {
      this.#busy = false;
    }
  }

  initialize(value) {
    if (this.#state !== undefined) return;
    this.#state = clone(value);
  }
}

function requireGeneration(state, expected) {
  if (expected !== state.bindingGeneration) throw new SimulationError('stale-binding');
}

function requirePin(state, pin, allowBlocked = false) {
  if (!samePin(state.binding, pin)) throw new SimulationError('stale-binding');
  if (!allowBlocked && state.blocked) throw new SimulationError('binding-blocked', state.blocked.reason);
}

function assertUuid(value) {
  validateDescriptor({ application: 'focus-timer', protocolVersion: 1, datasetId: value });
  return value;
}

function projection(state, step) {
  const reduced = reduceOperations(Object.values(state.operations));
  state.entities = Object.fromEntries(reduced.entities.map(entity => [entity.id, entity]));
  state.tombstones = reduced.tombstones;
  step('projection');
  state.highWater = Math.max(state.highWater, reduced.highWater);
  step('highWater');
}

function currentWinner(state, entityId) {
  if (!own(state.entities, entityId)) return undefined;
  let winner;
  for (const operation of Object.values(state.operations)) {
    if (operation.entityId !== entityId || operation.operation !== 'UPSERT') continue;
    if (!winner || operation.lamportCounter > winner.lamportCounter
      || (operation.lamportCounter === winner.lamportCounter && operation.opId > winner.opId)) winner = operation;
  }
  return winner;
}

function authoredPayload(value) {
  const validated = validateSession(value); // Validate input before trimming the 120-scalar bound.
  validated.description = authorDescription(validated.description);
  return validated;
}

function assertFreshEntity(state, entityId) {
  if (Object.values(state.operations).some(operation => operation.entityId === entityId)) {
    throw new SimulationError('entity-id-collision', 'Finish requires a fresh completed session identity');
  }
}

function assertCommandId(command) {
  if (typeof command.commandId !== 'string' || !command.commandId) throw new SimulationError('invalid-command-id');
}

function localOperation(state, { entityId, operation, payload, opId }, step) {
  if (state.highWater === MAX_COUNTER) throw new SimulationError('counter-exhausted');
  const value = validateOperation({
    protocolVersion: 1, schemaVersion: 1, datasetId: state.descriptor.datasetId,
    deviceId: state.writerId, opId, entityType: 'focusSession', entityId, operation,
    lamportCounter: state.highWater + 1, ...(operation === 'UPSERT' ? { payload } : {}),
  });
  if (own(state.operations, opId)) throw new SimulationError('integrity', 'A newly authored opId already exists');
  state.operations[opId] = value;
  step('operation');
  projection(state, step);
  state.outbox[opId] = { reservation: null };
  step('outbox');
  state.revision += 1;
  step('domain');
  return value;
}

function assertOwner(state, command) {
  if (!state.owner || state.owner.token !== command.ownerToken
    || state.owner.generation !== command.ownerGeneration || state.owner.status !== 'live') {
    throw new SimulationError('stale-owner');
  }
}

function assertActive(state, command) {
  assertOwner(state, command);
  if (!state.active || state.active.id !== command.activeId
    || state.active.revision !== command.expectedRevision) throw new SimulationError('stale-active');
}

function discovery(state) { return state.discoveries[state.binding.generation]; }

function publicationCoveragePending(state) {
  const artifacts = discovery(state).artifacts;
  return Object.values(state.publications).some(publication => publication.state === 'acknowledged'
    && (!publication.remoteReferences?.length || publication.remoteReferences.some(reference =>
      getOwn(artifacts, reference)?.segmentId !== publication.segmentId)));
}

/** One dataset replica. All exposed snapshots, publications and byte arrays are defensive copies. */
export class TransactionalRepository {
  constructor({ store = new MemoryStore(), descriptor, writerId, ids } = {}) {
    this.store = store;
    this.ids = ids ?? (() => { throw new SimulationError('id-factory-required'); });
    if (!store.read()) {
      const valid = validateDescriptor(descriptor);
      assertUuid(writerId);
      store.initialize({
        descriptor: valid, writerId, highWater: 0, revision: 0, operations: {}, entities: {}, tombstones: [],
        active: null, owner: null, ownerGeneration: 0, activeReceipts: {}, commandReceipts: {},
        outbox: {}, publications: {}, segments: {}, binding: null, lastBinding: null, bindingGeneration: 0,
        discoveries: {}, recoveryCollections: {}, blocked: null,
      });
    }
  }

  snapshot() { return this.store.read(); }
  materialized() {
    const state = this.snapshot();
    return { entities: Object.values(state.entities).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0), tombstones: state.tombstones };
  }
  captureBinding() { return this.snapshot().binding; }
  assertPin(pin) { requirePin(this.snapshot(), pin); }
  entityVersion(entityId) { return currentWinner(this.snapshot(), entityId)?.opId; }

  bind({ account, locator, descriptor, expectedGeneration = this.snapshot().bindingGeneration, resumePublications = false }) {
    const validated = validateDescriptor(descriptor);
    if (typeof account !== 'string' || !account || typeof locator !== 'string' || !locator) throw new SimulationError('invalid-binding');
    return this.store.transaction('bind', (state, step) => {
      requireGeneration(state, expectedGeneration);
      if (state.active) throw new SimulationError('active-not-idle');
      if (validated.datasetId !== state.descriptor.datasetId) throw new SimulationError('dataset-mismatch');
      const pendingPublications = Object.values(state.publications).filter(publication => publication.state !== 'acknowledged');
      if (pendingPublications.length && (!resumePublications || pendingPublications.some(publication =>
        publication.binding.account !== account || publication.binding.locator !== locator
        || publication.binding.datasetId !== validated.datasetId))) {
        throw new SimulationError('pending-publication-rebind-required', 'Explicitly resume the original target or resolve retained publication intents before rebinding');
      }
      const established = state.binding ?? state.lastBinding ?? Object.values(state.discoveries).at(-1)?.binding;
      const retainedCorpus = Object.keys(state.operations).length || Object.keys(state.segments).length
        || Object.keys(state.publications).length || Object.values(state.discoveries).some(pass => Object.keys(pass.artifacts).length);
      if (established && retainedCorpus && !sameDestination(established, { account, locator, datasetId: validated.datasetId })) {
        throw new SimulationError('destination-transfer-required', 'Retained dataset history requires a deliberate complete-corpus transfer before changing destination');
      }
      const previousDiscovery = Object.values(state.discoveries).findLast(pass => pass.binding?.account === account && pass.binding?.locator === locator);
      state.bindingGeneration += 1;
      state.binding = { account, locator, datasetId: validated.datasetId, generation: state.bindingGeneration };
      state.lastBinding = clone(state.binding);
      state.blocked = null;
      state.discoveries[state.bindingGeneration] = previousDiscovery ? {
        ...clone(previousDiscovery), binding: clone(state.binding), checkpoint: null,
        enumerationComplete: true, reconciled: false, inProgress: false, error: null,
      } : {
        binding: clone(state.binding),
        passId: 0, checkpoint: null, enumerationComplete: false, reconciled: false,
        inProgress: false, seen: [], artifacts: {}, error: null, lastSuccess: null,
      };
      for (const publication of pendingPublications) {
        publication.binding = clone(state.binding);
        if (publication.state === 'in-flight') publication.state = 'unknown';
      }
      step('binding');
      return state.binding;
    });
  }

  disconnect() {
    return this.store.transaction('disconnect', (state, step) => {
      if (state.active) throw new SimulationError('active-not-idle');
      state.bindingGeneration += 1;
      state.binding = null;
      step('binding');
    });
  }

  rotateWriter(writerId) {
    assertUuid(writerId);
    return this.store.transaction('rotate', (state, step) => {
      state.writerId = writerId;
      for (const operation of Object.values(state.operations)) state.highWater = Math.max(state.highWater, operation.lamportCounter);
      for (const collection of Object.values(state.recoveryCollections)) {
        collection.writerId = writerId;
        for (const operation of Object.values(collection.operations)) collection.highWater = Math.max(collection.highWater, operation.lamportCounter);
      }
      step('writer');
    });
  }

  acquireOwner(token) {
    if (typeof token !== 'string' || !token) throw new SimulationError('invalid-owner');
    return this.store.transaction('owner', (state, step) => {
      if (state.owner?.status === 'live') return { kind: 'attached', owner: state.owner, active: state.active };
      if (state.owner) throw new SimulationError('owner-recovery-required');
      state.ownerGeneration += 1;
      state.owner = { token, generation: state.ownerGeneration, status: 'live' };
      step('fence');
      return { kind: 'acquired', owner: state.owner };
    });
  }

  /** Test harness supplies execution-lifetime evidence; elapsed heartbeats never establish death. */
  setOwnerStatus(status) {
    if (!['live', 'unknown', 'gone'].includes(status)) throw new SimulationError('invalid-owner-status');
    return this.store.transaction('ownerSignal', (state, step) => {
      if (!state.owner) throw new SimulationError('no-owner');
      state.owner.status = status;
      step('signal');
    });
  }

  recoverOwner(token, { deliberate = false } = {}) {
    if (typeof token !== 'string' || !token) throw new SimulationError('invalid-owner');
    return this.store.transaction('recovery', (state, step) => {
      if (!state.owner || state.owner.status === 'live'
        || (state.owner.status === 'unknown' && !deliberate)) throw new SimulationError('owner-recovery-required');
      state.ownerGeneration += 1;
      state.owner = { token, generation: state.ownerGeneration, status: 'live' };
      if (state.active) {
        state.active.state = 'paused';
        state.active.revision += 1;
      }
      step('fence');
      return { owner: state.owner, active: state.active };
    });
  }

  startActive(command) {
    const { activeId = this.ids(), startedAt, focusDurationMs = 0, description = '', state: phase = 'paused' } = command;
    assertUuid(activeId);
    validateSession({ id: activeId, startedAt, endedAt: startedAt, focusDurationMs: Math.max(1, focusDurationMs), description });
    if (!Number.isSafeInteger(focusDurationMs) || focusDurationMs < 0 || !['running', 'paused'].includes(phase)) throw new SimulationError('invalid-active');
    return this.store.transaction('start', (state, step) => {
      requireGeneration(state, command.expectedBindingGeneration);
      assertOwner(state, command);
      if (state.active) throw new SimulationError('already-active');
      if (own(state.activeReceipts, activeId)) throw new SimulationError('active-id-collision');
      state.active = { id: activeId, revision: 1, datasetId: state.descriptor.datasetId, startedAt, focusDurationMs, description, state: phase };
      step('active');
      return state.active;
    });
  }

  checkpointActive(command) {
    return this.store.transaction('checkpoint', (state, step) => {
      requireGeneration(state, command.expectedBindingGeneration);
      assertActive(state, command);
      const focus = command.focusDurationMs;
      validateSession({ id: state.active.id, startedAt: state.active.startedAt, endedAt: state.active.startedAt,
        focusDurationMs: Math.max(1, focus), description: command.description === undefined ? state.active.description : command.description });
      if (!Number.isSafeInteger(focus) || focus < 0) throw new SimulationError('invalid-active');
      state.active.focusDurationMs = focus;
      if (command.description !== undefined) state.active.description = command.description;
      if (command.state !== undefined) {
        if (!['paused', 'running'].includes(command.state)) throw new SimulationError('invalid-active');
        state.active.state = command.state;
      }
      state.active.revision += 1;
      step('active');
      return state.active;
    });
  }

  finish(command) {
    assertCommandId(command);
    return this.store.transaction('finish', (state, step) => {
      const prior = getOwn(state.commandReceipts, command.commandId);
      if (prior && prior.activeId !== command.activeId) throw new SimulationError('stale-command');
      if (prior) return prior;
      if (own(state.activeReceipts, command.activeId)) {
        const receipt = state.activeReceipts[command.activeId];
        putOwn(state.commandReceipts, command.commandId, receipt);
        step('receipt');
        return receipt;
      }
      requireGeneration(state, command.expectedBindingGeneration);
      assertActive(state, command);
      const entityId = command.entityId ?? this.ids();
      const opId = command.opId ?? this.ids();
      assertFreshEntity(state, entityId);
      const payload = authoredPayload({ id: entityId, startedAt: state.active.startedAt, endedAt: command.endedAt,
        focusDurationMs: command.focusDurationMs ?? state.active.focusDurationMs, description: state.active.description });
      const operation = localOperation(state, { entityId, operation: 'UPSERT', payload, opId }, step);
      const receipt = { activeId: command.activeId, entityId, opId: operation.opId };
      state.activeReceipts[command.activeId] = receipt;
      putOwn(state.commandReceipts, command.commandId, receipt);
      state.active = null;
      step('completion');
      return receipt;
    });
  }

  /** Narrow §13 escape hatch; explicit new local collection, never an implicit binding switch. */
  finishToRecovery(command, { descriptor: recoveryDescriptor, deliberateDestination = false } = {}) {
    assertCommandId(command);
    const validated = validateDescriptor(recoveryDescriptor);
    if (!deliberateDestination) throw new SimulationError('recovery-destination-not-selected');
    return this.store.transaction('recoveryFinish', (state, step) => {
      const commandReceipt = getOwn(state.commandReceipts, command.commandId);
      const prior = commandReceipt ?? getOwn(state.activeReceipts, command.activeId);
      if (prior) {
        if (prior.activeId !== command.activeId || prior.datasetId !== validated.datasetId) throw new SimulationError('stale-command');
        if (!commandReceipt) {
          putOwn(state.commandReceipts, command.commandId, prior);
          step('receipt');
        }
        return prior;
      }
      requireGeneration(state, command.expectedBindingGeneration);
      assertActive(state, command);
      if (state.highWater !== MAX_COUNTER) throw new SimulationError('source-not-exhausted');
      if (validated.datasetId === state.descriptor.datasetId) throw new SimulationError('recovery-must-be-new-collection');
      let collection = state.recoveryCollections[validated.datasetId];
      if (!collection) {
        collection = { descriptor: validated, writerId: state.writerId, highWater: 0, revision: 0,
          operations: {}, entities: {}, tombstones: [], outbox: {}, binding: null };
        state.recoveryCollections[validated.datasetId] = collection;
      }
      if (command.expectedRecoveryRevision !== undefined && command.expectedRecoveryRevision !== collection.revision) {
        throw new SimulationError('stale-recovery-collection');
      }
      const entityId = command.entityId ?? this.ids();
      const opId = command.opId ?? this.ids();
      assertFreshEntity(state, entityId);
      assertFreshEntity(collection, entityId);
      step('collection');
      const payload = authoredPayload({ id: entityId, startedAt: state.active.startedAt, endedAt: command.endedAt,
        focusDurationMs: command.focusDurationMs ?? state.active.focusDurationMs, description: state.active.description });
      const operation = localOperation(collection, { entityId, operation: 'UPSERT', payload, opId }, step);
      const receipt = { activeId: command.activeId, datasetId: validated.datasetId, entityId, opId: operation.opId };
      state.activeReceipts[command.activeId] = receipt;
      putOwn(state.commandReceipts, command.commandId, receipt);
      state.active = null;
      step('completion');
      return receipt;
    });
  }

  recoverySnapshot(datasetId) { return this.snapshot().recoveryCollections[datasetId]; }

  edit(command) {
    const payload = validateSession(command.payload);
    if (payload.id !== command.entityId) throw new SimulationError('malformed', 'Edited entity identity changed');
    return this.store.transaction('edit', (state, step) => {
      requireGeneration(state, command.expectedBindingGeneration);
      const winner = currentWinner(state, command.entityId);
      if (!winner || winner.opId !== command.baseOpId) throw new SimulationError('stale-editor');
      if (payload.description !== winner.payload.description) payload.description = authorDescription(payload.description);
      if (JSON.stringify(winner.payload) === JSON.stringify(payload)) return { changed: false, opId: winner.opId };
      const opId = command.opId ?? this.ids();
      const operation = localOperation(state, { entityId: command.entityId, operation: 'UPSERT', payload, opId }, step);
      return { changed: true, opId: operation.opId };
    });
  }

  delete(command) {
    return this.store.transaction('delete', (state, step) => {
      requireGeneration(state, command.expectedBindingGeneration);
      const winner = currentWinner(state, command.entityId);
      if (!winner) return { changed: false };
      if (winner.opId !== command.baseOpId) throw new SimulationError('stale-editor');
      const opId = command.opId ?? this.ids();
      const operation = localOperation(state, { entityId: command.entityId, operation: 'DELETE', opId }, step);
      return { changed: true, opId: operation.opId };
    });
  }

  reserve(pin, { maxOperations = MAX_OPERATIONS } = {}) {
    if (!Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > MAX_OPERATIONS) throw new SimulationError('invalid-reservation-limit');
    return this.store.transaction('reserve', (state, step) => {
      requirePin(state, pin);
      const eligible = Object.keys(state.outbox).sort().filter(id => state.outbox[id].reservation === null);
      if (!eligible.length) return null;
      const segmentId = assertUuid(this.ids());
      if (own(state.publications, segmentId) || own(state.segments, segmentId)) throw new SimulationError('integrity', 'Segment ID collision');
      const writerId = state.operations[eligible[0]].deviceId;
      const operations = [];
      for (const id of eligible) {
        if (state.operations[id].deviceId !== writerId) continue;
        const candidate = [...operations, state.operations[id]];
        const bytes = encodeUtf8(JSON.stringify({ protocolVersion: 1, datasetId: pin.datasetId, deviceId: writerId, segmentId, operations: candidate }));
        if (bytes.length > MAX_SEGMENT_BYTES || operations.length === maxOperations) break;
        operations.push(state.operations[id]);
      }
      if (!operations.length) throw new SimulationError('oversized-operation');
      const publication = { segmentId, datasetId: pin.datasetId, writerId, binding: clone(pin), operations,
        operationIds: operations.map(op => op.opId), bytes: null, state: 'reserved', attempts: 0 };
      state.publications[segmentId] = publication;
      step('intent');
      for (const id of publication.operationIds) state.outbox[id].reservation = segmentId;
      step('membership');
      return publication;
    });
  }

  seal(pin, segmentId) {
    return this.store.transaction('seal', (state, step) => {
      requirePin(state, pin);
      const publication = state.publications[segmentId];
      if (!publication || !samePin(publication.binding, pin)) throw new SimulationError('stale-publication');
      if (publication.state !== 'reserved') return publication;
      const value = { protocolVersion: 1, datasetId: publication.datasetId, deviceId: publication.writerId,
        segmentId, operations: publication.operations };
      const bytes = encodeUtf8(JSON.stringify(value));
      parseSegment(bytes);
      const accepted = state.segments[segmentId];
      if (accepted && !sameBytes(accepted.bytes, bytes)) {
        throw new SimulationError('integrity', 'Reserved segment identity conflicts with accepted bytes');
      }
      for (const id of publication.operationIds) {
        if (state.outbox[id]?.reservation !== segmentId) throw new SimulationError('integrity', 'Reservation was lost');
      }
      publication.bytes = bytes;
      step('bytes');
      publication.state = 'sealed';
      step('intent');
      return publication;
    });
  }

  publications(pin) {
    const state = this.snapshot();
    requirePin(state, pin);
    return Object.values(state.publications).filter(value => samePin(value.binding, pin) && value.state !== 'acknowledged');
  }

  beginAttempt(pin, segmentId) {
    return this.store.transaction('attempt', (state, step) => {
      requirePin(state, pin);
      const publication = state.publications[segmentId];
      if (!publication || !samePin(publication.binding, pin) || !publication.bytes
        || ['reserved', 'confirmed', 'acknowledged'].includes(publication.state)) throw new SimulationError('invalid-publication-state');
      publication.state = 'in-flight';
      publication.attempts += 1;
      step('intent');
      return publication;
    });
  }

  unknown(pin, segmentId) {
    return this.store.transaction('unknown', (state, step) => {
      requirePin(state, pin);
      const publication = state.publications[segmentId];
      if (!publication || !samePin(publication.binding, pin)) throw new SimulationError('stale-publication');
      if (!['confirmed', 'acknowledged'].includes(publication.state)) publication.state = 'unknown';
      step('intent');
    });
  }

  confirm(pin, segmentId, confirmation) {
    return this.store.transaction('confirm', (state, step) => {
      requirePin(state, pin);
      const publication = state.publications[segmentId];
      if (!publication || !samePin(publication.binding, pin)) throw new SimulationError('stale-publication');
      if (!['confirmed', 'already-present'].includes(confirmation?.outcome)) throw new SimulationError('unconfirmed-publication');
      if (publication.state === 'reserved') throw new SimulationError('invalid-publication-state');
      if (confirmation.segmentId !== segmentId || !(confirmation.bytes instanceof Uint8Array)
        || !sameBytes(publication.bytes, confirmation.bytes)) throw new SimulationError('integrity', 'Confirmation did not identify the exact sealed publication');
      const references = confirmation.references ?? [];
      if (!Array.isArray(references) || references.some(reference => typeof reference !== 'string' || !reference)) {
        throw new SimulationError('integrity', 'Confirmation contained invalid physical references');
      }
      const retained = state.segments[segmentId];
      if (retained && !sameBytes(retained.bytes, publication.bytes)) throw new SimulationError('integrity', 'Confirmed segment conflicts with accepted bytes');
      const pass = discovery(state);
      for (const reference of references) {
        const artifact = getOwn(pass.artifacts, reference) ?? { reference, originalBytes: null, segmentId: null };
        if ((artifact.originalBytes && !sameBytes(artifact.originalBytes, publication.bytes))
          || (artifact.segmentId && artifact.segmentId !== segmentId)) {
          throw new SimulationError('integrity', 'Confirmed physical reference conflicts with known content');
        }
        artifact.originalBytes = publication.bytes;
        artifact.segmentId = segmentId;
        artifact.state = 'applied';
        artifact.error = null;
        artifact.verifiedPass = pass.passId;
        putOwn(pass.artifacts, reference, artifact);
      }
      publication.remoteReferences = [...new Set([...(publication.remoteReferences ?? []), ...references])];
      if (publication.remoteReferences.length) state.segments[segmentId] = { bytes: publication.bytes, operationIds: publication.operationIds };
      step('coverage');
      if (publication.state !== 'acknowledged') publication.state = 'confirmed';
      step('intent');
    });
  }

  acknowledge(pin, segmentId) {
    return this.store.transaction('ack', (state, step) => {
      requirePin(state, pin);
      const publication = state.publications[segmentId];
      if (!publication || !samePin(publication.binding, pin)) throw new SimulationError('stale-publication');
      if (publication.state === 'acknowledged') return;
      if (publication.state !== 'confirmed') throw new SimulationError('unconfirmed-publication');
      for (let index = 0; index < publication.operationIds.length; index += 1) {
        const id = publication.operationIds[index];
        if (state.outbox[id]?.reservation !== segmentId || !operationEqual(state.operations[id], publication.operations[index])) {
          throw new SimulationError('integrity', 'Acknowledgement membership mismatch');
        }
        delete state.outbox[id];
      }
      step('membership');
      publication.state = 'acknowledged';
      step('intent');
    });
  }

  verifyDescriptor(pin, value) {
    const validated = validateDescriptor(value);
    return this.store.transaction('descriptor', (state, step) => {
      requirePin(state, pin);
      if (JSON.stringify(validated) !== JSON.stringify(state.descriptor)) throw new SimulationError('integrity', 'Bound descriptor changed');
      step('verified');
    });
  }

  beginPass(pin) {
    return this.store.transaction('pass', (state, step) => {
      requirePin(state, pin);
      const pass = discovery(state);
      if (pass.passId === 0 || pass.enumerationComplete) {
        pass.passId += 1;
        pass.checkpoint = null;
        pass.seen = [];
        pass.enumerationComplete = false;
        pass.reconciled = false;
      }
      pass.inProgress = true;
      pass.error = null;
      step('start');
      return pass;
    });
  }

  restartEnumeration(pin) {
    return this.store.transaction('restartScan', (state, step) => {
      requirePin(state, pin);
      const pass = discovery(state);
      pass.checkpoint = null;
      pass.seen = [];
      pass.enumerationComplete = false;
      pass.reconciled = false;
      step('checkpoint');
    });
  }

  recordPage(pin, passId, page) {
    if (!page || !Array.isArray(page.references) || typeof page.complete !== 'boolean'
      || (!page.complete && page.continuation == null)) throw new SimulationError('invalid-enumeration');
    return this.store.transaction('discover', (state, step) => {
      requirePin(state, pin);
      const pass = discovery(state);
      if (pass.passId !== passId || pass.enumerationComplete) throw new SimulationError('stale-pass');
      for (const reference of page.references) {
        if (typeof reference !== 'string' || !reference) throw new SimulationError('invalid-reference');
        if (!pass.seen.includes(reference)) pass.seen.push(reference);
        const artifact = getOwn(pass.artifacts, reference) ?? { reference, originalBytes: null, segmentId: null };
        artifact.state = 'pending';
        artifact.error = null;
        putOwn(pass.artifacts, reference, artifact);
      }
      step('pending');
      pass.checkpoint = page.continuation;
      pass.enumerationComplete = page.complete;
      step('checkpoint');
      return pass;
    });
  }

  pendingReferences(pin) {
    const state = this.snapshot();
    requirePin(state, pin);
    return Object.values(discovery(state).artifacts).filter(value => value.state === 'pending').map(value => value.reference);
  }

  omittedReferences(pin) {
    const state = this.snapshot();
    requirePin(state, pin);
    const pass = discovery(state);
    return Object.keys(pass.artifacts).filter(reference => !pass.seen.includes(reference));
  }

  receive(pin, reference, inputBytes) {
    const before = this.snapshot();
    requirePin(before, pin);
    if (!(inputBytes instanceof Uint8Array)) throw new SimulationError('malformed', 'Expected artifact bytes');
    const knownArtifact = getOwn(discovery(before).artifacts, reference);
    if (knownArtifact?.originalBytes && !sameBytes(knownArtifact.originalBytes, inputBytes)) {
      throw new SimulationError('integrity', 'Known physical artifact changed');
    }
    if (inputBytes.length > MAX_SEGMENT_BYTES) {
      throw new SimulationError('malformed', 'Expected bounded artifact bytes');
    }
    const bytes = Uint8Array.from(inputBytes);
    const segment = parseSegment(bytes); // No effects before whole bounded wire validation.
    return this.store.transaction('receive', (state, step) => {
      requirePin(state, pin);
      if (segment.datasetId !== pin.datasetId) throw new SimulationError('malformed', 'Segment belongs to another dataset');
      const pass = discovery(state);
      const artifact = getOwn(pass.artifacts, reference) ?? { reference, originalBytes: null, segmentId: null };
      if (artifact.originalBytes && !sameBytes(artifact.originalBytes, bytes)) throw new SimulationError('integrity', 'Known physical artifact changed');
      const priorSegment = state.segments[segment.segmentId];
      const sealed = state.publications[segment.segmentId];
      if ((priorSegment && !sameBytes(priorSegment.bytes, bytes)) || (sealed?.bytes && !sameBytes(sealed.bytes, bytes))) {
        throw new SimulationError('integrity', 'Same segmentId has different sealed bytes');
      }
      for (const operation of segment.operations) {
        const previous = state.operations[operation.opId];
        if (previous && !operationEqual(previous, operation)) throw new SimulationError('integrity', 'Same opId has different semantic values');
      }
      step('identities');
      for (const operation of segment.operations) state.operations[operation.opId] = operation;
      step('operations');
      projection(state, step);
      state.segments[segment.segmentId] = { bytes, operationIds: segment.operations.map(operation => operation.opId) };
      state.revision += 1;
      step('dedup');
      artifact.originalBytes = bytes;
      artifact.segmentId = segment.segmentId;
      artifact.state = 'applied';
      artifact.error = null;
      artifact.verifiedPass = pass.passId;
      putOwn(pass.artifacts, reference, artifact);
      if (sealed?.bytes) sealed.remoteReferences = [...new Set([...(sealed.remoteReferences ?? []), reference])];
      step('applied');
      return { segmentId: segment.segmentId, operationIds: segment.operations.map(operation => operation.opId) };
    });
  }

  artifactFailure(pin, reference, error, inputBytes) {
    return this.store.transaction('quarantine', (state, step) => {
      requirePin(state, pin, true);
      const pass = discovery(state);
      const artifact = getOwn(pass.artifacts, reference) ?? { reference, originalBytes: null, segmentId: null };
      artifact.state = 'quarantined';
      artifact.error = error.classification ?? error.code ?? 'malformed';
      if (inputBytes instanceof Uint8Array) {
        artifact.rejectedBytes = inputBytes.slice(0, MAX_SEGMENT_BYTES);
        artifact.rejectedByteLength = inputBytes.length;
      }
      putOwn(pass.artifacts, reference, artifact);
      state.blocked = { classification: artifact.error, reason: error.message, reference };
      pass.inProgress = false;
      pass.reconciled = false;
      step('evidence');
    });
  }

  runFailure(pin, error) {
    return this.store.transaction('runFailure', (state, step) => {
      requirePin(state, pin, true);
      const pass = discovery(state);
      pass.error = error.code ?? error.classification ?? 'retryable';
      pass.inProgress = false;
      pass.reconciled = false;
      if (['missing-dataset', 'missing-object', 'access', 'integrity', 'malformed', 'unsupported'].includes(pass.error)) {
        state.blocked = { classification: pass.error, reason: error.message };
      }
      step('error');
    });
  }

  completePass(pin) {
    return this.store.transaction('complete', (state, step) => {
      requirePin(state, pin);
      const pass = discovery(state);
      const unresolved = Object.values(pass.artifacts).some(value => value.state !== 'applied' || value.verifiedPass !== pass.passId);
      const pendingPublication = Object.values(state.publications).some(value => value.state !== 'acknowledged') || publicationCoveragePending(state);
      pass.inProgress = false;
      pass.reconciled = pass.enumerationComplete && !unresolved && !Object.keys(state.outbox).length && !pendingPublication;
      if (pass.reconciled) pass.lastSuccess = pass.passId;
      step('status');
      return pass.reconciled;
    });
  }

  status() {
    const state = this.snapshot();
    if (state.highWater === MAX_COUNTER) return 'Recovery required';
    if (!state.binding) return 'Local only';
    if (state.blocked) return state.blocked.classification === 'unsupported' ? 'Unsupported data / Upgrade required' : 'Recovery required';
    const pass = discovery(state);
    if (pass.inProgress) return 'Syncing';
    if (pass.error === 'authorization') return 'Authorization required';
    if (pass.error) return 'Offline / Retry pending';
    if (Object.keys(state.outbox).length || Object.values(state.publications).some(value => value.state !== 'acknowledged')
      || publicationCoveragePending(state)) return 'Changes saved locally / Pending';
    if (pass.reconciled && pass.enumerationComplete
      && Object.values(pass.artifacts).every(value => value.state === 'applied' && value.verifiedPass === pass.passId)) return 'Synced';
    return 'Offline / Retry pending';
  }
}

export { sameBytes, samePin };
