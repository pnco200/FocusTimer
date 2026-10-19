# Google Drive API transport evidence

Research date: **2026-10-18**. This is the API half of the authorization/transport feasibility investigation. `SPEC.md`, the implementation/review/correction reports, production IndexedDB reports, asynchronous runner report, `src/web/sync-transport.ts`, and UI guidelines are the application authority. This document changes none of them.

**Gate status: NOT PROVEN.** No authenticated Google Drive experiment was run during this research. The claims marked **Documented** come from the current authoritative pages linked beside them. **Design inference** describes how a future isolated experiment or adapter could satisfy the existing contract; it is not observed provider behavior. **Unverified** requires an authenticated run with official Focus Timer OAuth registrations. Method support for `drive.file` does not establish cross-client corpus authorization. No broader scope or production adapter is selected here.

## 1. Candidate methods and creation identity

**Documented:** [`files.generateIds`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds) accepts `drive.file`. `GET /drive/v3/files/generateIds?count=1&space=drive&type=files` returns an ID generated for the requesting user, for later create/copy requests. This is allocation, not publication. [`files.create`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/create) also accepts that scope and supports `uploadType=multipart`, combining metadata and media in one request.

**Documented:** Google explicitly describes retrying uploads with pre-generated IDs after an indeterminate error or timeout. A retry after successful creation returns HTTP `409` and does not create a duplicate. Pre-generated IDs do not support conversion to Google Workspace formats; ordinary JSON blobs and folders are viable candidates. See [upload retry guidance](https://developers.google.com/workspace/drive/api/guides/manage-uploads#use_a_pre-generated_id_to_upload_files) and [creating files with generated IDs](https://developers.google.com/workspace/drive/api/guides/create-file#generate_ids_to_use_with_your_files).

**Design inference:** a generated Drive ID is the strongest documented candidate for the durable opaque `retryHandle`. Persist it with the original account, root, segment ID and exact sealed bytes before issuing `POST /upload/drive/v3/files?uploadType=multipart`. The ID goes in the metadata `id` field, with the pinned parent. A protocol UUID cannot replace the provider-generated ID. Lost allocation responses are harmless unused identities; lost upload responses are unresolved publication attempts.

Do not implement a metadata-only empty file followed by a content update. Do not retry an unknown create with a new ID. Do not treat either a successful upload response or `409` as `PublicationConfirmation`.

### Required authenticated lost-response experiment — unverified

1. Allocate and durably record a generated ID before upload. Restart the experiment process and reload that record to demonstrate retention.
2. Upload a small valid synthetic v1 segment as exact UTF-8 JSON bytes with the retained ID. Keep session descriptions synthetic.
3. Let Drive accept the request and discard the client-visible success before recording confirmation. A successful intercepted response establishes this controlled failure point; a random timeout alone does not prove acceptance.
4. Restart and send the same create with the same ID, bytes, logical segment ID and parent. Record actual HTTP status and sanitized structured reason. The documentation predicts `409`, but this is not yet an observed result.
5. Fetch metadata by that ID; check intended parent, MIME type, trash state and ID. Fetch complete bounded media bytes, compare every byte against the sealed bytes, and parse the segment with the existing protocol validator to check dataset/writer/segment identity.
6. Only exact successful read-back confirms publication. A failed/inaccessible/delayed/truncated read leaves it unresolved. Readable different bytes are `integrity`, even if JSON values appear equivalent. Retain the verified Drive reference with confirmation.
7. Repeat with readable conflicting content, download interruption, and delayed verification. None may acknowledge the original operation membership.

The test must report timestamps, phase, status/reason, byte counts and equality results without tokens, raw private content or general response dumps. The exact logical identity check and complete-byte comparison are Focus Timer requirements, not a claim that Google performs them for us.

## 2. Root discovery and incomplete bootstrap

**Documented:** a folder is created with MIME type `application/vnd.google-apps.folder`, and a child's `parents` metadata specifies its folder. See [create/populate folders](https://developers.google.com/workspace/drive/api/guides/folder). [Search queries](https://developers.google.com/workspace/drive/api/guides/search-files) support MIME type, `trashed=false`, parent containment and custom-property filtering. [Custom properties](https://developers.google.com/workspace/drive/api/guides/properties) distinguish public `properties` from app-private `appProperties`; neither is an access grant.

**Design inference:** discover candidate roots through an app marker and validate their immutable descriptor content, rather than trusting a name. Non-sensitive public properties are a possible discovery hint to avoid assuming that app-private metadata crosses OAuth client registrations. Marker spoofing/copying cannot make a candidate valid. Query results remain limited by actual authorization; a zero-result response cannot prove that no inaccessible Focus Timer history exists.

Persist a bootstrap intent locally with dataset ID, root ID, segment-folder ID, descriptor ID and descriptor bytes before creating any corresponding object. Recover a retained intent by those same IDs and verify each accepted object. Bind only after root, expected placement, segment folder and complete valid immutable descriptor all verify. A missing/unreadable descriptor, conflicting descriptors, missing segment folder or wrong placement yields an incomplete/invalid candidate. Never patch an empty descriptor into a valid one or publish segments into an incomplete candidate.

Discovery must collect every page and return **zero / one / multiple / incomplete / inaccessible / failed** outcomes. One validated candidate can be offered for deliberate join; it is not evidence of a global singleton. Two concurrent intents with independent generated IDs can create two roots. Repeated search does not provide a transaction or distributed uniqueness primitive. Preserve both and surface ambiguity; never elect the first name, earliest timestamp, lowest UUID or first response. No mutable manifest is needed or authorized.

**Unverified:** root marker discovery across official registrations; reconstruction after local locator loss; duplicate roots; descriptor-only/folder-only creation failures; simultaneous bootstrap and later full reconciliation. The application must not interpret a bound root's `404` as permission to recreate it.

## 3. Listing and pagination

**Documented:** [`files.list`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list) accepts `drive.file`. `pageSize` is a maximum, not a promised count. Continue with returned `nextPageToken`; its absence marks the end. Tokens are normally valid for hours, but rejected tokens must be discarded and listing restarted. Adding/removing items can change expected results. `incompleteSearch=true` means results may be missing. `orderBy` supplies explicit sort keys; this is no snapshot guarantee.

**Design inference:** persist an opaque token with the exact pinned account/root/query context and pending references. Do not parse a token or reuse it under another query/binding. A short or empty page with a token remains incomplete. An empty final page completes only if `incompleteSearch` is false and no known obligations remain. If `incompleteSearch` is true without continuation, fail/retry full reconciliation; do not invent a fake token that can loop permanently. Narrowing corpus to `user`/the pinned folder is a useful experiment choice, not a proof that incomplete searches cannot occur.

The current v3 reference reviewed here explicitly permits fewer than `pageSize`; it does not explicitly promise an observable empty continued page. Older v2 wording must not be presented as v3 experimental evidence. The generic contract intentionally tolerates such pages regardless of whether they occur in this finite test.

### Required authenticated enumeration experiment — unverified

- Create at least seven synthetic objects and request `pageSize=2`; record page count, per-page result count, continuation presence and `incompleteSearch`. Never export raw tokens into reports; token length/digest can establish retention without treating contents as meaningful.
- Persist page one and restart, then follow its actual token. Interrupt another page, then resume its last durable checkpoint. Do not mark references applied merely because a page was obtained.
- Submit a deliberately invalid token while holding the other parameters constant. Record actual status/structured reason. Do not assume every HTTP `400` is a continuation rejection. A naturally expired retained token requires a later run; no artificial expiration claim is acceptable.
- Add objects between pages and immediately after enumeration. Run later full enumerations and compare the ID sets. Record first-observed passes and delays. A finite successful run measures visibility; it proves neither a visibility deadline nor snapshot isolation.
- Attempt short/empty continued pages opportunistically. If absent, record **not observed**, retaining the already-verified generic runner cases as local behavior evidence only.
- Enumerate without ordering and with an explicit order for comparison. Do not use names, modified timestamps or UUID maxima as permanent discovery frontiers. Recheck known omitted objects and rerun full scans later.

No authoritative read-after-write or listing-visibility latency bound was established by the linked material. Eventual accessibility remains an explicit convergence assumption and a live proof obligation.

## 4. Bounded reads and integrity

**Documented:** [`files.get`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get) with `alt=media` returns stored blob content and accepts `drive.file`. Google Workspace editor files use export instead; Focus Timer should store raw JSON blobs. [Download guidance](https://developers.google.com/workspace/drive/api/guides/manage-downloads#partial_download) supports byte `Range` requests for blob downloads.

**Documented:** [File metadata](https://developers.google.com/workspace/drive/api/reference/rest/v3/files) offers `size` as an int64 string (absent for folders/shortcuts), MD5 for binary content, optional SHA-1/SHA-256 for stored content, `headRevisionId` for binary files, and a monotonically increasing `version` reflecting server changes. Names are not unique. None of these fields alone proves a later media response is complete or the same revision as an earlier metadata response.

**Design inference:** request fresh minimal metadata; parse size without lossy integer conversion. Reject known oversize before media transfer when possible, but also enforce a streaming byte cap. Metadata may be stale, absent or changed between calls. Never call unbounded `text()`, `json()`, `blob()` or `arrayBuffer()` on an arbitrary body and truncate afterward. A bounded error body also needs a cap.

Request up to `maxBytes + 1` bytes when using a range so an oversized prefix can be distinguished. Validate actual `200`/`206`, returned range/total if present and transfer completion; a partial prefix alone is not a complete artifact. A runtime cap must still work if the server returns a full `200`. Abort/cancel consumption immediately on excess, retaining only bounded chunks. Browser/HTTP implementation buffering and the handling of compression require measurement in the actual runtime; a source-level loop is not a claim of a universal network/hardware allocation ceiling.

Unexpected EOF, interrupted body, inconsistent declared transfer length or incomplete range is `retryable`; do not parse a truncated body and quarantine it as malformed. Complete oversized new content can report bounded `byteLength` evidence. Complete bytes that change a known reference are `integrity`; the runner already upgrades an oversized known-object failure through its retained original-byte check.

[`files.update`](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/update) can replace content under the same file ID. Thus a stable ID/name does not establish immutability. Record metadata before/after deliberate mutation during the live experiment; compare exact reread bytes against the retained original. Fresh version/checksum differences can trigger rereads, but no cached indicator is approved to skip them. No v3 resource `etag` field or proven conditional-media strategy was established here.

[Revisions](https://developers.google.com/workspace/drive/api/guides/manage-revisions) are not a substitute for the immutable corpus: older blob revisions can be purged, with only limited `keepForever` retention. [Revision metadata](https://developers.google.com/workspace/drive/api/reference/rest/v3/revisions) has revision ID, content MD5 and size, but it does not attest that the current file remains unchanged. Focus Timer must detect a changed current object, not silently fetch an older revision and call the binding healthy.

**Unverified read matrix:** metadata/media immediately after create; exact maximum and maximum-plus-one bytes; ignored/partial ranges; download abort; missing file; inaccessible file; mutation under known ID; content change between metadata and media; changed checksum/revision/version; and read-back after a discarded success response. Report raw byte equality separately from checksum equality.

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

**Unverified:** expired-token request, explicit revocation/reconnection, wrong account, actual scope denial, root/file removal and access loss. Rate limits and server faults should be documented or injected at the HTTP boundary; do not exhaust a real account's quota or mislabel injected outcomes as Google observations.

## 6. Evidence required before an adapter decision

The documented API mechanisms look compatible with retained generated-ID publication, full reconciliation and exact bounded rereads. They do **not** close the official-client scope matrix, reinstall discovery or provider experiments. No final adapter, bootstrap automation, sync UI or broader authorization is approved by this evidence.

A future live report must identify the official client roles, project association and exactly granted scopes without credentials; distinguish automatic list discovery from direct-ID access and picker-assisted access; include the actual provider status/reasons for each probe; report failed and unobserved cases; and retain the cross-client gate as a separate pass/fail decision. Passing local HTTP/mock tests is necessary harness evidence, never Google authorization evidence.
