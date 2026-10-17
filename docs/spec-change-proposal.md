# Proposed changes to SPEC.md

2026-10-17. Applies to Draft v2 at commit c9160304b8b95cebb765805063bff21e30d91a1d. This is a targeted amendment proposal, not a rewritten specification or an implementation. The accompanying [architecture review](architecture-review.md) contains evidence, failure sequences, clock alternatives, and the recovery matrix.

Priorities indicate implementation/release dependencies. CRITICAL changes prevent loss/divergence paths; HIGH changes establish necessary semantics; MEDIUM changes simplify or improve the design; LOW changes can wait. None requires a developer-controlled backend.

### Change 1 — Correct the reference implementation and preserved behavior

**Current design**

SPEC §§1, 5, 20, 45, 73, 78 describe an existing C++ application and say completed-history editing already exists. §61 postpones advanced statistics while leaving preservation of existing simple totals implicit.

**Problem**

The supplied reference is C#/WinForms. It has no completed-session editor and already displays today/week/all-time totals. False premises can turn new functionality into an unreviewed migration assumption.

**Proposed change**

Identify Reference-FocusTimer-SourceCode as the C#/.NET Framework 4.8 behavioral reference; keep C++ as a future target. Mark completed editing as new. Preserve existing simple finish-date totals; only advanced analysis is deferred. Record the behavior table/classifications in the review as the baseline for the later behavior document.

**Why**

Requirements should describe the actual supplied product. Existing 31/31 checks passed in an isolated fresh run; that suite does not establish future browser/sync behavior.

**Priority**

HIGH

---

### Change 2 — Specify active-session restart, reset, and timing policy

**Current design**

SPEC §§7-10, 13, 63 say elapsed focus derives from timestamps and active state should survive restart, without defining its restored state or sleep policy.

**Problem**

Restoring an old runningSince can add days of closed time, contradicting the reference. A once-per-five-seconds autosave opportunity is not a maximum crash-loss bound.

**Proposed change**

Restore active checkpoints paused when the previous execution owner is gone; exclude closed time after the last durable checkpoint. Opening/reloading a tab attaches to an existing live owner and must not pause it. Arbitrate local ownership and fence takeover with a durable revision/token; heartbeat timeout alone does not prove a backgrounded owner is gone. Unresponsive ownership requires deliberate recovery.

Preserve positive-duration finish from running/paused state; clear title on finish and retain it on reset. Pause before reset confirmation, resume on cancellation if previously running. Hidden tabs remain live sessions, not implicit closes. Specify running sleep continuity as a target requiring platform tests, use monotonic live measurement plus checkpoints, and handle wall-clock corrections separately from focus duration.

**Why**

These are user-visible stopwatch semantics. Synchronization cannot repair an incorrectly measured duration.

**Priority**

HIGH

---

### Change 3 — Add explicit dataset creation, joining, and binding

**Current design**

SPEC §§24-25 define UUIDs; §38 offers initializeDataset; §40 depicts a named folder tree.

**Problem**

Two devices can independently create datasets after an empty listing. Local-only operations already require a dataset ID, but adoption/account switching is undefined.

**Proposed change**

Separate discover, create, and bind. Bind locally to provider account context, stable locator, and validated immutable dataset ID/version. Never choose the first matching name or infer uniqueness from a listing. Surface multiple candidates.

Allow an offline collection/dataset UUID immediately. On joining a different existing dataset, retain the source collection/archive, hydrate the target, and explicitly adopt selected visible records as fresh target-dataset operations. Default to adding unknown IDs; retain target values on overlap and honor tombstones. Do not relabel immutable operations. Account/dataset switches never redirect pending work silently.

Make adoption durable/resumable. Keep local commands working during hydration; catch up source revisions and atomically verify/cut over the binding before publishing staged adoption. Concurrent source completions/edits must not be stranded.

**Why**

Explicit enrollment handles first-init races without coordination services and protects user data from unintended merging or upload.

**Priority**

CRITICAL

---

### Change 4 — Make the entire local mutation transaction mandatory

