import {
  MAX_COUNTER, MAX_OPERATIONS, MAX_SEGMENT_BYTES, encodeUtf8,
  parseSegment, validateDescriptor,
} from '../protocol/index.js';

/** Pure remote lifecycle decisions; callers own durable checks and atomic effects. */
export class RemoteError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'RemoteError';
    this.code = code;
    this.classification = ['malformed', 'unsupported', 'integrity'].includes(code) ? code : undefined;
  }
}

export const sameBytes = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);
export const sameDestination = (a, b) => a && b && a.account === b.account
  && a.locator === b.locator && a.datasetId === b.datasetId && a.provider === b.provider;
export const samePin = (a, b) => sameDestination(a, b) && a.generation === b.generation;
const values = collection => collection instanceof Map ? [...collection.values()] : Object.values(collection);

/** Eligible operations must already be checked against outbox rows and sorted by opId. */
export function makeReservation(pin, segmentId, eligibleOps, maxOperations = MAX_OPERATIONS) {
  if (!Number.isSafeInteger(maxOperations) || maxOperations < 1 || maxOperations > MAX_OPERATIONS) {
    throw new RemoteError('invalid-reservation-limit');
  }
  if (!eligibleOps.length) return null;
  validateDescriptor({ application: 'focus-timer', protocolVersion: 1, datasetId: segmentId });
  const writerId = eligibleOps[0].deviceId;
  const operations = [];
  for (const operation of eligibleOps) {
    if (operation.deviceId !== writerId) continue;
    const bytes = encodeUtf8(JSON.stringify({ protocolVersion: 1, datasetId: pin.datasetId,
      deviceId: writerId, segmentId, operations: [...operations, operation] }));
    if (bytes.length > MAX_SEGMENT_BYTES || operations.length === maxOperations) break;
    operations.push(operation);
  }
  if (!operations.length) throw new RemoteError('oversized-operation');
  return { segmentId, datasetId: pin.datasetId, writerId, binding: structuredClone(pin), operations,
    operationIds: operations.map(operation => operation.opId), bytes: null, state: 'reserved', attempts: 0 };
}

/** The repository must recheck accepted bytes and reservation membership before committing. */
export function sealedBytes(publication) {
  const bytes = encodeUtf8(JSON.stringify({ protocolVersion: 1, datasetId: publication.datasetId,
    deviceId: publication.writerId, segmentId: publication.segmentId, operations: publication.operations }));
  parseSegment(bytes);
  return bytes;
}

/** Return verified physical obligations; never treat a reference-free confirmation as coverage. */
export function validateConfirmation(publication, confirmation, retained) {
  if (!['confirmed', 'already-present'].includes(confirmation?.outcome)) throw new RemoteError('unconfirmed-publication');
  if (publication.state === 'reserved') throw new RemoteError('invalid-publication-state');
  if (confirmation.segmentId !== publication.segmentId || !(confirmation.bytes instanceof Uint8Array)
    || !sameBytes(publication.bytes, confirmation.bytes)) {
    throw new RemoteError('integrity', 'Confirmation did not identify the exact sealed publication');
  }
  const references = confirmation.references ?? [];
  if (!Array.isArray(references) || references.some(reference => typeof reference !== 'string' || !reference)) {
    throw new RemoteError('integrity', 'Confirmation contained invalid physical references');
  }
  if (retained && !sameBytes(retained.bytes, publication.bytes)) {
    throw new RemoteError('integrity', 'Confirmed segment conflicts with accepted bytes');
  }
  return references;
}

export function coveragePending(publications, artifacts) {
  const references = new Map(values(artifacts).map(artifact => [artifact.reference, artifact]));
  return values(publications).some(publication => publication.state === 'acknowledged'
    && (!publication.remoteReferences?.length || publication.remoteReferences.some(reference =>
      references.get(reference)?.segmentId !== publication.segmentId)));
}

export function remoteStatus({ highWater, binding, blocked, pass, outbox, publications }) {
  if (highWater === MAX_COUNTER) return 'Recovery required';
  if (!binding) return 'Local only';
  if (blocked) return blocked.classification === 'unsupported' ? 'Unsupported data / Upgrade required' : 'Recovery required';
  if (pass.inProgress) return 'Syncing';
  if (pass.error === 'authorization') return 'Authorization required';
  if (pass.error) return 'Offline / Retry pending';
  if (values(outbox).length || values(publications).some(value => value.state !== 'acknowledged')
    || coveragePending(publications, pass.artifacts)) return 'Changes saved locally / Pending';
  if (pass.reconciled && pass.enumerationComplete
    && values(pass.artifacts).every(value => value.state === 'applied' && value.verifiedPass === pass.passId)) return 'Synced';
  return 'Offline / Retry pending';
}

/** A normalized summary lets native stores share binding rules without loading a model graph. */
export function validateBindingTarget({ generation, active, datasetId, pendingPublications, established, retainedCorpus },
  { account, locator, descriptor, expectedGeneration, resumePublications = false, provider }) {
  const validated = validateDescriptor(descriptor);
  if (typeof account !== 'string' || !account || typeof locator !== 'string' || !locator) throw new RemoteError('invalid-binding');
  if (expectedGeneration !== generation) throw new RemoteError('stale-binding');
  if (active) throw new RemoteError('active-not-idle');
  if (validated.datasetId !== datasetId) throw new RemoteError('dataset-mismatch');
  const target = { account, locator, datasetId: validated.datasetId, ...(provider === undefined ? {} : { provider }) };
  if (pendingPublications.length && (!resumePublications || pendingPublications.some(publication =>
    !sameDestination(publication.binding, target)))) {
    throw new RemoteError('pending-publication-rebind-required', 'Explicitly resume the original target or resolve retained publication intents before rebinding');
  }
  if (established && retainedCorpus && !sameDestination(established, target)) {
    throw new RemoteError('destination-transfer-required', 'Retained dataset history requires a deliberate complete-corpus transfer before changing destination');
  }
  return validated;
}
