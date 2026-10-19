import { MAX_SEGMENT_BYTES, parseSegment } from '../protocol/index.js';
import type { Binding } from './remote-repository';
import { TransportError, type EnumerationPage, type PublicationConfirmation, type PublicationRequest,
  type ReadOptions, type RequestOptions, type SyncTransport } from './sync-transport';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const DRIVE_MARKER = 'focus-timer-drive-proof-v1';
export const DRIVE_FOLDER_MIME = 'application/vnd.google-apps.folder';
const JSON_LIMIT = 262_144;
const ERROR_LIMIT = 16_384;
const FIELDS = 'id,mimeType,parents,trashed,size,properties';
type Kind = 'root' | 'segments' | 'descriptor' | 'segment';
type Context = 'root' | 'object' | 'continuation' | 'publication' | 'request';
export interface DriveCredentials { accessToken: string; assertCurrent: () => void }
export interface DriveMetadata {
  id: string; mimeType: string; parents?: string[]; trashed?: boolean; size?: string;
  properties?: Record<string, string>;
}
export interface DriveLocator { rootId: string; descriptorId: string; segmentsId: string }
export interface DrivePage { files: DriveMetadata[]; continuation: string | null; complete: boolean; incompleteSearch: boolean }
export interface DriveClientOptions {
  fetcher?: typeof fetch; maxRetries?: number; random?: () => number;
  wait?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}
const interrupted = () => new TransportError('retryable', 'Drive request interrupted');
const checkSignal = (signal?: AbortSignal) => { if (signal?.aborted) throw interrupted(); };
const fail = (code: ConstructorParameters<typeof TransportError>[0]) => new TransportError(code);
export function checkedDriveId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(value)) throw fail('integrity');
  return value;
}
export function driveProperties(kind: Kind, datasetId: string) { return { proof: DRIVE_MARKER, kind, datasetId }; }
export function driveRootQuery() {
  return `trashed = false and properties has { key='proof' and value='${DRIVE_MARKER}' } and properties has { key='kind' and value='root' }`;
}
export function driveChildrenQuery(parent: string) { return `'${checkedDriveId(parent)}' in parents and trashed = false`; }
export function encodeDriveLocator(locator: DriveLocator): string {
  if (new Set([locator.rootId, locator.descriptorId, locator.segmentsId]).size !== 3) throw fail('integrity');
  return JSON.stringify({ v: 1, rootId: checkedDriveId(locator.rootId),
    descriptorId: checkedDriveId(locator.descriptorId), segmentsId: checkedDriveId(locator.segmentsId) });
}
export function decodeDriveLocator(text: string): DriveLocator {
  try {
    if (typeof text !== 'string' || text.length > 1024) throw fail('integrity');
    const value = JSON.parse(text);
    if (value.v !== 1 || Object.keys(value).length !== 4) throw fail('integrity');
    const result = { rootId: checkedDriveId(value.rootId), descriptorId: checkedDriveId(value.descriptorId),
      segmentsId: checkedDriveId(value.segmentsId) };
    if (new Set(Object.values(result)).size !== 3) throw fail('integrity');
    return result;
  } catch { throw new TransportError('integrity', 'Invalid Drive binding locator'); }
}

/** Bounded decoded-body consumption; header/metadata sizes never replace the stream cap. */
export async function boundedDriveBody(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_SEGMENT_BYTES) throw new RangeError('Invalid Drive byte limit');
  if (signal?.aborted) { await response.body?.cancel().catch(() => {}); throw interrupted(); }
  const declared = response.headers.get('content-length');
  if (declared !== null && !/^(0|[1-9][0-9]*)$/.test(declared)) {
    await response.body?.cancel().catch(() => {}); throw interrupted();
  }
  const plain = !response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity';
  if (declared !== null && BigInt(declared) > BigInt(maxBytes)) {
    await response.body?.cancel().catch(() => {});
    throw new TransportError('malformed', 'Drive object exceeds byte limit',
      { byteLength: Number(BigInt(declared) > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : BigInt(declared)) });
  }
  if (!response.body) throw interrupted();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      checkSignal(signal);
      const { value, done } = await reader.read();
      checkSignal(signal);
      if (done) break;
      if (value.byteLength > maxBytes - length) throw new TransportError('malformed', 'Drive object exceeds byte limit', { byteLength: maxBytes + 1 });
      length += value.byteLength; chunks.push(value);
    }
    if (plain && declared !== null && BigInt(length) !== BigInt(declared)) throw interrupted();
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof TransportError) throw error;
    throw interrupted();
  } finally {
    signal?.removeEventListener('abort', abort); reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}
