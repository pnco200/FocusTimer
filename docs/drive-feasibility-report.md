# Google Drive authorization and transport feasibility

Research and experiment preparation: 2026-10-18. Authority: `SPEC.md` §§16–24, 26, 36, 38 and the existing [generic transport](../src/web/sync-transport.ts). **Decision: HOLD. Drive is not approved for production integration.** `drive.file` remains the only candidate scope; neither its success nor its failure across Focus Timer registrations has been demonstrated. No wider scope or hidden storage fallback was selected.

## Evidence boundary

The specification, protocol implementation/review/correction reports, production local/remote IndexedDB reports and design mapping, asynchronous runner report, generic transport and UI guidelines were read before implementation. Historical model/browser results establish their stated local guarantees; they do not establish Google behavior.

Evidence labels throughout this phase:

- **Documented:** current authoritative Google documentation, linked in the supporting notes. An API accepting a scope does not prove a particular caller can see a particular file.
- **Local:** execution against synthetic responses or local browser/storage code. This tests the experiment apparatus, not Google.
- **Live:** an authenticated request using an identified official Focus Timer registration and recorded granted scope. **No such requests were possible in this environment.**
- **Blocked / unproven:** a required observation lacks provider evidence. This differs from a demonstrated provider incompatibility.

The managed runtime reported current observations with no secrets, runtime variables or outbound identities. No Focus Timer project/client IDs or interactive account consent were supplied. Its network policy excludes Google OAuth, GIS and Drive hosts; the runtime policy state was `unknown`, so configuration was not treated as proof of enforcement/readiness. An unauthenticated, bounded Drive reachability probe through the inherited proxy, with network access enabled for the command, failed with `Tunnel connection failed: 403 Forbidden`. An earlier sandbox-only attempt returned `Operation not permitted`. Neither is a Google API error, token failure, or evidence about file authorization. No connector-created files were used as a substitute: the connector's project, scopes and credentials are not the official application registrations under test.

## Findings and release gates

| Question | Result | Gate before architectural commitment |
| --- | --- | --- |
| Narrow scope | `drive.file` is the documented per-file candidate for app-created/selected files. | Prove actual granted scope and isolation from unrelated files using the official registrations. |
| Cross-client corpus | Project-level OAuth consent is documented; automatic inheritance of the complete Drive file corpus across the required clients has not been established. | Web A → B, B → A, web ↔ desktop/native, fresh profile/reinstall and revocation/reauthorization must discover **and** read exact descriptor/segment bytes. |
| Bootstrap | Generated IDs, stable local locators, immutable descriptor and explicit candidates are compatible with the contract in principle. | Exercise partial trees, locator loss, duplicate copies and simultaneous explicit creations. No singleton or snapshot assumption. |
| Lost publication response | Google documents pre-generated-ID retries returning 409 following an earlier successful create. | Run the retained-ID multipart sequence and independently read/compare complete exact bytes and logical identity. A 409 alone never confirms. |
| Enumeration | Page tokens and variable page sizes are documented; additions/deletions can alter later results. | Force pages, retain/replay tokens, append during/between scans, restart rejected continuation, and keep incomplete searches unresolved. |
| Bounded reads | Blob media download and ranges are documented. Size/checksum/revision metadata is available in defined circumstances. | Prove the browser's bounded stream/cancellation behavior against real responses. Reread current bytes; no metadata shortcut is enabled. |
| Failure classification | Current provider reasons support conservative, context-dependent mappings. | Observe token, access, root/object loss and interruption cases without converting ambiguity to deletion, recreation or confirmation. |

Supporting evidence: [authorization](drive-authorization-evidence.md), [bootstrap](drive-bootstrap-evidence.md), [Drive API and error mapping](drive-api-evidence.md). These notes identify guarantees separately from hypotheses and required experiments.

## Official-client authorization acceptance matrix

