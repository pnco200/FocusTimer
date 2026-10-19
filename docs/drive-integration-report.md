# Web/PWA Google Drive integration

Implemented 2026-10-19 against SPEC Draft v3, the production SyncTransport/SyncRunner and IndexedDB reports, UI guidelines, and the authoritative **GO WITH CHANGES** feasibility decision and live evidence. Native/desktop interoperability remains deferred. No protocol, reducer, wire format, existing runner algorithm or database schema version changed.

**Implementation and automated validation are complete. Release acceptance is pending the real Google checks below.** Automated provider faults and browser routes are synthetic evidence, not additional observations from Google or the user's accounts.

## Composition and durable behavior

`GoogleDriveTransport` implements the existing SyncTransport. `GoogleDriveSync` coordinates user authorization/bootstrap and invokes the existing production asynchronous `SyncRunner` over `RemoteRepository`. It contains no replacement publication, receive, acknowledgement or synchronization status state machine. Product labels translate the repository's durable status/error categories. All network calls happen between completed repository transactions.

The app supports explicit creation/selection, manual Sync, foreground/online opportunities, locally committed history changes and a 60-second opportunity while the page is alive. Network work never blocks local timer commands. There is no background authorization, silent renewal, service-worker sync or closed-PWA execution claim.

Creation allocates three Drive IDs, atomically retains the winning account/locator/descriptor/exact-byte intent in existing `meta` storage, then creates root, segments folder and complete descriptor. Competing tabs reuse the first committed IDs. Every component requires fresh placement/properties verification; the descriptor also requires exact bytes and logical identity. Incomplete trees are shown, never bound as empty histories. An interrupted explicit creation retries its retained IDs; a missing retained binding is never automatically recreated.

Discovery consumes every opaque page, including short/empty continued pages. Public `properties.proof=focus-timer-drive-proof-v1`, `kind` and `datasetId` preserve compatibility with the validated feasibility corpus; they are discovery hints and expected metadata, not authentication or identity authority. Closed descriptor content supplies dataset identity. Names are labels only. Even a sole ready candidate requires deliberate selection. Multiple roots, same-dataset copies, incomplete trees, malformed/unsupported descriptors, unreadable candidates and incomplete searches stay visible/unresolved. Reconnect validates every pinned component directly as well as checking the child mapping; an omitted search result cannot replace a retained locator.

Joining another dataset durably stages a plan and a scoped instance of the existing RemoteRepository. The source stays selected and usable during hydration through the existing runner with publication disabled. Scoped repositories reject publication transitions. Atomic idle cutover reads the latest source/target journals, keeps target values/tombstones, creates target UPSERTs only for currently visible source IDs unknown to the target, and switches selection with active revision fencing. Source deletions during hydration therefore do not create provisional target operations. Source tombstones are never transplanted. The complete source, including pending work, remains available as a full archive under Sync options → Previous histories. Cancellation/reload retains hydration progress; restarting setup uses the pinned account/location. Unsupported account/location transfer and automatic copy consolidation remain outside this phase.

The existing runner/repository retain reserved membership, sealed bytes, original writers, generated retry handles, unknown/in-flight attempts, pending downloads and exact acknowledgement membership across cancellation/reload/reconnect. Publication confirms only after current metadata/media verification. An accepted response lost before confirmation may resolve immediately by read-back or remain unknown; its later retry uses the same ID and handles 409 by exact read-back. No successful status or conflict alone acknowledges work.

Access/missing-object/root failures require an explicit same-account/location reconnect. After validating the tree, recovery clears the recoverable block through the existing binding transition and runs a receive-only verification pass before any publication resumes. A changed known object re-blocks as integrity. Reconnect/disconnect cannot silently clear malformed/unsupported/integrity blocks. A later full pass can discover objects omitted by an earlier completed scan.

## Authorization and security

