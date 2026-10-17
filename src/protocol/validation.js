import { MAX_COUNTER, MAX_DESCRIPTION_SCALARS, MAX_DURATION_MS, MAX_OPERATIONS, MAX_SEGMENT_BYTES } from './constants.js';
import { malformed, unsupported } from './errors.js';
import { parseWireJson } from './json.js';
import { scalarCount } from './utf8.js';

export function validateUuid(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[47][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    malformed('Expected canonical RFC variant UUIDv4/v7');
  }
  return value;
}

export function compareUuid(a, b) {
  validateUuid(a);
  validateUuid(b);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function uuidBytes(value) {
  validateUuid(value);
  const compact = value.replaceAll('-', '');
  return Uint8Array.from({ length: 16 }, (_, i) => Number.parseInt(compact.slice(i * 2, i * 2 + 2), 16));
}

export function validateTimestamp(value) {
  if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(value)) {
    malformed('Expected strict UTC millisecond timestamp');
  }
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  const hour = Number(value.slice(11, 13));
  const minute = Number(value.slice(14, 16));
  const second = Number(value.slice(17, 19));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || hour > 23 || minute > 59 || second > 59) {
    malformed('Invalid Gregorian timestamp');
  }
  return value;
}

export function validateInteger(value, minimum, maximum) {
  if (!Number.isSafeInteger(value) || Object.is(value, -0) || value < minimum || value > maximum) {
    malformed('Integer outside permitted range');
  }
  return value;
}

function shape(value, fields) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) malformed('Expected JSON object');
  for (const name of fields) {
    if (!Object.hasOwn(value, name)) malformed(`Missing required field ${name}`);
  }
  for (const name of Reflect.ownKeys(value)) {
    if (!fields.includes(name)) unsupported('Unknown field');
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) malformed('Expected JSON data property');
  }
}

function version(value, name) {
  validateInteger(value, 0, MAX_COUNTER);
  if (value !== 1) unsupported(`Unsupported ${name}`);
  return value;
}

function selector(value, supported, name) {
  if (typeof value !== 'string') malformed(`Expected string ${name}`);
  scalarCount(value);
  if (!supported.includes(value)) unsupported(`Unsupported ${name}`);
  return value;
}

export function validateDescription(value) {
  if (scalarCount(value) > MAX_DESCRIPTION_SCALARS) malformed('Description scalar limit exceeded');
  return value;
}

/** Authoring only; ingestion never trims or normalizes. Check the input bound first. */
export function authorDescription(value) {
  validateDescription(value);
  const trimmed = value.replace(/^[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/gu, '');
  return trimmed || 'Untitled session.';
}

export function validateSession(value) {
  shape(value, ['id', 'startedAt', 'endedAt', 'focusDurationMs', 'description']);
  return {
    id: validateUuid(value.id),
    startedAt: validateTimestamp(value.startedAt),
    endedAt: validateTimestamp(value.endedAt),
    focusDurationMs: validateInteger(value.focusDurationMs, 1, MAX_DURATION_MS),
    description: validateDescription(value.description),
  };
}

export function validateDescriptor(value) {
  shape(value, ['application', 'protocolVersion', 'datasetId']);
  if (value.application !== 'focus-timer') malformed('Invalid descriptor application');
  return { application: 'focus-timer', protocolVersion: version(value.protocolVersion, 'protocolVersion'), datasetId: validateUuid(value.datasetId) };
}

export function validateOperation(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) malformed('Expected operation object');
  // Select the closed branch before deciding whether payload is required/forbidden.
  const operation = selector(value.operation, ['UPSERT', 'DELETE'], 'operation');
  const fields = ['protocolVersion', 'schemaVersion', 'opId', 'datasetId', 'deviceId', 'entityType', 'entityId', 'operation', 'lamportCounter'];
  if (operation === 'UPSERT') fields.push('payload');
  // A payload on DELETE is an explicitly forbidden known member, hence malformed.
  if (operation === 'DELETE' && Object.hasOwn(value, 'payload')) malformed('DELETE payload must be absent');
  shape(value, fields);
  const result = {
    protocolVersion: version(value.protocolVersion, 'protocolVersion'),
    schemaVersion: version(value.schemaVersion, 'schemaVersion'),
    opId: validateUuid(value.opId),
    datasetId: validateUuid(value.datasetId),
    deviceId: validateUuid(value.deviceId),
    entityType: selector(value.entityType, ['focusSession'], 'entityType'),
    entityId: validateUuid(value.entityId),
    operation,
    lamportCounter: validateInteger(value.lamportCounter, 1, MAX_COUNTER),
  };
  if (operation === 'UPSERT') {
    result.payload = validateSession(value.payload);
    if (result.payload.id !== result.entityId) malformed('Operation/payload identity mismatch');
  }
  return result;
}

export function validateSegment(value) {
  shape(value, ['protocolVersion', 'datasetId', 'deviceId', 'segmentId', 'operations']);
  const result = {
    protocolVersion: version(value.protocolVersion, 'protocolVersion'),
    datasetId: validateUuid(value.datasetId),
    deviceId: validateUuid(value.deviceId),
    segmentId: validateUuid(value.segmentId),
    operations: [],
  };
  if (!Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > MAX_OPERATIONS) malformed('Invalid segment operation count');
  const ids = new Set();
  for (const item of value.operations) {
    const operation = validateOperation(item);
    if (operation.protocolVersion !== result.protocolVersion || operation.datasetId !== result.datasetId || operation.deviceId !== result.deviceId) {
      malformed('Segment/operation identity mismatch');
    }
    if (ids.has(operation.opId)) malformed('Repeated opId within segment');
    ids.add(operation.opId);
    result.operations.push(operation);
  }
  return result;
}

// Unlike standalone resource policy, descriptor/segment byte limits are wire rules.
function parseBoundedArtifact(bytes) {
  if (!(bytes instanceof Uint8Array)) malformed('Wire input must be UTF-8 bytes');
  if (bytes.length > MAX_SEGMENT_BYTES) malformed('Artifact byte limit exceeded');
  return parseWireJson(bytes, { maxBytes: MAX_SEGMENT_BYTES });
}

export const parseSession = (bytes, { maxBytes } = {}) => validateSession(parseWireJson(bytes, { maxBytes }));
export const parseDescriptor = bytes => validateDescriptor(parseBoundedArtifact(bytes));
export const parseOperation = (bytes, { maxBytes } = {}) => validateOperation(parseWireJson(bytes, { maxBytes }));
export const parseSegment = bytes => validateSegment(parseBoundedArtifact(bytes));
