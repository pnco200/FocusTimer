# Focus Timer — Product & Technical Specification

**Status:** Draft v3 — architecture-reviewed
**Primary implementation target:** Web / PWA
**Behavioral reference:** Studytime 1.2 for Windows, C# / .NET Framework 4.8 / WinForms
**Synchronization contract:** Focus Timer Sync Protocol v1
**Long-term targets:** Independent TypeScript, C#, C++, Kotlin, Swift, and other clients

## 1. Purpose, authority, and scope

Focus Timer measures focused work with a stopwatch. There is no required target duration, countdown, or automatic completion.

This document is the self-contained product and implementation contract. MUST, MUST NOT, SHOULD, and MAY express requirement strength. All protocol field names, literals, ranges, comparison rules, and failure outcomes below are normative. Examples illustrate those rules; an implementation language is never the specification.

The existing C# implementation is a behavioral reference, not an architectural constraint. The architecture review has been integrated here; implementers do not need the change-proposal document to determine required behavior. A future protocol reference, schemas, and test vectors MUST agree with this contract. Discovering a contradiction requires an explicit specification correction, never silently choosing a client's behavior.

This revision authorizes specification work only. It does not authorize starting the web application, synchronization implementation, or production changes. The implementation phases in §37 are gates for a separately authorized development task.

## 2. Product principles and v1 scope

The application MUST support start, pause, resume, finish, reset, history viewing/editing/deletion, and export using local storage without an account, network, Google authorization, or developer-operated backend. Local storage failures are handled explicitly; no system can promise a successful durable write when storage is unavailable.

Synchronization is optional. Users own their data and can disconnect while retaining local history, export it, and deliberately remove remote copies. No Focus Timer server coordinates accounts, history, timers, conflicts, or recovery.

Active stopwatches are entirely device-local. Independent installations MAY run simultaneously; their resulting completed sessions are separate entities. Protocol v1 synchronizes completed sessions, edits, and terminal deletion facts only. It MUST NOT synchronize active/paused state, timer ownership, handoff, remote controls, preferences, theme, sound/notification settings, credentials, or provider cursors.

v1 MUST NOT introduce vector clocks, CRDT frameworks, mandatory device registries, mutable journal heads/global manifests, distributed garbage collection, device acknowledgement protocols, signatures, provider plugin frameworks, simultaneous multi-provider bridging, or active-timer synchronization. Real-time sync, collaborative/team accounts, social features, advanced statistics, and application-level encryption are outside v1.

## 3. Reference implementation and behavioral baseline

The supplied Reference-FocusTimer-SourceCode contains C# WinForms code targeting .NET Framework 4.8. C++ is only a possible future client. The existing full AppData JSON is not a synchronization format: it mixes active state, preferences, and history.

Preserve these observed behaviors:

| Behavior | Required treatment |
|---|---|
| Stopwatch focus | Sum only running intervals; paused time never counts. |
| Start/resume | Preserve original start on resume; repeated Start while running is a no-op. |
| Pause | Freeze accumulated focus; repeated Pause while not running is a no-op. |
| Finish | Permit running or paused sessions with positive focus, including subsecond sessions; successful finish clears active time and description. |
| Reset | Discard active timing/start but keep description and completed history; confirmation excludes its own dialog time. |
| Descriptions | Optional editable active title; trim at authoring completion, default blank to “Untitled session.” Apply the portable limit in §10. |
| Restart | Recover the last durable active checkpoint paused when its execution owner is gone; closed time is excluded. |
| History | Completed records only; newest finish first; title search; three recent entries where layout permits; explicit confirmed deletion. |
| Basic totals | Today, Monday-through-today, and all-time, using completed focus and finish dates in the viewer's current timezone. |
| Reporting | CSV export of all completed history, independently of the active search filter. |
| Failed save | No false success, no cleared active session after failed finish, and no silently reset history after unreadable storage. |

Completed-session editing is a NEW requirement; the reference only edits the active title and deletes completed records. The reference's 120-character implementation limit counts UTF-16 code units; v3 deliberately uses up to 120 Unicode scalar values.

Reference startup pauses restored work. Its README says a running stopwatch counts sleep, but its code relies on the platform Stopwatch rather than a suspend handler. The intended continuity and target proof/fallback are specified in §6. Approximately five-second checkpoints are opportunities, not a maximum crash-loss guarantee.

Native mutexes, WinForms controls, native file replacement/serialization, Windows filesystem paths, and topmost APIs MUST NOT enter the common protocol. Adapt responsive layout, theme, shortcuts, accessibility, and in-app notices to each platform.

## 4. Architecture and dependency boundaries

Use the following boundaries:

    Stopwatch/history domain
        → transactional local persistence
        → deterministic protocol validator/reducer
        → synchronization runner
        → transport adapter

The protocol validator/reducer MUST be independent of React, IndexedDB, browser APIs, OAuth, Google Drive, WinForms, and other platform APIs. Domain commands and projections use local transactional storage. The sync runner orchestrates durable state and network attempts; the transport handles provider I/O and authorization.

Recommended web tools are TypeScript, React, Vite, IndexedDB, and a service worker/PWA shell. Equivalent libraries MAY be chosen without changing protocol semantics. Native clients choose their own transactional persistence and platform UI.

Folder/package layout is advisory. A small domain module, transactional repository, pure protocol module, sync runner, and adapter suffice. No abstract framework is required for every layer or possible future provider.

## 5. Stopwatch state and commands

One installation has at most one active stopwatch across its local tabs/windows. Idle means no started stopwatch; an idle description draft MAY exist. Running and paused state contain a stable local activeSessionId, local revision, owning local dataset ID, original start timestamp, description, and accumulated focus. Execution-owner fencing metadata is local-only.

- **Start from idle:** create activeSessionId, record current UTC start, begin a live measurement interval, and commit active state locally. No completed-history operation is created.
- **Start from paused / Resume:** preserve activeSessionId, original start, and accumulation; begin a new measurement interval.
- **Start while running:** no-op.
- **Pause:** sample current focus, commit paused accumulation, clear the live interval. Pausing idle/paused state is a no-op.
- **Finish:** require a started session and positive focused milliseconds. Capture end time and focus once; create a fresh session entity ID and complete snapshot. Atomically commit completion and its operation as required in §15, consuming the expected active identity/revision. Clear the active state and description only after success.
- **Reset:** confirm before discarding positive focus. Pause before confirmation; cancelling resumes only if it was running before the dialog. Confirmed reset clears start, active identity, and accumulated focus, preserves description/history, and creates no history operation. There is no separate synchronized cancel event.
- **Active description edit:** affects local runtime state only. Persist on a short debounce and on state transitions/close where execution is available. Do not claim uncommitted keystrokes are durable.

A duplicate Finish retry for an already consumed active identity MUST return the committed completion outcome or a stale-command result, never create another session. Concurrent commands MUST check local identity/revision and execution-owner fencing inside their transaction. Negative or over-limit focus MUST NOT be silently clamped into a different historical duration.

## 6. Measurement, backgrounding, suspension, and wall clocks

While running:

    focused time = accumulated focused intervals + current live running interval

Use a monotonic measurement source where available. A display refresh interval MUST NOT measure time by incrementing a counter. Delayed rendering/background throttling must not itself reduce focus. Preserve measurement continuity through checkpoint I/O; re-anchoring MUST NOT discard the elapsed time spent saving.

Wall clocks provide startedAt/endedAt for history only. They MUST NOT order synchronization operations. Do not infer focus from endedAt minus startedAt, infer pauses, or reject a positive session merely because a wall-clock correction makes end earlier than start. Paused time remains excluded regardless of wall-clock changes.

Completed focus is positive integer milliseconds; retain sufficient local precision and truncate any nonnegative submillisecond remainder when creating the completed value. Ordinary display may show whole seconds; hours MUST NOT wrap after 24.

A running stopwatch is intended to include system sleep/suspension while the same execution owner survives, consistent with the desktop's documented behavior. Each supported target MUST prove its measurement source's actual suspend/resume and clock-adjustment behavior. A platform that cannot measure the gap reliably MUST use a disclosed conservative recovery: retain the last proven durable focus, recover paused, and indicate possible missing time. It MUST NOT silently add arbitrary wall-clock gaps. Sleep-continuity support/fallback is a platform proof gate, not a change to merge semantics.

