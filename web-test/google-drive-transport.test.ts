import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { boundedDriveBody, decodeDriveLocator, DRIVE_FOLDER_MIME, driveProperties, encodeDriveLocator,
  GoogleDriveClient, GoogleDriveTransport, type DriveMetadata } from '../src/web/google-drive-transport';
import { TransportError } from '../src/web/sync-transport';
import { MAX_SEGMENT_BYTES, encodeUtf8 } from '../src/protocol/index.js';
import { LocalRepository } from '../src/web/repository';
import { SyncRunner } from '../src/web/sync-runner';
import { pin as activePin, type Descriptor } from '../src/web/model';
import type { Binding } from '../src/web/remote-repository';

const uuid = (n: number) => `97000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const stamp = '2026-10-19T12:00:00.000Z';
const descriptor: Descriptor = { application: 'focus-timer', protocolVersion: 1, datasetId: uuid(1) };
const locator = { rootId: 'root', descriptorId: 'descriptor', segmentsId: 'segments' };
const binding: Binding = { provider: 'google-drive', account: 'account', locator: encodeDriveLocator(locator), datasetId: descriptor.datasetId, generation: 1 };
const options = { maxBytes: MAX_SEGMENT_BYTES };
function segment(n = 1) {
  const entityId = uuid(100 + n);
  return encodeUtf8(JSON.stringify({ protocolVersion: 1, datasetId: descriptor.datasetId, deviceId: uuid(2), segmentId: uuid(200 + n), operations: [
    { protocolVersion: 1, schemaVersion: 1, opId: uuid(300 + n), datasetId: descriptor.datasetId, deviceId: uuid(2), entityType: 'focusSession',
      entityId, operation: 'UPSERT', lamportCounter: n, payload: { id: entityId, startedAt: stamp, endedAt: stamp, focusDurationMs: n, description: `Synthetic ${n}` } },
  ] }));
}
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const providerError = (status: number, reason?: string, location?: string) => json({ error: { message: 'PRIVATE TOKEN AND HISTORY MUST NOT LEAK',
  errors: reason ? [{ reason, ...(location ? { location } : {}) }] : [] } }, status);
type Stored = { metadata: DriveMetadata; bytes?: Uint8Array };
type Request = { url: URL; init: RequestInit };
function fixture(config: { maxRetries?: number; random?: () => number } = {}) {
  const objects = new Map<string, Stored>();
  const requests: Request[] = [];
  const delays: number[] = [];
  let generated = 0;
  let validCredentials = true;
  let hook: ((request: Request) => Response | void | Promise<Response | void>) | undefined;
  const store = (id: string, kind: 'root' | 'segments' | 'descriptor' | 'segment', parent?: string, bytes?: Uint8Array) => {
    objects.set(id, { metadata: { id, mimeType: ['root', 'segments'].includes(kind) ? DRIVE_FOLDER_MIME : 'application/json', trashed: false,
      ...(parent ? { parents: [parent] } : {}), ...(bytes ? { size: String(bytes.length) } : {}), properties: driveProperties(kind, descriptor.datasetId) }, bytes });
  };
  store('root', 'root'); store('segments', 'segments', 'root'); store('descriptor', 'descriptor', 'root', encodeUtf8(JSON.stringify(descriptor)));
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = new URL(String(input)); const request = { url, init }; requests.push(request);
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer transient-test-token');
    expect(init).toMatchObject({ cache: 'no-store', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
    expect(url.href).not.toContain('transient-test-token');
    const override = await hook?.(request); if (override) return override;
    if (url.pathname.endsWith('/generateIds')) return json({ ids: Array.from({ length: Number(url.searchParams.get('count')) }, () => `generated_${++generated}`) });
    if (init.method === 'POST') {
      let metadata: DriveMetadata; let bytes: Uint8Array | undefined;
      if (init.body instanceof Blob) {
        const body = await init.body.text(); const boundary = new Headers(init.headers).get('Content-Type')!.split('boundary=')[1];
        const parts = body.split(`--${boundary}`);
        metadata = JSON.parse(parts[1].split('\r\n\r\n')[1].slice(0, -2));
        bytes = encodeUtf8(parts[2].slice(parts[2].indexOf('\r\n\r\n') + 4, -2));
      } else metadata = JSON.parse(String(init.body));
      if (objects.has(metadata.id)) return providerError(409);
      objects.set(metadata.id, { metadata: { ...metadata, trashed: false, ...(bytes ? { size: String(bytes.length) } : {}) }, bytes });
      return json({ id: metadata.id });
    }
    if (url.pathname.endsWith('/files')) {
      const parent = url.searchParams.get('q')?.match(/^'([^']+)' in parents/)?.[1];
      const files = [...objects.values()].map(value => value.metadata).filter(value => parent ? value.parents?.includes(parent) : value.properties?.kind === 'root');
      return json({ files });
    }
    const id = url.pathname.split('/').at(-1)!; const object = objects.get(id);
    if (!object) return providerError(404, 'notFound');
    if (url.searchParams.get('alt') === 'media') return new Response(new Uint8Array(object.bytes!), { headers: { 'Content-Length': String(object.bytes!.length) } });
    return json(object.metadata);
  };
  const client = new GoogleDriveClient(account => {
    if (account !== 'account' || !validCredentials) throw new Error('private credential failure');
    return { accessToken: 'transient-test-token', assertCurrent: () => { if (!validCredentials) throw new Error('private stale credential'); } };
  }, { fetcher, maxRetries: config.maxRetries ?? 0, random: config.random ?? (() => 0), wait: async ms => { delays.push(ms); } });
  const transport = new GoogleDriveTransport(client);
  return { client, transport, objects, requests, delays, store,
    hook(value: typeof hook) { hook = value; }, invalidate() { validCredentials = false; } };
}
const segmentRequest = (bytes = segment()) => ({ retryHandle: 'retained_id', segmentId: uuid(201), bytes });
const isMedia = ({ url }: Request) => url.searchParams.get('alt') === 'media';
const isList = ({ url, init }: Request) => url.pathname.endsWith('/files') && init.method !== 'POST';
const code = (value: unknown) => value instanceof TransportError && value.code;

describe('bounded Drive reads', () => {
  it('reads the exact maximum through a stream and copies complete caller-owned bytes', async () => {
    const original = new Uint8Array(MAX_SEGMENT_BYTES).fill(31);
    const response = new Response(original, { headers: { 'Content-Length': String(original.length) } });
    const bytes = await boundedDriveBody(response, MAX_SEGMENT_BYTES);
    expect(bytes.length).toBe(original.length); expect(Buffer.compare(Buffer.from(bytes), Buffer.from(original))).toBe(0); expect(bytes).not.toBe(original);
  });
  it('cancels a streaming maximum-plus-one body without retaining the extra chunk', async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(4)); controller.enqueue(new Uint8Array(5)); }, cancel() { cancelled = true; } });
    await expect(boundedDriveBody(new Response(stream), 8)).rejects.toMatchObject({ code: 'malformed', byteLength: 9 });
    expect(cancelled).toBe(true);
  });
  it('refuses declared oversized length before reading any body', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Length': '9007199254740993' } });
    await expect(boundedDriveBody(response, 8)).rejects.toMatchObject({ code: 'malformed', byteLength: Number.MAX_SAFE_INTEGER });
    expect(cancelled).toBe(true);
  });
  it('classifies a clean early EOF as retryable rather than corrupt JSON', async () => {
    await expect(boundedDriveBody(new Response('short', { headers: { 'Content-Length': '12' } }), 20)).rejects.toMatchObject({ code: 'retryable' });
  });
  it('classifies a stream exception as retryable and does not include its private message', async () => {
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(encodeUtf8('{')); controller.error(new Error('PRIVATE')); } }));
    try { await boundedDriveBody(response, 8); throw new Error('unexpected success'); }
    catch (error) { expect(code(error)).toBe('retryable'); expect(String(error)).not.toContain('PRIVATE'); }
  });
  it('aborts a pending body read', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    const controller = new AbortController(); const read = boundedDriveBody(response, 8, controller.signal); controller.abort();
    await expect(read).rejects.toMatchObject({ code: 'retryable' }); expect(cancelled).toBe(true);
  });
  it('cancels an unread response when cancellation won the race before body consumption', async () => {
    let cancelled = false; const controller = new AbortController(); controller.abort();
    const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }));
    await expect(boundedDriveBody(response, 8, controller.signal)).rejects.toMatchObject({ code: 'retryable' }); expect(cancelled).toBe(true);
  });
  it('does not compare compressed transfer length with decoded bytes', async () => {
    const bytes = await boundedDriveBody(new Response('decoded', { headers: { 'Content-Length': '3', 'Content-Encoding': 'gzip' } }), 8);
    expect(new TextDecoder().decode(bytes)).toBe('decoded');
  });
  it.each([new Headers({ 'Content-Length': '-1' }), new Headers({ 'Content-Length': '1.2' })])('refuses an invalid transfer length', async headers => {
    await expect(boundedDriveBody(new Response('a', { headers }), 8)).rejects.toMatchObject({ code: 'retryable' });
  });
  it.each([206, 200])('rejects unsolicited partial transfer with status %s', async status => {
    const f = fixture(); f.hook(request => isMedia(request) ? new Response('part', { status, headers: { 'Content-Range': 'bytes 0-3/80' } }) : undefined);
    await expect(f.transport.readDescriptor(binding, options)).rejects.toMatchObject({ code: 'retryable' });
  });
  it('permits missing or stale smaller metadata size while independently bounding the actual media', async () => {
    const f = fixture(); f.store('a', 'segment', 'segments', segment()); delete f.objects.get('a')!.metadata.size;
    expect((await f.transport.read(binding, 'a', options)).bytes).toEqual(segment());
    f.objects.get('a')!.metadata.size = '1';
    expect((await f.transport.read(binding, 'a', options)).bytes).toEqual(segment());
    f.hook(request => isMedia(request) ? new Response(new Uint8Array(17)) : undefined);
    await expect(f.transport.read(binding, 'a', { maxBytes: 16 })).rejects.toMatchObject({ code: 'malformed', byteLength: 17 });
  });
  it('refuses oversized metadata without a media request and handles malformed size conservatively', async () => {
    const f = fixture(); f.store('a', 'segment', 'segments', segment()); f.objects.get('a')!.metadata.size = '999999999999999999999';
    await expect(f.transport.read(binding, 'a', options)).rejects.toMatchObject({ code: 'malformed', byteLength: Number.MAX_SAFE_INTEGER });
    expect(f.requests.some(isMedia)).toBe(false); f.objects.get('a')!.metadata.size = '1e3';
    await expect(f.transport.read(binding, 'a', options)).rejects.toMatchObject({ code: 'retryable' });
  });
});

describe('Drive targets and enumeration', () => {
  it('uses exact stable component locators, account, properties, and placement', async () => {
    const f = fixture(); expect(decodeDriveLocator(binding.locator)).toEqual(locator);
    expect(await f.transport.readDescriptor(binding, options)).toEqual(encodeUtf8(JSON.stringify(descriptor)));
    expect(f.requests.map(request => request.url.pathname.split('/').at(-1))).toEqual(['root', 'segments', 'descriptor', 'descriptor']);
  });
  it.each(['root', 'segments', 'descriptor'])('a missing or inaccessible %s is missing-dataset with no recreation', async id => {
    const f = fixture(); f.objects.delete(id);
    await expect(f.transport.readDescriptor(binding, options)).rejects.toMatchObject({ code: 'missing-dataset' });
    expect(f.requests.every(request => request.init.method !== 'POST')).toBe(true);
  });
  it('preserves missing-object ambiguity', async () => {
    const f = fixture(); await expect(f.transport.read(binding, 'unavailable', options)).rejects.toMatchObject({ code: 'missing-object' });
  });
  it.each(['trashed', 'parent', 'mime', 'properties'])('rejects changed %s before accepting content', async change => {
    const f = fixture(); f.store('a', 'segment', 'segments', segment()); const meta = f.objects.get('a')!.metadata;
    if (change === 'trashed') meta.trashed = true;
    if (change === 'parent') meta.parents = ['other'];
    if (change === 'mime') meta.mimeType = DRIVE_FOLDER_MIME;
    if (change === 'properties') meta.properties!.datasetId = uuid(99);
    await expect(f.transport.read(binding, 'a', options)).rejects.toMatchObject({ code: 'integrity' });
    expect(f.requests.some(isMedia)).toBe(false);
  });
  it('accepts empty continued pages and opaque punctuation in page tokens', async () => {
    const f = fixture(); const token = 'opaque +/=? &token'; let page = 0;
    f.hook(request => {
      if (!isList(request)) return;
      page++;
      if (page === 1) { expect(request.url.searchParams.has('pageToken')).toBe(false); return json({ files: [], nextPageToken: token }); }
      expect(request.url.searchParams.get('pageToken')).toBe(token); return json({ files: [{ id: 'later' }] });
    });
    const first = await f.transport.enumerate(binding, null, {}); expect(first).toMatchObject({ references: [], complete: false });
    expect(await f.transport.enumerate(binding, first.continuation, {})).toEqual({ references: ['later'], complete: true, continuation: null });
    expect(f.requests.find(isList)!.url.searchParams.get('corpora')).toBe('user');
  });
  it.each([true, false])('never completes incompleteSearch with continuation=%s', async continued => {
    const f = fixture(); f.hook(request => isList(request) ? json({ files: [{ id: 'a' }], incompleteSearch: true, ...(continued ? { nextPageToken: 'token' } : {}) }) : undefined);
    await expect(f.transport.enumerate(binding, null, {})).rejects.toMatchObject({ code: 'retryable' });
    const raw = await f.client.list('account', 'safe query'); expect(raw.incompleteSearch).toBe(true); expect(raw.complete).toBe(false);
  });
  it('pins opaque continuation to account, target, and dataset without sending an unrelated cursor', async () => {
    const f = fixture();
    await expect(f.transport.enumerate(binding, { v: 1, account: 'other', locator: binding.locator, datasetId: binding.datasetId, token: 'secret' }, {}))
      .rejects.toMatchObject({ code: 'invalid-cursor' }); expect(f.requests).toHaveLength(0);
  });
  it('classifies a positively diagnosed rejected continuation but leaves generic 400 retryable', async () => {
    const f = fixture(); const continuation = { v: 1, account: binding.account, locator: binding.locator, datasetId: binding.datasetId, token: 'old' };
    f.hook(request => isList(request) ? providerError(400, 'invalid', 'pageToken') : undefined);
    await expect(f.transport.enumerate(binding, continuation, {})).rejects.toMatchObject({ code: 'invalid-cursor' });
    f.hook(request => isList(request) ? providerError(400, 'invalid') : undefined);
    await expect(f.transport.enumerate(binding, continuation, {})).rejects.toMatchObject({ code: 'retryable' });
  });
});

describe('Drive failures and credentials', () => {
  it.each([[401, 'authError', 'authorization'], [403, 'authError', 'authorization'], [403, 'insufficientPermissions', 'authorization'], [403, 'appNotAuthorizedToFile', 'access'],
    [403, 'insufficientFilePermissions', 'access'], [403, 'domainPolicy', 'access'], [403, 'rateLimitExceeded', 'retryable'],
    [403, 'userRateLimitExceeded', 'retryable'], [403, 'dailyLimitExceeded', 'retryable'], [403, 'storageQuotaExceeded', 'retryable'],
    [403, '', 'retryable'], [403, 'unknownProviderReason', 'retryable'],
    [429, '', 'retryable'], [500, '', 'retryable'], [502, '', 'retryable'], [503, '', 'retryable'], [504, '', 'retryable'], [400, '', 'retryable']])
    ('maps HTTP %s/%s to %s without retaining private provider text', async (status, reason, expected) => {
      const f = fixture(); f.hook(() => providerError(Number(status), String(reason)));
      try { await f.client.metadata('account', 'a'); throw new Error('unexpected success'); }
      catch (error) { expect(code(error)).toBe(expected); expect(JSON.stringify(error)).not.toContain('PRIVATE'); expect(String(error)).not.toContain('PRIVATE'); }
    });
  it('uses bounded exponential backoff and jitter for retryable HTTP outcomes, with an attempt budget', async () => {
    const f = fixture({ maxRetries: 2, random: () => 1 }); let count = 0;
    f.hook(() => { count++; return providerError(503); });
    await expect(f.client.metadata('account', 'a')).rejects.toMatchObject({ code: 'retryable' });
    expect(count).toBe(3); expect(f.delays).toEqual([1000, 2000]);
  });
  it('retries a transient network read failure and can recover within its finite budget', async () => {
    const f = fixture({ maxRetries: 2 }); let attempts = 0;
    f.hook(() => { if (++attempts === 1) throw new Error('PRIVATE NETWORK'); });
    expect((await f.client.metadata('account', 'root')).id).toBe('root'); expect(f.delays).toEqual([500]);
  });
  it('never retries denied access or sends a wrong-account request', async () => {
    const f = fixture({ maxRetries: 2 }); f.hook(() => providerError(401, 'authError'));
    await expect(f.client.metadata('account', 'a')).rejects.toMatchObject({ code: 'authorization' }); expect(f.requests).toHaveLength(1);
    await expect(f.client.metadata('other', 'a')).rejects.toMatchObject({ code: 'authorization' }); expect(f.requests).toHaveLength(1);
    expect(f.delays).toEqual([]);
  });
  it('bounds arbitrary provider errors and preserves status diagnosis even for oversized non-JSON errors', async () => {
    const f = fixture(); let cancelled = false;
    f.hook(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(16_385)); }, cancel() { cancelled = true; } }), { status: 401 }));
    await expect(f.client.metadata('account', 'a')).rejects.toMatchObject({ code: 'authorization' }); expect(cancelled).toBe(true);
  });
  it('does not mistake malformed provider metadata JSON for invalid synchronized history', async () => {
    const f = fixture(); f.hook(() => new Response('{'));
    await expect(f.client.metadata('account', 'a')).rejects.toMatchObject({ code: 'retryable' });
  });
  it('rejects credentials invalidated while headers are outstanding', async () => {
    const f = fixture(); f.hook(() => { f.invalidate(); return json({ id: 'a', mimeType: 'application/json', trashed: false }); });
    await expect(f.client.metadata('account', 'a')).rejects.toMatchObject({ code: 'authorization' });
  });
  it('rejects credentials invalidated during body consumption', async () => {
    const f = fixture(); let finish!: () => void;
    f.hook(request => !isMedia(request) ? undefined : new Response(new ReadableStream({ start(controller) {
      finish = () => { f.invalidate(); controller.enqueue(encodeUtf8('complete')); controller.close(); };
    } })));
    const read = f.client.media('account', 'a', { maxBytes: 8 });
    while (!finish) await Promise.resolve(); finish();
    await expect(read).rejects.toMatchObject({ code: 'authorization' });
  });
  it('passes cancellation to fetch and refuses work already cancelled', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.transport.readDescriptor(binding, { ...options, signal: controller.signal })).rejects.toMatchObject({ code: 'retryable' }); expect(f.requests).toHaveLength(0);
  });
});

describe('retained-ID immutable publication', () => {
  it('preparation allocates only a generated ID and publishes no content', async () => {
    const f = fixture(); expect(await f.transport.preparePublication(binding, { segmentId: uuid(201) }, {})).toBe('generated_1');
    expect(f.requests).toHaveLength(1); expect(f.requests[0].url.pathname).toBe('/drive/v3/files/generateIds'); expect(f.objects.size).toBe(3);
  });
  it('treats allocation endpoint failures and repeated generated IDs as provider failures', async () => {
    const f = fixture(); f.hook(() => providerError(404, 'notFound'));
    await expect(f.client.generateIds('account', 1)).rejects.toMatchObject({ code: 'retryable' });
    f.hook(() => json({ ids: ['same', 'same', 'same'] }));
    await expect(f.client.generateIds('account', 3)).rejects.toMatchObject({ code: 'retryable' });
  });
  it('confirms a complete multipart create only after fresh exact metadata/media verification', async () => {
    const f = fixture(); const request = segmentRequest(); const confirmation = await f.transport.publish(binding, request, {});
    expect(confirmation).toEqual({ outcome: 'confirmed', segmentId: request.segmentId, bytes: request.bytes, references: ['retained_id'] });
    expect(f.objects.get('retained_id')!.bytes).toEqual(request.bytes);
    expect(f.requests.map(value => [value.init.method ?? 'GET', value.url.pathname, value.url.searchParams.get('alt')])).toEqual([
      ['GET', '/drive/v3/files/root', null], ['GET', '/drive/v3/files/segments', null], ['POST', '/upload/drive/v3/files', null],
      ['GET', '/drive/v3/files/retained_id', null], ['GET', '/drive/v3/files/retained_id', 'media'],
    ]);
    expect(await f.transport.publish(binding, request, {})).toMatchObject({ outcome: 'already-present', references: ['retained_id'] });
    expect(f.requests.filter(value => value.url.pathname.endsWith('/generateIds'))).toHaveLength(0);
  });
  it('retains an unresolved accepted-create loss, then retries the same ID and confirms 409 only through exact read-back', async () => {
    const f = fixture(); const request = segmentRequest(); let createLost = false; let unavailable = true;
    f.hook(async ({ url, init }) => {
      if (init.method === 'POST' && !createLost) {
        createLost = true; f.store('retained_id', 'segment', 'segments', request.bytes); throw new Error('lost accepted response');
      }
      if (url.pathname.endsWith('/retained_id') && unavailable) return providerError(404, 'notFound');
    });
    await expect(f.transport.publish(binding, request, {})).rejects.toMatchObject({ code: 'unknown' });
    unavailable = false;
    expect(await f.transport.publish(binding, request, {})).toMatchObject({ outcome: 'already-present', bytes: request.bytes, references: ['retained_id'] });
    const creates = f.requests.filter(value => value.init.method === 'POST'); expect(creates).toHaveLength(2);
    for (const create of creates) expect(await (create.init.body as Blob).text()).toContain('"id":"retained_id"');
    expect(f.objects.size).toBe(4);
  });
  it('can resolve a lost create response by exact immediate fresh read-back', async () => {
    const f = fixture(); const request = segmentRequest();
    f.hook(({ init }) => { if (init.method === 'POST') { f.store('retained_id', 'segment', 'segments', request.bytes); throw new Error('lost accepted response'); } });
    expect(await f.transport.publish(binding, request, {})).toMatchObject({ outcome: 'already-present', references: ['retained_id'] });
  });
  it.each([200, 409])('HTTP %s without readable matching bytes remains unknown', async status => {
    const f = fixture(); f.hook(request => request.init.method === 'POST' ? json({}, status) : undefined);
    await expect(f.transport.publish(binding, segmentRequest(), {})).rejects.toMatchObject({ code: 'unknown' });
  });
  it('readable changed content, including semantically identical reformatting, is integrity failure', async () => {
    const f = fixture(); const request = segmentRequest(); f.store('retained_id', 'segment', 'segments', encodeUtf8(` ${new TextDecoder().decode(request.bytes)}`));
    await expect(f.transport.publish(binding, request, {})).rejects.toMatchObject({ code: 'integrity' });
  });
  it('wrong placement after 409 cannot confirm matching bytes', async () => {
    const f = fixture(); const request = segmentRequest(); f.store('retained_id', 'segment', 'other', request.bytes);
    await expect(f.transport.publish(binding, request, {})).rejects.toMatchObject({ code: 'integrity' });
  });
  it('a different metadata ID cannot confirm the retained publication', async () => {
    const f = fixture();
    f.hook(({ url, init }) => url.pathname.endsWith('/retained_id') && !url.searchParams.has('alt') && init.method !== 'POST'
      ? json({ id: 'other_id', mimeType: 'application/json', trashed: false }) : undefined);
    await expect(f.transport.publish(binding, segmentRequest(), {})).rejects.toMatchObject({ code: 'integrity' });
  });
  it('a truncated verification body remains unknown and cannot acknowledge a successful create', async () => {
    const f = fixture(); f.hook(request => isMedia(request) ? new Response('{', { headers: { 'Content-Length': '100' } }) : undefined);
    await expect(f.transport.publish(binding, segmentRequest(), {})).rejects.toMatchObject({ code: 'unknown' });
  });
  it('copies the original sealed bytes before asynchronous provider work', async () => {
    const f = fixture(); const request = segmentRequest(); const expected = Uint8Array.from(request.bytes);
    f.hook(({ url }) => { if (url.pathname.endsWith('/root')) request.bytes.fill(0); });
    expect((await f.transport.publish(binding, request, {})).bytes).toEqual(expected);
  });
  it('checks original dataset and segment identity before any content upload', async () => {
    const f = fixture(); await expect(f.transport.publish(binding, { ...segmentRequest(), segmentId: uuid(999) }, {})).rejects.toMatchObject({ code: 'integrity' });
    expect(f.requests.some(value => value.init.method === 'POST')).toBe(false);
  });
  it('cancellation of an attempted create remains unknown', async () => {
    const f = fixture(); const controller = new AbortController();
    f.hook(({ init }) => { if (init.method === 'POST') { controller.abort(); throw new Error('cancelled upload'); } });
    await expect(f.transport.publish(binding, segmentRequest(), { signal: controller.signal })).rejects.toMatchObject({ code: 'unknown' });
  });
});

const repositories: LocalRepository[] = [];
afterEach(() => { for (const repository of repositories.splice(0)) repository.close(); });
async function open(name: string = crypto.randomUUID()) {
  let first = true;
  const repository = await LocalRepository.open(name, () => { if (first) { first = false; return descriptor.datasetId; } return crypto.randomUUID(); });
  repositories.push(repository); await repository.initialize(); return repository;
}
describe('production adapter / runner / IndexedDB composition', () => {
  it('preserves durable unknown bytes/membership/handle through reopen and same-ID 409 recovery', async () => {
    const f = fixture(); let repository = await open(); const target = { ...binding, descriptor }; delete (target as Partial<Binding>).generation;
    await repository.remote().bind(target);
    let { active } = await repository.acquireOwner(crypto.randomUUID());
    active = await repository.saveActive(activePin(active), { ...active, id: crypto.randomUUID(), startedAt: stamp, state: 'paused', focusMs: 123 });
    await repository.finish(activePin(active), 123, stamp, 'Synthetic local');
    let accepted = false; let unreadable = true;
    f.hook(async ({ init, url }) => {
      if (init.method === 'POST' && !accepted) {
        accepted = true;
        const body = await (init.body as Blob).text(); const metadata = JSON.parse(body.split('\r\n\r\n')[1].split('\r\n')[0]);
        const bytes = encodeUtf8(body.split('Content-Type: application/json\r\n\r\n')[1].split('\r\n--')[0]);
        f.store(metadata.id, 'segment', 'segments', bytes); throw new Error('accepted response lost');
      }
      if (unreadable && url.pathname.includes('/generated_')) return providerError(404, 'notFound');
    });
    expect(await new SyncRunner(repository.remote(), f.transport).run()).toBe('Offline / Retry pending');
    const before = Object.values((await repository.remote().snapshot()).publications)[0];
    expect(before.state).toBe('unknown'); expect(before.retryHandle).toBe('generated_1');
    const name = repository.db.name; repository.close(); repository = await open(name); unreadable = false;
    expect(await new SyncRunner(repository.remote(), f.transport).run()).toBe('Synced');
    const snapshot = await repository.remote().snapshot(); const after = Object.values(snapshot.publications)[0];
    expect(after.state).toBe('acknowledged'); expect(after.retryHandle).toBe(before.retryHandle);
    expect(after.bytes).toEqual(before.bytes); expect(after.operationIds).toEqual(before.operationIds); expect(snapshot.outbox).toEqual({});
    expect(f.requests.filter(value => value.url.pathname.endsWith('/generateIds'))).toHaveLength(1);
    expect(f.requests.filter(value => value.init.method === 'POST')).toHaveLength(2);
  });
  it('discovers a concurrent omitted object in a later full scan and detects mutation under a known ID', async () => {
    const f = fixture(); const repository = await open(); await repository.remote().bind({ ...binding, descriptor });
    f.store('a', 'segment', 'segments', segment(1)); let first = true;
    f.hook(request => { if (isList(request) && first) { first = false; f.store('b', 'segment', 'segments', segment(2)); return json({ files: [{ id: 'a' }] }); } });
    const runner = new SyncRunner(repository.remote(), f.transport);
    expect(await runner.run()).toBe('Synced'); expect((await repository.view()).history).toHaveLength(1);
    expect(await runner.run()).toBe('Synced'); expect((await repository.view()).history).toHaveLength(2);
    f.objects.get('a')!.bytes = encodeUtf8(new TextDecoder().decode(segment(1)).replace('Synthetic 1', 'Mutated 1'));
    expect(await runner.run()).toBe('Recovery required');
    expect((await repository.view()).history).toHaveLength(2); expect(Object.values((await repository.remote().snapshot()).operations)).toHaveLength(2);
  });
});