Use the same test Google account initially. Record Cloud project identity, actual OAuth client type/ID, origin/platform, granted scopes, file IDs and hashes in local experiment evidence. Public client IDs are configuration; tokens and OAuth codes are never evidence exports. A user-supplied account label alone is not proof of Google account identity. Check account selection independently and repeat with a different account as a negative control.

| Producer | Consumer / condition | Required positive observation | Current result |
| --- | --- | --- | --- |
| Web A | Web B, different official client ID | Discover root without supplying its ID or using Picker; download descriptor and all A segments exactly. | Blocked |
| Web B | Web A | B creates a segment in the selected shared root; A discovers/reads it exactly. | Blocked |
| Web A/B | Desktop public OAuth client in same project | Native authorization with PKCE/system browser discovers and reads web corpus. | Blocked |
| Desktop | Both web clients and another supported native registration | Publish original bytes under native credentials; peers discover/read them. | Blocked |
| Any official client | Fresh browser profile / erased experiment locator / reinstall | Narrow consent, independent candidate discovery, explicit selection, exact reads. | Blocked |
| Any official client | Expiry, revoke app access, then reauthorize | Record actual response; reconnect to original corpus or expose loss of authorization, without creating a replacement. | Blocked |
| Official client | Wrong test account / unrelated unselected file | No silent corpus/account substitution. Existing unrelated file is not readable merely by known ID. | Blocked |

Known-ID GET and discovery are separate observations. Selecting a root through Picker is a separate explicit-authorization experiment and cannot establish automatic discovery or descendant authorization. Do not preauthorize every file to manufacture a passing result. Previously broad grants can contaminate a scope test; use a clean app grant/test account and check returned scopes. A successful web A/B run cannot discharge a native registration that does not yet exist.

If a required client cannot discover/read the existing corpus under `drive.file`, stop this transport choice and record the exact failed operation and grant context. Do not retry under `drive`, `drive.readonly`, or `drive.appdata` as an automatic workaround. If evidence stays unavailable, the gate stays unproven; absence of credentials does not prove `drive.file` is incapable.

## Exact publication experiment

The isolated harness must record these observations on a real run:

1. Allocate an ID using `files.generateIds` for ordinary Drive files; durably retain it with the chosen parent, dataset/segment identity and exact final bytes **before** `files.create`.
2. Send one complete multipart create with retained ID, metadata and bytes. Do not create an empty file and patch it. Intentionally discard a successful response at the application boundary; retain the publication as unknown. This simulates response loss after known acceptance, not a physical network cut.
3. Retry create with precisely the same retained ID, parent, identity and bytes after a reload if desired. Record actual HTTP status and safe API reason. Do not allocate another ID following uncertainty.
4. Independently GET metadata and bounded `alt=media` content for that ID. Verify placement/type/availability and validate the descriptor/segment using the existing strict parser. Compare the entire returned byte array to the retained original and check expected dataset/segment/writer identity.
5. Only complete equal readable bytes confirm; unavailable/interrupted reads stay unresolved, and complete different bytes are integrity failure. Repeat with an intentionally mutated **disposable probe**, never a production segment. Checksums are supplementary evidence.

No live status, exact retry response, timing or read-back comparison has been observed yet. The documented expected 409 is a hypothesis to check, not a recorded outcome.

## Enumeration and read experiment ledger