Hidden/backgrounded tabs are not dead owners. When the prior owner is genuinely gone, restore from its last durable checkpoint paused; do not add closed time from an obsolete anchor. Monotonic anchors from a dead execution context MUST NOT be reused as live anchors in another context.

## 7. Local ownership, checkpoints, and crash recovery

Persist activeSessionId, local revision, owning dataset, state, original start, description, and accumulated focus/checkpoint. Runtime clock anchors and execution ownership are not protocol fields.

The local ownership mechanism MUST combine an execution-lifetime coordination primitive where supported with transactional fencing. Every owner command/checkpoint checks its current owner token and active revision. Taking ownership/recovering increments the fencing generation; an old owner returning later cannot commit under its obsolete token.

A newly opened/reloaded tab attaches to a live owner rather than pausing or independently completing its timer. Lack of a heartbeat alone MUST NOT prove owner death. If death cannot be established, show an unresponsive-owner condition and require deliberate fenced recovery. That recovery uses the durable checkpoint, invalidates old commands, and acknowledges that uncheckpointed focus may be lost. It is local tab coordination, never cross-device synchronization.

Attempt running checkpoints approximately every five seconds when execution/storage permit, plus pause/resume/reset/finish transitions and ordinary close. An orderly close of the actual execution owner SHOULD snapshot and pause while execution permits; closing a non-owner tab does not pause another live owner. Active-description debounce SHOULD be approximately 700 ms. Browser shutdown handlers are best effort; correctness MUST NOT depend on their execution. After a failed checkpoint, preserve work in memory where possible and show a save error. The possible crash-loss window is time since the last successful checkpoint, which can exceed five seconds.

Recover unreadable local data from a validated recovery source if available; preserve the damaged source for diagnosis. If no valid source exists, offer explicit recovery/new local collection rather than silently replacing history with an empty dataset.

Dataset switching/adoption final cutover requires the local active stopwatch to be idle (§20). Network hydration may occur while it runs; its finish still belongs to its original dataset except for the deliberate counter-exhaustion recovery completion in §13. Viewing another collection must not silently retarget it.

## 8. History, editing, deletion, totals, and presentation

History MUST use a local materialized projection and include completed, non-deleted sessions only. Sort by endedAt descending, with canonical entity ID ascending for equal end times. For the strict UTC representation, ordinary timestamp text order agrees with chronological order. Search MUST support case-insensitive description substring matching in the client's presentation locale; search collation is presentation behavior and MUST NOT affect identity or merge ordering.

Where useful, show three recent sessions, finish date/time, description, and effective focus. Users can inspect start/end, but elapsed wall span is not focused duration.

New editing MUST support description, startedAt, endedAt, and focusDurationMs independently. ID is immutable. Editing duration/dates MUST NOT invent pause intervals or recalculate another field implicitly. Validate each date/duration using §10. At commit, compare the edited winner/revision against the current local winner. A changed or deleted base requires explicit refresh/review/reapply, never a silent stale-form overwrite. An unchanged edit produces no operation.

Confirm deletion. A visible-session delete creates a terminal DELETE. Repeated deletion of an already tombstoned key, or a request for a genuinely unknown local key, is a no-op. Remote DELETE may still arrive before the original UPSERT and is valid. Undo/restore/copy creates a fresh ID, not an edit that revives the old key.

Basic statistics MUST sum focus and count completed live sessions, excluding active work. Attribute the entire duration to the session's finish date converted into the viewer's current local timezone:

- today: finish local date equals today;
- this week: Monday of the current local week through today inclusive;
- all-time: all live completed sessions, including future-dated records if authored that way.

Totals in different timezones may differ with identical synchronized data. Use checked/exact aggregation without overflow or floating truncation. Do not split focus across days from start/end/focus alone; pauses make such reconstruction impossible. Streaks, trends, tags/projects, and other advanced statistics remain future work.

## 9. Minimal synchronized domain model

A FocusSession contains exactly these five fields:

| Field | Type and meaning |
|---|---|
| id | Immutable session UUID; equals operation.entityId. |
| startedAt | Original/authored corrected start, strict UTC timestamp. |
| endedAt | Finish/authored corrected end, strict UTC timestamp. |
| focusDurationMs | Positive integer focused milliseconds, excluding pauses. |
| description | Exact Unicode scalar text, including an explicitly empty string if present in received/imported data. |

createdAt, updatedAt, pause intervals, runtime state, original timezone, tags/projects, synchronization clocks, and provider data are not v1 domain fields. Schema/type versions belong in the operation envelope. No audit timestamp may be invented to implement ordering.

Application authoring on Finish or a description edit trims only the following fixed whitespace scalars at both ends: U+0009..U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000..U+200A, U+2028, U+2029, U+202F, U+205F, U+3000. If the result is empty, store the literal “Untitled session.” Validate the 120-scalar input bound before committing. Existing received/imported values are preserved exactly; applying this authoring rule is not part of parsing or merging.

## 10. Exact v1 wire profile

These rules apply to every v1 descriptor, segment, operation, and session. Portable export envelopes use the same scalar/number/date/UUID rules with their own defined fields.

| Aspect | Normative rule |
|---|---|
| Encoding | UTF-8 without BOM; reject invalid UTF-8 and unpaired UTF-16 surrogate escapes. Strings represent Unicode scalar sequences. |
| JSON | RFC 8259 syntax only. Reject duplicate object names after decoding escapes, including two spellings that decode to the same name. JSON whitespace is only space, tab, CR, LF. |
| Integers | Tokens match 0 or a nonzero ASCII digit followed by zero or more ASCII digits. No sign, negative zero, fraction, exponent, numeric string, NaN, Infinity, or rounding before range validation. |
| Required values | Every listed required field exists with the exact type and is non-null. Absence, null, empty string, and zero are distinct. DELETE payload is absent, not null. |
| UUIDs | Lowercase 36-character form xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx using ASCII hexadecimal; RFC variant bits 10 and version nibble 4 or 7. Reject braces, URNs, uppercase, nil/max, and other versions/variants. |
| UUID ordering | Compare the 16 RFC/network-order bytes as unsigned bytes, lexicographically. Equivalently compare canonical ASCII UUID strings. Never use platform Guid mixed-endian storage, signed-byte comparison, or locale collation. |
| Timestamps | Exactly YYYY-MM-DDTHH:mm:ss.SSSZ; ASCII digits, year 0001..9999, Gregorian valid month/day, hour 00..23, minute/second 00..59. Exactly three fractional digits; uppercase T/Z; no offsets, leap seconds, expanded years, or permissive normalization. Leap years are divisible by 4 except centuries not divisible by 400. |
| Duration | focusDurationMs in 1..3,155,760,000,000 inclusive. Minimum 1 ms; independent of wall-clock span. |
| Counter | Operation lamportCounter in 1..9,007,199,254,740,991 inclusive. Local high-water C additionally permits zero. |
| Description | String of 0..120 Unicode scalar values. Count scalars, not UTF-16 code units, UTF-8 bytes, or grapheme clusters. Preserve code points without NFC/NFD conversion, trimming, or case folding on ingestion. |
| Segment bytes | At most 1,048,576 raw UTF-8 bytes, including all JSON whitespace. |
| Segment operations | 1..1,000 operations; no repeated opId inside one segment. The same operation may appear in different artifacts. |
| Depth | Maximum container depth 16. Root object has depth 1; each nested object/array adds 1; scalars add no container depth. |
| Descriptor bytes | At most 1,048,576 raw bytes, with the same validation/depth rules. Its actual closed shape is small. |
| Unknown data | Exact closed shapes in §12. Unknown fields, protocol/schema versions, operation names, or entity types are unsupported data; pause affected synchronization safely. Wrong types/missing required fields or invalid values are malformed. No generic extension container is defined in v1. |

Every conforming transport/client MUST accept all artifacts within these limits and MUST reject over-limit v1 artifacts without partial ingestion. Reads/parsing MUST enforce limits before unbounded allocation or numeric loss. A v1 reader need not accept larger future artifacts to identify their semantics; report unsupported/invalid oversized data without claiming healthy sync.

Language parsers' permissive defaults are insufficient. Native duration/counter arithmetic needs checked 64-bit or equivalent exact values; TypeScript uses only exact safe integers for wire values. Aggregate totals may need wider arithmetic than one value.

