// Isolated diagnostic helpers. This module is NOT a SyncTransport implementation.
import { parseDescriptor, parseSegment } from '../../src/protocol/index.js';

export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
export const MAX_BYTES = 1_048_576;
export const PROOF_MARKER = 'focus-timer-drive-proof-v1';
const encoder = new TextEncoder();
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
export const encode = text => encoder.encode(text);

export class ProofFailure extends Error {
  constructor(code, detail = {}) { super(code); this.code = code; this.detail = detail; }
}

export function checkedId(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(value)) throw new ProofFailure('invalid-local-id');
  return value;
}

export function equalBytes(a, b) {
  return a.byteLength === b.byteLength && a.every((value, index) => value === b[index]);
}

export function refuseOversizeMetadata(metadata, maxBytes = MAX_BYTES) {
  // Drive's size is an int64 string. Missing size is permitted; malformed size is untrusted.
  if (metadata.size === undefined) return;
  if (typeof metadata.size !== 'string' || !/^(0|[1-9][0-9]*)$/.test(metadata.size)) throw new ProofFailure('malformed-provider-size');
  if (BigInt(metadata.size) > BigInt(maxBytes)) throw new ProofFailure('oversize', { bound: maxBytes });
}

// Content-Length is only an early refusal hint. The stream bound applies independently.
export async function boundedBody(response, maxBytes = MAX_BYTES, { interruptAfterBytes } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) throw new ProofFailure('invalid-bound');
  const declared = response.headers.get('content-length');
  const plainLength = declared !== null && /^\d+$/.test(declared) && (!response.headers.get('content-encoding') || response.headers.get('content-encoding') === 'identity') ? BigInt(declared) : null;
  if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(maxBytes)) {
    await response.body?.cancel();
    throw new ProofFailure('oversize', { bound: maxBytes });
  }
  if (!response.body) throw new ProofFailure('incomplete-transfer');
  const reader = response.body.getReader();
  const pieces = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (length + value.byteLength > maxBytes) throw new ProofFailure('oversize', { bound: maxBytes });
      length += value.byteLength;
      pieces.push(value);
      if (interruptAfterBytes !== undefined && length >= interruptAfterBytes) throw new ProofFailure('intentional-read-interruption', { receivedBytes: length });
    }
    if (plainLength !== null && BigInt(length) !== plainLength) throw new ProofFailure('incomplete-transfer');
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ProofFailure) throw error;
    throw new ProofFailure('incomplete-transfer');
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const piece of pieces) { bytes.set(piece, offset); offset += piece.byteLength; }
  return bytes;
}

const REASONS = new Set(['authError', 'insufficientPermissions', 'insufficientFilePermissions', 'appNotAuthorizedToFile',
  'notFound', 'rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'storageQuotaExceeded',
  'backendError', 'internalError', 'invalid', 'badRequest', 'forbidden', 'fileNotDownloadable']);