function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  checkSignal(signal);
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(interrupted()); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
const QUOTA_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'storageQuotaExceeded'];
async function classify(response: Response, context: Context, signal?: AbortSignal): Promise<TransportError> {
  let reasons: string[] = [];
  let rejectedToken = false;
  try {
    const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedDriveBody(response, ERROR_LIMIT, signal)));
    const errors = Array.isArray(body.error?.errors) ? body.error.errors : [];
    reasons = errors.map((error: { reason?: unknown }) => error.reason).filter((reason: unknown) => typeof reason === 'string');
    // A generic 400/invalid is not evidence of a rejected page token. Require a structured location.
    rejectedToken = reasons.includes('invalidPageToken') || errors.some((error: { reason?: string; location?: string }) =>
      ['invalid', 'badRequest', 'invalidPageToken'].includes(error.reason ?? '') && ['pageToken', 'page_token'].includes(error.location ?? ''));
    const violations = body.error?.details;
    if (Array.isArray(violations)) rejectedToken ||= violations.some(detail => Array.isArray(detail.fieldViolations)
      && detail.fieldViolations.some((violation: { field?: string }) => ['pageToken', 'page_token'].includes(violation.field ?? '')));
  } catch { /* Never retain arbitrary provider messages, response bodies, or credentials. */ }
  if (response.status === 401 || reasons.includes('authError') || (response.status === 403 && reasons.includes('insufficientPermissions'))) return fail('authorization');
  if (response.status === 403) {
    if (reasons.some(reason => QUOTA_REASONS.includes(reason))) return fail('retryable');
    if (reasons.some(reason => ['appNotAuthorizedToFile', 'insufficientFilePermissions', 'domainPolicy'].includes(reason))) return fail('access');
    return fail('retryable');
  }
  if (response.status === 404 && ['root', 'object'].includes(context)) return fail(context === 'root' ? 'missing-dataset' : 'missing-object');
  if (context === 'continuation' && response.status === 400 && rejectedToken) return fail('invalid-cursor');
  return fail('retryable');
}