No canonical JSON serializer is required. Object order, legal whitespace, and equivalent string escapes do not affect parsed operation meaning. Exact sealed segment bytes are separately immutable (§16). Cryptographic signatures/canonical hashing are outside v1.

## 11. Protocol identities and version authority

datasetId identifies a historical dataset, independent of account, provider locator, local database, platform, or origin. deviceId identifies a writer installation, not a human account. opId identifies one immutable operation globally. segmentId identifies one immutable batch. Session IDs identify domain entities.

Use securely generated UUIDv4 by default; canonical UUIDv7 is accepted, but its embedded time is never authoritative ordering. UUID sorting is not causality. Do not use database sequences, provider IDs, timestamps, names, or display labels as protocol identities.

Supported protocolVersion is 1. Supported FocusSession schemaVersion is 1. protocolVersion defines envelope/reducer semantics; schemaVersion identifies the entity schema in an operation, including DELETE. Local database versions are independent.

Deduplicate operations by (datasetId, opId). Materialize entities by (datasetId, entityType, entityId). Identify segments by (datasetId, segmentId). Names and folders do not narrow or override these keys.

## 12. Closed descriptor, operation, and segment schemas

Field lists below are exhaustive. All listed fields are required except UPSERT-only payload, which MUST be absent on DELETE. All UUID/date/integer/text values obey §10.

### 12.1 Dataset descriptor

Fields: application (literal "focus-timer"), protocolVersion (integer 1), datasetId (UUID).

    {
      "application": "focus-timer",
      "protocolVersion": 1,
      "datasetId": "11000000-0000-4000-8000-000000000001"
    }

The descriptor's parsed semantic content is immutable. Retain its validated identity when binding. It is not a mutable segment index, device registry, or upgrade switch.

### 12.2 Operation

| Field | Exact meaning |
|---|---|
| protocolVersion | Integer 1, equals segment.protocolVersion. |
| schemaVersion | Integer 1, the FocusSession schema version. |
| opId | Operation UUID, unchanged on retries. |
| datasetId | Equals enclosing segment and bound descriptor datasetId. |
| deviceId | Original author/writer UUID; equals segment.deviceId. |
| entityType | Literal "focusSession". |
| entityId | Entity UUID. |
| operation | Literal "UPSERT" or "DELETE". |
| lamportCounter | Exact positive integer in §10 range. |
| payload | UPSERT only: object with exactly the five fields in §9; payload.id equals entityId. |

Example UPSERT:

    {
      "protocolVersion": 1,
      "schemaVersion": 1,
      "opId": "33000000-0000-4000-8000-000000000001",
      "datasetId": "11000000-0000-4000-8000-000000000001",
      "deviceId": "22000000-0000-4000-8000-000000000001",
      "entityType": "focusSession",
      "entityId": "44000000-0000-4000-8000-000000000001",
      "operation": "UPSERT",
      "lamportCounter": 1,
      "payload": {
        "id": "44000000-0000-4000-8000-000000000001",
        "startedAt": "2026-10-17T15:20:00.000Z",
        "endedAt": "2026-10-17T16:43:10.000Z",
        "focusDurationMs": 4085000,
        "description": "Database study"
      }
    }

UPSERT is a complete replacement snapshot, never a patch. It can create an unknown entity ID. Omitted session fields are invalid, not instructions to preserve an old field. DELETE has the same required envelope fields, operation="DELETE", and no payload member at all. It does not require a prior known UPSERT.

### 12.3 Segment

Fields: protocolVersion (integer 1), datasetId (UUID), deviceId (writer UUID), segmentId (UUID), operations (nonempty bounded array of operations).

Each operation MUST match segment protocolVersion, datasetId, and deviceId. Session entity type is declared once in the operation; payload.id must match entityId. A segment is homogeneous by original writer. Each nested operation independently has schemaVersion=1.

Operations array order does not affect reduction, but the sealed array order/bytes never change on retry. No segment sequence, createdAt, previous/head pointer, registered device, or physical device directory is required.

## 13. Persisted Lamport high-water and exact ordering

Hybrid Logical Clocks are not part of v1. Wall-clock dates, UUIDv7 timestamps, upload time, and provider metadata MUST NOT determine operation ordering.

For each local dataset replica, persist one high-water C, initially 0 for an empty new dataset:

1. Accepting any valid remote operation r MUST persist C=max(C,r.lamportCounter) with its durable acceptance. This includes losing UPSERTs, DELETEs, and valid operations for already tombstoned IDs.
2. A new local synchronization mutation MUST atomically allocate counter=C+1, persist that value as C, and create the immutable operation with that counter and a new opId.
3. Shared tabs/workers allocate against the same transactional C. Sealing, publishing, receiving a duplicate already accepted operation, or replaying a projection MUST NOT mint a new mutation/version.
4. Never rewind C after restart, backup import, writer rotation, or projection rebuild; recover at least the maximum of the retained high-water and accepted operation counters.

Version comparison is a strict total order: numeric lamportCounter first, then lexicographic unsigned RFC/network-order opId bytes. deviceId is not another tie-break. Identical opId with unequal semantic content is corruption, not a clock tie.

A local edit after observing a remote operation orders after it. Unobserved disconnected edits have a deterministic arbitrary winner, not a guaranteed real-time “latest human edit.” A simple per-writer sequence without remote incorporation does not satisfy this rule.

C may equal the maximum value after accepting an operation. If C+1 cannot be represented within the range, abort that dataset's new mutation transaction; never wrap, clamp, reset, or re-version existing operations. Mark counter exhaustion/recovery required. The timer remains usable: offer an explicitly identified new local-only recovery collection for completion/continued history work, with its own dataset ID, C, operations, and transactions. Saving there requires a deliberate destination choice and does not rebind the damaged remote or relabel old work. No completion may claim success without a committed record and matching operation in its chosen collection.

This is a narrow exception to the normal original-dataset/idle-switch rules: after deliberate recovery-destination selection, one local transaction MUST consume the original active identity/revision/owner token and commit the recovery collection's descriptor as needed, completed session, immutable operation, C, outbox, and completion receipt. The original dataset/binding/history/pending work remain unchanged. Failure leaves the active session intact. This recovery Finish is not an ordinary binding switch; afterward, an ordinary idle local-collection switch may be selected explicitly.

## 14. Deterministic reducer and terminal deletion

Given a valid accepted operation set O, partition by entity key (datasetId, entityType, entityId). For each key:

1. If O contains any DELETE, materialize a tombstone and no visible FocusSession, regardless of any UPSERT's counter or arrival time.
2. Otherwise, if O contains UPSERTs, choose exactly the payload of the maximum (lamportCounter, opId) UPSERT.
3. Otherwise the entity is absent.

If storing representative tombstone metadata, use the maximum ordered DELETE. Retain deletion presence permanently even when a greater UPSERT is later accepted. Retain losing operations in immutable history.

This is terminal **DELETE-wins**, not ordinary LWW between edits and deletes. A stale year-offline delete may defeat newer edits. Restore/copy must use a fresh entity ID. The policy intentionally prevents later stale edits or history imports from reviving an old deleted ID.

For valid immutable identities, union of operation sets and the rule above produce deterministic, associative, commutative, idempotent materialization independent of arrival order. No global chronological replay is required. DELETE-before-UPSERT, duplicate physical artifacts, and repeated synchronization are safe.

Whole-session UPSERT selection does not preserve independent concurrent field edits: one snapshot wins. Do not add field-level merge or conflict-copy machinery to v1. Losing operations remain recoverable through a complete dataset archive.

## 15. Transactional local persistence and mutation success

The web client MUST use IndexedDB or equivalent transactional persistence. Native stores must provide equivalent atomicity/recovery, without sharing local database formats.

Persist, conceptually: active state/owner revision, dataset descriptors/bindings, completed projections/tombstones, immutable accepted/authored operations, C, outbox membership, sealed publication records, discovered artifact state, and opaque adapter checkpoints. These are local implementation structures, not wire tables.

A successful newly authored history mutation MUST atomically persist:

- the validated domain transition and winner/tombstone;
- its immutable operation with new opId;
- outbox membership;
- allocated Lamport high-water;
- for Finish, consumption of expected active identity/revision and the completion outcome.