| Case | How to establish it | Current evidence |
| --- | --- | --- |
| Pagination | Create at least five synthetic blobs, request `pageSize=2`, follow actual `nextPageToken` until absent. | Documented API; live blocked. |
| Short/empty continued page | Record if provider emits one; independently inject both into local apparatus. Never manufacture a live observation. | Live not observed. |
| Opaque continuation | Store/reuse token unchanged with the same query/account/target. Do not parse or order it. | Documented API; live blocked. |
| Rejected / expired token | Submit deliberately invalid token; retain real token across hours and replay later. Invalid is not proof of expiry behavior. | Documented restart rule; live blocked. |
| Creation during scan | Pause after first page, create another retained-ID object, finish scan and repeat a full scan. Record omissions/duplicates without assuming either. | Live blocked. |
| New/delayed objects | Add after completed scan and enumerate again. Real delayed visibility requires actual observation; local delay injection is only apparatus evidence. | Live blocked. |
| Missing / inaccessible | Use a disposable nonexistent ID and a different test account or explicit permission change. Google's 404 may cover both. | Documented ambiguity; live blocked. |
| Root loss | Trash/remove only a disposable test root; stop publication and preserve local intents. | Live blocked. |
| Interrupted read | Abort actual media fetch, retry completely, and ensure no partial parse/acceptance. | Live blocked. |
| Changed bytes / same ID | PATCH only a disposable blob, compare against retained originals, and report integrity mismatch. | Live blocked. |
| Read after write | Attempt immediate bounded GET and repeat if unavailable; record observed latency without deriving a general timing guarantee. | Live blocked. |
| Oversize / absent size | Refuse excessive metadata size, then enforce runtime byte cap regardless of size header/metadata or ignored range. | Local apparatus check; live blocked. |

No filename, time, UUID, list position or last-seen maximum becomes a permanent discovery frontier. A new full scan remains required. Empty candidate results do not prove no dataset exists, and a completed scan does not provide a lock for concurrent bootstrap.

## Local verification performed

| Check | Result and evidence limit |
| --- | --- |
| `node --test --test-isolation=none experiments/google-drive/core.test.mjs` | **17/17 passed.** Synthetic HTTP/stream responses cover short/empty continued pages, incomplete search, opaque tokens, bounds, truncated/partial transfers, exact same-ID multipart retry, unreadable/conflicting content and sanitized errors. |
| `PROOF_CHROMIUM_PATH=/usr/bin/chromium node experiments/google-drive/browser-smoke.mjs` (separate loopback server) | **Passed in Chromium 154.0.8037.57 on Linux.** Real browser/IndexedDB, entirely synthetic GIS/Drive responses. Checks committed IDs/bytes before fake acceptance, unknown response loss, document reload and B retry without new allocation, synthetic 409 followed by exact read-back, five segments over three pages, authorization callback fencing, wrong-account refusal, overbroad-token refusal, no token in retained records/diagnostics and no service worker. This certifies none of Google's account/scope/provider behavior. |
| Experiment JavaScript syntax checks | Passed. |
| `npm run build` | Passed TypeScript and Vite build, **47 production application modules**. Experiment markers/helpers are absent from generated assets. No production source was changed. |
| `git diff --check` | Passed. |

The browser check exposed a Web API invocation issue that Node's fake fetch did not: calling a stored native `fetch` as an instance method supplied the wrong receiver. The experiment now delegates through `globalThis.fetch`. The passing real-browser apparatus check is useful platform evidence, still separate from provider evidence. Existing production suites were not rerun because production source/contracts and dependencies are unchanged.

## Scope of delivered work and continuation

The [isolated experiment instructions](../experiments/google-drive/README.md) describe the runnable apparatus, dedicated experiment storage, exact-byte retry sequence and evidence collection. It does not implement `SyncTransport`, import the production runner, schedule synchronization, or bind production data. It requests only `drive.file` through user-driven GIS; native client proof remains a separately executed part of the matrix. No final sync UI, protocol, persistence or production runner changes are authorized or made in this phase.

To unblock actual provider proof, supply the official project and public registration IDs/types; configure matching authorized local experiment origins, Drive API and consent test users; provide an interactive test-account consent path; and enable the necessary Google hosts through the supported environment/browser setup. Keep tokens and client secrets out of chat. The exact scopes and clean-grant conditions must be captured during execution. Network setup and client provisioning are missing prerequisites, not a request to widen Drive permissions.

The next decision is based on recorded live matrix results. Until then, the provider-independent production architecture remains unchanged and the Drive integration gate stays closed.
