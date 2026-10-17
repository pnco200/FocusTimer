# Focus Timer architecture review

Reviewed 2026-10-17 against commit c9160304b8b95cebb765805063bff21e30d91a1d and all 78 sections of SPEC.md, Draft v2.

Scope: architecture and behavior only. No production changes, application implementation, or SPEC rewrite. Proposed amendments are in [spec-change-proposal.md](spec-change-proposal.md).

Evidence labels:

- **Confirmed:** observed source behavior, contradiction, or absent contract. An absent contract is not proof of an implemented bug.
- **Probable risk:** a realistic failure permitted by an omission.
- **Theoretical concern:** possible but unlikely at personal stopwatch scale.

Source references are repository-relative and refer to the reviewed commit. Provider/standards claims have external links; recommendations and failure sequences are this review's analysis.

## 1. Executive assessment

**Overall rating: SOUND WITH CHANGES.**

Keep local-first operation, device-local active timers, completed-history synchronization, immutable operations, optional Google Drive, and a language-neutral reducer. These choices meet the requirements without a developer-controlled backend. Whole-entity conflict resolution is proportionate; retaining journals indefinitely is a reasonable v1 tradeoff.

The draft is an architectural direction, not yet an implementable interoperable protocol. Enrollment, transactions, publication acknowledgement, complete discovery, deletion semantics, and version compatibility need decisions before implementations solidify different assumptions. Journals prevent shared-file overwrites; they do not automatically solve these other problems.

Recommend complete session snapshots, terminal tombstones, a persisted Lamport counter, bounded immutable batches, at-least-once delivery, and explicit dataset binding. HLC, mandatory device registries, distributed garbage collection, and mutable journal indexes are unnecessary for v1.

### Actual product and SPEC discrepancies

The supplied reference is **Studytime 1.2, C#/.NET Framework 4.8 WinForms**, not C++. See Reference-FocusTimer-SourceCode/build.ps1:1-15, README.txt:91-103, and the .cs sources. C++ remains a valid future target. Correct SPEC §§1, 5, 20, 45, 73, and 78.

In the following table, source filenames are within Reference-FocusTimer-SourceCode/.

| Area | Actual behavior and evidence | Disposition |
|---|---|---|
| Measurement | System.Diagnostics.Stopwatch supplies elapsed milliseconds; UTC supplies record dates. Focus equals accumulated time plus the nonnegative current monotonic interval. UI refresh does not measure time. Core.cs:51-56,163,174-185. | **PRESERVE** invariant; adapt APIs. |
| Start / resume | Running start is a no-op. First start records UTC; resume preserves original start and accumulation. Core.cs:204-212. | **PRESERVE**. |
| Pause | Repeated pause is a no-op. Pause snapshots and durably freezes focus. Core.cs:213-219. | **PRESERVE**. |
| Finish | Running or paused sessions can finish with positive focus. New GUID record stores original start, current finish, duration, title. Successful save clears active time and title. Core.cs:227-242. | **PRESERVE**, commit once. |
| Reset / cancel | Reset discards active timing/start, retains title/history, returns idle. No separate cancel domain operation. UI pauses before reset confirmation; cancelling resumes a previously running timer and excludes dialog time. Core.cs:220-225; UI.cs:479-492. | **PRESERVE** useful semantics. |
| Descriptions | Editable before/during a session. Limit 120 UTF-16 code units; whitespace-only finish becomes “Untitled session,” otherwise trimmed. Typing changes memory immediately; roughly 700 ms debounced save. Core.cs:187-190,233; UI.cs:370-375,518-526. | **PRESERVE**, specify portable length policy. |
| History | Completed records only, newest finish first; three recent records; title substring search with current-culture case-insensitive comparison. UI.cs:544-575. | **PRESERVE**; search collation is presentation. |
| History editing | **No supported completed-session edit exists.** Current-title editing and history deletion exist; history rows have no edit action. Core.cs:187-255; UI.cs:247-258,565-575. Mutable record fields are not an edit feature. | **NEW REQUIREMENT**, contrary to SPEC §20. Define editable fields. |
| Deletion | Confirmation, physical local removal, no undo; unknown ID is a no-op. Core.cs:244-248; UI.cs:593-598. | **ADAPT FOR SYNC** using tombstones. |
| Statistics | Today, Monday-through-today, all-time; completed focus only, wholly attributed to finish date in the viewer's current timezone. Active time excluded. UI.cs:784-793. | **PRESERVE** basic totals; distinguish advanced statistics in SPEC §61. |
| Persistence | %LOCALAPPDATA%\Studytime\sessions.json; validated full-state JSON, sibling temp, flush, replace/move, one backup. Save precedes in-memory commit. Program.cs:46; Core.cs:123-146,181-185. | **ADAPT FOR WEB** with database transactions. |
| Recovery | Backup recovery preserves corrupt primary as evidence. If neither copy is valid, startup errors rather than resetting history. Core.cs:66-92; Program.cs:44-57. | **PRESERVE** intent. |
| Restart / crash | Close snapshots and pauses. Constructor always restores paused. Closed time excluded. Crash restores last durable checkpoint, not wall time since checkpoint. Core.cs:165-173,249-254. | **PRESERVE** as web restart policy; §10 omits restored state. |
| Background / sleep | Minimized operation continues. README says sleep counts; source has no suspend handler and relies on platform Stopwatch. README.txt:59-68; Core.cs:51-56; UI.cs:518-527. | **ADAPT / VERIFY** per target; sleep claim is documented intent, not measured integration evidence. |
| Autosave bound | Running checkpoints attempted about every five seconds. UI blocking, sleep, or save errors lengthen the gap; errors back off. UI.cs:518-527. | **ADAPT**: five seconds is not a hard crash-loss guarantee. |
| Export | All completed records, independent of filter, to UTF-8 CSV with BOM. Formula-leading titles escaped. No stable IDs or import. Core.cs:273-290; UI.cs:600-606; README.txt:81-89. | **PRESERVE** reporting CSV; add separate JSON backup/import. |
| Native behavior | Single Windows logon-session mutex, local theme/topmost, compact layout, shortcuts, in-app notices. Program.cs:31-42; UI.cs:609-633. | **ADAPT** useful UI; **REMOVE** native plumbing from shared domain/protocol. |

