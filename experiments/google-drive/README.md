# Isolated Google Drive feasibility experiment

**Status: live web results recorded; GO WITH CHANGES for Web/PWA v1 feasibility.** The user supplied actual Google observations on 2026-10-19; see [the feasibility report's result matrix and provenance](../../docs/drive-feasibility-report.md). This remains a diagnostic page and raw Drive v3 helper, not a production `SyncTransport`, adapter, scheduler or final sync UI. Nothing imports it from the production application. Synthetic tests/local browser smoke remain separate from live observations. Native is **DEFERRED / NOT IN CURRENT WEB V1 SCOPE**.

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

## Reproduction procedures and current evidence

The procedures below support follow-up/reproduction; the report's W01–W14/N01 matrix defines established observations and limits. Evidence now includes the live summary and five [audited event exports](../../docs/drive-live-evidence-audit.md): 203 rows reduce to 144 unique records after overlapping snapshots are accounted for. These are client-side diagnostics, not a new managed-runtime Google execution. Correct-account revocation was confirmed as a separate outside-capture action. For future runs record safe registration/scope/account/phase and comparison details. Download events before reload: events are memory-only. Retained bytes/IDs persist locally; do not clear that storage while recovering an unknown publication.

| Experiment | Current evidence | Procedure / remaining boundary |
| --- | --- | --- |
| Official web creates corpus | **PROVEN:** JGTU created the corpus; incomplete-tree refusal also observed (W02/W06). | Authorize A, deliberately prepare/choose a new disposable intent, create folders, inspect incomplete tree, then publish/verify descriptor. No automatic candidate choice. |
| Other official web discovers/reads | **PROVEN WITH CONSTRAINT:** FG1U independently discovered/inspected JGTU's corpus and performed an exact-retained segment read (W02–W04); reverse FG1U publication → zero-intent JGTU listing/read is now also captured (W13). | Same project/account and exact `drive.file`; discovery had no supplied root ID per test context. The reverse read validates logical identity but has no retained original for exact comparison. |
| Revoke/reconsent | **PROVEN WITH CONSTRAINT:** user confirmed correct-account revocation/reconsent separately outside the exports; same corpus reopened (W12). | The captured revoke follows alternate-account authorization. Keep that source distinction and account/scope checks; no old revoked-token error or unattended renewal is established. |
| Clean profile | **PROVEN WITH CONSTRAINT:** zero retained intents, root/descriptor rediscovered, all six segments listed, a bounded segment read succeeded (W11). | Complete reads log digest and identity; no claim that all six were read/compared byte-for-byte. A digest is supplementary, not a production exact-byte integrity substitute. |
| Different account | **PROVEN WITH CONSTRAINT:** same web client saw zero candidates (W05). | Negative control for that account/query; do not infer known-ID denial or treat an empty scan as authority to recreate a bound root. |
| Official desktop/native | **DEFERRED / NOT IN CURRENT WEB V1 SCOPE.** | Only if a native client becomes an actual target: use its own official registration and supported native OAuth to repeat web/native discovery/read/publish interoperability before shipping it. No native OAuth flow is implemented here; never paste native credentials/tokens into this page. |

Root discovery uses public `properties` (`proof=focus-timer-drive-proof-v1`, `kind=root`) with `trashed=false`, never client-private `appProperties`. Markers restrict the disposable experiment and are only discovery hints. Exact descriptor validation establishes protocol identity. Name matching is never identity. Root inspection enumerates children completely, requires exactly one descriptor and one segment folder, checks their public marker/dataset identity and descriptor bytes, and rejects incomplete/ambiguous trees. It is inspection, not production hydration/binding.

Create two independent bootstrap intents, including in separate profiles, before publishing either descriptor to exercise concurrent attempts. They retain distinct generated IDs/dataset IDs. Scan before/during/after and record zero, one and multiple candidates. The page never elects a root, including after a single-result scan. A post-create scan exposes presently visible competing roots but proves neither global uniqueness nor a linearizable snapshot; delayed competing roots must be detected by later full scans. Resume an incomplete same intent with its original IDs. No missing-root response triggers recreation.

### Same-ID lost-response publication

1. Explicitly inspect a complete root. Prepare a synthetic segment and choose the retained publication. The generated Drive ID and exact valid segment bytes commit before upload; `generateIds` itself publishes no bytes.
2. Click **Create; discard accepted response**. The attempt is durably in-flight first. On a successful HTTP status the helper intentionally cancels/discards the response body and records unknown, without confirming. This is controlled client response loss after an accepted status, not an actual interrupted network trace. Reload here to test recovery if desired.
3. Reauthorize the same account if necessary. Choose the same retained publication. Click **Retry same ID; verify exact bytes**. Record the actual retry status/reason; a create success or conflict alone is never confirmation.
4. The helper reads fresh metadata and requires the retained ID, exact parent, `application/json`, non-trashed state and expected public proof properties. It refuses oversize metadata, performs a full bounded media GET, compares **every byte** to retained original UTF-8, then parses/compares dataset, segment and original writer identity. Only this path records confirmed. Wrong bytes/placement blocks; missing/inaccessible/delayed/interrupted read remains unknown.

Repeat with descriptor publication as appropriate. Root/segment folders have generated IDs before create and verify metadata after create/retry; no three-object atomicity is assumed. The generic runner's immutable reservation/acknowledgement state is deliberately absent. Unknown/in-flight experimental records remain resumable; a synthetic helper success does not establish that Google accepts caller-supplied generated IDs or how it reports duplicate creates.

**Reported live outcome (W07/W08):** retained generated IDs survived retry; the accepted-response-loss sequence retried the same ID, received **409**, and confirmed exact bytes/logical identity only after fresh metadata/media read-back. This resolves the prior publication feasibility question. Other interruption/reload/conflicting-content variants remain web integration acceptance coverage rather than inferred live successes.

### Listing, reads and errors

Create at least five segments in the disposable corpus. Start a full segment scan and click Next page; every list requests `pageSize=2` with no `orderBy`. Record opaque tokens and actual page sizes. Publish further prepared segments between page clicks, then run a later full scan. Compare unions; never interpret list order as operation order or a permanent frontier. Short/empty pages with tokens continue; `incompleteSearch=true` prevents completion. Automatic full scans cap at 100 pages and report incomplete rather than truncating to success. Invalid-continuation button uses a deliberately invalid token; rejection of this token does not prove real token expiration. Save a real token locally and resume after Google's documented validity period to test expiration separately. No API guarantee exists here that short/empty pages will be reproducible on demand.

**Reported live outcome (W09/W10):** `pageSize=2` produced **2 + 2 + 1**, finishing only at null continuation. A segment created during the scan was omitted and then found by a later full scan. Repeated full reconciliation is therefore necessary; neither snapshot enumeration nor a visibility deadline is established. No empty/short **continued** page or expired-token response was reported.

The exports corroborate these reference sets and additionally record an actual object-read **404 / `notFound`**, retained as missing-or-inaccessible (W14, E04 #28). Invalid-ID and inspect-before-scan guards, and clicking Next after completion, are local guard results; they are not failed authorization or rejected-page-token observations.

Explicit-object reads record fresh `size`, revision/version/checksum metadata, `isAppAuthorized`, capabilities and complete-byte SHA-256. Exact decimal int64 size above 1 MiB is refused before media; missing size still requires the independent streamed bound. Content-Length is only an early hint. Completed plain-body length mismatches, stream errors, partial HTTP 206 and Content-Range are rejected; chunks exceeding 1 MiB are cancelled. Complete EOF is required. No cached metadata bypasses byte reads. **Read and intentionally cancel** exercises local cancellation handling after a chunk, which may already contain a small complete response; the supplied live summary does not report this action or a real mid-network interruption.

Read immediately after publication, then later. Read a nonexistent ID and a known inaccessible ID; keep their 404 ambiguity. Test an insufficient grant separately from the deliberately wrong account (retained publication will be refused locally). For actual revocation/expiry HTTP behavior use developer-controlled session setup without logging or persisting tokens; this page usually refuses an expired in-memory token before issuing a request, so it cannot by itself claim an observed Google 401. Exercise a real connection interruption separately. Do not deliberately exhaust quotas or inject synthetic failures into the live-results ledger.

To test changed bytes under a known ID, create a separate disposable ordinary JSON fixture through an authorized test tool, record its original bounded bytes, alter it deliberately, and compare a later full read. This page provides no update/delete command and does not mutate immutable protocol segments. Actual stale-token errors, physical network failure, file revision mutation, token expiry, quota/server faults and a general visibility deadline were not reported. Keep their conservative handling in web acceptance coverage; do not relabel documentation/synthetic tests as live results. Native proof is deferred to a future actual native target. The helper's error labels are diagnostic, not a final production classifier: 404 may be missing or inaccessible, and a token-related 400 is only possible-invalid-continuation until diagnosed.

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

Original apparatus verification: syntax checks and the 17 named synthetic assertions passed, along with the local Chromium/IndexedDB smoke recorded in the parent report. The initial managed task had no live consent/access; the user's subsequent live evidence now closes the stated web feasibility questions with explicit constraints. It does not turn those synthetic checks into provider observations. No production adapter or sync UI has been implemented.