There must be no committed authored domain mutation without its operation, or authored operation/outbox entry without the corresponding command transition. A valid received losing operation need not change the visible winner; its durable acceptance is governed by §17, not fabricated as a local command.

Generate IDs/results once per command attempt and preserve committed outcome receipts as needed for retry. Validate edited revision, active ownership, and selected dataset/binding generation inside the transaction. A stale command fails/refreshes; it is never redirected to a newly selected collection.

Report success only after transaction commit. A failed transaction leaves the prior durable state and outbox unchanged; retain unsaved work in memory if possible and show a save error. Do not clear a timer or report “saved locally” after quota/I/O failure. No network operation belongs inside a database transaction.

Domain no-ops (unchanged edit, repeated pause/reset where applicable, repeated deletion) do not create new sync operations.

## 16. Sealing, immutable publication, and acknowledgement

A pending operation may be assigned to at most one active sealed publication intent at a time. Competing sync workers MUST reserve membership transactionally; a leader lock alone is insufficient.

Before network publication, atomically persist:

- stable segmentId and dataset/original writer identity;
- exact final UTF-8 serialized segment bytes;
- exact included operation IDs and immutable values;
- their outbox reservation/membership;
- publication intent/state and current target binding generation.

Seal only operations from one original writer. Choose 1..1,000 operations and obey the byte limit; do not modify a sealed batch to add later edits. Batch by count/bytes/short execution opportunities; manual sync or a ready small outbox can seal a one-op segment. Do not wait indefinitely to fill a batch.

States MUST distinguish sealed/pending, in-flight, unknown outcome, and confirmed/acknowledged. A lost response leaves the same publication unknown and retryable. Retrying MUST reuse segment ID, exact bytes, writer, and membership. A provider-specific create handle may be acquired before upload but MUST be durable before a create that relies on it.

Confirm success or verify identical already-present content, then atomically acknowledge only that segment's operation IDs/reservations. New outbox entries stay pending. Verify that the confirmation belongs to the original pinned binding/publication intent; an account switch never acknowledges or sends another binding's work.

Do not require exactly-once transport delivery. Duplicate physical artifacts with identical sealed bytes or identical operations in distinct valid segments are tolerated. Same segment identity with different bytes is an integrity fault even if a different JSON serialization looks equivalent; operation identity uses parsed equality instead (§17).

Confirmation does not delete immutable operations, segment bytes, or tombstones. Retain them for recovery/retention. Sealed bytes never change after failure, reinstall recovery, or writer rotation.

## 17. Inbound validation, acceptance, and integrity faults

Track each discovered artifact reference as discovered, pending, applied, or quarantined, with binding, retry/error reason, and raw bytes where practical. “Known” alone MUST NOT mean applied.

Before accepting any operation from a segment:

1. Obtain complete bounded bytes; retry transient unreadability/truncation before diagnosing permanent damage.
2. Validate encoding, JSON names/tokens, all closed shapes, versions, fields, ranges, resource bounds, duplicate op IDs within the segment, and envelope/payload identity.
3. Verify the segment belongs to the bound descriptor/dataset and matches previously known immutable segment identity/content.
4. Compare every operation identity against durable accepted operations and other candidates in this segment. Equal (datasetId,opId) must have equal parsed fields/values. No first-received winner for conflicting identity.

After complete structural validation, use one bounded local transaction to recheck the current binding, segment identity/bytes, and every operation identity/content against durable state, then persist accepted bytes/operations, winner/tombstone changes, C, deduplication, and segment completion together. Enforce immutable-key uniqueness/content equality inside that transaction; pre-validation against a cache or an earlier transaction is insufficient. Two competing receivers of conflicting identities must cause the later transaction to detect the fault, never overwrite or silently skip it. v1 uses this bounded whole-segment acceptance transaction rather than exposing provisional per-operation effects. A crash leaves the segment entirely unaccepted or fully applied.

Parsed operation equality compares all defined fields, exact scalar string values, numeric integer values, and payload members; object member order and equivalent escape spelling are irrelevant. No normalization or removal of “irrelevant” defined fields is permitted.

Malformed data is quarantined, not partly accepted. Unsupported data pauses affected synchronization without guessed semantics. An identity conflict or a known immutable artifact changing content stops automatic ingestion/publication for that binding pending deliberate repair. Preserve valid local history and pending work; retain original/conflicting bytes or bounded references/diagnostics when storage permits. Do not silently roll back accepted data, overwrite the artifact, ignore the conflict, or announce convergence for a corrupt corpus.

While a binding is blocked, local commands on the known local v1 collection may continue and accumulate pending work if its counter/storage remain healthy. They MUST NOT be automatically published until explicit repair/upgrade/rebind resolves the condition. A future migration must deal deliberately with that pending work.

## 18. Discovery, pending downloads, and checkpoints

Enumeration is a set-discovery mechanism, not an operation order. Consume opaque pages until explicit completion; a short/empty page with continuation is not completion. Retry an interrupted or rejected continuation from a valid earlier point/full reconciliation.

A known-segment cache may skip reduction but MUST NOT permanently skip remote integrity verification. For every discovered physical reference, compare current bytes with retained original bytes, or use an adapter-proven unchanged-content indicator that detects byte changes. Unknown/changed indicators require a fresh bounded read and comparison. A newly discovered locator claiming an already-known segment ID also requires content verification. Known references omitted from a scan require availability/integrity checking rather than an inferred delete or an unchecked healthy pass. An optional changes feed may discharge these checks only with continuous, durably checkpointed coverage that proves no relevant change was skipped.

Persist a cursor/checkpoint only with successfully processed effects or a durable pending reference for every discovery it covers. Keep pending downloads across crashes; no processing marker may precede its durable effects. Quarantined/unsupported artifacts remain unresolved for status purposes, even if their references are durable.

Never use modifiedTime, UUID ordering/time, filenames, or maximum sequence number as permanent discovery frontiers. An older artifact can become visible later. Initial transport implementations MUST support full paginated reconciliation against locally known segment IDs/content. Repeat reconciliation on later passes to discover delayed/concurrent publications; one completed scan is not a linearizable global snapshot.

An optional changes feed may optimize discovery without changing protocol semantics. Capture its starting token before the initial full scan, then drain changes from that token. Commit continuation with effects/pending references. The feed reports storage-object changes; operations remain inside immutable segments. Do not invent provider expiration/ordering guarantees.

A missing/trashed remote file never implies domain DELETE. Discovery must not remove local sessions/operations because a remote list omits them.

## 19. Dataset discovery, creation, binding, and switching

Every fresh installation MUST create a local dataset descriptor/UUID, writer identity, C=0, and transactional collection without an account. Local-only history uses the same operation/outbox rules as bound history; no later reconstruction of missing mutation history is needed.

The remote lifecycle is explicit:

1. **Discover:** return validated candidates and incomplete/unreadable candidates with status; never select by first matching name.
2. **Create:** user deliberately chooses to create a remote representation of a local dataset; persist creation intent and adapter retry locators. Publish a complete immutable descriptor before allowing dataset binding/publication. Incomplete folder trees remain incomplete candidates.
3. **Join:** user chooses an existing candidate; validate descriptor/protocol and hydrate it before enrollment completes.
4. **Bind:** persist provider account context, stable provider locator(s), validated immutable dataset identity/version, and local binding generation together.
5. **Disconnect:** stop remote work while preserving local history, operations, outbox, and descriptor.
6. **Switch account/dataset:** explicitly select/validate a new binding/collection; isolate prior pending work and require idle active state at cutover. Stale workers/commands cannot silently use the new destination.

Names are labels, never identity or uniqueness primitives. Two devices concurrently creating different dataset UUIDs create two datasets; discovery must surface that fact/ambiguity rather than claiming they are shared. Repeated listing or a deterministic name cannot establish a singleton.

Two locators with the same datasetId may be duplicate remote copies. Do not silently choose one and ignore the other; require explicit reconciliation/selection, validate immutable contents, and preserve the union/archive before deliberate consolidation. Different dataset IDs are never auto-merged.

A different account may only receive the same dataset after deliberate authorization/copy/rebinding; copy the full immutable corpus without reauthoring operations. A different dataset requires adoption (§20). Never relabel existing operations, mutate dataset IDs, or redirect pending work because authorization changed.

