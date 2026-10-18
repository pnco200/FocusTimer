import type { Binding } from './remote-repository';

export type TransportFailure = 'retryable' | 'unknown' | 'authorization' | 'access'
  | 'missing-dataset' | 'missing-object' | 'invalid-cursor' | 'malformed' | 'unsupported' | 'integrity';

/** Diagnosed provider/data failures only; messages must exclude credentials and history. */
export class TransportError extends Error {
  readonly classification?: 'malformed' | 'unsupported' | 'integrity';
  readonly byteLength?: number;
  constructor(readonly code: TransportFailure, message: string = code, evidence: { byteLength?: number } = {}) {
    super(message);
    this.name = 'TransportError';
    if (code === 'malformed' || code === 'unsupported' || code === 'integrity') this.classification = code;
    this.byteLength = evidence.byteLength;
  }
}

export interface RequestOptions { signal?: AbortSignal }
export interface ReadOptions extends RequestOptions { maxBytes: number }
export interface EnumerationPage { references: string[]; continuation: unknown; complete: boolean }
export interface PublicationRequest { segmentId: string; bytes: Uint8Array; retryHandle: string }
export interface PublicationConfirmation {
  outcome: 'confirmed' | 'already-present'; segmentId: string; bytes: Uint8Array; references?: string[];
}

/**
 * An already selected, bootstrapped binding. Candidate discovery/creation and account
 * authorization are separate explicit workflows, not automatic repairs by a sync pass.
 * Locators, continuation and retry handles are opaque local adapter metadata.
 *
 * No unique names, ordered/snapshot lists, immediate visibility, exactly-once creates,
 * multi-object atomicity or unchanged-content indicators are assumed. Later full passes
 * discover delayed/concurrent content. Every request must use the supplied account/target.
 * Returned bytes are owned by the caller. Adapters must bound transfer/allocation, not
 * download arbitrarily large content and truncate it. A byteLength error can report an
 * oversized object without returning its body. Descriptor transfer must be complete;
 * incomplete descriptor transfers throw retryable, not malformed.
 */
export interface SyncTransport {
  readDescriptor(pin: Binding, options: ReadOptions): Promise<Uint8Array>;
  enumerate(pin: Binding, continuation: unknown, options: RequestOptions): Promise<EnumerationPage>;
  read(pin: Binding, reference: string, options: ReadOptions): Promise<{ bytes: Uint8Array; complete: boolean }>;
  /** Allocate/derive a creation identity only. MUST NOT publish any content. Unused handles are harmless. */
  preparePublication(pin: Binding, publication: { segmentId: string }, options: RequestOptions): Promise<string>;
  /**
   * Use the durably retained handle, segment ID and exact bytes on every attempt.
   * Success/duplicate/conflict HTTP responses alone are insufficient: return affirmative
   * exact-content read-back (or equivalent proven byte verification), otherwise throw
   * unknown/retryable/integrity. references, when supplied, identify verified bytes.
   * Reference-free confirmation retains an unresolved discovery coverage obligation.
   */
  publish(pin: Binding, publication: PublicationRequest, options: RequestOptions): Promise<PublicationConfirmation>;
}
