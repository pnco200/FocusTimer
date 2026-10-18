import {
  authorDescription, compareVersions, nextCounter, reduceOperations,
  validateOperation, validateSession,
} from '../protocol/index.js';

// Pure local decisions shared by the deterministic repository and native stores.
// The caller must check durable identity/base/ownership and commit all effects.
export function authoredSession(value) {
  const payload = validateSession(value);
  payload.description = authorDescription(payload.description);
  return payload;
}

export function editedSession(current, candidate) {
  const payload = validateSession(candidate);
  if (payload.description !== current.description) payload.description = authorDescription(payload.description);
  return { payload, changed: JSON.stringify(validateSession(current)) !== JSON.stringify(payload) };
}

export function localOperation({ descriptor, writerId, highWater, entityId, operation, payload, opId }) {
  return validateOperation({
    protocolVersion: 1, schemaVersion: 1, datasetId: descriptor.datasetId,
    deviceId: writerId, opId, entityType: 'focusSession', entityId, operation,
    lamportCounter: nextCounter(highWater), ...(operation === 'UPSERT' ? { payload } : {}),
  });
}

/** Terminal DELETE and winner metadata come from the same validated operation set. */
export function materializeOperations(operations, initialHighWater = 0) {
  const reduced = reduceOperations(operations, initialHighWater);
  const deleted = new Set(reduced.tombstones);
  const winners = new Map();
  for (const candidate of operations) {
    const op = validateOperation(candidate);
    if (deleted.has(op.entityId) !== (op.operation === 'DELETE')) continue;
    const previous = winners.get(op.entityId);
    if (!previous || compareVersions(op, previous) > 0) winners.set(op.entityId, op);
  }
  return { ...reduced, winners };
}