A not-found response can mean inaccessible storage. Missing/damaged bound root stops automatic publication until deliberate recovery/rebind (§26); it is not implicit permission to recreate.

## 20. Durable adoption of existing local history

Joining another dataset with existing local history is an explicit import/adoption, not a rewrite of source operations. Preserve the source collection, its operations/outbox, and a recovery archive or equivalent retained storage. The default selection adopts all currently visible source history; explicitly unselected records remain available in the retained source, with their unsynchronized status clear.

Persist a resumable adoption plan containing source/target identities, selected scope, source revision, hydration progress, and pending cutover. This plan is not an operation and is not publishable. Keep source commands usable while network hydration proceeds; catch up source completions/edits/deletions since the original snapshot.

For each selected record at cutover:

- if target has no operation/tombstone for that ID, create a fresh target-dataset UPSERT preserving the entity ID/value;
- if target already has a live value, retain target by default (identical value is a no-op);
- if target tombstones the ID, do not import it under that ID;
- intentional overwrite is a separately reviewed edit after hydration; intentional copy/restore uses a fresh entity ID.

Source tombstones are not transplanted as deletes into an unrelated dataset. Re-importing old source history never cancels target deletion.

Before cutover, require active stopwatch idle, catch up source revisions, and recheck target winners/tombstones. Atomically verify the expected source revision, target revision/binding, and current selection; generate the actual target operations/C/outbox/projection transitions; record adoption completion; and switch the selected local binding. Do not stage provisional immutable operations for source records that may later be deleted. No adoption operations may publish before coherent cutover.

A competing source command either commits before this check and is caught up, or fails a stale selected-collection/generation check afterward. A target change causes plan refresh/revalidation. No network wait is inside the final transaction. Crashes resume/cancel the durable plan without stranded changes or duplicate operations. The source remains retained and explicitly accessible after cutover.

## 21. Writer identity, reinstall, and independent restore

Generate a fresh writer deviceId for a fresh installation, storage reset, reinstall without its original installation state, or deliberate independently running database restore/clone. Labels/platform/account identity do not participate in correctness. Browser tabs sharing one installation share its writer identity and transactional counter.

Rotation affects newly authored operations only. Historical operations retain their original opId, deviceId, counters, datasetId, and payload. Pending/sealed recovered publications retry their original identity/bytes. Unsealed recovered operations may be sealed in a new segment homogeneous for their original writer; this is publishing already-authored history, not creating new commands under that writer. Never rewrite old deviceId or put old-writer ops in a new-writer segment.

A restored installation MUST recover high-water from retained/accepted history, validate remote binding deliberately, and reconcile before claiming Synced. If it begins offline, its new operations cannot claim precedence over unseen remote versions. They remain valid and are not rewritten on reconnect. A deliberate edit after hydration receives an advanced counter.

Preserve entity IDs when restoring the same dataset. Arbitrary filesystem copying outside supported restore workflows may be undetectable; random op/segment IDs and collision checks remain necessary even when writer rotation is expected.

## 22. Minimum transport contract

The transport is replaceable, byte-oriented storage. Its implementation/API names are advisory; these semantics are mandatory:

| Capability | Required result/guarantee |
|---|---|
| Discover | Candidate locators plus complete/incomplete/ambiguous/error status; no implicit singleton election. |
| Create | Durable retryable creation of a representation for an explicit immutable descriptor. No cross-file atomicity assumed. |
| Bind/read descriptor | Validate a stable locator against expected dataset identity/version and account context. |
| Enumerate | Opaque continuation and explicit pass completion; duplicate/out-of-order/delayed discovery tolerated. |
| Read | Complete bounded artifact bytes, identity/locator information, and distinguishable failure. |
| Publish | Stable segment ID and sealed bytes; outcome confirmed, verified same-content already present, unknown, or integrity conflict. |
| Errors | Authorization-required, permission/access failure, missing/inaccessible dataset, retryable service/network/quota failure, invalid artifact, unsupported data, integrity conflict. |
| Optional changes | Opaque discovery optimization; never operation order or the only required recovery path. |

At-least-once physical publication/delivery is sufficient. The core MUST NOT assume unique names, linearizable enumeration, ordered delivery, multi-file transactions, or network/local atomicity. Immutable published valid data must remain eventually discoverable/readable for eventual convergence.

Classify errors only as precisely as the provider supports. A not-found object may be inaccessible, not deleted. Missing/access ambiguity preserves local data and never authorizes automatic recreation or domain deletion.

The generic protocol MUST NOT contain Drive IDs/paths, OAuth state, API listing/change semantics, quota constants, or provider cursors. Adapter locators/cursors and publication handles are local to the bound transport.

There is no mandatory listDevices operation, device-registration file, mutable manifest, journal head, or remote “last segment” authority.

## 23. Initial Google Drive representation and I/O

Google Drive is the first planned transport, subject to the authorization gate in §24. Prefer a visible app-managed dataset-specific root:

    Focus Timer - <datasetId>/
        dataset.json
        segments/
            <segmentId>.json
            ...

Logical writer journals are the immutable operation/segment sets grouped by deviceId, not physical device folders. Contents define identity. Drive names are nonunique labels; keep stable root/descriptor/segments-folder file IDs in the local binding. Do not reconstruct a binding by repeatedly choosing matching names.

Bootstrap MUST persist its creation intent and generated retry IDs. Complete the required root/segments placement and immutable descriptor before treating the candidate as bindable. Do not publish an empty descriptor or segment and patch it later. Half-built trees are incomplete candidates, not empty initialized datasets.

For small bounded JSON, use a complete multipart create carrying metadata and content. If resumable upload is used, its finalization/status recovery is adapter-local. Do not assume readers can never encounter incomplete/unreadable content; §17 still validates before acceptance.

Use Drive-generated file IDs as durable create retry handles, acquired and persisted before the create. A successful create with lost response retries the same generated ID/content. A 409 response requires reading/verifying expected identity and bytes before confirming; it alone is not acknowledgement. A protocol UUID is not a Drive-generated file ID.

Initial synchronization MUST implement full paginated reconciliation with appropriate space, bound parent locator, trashed=false, and field selection. Consume every nextPageToken, including after short/empty pages. IncompleteSearch does not complete a pass. Restart rejected file-list continuations and retry pending downloads. Files can change visibility during paging; reconcile later rather than promising a snapshot. The known-file cache obeys §18: provider content indicators must be proven to detect changed bytes before they justify skipping a reread; filename/segment ID alone never does.

An optional Drive changes-feed implementation follows §18's token-before-scan rule. It discovers storage-object state, not a domain-operation log. Honor documented token behavior rather than a hardcoded assumed expiry. A change/removal notification never emits FocusSession DELETE.

Bound concurrency and retry retryable service/quota responses with exponential backoff and jitter. Treat numerical quota/method costs as current provider configuration, not protocol constants. File-count/replay cost must be measured; batching and local caches precede more elaborate optimizations.