- GIS token popup starts directly from the user's button gesture after loading the public GIS library. The only requested scope is `https://www.googleapis.com/auth/drive.file`; `include_granted_scopes:false` and exact returned-scope validation reject insufficient or broader grants.
- `about.get?fields=user(permissionId)` verifies the actual Drive account without email/profile scopes. Retained bindings, creation intents and join plans pin that account. OAuth client IDs are public build configuration, not credentials.
- Access tokens live only in the authorization instance and outstanding request closures. There are no codes/refresh tokens, backend, client secret, Picker, appDataFolder or fallback remote store. Clear/reload/expiry invalidates credential accessors. An authorization rejection clears the in-memory grant and stops automatic opportunities until explicit reconnect. Stale GIS/account callbacks and async bootstrap boundaries check local execution and durable binding/source generations.
- Requests use Authorization headers, `cache:no-store`, `credentials:omit` and `redirect:error`. Tokens are absent from URLs, IDB, archives, exports and routine errors. Bounded provider error parsing retains only typed categories; arbitrary provider messages/private bodies are discarded. There is no new logging/telemetry.
- The existing service worker remains restricted to same-origin public shell assets. Cross-origin GIS/Google API requests are never cached. The production bundle contains no feasibility harness, test transport, MemoryStore, synthetic token or browser test global.
- Bounded stream reads enforce actual decoded bytes independently of metadata and Content-Length. Interrupted/partial/inconsistent transfers remain retryable; complete oversize is bounded evidence. Exact known-original comparison detects mutation. Browser buffering/compression behavior is still subject to actual runtime acceptance; a streaming cap is not a universal hardware-memory claim.