Edge cases: positive subsecond sessions are valid despite zero whole seconds displayed; hours do not wrap at 24; failed finish leaves active state and history intact; failed pause/reset preserves engine state. Wall-clock correction can make finish precede start while focus remains positive: validation does not enforce timestamp ordering (Core.cs:102-121). A backup can lag the latest save; restoring it must not automatically emit edits/deletions.

Proposed web policy: restore persisted active state **paused** when recovering a timer whose previous execution owner is gone; never add closed time from an obsolete runningSince. Opening/reloading a tab must attach to an existing live owner, not pause the shared timer. Coordinate local ownership and fence takeover commands with a durable revision/token; mere lack of a heartbeat from a backgrounded tab is not proof of death. An unresponsive owner needs deliberate recovery rather than guessed elapsed time. A hidden tab is not a close. Continue ordinary live background operation; test sleep and wall-clock correction explicitly. Use a monotonic measurement source within a live execution context plus durable accumulated checkpoints. Timestamp subtraction alone does not settle sleep behavior. [W3C High Resolution Time](https://www.w3.org/TR/hr-time-3/) distinguishes monotonic measurement from user-visible wall time.

Validation: the reference was rebuilt and its existing **31/31 checks passed**, with hidden test windows and isolated data in a writable review directory. No new tests were introduced. The suite covers timer commands, persistence, recovery, failures, exports, and native controls; it does not prove real sleep/hibernate, browser behavior, or any future synchronization.

## 2. Critical findings

### C1 — Dataset identity exists, but enrollment does not

**Severity: HIGH. Evidence: confirmed omission; split-brain is a probable risk.** SPEC §§24-25, 38-40.

**Problem:** initializeDataset can become “find by name, create if absent.” Provider account, remote locator, dataset UUID, and local collection are different identities.

**Failure:** A and B list no dataset; each creates Focus Timer/sync/v1 with a different UUID; both publish valid journals and report synced, but histories remain split.

**Fix:** separate discovery, explicit creation, and binding to a validated locator plus expected dataset ID. Multiple candidates mean ambiguity, never first-result selection. Pin account/locator/dataset locally. Joining, changing accounts, replacing a missing root, and merging local-only history need explicit workflows. Never relabel immutable operations into another dataset.

### C2 — Atomicity must cover the whole command and inbound processing

**Severity: CRITICAL. Evidence: confirmed incomplete contract; loss is a probable risk.** SPEC §§17-18, 27:916.

**Problem:** entity/outbox “should be atomic” omits active completion, clocks, received markers, and discovery checkpoints.

**Failure:** A commits history and clears active state, crashes before outbox insertion; B never receives the session. Alternatively, A marks a segment known, crashes before applying its DELETE, and skips it forever after restart.

**Fix:** mandatory transactions for local mutations and reception, as detailed in §5. Include active transition, winner/tombstone, immutable operation, clock, and outbox membership. Advance discovery checkpoints only with applied effects or a durable pending-download queue.

### C3 — Publication has no durable retry/acknowledgement state machine

**Severity: CRITICAL. Evidence: confirmed omission; loss is a probable risk.** SPEC §§30, 38, 50, 52.

**Problem:** upload success does not define response loss, retries, competing workers, or edits created during upload.

**Failure:** A uploads S containing E1; response is lost; E2 is created; retry rebuilds S from the current outbox, or upload acknowledgement clears all entries. S changes content or E2 is falsely acknowledged.

**Fix:** durably seal segment ID, exact bytes, operation membership, and publication intent before upload. Retry the same logical publication. Acknowledge only included operations after confirmation. Unknown outcome remains pending. Same ID/different content is an integrity fault. Drive file-ID mechanics remain adapter-local.

### C4 — Tombstones do not guarantee the implied anti-resurrection policy

**Severity: HIGH. Evidence: confirmed semantic tension, not mathematical divergence.** SPEC §§34-35.

**Problem:** uniform version-ordered UPSERT/DELETE lets a greater stale edit defeat a tombstone.

**Failure:** A deletes X at clock 10; B offline with old X has unrelated clock 100 and edits X at 101; on exchange, X reappears. HLC has an analogous skewed-clock case.

**Fix:** recommend **terminal DELETE-wins per entity ID**. Any valid DELETE permanently hides that ID; restore uses a fresh ID. This intentionally changes §34 and sacrifices newer edits when a stale delete arrives. If uniform LWW is retained instead, accept and explain resurrection; tombstone retention alone does not prevent it.

### C5 — Merge and wire rules cannot yet produce one portable answer

**Severity: CRITICAL. Evidence: confirmed underspecification.** SPEC §§14, 26, 31-34, 47-49.

**Failure:** A compares numeric counters and treats UPSERT as replacement; B compares serialized clocks or treats omissions as patches. The same operations produce different history. Duplicate JSON keys, UUID ordering, or null handling create similar splits.

**Fix:** freeze full-snapshot semantics, one reducer, one clock algorithm, exact types/ranges, comparison, validation, and tie-breaking. Prove them with shared positive/negative vectors before any implementation becomes the accidental specification.

### C6 — Ignoring optional fields can erase future data

**Severity: HIGH. Evidence: confirmed evolution gap; loss is a probable risk.** SPEC §49.

**Failure:** future A writes projectId; old B ignores it, edits description, and publishes a winning full snapshot without projectId; the association disappears.

**Fix:** v1 has a closed persistent session schema. Only independent decorative metadata can be ignored safely. New persistent semantics require a version change unless all existing writers demonstrably round-trip them. Unknown operation/entity/version means unsupported sync, not silently successful partial sync. Encryption or changed delete rules cannot be transparent optional fields.

### C7 — Enumeration has no completeness/checkpoint contract

**Severity: HIGH. Evidence: confirmed omission; permanent gaps are a probable risk.** SPEC §§38, 52.

**Failure:** A sees S1 and S3, records “latest = 3”; S2 appears later and is excluded forever. Or A advances a changes cursor despite a failed segment download.

**Fix:** opaque pagination, explicit end-of-pass, durable pending references, repeated reconciliation. No irreversible watermark based on file name, UUID time, maximum segment sequence, or modifiedTime.

### C8 — One browser installation can contain competing writers

**Severity: HIGH. Evidence: confirmed omission; local races are a probable risk.** SPEC §§8, 17, 25, 28.

**Failure:** two tabs share device identity and active state; each finishes the same session into a different ID. Two workers can also allocate conflicting batch contents.

**Fix:** transactional command arbitration and clock allocation; consume a local active-session identity/revision only once. Coordinate tabs, but do not rely on a best-effort leader lock for correctness. A separately running database clone gets a new writer identity.

### C9 — Missing remote data needs recovery, not inference

**Severity: HIGH. Evidence: confirmed omission; loss/resurrection are probable risks.** SPEC §§43, 52.

**Failure:** user deletes remote sync files; old A sees an uninitialized root and republishes everything, undoing removal. B might instead delete local sessions because files disappeared.

**Fix:** missing bound root or modified immutable bytes degrades synchronization; preserve local history and stop automatic publication. Offer explicit recovery/export/new dataset. Remote absence never generates domain DELETE. A visible-history export cannot reconstruct missing tombstones.

### C10 — Timing and authorization promises need concrete limits

**Severity: HIGH. Evidence: confirmed reference discrepancies and provider limitation.** SPEC §§9-10, 20, 41, 50, 61.

**Failure:** web restart adds a weekend from persisted runningSince although desktop excludes closed time. Separately, browser token expiry stops sync while the UI still says Synced.

**Fix:** define paused restart/checkpoint recovery, mark history editing as new, and specify background/sleep behavior. Use authorization-required status with retained outbox. Periodic opportunities do not imply unattended token renewal. [GIS token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model) and [GIS migration guidance](https://developers.google.com/identity/oauth2/web/guides/migration-to-gis) explain the browser renewal limitation.

## 3. Important improvements

- Preserve boundaries without imposing packages/interfaces for every concept: domain commands, transactional storage, pure validator/reducer, sync runner, transport adapter are enough.
- Remove correctness dependence on listDevices. Segment envelopes identify writers. Optional names are presentation; missing registration must never hide segments.
- Use shallow remote storage. Device folders multiply discovery/initialization calls without improving conflict resolution.
- Define Synced as no pending publication, no unresolved artifacts, and a completed last discovery pass. It cannot mean all devices have all data now.
- Retain losing operations for recovery/export; postpone conflict browsing and automatic conflict copies. Whole-session LWW deliberately loses one concurrent edit.
- Distinguish CSV reporting, JSON history import, and complete dataset archives containing operations/tombstones.
- Request persistent browser storage where available; handle quota/transaction errors; provide export. Persistent storage reduces eviction exposure, not intentional-clear or backup risk. [Storage Standard](https://storage.spec.whatwg.org/#persistence)
- Keep diagnostics token-free and descriptions private by default. Bounds and safe rendering suffice; hostile multi-user consensus/signatures are outside this personal-data design.

## 4. Race-condition analysis

These are permitted failure paths, not bugs in nonexistent sync code.

| ID | Concrete sequence and incorrect result | Resolution |
|---|---|---|
| R1 | A lists no root; B lists no root; both create distinct datasets; each publishes alone. | Explicit create/join, pinned binding, ambiguity handling. Names are not uniqueness primitives. |
| R2 | A creates an empty descriptor; B discovers it and assumes ID/version; A later replaces it. | Complete immutable descriptor; validate before binding; incomplete candidates remain retryable. |
| R3 | A creates S; response is lost; retry regenerates operations/file; B sees duplicates or conflicting S. | Persist sealed content/IDs; stable publication handle; op-level deduplication. |
| R4 | E1 uploads; another tab creates E2; E1 success clears the whole outbox; E2 never publishes. | Acknowledge exact batch membership only. |
| R5 | A saves X/clears active state; crashes before outbox creation; B never sees X. | One completion transaction for all effects. |
| R6 | A marks S processed or moves cursor; crashes before DELETE applies; restart skips S. | Atomic effects/markers/clock, or durable pending references before cursor advancement. |
| R7 | A sees S3 before S2 and records maximum sequence/time; later S2 is filtered forever. | Set-based discovery, pagination, reconciliation; no assumed contiguous prefix. |
| R8 | A deletes X; offline B edits stale X with a greater clock; reconnection revives X. | Terminal deletion, restore under new ID; otherwise explicitly accept LWW resurrection. |
| R9 | A edits description; B edits duration from old snapshot; one snapshot overwrites the other field. | Document intentional whole-entity conflict loss; retain losing op. No field CRDT required. |
| R10 | Two tabs read active revision r; each finishes into X/Y and allocates clock from stale state. | Transactional revision check, one successful finish, shared counter allocation. |
| R11 | A's installation is cloned to B; both publish sequence 12 with different content; readers accept first arrival. | New independent writer identity; UUID segment IDs; content-conflict detection. |
| R12 | New A stores extra semantic field; old B edits known fields and omits it; field disappears. | Closed v1 schema/version transition or proven preservation. |
| R13 | A has D1 outbox; user authorizes another account or chooses D2; runner sends old work there. | Pin account/locator/expected dataset and isolate work; explicit migration. |
| R14 | User removes root; stale A recreates it while B treats absence as session deletion. | Neither inference is valid; preserve local state and require recovery. |
| R15 | A discards old tombstones; B returns after a year with stale X; X is accepted as new. | No v1 garbage collection; future destructive compaction needs a migration/rejoin boundary. |
| R16 | Editor reads X@4; receiver commits X@7; editor saves stale full snapshot as a new version. | Check edited revision; deliberately resolve/rebase stale form. Clock allocation alone does not preserve intent. |
| R17 | A scans page 1; B publishes during scan; A obtains changes token only after scan and misses that publication. | Obtain start token before scan, then drain from it; or repeat full reconciliation without feed. |
| R18 | Different content uses the same op/segment ID; A and B each retain whichever arrived first. | Integrity fault, preserve evidence, stop affected sync; never first-seen-wins. |
| R19 | A snapshots source history and hydrates a target dataset; tab B finishes/edits in the source; A binds from the old snapshot and strands B's changes. | Durable resumable adoption, catch up source revisions, then atomically verify/cut over the binding; local commands continue during network hydration. |

## 5. Sync protocol review

### Operations, segments, validation

Keep immutable full-session UPSERTs and deletion facts, not patches or database dumps. UPSERT supplies all required session fields and can create an unknown ID. DELETE carries key/operation metadata; require its payload absent rather than inconsistently null.

Deduplicate by (datasetId, opId); materialize by (datasetId, entityType, entityId). Match operation type/ID to payload and segment dataset/writer/version to every nested operation. Folder names are not authoritative.

Batching changes cost, never merge order. A segment may contain one operation; do not wait indefinitely to fill a batch. Bound bytes/count and flush on opportunities/manual sync. Candidate v1 ceilings: 1 MiB UTF-8 JSON, 1,000 operations. Freeze final bounds in the protocol with boundary vectors. No global mutable manifest, journal head, or mandatory device catalogue.

Validate complete segments before logical ingestion. Apply the bounded segment in one transaction, or stage durably with resumable per-op transactions and mark complete only when every op is durable. Unreadable/truncated objects stay retryable until diagnosed; malformed content is quarantined with reason/locator, never counted as successful.

### Recommended reducer

For each entity key, any accepted DELETE creates a permanent deletion fact. If diagnostic deletion metadata is needed, choose the maximum ordered DELETE. Without a DELETE, materialize the maximum UPSERT by (numeric Lamport counter, canonical opId bytes). Device ID is not needed as another tie-break.

This set rule is associative, commutative, and idempotent: the maximum live value and presence of deletion do not depend on arrival order. No global sorted replay is needed. DELETE-before-UPSERT and duplicate delivery are safe.

This is a deliberate change from SPEC §34: even an old offline delete defeats newer edits. The existing UI has permanent deletion and no undo, so terminal IDs are a small understandable rule. Explicit restore/import of a deleted record creates a fresh ID.

Same opId/different parsed content is corruption; JSON member order and equivalent escapes do not constitute different operation values. Same segment ID/different sealed bytes is an integrity fault. Guaranteed convergence assumes valid immutable identities, not arbitrary corrupt corpora. Do not silently choose the first received variant.

### HLC versus simpler clocks

| Mechanism | Deterministic with tie-break? | Offline / incorrect-clock behavior | Recommendation |
|---|---|---|---|
| Physical UTC + device/op ID | Yes. | Fast clock dominates disconnected edits; regression can make an observed update lose. | Insufficient observed-update behavior. |
| Per-device sequence + ID | Yes. | Unrelated counters: A@2 can lose after intentionally editing observed B@500. | Optional journal bookkeeping only. |
| Lamport + op ID | Yes. | Independent of wall clock; observed changes precede later writes; disconnected conflicts are ordered arbitrarily. | **Use for v1.** |
| HLC + op ID | Yes with exact algorithm. | Adds physical proximity, additional send/receive cases, skew/counter rules; future clock can bias disconnected conflicts. | No required benefit here. |
| Vector clocks / multi-value / field CRDTs | Can retain concurrency/multiple values. | Extra metadata and conflict UI. | Postpone. |

The [Lamport paper](https://lamport.azurewebsites.net/pubs/time-clocks.pdf) supplies the observed-event ordering principle. The [original HLC paper](https://cse.buffalo.edu/tech-reports/2014-04.pdf) addresses physical-time proximity as well as causality. Neither identifies the true time order of independent offline edits.

Keep one durable high-water counter C per local dataset replica. Accepting any valid remote operation, including losing UPSERTs/DELETEs, persists C=max(C,remoteCounter). A local mutation allocates C=C+1 atomically with its operation. Only generated operations need versions; reception need not create a separate timestamped event. Shared tabs use the same transactional counter.

Use exact JSON integers through 9,007,199,254,740,991; local operations begin at 1. Never compare numeric strings, wrap, reset, or reuse op IDs. Exhaustion is theoretical at personal scale: fail explicitly and preserve local completions in a detached recovery collection if a damaged dataset cannot generate safe versions. Never stop the stopwatch or silently corrupt ordering.

Reinstall/storage loss creates a new device identity. Rehydrate and incorporate remote high-water before connected editing. Fresh offline writes cannot claim to supersede unseen remote versions; after hydration a deliberate replacement edit can. HLC cannot recover erased causality or unpublished data.

### Required durable transitions

1. **Local mutation:** check expected active/entity revision; compute validated result; allocate clock/op ID; persist winner/tombstone, immutable op, outbox, and clock. Finish consumes a local active-session identity once. Report success after commit.
2. **Seal:** select specific pending ops; persist random segment ID, bytes, exact membership, and publication intent. Later edits never change sealed content.
3. **Publish/acknowledge:** retry unknown outcomes; acknowledge only confirmed membership transactionally. Preserve published operations according to recovery policy.
4. **Receive:** verify binding/version/content; persist operations, materialized effects/tombstones, high-water, deduplication, and completion markers atomically/equivalently resumably. Reception never creates a fresh outgoing edit.
5. **Discovery checkpoint:** save cursor with effects or a durable queue of every pending reference. Distinguish discovered, pending, applied, quarantined; retries are safe.

Pull before publishing when practical, but never rewrite existing offline operations to manufacture causality. Local commands do not wait for network.

### Retention and eventual consistency

Require indefinite append-only retention of segments and tombstones in v1, rather than merely allowing it. Outbox acknowledgement does not erase history. Months/year offline are safe while relevant artifacts remain available and the client supports the protocol.

Future non-destructive snapshots can accelerate replay. Destructive compaction needs winners, tombstones, high-water, coverage, and a rejoin/migration rule. A time cutoff, last-seen list, or acknowledgements from “current devices” is insufficient with forgotten/long-offline clients. Do not build this machinery now.

Convergence requires eventual delivery of the same valid operation set under the same rules. Authentication failure, remote deletion, or unsupported clients suspend those assumptions; “eventual consistency” is not a recovery algorithm.

## 6. Google Drive review

**Drive is suitable for a personal append-only history transport**, provided publication/discovery semantics are explicit and interactive browser authorization is acceptable. It is storage, not a transaction coordinator or protocol authority.

### Representation and bootstrap

Recommend one visible dataset folder, an immutable complete dataset descriptor, and one shallow segments folder. Filenames are readable labels; contents carry protocol identities; adapter-local file IDs locate objects.

    Focus Timer - <datasetId>/
        dataset.json
        segments/
            <segmentId>.json

Use Drive-generated IDs for creation retry handles, including descriptor/folders where applicable. Pin the selected dataset-root ID locally after validating descriptor content. Do not repeatedly resolve a path by name. Names are explicitly nonunique, even within a folder; one listing result cannot elect a global singleton. [Drive files resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files)

An incomplete folder tree is an incomplete candidate, not an empty valid dataset. Different locators with the same validated dataset ID can be duplicate copies requiring reconciliation; different dataset IDs are distinct datasets. Never auto-merge based on equal folder names. There is no need for a shared mutable file containing every device/segment.

### Scope and authorization across clients

| Choice | Benefits | Limitations |
|---|---|---|
| Hidden appDataFolder with drive.appdata | Narrow application-data access, special root, avoids ordinary UI clutter. | Not browsable in normal Drive; cannot share, move between spaces, or trash contents normally. App data can still be deleted. Independent OAuth apps do not gain access merely by knowing protocol IDs. |
| Visible files with drive.file | Narrow per-file access; ordinary user-owned JSON supports manual recovery and independent tools. | Authorization is app/per-file, not a blanket grant to every descendant by possessing a folder ID. Discovery and future-client joining must be proven. Moving/editing/deleting files becomes an expected failure case. |

These properties follow the [application-data guide](https://developers.google.com/workspace/drive/api/guides/appdata) and [scope guide](https://developers.google.com/workspace/drive/api/guides/api-specific-auth). Prefer **visible app-managed files with drive.file** for this SPEC's manual recoverability goals, subject to a focused authorization proof before transport implementation is committed. Do not widen to full Drive access just to simplify discovery. appDataFolder remains a reasonable alternative if hidden storage plus explicit archive export is the chosen product experience.

Official web/desktop/Android/iOS registrations should belong to one Google Cloud project, with platform-appropriate OAuth client IDs. [Google cross-client identity](https://developers.google.com/identity/protocols/oauth2/cross-client-identity) documents this multi-component model. It does not by itself prove all per-file visibility cases: test native clients reading web-created segments, publishing their own segments, and the web reading those native publications. Existing segments remain immutable. A third-party client in a different project is a separate authorization case. Portable JSON alone does not grant storage access; define explicit file authorization or export/import for such clients.

Backend-free browser GIS returns short-lived access tokens without refresh tokens; token-model renewal after expiry requires a user-driven request. Keep access tokens transient, never in segments, exports, logs, or service-worker caches. While expired/disconnected, local history and outbox continue. Startup/reconnect/manual opportunities are best effort, not closed-PWA or perpetual unattended guarantees. [GIS token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model)

Native OAuth uses a different adapter: system browser and supported public-client flow, PKCE for desktop, secure platform token storage, and supported mobile authorization. Do not embed a confidential client secret or copy web token lifecycle assumptions. Native refresh capability does not require a Focus Timer backend. [Desktop OAuth](https://developers.google.com/identity/protocols/oauth2/native-app), [Android AuthorizationClient](https://developers.google.com/android/reference/com/google/android/gms/auth/api/identity/AuthorizationClient)

### Publication, failed uploads, and retry

For bounded small segments, use one multipart create carrying metadata and full content. Do not create an empty discoverable JSON file and patch content later. If resumable upload is used, final completion/status recovery belongs to the adapter. The upload guide documents completion behavior; it does not establish a stronger universal guarantee that every observer can only ever encounter complete content. Receivers therefore validate before accepting. [Upload guide](https://developers.google.com/workspace/drive/api/guides/manage-uploads)

Generate a Drive file ID and durably attach it to the sealed publication before create. Retrying that same ID avoids duplicate objects; Google documents a 409 conflict after prior successful creation. On 409, read and verify identity/content before acknowledging: a conflict alone is not proof of the expected content. Pre-generated IDs support drive and appDataFolder. Never confuse a protocol UUID with a generated Drive ID. [Create files and pre-generated IDs](https://developers.google.com/workspace/drive/api/guides/create-file), [generateIds](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds)

Other transports may provide only at-least-once physical publication. The generic protocol must still tolerate duplicate artifacts containing identical operations. Unknown timeout outcomes retain the publication intent. No remote request/acknowledgement is atomic with the local database.

### Listing, changes, consistency, and scale

Use the proper space, bound parent IDs, trashed=false, narrow field masks, and all nextPageToken pages. A short or empty page is not the end when a next token exists. Restart a rejected listing token; detect incompleteSearch rather than declaring completion. Files added/removed during pagination can change results. [files.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list)

The consulted docs do not establish linearizable listing or multi-file transactions. Treat discovery as duplicate/out-of-order and potentially temporarily incomplete. Retry unreadable references and periodically reconcile. Do not use modifiedTime or UUID chronology as a permanent cutoff.

Start with complete paginated reconciliation and a known-segment cache. If measured cost warrants changes-feed optimization, obtain the start token before the initial scan, scan, then drain changes from that token. Persist continuation only after durable processing or enqueueing. Drive changes concern file state, not the application's immutable operation history. Current v3 documentation says changes page tokens do not expire; do not invent a routine expiration/410 rule. Handle explicit provider rejection and full-reconcile when needed. [changes.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list), [about changes](https://developers.google.com/workspace/drive/api/guides/about-changes)

Thousands of sessions do not necessarily mean thousands of files, but immediate single-op sync can still approach that count. Batch opportunistically and page all requests. Cache applied segments; keep history rendering entirely local; bound download concurrency and retry with backoff/jitter. Current quotas use quota units with method costs, so do not freeze an old requests-per-minute number into the protocol. [Current usage limits](https://developers.google.com/workspace/drive/api/guides/limits)

### Manual remote changes and limits

Never interpret a removed/trashed segment as a session deletion. A known immutable segment changing content is an integrity fault. A temporarily unreadable object is not automatically corrupt: retry/authenticate first. A missing root requires deliberate recovery, not automatic repopulation.

A new installation cannot necessarily detect an already deleted historical segment without an independently retained completeness record. A changed well-formed segment first seen by a new client is not authenticated by its filename. This is an explicit recovery limitation of user-editable storage, not justification for a new backend or mutable global manifest. Local retained journals and dataset archives are the recovery sources. Checksums help detect known-content change; they are not authenticity or backup.

### Minimum transport contract

Method names are unimportant; required semantics are:

- Discover candidates, explicitly create, and bind a locator to expected immutable dataset metadata.
- Paginate enumeration with opaque continuation/completion; optional changes discovery remains an optimization.
- Read bounded bytes; publish stable segment identity and sealed bytes with outcomes confirmed, same-content-already-present, unknown, or conflict.
- At-least-once delivery, no ordering or multi-file transaction assumption, no rewrite of immutable content.
- Distinguish authentication-required, permission-denied, dataset-missing, retryable, invalid-artifact, and integrity-conflict.

Classify provider errors only as precisely as evidence allows. A not-found response can also mean an inaccessible binding; “dataset missing” is not proof that the user deleted it. Either case preserves local data and stops automatic recreation.

Account IDs, generated file IDs, Drive queries, cursors, folders, quotas, and OAuth never enter operation ordering or entity identity.

## 7. Cross-platform compatibility review

These are proposed normative v1 choices, not claims that the current conceptual examples already specify them.

| Topic | Risk | Recommended exact contract |
|---|---|---|
| Time | Locale parsing, offsets, 7-digit .NET fractions, leap seconds, permissive date normalization. | Fixed Gregorian UTC form YYYY-MM-DDTHH:mm:ss.SSSZ, years 0001-9999, exactly three fractional digits, no leap seconds or offset variants. Validate calendar dates before conversion. |
| Historical timestamps | Client clocks change or imported times are imperfect. | Preserve authored start/end. Do not derive focus or require focus<=end-start. Flag impossible-looking chronology; do not discard otherwise valid focus solely on wall-clock ordering. |
| Duration | Floating seconds, 32-bit overflow (~24.8 days in ms), rounding differences. | Positive integer milliseconds, never float seconds. Proposed maximum 3,155,760,000,000 ms matches reference validation. Use at least checked 64-bit/native safe-number storage. |
| Lamport | JSON doubles lose large integers; string order puts 10 before 2. | Integral JSON number 1..9,007,199,254,740,991 for ops, numeric comparison, checked increment, no wrap. |
| JSON numbers | Fractions, exponent/rounding, nonfinite values, negative zero. | Emit plain decimal integers; reject fraction/exponent spellings and negative zero in integer fields. Validate without first rounding an out-of-range token into range. |
| UUID | Case, braces, .NET Guid internal layout, locale or signed-byte comparison. | Lowercase 36-character hyphenated text. Order by the 16 RFC/network-order unsigned bytes (equivalent canonical ASCII order), never Guid.ToByteArray layout or locale collation. Allow v4 and v7 IDs; prefer v4 where time sorting is unnecessary. |
| UUID time | UUIDv7 mistaken for conflict version or true chronological authority. | Random IDs establish identity only; history sort uses explicit timestamps plus ID for stable presentation ties. UUID order is never causal order. |
| Text | UTF-8 vs UTF-16 lengths, Swift graphemes, silent NFC normalization. | UTF-8, valid Unicode scalar sequences, reject unpaired surrogates. Preserve received code points exactly; no merge-time trimming, case folding, or NFC/NFD conversion. |
| Description bound | Reference “120 characters” is actually UTF-16 units. | Proposed portable limit: 120 Unicode scalar values; this intentionally broadens some emoji titles. Use the same scalar-count validator in all clients, not language string.length. UI blank-title default is an authoring rule. |
| JSON objects | Duplicate names have parser-dependent winners; object order varies. | Reject duplicate names after escape decoding; object-member order and equivalent escapes do not affect semantic equality. Reject BOM for the wire format; export compatibility conversion is separate. |
| Missing/null | undefined, absent, null, empty text can be conflated. | Required typed fields must exist and be non-null. UPSERT contains full required snapshot; DELETE payload absent. Empty description may be explicitly allowed as text; never interpret it as missing or a delete. |
| Unknown fields/types | Old writers erase future persistent data or skip mandatory semantics. | Closed persistent v1 schema; unknown semantic data is unsupported. Only explicitly independent informational envelope metadata is ignorable. No skip-and-report-synced behavior. |
| Identity consistency | Envelope and payload disagree; parsers trust different copies. | Validate dataset/version/writer and entity ID/type equality before applying any operation. |
| Resource limits | One client accepts content another refuses; huge/deep JSON exhausts memory. | Same protocol ceilings for segment bytes/count/text/depth. Proposed depth ceiling 16 and sizes in §5; local transport limits must still accept every legal v1 segment. |
| Aggregation | Thousands of values can overflow despite legal individual durations. | Checked sums or larger arithmetic locally; no floating conversion or truncated totals. Statistics are derived, not replicated authoritative counters. |

[RFC 8259](https://www.rfc-editor.org/rfc/rfc8259.html) documents JSON's numeric interoperability limits, duplicate-name differences, and Unicode pitfalls. The stricter application rules above are deliberate protocol choices.

For UUIDs, follow [RFC 9562's representation](https://www.rfc-editor.org/rfc/rfc9562.html); Microsoft's [Guid.ToByteArray documentation](https://learn.microsoft.com/en-us/dotnet/api/system.guid.tobytearray) explicitly documents its different default byte order.

No canonical JSON serializer is required for v1 convergence: compare parsed values and retain original sealed segment bytes for retry/checksums. Do not hash arbitrary reserialization as an identity primitive. If future signatures require canonical serialization, adopt an established scheme as part of that version.

### Session model and separation of responsibilities

**Domain:** stable session ID, startedAt, endedAt, focusDurationMs, description. These support existing history, editable history, totals, and ordinary import/export. Store focused duration independently; do not synchronize pause intervals without a product need.

**Synchronization envelope/state:** dataset/device/op/segment IDs, protocol/schema versions, Lamport counter, winning version, terminal deletion fact, deduplication, publication records. Keep these outside the domain record. entityType belongs in the operation; duplicating it in payload is unnecessary unless equality is enforced.

**Local-only runtime:** running/paused state, accumulated focus, live monotonic anchor, active identity/revision, checkpoints, UI/preferences, OAuth, provider locators/cursors. None is a synchronized session.

Recommend removing required createdAt/updatedAt from SPEC §§13-14 v1: the reference lacks them and no current behavior needs separate historical audit timestamps. Completion's endedAt already records finish. If retained, define them as author-supplied audit fields, never version authority; legacy migration cannot invent their true values. Do not store redundant audit dates merely to implement conflict ordering.

For history editing, define v1 controls deliberately: description, focused duration, and start/end correction. ID is immutable; editing duration must not recompute timestamps or paused intervals. Positive duration and valid individual dates remain required. No new tags/projects or original-timezone fields are necessary yet.

Basic totals can preserve the existing viewer-timezone finish-date rule without an extra field. Identical synchronized data can intentionally yield different “today” totals in different timezones. Exact day-boundary splitting of focused work cannot be reconstructed from start/end/focus alone when pauses occurred. If that feature is later required, make its data requirements explicit then; do not claim the current model can infer it.

### Evolution and migrations

Freeze protocol semantics independently of each client's local database schema version. A local storage migration must not generate new sync operations or regenerate IDs merely because serialization changes. Migrate atomically or retain a recoverable prior database; a failed migration must not clear history.

For the reference importer, preserve generated UUIDv4 identities and normalize their spelling without changing the UUID value. Its Guid.TryParse loader accepts forms/versions beyond this proposed wire profile. Quarantine unsupported legacy UUID variants/versions and duplicate identities found after canonicalization; explicit mapping/recovery is required rather than silent regeneration. Convert legacy submillisecond date precision deliberately while preserving effective duration.

v1 supports its fixed entity/operation set for years. Additional semantic fields/entity types require an explicit compatibility plan; closed v1 clients cannot be promised universal future interoperability. An unsupported reader retains local data/raw artifact and pauses affected sync, preserving pending work and displaying upgrade/recovery status. Local stopwatch use continues.

A breaking upgrade can create a new protocol dataset and explicit cutover while preserving/exporting the old one. Do not run incompatible reducers in the same unchanged dataset or silently dual-write two divergent versions. Existing old clients remain usable locally, but cannot transparently participate in unknown semantics. Narrow SPEC §77's unconditional compatibility promise accordingly.

Future tags/projects need references and delete rules; future encryption needs keys, authenticated envelopes, recovery, and version negotiation; snapshots need coverage and old-client behavior. Reserve design space by keeping transport byte-oriented, not by implementing capability frameworks now. A second transport can carry the same immutable dataset; deliberate migration must copy its full operation/tombstone corpus without generating new operations. Simultaneous multi-provider bridging is outside v1.

## 8. Failure-recovery matrix

“Safe?” evaluates the written draft, not nonexistent sync code. **Partial** means the principle is present but recovery is unspecified. Automatic recovery assumes retained durable local/remote data and valid authorization.

| Failure | Expected result | Current design safe? | Recommended handling |
|---|---|---|---|
| Browser crash during finish commit | On restart, either active session remains, or exactly one completed record and operation exist. | Partial | Atomic transaction, stable active identity/revision, inspect committed state after restart. |
| Crash between history mutation and outbox insert | No history-only committed change. | Partial: “should” atomic | Mandatory all-effects transaction including clock and active transition. |
| Crash after history/outbox but before active clear | No second completion from the same active state. | Not specified | Active clear in the same transaction; finish idempotent for that local active identity. |
| Local quota/write failure | Prior state retained; success not reported; retry possible. | Partial | Handle transaction abort visibly; retain in-memory work where possible, offer export. Do not clear active state. |
| Crash before/while sealing segment | Reuse durable sealed batch or leave operations pending. | Not specified | Seal transaction precedes network; no half-recorded membership. |
| Upload finishes but response is lost | Retry confirms same publication without new operations. | Partial: idempotency principle | Stable bytes/logical ID and adapter handle; unknown outcome remains pending. |
| Network loss halfway through sync | Committed progress persists; uncommitted downloads/uploads retry. | Partial | Durable per-artifact state; no cursor/ack beyond effects or pending queue. |
| Duplicate retry or duplicate physical file | No extra sessions or altered winners. | Yes in principle | Immutable op IDs, set reducer, same-content checks; duplicate bytes are not new commands. |
| Crash during inbound processing | Retry applies missing effects once. | Not specified | Effects, high-water, dedup/segment markers atomic or resumably staged. |
| Rejected listing continuation / interrupted scan | Restart enumeration without losing discoveries. | Not specified | Opaque cursors, durable pending refs, periodic complete reconciliation. |
| OAuth token expiration | Local actions work; sync resumes when authorized. | Partial | Browser may require user action; show authorization-required, preserve outbox. |
| User revokes permissions / wrong account | No upload to another account or local deletion. | Partial | Pin binding; pause; explicit reconnect/rebind; distinguish retryable from permission failure. |
| API quota/rate limit | Delayed synchronization, no data loss. | Partial | Bounded backoff/jitter, lower concurrency, retain pending work. |
| Bound remote directory deleted | Local history retained; remote removal not silently undone. | Not specified | Stop auto-publish; deliberate restore/new dataset; never infer session DELETE. |
| One historical segment removed | Known client reports damage; new client may not know the missing history ever existed. | No completeness guarantee | Retained local journal/archive repair; disclose detection limit; no inference from absence. |
| User changes immutable file | No silent overwrite/first-arrival choice. | Not specified | Compare known original content/digest, quarantine integrity fault, explicit repair. First-seen well-formed edits lack authenticity guarantees. |
| Truncated upload / transient unreadability | Artifact remains pending, valid state unaffected. | Partial | Retry and validate complete content; do not permanently mark known/applied. |
| Malformed segment / corrupt JSON | Good local history retained; damaged segment not half-applied. | Partial | Whole-segment validation, bounded parsing, quarantine raw reference/bytes, error status. |
| Same ID with conflicting payload | No false claim of deterministic healthy sync. | Not specified | Integrity conflict, preserve evidence and stop affected publication; no first-seen winner. |
| Unsupported protocol/schema/entity/op | Local history retained; no guessed materialization or unsafe overwrite. | Partial: “fail safely” | Pause affected dataset, retain raw artifact/pending work, show upgrade required; do not skip-and-advance. |
| Device offline for a year | Full catch-up and deterministic merge. | Conditional | Retain all journals/tombstones, page replay; old delete still terminal; support/version/auth required. |
| Site storage cleared | Restore published history after reauthorization; only-copy unpublished work is gone. | Unavoidable loss boundary omitted | New identity, explicit dataset join, remote replay, export/backup guidance. No sync algorithm recovers destroyed unpublished data. |
| Reinstall | Fresh writer identity; no sequence/ID reuse; published history replayed. | Not specified | Bind known dataset after authentication and hydrate; do not auto-import stale backup as newer edits. |
| Independent database clone | Both can write without publication collisions. | Not specified | Rotate identity for newly authored operations. Preserve original IDs/writer/content of historical or pending ops; retry recovered publication unchanged, never repack under a mismatching new writer. |
| Reload/crash with active timer | Attach if another tab still owns the live timer; otherwise recover last checkpoint paused. | Partial: survival only | Arbitrate/fence local execution ownership before recovery; exclude closed time; no guaranteed five-second loss bound. |
| System sleep/resume | Running/paused semantics consistent with declared platform policy. | Not specified | Platform integration checks, no timer-tick counting; document any unsupported continuity behavior. |
| Local schema migration fails | Recoverable prior state, no fake sync changes. | Not specified | Transactional/versioned migration with retained recovery source; no ID regeneration. |
| History JSON re-imported twice | No accidental duplicate identities or resurrection. | Partial: validation only | Explicit merge/copy mode, preserve IDs for merge, fresh IDs for deliberate copy/restore, tombstone-aware import. |

## 9. Overengineering / simplification opportunities

| Area | Assessment | Decision |
|---|---|---|
| HLC preference | Over-specified mechanism, under-specified actual algorithm. | Replace with one Lamport high-water and UUID tie-break. |
| Per-device nested remote folders / listDevices | Physical layout adds discovery/bootstrap work; not a protocol requirement. | Shallow segments, writer ID in envelope; no mandatory registry. |
| Logical layering | Useful separation; packaging is advisory. | Keep boundaries, postpone elaborate monorepo/tooling/plugin frameworks. |
| UUIDv7 preference | Sortability unnecessary for correctness and not trustworthy causal time. | Accept v4/v7, prefer widely supported v4 when time sorting is not used. |
| Entity-type/schema metadata repeated everywhere | Some discrimination needed; copies can disagree. | Keep operation/envelope discriminator, minimize payload repetition; validate any duplication. |
| createdAt/updatedAt | Extra fields without an existing audit requirement or legacy values. | Remove required v1 audit dates; never use them as merge clocks. |
| General future transports | Good adapter boundary; no need to implement every provider's capabilities now. | Specify minimum byte/publication/discovery semantics and an in-memory adversarial transport. |
| Conflict-preserving CRDTs / vector clocks | Solves richer requirements than current product. | Whole-session winner plus terminal delete; retain raw losing ops. |
| Infinite sophisticated recovery | No backend can recover a destroyed only copy; user-edited history cannot be authenticated by JSON shape. | State limits; provide archive/export and explicit repair. |
| Snapshots / compaction / device acknowledgements | Premature distributed coordination. | Retain v1 history; measure replay before non-destructive snapshots. |
| Encryption | Desirable future option, but keys/old clients need a separate design. | Keep transport opaque; postpone encryption implementation and capability machinery. |
| Broad generic extension model | Risks unsafe optional-field promises. | Closed v1 semantic schema; version deliberate changes. |

Under-specified blockers are transactions, identity enrollment, immutable publication retry, receive checkpointing, exact validation/ordering, schema compatibility, and recovery status. Over-specified details include HLC preference, elaborate repository structure, and a deep Drive directory tree before proving authorization/discovery. Do not confuse the two.

## 10. Recommended architecture

### What to implement after revising the contract

1. **Local stopwatch/domain:** idle/running/paused commands, accumulated focus, descriptions, completion/reset rules. Independent across devices. Durable active identity/revision; local owner arbitration, attach to live owner, paused recovery after owner loss.
2. **Transactional local repository:** active state, completed projection/tombstones, immutable operations, Lamport high-water, sealed publications, dedup/received status, provider binding. IndexedDB is the web adapter; native clients choose their own transactional store.
3. **Portable protocol core:** strict parser/validator, full-snapshot UPSERT, terminal DELETE, numeric counter/opId ordering. Pure reducer, no UI/provider/database dependencies.
4. **Sync runner:** single coordinated worker per local binding where practical, transaction-safe even with competing workers. Seal, publish/retry/ack, enumerate/read/validate/apply. All user commands remain local.
5. **Drive adapter:** platform authorization, explicit dataset discovery/create/bind, paged immutable-object I/O, generated file-ID retry handles, typed errors/backoff. No provider identifiers become domain IDs.

No developer-controlled backend, active timer handoff, realtime coordination, or mandatory account is required.

### Dataset lifecycle

Every installation can begin with an offline local collection and stable session IDs; it may allocate its own local dataset UUID and operation history immediately. Enabling synchronization either creates that dataset remotely or explicitly joins a chosen existing dataset.

Joining with pre-existing local history is a reviewed import/adoption, not a rewrite of old immutable operations. Preserve the original collection/archive; hydrate the selected dataset; create fresh target-dataset operations for adopted records. Default to adding IDs unknown to that dataset, retain its existing values for overlapping IDs, and respect its tombstones. Replacing an existing value or restoring a deleted one is deliberate; restoration uses a fresh ID. Pending work is never silently redirected to a different account/dataset.

Adoption itself needs durable resumable progress: keep source commands working during network hydration, catch up edits/completions made since its initial snapshot, then atomically check source revision and cut over the binding. Do not publish staged adoption work until its selected source view/cutover is coherent. A crash resumes or cancels from durable progress without stranding source changes.

Writer rotation affects newly authored operations only. Recovered pending/sealed operations keep original op IDs, writer, and bytes and retry as their original publication; alternatively, explicitly adopt unsent visible state with fresh operations. Never alter an old operation's deviceId or put it into a segment whose writer fails the envelope match. Replaying an existing immutable publication is recovery, not authoring new work for the old installation.

The first-init race cannot be eliminated by choosing a deterministic folder name or listing twice. Explicit create/join plus ambiguity recovery is sufficient for a personal app; it does not need distributed leader election. A second device may initially create a separate legitimate dataset, but the app must surface that fact rather than falsely claim a shared one.

### Release gates and precise SPEC changes

Apply the companion proposal's changes before freezing v1. In particular replace §32's HLC preference, §34's delete ordering, §27's advisory atomicity, §49's optional-field promise, and §§38-42's implicit bootstrap/authorization assumptions. Correct the reference language/editing claims and specify lifecycle/timing/import behavior.

Then, in a later implementation task:

- Publish the normative protocol, schemas, and shared vectors. Cover permutations/duplicates, DELETE-before-UPSERT, late offline edits/deletes, counter ties/max, timestamps/UUID/Unicode boundaries, unknown versions, duplicate keys, mismatched envelopes, and same-ID content conflict.
- Use an adversarial in-memory transport that duplicates, reorders, delays, partially lists, and fails before/after publication. Inject crashes at each local commit/ack/cursor boundary, plus competing tabs and stale editor revisions.
- Prove the chosen Google scope with separate planned web/native OAuth registrations; test first-init ambiguity, same-ID retry, pagination during append, token expiry/revocation, manual removal, and tampered files.
- Implement local web behavior and platform timing tests; integrate Drive only after protocol invariants hold. Measure file count, cold replay, and normal incremental sync before adding feed/snapshot optimizations.

The target is a small deterministic replicated history with explicit recovery limits. The proposed changes preserve the product principles and remove avoidable ambiguity without turning the stopwatch into a distributed database platform.
