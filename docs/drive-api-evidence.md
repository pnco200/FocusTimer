# Google Drive API transport evidence

Research date: **2026-10-18**. Live-evidence update: **2026-10-19**, for **Web/PWA v1**. `SPEC.md`, the implementation/review/correction reports, production IndexedDB reports, asynchronous runner report, `src/web/sync-transport.ts`, and UI guidelines remain the application authority. This document changes none of them.

**Gate status: GO WITH CHANGES for Web/PWA v1 technical feasibility.** The user's live summary and five subsequently [audited event exports](drive-live-evidence-audit.md) establish retained-ID retry/read-back, actual pagination, concurrent-scan omission followed by later discovery, bounded reads and web corpus recovery. See [W01–W14 and provenance](drive-feasibility-report.md). Export inspection also adds constrained reverse web publication/read and an actual object `404 / notFound`. These are client-side records, not raw HTTP transcripts or a new Google execution here. **Documented** denotes the original authoritative research; **Design inference** denotes implementation reasoning. Unreported faults remain acceptance coverage. Native is **DEFERRED / NOT IN CURRENT WEB V1 SCOPE**, and no production adapter is implemented in this phase.

## 1. Candidate methods and creation identity

**Documented:** [`files.generateIds`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds) accepts `drive.file`. `GET /drive/v3/files/generateIds?count=1&space=drive&type=files` returns an ID generated for the requesting user, for later create/copy requests. This is allocation, not publication. [`files.create`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create) also accepts that scope and supports `uploadType=multipart`, combining metadata and media in one request.