**Current design**

SPEC §§18, 27 describe local entity/outbox changes and say they “should be atomic.”

**Problem**

History can commit without an operation; active state can survive completion and finish twice; counters can reset independently.

**Proposed change**

Replace advisory atomicity with MUST: entity winner/tombstone, immutable operation, outbox membership, and persisted Lamport counter commit together. Finishing also consumes the expected active-session identity/revision in that transaction. Success is shown only after commit. An aborted transaction retains prior durable state.

**Why**

The database must make a completed command and its replication record one fact. No retry layer can reconstruct a missing operation reliably.

**Priority**

CRITICAL

---

### Change 5 — Specify transactional receive processing and discovery checkpoints

**Current design**

SPEC §§17, 31, 38, 52 mention known operations/segments and graceful errors, without ordering their persistence.

**Problem**

Saving “known” or a cursor before applying an operation can cause permanent skips after a crash.

**Proposed change**

Persist accepted operations, winner/deletion effects, deduplication, Lamport high-water, and processing state atomically. Whole-segment transactions are preferred for bounded batches; durable staged per-op processing is valid if completion is recorded only after all effects persist. Cursor advancement must accompany either processing or durable enqueueing of every pending artifact. Separate discovered, pending, applied, and quarantined states. Receiving state never generates a new outgoing mutation.

**Why**

Crash recovery becomes ordinary safe retry rather than a repair heuristic.

**Priority**

CRITICAL

---

### Change 6 — Seal publication intent and acknowledge exact membership

**Current design**

SPEC §§28-30 require immutable published segments, but do not define pre-publication identity or unknown upload outcomes.

**Problem**

Retry can rebuild different content; acknowledging all pending operations can drop edits created during upload.

**Proposed change**

Before network activity, durably seal random segment ID, exact bytes, included operation IDs, and publication state. Retry unchanged. New edits use later segments. Confirm or verify publication before acknowledging only the included operations. Unknown outcomes stay pending. Same segment ID/different sealed content or same opId/different parsed values is an integrity fault, never first-seen-wins. Preserve immutable operation history after outbox acknowledgement.

**Why**

At-least-once delivery is sufficient; exactly-once network transactions are unnecessary.

**Priority**

CRITICAL

---

### Change 7 — Replace HLC preference with one Lamport counter

**Current design**

SPEC §32 prefers HLC or an unspecified equivalent; §33 orders conflicting updates by that clock.

**Problem**

HLC adds physical-clock and send/receive cases without a current physical-time query requirement. It does not make disconnected edits' real chronology knowable.

**Proposed change**

Persist one counter C per local dataset replica. Accepting any valid remote op persists C=max(C,remoteCounter), including losing edits/deletes. A local mutation allocates C+1 atomically. Compare (counter numerically, canonical unsigned UUID bytes of opId). Do not add a separate per-device sequence for conflict ordering.

Counters are exact JSON integers up to 9,007,199,254,740,991; op counters start at 1, never wrap/reset. Detect exhaustion as a recovery condition; preserve stopwatch completions locally even when a damaged dataset cannot accept safe versions.

**Why**

Lamport preserves observed-update precedence and deterministic convergence without wall-clock dependence. Offline unobserved conflicts remain arbitrary, which is acceptable for this application. See the review's alternatives table and [original paper](https://lamport.azurewebsites.net/pubs/time-clocks.pdf).

**Priority**

HIGH

---

### Change 8 — Make deletion terminal for a session ID

**Current design**

SPEC §34 lets DELETE and UPSERT compete by the same version order; §35 implies tombstones prevent offline resurrection.

**Problem**

A stale offline edit with a higher clock can revive a deleted record. Retention alone does not prevent it.

**Proposed change**

Any valid DELETE permanently tombstones (datasetId, entityType, entityId). Among live UPSERTs choose the maximum version; deletion dominates them all. Restore/copy of a deleted session gets a fresh ID. Retain tombstones indefinitely.

Document the intentional tradeoff: a year-old offline delete defeats newer edits. This replaces uniform LWW deletion semantics, rather than being described as equivalent.

