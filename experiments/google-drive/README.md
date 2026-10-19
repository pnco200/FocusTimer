# Isolated Google Drive feasibility experiment

**Status: runnable experiment; live Google results remain pending.** This is a diagnostic page and raw Drive v3 helper, not a production `SyncTransport`, sync adapter, scheduler or final sync UI. Nothing imports it from the production application. Read the provider research, authoritative documentation and unresolved decision gate in [the feasibility report](../../docs/drive-feasibility-report.md). Synthetic tests and local HTTP/browser smoke results must never be entered as Google observations.

The experiment uses Google Identity Services' **browser token model**, requests only `https://www.googleapis.com/auth/drive.file` with `include_granted_scopes: false`, and rejects a response whose actual granted scopes differ. It uses no client secret, refresh token, backend, Picker, broad Drive scope, mutable manifest or application data folder. A failure of narrow-scope cross-client access is a stop condition for the architectural decision; this experiment never requests broader access.

## Run

From the repository root, start a separate loopback origin:

```sh
python3 experiments/google-drive/serve.py
```

Open `http://127.0.0.1:8765/experiments/google-drive/`. Register **exactly** `http://127.0.0.1:8765` as an authorized JavaScript origin for each official web OAuth client under test. Use the project's actual public web client IDs and a deliberately chosen disposable test account. Configure the project's consent screen/test users as Google requires. Desktop OAuth client IDs are not browser GIS client IDs and must not be pasted into this page.

Port 8765 is intentionally separate from the production app, its IndexedDB origin and service worker. Stop any unrelated service worker previously registered on this diagnostic origin before use. `serve.py` binds only loopback and returns `Cache-Control: no-store`; the page registers no service worker. Serve from the repository root because the page imports the existing pure protocol validators. No production repository or runner is imported.

All remote writes are caused by explicit buttons. The page creates only synthetic, disposable test data and never reads the user's local Focus Timer database. Generated Drive IDs, exact synthetic UTF-8 text, original protocol identities, source client/account identifiers and intent state are committed in dedicated database `focus-timer-google-drive-proof-v1` before content create. A transaction must complete before a network write. IndexedDB strict durability is requested; it is not a promise against eviction, physical failure or deliberate clearing.

Tokens remain in JavaScript memory, are sent only in the Drive Authorization header, and are excluded from URLs, IndexedDB, diagnostics and downloaded evidence. Disconnect/reload forgets them. Authorization attempts use a generation fence and per-attempt token for account lookup so an old popup callback cannot reconnect after disconnect. The actual `about.user.permissionId` pins retained intents to the test account; another account cannot publish them. Public client IDs are not secrets. Diagnostic exports include account permission IDs, Drive IDs, checksums and opaque page tokens: keep them local and redact identifiers before sharing. No file descriptions, content bytes, arbitrary exceptions or provider error messages are logged/exported.

## Required live observations

Every row below is **pending** until executed against Google with the official registrations. Record date, browser/platform, project/registration aliases, consent mode, actual returned scopes, test-account alias, relevant request method/status/reason, logical identities and bounded evidence. Download events before reload: events are memory-only. Retained exact bytes/IDs persist locally; clearing origin storage removes that evidence and must never be done while recovering an unknown publication.

| Experiment | Procedure and acceptance evidence |
| --- | --- |
| Official A creates corpus | Authorize client A; run Full root scan; deliberately Prepare a NEW disposable dataset intent. Explicitly choose that local intent. Create folders only; scan and inspect its root ID to observe incomplete status. Publish descriptor and verify. Copy its root ID into the root field and explicitly inspect again. No candidate is auto-selected. |
| Official B discovery and reads | Forget token; authorize official client B with the same account. Full root scan must independently discover A's root. Explicitly inspect A's root. Read A's descriptor and every published segment by ID. Record `isAppAuthorized` as an observation, not a substitute for successful list/media access. Also prepare/publish a B segment and prove A can discover/read it. A known-ID read and discoverability are separate proof obligations. |
| Same client reconnect | Forget token; reauthorize A. Prove discovery and reads after a new access token. Repeat after authorization revocation and reconsent, with account identity and actual scope checked again. Revocation is deliberate and may affect other official clients' grant; record it. |
| Reinstall / clean browser | Use a fresh profile with no experimental IndexedDB; authorize B, do not supply the root locator initially, and prove root discovery plus descriptor/segment reads. Then test a retained locator separately. Complete reads record SHA-256 and parsed dataset/segment/writer IDs for comparison with A. A digest comparison supplements evidence; it does not replace an exact original-byte comparator or establish production integrity. |
| Official desktop/native | Use an actual official installed-app OAuth registration in the same project and Google's supported native authorization flow; request only `drive.file`. Independently list the public-property query and read A/B descriptor and segment IDs; publish a disposable segment and have A/B read it. Never put native credentials or access tokens into this page. No native client credential/flow is implemented here. |
| Distinct official client IDs | Record source and reader OAuth registration aliases/types and same-account permission ID for every direction. A shared project identifier alone is not a pass. If an official registration cannot list/read the corpus, stop; do not expand scope. |

Root discovery uses public `properties` (`proof=focus-timer-drive-proof-v1`, `kind=root`) with `trashed=false`, never client-private `appProperties`. Markers restrict the disposable experiment and are only discovery hints. Exact descriptor validation establishes protocol identity. Name matching is never identity. Root inspection enumerates children completely, requires exactly one descriptor and one segment folder, checks their public marker/dataset identity and descriptor bytes, and rejects incomplete/ambiguous trees. It is inspection, not production hydration/binding.