Provider guidance: [files resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files), [create files](https://developers.google.com/workspace/drive/api/guides/create-file), [uploads](https://developers.google.com/workspace/drive/api/guides/manage-uploads), [files.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list), [changes.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/changes/list), [usage limits](https://developers.google.com/workspace/drive/api/guides/limits). Provider documentation cannot override protocol invariants; unsupported guarantees must not be invented.

## 24. Authorization, narrow-scope proof, and user control

Google authorization grants optional storage access; it is not Focus Timer identity. The app MUST remain fully local when disconnected, expired, revoked, or offline.

Prefer visible app-managed files with drive.file **only after** proving the selected scope works across planned official web/native OAuth registrations. Official platforms use separate suitable client IDs in one Google Cloud project; that arrangement and possession of a folder ID do not prove access to all existing descendants or all other clients' files.

The proof gate MUST demonstrate:

- web creates a dataset/segment and every planned native registration can discover/read it;
- each native registration publishes its own segment, and web/other clients discover/read it;
- a new/reconnected installation joins the intended existing dataset using validated identity;
- all actions work under the selected narrow scope without arbitrary unrelated-Drive access.

Do not broaden scope merely to make discovery work. If proof fails, stop the transport decision and explicitly reevaluate storage/authorization/product requirements. Hidden appDataFolder/drive.appdata is a possible separately approved alternative, with documented hidden/non-shareable storage and archive-based manual recovery; it is not a silent fallback. Independent third-party OAuth projects need a separately supported explicit file-authorization or archive-transfer path.

Backend-free browser authorization uses the supported GIS token model with transient access tokens, without assuming browser refresh tokens or permanent unattended renewal. After expiry, token renewal requires a user-driven request. Expose Authorization required / Reconnect Google Drive; retain local history and outbox. Closed PWAs are not expected to synchronize continuously.

Native clients use platform-appropriate public-client authorization independently, including desktop PKCE and system browser, and suitable secure token storage. No distributed client secret can be expected to remain confidential. Do not copy native token-refresh assumptions into the browser flow.

Tokens/credentials MUST NOT enter operations, segments, history exports, dataset archives, logs, URLs used as domain IDs, or service-worker caches. Disconnecting stops new authenticated work and clears transient credentials as appropriate, but does not discard local history/outbox or silently delete remote data.

Provider guidance: [Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [app data](https://developers.google.com/workspace/drive/api/guides/appdata), [cross-client identity](https://developers.google.com/identity/protocols/oauth2/cross-client-identity), [GIS token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model), [native OAuth](https://developers.google.com/identity/protocols/oauth2/native-app).

## 25. Sync runner, scheduling, and truthful status

Attempt synchronization on suitable opportunities: startup/foreground, completed/edit/delete commands, reconnect, manual Sync, and occasional live periodic opportunity. Correctness MUST NOT depend on a polling frequency, shutdown event, closed-PWA execution, or unattended browser renewal.

Coordinate one runner per binding where practical, but membership reservation, high-water, receive processing, and acknowledgement MUST remain safe with competing workers and crashes. Each step verifies pinned account/locator/dataset/binding generation. No network call blocks a timer/history command.

A typical pass verifies binding, enumerates/downloads/applies pending remote artifacts, seals/publishes/acknowledges eligible local work, and completes discovery checks. Pulling first helps newly authored edits observe known remote state; do not renumber operations already created offline. Repeated healthy passes with no changes are idempotent.

| State | Meaning |
|---|---|
| Local only | No remote binding is enabled; local operations/history remain durable. |
| Changes saved locally / Pending | Committed local work is not yet acknowledged remotely, including unsealed work. |
| Syncing | A pass is in progress; local operation remains available. |
| Offline / Retry pending | Network/service failure delays work retained locally. |
| Authorization required | User-driven reconnect is needed; outbox is retained. |
| Unsupported data / Upgrade required | Dataset contains unsupported semantics; synchronization is paused. |
| Recovery required | Missing/inaccessible root, immutable integrity fault, counter exhaustion, or damaged data prevents safe automatic sync. |
| Local save failed | The current command is not durably committed; it must not be described as saved locally. |
| Synced | The conditions below all hold for the last completed pass. |

Synced MUST require a completed reconciliation/change pass, all references discovered by that pass durably applied and integrity-verified under §18 with no unresolved pending/quarantined/unsupported artifact, no unacknowledged local outbox/publication work, and no unresolved integrity/binding error. Recheck local mutation/publication state before displaying it; a new mutation immediately makes status pending.

Synced means “last pass completed with no known pending work.” It does not mean another device is online or has received anything, nor that a concurrent not-yet-discovered artifact cannot exist. Show last successful check time when useful.

Diagnostics MAY include protocol/dataset/writer IDs, last successful pass, pending counts, discovery progress, and artifact error references. Never expose tokens or private descriptions by default.

## 26. Failure handling and deliberate recovery

The following outcomes are mandatory. Automatic retry assumes valid retained data, supported semantics, storage, and appropriate authorization.

| Failure | Required result / handling |
|---|---|
| Crash before/during local mutation | Transaction leaves old state or complete new state; receipt/active identity prevents duplicate Finish. |
| Crash between entity/outbox/clock writes | No separately committed partial command; transaction aborts or commits all effects. |
| Local storage/quota failure | No success/active clear; preserve prior durable state, expose unsaved work/error, offer export/retry. Do not delete journals to make room silently. |
| Crash during sealing | Durable sealed intent or still-pending unreserved operations; never half-recorded membership. |
| Upload succeeds, response lost | Unknown outcome, same sealed retry, no early acknowledgement. |
| Duplicate physical publication | Verify immutable content, deduplicate operations; no extra history record. |
| Network loss midway | Keep committed progress/pending refs/intents; retry remaining work. |
| Crash during receive | Effects/C/dedup remain atomic; incomplete segment is not applied; retry safely. |
| Incomplete/rejected listing | Retain pending references, restart/reconcile; do not declare Synced. |
| Token expires | Local work continues; preserve outbox, require user reconnect when necessary. |
| Permission revoked / account changed | Stop authenticated work for that binding; no cross-account redirection; explicit reconnect/rebind. |
| Rate limit/service outage | Bounded backoff/jitter; no discarded operations. |
| Bound root missing/inaccessible | Stop automatic publication; retain local history; deliberate validation/rebind/restore/new dataset. Never auto-recreate. |
| Known immutable artifact changed | Integrity fault; retain evidence and stop affected automatic publication/ingestion until deliberate repair. |
| Artifact absent/trashed | Never domain DELETE or removal of local accepted data. Known loss is recovery-required. |
| Malformed/truncated JSON | Retry transient incomplete read; quarantine diagnosed malformed artifact; no partial ingestion/healthy status. |
| Unsupported version/field/type | Preserve local/pending data and raw artifact/reference where practical; pause affected sync, no guessed meaning. |
| Conflicting immutable identity | Integrity fault, not arrival-order conflict resolution; no silent overwrite or acceptance of both as valid. |
| Year-offline device | Replay retained artifacts under same rules; terminal deletes still win; versions/auth must be supported. |
| Storage cleared / lost only local copy | Recover published/archived history by explicit join; unpublished only-copy data is irrecoverable. No false recovery promise. |
| Reinstall / independent restore | New authoring writer ID; preserve old operation identities, hydrate/reconcile, no counter reset of existing dataset history. |
| Owner loss with active timer | Restore last durable checkpoint paused; attach instead if another live owner remains. |
| Counter exhaustion | Block that dataset's new mutations; deliberate local recovery collection preserves stopwatch use (§13). |
| Failed database migration/adoption | Retain recoverable source; resume/cancel durable plan; no fake operations or stranded source changes. |

Remote removal is storage damage/removal, never a FocusSession deletion operation. A missing response alone cannot prove user intent. Deliberate recovery MUST name the source/target dataset and binding, preserve a validated source/archive, verify all known immutable identities, and explicitly resume or establish a new binding. Prefer copying a validated retained corpus to an explicitly selected recovery location over overwriting corrupt published content. Never automatically re-version records or bypass unsupported semantic checks to make an error disappear.

A new client may be unable to detect a historical segment that was already removed before discovery. A well-formed first-seen modification cannot be authenticated merely by UUID/filename. Checksums/original bytes detect known-content change; they do not prove authenticity or recover a missing only copy. These are disclosed recovery limits, not justification for a developer backend or mutable global manifest.

## 27. Reporting CSV and portable history JSON

Provide CSV reporting export of all live completed history regardless of search filter, with description, local start/finish, formatted effective focus, and decimal effective seconds. Quote/escape fields and protect formula-leading text as in the reference. UTF-8 BOM is permitted for reporting CSV only. CSV lacks stable identities/recovery metadata; CSV import is not required.

Portable history JSON is UTF-8 without BOM, using §10's JSON/scalar/integer validation and exactly these fields:

- format: literal "focus-timer-history";
- formatVersion: integer 1;
- sessions: array of the five-field FocusSession objects in §9.

Export excludes tombstoned entities and all runtime/sync/provider metadata. Sort exported sessions by the history order for reproducibility, but import meaning is independent of array order. An empty sessions array is valid. Reject unknown fields/versions, malformed records, and duplicate session IDs within an import, including identical duplicate entries.

History JSON is not a dataset archive. It MUST NOT include access/refresh tokens, Drive IDs, provider locators/cursors, writer credentials, database dumps, or active timer state.

Validate/stage a complete import plan before mutating target history; large imports may use durable resumable plans. Show the target and merge/copy choice:

- **Default merge:** preserve IDs; add only keys unknown in target; identical existing values are no-ops; keep target for differing overlaps; skip/report tombstoned IDs.
- **Deliberate replace:** user reviews overlap and current winner; perform an ordinary new edit with target counter/operation. It is not automatic re-import behavior.
- **Deliberate copy/restore:** allocate fresh entity IDs and target operations. Persist job-to-ID/outcome mapping so retrying the same import job does not duplicate copies; a separately requested new copy may.

Do not fabricate newer operations merely because a file was imported/exported again. Import never removes target records because they were absent from the file, transplants source tombstones from an unrelated history export, or revives a target tombstone. Each committed imported mutation obeys §15; crash/resume uses durable progress. No provider authorization is needed to import/export locally.

## 28. Complete dataset archive and journal recovery

Retain immutable accepted/authored operations and accepted/sealed segment bytes locally so a dataset can be archived and diagnosed independently of the provider. A transaction that cannot retain its required accepted data fails visibly; do not mark it applied first. Projection-only backup is insufficient.

A portable dataset archive is UTF-8 JSON without BOM, using §10's JSON/scalar/integer validation and exactly these fields:

- format: literal "focus-timer-dataset-archive";
- formatVersion: integer 1;
- coverage: literal "local-replica";
- dataset: the closed descriptor from §12.1;
- segments: array of strings, each string decoding to the exact original UTF-8 segment text, including whitespace/escape spelling;
- unsegmentedOperations: array of valid operations not yet represented in an included sealed segment.

The archive MUST cover every accepted/authored operation in that local replica, including losing UPSERTs, DELETEs, acknowledged work, and pending/sealed work. Each decoded segment independently obeys §10; encoding a segment as an archive JSON string must round-trip its exact bytes without normalization. All segment/operation dataset IDs match the archived descriptor; duplicate identities require ordinary same-content checks. Operations already covered by segments are not emitted again in unsegmentedOperations.

“Complete” means lossless for the retained local operation corpus, not proof that all other devices' unpublished or undiscovered operations are included. coverage is explicitly local-replica. Archive envelope size/streaming limits are separate from the per-segment 1 MiB limit; an importer MUST announce any resource refusal before destructive action. Parse/validate all required components in bounded staging before applying recovery.

The archive excludes provider locators/IDs/cursors, authentication, active stopwatch, and local preferences. The current installation writer identity is not copied as an authoring credential; historical deviceId fields remain part of immutable operations.

Restoring the same dataset replays original operations/segments, preserves tombstones and identities, and recovers C at least to the maximum accepted counter. It does not re-import visible sessions as newly versioned UPSERTs. New installation authoring uses a fresh deviceId (§21). Publication status is conservative after portable restore: reconcile/verify remote artifacts and retry original publications where needed; an archive never assumes a remote acknowledgement based on a provider ID.

Restoring unsegmented authored operations preserves them and may seal them under their original writer; it never edits their counters/writer. Copying a validated corpus to another transport preserves dataset/op/segment identity. A different dataset ID is a deliberate adoption/migration with new operations, not archive restoration.

## 29. Legacy import and local database migrations

The reference source is C# AppData version 1. A dedicated importer may read its sessions.json, but MUST NOT synchronize that whole file or use a native database format as a wire schema.

Map completed records: Id→id, Title→description, StartedUtc→startedAt, FinishedUtc→endedAt, DurationMs→focusDurationMs. Preserve normally generated UUIDv4 values; canonicalize supported GUID spelling without changing the UUID value. The legacy loader accepts broader forms/versions and compares ID strings; detect duplicate identities after canonicalization. Quarantine unsupported variants/versions, invalid Unicode/data, and canonical collisions for explicit recovery/mapping, never silent new IDs.

Parse supported legacy round-trip dates, convert their instant to UTC, and truncate fractional precision to milliseconds; preserve DurationMs. Do not infer dates from duration, invent audit dates, or reject reversed chronology alone. Preserve received description code points; no blanket authoring trim during migration.

Legacy active state, if imported, stays local and paused from saved accumulated focus under a new local active identity; it is not a completed session or sync operation. Theme/topmost and other preferences remain local. CSV is reporting, not a substitute identity-preserving legacy source.

Importing legacy visible history follows §27/adoption rules. Restoring an older native backup must not automatically emit “newer” edits/deletions because its projection differs from synchronized state.

Local database migrations have independent version numbers. They MUST be transactional or preserve a recoverable source and resumable progress, preserve committed IDs/operations/high-water, and create no history operations just for storage/serialization changes. New app/service-worker versions must coordinate old tabs and database compatibility without dropping active/history data.

## 30. v1 compatibility and future evolution

v1's persistent semantic schema is closed. No arbitrary future field may be ignored by an old writer that then replaces the record. No extension container or optional persistent metadata escape hatch is defined. Device display names may remain local without affecting correctness.

Unknown protocolVersion, schemaVersion, operation/entity type, or field safely pauses affected sync under §17/§26. Preserve local data, pending work, and raw unsupported artifacts where practical; never skip-and-advance/report Synced. An old client remains locally usable, but is not promised interoperability with semantics it cannot implement.

Future compatible clients in TypeScript, C#, C++, Kotlin, Swift, or another language join v1 by implementing this contract and passing the same vectors, without reverse-engineering a web client's storage or reducer. A future transport carries the same protocol without changing domain/order/delete semantics, subject to equivalent I/O and authorization.

New persistent semantic fields/types, tags/projects with references, encryption, changed deletion rules, or destructive snapshot semantics require an explicit version/compatibility/migration design. Breaking transitions may create a new protocol dataset and deliberate cutover, retaining the old archive. Do not silently run incompatible reducers in one unchanged dataset or maintain uncontrolled divergent dual-written versions.

Application-level encryption is not v1. Keeping transport payloads opaque permits a future serialization/encryption layer, but keys, authenticated envelopes, recovery, limits, and old-client migration must be specified then. Plaintext v1 clients cannot silently consume encrypted artifacts.

## 31. Retention, scale, snapshots, and convergence limits

Published v1 segments, accepted immutable operations, and terminal tombstones MUST be retained indefinitely by participating clients/transport storage. Outbox acknowledgement may change local queue status, not erase history. Users may deliberately remove their data; such removal invokes explicit recovery semantics, not automatic journal recreation.

No automatic age cutoff, destructive compaction, distributed GC, device acknowledgements, mandatory device registry, or mutable snapshot/journal head is permitted in v1. Offline for a year must work while the valid corpus remains available and protocol/auth are supported.

Future non-destructive snapshots may accelerate local reconstruction only if they preserve exact v1 results, leave journals/tombstones authoritative, and remain optional to old clients. They must not appear as unknown required segments in the v1 enumerated segment set. Do not implement them before measured need and an explicit format design.

Support thousands of sessions/many years through batching, paged discovery, cached known segments, local indexed projections, and incremental materialization. Measure cold replay/file count/API cost before changes-feed or snapshot optimization. Normal UI never reconstructs history from Drive on each render.

Eventual convergence assumes all relevant valid immutable operations are eventually accessible/delivered, retained, and reduced under the same supported rules. Missing only copies, corruption, unsupported clients, revoked authorization, or permanently withheld delivery prevent that premise; the status/recovery contract must say so.

## 32. Privacy and security

History belongs to the user. Do not transmit it to the developer or require behavioral telemetry. Use only explicitly authorized remote providers. Session descriptions may be private; redact them from routine diagnostics.

Treat remote/imported JSON as untrusted data: enforce bounds, validate exact types/identities, render descriptions as text, and never evaluate file content as code/HTML. A valid UUID or checksum is not author authentication. Cryptographic signatures and hostile collaborative consensus are outside this personal-data trust model.

Keep credentials local/transient as appropriate; use native secure storage where necessary. Exclude tokens/secrets/passwords from all portable history/archives/segments and logging. No client secret is a confidential credential in a distributed application.

Disconnecting leaves local use and exports available. No developer infrastructure is required to interpret or restore documented user data. Request persistent browser storage where available; it improves eviction resistance but is not a backup or protection against deliberate clearing.

## 33. PWA, accessibility, notifications, and performance

The web client SHOULD be installable where supported. After initial successful loading/caching, timer, local history commands, basic totals, and exports MUST work offline. Cache the application shell/resources appropriately; do not cache OAuth-sensitive responses or make offline use depend on Google. Deployment may serve static assets; no Focus Timer data backend is required.

Support desktop/tablet/phone layouts, useful compact timer/history views, readable light/dark themes, semantic labels, keyboard operation, visible focus, reasonable WCAG-compatible contrast, and state cues beyond color. Native topmost is a desktop capability, not a protocol/web requirement.

Adapt reference shortcuts where the platform permits: Space starts/pauses/resumes outside text inputs; finish/reset/history/timer/theme controls have accessible equivalents. Avoid hijacking text entry or relying on browser/system-reserved shortcuts. Native Ctrl+R behavior need not override browser reload. In-app save/error/recovery notices are required; system notifications/sounds are optional platform features with contextual permission, never synchronized.

All normal timer/history interactions use local state and feel immediate; network work is asynchronous. Durability errors remain visible even when this prevents reporting success. Use bounded work and local projections so background sync does not stall interaction.

## 34. Protocol conformance release gate

Before Google Drive is part of the implementation, publish a normative protocol reference, schemas, and language-neutral positive/negative test vectors consistent with §§9-18. The later files may live in protocol/v1/protocol.md, schemas/, and test-vectors/; their directory layout is advisory, their coverage is mandatory.

Vectors MUST include:

- arbitrary delivery permutations, repeated passes, duplicate operations across artifacts, duplicate physical artifacts, and out-of-order/delayed segments;
- full snapshot replacement versus missing-field rejection;
- terminal DELETE, DELETE-before-UPSERT, greater-clock stale edit after DELETE, and late stale DELETE defeating newer edits;
- losing-operation and already-deleted-entity high-water incorporation;
- Lamport numeric order/ties, counter 1/max/exhaustion, restart/rotation without rewind;
- canonical UUID version/variant/text and unsigned network-byte ordering, including platform mixed-endian pitfalls;
- strict UTC calendar/leap-date/millisecond boundaries and reversed wall-clock chronology with positive focus;
- integer lexical restrictions/precision/overflow, null/missing/wrong types, duplicate names after escape decoding;
- valid/invalid Unicode, scalar-count boundaries, exact preservation of different normalization sequences;
- closed unsupported fields/protocol/schema/operation/entity types;
- dataset/writer/version/payload identity mismatches, same-ID conflicting content, duplicate opId within one segment;
- byte/count/depth limits and exact sealed bytes versus semantic operation equality;
- thousands of sessions and year-offline replay with retained tombstones.

For valid common operation sets, every compliant language produces the same materialized values and tombstones; invalid/unsupported inputs produce the prescribed classification, never parser-dependent healthy state. Test the algebraic properties without relying on global replay order. No client implementation is privileged authority.

## 35. Crash, concurrency, and adversarial-transport gate

Use an adversarial in-memory transport supporting duplication, reordering, delayed visibility, partial/paginated enumeration, retryable failures, and successful publication followed by response loss. Prove core behavior before provider integration.

Inject crash/failure before and after domain transaction, outbox writes, seal, publication, acknowledgement, inbound acceptance, processing marker, and discovery checkpoint. Intermediate writes inside one transaction must roll back together. On restart every committed fact survives and every unknown outcome retries safely.

Also verify:

- competing tabs/workers, duplicate Finish, stale active revision/owner, delayed heartbeat, live-owner attach, fenced recovery, and returning obsolete owner;
- edits arriving during publication, exact acknowledgement membership, and competing seals;
- stale history editor versus remote winner/delete;
- source commands/target changes during hydration/adoption, idle cutover, crash/resume, and no provisional publications;
- account/dataset switch while an old request is in flight, without misrouting or false acknowledgement;
- clone/restore with old pending/sealed writer operations and new writer authoring;
- malformed/unsupported/conflicting segment with no partial healthy ingestion;
- storage quota/write failure, migration failure, counter exhaustion, history re-import/job retry, and archives preserving tombstones/losers;
- active timing under timer throttling, checkpoint latency, wall-clock correction, close/reload/crash, sleep/resume, and the disclosed platform fallback.

Existing reference tests establish reference behavior only. They do not replace these new conformance/failure tests.

## 36. Drive and platform integration proof gates

Passing core tests is necessary but does not prove provider/platform assumptions. Before enabling Drive:

- satisfy the exact narrow-scope official-client matrix in §24;
- test simultaneous first creation and ambiguous discovery without first-result election;
- prove generated-ID create retry after lost success and 409 identity/content verification;
- test interrupted/empty-page pagination, incompleteSearch, append during scan, delayed reads, and restart with pending downloads;
- test expiration/revocation, wrong account, missing/inaccessible root, duplicate names/copies, and known immutable content mutation despite cached segment identity;
- prove no sensitive auth response is cached/logged/exported and closed-PWA inactivity does not falsely report progress.

For each supported runtime, prove the local lifetime/fencing mechanism and actual background/suspend clock behavior. Desired semantics are specified; their availability is not guaranteed by this document. If a target cannot meet them, implement the defined conservative fallback and disclose it, or explicitly revise target support. Do not weaken protocol invariants to compensate for provider/platform limitations.

## 37. Later implementation phases and acceptance

This specification-only task ends with this document. In a separately authorized implementation task:

1. **Behavior baseline:** read the supplied C# reference and this specification; produce/update docs/existing-app-behavior.md from observed behavior with PRESERVE / ADAPT FOR WEB / REMOVE classifications. Do not repeat unsupported C++/editing claims or port native plumbing.
2. **Protocol artifacts:** derive the normative reference/schemas/vectors from this contract, identify contradictions explicitly, and resolve them before code defines behavior.
3. **Portable core proof:** implement validator/reducer and transactional simulation with the adversarial in-memory transport; pass §§34-35.
4. **Local-first web client:** implement timer/history/edit/delete/totals/export, IndexedDB durability/recovery, tab ownership, responsive accessible PWA/offline behavior, and platform timing tests. Everything works without Google.
5. **Authorization proof and Drive adapter:** satisfy §§24 and 36, then integrate optional Drive without changing domain/ordering/delete semantics.
6. **Hardening:** multi-device/offline/year replay, permissions/quota failures, malformed data, recovery/archive/import, migration/update coexistence, privacy/security, accessibility, and measured performance.

Release acceptance requires:

- positive-duration stopwatch sessions with pause exclusion, idempotent commands, durable single completion, correct reset, paused owner-loss recovery, and no duplicate local owners;
- history/edit/delete and basic totals entirely local, stable IDs, independent focus duration, and truthful save errors;
- identical live entities/tombstones from a common valid operation set across implementations, including late DELETE and duplicate/reordered delivery;
- immutable retry-safe publication, exact outbox acknowledgement, crash-safe reception/discovery, explicit binding/adoption, and no domain deletion inferred from storage absence;
- unsupported/integrity/auth/recovery states preserving local/pending work without a false Synced label;
- documented exports and lossless local-corpus archive/recovery without provider credentials;
- independently verifiable future clients/transports for supported v1 semantics, no developer data backend, mandatory account, or active timer synchronization.

## 38. Frozen decisions and remaining proof obligations

All CRITICAL/HIGH review proposals are adopted. Simplifying MEDIUM/LOW proposals are also integrated: minimal domain without mandatory audit dates, shallow remote layout, ordinary UUIDv4 generation with v4/v7 acceptance, advisory packaging, and postponed speculative machinery.

The v1 product defaults are resolved here: terminal deletion, complete snapshot editing, exact authoring/wire text rules, viewer-timezone finish-date totals, paused recovery after owner loss, idle dataset-switch cutover, and target-preserving/tombstone-aware adoption/import. No further product choice is required to implement the deterministic core.

The visible Drive/drive.file choice is conditional on actual cross-registration authorization proof. Failure leaves that transport/product decision open for explicit reevaluation; neither broader scope nor hidden storage is preapproved as a silent workaround.

Unproven integration assumptions are: cross-client narrow-scope file access/discovery, provider retry/pagination/error behavior under failure, local execution-lifetime fencing support, real sleep/clock continuity on each target, and browser persistence/service-worker behavior. These require tests/prototypes in a later authorized task, not a promise in prose. The recovery boundaries for missing remote history and destroyed unpublished only-copy data are intentional and cannot be specified away.
