import { validateDescription, validateInteger, validateSession, validateTimestamp, validateUuid, MAX_DURATION_MS } from '../protocol/index.js';

export interface Session {
  id: string;
  startedAt: string;
  endedAt: string;
  focusDurationMs: number;
  description: string;
}

/** Local editor authoring only; wire validation continues to permit clock corrections. */
export function prepareSessionEdit(base: Session, description: string, adjustmentMinutes: string): Session {
  const session = validateSession(base) as Session;
  if (session.endedAt < session.startedAt) throw new LocalError('edit-dates', 'This session finishes before it starts. Its timestamps are preserved, so editing is unavailable.');
  if (!/^[+-]?[0-9]+$/.test(adjustmentMinutes) || !Number.isSafeInteger(Number(adjustmentMinutes))) {
    throw new LocalError('edit-minutes', 'Enter a whole number of minutes, such as +5, -3, or 0.');
  }
  const duration = BigInt(session.focusDurationMs) + BigInt(Number(adjustmentMinutes)) * 60_000n;
  if (duration <= 0n) throw new LocalError('edit-positive', 'The resulting duration must be greater than zero.');
  if (duration > BigInt(MAX_DURATION_MS)) throw new LocalError('edit-limit', 'The resulting duration exceeds the supported limit.');
  try { validateDescription(description); }
  catch (error) {
    const failure = new LocalError('edit-description', 'Invalid description or description scalar limit exceeded.');
    failure.cause = error;
    throw failure;
  }
  return { ...session, description, focusDurationMs: Number(duration) };
}
export interface Operation {
  protocolVersion: 1; schemaVersion: 1; opId: string; datasetId: string; deviceId: string;
  entityType: 'focusSession'; entityId: string; operation: 'UPSERT' | 'DELETE'; lamportCounter: number;
  payload?: Session;
}
export interface Descriptor { application: 'focus-timer'; protocolVersion: 1; datasetId: string }
export interface Collection { descriptor: Descriptor; highWater: number }
export interface Installation { version: 1; writerId: string; selectedDatasetId: string }
export interface Owner { token: string; generation: number }
export interface Active {
  id: string | null; revision: number; datasetId: string;
  startedAt: string | null; description: string; focusMs: number;
  state: 'idle' | 'running' | 'paused'; owner: Owner | null;
}
export interface HistoryEntry { datasetId: string; id: string; winner: Operation }
export interface LocalView { installation: Installation; collection: Collection; active: Active; history: HistoryEntry[] }
export interface ActivePin { id: string | null; revision: number; datasetId: string; owner: Owner }

export class LocalError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'LocalError'; }
}
export function emptyActive(datasetId: string, revision = 0, owner: Owner | null = null, description = ''): Active {
  return { id: null, revision, datasetId, startedAt: null, description, focusMs: 0, state: 'idle', owner };
}
export function validateActive(value: Active): Active {
  if (!value || !['idle', 'running', 'paused'].includes(value.state)) throw new Error('Invalid active state');
  validateUuid(value.datasetId);
  validateInteger(value.revision, 0, Number.MAX_SAFE_INTEGER);
  validateDescription(value.description);
  if (!Number.isFinite(value.focusMs) || value.focusMs < 0 || value.focusMs > MAX_DURATION_MS) throw new Error('Invalid active focus');
  if (value.owner) { validateUuid(value.owner.token); validateInteger(value.owner.generation, 1, Number.MAX_SAFE_INTEGER); }
  if (value.state === 'idle') {
    if (value.id !== null || value.startedAt !== null || value.focusMs !== 0) throw new Error('Invalid idle state');
  } else {
    validateUuid(value.id); validateTimestamp(value.startedAt);
    if (!value.owner) throw new Error('Missing active owner metadata.');
  }
  return value;
}
export function pin(active: Active): ActivePin {
  if (!active.owner) throw new LocalError('stale-owner', 'This tab does not own the timer.');
  return { id: active.id, revision: active.revision, datasetId: active.datasetId, owner: active.owner };
}

export function historyOrder(a: Session, b: Session): number {
  return a.endedAt === b.endedAt ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.endedAt > b.endedAt ? -1 : 1;
}
