import { MAX_SEGMENT_BYTES, parseDescriptor, validateDescriptor, validateUuid } from '../protocol/index.js';
import { sameBytes } from '../sync/remote.js';
import type { Descriptor } from './model';
import type { BootstrapIntent } from './remote-repository';
import { TransportError, type TransportFailure } from './sync-transport';
import { GoogleDriveClient, DRIVE_MARKER, encodeDriveLocator, decodeDriveLocator, driveRootQuery, driveChildrenQuery,
  type DriveLocator, type DriveMetadata } from './google-drive-transport';

interface BootstrapOptions { signal?: AbortSignal; isCurrent?: () => boolean; assertCurrent?: () => Promise<void> }
export interface DriveCandidate {
  rootId: string; status: 'ready' | 'incomplete' | 'unreadable' | 'invalid';
  failure?: TransportFailure; descriptor?: Descriptor; locator?: string;
}
export interface DriveReadyCandidate extends DriveCandidate { status: 'ready'; descriptor: Descriptor; locator: string }
export interface DriveDiscovery { candidates: DriveCandidate[]; complete: boolean }
interface IntentStore {
  getBootstrapIntent(account?: string): Promise<BootstrapIntent | null>;
  retainBootstrapIntent(intent: BootstrapIntent, options?: { expectedGeneration?: number }): Promise<BootstrapIntent>;
}
class IncompleteTree extends TransportError {}
const folderMime = 'application/vnd.google-apps.folder';

async function guard(options: BootstrapOptions) {
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (options.isCurrent?.() === false) throw new TransportError('authorization');
  await options.assertCurrent?.();
  if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
  if (options.isCurrent?.() === false) throw new TransportError('authorization');
}
function protocolFailure(error: unknown): never {
  const classification = (error as { classification?: string })?.classification;
  throw new TransportError(classification === 'unsupported' || classification === 'integrity' ? classification : 'malformed');
}
function descriptor(bytes: Uint8Array): Descriptor {
  try { return parseDescriptor(bytes) as Descriptor; } catch (error) { return protocolFailure(error); }
}
function validMetadata(meta: DriveMetadata, id: string, kind: 'root' | 'segments' | 'descriptor', datasetId: string, parent?: string) {
  if (meta.id !== id || meta.trashed !== false || meta.mimeType !== (kind === 'descriptor' ? 'application/json' : folderMime)
    || meta.properties?.proof !== DRIVE_MARKER || meta.properties.kind !== kind || meta.properties.datasetId !== datasetId
    || (parent !== undefined && (meta.parents?.length !== 1 || meta.parents[0] !== parent))) throw new TransportError('integrity');
}

/** Explicit discovery/creation, separate from an already-bound synchronization pass. */
export class GoogleDriveBootstrap {
  constructor(private client: GoogleDriveClient, private store: IntentStore) {}

  private async scan(account: string, query: string, options: BootstrapOptions) {
    const files = new Map<string, DriveMetadata>();
    let token: string | null = null;
    let complete = true;
    do {
      await guard(options);
      const page = await this.client.list(account, query, token, options);
      await guard(options);
      for (const file of page.files) files.set(file.id, file);
      // An incompleteSearch page remains incomplete even if a later page is complete.
      if (page.incompleteSearch || (!page.complete && page.continuation === null)) complete = false;
      token = page.continuation;
    } while (token !== null);
    return { files: [...files.values()], complete };
  }

  async discover(account: string, options: BootstrapOptions = {}): Promise<DriveDiscovery> {
    const roots = await this.scan(account, driveRootQuery(), options);
    const candidates: DriveCandidate[] = [];
    for (const root of roots.files) {
      try { candidates.push(await this.inspect(account, root.id, options)); }
      catch (error) {
        await guard(options);
        if (!(error instanceof TransportError) || error.code === 'authorization') throw error;
        candidates.push({ rootId: root.id,
          status: error instanceof IncompleteTree ? 'incomplete'
            : ['malformed', 'unsupported', 'integrity'].includes(error.code) ? 'invalid' : 'unreadable', failure: error.code });
      }
    }
    return { candidates, complete: roots.complete };
  }