**Why**

Permanent deletion matches the existing no-undo UI and avoids resurrection without vectors or causal delete contexts.

**Priority**

HIGH

---

### Change 9 — Define full snapshots and the precise reducer

**Current design**

SPEC §§26, 30-34 show conceptual payloads and require convergence, but leave patch/replacement and identity consistency open.

**Problem**

Independent clients can disagree on omitted fields, sorting, entity keys, and duplicate IDs.

**Proposed change**

UPSERT is a complete required FocusSession snapshot, never a patch. DELETE payload is absent. Deduplicate by (datasetId,opId); materialize by (datasetId,entityType,entityId). Require envelope/payload and segment/nested-operation identifiers/versions to agree. Any DELETE hides that entity permanently; otherwise select maximum (counter,opId). Processing order never changes state.

Validate full segments before ingestion and treat conflicting immutable IDs as corruption. Object member order/escape spelling does not change parsed operation identity.

**Why**

A small set reducer can be specified and reproduced exactly across languages.

**Priority**

CRITICAL

---

### Change 10 — Freeze a portable wire profile and resource bounds

**Current design**

SPEC §§14, 16, 22-23, 47 specify JSON, timestamps, UUIDs, and vectors at a conceptual level.

**Problem**

32-bit milliseconds, JSON precision, locale parsing, Guid byte order, duplicate keys, and Unicode length differ between languages.

**Proposed change**

Adopt the review §7 profile: UTF-8 without BOM, valid Unicode scalar text, duplicate-name rejection, exact non-null required fields, lowercase canonical UUIDs ordered by network-order bytes, strict Gregorian UTC milliseconds (years 0001-9999, no leap seconds), integer duration, and bounded numeric counters. Emit/accept plain decimal integer tokens in integer fields, with no fractions/exponents/negative zero or pre-validation rounding.

Proposed v1 bounds: positive duration through 3,155,760,000,000 ms, 120 Unicode scalar values per description, segment at most 1 MiB/1,000 operations, nesting depth at most 16. Define depth counting in the normative schema/vectors. Text is preserved exactly on reception; no normalization/trim during merge. These limits must be identical across clients; 120 scalar values intentionally broadens the reference's UTF-16 limit.

**Why**

