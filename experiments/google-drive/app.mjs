import { DriveProbe, ProofFailure, DRIVE_FILE_SCOPE, PROOF_MARKER, encode, confirmExact, refuseOversizeMetadata, rootQuery, childrenQuery } from './core.mjs';
import { openProofStore } from './storage.mjs';
import { parseDescriptor, parseSegment } from '../../src/protocol/index.js';

const $ = id => document.getElementById(id);
const events = [];
let token = null, expiresAt = 0, account = null, clientId = null, verifiedRoot = null, scan = null, authEpoch = 0;
let store;
const api = new DriveProbe(() => {
  if (Date.now() >= expiresAt) { token = null; throw new ProofFailure('authorization'); }
  return token;
});
function log(event, detail = {}) {
  // Callers provide only fixed diagnostic fields, never arbitrary exceptions/provider bodies.
  events.push({ at: new Date().toISOString(), event, ...detail });
  if (events.length > 500) events.shift();
  $('log').textContent = events.map(row => JSON.stringify(row)).join('\n');
}
function forget() { authEpoch++; token = null; expiresAt = 0; account = null; clientId = null; verifiedRoot = null; scan = null; $('status').textContent = 'Disconnected'; }
function needAccount() { if (!token || !account || Date.now() >= expiresAt) throw new ProofFailure('authorization'); }
function sameAccount(intent) { needAccount(); if (intent.account !== account) throw new ProofFailure('wrong-account-for-retained-intent'); }
function currentRoot() { needAccount(); if (!verifiedRoot || verifiedRoot.account !== account) throw new ProofFailure('inspect-complete-root-first'); return verifiedRoot; }
async function save(record) { await store.put(record); return record; }
async function getIntent(select) {
  const result = (await store.all()).find(record => record.id === $(select).value);
  if (!result) throw new ProofFailure('select-retained-intent');
  sameAccount(result); return result;
}
async function refresh() {
  const intents = await store.all();
  for (const [id, kind] of [['rootIntent', 'bootstrap'], ['publication', 'segment']]) {
    const previous = $(id).value; $(id).replaceChildren(new Option('Choose explicitly', ''));
    for (const row of intents.filter(row => row.kind === kind)) $(id).add(new Option(`${row.datasetId} / ${row.id} / ${row.state}`, row.id));
    $(id).value = previous;
  }
  log('retained-intents', { count: intents.length, ids: intents.map(row => ({ id: row.id, kind: row.kind, state: row.state })) });
}
async function fullScan(q) {
  const files = new Map(); let continuation = null, incomplete = false;
  for (let pageNumber = 1; pageNumber <= 100; pageNumber++) {
    const page = await api.list(q, continuation);
    log('list-page', { pageNumber, count: page.files.length, continuation: page.continuation, complete: page.complete, incompleteSearch: page.incompleteSearch });
    for (const row of page.files) files.set(row.id, row);
    incomplete ||= page.incompleteSearch;
    if (page.continuation === null) return { files: [...files.values()], complete: page.complete && !incomplete };
    continuation = page.continuation;
  }
  throw new ProofFailure('scan-page-cap-incomplete');
}
function summaries(files) { return files.map(row => ({ id: row.id, mimeType: row.mimeType, size: row.size })); }
async function inspectRoot(id) {
  needAccount(); verifiedRoot = null; scan = null;
  const meta = await api.metadata(id, 'root');
  if (meta.trashed || meta.mimeType !== 'application/vnd.google-apps.folder' || meta.properties?.proof !== PROOF_MARKER || meta.properties.kind !== 'root') throw new ProofFailure('not-a-proof-root');
  const children = await fullScan(childrenQuery(id));
  const descriptors = children.files.filter(row => row.properties?.proof === PROOF_MARKER && row.properties.kind === 'descriptor');
  const folders = children.files.filter(row => row.properties?.proof === PROOF_MARKER && row.properties.kind === 'segments' && row.mimeType === 'application/vnd.google-apps.folder');
  log('root-shape', { rootId: id, completeScan: children.complete, descriptorCount: descriptors.length, segmentFolderCount: folders.length });
  if (!children.complete || descriptors.length !== 1 || folders.length !== 1) throw new ProofFailure('incomplete-or-ambiguous-root');
  const bytes = await api.media(descriptors[0].id);
  const descriptor = parseDescriptor(bytes);
  if ([meta, descriptors[0], folders[0]].some(row => row.properties.datasetId !== descriptor.datasetId)) throw new ProofFailure('root-identity-mismatch');
  verifiedRoot = { account, rootId: id, descriptorId: descriptors[0].id, segmentsId: folders[0].id, datasetId: descriptor.datasetId };
  log('explicit-root-inspected', { ...verifiedRoot, descriptorBytes: bytes.byteLength, clientId });
  return verifiedRoot;
}
async function ensureFolder(id, parent, kind, datasetId) {
  let outcome;
  try { await api.createFolder(id, parent, kind, datasetId); outcome = 'create-returned'; }
  catch (error) { outcome = error.code ?? 'unclassified'; log('folder-create-response', { remoteId: id, outcome, ...error.detail }); }
  const meta = await api.metadata(id, kind === 'root' ? 'root' : 'object');
  if (meta.trashed || meta.mimeType !== 'application/vnd.google-apps.folder' || meta.properties?.proof !== PROOF_MARKER || meta.properties.kind !== kind || meta.properties.datasetId !== datasetId
    || (parent && (!Array.isArray(meta.parents) || meta.parents.length !== 1 || meta.parents[0] !== parent))) throw new ProofFailure('folder-integrity');
  log('folder-verified', { remoteId: id, kind, create: outcome });
}
function fixture(datasetId) {
  const deviceId = crypto.randomUUID(), segmentId = crypto.randomUUID(), entityId = crypto.randomUUID();
  const text = JSON.stringify({ protocolVersion: 1, datasetId, deviceId, segmentId, operations: [{ protocolVersion: 1, schemaVersion: 1,
    opId: crypto.randomUUID(), datasetId, deviceId, entityType: 'focusSession', entityId, operation: 'UPSERT', lamportCounter: 1,
    payload: { id: entityId, startedAt: '2026-10-18T12:00:00.000Z', endedAt: '2026-10-18T12:00:01.000Z', focusDurationMs: 1000, description: 'Disposable Drive proof fixture.' } }] });
  parseSegment(encode(text)); return { text, segmentId };
}
const actions = {
  connect() {
    forget();
    const epoch = authEpoch;
    const selected = $($('client').value).value.trim();
    if (!/^[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$/.test(selected)) throw new ProofFailure('public-web-client-id-required');
    if (!globalThis.google?.accounts?.oauth2) throw new ProofFailure('google-identity-script-not-ready');
    const oauth = google.accounts.oauth2.initTokenClient({ client_id: selected, scope: DRIVE_FILE_SCOPE, include_granted_scopes: false,
      callback: async response => {
        if (epoch !== authEpoch) return;
        try {
          if (response.error) throw new ProofFailure('authorization-denied');
          const scopes = (response.scope ?? '').split(/\s+/).filter(Boolean);
          if (scopes.length !== 1 || scopes[0] !== DRIVE_FILE_SCOPE || !google.accounts.oauth2.hasGrantedAllScopes(response, DRIVE_FILE_SCOPE)) throw new ProofFailure('unexpected-granted-scopes');
          if (typeof response.access_token !== 'string' || !Number.isFinite(Number(response.expires_in)) || Number(response.expires_in) <= 0) throw new ProofFailure('invalid-token-response');
          const candidateToken = response.access_token, candidateExpiresAt = Date.now() + Number(response.expires_in) * 1000;
          const verifiedAccount = await new DriveProbe(() => candidateToken).account();
          if (epoch !== authEpoch) return;
          token = candidateToken; expiresAt = candidateExpiresAt; clientId = selected; account = verifiedAccount;
          $('status').textContent = 'Authorized for this diagnostic session';
          log('authorized', { clientId, account, scopes });
        } catch (error) { if (epoch === authEpoch) { forget(); log('authorization-failed', { code: error instanceof ProofFailure ? error.code : 'authorization-unavailable' }); } }
      }, error_callback: () => { if (epoch === authEpoch) { forget(); log('authorization-popup-failed'); } } });
    oauth.requestAccessToken({ prompt: 'select_account' });
  },
  disconnect() { forget(); log('token-forgotten'); },
  revoke() {
    needAccount(); const value = token;
    google.accounts.oauth2.revoke(value, () => log('revocation-callback-received'));
    forget(); log('revocation-requested-token-forgotten');
  },
  async roots() {
    needAccount(); verifiedRoot = null;
    const result = await fullScan(rootQuery());
    log('root-candidates-no-selection', { count: result.files.length, complete: result.complete, candidates: summaries(result.files), clientId, account });
  },
  async inspect() { await inspectRoot($('rootId').value.trim()); },
  async prepareRoot() {
    needAccount(); const datasetId = crypto.randomUUID();
    const [rootId, segmentsId, descriptorId] = await api.generateIds(3);
    const text = JSON.stringify({ application: 'focus-timer', protocolVersion: 1, datasetId }); parseDescriptor(encode(text));
    const row = await save({ id: crypto.randomUUID(), kind: 'bootstrap', account, clientId, datasetId, rootId, segmentsId, descriptorId, text, state: 'prepared' });
    log('bootstrap-intent-durable-no-content-created', { id: row.id, datasetId, rootId, segmentsId, descriptorId }); await refresh();
  },
  async folders() {
    const row = await getIntent('rootIntent');
    await save({ ...row, state: 'folders-in-flight' });
    await ensureFolder(row.rootId, null, 'root', row.datasetId);
    await ensureFolder(row.segmentsId, row.rootId, 'segments', row.datasetId);
    await save({ ...row, state: 'folders-verified-descriptor-missing' });
    log('partial-bootstrap-created', { rootId: row.rootId }); await refresh();
  },
  async descriptor() {
    const row = await getIntent('rootIntent');
    await ensureFolder(row.rootId, null, 'root', row.datasetId); await ensureFolder(row.segmentsId, row.rootId, 'segments', row.datasetId);
    await save({ ...row, state: 'descriptor-in-flight' });
    const result = await api.retryAndVerify({ kind: 'descriptor', remoteId: row.descriptorId, parent: row.rootId, text: row.text, datasetId: row.datasetId });
    await save({ ...row, state: 'descriptor-exact-verified' }); log('descriptor-confirmed', { rootId: row.rootId, ...result });
    // A scan can reveal concurrent roots but does not elect or establish global uniqueness.
    const candidates = await fullScan(rootQuery()); log('post-bootstrap-candidates-no-selection', { count: candidates.files.length, complete: candidates.complete, candidates: summaries(candidates.files) });
    await refresh();
  },
  async prepareSegment() {
    const root = currentRoot(); const [remoteId] = await api.generateIds(1); const content = fixture(root.datasetId);
    const row = await save({ id: content.segmentId, kind: 'segment', account, clientId, ...root, ...content, remoteId, parent: root.segmentsId, state: 'prepared' });
    log('segment-intent-durable-no-content-created', { id: row.id, remoteId, bytes: encode(row.text).byteLength }); await refresh();
  },
  async lose() {
    const row = await getIntent('publication'); await save({ ...row, state: 'in-flight' });
    try { await api.createBlob(row, { discardAcceptedResponse: true }); }
    catch (error) {
      await save({ ...row, state: 'unknown' }); log('publication-unconfirmed', { remoteId: row.remoteId, code: error.code ?? 'unclassified', ...error.detail });
    }
    await refresh();
  },
  async retry() {
    const row = await getIntent('publication'); await save({ ...row, state: 'in-flight' });
    try {
      const result = await api.retryAndVerify(row); await save({ ...row, state: 'exact-readback-confirmed' });
      log('publication-confirmed-after-exact-readback', { remoteId: row.remoteId, segmentId: row.segmentId, clientId, ...result });
    } catch (error) { await save({ ...row, state: error.code === 'integrity' ? 'integrity' : 'unknown' }); throw error; }
    finally { await refresh(); }
  },
  startScan() { const root = currentRoot(); scan = { account: root.account, rootId: root.rootId, segmentsId: root.segmentsId,
    q: childrenQuery(root.segmentsId), token: null, page: 0, incomplete: false, done: false }; log('fresh-scan-started'); },
  async nextPage() {
    const root = currentRoot(); if (!scan || scan.done) throw new ProofFailure('start-a-fresh-scan');
    if (scan.account !== root.account || scan.rootId !== root.rootId || scan.segmentsId !== root.segmentsId) throw new ProofFailure('scan-target-changed');
    const page = await api.list(scan.q, scan.token); scan.page++; scan.incomplete ||= page.incompleteSearch; scan.token = page.continuation; scan.done = page.continuation === null;
    log('manual-scan-page', { page: scan.page, files: summaries(page.files), continuation: page.continuation, incompleteSearch: page.incompleteSearch, complete: scan.done && page.complete && !scan.incomplete });
  },
  async secondScan() { const root = currentRoot(); const result = await fullScan(childrenQuery(root.segmentsId)); log('later-full-scan', { files: summaries(result.files), complete: result.complete }); },
  async badCursor() { const root = currentRoot(); await api.list(childrenQuery(root.segmentsId), 'deliberately-invalid-proof-page-token'); log('invalid-probe-unexpectedly-accepted'); },
  async read() {
    needAccount(); const id = $('readId').value.trim(), metadata = await api.metadata(id);
    log('read-metadata', { id, size: metadata.size, version: metadata.version, headRevisionId: metadata.headRevisionId, md5Checksum: metadata.md5Checksum, sha1Checksum: metadata.sha1Checksum, sha256Checksum: metadata.sha256Checksum, isAppAuthorized: metadata.isAppAuthorized, trashed: metadata.trashed, capabilities: metadata.capabilities });
    refuseOversizeMetadata(metadata);
    const bytes = await api.media(id);
    const retained = (await store.all()).find(row => row.remoteId === id);
    let validation = 'not-classified', identity = {};
    if (retained) { confirmExact(retained, bytes); validation = 'exact-retained-segment'; }
    try {
      const parsed = parseSegment(bytes); identity = { datasetId: parsed.datasetId, segmentId: parsed.segmentId, deviceId: parsed.deviceId };
    } catch { try { const parsed = parseDescriptor(bytes); identity = { datasetId: parsed.datasetId }; } catch { /* Unclassified fixture is read, never accepted. */ } }
    if (!retained) validation = identity.segmentId ? 'valid-segment' : identity.datasetId ? 'valid-descriptor' : 'not-a-valid-v1-artifact';
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const sha256 = [...digest].map(value => value.toString(16).padStart(2, '0')).join('');
    log('bounded-complete-read', { id, byteLength: bytes.byteLength, validation, sha256, ...identity, clientId, account });
  },
  async interrupt() { needAccount(); await api.media($('readId').value.trim(), { interruptAfterBytes: 1 }); log('interruption-not-observed'); },
  refresh,
  export() {
    const blob = new Blob([JSON.stringify({ experiment: PROOF_MARKER,
      evidence: 'Diagnostic event log; provider provenance and official-client acceptance require verified registration context.', events }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = 'focus-timer-drive-proof-events.json'; a.click(); URL.revokeObjectURL(url);
  },
};
for (const [id, action] of Object.entries(actions)) $(id).addEventListener('click', async () => {
  // Disable controls until the durable diagnostic action ends; no queued account switch.
  const buttons = [...document.querySelectorAll('button')]; buttons.forEach(button => { button.disabled = true; });
  try { if (!store) throw new ProofFailure('experimental-storage-unavailable'); await action(); }
  catch (error) { log('action-failed', { action: id, code: error instanceof ProofFailure ? error.code : 'local-or-unclassified-failure', ...(error instanceof ProofFailure ? error.detail : {}) }); }
  finally { buttons.forEach(button => { button.disabled = false; }); }
});
try { store = await openProofStore(); await refresh(); }
catch { log('experimental-storage-unavailable'); }
