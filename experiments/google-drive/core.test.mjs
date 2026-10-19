// SYNTHETIC ONLY: fetch/streams below are local fakes, never Google provider evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DriveProbe, ProofFailure, MAX_BYTES, DRIVE_FILE_SCOPE, PROOF_MARKER, boundedBody, pageState, encode,
  confirmExact, refuseOversizeMetadata, providerClassification, rootQuery, properties } from './core.mjs';

const datasetId = '11000000-0000-4000-8000-000000000001';
const segmentId = '33000000-0000-4000-8000-000000000001';
const text = JSON.stringify({ protocolVersion: 1, datasetId, deviceId: '22000000-0000-4000-8000-000000000001', segmentId,
  operations: [{ protocolVersion: 1, schemaVersion: 1, opId: '44000000-0000-4000-8000-000000000001', datasetId,
    deviceId: '22000000-0000-4000-8000-000000000001', entityType: 'focusSession', entityId: '55000000-0000-4000-8000-000000000001',
    operation: 'DELETE', lamportCounter: 1 }] });
const intent = { kind: 'segment', datasetId, segmentId, remoteId: 'generated_id', parent: 'segments_id', text };
const meta = () => ({ id: intent.remoteId, parents: [intent.parent], mimeType: 'application/json', trashed: false, properties: properties('segment', datasetId) });
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const errorIs = code => error => error instanceof ProofFailure && error.code === code;