Create two independent bootstrap intents, including in separate profiles, before publishing either descriptor to exercise concurrent attempts. They retain distinct generated IDs/dataset IDs. Scan before/during/after and record zero, one and multiple candidates. The page never elects a root, including after a single-result scan. A post-create scan exposes presently visible competing roots but proves neither global uniqueness nor a linearizable snapshot; delayed competing roots must be detected by later full scans. Resume an incomplete same intent with its original IDs. No missing-root response triggers recreation.

### Same-ID lost-response publication

1. Explicitly inspect a complete root. Prepare a synthetic segment and choose the retained publication. The generated Drive ID and exact valid segment bytes commit before upload; `generateIds` itself publishes no bytes.
2. Click **Create; discard accepted response**. The attempt is durably in-flight first. On a successful HTTP status the helper intentionally cancels/discards the response body and records unknown, without confirming. This is controlled client response loss after an accepted status, not an actual interrupted network trace. Reload here to test recovery if desired.
3. Reauthorize the same account if necessary. Choose the same retained publication. Click **Retry same ID; verify exact bytes**. Record the actual retry status/reason; a create success or conflict alone is never confirmation.
4. The helper reads fresh metadata and requires the retained ID, exact parent, `application/json`, non-trashed state and expected public proof properties. It refuses oversize metadata, performs a full bounded media GET, compares **every byte** to retained original UTF-8, then parses/compares dataset, segment and original writer identity. Only this path records confirmed. Wrong bytes/placement blocks; missing/inaccessible/delayed/interrupted read remains unknown.

Repeat with descriptor publication as appropriate. Root/segment folders have generated IDs before create and verify metadata after create/retry; no three-object atomicity is assumed. The generic runner's immutable reservation/acknowledgement state is deliberately absent. Unknown/in-flight experimental records remain resumable; a synthetic helper success does not establish that Google accepts caller-supplied generated IDs or how it reports duplicate creates.

### Listing, reads and errors

Create at least five segments in the disposable corpus. Start a full segment scan and click Next page; every list requests `pageSize=2` with no `orderBy`. Record opaque tokens and actual page sizes. Publish further prepared segments between page clicks, then run a later full scan. Compare unions; never interpret list order as operation order or a permanent frontier. Short/empty pages with tokens continue; `incompleteSearch=true` prevents completion. Automatic full scans cap at 100 pages and report incomplete rather than truncating to success. Invalid-continuation button uses a deliberately invalid token; rejection of this token does not prove real token expiration. Save a real token locally and resume after Google's documented validity period to test expiration separately. No API guarantee exists here that short/empty pages will be reproducible on demand.

Explicit-object reads record fresh `size`, revision/version/checksum metadata, `isAppAuthorized`, capabilities and complete-byte SHA-256. Exact decimal int64 size above 1 MiB is refused before media; missing size still requires the independent streamed bound. Content-Length is only an early hint. Completed plain-body length mismatches, stream errors, partial HTTP 206 and Content-Range are rejected; chunks exceeding 1 MiB are cancelled. Complete EOF is required. No cached metadata bypasses byte reads. **Read and intentionally cancel** proves local cancellation handling after a chunk, which may already contain a small complete response; it is not evidence of a real mid-network interruption.

Read immediately after publication, then later. Read a nonexistent ID and a known inaccessible ID; keep their 404 ambiguity. Test an insufficient grant separately from the deliberately wrong account (retained publication will be refused locally). For actual revocation/expiry HTTP behavior use developer-controlled session setup without logging or persisting tokens; this page usually refuses an expired in-memory token before issuing a request, so it cannot by itself claim an observed Google 401. Exercise a real connection interruption separately. Do not deliberately exhaust quotas or inject synthetic failures into the live-results ledger.

To test changed bytes under a known ID, create a separate disposable ordinary JSON fixture through an authorized test tool, record its original bounded bytes, alter it deliberately, and compare a later full read. This page intentionally provides no update/delete command and does not mutate immutable protocol segments. Native authorization, actual stale-token requests, real network failure, file revision mutation, delayed visibility, expired page token, quotas and temporary Google server failures therefore remain manual/documentary probes until separately observed. The helper's error labels are diagnostic hypotheses, not the final generic transport mapping; preserve provider status/reasons and consult the report. A 404 cannot distinguish missing from inaccessible; a 400 on a token request is only possible-invalid-continuation unless its cause is established.

## Local verification

```sh
node --test --test-isolation=none experiments/google-drive/core.test.mjs
node --check experiments/google-drive/app.mjs
node --check experiments/google-drive/storage.mjs
```

The explicit in-process Node test option gives actual named assertions in this managed runtime (default process isolation reported only a file-wrapper result). The synthetic tests cover bounded transfer/truncation/cancellation, opaque empty/short pagination, incomplete-search status, same-ID multipart retry after discarded accepted response, exact bytes/identity/placement confirmation, unreadable outcomes and redacted conservative errors. They cannot prove Google behavior, GIS consent, native OAuth or cross-client authorization.

An optional real-browser local smoke uses synthetic GIS and intercepted HTTP responses, actual Chromium and actual IndexedDB. Start the loopback server first, then:

```sh
PROOF_CHROMIUM_PATH=/absolute/path/to/chromium node experiments/google-drive/browser-smoke.mjs
```

That check is also **synthetic**, even though its browser/IndexedDB execution is real. Its source documents the exact scenarios and asserts no token is retained. It does not contact Google for authorization or storage.

Implementation verification during this phase: the syntax checks above passed; the isolated named Node assertions passed. The parent feasibility report records final test counts and browser smoke results after review. No live Google account, official client registration, access token, refresh token, project secret or live API result was available to this task. All provider acceptance rows remain pending until real evidence closes them.