**Documented:** Google explicitly describes retrying uploads with pre-generated IDs after an indeterminate error or timeout. A retry after successful creation returns HTTP `409` and does not create a duplicate. Pre-generated IDs do not support conversion to Google Workspace formats; ordinary JSON blobs and folders are viable candidates. See [upload retry guidance](https://developers.google.com/workspace/drive/api/guides/manage-uploads#use_a_pre-generated_id_to_upload_files) and [creating files with generated IDs](https://developers.google.com/workspace/drive/api/guides/create-file#generate_ids_to_use_with_your_files).

**Design inference:** a generated Drive ID is the strongest documented candidate for the durable opaque `retryHandle`. Persist it with the original account, root, segment ID and exact sealed bytes before issuing `POST /upload/drive/v3/files?uploadType=multipart`. The ID goes in the metadata `id` field, with the pinned parent. A protocol UUID cannot replace the provider-generated ID. Lost allocation responses are harmless unused identities; lost upload responses are unresolved publication attempts.

**Live — PROVEN for the reported scenario (W07/W08):** generated IDs were retained through retry; retry of an accepted create using the same generated Drive ID returned **409**, followed by fresh metadata/media retrieval that verified exact retained bytes and logical identity. This validates the proposed creation identity and confirmation strategy for web v1. It does not make conflict status itself a confirmation.

The exports corroborate four distinct fully captured accepted-200/lost-response/409/verified-read-back sequences (E04 #44–48/#50–52/#54–56/#74–76). E04 #3 resolves an unknown object whose initial acceptance is outside that capture. E04 #58/#60/#62 shows direct success then duplicate-create recovery; it is not a fifth accepted-200 loss sequence. See the audit for deduplication and the limits of comparator flags without exported payload bytes.

Do not implement a metadata-only empty file followed by a content update. Do not retry an unknown create with a new ID. Do not treat either a successful upload response or `409` as `PublicationConfirmation`.

### Publication sequence and remaining implementation coverage

1. Allocate and durably record a generated ID before upload. Retention through retry is reported live; production restart/reload boundaries still need integration coverage rather than being inferred from that statement.
2. Upload a small valid synthetic v1 segment as exact UTF-8 JSON bytes with the retained ID. Keep session descriptions synthetic.
3. Let Drive accept the request and discard the client-visible success before recording confirmation. A successful intercepted response establishes this controlled failure point; a random timeout alone does not prove acceptance.
4. Retry the same create with the same ID, bytes, logical segment ID and parent. The captured live result was **409**, with an empty recorded reason list in these confirmations. Client event timestamps are available in the exports; no distinct live restart boundary, server timing or visibility guarantee is inferred from them.
5. Fetch metadata by that ID; check intended parent, MIME type, trash state and ID. Fetch complete bounded media bytes, compare every byte against the sealed bytes, and parse the segment with the existing protocol validator to check dataset/writer/segment identity.
6. Only exact successful read-back confirms publication. A failed/inaccessible/delayed/truncated read leaves it unresolved. Readable different bytes are `integrity`, even if JSON values appear equivalent. Retain the verified Drive reference with confirmation.
7. Cover readable conflicting content, download interruption and unavailable verification in production acceptance tests; these variants were not reported live. None may acknowledge the original operation membership.

The controlled accepted-response-loss/409/exact-read-back sequence is now live evidence. It is not a physical network-cut experiment or proof of every fault boundary. For further tests, capture phase, safe status/reason, byte counts and equality results without tokens/private content. Logical identity checking and byte comparison remain application responsibilities.

## 2. Root discovery and incomplete bootstrap

**Documented:** a folder is created with MIME type `application/vnd.google-apps.folder`, and a child's `parents` metadata specifies its folder. See [create/populate folders](https://developers.google.com/workspace/drive/api/guides/folder). [Search queries](https://developers.google.com/workspace/drive/api/guides/search-files) support MIME type, `trashed=false`, parent containment and custom-property filtering. [Custom properties](https://developers.google.com/workspace/drive/api/guides/properties) distinguish public `properties` from app-private `appProperties`; neither is an access grant.

**Design inference:** discover candidate roots through an app marker and validate their immutable descriptor content, rather than trusting a name. Non-sensitive public properties are a possible discovery hint to avoid assuming that app-private metadata crosses OAuth client registrations. Marker spoofing/copying cannot make a candidate valid. Query results remain limited by actual authorization; a zero-result response cannot prove that no inaccessible Focus Timer history exists.

Persist a bootstrap intent locally with dataset ID, root ID, segment-folder ID, descriptor ID and descriptor bytes before creating any corresponding object. Recover a retained intent by those same IDs and verify each accepted object. Bind only after root, expected placement, segment folder and complete valid immutable descriptor all verify. A missing/unreadable descriptor, conflicting descriptors, missing segment folder or wrong placement yields an incomplete/invalid candidate. Never patch an empty descriptor into a valid one or publish segments into an incomplete candidate.

Discovery must collect every page and return **zero / one / multiple / incomplete / inaccessible / failed** outcomes. One validated candidate can be offered for deliberate join; it is not evidence of a global singleton. Two concurrent intents with independent generated IDs can create two roots. Repeated search does not provide a transaction or distributed uniqueness primitive. Preserve both and surface ambiguity; never elect the first name, earliest timestamp, lowest UUID or first response. No mutable manifest is needed or authorized.

**Live:** cross-client root discovery and descriptor inspection, incomplete-tree rejection, and recovery from a clean profile with zero retained intents are established by W02/W03/W06/W11. The clean profile listed all six segments and read a segment; full production hydration is not claimed. Multiple roots/components, other partial layouts, simultaneous bootstrap and per-component fault boundaries still need web implementation coverage. A bound root's `404` never authorizes recreation. See [bootstrap evidence](drive-bootstrap-evidence.md).

## 3. Listing and pagination

**Documented:** [`files.list`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list) accepts `drive.file`. `pageSize` is a maximum, not a promised count. Continue with returned `nextPageToken`; its absence marks the end. Tokens are normally valid for hours, but rejected tokens must be discarded and listing restarted. Adding/removing items can change expected results. `incompleteSearch=true` means results may be missing. `orderBy` supplies explicit sort keys; this is no snapshot guarantee.

**Design inference:** persist an opaque token with the exact pinned account/root/query context and pending references. Do not parse a token or reuse it under another query/binding. A short or empty page with a token remains incomplete. An empty final page completes only if `incompleteSearch` is false and no known obligations remain. If `incompleteSearch` is true without continuation, fail/retry full reconciliation; do not invent a fake token that can loop permanently. Narrowing corpus to `user`/the pinned folder is a useful experiment choice, not a proof that incomplete searches cannot occur.

The current v3 reference reviewed here explicitly permits fewer than `pageSize`; it does not explicitly promise an observable empty continued page. Older v2 wording must not be presented as v3 experimental evidence. The generic contract intentionally tolerates such pages regardless of whether they occur in this finite test.

### Live enumeration results and remaining acceptance coverage

| Behavior | Status and evidence |
| --- | --- |
| Real continuation and explicit completion | **PROVEN (W09):** `pageSize=2` yielded **2 + 2 + 1**; completion only after null continuation. |
| Creation during enumeration | **PROVEN WITH CONSTRAINT (W10):** a new segment was omitted from the active scan and found by a later full scan. No snapshot or visibility deadline can be assumed. |
| Clean-profile enumeration | **PROVEN WITH CONSTRAINT (W11):** all six existing segments were enumerated with no retained intents; not six individual exact-byte reads. |
| Short/empty continued pages, rejected/expired tokens, `incompleteSearch`, interrupted page requests | **DOCUMENTED / LOCAL ONLY:** not reported live. Preserve the existing tolerant/restart rules and cover them in the web adapter. |

- The reported five-object **2 + 2 + 1** run already establishes real pagination; a later clean-profile run enumerated six segments. No additional arbitrary object-count threshold is required. Preserve tokens opaquely and completion semantics in the adapter.
- Persist page one and restart, then follow its actual token. Interrupt another page, then resume its last durable checkpoint. Do not mark references applied merely because a page was obtained.
- Submit a deliberately invalid token while holding the other parameters constant. Record actual status/structured reason. Do not assume every HTTP `400` is a continuation rejection. A naturally expired retained token requires a later run; no artificial expiration claim is acceptable.
- Add objects between pages and immediately after enumeration. Run later full enumerations and compare the ID sets. Record first-observed passes and delays. A finite successful run measures visibility; it proves neither a visibility deadline nor snapshot isolation.
- Attempt short/empty continued pages opportunistically. If absent, record **not observed**, retaining the already-verified generic runner cases as local behavior evidence only.
- Enumerate without ordering and with an explicit order for comparison. Do not use names, modified timestamps or UUID maxima as permanent discovery frontiers. Recheck known omitted objects and rerun full scans later.

No authoritative read-after-write or listing-visibility latency bound was established by the linked material or the live summary. Later-scan discovery is now observed; eventual accessibility remains the generic convergence condition rather than a promised deadline or another architecture HOLD.

## 4. Bounded reads and integrity

**Documented:** [`files.get`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get) with `alt=media` returns stored blob content and accepts `drive.file`. Google Workspace editor files use export instead; Focus Timer should store raw JSON blobs. [Download guidance](https://developers.google.com/workspace/drive/api/guides/manage-downloads#partial_download) supports byte `Range` requests for blob downloads.

**Documented:** [File metadata](https://developers.google.com/workspace/drive/api/reference/rest/v3/files) offers `size` as an int64 string (absent for folders/shortcuts), MD5 for binary content, optional SHA-1/SHA-256 for stored content, `headRevisionId` for binary files, and a monotonically increasing `version` reflecting server changes. Names are not unique. None of these fields alone proves a later media response is complete or the same revision as an earlier metadata response.

**Design inference:** request fresh minimal metadata; parse size without lossy integer conversion. Reject known oversize before media transfer when possible, but also enforce a streaming byte cap. Metadata may be stale, absent or changed between calls. Never call unbounded `text()`, `json()`, `blob()` or `arrayBuffer()` on an arbitrary body and truncate afterward. A bounded error body also needs a cap.

Request up to `maxBytes + 1` bytes when using a range so an oversized prefix can be distinguished. Validate actual `200`/`206`, returned range/total if present and transfer completion; a partial prefix alone is not a complete artifact. A runtime cap must still work if the server returns a full `200`. Abort/cancel consumption immediately on excess, retaining only bounded chunks. Browser/HTTP implementation buffering and the handling of compression require measurement in the actual runtime; a source-level loop is not a claim of a universal network/hardware allocation ceiling.

Unexpected EOF, interrupted body, inconsistent declared transfer length or incomplete range is `retryable`; do not parse a truncated body and quarantine it as malformed. Complete oversized new content can report bounded `byteLength` evidence. Complete bytes that change a known reference are `integrity`; the runner already upgrades an oversized known-object failure through its retained original-byte check.

[`files.update`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update) can replace content under the same file ID. Thus a stable ID/name does not establish immutability. Record metadata before/after deliberate mutation during the live experiment; compare exact reread bytes against the retained original. Fresh version/checksum differences can trigger rereads, but no cached indicator is approved to skip them. No v3 resource `etag` field or proven conditional-media strategy was established here.

[Revisions](https://developers.google.com/workspace/drive/api/guides/manage-revisions) are not a substitute for the immutable corpus: older blob revisions can be purged, with only limited `keepForever` retention. [Revision metadata](https://developers.google.com/workspace/drive/api/reference/rest/v3/revisions) has revision ID, content MD5 and size, but it does not attest that the current file remains unchanged. Focus Timer must detect a changed current object, not silently fetch an older revision and call the binding healthy.

**Live — PROVEN WITH CONSTRAINT (W04/W08/W11):** bounded cross-client segment read/identity validation, exact retained-byte verification where applicable, fresh metadata/media confirmation after accepted-response loss, and a clean-profile bounded segment read succeeded. This proves the reported working paths; no cached-metadata integrity shortcut is approved.

**Remaining web acceptance coverage, not observed:** exact maximum/maximum-plus-one remote bytes, missing size, ignored/partial ranges, abort/truncation, diagnosed permission/root failures, changed content under a known ID or between metadata/media calls, and checksum/revision changes. One object read does record actual `404 / notFound` (W14), without establishing whether that object was nonexistent, inaccessible or mistyped. Readability after accepted creation is observed; no universal immediate-read deadline follows from event timestamps. Distinguish complete byte equality from checksum equality and keep failures unresolved conservatively.

## 5. Conservative error mapping

These are proposed translations into existing `TransportFailure` values, not a new production classifier. Google's [error guide](https://developers.google.com/workspace/drive/api/guides/handle-errors) documents status plus structured reasons: expired/invalid tokens yield `401`; `403` covers permissions **and quotas**; `404` cannot distinguish missing from inaccessible files. Parse only bounded structured fields and preserve operation context. Do not surface arbitrary provider text, account addresses or file names as a `TransportError` message.

| Google/API outcome | Existing code | Required interpretation |
| --- | --- | --- |
| `401` / `authError` | `authorization` | Token/scopes need attention. |
| Explicit insufficient-scope authorization failure | `authorization` | Never silently request broader scope. |
| `403` / `appNotAuthorizedToFile`, `insufficientFilePermissions`, `domainPolicy` | `access` | Stop access attempts until deliberately resolved. |
| `404` / `notFound` for pinned root/descriptor/required folder | `missing-dataset` | Missing **or inaccessible**; never recreate. |
| `404` / `notFound` for segment | `missing-object` | Missing **or inaccessible**; never domain DELETE. |
| `403` / `rateLimitExceeded`, `userRateLimitExceeded`; `429` | `retryable` | Retain all obligations. |
| `403` / `dailyLimitExceeded`, `storageQuotaExceeded` | `retryable` | Requires capacity/configuration relief; bounded retry opportunities. |
| `500`, `502`, `503`, `504` | `retryable` for reads/list/allocation | Publication acceptance may be ambiguous. |
| Positively diagnosed rejection of the supplied list token | `invalid-cursor` | Full restart; pending references survive. |
| Generic `400`, unknown status/reason, malformed error response | `retryable` fallback | Diagnose request/provider issue; do not quarantine remote history. |
| Complete invalid protocol bytes | `malformed` | Existing validator diagnoses actual content. |
| Complete unsupported wire version/shape | `unsupported` | Preserve bytes; require upgrade/recovery. |
| Known bytes changed, same logical ID with unequal bytes, wrong read-back bytes | `integrity` | Never overwrite/acknowledge. |
| Network loss/abort/timeout during upload, unverified `2xx`/`409`, failed read-back | `unknown` | Retry retained ID/bytes; no confirmation. |
| Network/body interruption during read/list/preparation | `retryable` | Do not diagnose corrupt content. |
| Verified current account differs from pinned account | `authorization` | Local context check; never send the pinned publication. |

**Application inference:** the generic error vocabulary has no separate permanent quota or adapter-bug class. `retryable` here preserves pending work without falsely diagnosing corruption; it does not mean tight-loop or automatic infinite retries. Backoff/jitter and an attempt budget belong outside protocol semantics. [Current quota guidance](https://developers.google.com/workspace/drive/api/guides/limits) recommends truncated exponential backoff with randomness; quotas/costs are configuration, not protocol constants.

Do not infer wrong account, revocation, deletion or expiration solely from `404`, `403` or one `401`. Expiration and revocation may converge on authorization failure while wrong-account requests can look missing. Account verification and reconnection belong to the authorization proof. After any attempted publication, retained state remains unknown unless exact read-back confirms it, even if the error has a more precise authorization/access classification. The existing runner conservatively persists unknown publication state on diagnosed publish failure.

**Live with constraints:** another account using the same web client saw zero candidates (W05); same-ID retry returned 409 before verified confirmation (W08); an object read returned **404 / `notFound`** and stayed missing-or-inaccessible (W14, E04 #28). Correct-account revocation/reconsent was confirmed by the user as a separate action outside these exports (W12); the recorded revoke targets the alternate account. No actual expired/revoked-token rejection code, diagnosed permission denial, missing-root, quota or server-failure response is established. Keep those mappings documented and exercise them through controlled web acceptance tests; do not exhaust real quota or relabel injected failures as Google observations.

## 6. Web/PWA v1 recommendation

**GO WITH CHANGES.** The supplied live evidence is sufficient for the current web product's technical transport choice: narrow-scope official web access, generated-ID retry with verified exact bytes, real pagination, later full reconciliation and clean-profile/reconsent recovery. The observed constraints fit the existing `SyncTransport`; no protocol/architecture redesign or broader scope is required. No final adapter, bootstrap automation or sync UI is implemented here.

Remaining work is the [concrete web implementation and acceptance list](drive-feasibility-report.md): account/scope fencing, complete explicit bootstrap, retained-ID/byte publication, all-page/full-pass reconciliation, bounded current-byte reads and conservative typed failures. Both web directions now have export-supported coverage, with reverse original-byte comparison explicitly unproven (W13). Preserve those actual constraints in production acceptance. Native interoperability is deferred until an actual native target exists and must pass for its own official registration before that native client ships. Synthetic tests remain separate apparatus evidence.