  /** A retained locator pins every component; an omitted search result never replaces it. */
  async inspect(account: string, root: string | DriveLocator,
    options: BootstrapOptions & { expectedDescriptor?: Descriptor } = {}): Promise<DriveReadyCandidate> {
    const retained = typeof root === 'string' ? undefined : decodeDriveLocator(encodeDriveLocator(root));
    const rootId = typeof root === 'string' ? root : retained!.rootId;
    let expectedDescriptor: Descriptor | undefined;
    if (options.expectedDescriptor) {
      try { expectedDescriptor = validateDescriptor(options.expectedDescriptor) as Descriptor; }
      catch (error) { return protocolFailure(error); }
    }
    await guard(options);
    const rootMeta = await this.client.metadata(account, rootId, { ...options, context: 'root' });
    await guard(options);
    const datasetId = rootMeta.properties?.datasetId;
    try { validateUuid(datasetId); } catch { throw new TransportError('malformed'); }
    validMetadata(rootMeta, rootId, 'root', datasetId!);
    const children = await this.scan(account, driveChildrenQuery(rootId), options);
    if (!children.complete) throw new IncompleteTree('retryable');
    const descriptors = children.files.filter(row => row.properties?.proof === DRIVE_MARKER && row.properties.kind === 'descriptor');
    const segments = children.files.filter(row => row.properties?.proof === DRIVE_MARKER && row.properties.kind === 'segments');
    if (!descriptors.length || !segments.length) throw new IncompleteTree('missing-dataset');
    if (descriptors.length !== 1 || segments.length !== 1) throw new TransportError('integrity');
    const locator: DriveLocator = { rootId, descriptorId: descriptors[0].id, segmentsId: segments[0].id };
    if (retained && encodeDriveLocator(locator) !== encodeDriveLocator(retained)) throw new TransportError('integrity');
    // Listing is a discovery hint. Read each selected component's current metadata directly.
    const folder = await this.client.metadata(account, locator.segmentsId, { ...options, context: 'root' });
    await guard(options);
    validMetadata(folder, locator.segmentsId, 'segments', datasetId!, rootId);
    const meta = await this.client.metadata(account, locator.descriptorId, { ...options, context: 'root' });
    await guard(options);
    validMetadata(meta, locator.descriptorId, 'descriptor', datasetId!, rootId);
    const bytes = await this.client.media(account, locator.descriptorId, { maxBytes: MAX_SEGMENT_BYTES, ...options });
    await guard(options);
    const parsed = descriptor(bytes);
    if (parsed.datasetId !== datasetId || (expectedDescriptor &&
      (parsed.datasetId !== expectedDescriptor.datasetId || parsed.application !== expectedDescriptor.application
        || parsed.protocolVersion !== expectedDescriptor.protocolVersion))) throw new TransportError('integrity');
    return { rootId, status: 'ready', descriptor: parsed, locator: encodeDriveLocator(locator) };
  }

  /** Allocate IDs only, then wait for durable local commit before exposing a creatable intent. */
  async prepare(account: string, input: Descriptor,
    options: BootstrapOptions & { expectedGeneration?: number } = {}): Promise<BootstrapIntent> {
    let parsed: Descriptor;
    try { parsed = validateDescriptor(input) as Descriptor; } catch (error) { return protocolFailure(error); }
    await guard(options);
    const existing = await this.store.getBootstrapIntent(account);
    await guard(options);
    if (existing) {
      if (existing.account !== account || existing.descriptor.datasetId !== parsed.datasetId) throw new TransportError('integrity');
      return existing;
    }
    const ids = await this.client.generateIds(account, 3, options);
    await guard(options);
    const intent: BootstrapIntent = { version: 1, account,
      locator: encodeDriveLocator({ rootId: ids[0], segmentsId: ids[1], descriptorId: ids[2] }), descriptor: parsed,
      descriptorBytes: new TextEncoder().encode(JSON.stringify(parsed)) };
    decodeDriveLocator(intent.locator);
    const retained = await this.store.retainBootstrapIntent(intent, { expectedGeneration: options.expectedGeneration });
    await guard(options);
    return retained;
  }

  /** User-selected create/retry: always reload the durable winning IDs and exact bytes. */
  async create(account: string, options: BootstrapOptions = {}): Promise<{ candidate: DriveReadyCandidate; discovery: DriveDiscovery }> {
    await guard(options);
    const intent = await this.store.getBootstrapIntent(account);
    await guard(options);
    if (!intent || intent.account !== account) throw new TransportError('integrity');
    const pinned = decodeDriveLocator(intent.locator);
    const expected = descriptor(intent.descriptorBytes);
    if (expected.datasetId !== intent.descriptor.datasetId) throw new TransportError('integrity');
    for (const [id, parent, kind] of [[pinned.rootId, undefined, 'root'], [pinned.segmentsId, pinned.rootId, 'segments']] as const) {
      await guard(options);
      try { await this.client.createFolder(account, { id, parent, kind, datasetId: expected.datasetId }, options); }
      catch (error) { if (!(error instanceof TransportError) || !['unknown', 'retryable'].includes(error.code)) throw error; }
      await guard(options);
      const meta = await this.client.metadata(account, id, { ...options, context: 'root' });
      await guard(options);
      validMetadata(meta, id, kind, expected.datasetId, parent);
    }
    // Publish descriptor last, as a complete multipart object. Never patch an empty file.
    try { await this.client.createBlob(account, { id: pinned.descriptorId, parent: pinned.rootId,
      datasetId: expected.datasetId, kind: 'descriptor', bytes: intent.descriptorBytes }, options); }
    catch (error) { if (!(error instanceof TransportError) || !['unknown', 'retryable'].includes(error.code)) throw error; }
    await guard(options);
    const meta = await this.client.metadata(account, pinned.descriptorId, { ...options, context: 'root' });
    await guard(options);
    validMetadata(meta, pinned.descriptorId, 'descriptor', expected.datasetId, pinned.rootId);
    const bytes = await this.client.media(account, pinned.descriptorId, { maxBytes: MAX_SEGMENT_BYTES, ...options });
    await guard(options);
    if (!sameBytes(bytes, intent.descriptorBytes)) throw new TransportError('integrity');
    const candidate = await this.inspect(account, pinned, { ...options, expectedDescriptor: expected });
    const discovery = await this.discover(account, options);
    await guard(options);
    return { candidate, discovery };
  }
}