Google references checked during implementation: [GIS JavaScript token API](https://developers.google.com/identity/oauth2/web/reference/js-reference), [Drive about.get](https://developers.google.com/workspace/drive/api/reference/rest/v3/about/get). The existing [API evidence notes](drive-api-evidence.md) remain the authoritative operation/retry/pagination research record; implementation does not reopen feasibility.

## Exact Drive operation mapping

| SyncTransport operation | Drive API operations and confirmation |
| --- | --- |
| `readDescriptor` | Fresh `GET /drive/v3/files/{rootId}`, `{segmentsId}`, `{descriptorId}` metadata with selected fields; validate IDs/type/public properties/placement/trash state; complete bounded `GET /drive/v3/files/{descriptorId}?alt=media`. Descriptor-media 404 maps to missing-dataset. Existing runner parses/compares descriptor. |
| `enumerate` | Validate pinned root/segments metadata, then `GET /drive/v3/files?q='<segmentsId>' in parents and trashed=false&spaces=drive&corpora=user&pageSize=100&fields=nextPageToken,incompleteSearch,files(...)`. Every nextPageToken stays opaque in a local account/locator/dataset context. No ordering/snapshot/frontier assumption. `incompleteSearch` never completes a pass. |
| `read` | Fresh `GET /drive/v3/files/{reference}` metadata; require correct segment parent/MIME/public properties/non-trashed ID; complete bounded `GET .../{reference}?alt=media`. No absence becomes domain DELETE. Existing repository compares known originals and validates all operations atomically. |
| `preparePublication` | `GET /drive/v3/files/generateIds?count=1&space=drive&type=files`. Returns only the generated remote identity; publishes no content. Existing runner durably retains it before upload. |
| `publish` | Validate folders; `POST /upload/drive/v3/files?uploadType=multipart&fields=id` with retained generated ID, correct parent/properties and exact sealed JSON bytes in one complete multipart request. Following 2xx, 409 or ambiguous acceptance, require fresh metadata + complete bounded media at that exact ID, exact byte equality and dataset/segment/writer validation before returning confirmation/reference. |
| Explicit authorization/bootstrap (outside SyncTransport) | GIS token popup; `GET /drive/v3/about?fields=user(permissionId)`; all-page root/child `files.list`; `files.generateIds?count=3`; metadata-only `POST /drive/v3/files` for folders and complete multipart descriptor create; fresh metadata/media verification. |

The visible immutable layout is a dataset-specific Focus Timer root, `segments/`, `dataset.json` and `<segmentId>.json` blobs. Locators/continuations/retry handles stay local adapter metadata, excluded from portable archives.

## Conservative failures and retries

401/authError/insufficient scope → authorization; diagnosed file/domain permission denial → access; root/required-component 404 → missing-dataset; segment 404 → missing-object. Both 404 categories preserve missing-or-inaccessible ambiguity. Quota/rate-limit/service/network and unknown status/reasons → retryable; diagnosed rejection of the supplied pageToken → invalid-cursor; generic 400 does not imply rejected continuation. Complete invalid/unsupported protocol bytes and immutable identity/byte conflicts use the existing malformed/unsupported/integrity categories. Failed publication verification remains unknown unless specifically diagnosed as authorization/access/integrity; the runner retains the attempted publication as unresolved even on diagnosed publish failure.

Reads/list/allocation use at most two retries by default (three total attempts), with exponential delays and jitter, bounded by the client's configured retry budget. Uploads do not blindly repeat within a request: they require read-back or later same-ID runner retry. Retry state never discards local obligations or stores provider response text.

## Changed files

| Files | Change |
| --- | --- |
| `src/web/google-drive-transport.ts` | Production bounded Drive client and SyncTransport implementation. |
| `src/web/google-drive-auth.ts` | Transient GIS authorization, account verification, scope/expiry/callback fences. |
| `src/web/google-drive-bootstrap.ts` | Explicit complete discovery, retained locator inspection and durable create/retry. |
| `src/web/google-drive-sync.ts` | Application coordination using existing runner/repository; reconnect/cancel/opportunities and product status. |
| `src/web/GoogleDrivePanel.tsx`, `App.tsx`, `style.css` | Minimal accessible sync controls/candidate selection and progressively disclosed source recovery exports. |
| `src/web/client.ts` | Replace idle Stopwatch command context after deliberate collection cutover. |
| `src/web/repository.ts`, `remote-repository.ts` | Existing-store creation intent retention, resumable scoped hydration, atomic adoption/cutover, retained-source archives and connection metadata. |
| `web-test/google-drive-{transport,auth,bootstrap,persistence,sync}.test.ts` | Adapter, authorization, bootstrap, persistence/adoption and application composition fault tests. |
| `e2e/drive.spec.ts`, `e2e/fixtures/drive.html`, `drive-harness.ts` | Isolated real-browser IndexedDB/controller tests with synthetic GIS/HTTP state surviving document destruction. |
| `playwright.config.ts` | Launch Vite with the actual test process's Node executable, avoiding a separate npm/Node launcher. |
| `.env.example`, `.gitignore`, `README.md`, this report | Public OAuth registration configuration, local-env exclusions, operating instructions and acceptance boundaries. |

No dependency changes. Existing protocol/core/reference tests are preserved. The isolated feasibility harness remains available and is not a production dependency.

## Verification

| Check | Result |
| --- | --- |
| Core protocol/deterministic suite | 532/532 passed. |
| Web/IndexedDB engine suite | 313/313 passed in 14 files: 176 existing plus 137 new (70 transport, 21 auth, 18 bootstrap, 15 persistence/adoption, 13 application composition). |
| Real-browser production suite | 237/237 passed in 3.0 minutes across Chrome desktop, Chrome Pixel 7 emulation and Edge desktop, including nine new Drive checks. |
| Unchanged C# reference | 31/31 passed. |
| TypeScript and Vite production build | Passed, 54 application modules. |
| Diff/security bundle checks | `git diff --check` passed; generated bundle excludes harness/test transports/synthetic credentials. |

Coverage includes expired/rejected tokens, scope/account mismatch and stale callbacks; access/missing root/object; quota/service jitter; unknown/generic errors and invalid continuations; short/empty continued pages and incompleteSearch; interrupted/truncated/partial/missing-size/incorrect-size/oversized bodies; mutation under a known ID; cancellation; accepted-create response loss and same-ID409 exact read-back; later full-scan discovery; IDB reopen/abort/competing intent/generation fences; retained writer/bytes/membership; and source/target changes during staged hydration and atomic adoption.

Browser HTTP/GIS responses are synthetic. Browser profiles are isolated Playwright contexts, not the user's normal profiles. Pixel 7 is emulation on Windows; physical mobile and official-client acceptance remain separate. The earlier UI announcement regression was corrected by keeping sync's polite live announcement separate from timer interruption status; existing lifecycle tests remain unchanged.

After the final destination-specific Last synced and rejected-grant scheduling refinements, the affected 13 application composition tests and all nine Drive browser checks passed again. The final TypeScript/build and diff/bundle checks also passed. The full suites above are not double-counted with these focused repeats.

## Real manual acceptance still required

Use synthetic session descriptions and two real browser profiles/devices, with the official Web OAuth registration(s) used in feasibility. Configure each exact origin and `VITE_GOOGLE_CLIENT_ID`; rebuild/deploy over HTTPS (or localhost). Keep real tokens out of screenshots, exports and reports.

1. **Create and deliberately join.** In profile A connect under the intended Google account with only drive.file, explicitly save its history and sync a finished session. In clean profile B using the other official registration where available, connect to the same account, discover A's history without supplying IDs, explicitly select it, hydrate and verify matching session values. Do not select automatically even if only one candidate appears.
2. **Both directions/offline merge.** Finish/edit sessions offline in both profiles; delete a shared session in one while editing it offline in the other. Reconnect/sync both, then sync again. Verify identical visible history, terminal deletion, no duplicates, pending work cleared and Last synced/Synced only after successful passes. An active timer must stay local.
3. **Reload/cancel/response loss.** Reload during download/upload or cancel sync. Reconnect to the same account/history and verify eventual convergence without duplicate sessions. Where controlled tooling is available, lose the create response and temporarily block read-back, then verify the retained-ID409/read-back path without logging tokens. Repeat a full scan after creating work during a scan; confirm it is eventually found.
4. **Expiry/revocation/account fence.** Reload to discard the token; verify local use still works and reconnect is user driven. Revoke the intended account grant, reconnect/reconsent, and verify the same history returns. Attempt another account during reconnect: no retained work may publish there, no acknowledgement or new root may appear. Repeat using both official Web registrations.
5. **Explicit recovery/ambiguity.** Use a disposable test history to verify zero/one/multiple candidates and interrupted setup/reload. Missing/inaccessible retained root/object must show attention without recreation or local deletion. Restore access and explicitly reconnect. A changed known segment must preserve local history and block sync; retain an archive for recovery. Do not mutate private production history to force a test.
6. **PWA/privacy.** Confirm offline reopening/local timer/edit/export, keyboard access to choices/options, and meaningful status on phone/desktop. Inspect origin IndexedDB, exported archives, app-shell caches and URLs: no tokens/codes/Authorization headers. Close the PWA and verify it makes no progress until reopened/reconnected. Record browser/device/registration aliases and sanitized outcomes only.

Record pass/fail for each profile/registration, both read/publish directions and exact-byte checks where original bytes are retained. These real checks have **not** been performed during this implementation. Do not describe the integration as production-ready before they pass.

## Concrete incompatibilities and remaining scope

No concrete Drive incompatibility with SyncTransport, runner, reducer, journal or persistence architecture was found. The only added persistence workflow is the explicit staged join/cutover needed to make another browser's existing history usable without relabeling local operations. It reuses existing stores, validators, reducer, runner and transaction boundaries.

Provider policy/configuration eligibility, real official-registration acceptance, physical mobile/runtime behavior and previously documented platform durability/sleep limits remain as stated in the existing evidence. Native/desktop interoperability, arbitrary account/location corpus transfer, portable restore and automatic remote-copy consolidation are not implemented or claimed.