export function providerClassification(status, reasons = [], context = 'object') {
  if (status === 401) return 'authorization';
  if (status === 403 && reasons.includes('insufficientPermissions')) return 'authorization';
  if (status === 403 && reasons.some(reason => ['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'storageQuotaExceeded'].includes(reason))) return 'retryable';
  if (status === 403) return 'access';
  // Drive intentionally conflates missing and inaccessible. A 404 alone proves neither.
  if (status === 404) return context === 'root' ? 'missing-or-inaccessible-root' : 'missing-or-inaccessible-object';
  if (status === 429 || status >= 500) return 'retryable';
  if (context === 'publication') return 'unknown-publication';
  if (context === 'continuation' && status === 400) return 'possible-invalid-continuation';
  return 'unclassified';
}

export function pageState(page) {
  if (!page || !Array.isArray(page.files) || (page.nextPageToken !== undefined && (typeof page.nextPageToken !== 'string' || page.nextPageToken.length > 8192))
    || (page.incompleteSearch !== undefined && typeof page.incompleteSearch !== 'boolean')) throw new ProofFailure('malformed-provider-page');
  return { files: page.files, continuation: page.nextPageToken ?? null,
    complete: !page.nextPageToken && page.incompleteSearch !== true, incompleteSearch: page.incompleteSearch === true };
}

export function confirmExact(intent, bytes) {
  if (!equalBytes(encode(intent.text), bytes)) throw new ProofFailure('integrity');
  const parsed = intent.kind === 'descriptor' ? parseDescriptor(bytes) : parseSegment(bytes);
  const original = intent.kind === 'descriptor' ? parseDescriptor(encode(intent.text)) : parseSegment(encode(intent.text));
  if (parsed.datasetId !== intent.datasetId || (intent.kind === 'segment' && (parsed.segmentId !== intent.segmentId || parsed.deviceId !== original.deviceId))) throw new ProofFailure('integrity');
  return { exactBytes: true, logicalIdentity: true, byteLength: bytes.byteLength };
}

export function properties(kind, datasetId) { return { proof: PROOF_MARKER, kind, datasetId }; }
export function rootQuery() { return `trashed = false and properties has { key='proof' and value='${PROOF_MARKER}' } and properties has { key='kind' and value='root' }`; }
export function childrenQuery(parent) { return `'${checkedId(parent)}' in parents and trashed = false`; }

export class DriveProbe {
  constructor(getToken, fetcher = (...args) => globalThis.fetch(...args)) { this.getToken = getToken; this.fetcher = fetcher; }
  async request(path, options = {}, { upload = false, context = 'object' } = {}) {
    const token = this.getToken();
    if (!token) throw new ProofFailure('authorization');
    let response;
    try {
      response = await this.fetcher(`${upload ? UPLOAD : API}${path}`, { ...options, cache: 'no-store', credentials: 'omit', redirect: 'error',
        headers: { ...options.headers, Authorization: `Bearer ${token}` } });
    } catch { throw new ProofFailure(context === 'publication' ? 'unknown-publication' : 'network-interruption'); }
    if (response.ok) return response;
    let reasons = [];
    try {
      const body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(response, 65_536)));
      reasons = [...new Set((body.error?.errors ?? []).map(row => row.reason).filter(reason => REASONS.has(reason)))];
    } catch { /* Never log arbitrary provider message or body. */ }
    throw new ProofFailure(providerClassification(response.status, reasons, context), { status: response.status, reasons });
  }
  async json(path, options, context) {
    const response = await this.request(path, options, context);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await boundedBody(response, 131_072))); }
    catch (error) { if (error instanceof ProofFailure) throw error; throw new ProofFailure('malformed-provider-json'); }
  }
  async account() {
    const result = await this.json('/about?fields=user(permissionId)');
    return checkedId(result.user?.permissionId);
  }
  async generateIds(count) {
    if (!Number.isInteger(count) || count < 1 || count > 10) throw new ProofFailure('invalid-count');
    const result = await this.json(`/files/generateIds?count=${count}&space=drive&type=files`);
    if (!Array.isArray(result.ids) || result.ids.length !== count) throw new ProofFailure('invalid-generated-ids');
    return result.ids.map(checkedId);
  }
  async metadata(id, context = 'object') {
    return this.json(`/files/${checkedId(id)}?fields=id,mimeType,parents,trashed,size,version,headRevisionId,md5Checksum,sha1Checksum,sha256Checksum,isAppAuthorized,properties,capabilities(canEdit,canDownload)`, {}, { context });
  }
  async list(q, token = null) {
    const params = new URLSearchParams({ q, spaces: 'drive', pageSize: '2', fields: 'nextPageToken,incompleteSearch,files(id,mimeType,parents,size,properties,trashed)' });
    if (token !== null) {
      if (typeof token !== 'string' || token.length > 8192) throw new ProofFailure('invalid-local-continuation');
      params.set('pageToken', token);
    }
    return pageState(await this.json(`/files?${params}`, {}, { context: token === null ? 'object' : 'continuation' }));
  }
  async createFolder(id, parent, kind, datasetId) {
    return this.json('/files?fields=id', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: checkedId(id), name: `Focus Timer PROOF ${kind}`, mimeType: 'application/vnd.google-apps.folder',
        ...(parent ? { parents: [checkedId(parent)] } : {}), properties: properties(kind, datasetId) }) }, { context: 'publication' });
  }
  async createBlob(intent, { discardAcceptedResponse = false } = {}) {
    const boundary = `proof_${crypto.randomUUID()}`;
    const metadata = { id: checkedId(intent.remoteId), name: `Focus Timer PROOF ${intent.kind}`, mimeType: 'application/json',
      parents: [checkedId(intent.parent)], properties: properties(intent.kind, intent.datasetId) };
    const body = new Blob([`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n`, encode(intent.text), `\r\n--${boundary}--\r\n`]);
    const response = await this.request('/files?uploadType=multipart&fields=id', { method: 'POST', body,
      headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } }, { upload: true, context: 'publication' });
    if (discardAcceptedResponse) {
      await response.body?.cancel().catch(() => {});
      throw new ProofFailure('intentionally-lost-accepted-response', { acceptedStatus: response.status });
    }
    await boundedBody(response, 65_536);
    return { status: response.status }; // Still not a publication confirmation.
  }
  async media(id, options = {}) {
    const response = await this.request(`/files/${checkedId(id)}?alt=media`, { signal: options.signal });
    if (response.status !== 200 || response.headers.has('content-range')) {
      await response.body?.cancel().catch(() => {});
      throw new ProofFailure('incomplete-transfer');
    }
    return boundedBody(response, MAX_BYTES, options);
  }
  async retryAndVerify(intent) {
    let create;
    try { create = await this.createBlob(intent); }
    catch (error) {
      if (!(error instanceof ProofFailure)) throw error;
      // A retry response, including 409, only motivates a read. Never confirms alone.
      create = { error: error.code, ...error.detail };
    }
    let bytes;
    try {
      const meta = await this.metadata(intent.remoteId);
      if (meta.id !== intent.remoteId || meta.trashed || meta.mimeType !== 'application/json' || !Array.isArray(meta.parents)
        || meta.parents.length !== 1 || meta.parents[0] !== intent.parent || meta.properties?.proof !== PROOF_MARKER
        || meta.properties.kind !== intent.kind || meta.properties.datasetId !== intent.datasetId) throw new ProofFailure('integrity');
      refuseOversizeMetadata(meta);
      bytes = await this.media(intent.remoteId);
    }
    catch (error) {
      if (error.code === 'integrity') throw error;
      throw new ProofFailure('unknown-publication', { create, read: error.code ?? 'unclassified' });
    }
    return { create, ...confirmExact(intent, bytes) };
  }
}