test('synthetic: drive.file only and public-property discovery, no appProperties', () => {
  assert.equal(DRIVE_FILE_SCOPE, 'https://www.googleapis.com/auth/drive.file');
  assert.match(rootQuery(), /properties has/); assert.equal(rootQuery().includes('appProperties'), false);
  assert.equal(properties('root', datasetId).proof, PROOF_MARKER);
});
test('synthetic: short and empty continued pages are incomplete', () => {
  for (const files of [[], [{ id: 'one' }]]) assert.equal(pageState({ files, nextPageToken: 'opaque' }).complete, false);
  assert.deepEqual(pageState({ files: [] }), { files: [], continuation: null, complete: true, incompleteSearch: false });
});
test('synthetic: incompleteSearch cannot complete a full page sequence', () => {
  assert.equal(pageState({ files: [], incompleteSearch: true }).complete, false);
  assert.throws(() => pageState({ files: [], nextPageToken: 'x'.repeat(8193) }), errorIs('malformed-provider-page'));
});
test('synthetic: opaque token forwarded verbatim with no permanent frontier/order', async () => {
  let captured;
  const api = new DriveProbe(() => 'SYNTHETIC_TOKEN', async (url, options) => { captured = { url, options }; return json({ files: [], nextPageToken: 'next' }); });
  await api.list("'parent' in parents", 'opaque+token/=!?');
  const url = new URL(captured.url);
  assert.equal(url.searchParams.get('pageToken'), 'opaque+token/=!?'); assert.equal(url.searchParams.get('pageSize'), '2');
  assert.equal(url.searchParams.has('orderBy'), false); assert.equal(captured.options.cache, 'no-store');
  assert.equal(captured.options.headers.Authorization, 'Bearer SYNTHETIC_TOKEN');
});
test('synthetic: unknown length stream exceeding cap is cancelled', async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(8)); }, cancel() { cancelled = true; } });
  await assert.rejects(boundedBody(new Response(body), 4), errorIs('oversize')); assert.equal(cancelled, true);
});
test('synthetic: advertised oversize refuses before pulling content into accumulator', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Length': `${MAX_BYTES + 1}` } });
  await assert.rejects(boundedBody(response), errorIs('oversize')); assert.equal(cancelled, true);
});
test('synthetic: Content-Length cannot hide an oversized body or a truncated EOF', async () => {
  await assert.rejects(boundedBody(new Response(new Uint8Array(8), { headers: { 'Content-Length': '2' } }), 4), errorIs('oversize'));
  await assert.rejects(boundedBody(new Response(new Uint8Array(2), { headers: { 'Content-Length': '4' } }), 4), errorIs('incomplete-transfer'));
});
test('synthetic: stream error and intentional cancellation cannot become complete reads', async () => {
  const failed = new ReadableStream({ start(controller) { controller.error(new Error('never export private arbitrary message')); } });
  await assert.rejects(boundedBody(new Response(failed)), errorIs('incomplete-transfer'));
  await assert.rejects(boundedBody(new Response('bytes'), MAX_BYTES, { interruptAfterBytes: 1 }), errorIs('intentional-read-interruption'));
});
test('synthetic: fresh metadata refuses oversized decimal int64 without rounding; missing size still needs stream bound', () => {
  refuseOversizeMetadata({}); refuseOversizeMetadata({ size: `${MAX_BYTES}` });
  for (const size of [`${MAX_BYTES + 1}`, '900719925474099300000']) assert.throws(() => refuseOversizeMetadata({ size }), errorIs('oversize'));
  for (const size of [42, '-1', '1.5', '1e6', '01']) assert.throws(() => refuseOversizeMetadata({ size }), errorIs('malformed-provider-size'));
});
test('synthetic: unexpected partial status or content-range is rejected', async () => {
  for (const response of [new Response('prefix', { status: 206 }), new Response('prefix', { headers: { 'Content-Range': 'bytes 0-5/100' } })]) {
    const api = new DriveProbe(() => 'SYNTHETIC_TOKEN', async () => response);
    await assert.rejects(api.media('file'), errorIs('incomplete-transfer'));
  }
});
test('synthetic: same ID and exact bytes retry after discarded accepted response; conflict requires GET verification', async () => {
  const creates = []; let accepted = false; const requests = [];
  const api = new DriveProbe(() => 'SYNTHETIC_TOKEN', async (url, options) => {
    requests.push(url);
    if (options.method === 'POST') {
      const multipart = await options.body.text(); creates.push(multipart);
      if (accepted) return json({ error: { errors: [] } }, 409);
      accepted = true; return json({ id: intent.remoteId });
    }
    if (url.includes('alt=media')) return new Response(encode(text));
    return json(meta());
  });
  await assert.rejects(api.createBlob(intent, { discardAcceptedResponse: true }), errorIs('intentionally-lost-accepted-response'));
  const result = await api.retryAndVerify(intent);
  assert.equal(result.create.status, 409); assert.equal(result.exactBytes, true); assert.equal(result.logicalIdentity, true);
  assert.equal(creates.length, 2);
  for (const multipart of creates) { assert.ok(multipart.includes(`"id":"${intent.remoteId}"`)); assert.ok(multipart.includes(text)); }
  assert.ok(requests.some(url => url.includes('alt=media'))); assert.ok(requests.some(url => url.includes('fields=id,mimeType')));
});
test('synthetic: create success and conflict do not confirm unreadable content', async () => {
  for (const status of [200, 409]) {
    const api = new DriveProbe(() => 'SYNTHETIC_TOKEN', async (url, options) => {
      if (options.method === 'POST') return json({}, status);
      if (url.includes('alt=media')) return json({ error: { errors: [{ reason: 'notFound' }] } }, 404);
      return json(meta());
    });
    await assert.rejects(api.retryAndVerify(intent), errorIs('unknown-publication'));
  }
});
test('synthetic: exact-content comparison and logical segment identity are mandatory', () => {
  assert.equal(confirmExact(intent, encode(text)).logicalIdentity, true);
  assert.throws(() => confirmExact(intent, encode(`${text} `)), errorIs('integrity'));
  assert.throws(() => confirmExact({ ...intent, segmentId: datasetId }, encode(text)), errorIs('integrity'));
});
test('synthetic: wrong placement/type/trashed metadata blocks confirmation before media', async () => {
  for (const corrupt of [{ parents: ['wrong'] }, { mimeType: 'text/plain' }, { trashed: true }, { properties: {} }]) {
    let media = 0;
    const api = new DriveProbe(() => 'SYNTHETIC_TOKEN', async (url, options) => {
      if (options.method === 'POST') return json({});
      if (url.includes('alt=media')) { media++; return new Response(encode(text)); }
      return json({ ...meta(), ...corrupt });
    });
    await assert.rejects(api.retryAndVerify(intent), errorIs('integrity')); assert.equal(media, 0);
  }
});
test('synthetic: network interruption on POST remains unknown', async () => {
  const api = new DriveProbe(() => 'SYNTHETIC_TOKEN', async () => { throw new Error('private arbitrary detail'); });
  await assert.rejects(api.createBlob(intent), errorIs('unknown-publication'));
  await assert.rejects(api.media('file'), errorIs('network-interruption'));
});
test('synthetic: provider error details are whitelisted and credentials/messages omitted', async () => {
  const api = new DriveProbe(() => 'SYNTHETIC_SECRET', async () => json({ error: { message: 'SYNTHETIC_SECRET private history', errors: [{ reason: 'authError' }, { reason: 'private history' }] } }, 401));
  await assert.rejects(api.media('file'), error => {
    assert.equal(error.code, 'authorization'); assert.deepEqual(error.detail, { status: 401, reasons: ['authError'] });
    assert.equal(JSON.stringify(error).includes('SYNTHETIC_SECRET'), false); return true;
  });
});
test('synthetic: conservative classification retains missing/access and continuation ambiguity', () => {
  assert.equal(providerClassification(404, [], 'root'), 'missing-or-inaccessible-root');
  assert.equal(providerClassification(404), 'missing-or-inaccessible-object');
  assert.equal(providerClassification(400, ['badRequest'], 'continuation'), 'possible-invalid-continuation');
  assert.equal(providerClassification(403, ['insufficientPermissions']), 'authorization');
  assert.equal(providerClassification(403, ['insufficientFilePermissions']), 'access');
  for (const reason of ['storageQuotaExceeded', 'rateLimitExceeded', 'userRateLimitExceeded']) assert.equal(providerClassification(403, [reason]), 'retryable');
  assert.equal(providerClassification(409, [], 'publication'), 'unknown-publication');
});