/** Provider I/O shared by explicit bootstrap and the bound transport. It holds no tokens. */
export class GoogleDriveClient {
  private fetcher: typeof fetch;
  private maxRetries: number;
  private random: () => number;
  private wait: NonNullable<DriveClientOptions['wait']>;
  private guards = new WeakMap<Response, () => void>();
  constructor(private credentials: (account: string) => DriveCredentials, options: DriveClientOptions = {}) {
    this.fetcher = options.fetcher ?? ((...args) => globalThis.fetch(...args));
    this.maxRetries = options.maxRetries ?? 2;
    if (!Number.isInteger(this.maxRetries) || this.maxRetries < 0 || this.maxRetries > 3) throw new RangeError('Invalid Drive retry budget');
    this.random = options.random ?? Math.random; this.wait = options.wait ?? wait;
  }
  private async request(account: string, path: string, init: RequestInit = {}, context: Context = 'object', upload = false): Promise<Response> {
    const signal = init.signal ?? undefined;
    let credential: DriveCredentials;
    try { credential = this.credentials(account); } catch { throw fail('authorization'); }
    const assert = () => {
      checkSignal(signal);
      try { credential.assertCurrent(); } catch { throw fail('authorization'); }
      if (!credential.accessToken) throw fail('authorization');
    };
    const attempts = context === 'publication' ? 0 : this.maxRetries;
    for (let attempt = 0; ; attempt++) {
      assert();
      let response: Response | undefined;
      let error: TransportError;
      try {
        response = await this.fetcher(`${upload ? UPLOAD : API}${path}`, { ...init, cache: 'no-store', credentials: 'omit', redirect: 'error',
          referrerPolicy: 'no-referrer', headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${credential.accessToken}` } });
        assert();
        if (response.ok || (context === 'publication' && response.status === 409)) {
          this.guards.set(response, assert); return response;
        }
        error = await classify(response, context, signal);
        assert();
      } catch (cause) {
        await response?.body?.cancel().catch(() => {});
        if (cause instanceof TransportError && cause.code === 'authorization') throw cause;
        error = cause instanceof TransportError ? cause : fail(context === 'publication' ? 'unknown' : 'retryable');
      }
      if (context === 'publication') {
        if (error.code === 'authorization' || error.code === 'access') throw error;
        throw fail('unknown');
      }
      if (error.code !== 'retryable' || attempt >= attempts || signal?.aborted) throw error;
      const jitter = Math.min(1, Math.max(0, this.random()));
      await this.wait(Math.floor(Math.min(8000, 1000 * 2 ** attempt) * (0.5 + jitter * 0.5)), signal);
    }
  }
  private async json(account: string, path: string, init: RequestInit = {}, context: Context = 'object'): Promise<any> {
    const response = await this.request(account, path, init, context);
    try {
      const bytes = await boundedDriveBody(response, JSON_LIMIT, init.signal ?? undefined);
      this.guards.get(response)?.();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch (error) { if (error instanceof TransportError && error.code === 'authorization') throw error; throw interrupted(); }
  }
  async generateIds(account: string, count: number, options: RequestOptions = {}): Promise<string[]> {
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new RangeError('Invalid Drive ID count');
    const value = await this.json(account, `/files/generateIds?count=${count}&space=drive&type=files`, options, 'request');
    if (!Array.isArray(value.ids) || value.ids.length !== count || new Set(value.ids).size !== count) throw interrupted();
    try { return value.ids.map(checkedDriveId); } catch { throw interrupted(); }
  }
  async metadata(account: string, id: string, options: RequestOptions & { context?: 'root' | 'object' } = {}): Promise<DriveMetadata> {
    const value = await this.json(account, `/files/${checkedDriveId(id)}?fields=${FIELDS}`, { signal: options.signal }, options.context ?? 'object');
    if (value?.id !== undefined && value.id !== id) throw fail('integrity');
    if (!value || value.id !== id || typeof value.mimeType !== 'string' || (value.parents !== undefined && (!Array.isArray(value.parents)
      || value.parents.some((parent: unknown) => typeof parent !== 'string'))) || typeof value.trashed !== 'boolean') throw interrupted();
    return value;
  }
  async list(account: string, query: string, token: string | null = null, options: RequestOptions = {}): Promise<DrivePage> {
    if (token !== null && (typeof token !== 'string' || !token.length || token.length > 8192)) throw fail('invalid-cursor');
    const parameters = new URLSearchParams({ q: query, spaces: 'drive', corpora: 'user', pageSize: '100',
      fields: `nextPageToken,incompleteSearch,files(${FIELDS})` });
    if (token !== null) parameters.set('pageToken', token);
    const value = await this.json(account, `/files?${parameters}`, options, token === null ? 'request' : 'continuation');
    if (!value || !Array.isArray(value.files) || value.files.length > 100
      || (value.nextPageToken !== undefined && (typeof value.nextPageToken !== 'string' || !value.nextPageToken.length || value.nextPageToken.length > 8192))
      || (value.incompleteSearch !== undefined && typeof value.incompleteSearch !== 'boolean')) throw interrupted();
    for (const file of value.files) { try { checkedDriveId(file?.id); } catch { throw interrupted(); } }
    return { files: value.files, continuation: value.nextPageToken ?? null, complete: value.nextPageToken === undefined && value.incompleteSearch !== true,
      incompleteSearch: value.incompleteSearch === true };
  }
  private async create(account: string, metadata: Record<string, unknown>, bytes: Uint8Array | undefined, options: RequestOptions): Promise<'created' | 'already-present'> {
    const boundary = `focus_timer_${crypto.randomUUID()}`;
    const headers = bytes ? { 'Content-Type': `multipart/related; boundary=${boundary}` } : { 'Content-Type': 'application/json' };
    const body = bytes ? new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n`, new Uint8Array(bytes), `\r\n--${boundary}--\r\n`]) : JSON.stringify(metadata);
    const response = await this.request(account, `/files?${bytes ? 'uploadType=multipart&' : ''}fields=id`,
      { method: 'POST', headers, body, signal: options.signal }, 'publication', bytes !== undefined);
    // The caller must verify current metadata and media; neither of these statuses confirms content.
    await response.body?.cancel().catch(() => {});
    this.guards.get(response)?.();
    return response.status === 409 ? 'already-present' : 'created';
  }
  createFolder(account: string, input: { id: string; parent?: string; datasetId: string; kind: 'root' | 'segments' }, options: RequestOptions = {}) {
    return this.create(account, { id: checkedDriveId(input.id), name: input.kind === 'root' ? `Focus Timer - ${input.datasetId}` : 'segments', mimeType: DRIVE_FOLDER_MIME,
      ...(input.parent ? { parents: [checkedDriveId(input.parent)] } : {}), properties: driveProperties(input.kind, input.datasetId) }, undefined, options);
  }
  createBlob(account: string, input: { id: string; parent: string; datasetId: string; kind: 'descriptor' | 'segment'; bytes: Uint8Array; segmentId?: string }, options: RequestOptions = {}) {
    if (!(input.bytes instanceof Uint8Array) || input.bytes.length > MAX_SEGMENT_BYTES) throw fail('integrity');
    return this.create(account, { id: checkedDriveId(input.id), name: input.kind === 'descriptor' ? 'dataset.json' : `${checkedDriveId(input.segmentId)}.json`,
      mimeType: 'application/json', parents: [checkedDriveId(input.parent)], properties: driveProperties(input.kind, input.datasetId) }, input.bytes, options);
  }
  async media(account: string, id: string, options: ReadOptions): Promise<Uint8Array> {
    const response = await this.request(account, `/files/${checkedDriveId(id)}?alt=media`, { signal: options.signal });
    // Ordinary complete blob GETs are used. Unsolicited range responses cannot establish completeness.
    if (response.status !== 200 || response.headers.has('content-range')) {
      await response.body?.cancel().catch(() => {}); throw interrupted();
    }
    const bytes = await boundedDriveBody(response, options.maxBytes, options.signal);
    this.guards.get(response)?.();
    return bytes;
  }
}

export function verifyDriveMetadata(metadata: DriveMetadata, expected: { id: string; kind: Kind; datasetId: string; parent?: string }) {
  if (metadata.id !== expected.id || metadata.trashed !== false || metadata.mimeType !== (['root', 'segments'].includes(expected.kind) ? DRIVE_FOLDER_MIME : 'application/json')
    || metadata.properties?.proof !== DRIVE_MARKER || metadata.properties?.kind !== expected.kind || metadata.properties?.datasetId !== expected.datasetId
    || (expected.parent && (!Array.isArray(metadata.parents) || metadata.parents.length !== 1 || metadata.parents[0] !== expected.parent))) throw fail('integrity');
}
function checkSize(metadata: DriveMetadata, maxBytes: number) {
  if (metadata.size === undefined) return;
  if (typeof metadata.size !== 'string' || !/^(0|[1-9][0-9]*)$/.test(metadata.size)) throw interrupted();
  if (BigInt(metadata.size) > BigInt(maxBytes)) throw new TransportError('malformed', 'Drive object exceeds byte limit',
    { byteLength: Number(BigInt(metadata.size) > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : BigInt(metadata.size)) });
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((value, index) => value === b[index]);

/** Immutable corpus transport for an explicitly selected and completely bootstrapped Drive binding. */
export class GoogleDriveTransport implements SyncTransport {
  constructor(readonly client: GoogleDriveClient) {}
  private locator(pin: Binding): DriveLocator {
    if (pin.provider !== 'google-drive') throw fail('integrity');
    return decodeDriveLocator(pin.locator);
  }
  private async folders(pin: Binding, options: RequestOptions): Promise<DriveLocator> {
    const locator = this.locator(pin);
    verifyDriveMetadata(await this.client.metadata(pin.account, locator.rootId, { ...options, context: 'root' }),
      { id: locator.rootId, kind: 'root', datasetId: pin.datasetId });
    verifyDriveMetadata(await this.client.metadata(pin.account, locator.segmentsId, { ...options, context: 'root' }),
      { id: locator.segmentsId, kind: 'segments', parent: locator.rootId, datasetId: pin.datasetId });
    return locator;
  }
  async readDescriptor(pin: Binding, options: ReadOptions): Promise<Uint8Array> {
    pin = { ...pin };
    const locator = await this.folders(pin, options);
    const metadata = await this.client.metadata(pin.account, locator.descriptorId, { ...options, context: 'root' });
    verifyDriveMetadata(metadata, { id: locator.descriptorId, kind: 'descriptor', parent: locator.rootId, datasetId: pin.datasetId });
    checkSize(metadata, options.maxBytes);
    try { return await this.client.media(pin.account, locator.descriptorId, options); }
    catch (error) {
      if (error instanceof TransportError && error.code === 'missing-object') throw fail('missing-dataset');
      throw error;
    }
  }
  async enumerate(pin: Binding, continuation: unknown, options: RequestOptions): Promise<EnumerationPage> {
    pin = { ...pin };
    let token: string | null = null;
    if (continuation !== null && continuation !== undefined) {
      const value = continuation as { v?: unknown; account?: unknown; locator?: unknown; datasetId?: unknown; token?: unknown };
      if (!value || value.v !== 1 || value.account !== pin.account || value.locator !== pin.locator || value.datasetId !== pin.datasetId
        || typeof value.token !== 'string') throw fail('invalid-cursor');
      token = value.token;
    }
    const locator = await this.folders(pin, options);
    // Every child is inspected on read. A misplaced/mutated object must not disappear through a metadata filter.
    const page = await this.client.list(pin.account, driveChildrenQuery(locator.segmentsId), token, options);
    // Refuse the page rather than persisting a false completed scan or inventing a token.
    if (page.incompleteSearch) throw new TransportError('retryable', 'Drive search incomplete');
    return { references: page.files.map(file => file.id), complete: page.complete,
      continuation: page.continuation === null ? null : { v: 1, account: pin.account, locator: pin.locator, datasetId: pin.datasetId, token: page.continuation } };
  }
  async read(pin: Binding, reference: string, options: ReadOptions): Promise<{ bytes: Uint8Array; complete: boolean }> {
    pin = { ...pin };
    const locator = this.locator(pin);
    const metadata = await this.client.metadata(pin.account, checkedDriveId(reference), options);
    verifyDriveMetadata(metadata, { id: reference, kind: 'segment', parent: locator.segmentsId, datasetId: pin.datasetId });
    checkSize(metadata, options.maxBytes);
    return { bytes: await this.client.media(pin.account, reference, options), complete: true };
  }
  async preparePublication(pin: Binding, _publication: { segmentId: string }, options: RequestOptions): Promise<string> {
    pin = { ...pin };
    this.locator(pin);
    return (await this.client.generateIds(pin.account, 1, options))[0];
  }
  async publish(pin: Binding, publication: PublicationRequest, options: RequestOptions): Promise<PublicationConfirmation> {
    pin = { ...pin };
    publication = { ...publication, bytes: Uint8Array.from(publication.bytes) };
    const locator = await this.folders(pin, options);
    const id = checkedDriveId(publication.retryHandle);
    const original = parseSegment(publication.bytes);
    if (original.datasetId !== pin.datasetId || original.segmentId !== publication.segmentId) throw fail('integrity');
    let outcome: 'confirmed' | 'already-present' = 'confirmed';
    try {
      if (await this.client.createBlob(pin.account, { id, parent: locator.segmentsId, datasetId: pin.datasetId,
        kind: 'segment', bytes: publication.bytes, segmentId: publication.segmentId }, options) === 'already-present') outcome = 'already-present';
    } catch (error) {
      if (error instanceof TransportError && (error.code === 'authorization' || error.code === 'access')) throw error;
      // A lost create response can still be resolved by affirmative fresh read-back at the retained ID.
      outcome = 'already-present';
    }
    try {
      const metadata = await this.client.metadata(pin.account, id, options);
      verifyDriveMetadata(metadata, { id, kind: 'segment', datasetId: pin.datasetId, parent: locator.segmentsId });
      checkSize(metadata, MAX_SEGMENT_BYTES);
      const bytes = await this.client.media(pin.account, id, { ...options, maxBytes: MAX_SEGMENT_BYTES });
      if (!sameBytes(bytes, publication.bytes)) throw fail('integrity');
      const parsed = parseSegment(bytes);
      if (parsed.datasetId !== pin.datasetId || parsed.segmentId !== publication.segmentId || parsed.deviceId !== original.deviceId) throw fail('integrity');
      return { outcome, segmentId: publication.segmentId, bytes, references: [id] };
    } catch (error) {
      if (error instanceof TransportError && ['integrity', 'authorization', 'access'].includes(error.code)) throw error;
      if (error instanceof TransportError && error.byteLength !== undefined) throw fail('integrity');
      throw fail('unknown');
    }
  }
}