Deterministic rejection is as necessary as deterministic merging. [RFC 8259](https://www.rfc-editor.org/rfc/rfc8259.html) explains the underlying interoperability hazards; the tighter profile is this application's choice.

**Priority**

HIGH

---

### Change 11 — Close the v1 persistent schema and bound compatibility promises

**Current design**

SPEC §49 permits optional fields older clients ignore; §77 promises future clients/transports without redesign.

**Problem**

Ignoring a future stored field while emitting replacement snapshots erases it. Old clients cannot safely interpret arbitrary future encryption, entity types, or delete rules.

**Proposed change**

Keep the v1 persistent schema closed. Only explicitly independent informational envelope metadata may be ignored. New semantic fields/types require a version transition unless every existing writer has proven preservation behavior. Unknown protocol/schema/op/entity pauses affected sync, retains local/raw/pending data, and never reports Synced.

Separate local database versions from wire versions. Breaking transitions use explicit migration/cutover, potentially a new dataset, retaining the old archive. No silent incompatible dual-write. Narrow compatibility promises to clients implementing supported semantics; old clients remain locally usable but cannot participate in unknown versions.

**Why**

Honest compatibility boundaries are safer than an unimplementable universal forward-compatibility promise.

**Priority**

HIGH

---

### Change 12 — Require v1 retention; postpone destructive compaction

**Current design**

SPEC §36 says v1 may retain segments indefinitely and defers snapshots/compaction.

**Problem**

“May” leaves clients free to delete history/tombstones without an agreed long-offline rejoin rule.

**Proposed change**

Require no automatic deletion of published segments or tombstones in v1. Local outbox acknowledgement is not retention permission. Future non-destructive snapshots may accelerate replay; destructive compaction needs explicit coverage, tombstone/winner/high-water preservation, compatibility and old-device rejoin rules.

**Why**

Thousands of personal sessions justify retention; distributed garbage collection does not. A date cutoff or current-device acknowledgement list is insufficient for year-offline devices.

**Priority**

HIGH

---

### Change 13 — Define transport guarantees rather than provider-shaped methods

**Current design**

SPEC §§38-39 require an abstraction with initializeDataset, listDevices, listSegments, read/publish, and status.

**Problem**

Method names omit pagination, publication outcomes, duplicate discovery, and incomplete data. Device registration can become another race.

**Proposed change**

Require explicit discover/create/bind; paginated enumeration with opaque continuation/completion; bounded reads; stable sealed publication with confirmed/same-content/unknown/conflict outcomes; typed errors. Promise at-least-once delivery without ordering, name uniqueness, or multi-file transactions. Remove mandatory listDevices; envelopes identify writers. Optional changes feed is adapter capability, not core ordering.

Provider errors are classified only as far as evidence permits: an inaccessible/not-found root is not proof of user deletion and never triggers automatic recreation.

**Why**

This is a sufficient common contract for Drive, filesystems, and later object stores without premature provider capability frameworks.

**Priority**

HIGH

---

### Change 14 — Simplify Drive layout and make creation retries stable

**Current design**

SPEC §40 depicts Focus Timer/sync/v1/devices/<device>/segments.

**Problem**

Deep per-device trees add discovery/bootstrap calls. Drive allows duplicate names; immutable filenames alone do not make publication retry-safe.

**Proposed change**

Prefer a visible dataset-specific root with immutable dataset.json and one segments folder. Contents define identity; root/file IDs are local adapter locators. Use Drive-generated IDs persisted with sealed publications before create; retry the same ID/content. On 409, verify the existing object's identity/content before acknowledging. Use complete multipart uploads for small JSON; avoid empty discoverable files later patched.

**Why**

This removes mutable manifests and most folder races while preserving per-writer immutable logical journals. [Drive create-file guide](https://developers.google.com/workspace/drive/api/guides/create-file), [upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads)

**Priority**

MEDIUM

---

### Change 15 — Prove the narrow Drive scope across actual client registrations

**Current design**

SPEC §§41-42 request the narrowest scope without selecting visible versus hidden storage or validating cross-client access.

**Problem**

Shared JSON semantics do not grant another OAuth app storage access. A folder locator does not establish access to every existing child.

**Proposed change**

Prefer visible app-managed files with drive.file for manual recoverability; use separate platform client IDs in one Cloud project for official clients. Before committing transport implementation, prove web/native discovery/read/write with those registrations and no broad Drive scope. Document unrelated third-party project access separately via explicit file authorization or archive transfer.

If choosing appDataFolder instead, explicitly accept hidden/non-shareable storage, app-specific access, and archive-based manual recovery. Never widen scope automatically to conceal discovery limitations.

**Why**

This is a provider integration decision, not protocol identity. [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [app data](https://developers.google.com/workspace/drive/api/guides/appdata), [cross-client identity](https://developers.google.com/identity/protocols/oauth2/cross-client-identity)

**Priority**

HIGH

---

### Change 16 — Make browser authorization and scheduling limits explicit

**Current design**

SPEC §§41, 50, 53, 56 mention browser OAuth/PKCE, periodic synchronization, and locally stored credentials.

**Problem**

A backend-free PWA cannot assume refresh tokens, unattended renewal, or execution after it is closed.

**Proposed change**

Use the supported GIS browser token model with transient access tokens and an explicit reconnect/authorization-required state. Sync while authorization and execution opportunities exist; preserve outbox during expiration/revocation. Never cache OAuth-sensitive responses in the service worker. Use native public-client authorization separately, with desktop PKCE and secure platform storage. No client secret is treated as confidential in a shipped app.

**Why**

The account stays optional and no backend is necessary if interactive reconnection is acceptable. [GIS token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app)

**Priority**

HIGH

---

### Change 17 — Specify complete discovery and safe cursor progression

**Current design**

SPEC §§38, 50, 52 omit pagination and reconciliation rules.

**Problem**

A short page, a delayed older segment, or a failed download can become a permanent gap.

**Proposed change**

Consume every nextPageToken, restart rejected listing continuation, and do not claim completion on incompleteSearch. Never use modifiedTime, UUID time, names, or maximum segment number as a permanent frontier. Initially reconcile complete paginated listings against known segments.

If adding Drive changes, take the start token before initial scan, then drain changes from it; cursor commit requires effects or durable pending refs. The feed discovers files, not domain operations. Respect current provider token semantics rather than inventing routine expiration. Use bounded concurrency/backoff/jitter and current method quota units.

**Why**

Enumeration ordering must not affect eventual delivery. [files.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list), [changes.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list), [limits](https://developers.google.com/workspace/drive/api/guides/limits)

**Priority**

HIGH

---

### Change 18 — Distinguish remote damage, user deletion, and recoverable history

**Current design**

SPEC §§43, 52 promise user ownership and graceful missing-file/malformed-segment handling without a recovery policy.

**Problem**

Automatic root recreation undoes remote removal. Remote absence cannot safely mean DELETE. New installations may not detect previously removed segments.

**Proposed change**

On missing bound root or changed immutable content, preserve local history, stop automatic publication to that binding, and offer deliberate export/restore/new dataset. Retry transient unreadability before quarantine. No session DELETE arises from file absence.

Retain local immutable history or provide complete dataset archives for declared repair. Explain that previously missing history cannot always be detected/reconstructed by a fresh client and unpublished only-copy data cannot survive storage destruction.

**Why**

Explicit recovery preserves user ownership without false backup/authenticity promises.

**Priority**

HIGH

---

### Change 19 — Coordinate tabs and distinguish writer identity from device branding

**Current design**

SPEC §§8, 25, 28 describe one active timer and one writer journal per installation.

**Problem**

Tabs/service workers share storage and can finish the same session or allocate publication state concurrently. A copied database can clone a writer identity.

**Proposed change**

One active session per local installation; commands use transactional expected revision/identity checks and shared counter allocation. Worker locks reduce duplicate work, but correctness survives two workers. Generate random segment IDs, not a sequence as uniqueness authority. Reinstall, storage reset, or an independent database clone gets a new writer identity; historical op/entity identities remain unchanged.

Rotation applies to newly authored operations. Pending/sealed operations retain original writer/IDs/content and retry as their original publication, or unsent state is deliberately adopted with fresh operations. Never rewrite an old writer ID or mix old-writer operations into a new-writer envelope.

For a stale history editor, detect the changed local winner before overwriting a full snapshot; ask/rebase deliberately rather than silently applying a stale form.

**Why**

Per-device journals are safe only when local concurrency and identity lifecycle are defined.

**Priority**

HIGH

---

### Change 20 — Keep the synchronized domain model minimal

**Current design**

SPEC §§13-15 require start/end/focus/description plus createdAt/updatedAt; §20 leaves editable fields partly open.

**Problem**

The reference has no separate audit timestamps. Redundant dates invite misuse as conflict clocks. Timestamp differences cannot reconstruct pauses or exact daily focus allocation.

**Proposed change**

Use domain ID, startedAt, endedAt, positive focusDurationMs, description; version/type belong in the appropriate envelope/schema. Remove mandatory createdAt/updatedAt unless a real audit use case is added. Keep runtime anchors, synchronization clocks, winner/deletion metadata, cursors, and credentials outside the domain.

Define new history editing of description/duration/start/end explicitly; ID immutable. Do not derive focus from dates or reject solely because clock correction reverses chronology. Preserve viewer-timezone finish-date totals; do not add pause intervals/timezone/tags/projects speculatively.

**Why**

The minimal record supports current history and totals. Exact cross-day focus distribution with pauses would need a future data requirement.

**Priority**

MEDIUM

---

### Change 21 — Separate reporting export, history import, and dataset backup

**Current design**

SPEC §44 calls for documented JSON export and validation, without merge/re-import/tombstone rules.

**Problem**

Re-import can duplicate history, reset versions, or resurrect deletion. A history-only export cannot repair a complete sync dataset.

**Proposed change**

Keep existing CSV as reporting. Document JSON history export/import with format version, domain IDs, dates and durations. Merge preserves IDs and respects existing tombstones; deliberate copy/restore generates fresh IDs. Re-importing unchanged data must not fabricate newer operations.

Provide a distinct full dataset archive format or retained-journal recovery path containing immutable operations/tombstones/descriptor. Keep provider tokens/locators/cursors out of portable history. Legacy migration preserves normally generated UUIDv4 identities, normalizes supported GUID spelling to canonical text, converts UTC fractional precision deliberately to milliseconds, and retains duration. Legacy loader acceptance is broader than the proposed v4/v7 wire profile: incompatible versions/variants or duplicate identities after normalization are quarantined with an explicit mapping/recovery decision. Never silently regenerate IDs or invent audit dates.

**Why**

Ownership requires understandable recovery formats, not a raw IndexedDB dump or an export that silently changes merge semantics.

**Priority**

HIGH

---

### Change 22 — Define truthful status and local persistence failure behavior

**Current design**

SPEC §§10, 51-52, 56 promise survival and statuses such as Synced / changes safe locally.

**Problem**

Incomplete discovery, corrupt artifacts, unsupported versions, and local write failures cannot honestly be described as synchronized or safely committed.

**Proposed change**

Synced means last pass completed, all its known artifacts applied, no unresolved integrity/version errors, and local publications acknowledged; it is not global device acknowledgement. Add explicit authorization, unsupported-version, and recovery-required states.

Report local save success only after transaction commit; storage/quota failure retains prior state and offers recovery/export. Request persistent storage when supported, but explain that manual clearing/reinstall can destroy unpublished data.

**Why**

Users must distinguish “saved locally,” “not uploaded yet,” and “cannot safely synchronize.”

**Priority**

HIGH

---

### Change 23 — Make conformance and failure tests the protocol release gate

**Current design**

SPEC §§47-48, 63-68 require useful vectors and in-memory tests but omit several decisive boundaries.

**Problem**

Happy-path convergence cannot establish crash recovery, parser equivalence, local concurrency, or provider access.

**Proposed change**

Add vectors for full-snapshot rules, terminal deletion including late stale delete, losing-op clock incorporation, counter/UUID ties and boundaries, strict dates/numbers/Unicode, null/missing/unknown data, duplicate keys, mismatched IDs, conflicting immutable identity, and long-offline replay. Exercise arbitrary delivery permutations and duplicates.

Inject failures around every mutation/seal/publication/ack/receive/cursor boundary; test competing tabs and stale forms. Transport tests cover ambiguous bootstrap, lost successful response, paging during append, revoked access, missing/tampered root, and distinct official OAuth registrations.

These are requirements for the later implementation task, not new implementation deliverables in this review.

**Why**

Small reproducible fixtures provide more value than sophisticated synchronization machinery.

**Priority**

HIGH

---

### Change 24 — Postpone machinery without a current requirement

**Current design**

SPEC §§4, 16, 38, 55, 62, 71-73 suggest numerous layers, sortable IDs, providers, encryption, snapshots, and repository packages.

**Problem**

Implementation detail can outrun unresolved correctness contracts.

**Proposed change**

Keep domain/storage/protocol/transport boundaries, but make package layout advisory. Prefer ordinary UUIDv4 where sorting is unnecessary; accept canonical v4/v7. Do not implement mandatory device registries, mutable journal heads, field CRDTs, vector clocks, signatures, provider plugin systems, multi-provider bridging, or distributed garbage collection in v1.

Keep transport payloads opaque for possible future encryption; design keys/version migration when actually required. Measure replay/file counts before changes-feed or snapshot optimization.

**Why**

A personal stopwatch needs a small deterministic history and understandable recovery, not a general distributed database platform.

**Priority**

LOW
