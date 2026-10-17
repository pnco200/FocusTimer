import { MAX_COUNTER } from './constants.js';
import { integrity, malformed } from './errors.js';
import { compareUuid, validateInteger, validateOperation } from './validation.js';

export function compareVersions(a, b) {
  validateInteger(a.lamportCounter, 1, MAX_COUNTER);
  validateInteger(b.lamportCounter, 1, MAX_COUNTER);
  return a.lamportCounter < b.lamportCounter ? -1 : a.lamportCounter > b.lamportCounter ? 1 : compareUuid(a.opId, b.opId);
}

/** All defined members participate. Validation gives a fixed member order. */
export function operationEqual(a, b) {
  return JSON.stringify(validateOperation(a)) === JSON.stringify(validateOperation(b));
}

export function incorporateHighWater(current, remoteCounter) {
  validateInteger(current, 0, MAX_COUNTER);
  validateInteger(remoteCounter, 1, MAX_COUNTER);
  return Math.max(current, remoteCounter);
}

export class CounterExhaustedError extends Error {
  constructor() { super('Dataset Lamport counter exhausted; recovery destination required'); this.name = 'CounterExhaustedError'; this.code = 'counter-exhausted'; }
}

export function nextCounter(current) {
  validateInteger(current, 0, MAX_COUNTER);
  if (current === MAX_COUNTER) throw new CounterExhaustedError();
  return current + 1;
}

/** One dataset at a time. Pure, order-independent set reduction; no input references escape. */
export function reduceOperations(operations, initialHighWater = 0) {
  let highWater = validateInteger(initialHighWater, 0, MAX_COUNTER);
  let datasetId;
  const immutable = new Map();
  const winners = new Map();
  const deletes = new Map();
  for (const candidate of operations) {
    const operation = validateOperation(candidate);
    if (datasetId !== undefined && datasetId !== operation.datasetId) malformed('Reduce one dataset at a time');
    datasetId = operation.datasetId;
    const existing = immutable.get(operation.opId);
    if (existing) {
      if (!operationEqual(existing, operation)) integrity('Conflicting immutable operation identity');
      continue;
    }
    immutable.set(operation.opId, operation);
    highWater = incorporateHighWater(highWater, operation.lamportCounter);
    const target = operation.operation === 'DELETE' ? deletes : winners;
    const previous = target.get(operation.entityId);
    if (!previous || compareVersions(operation, previous) > 0) target.set(operation.entityId, operation);
  }
  const entities = [...winners.keys()].filter(id => !deletes.has(id)).sort().map(id => winners.get(id).payload);
  return { entities, tombstones: [...deletes.keys()].sort(), highWater };
}
