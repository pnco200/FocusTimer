# Production remote persistence: preimplementation mapping

Authority: SPEC §§15–19,25–29 and the corrected deterministic repository (F1/F2/F4 included). This mapping was recorded before production implementation. The wire protocol is unchanged.

Schema 3 retains every schema-2 record and adds four native stores: `remote` keyed by dataset, `publications` and `segments` keyed by dataset/segment, and `artifacts` keyed by dataset/opaque physical reference. The latter three have dataset indexes. No migration creates a remote binding, publication, acknowledgement or coverage claim.

`remote` contains account/provider/root locator, immutable descriptor identity, last target, monotonically fenced generation, blocked state and discovery pass/checkpoint scalars. Reconnect keeps obligations, rejects uncovered retargets and fences prior callbacks. `publications` contains reservation state, original writer, exact operation values/IDs, allocated segment ID, immutable final bytes, attempts and unioned confirmed references. `outbox.reservation` supplies exclusive membership. `segments` retains accepted bytes/membership; `artifacts` retains pending/applied/quarantined state, original bytes, bounded rejection evidence and pass verification.

Each transition uses one native read/write transaction overlapping local authoring. Reservation writes intent and exact membership together. Seal checks accepted identity before persisting final bytes. Attempt/unknown never allocate another identity. Confirm writes coverage before exact acknowledgement removes membership; reference-free confirmation retains a logical coverage obligation. Discovery commits pending references with its cursor, never infers completion from page length or deletion from absence.

Receive first validates the entire bounded byte value, then transactionally rechecks binding, physical/segment/operation identities. It commits operations, affected winner/tombstone projections, high-water, accepted segment and applied artifact together. IndexedDB reads/writes alone are awaited while transactions are live. No network belongs in these transactions.

The asynchronous repository boundary mirrors deterministic transition names. Pure reservation/serialization/confirmation/coverage/status decisions will be shared with the deterministic model. No production transport/runner scheduling, provider, OAuth or synchronization UI is added. Native browser tests must establish transactional guarantees; abstract confirmation evidence remains a future transport obligation.

## Detailed state mapping

The schema-2 production journal already owns local immutable operations, cached winner/tombstone projections, C, pending membership and Finish receipts. Active timer execution/ownership/checkpoints remain device-local. `MemoryStore` is an independent serial model, never a browser storage adapter. Production reads, checks and writes individual native records inside overlapping IndexedDB transactions, and returns results after native transaction completion.

| Deterministic state | Production authority |
| --- | --- |
| `binding`, `lastBinding`, `bindingGeneration` | `remote` row for the dataset. Provider/account/root locator are opaque local metadata; descriptor remains in `collections`. Disconnect retains the last destination. |
| `outbox[opId].reservation` | Existing `[datasetId, opId]` row; reservation becomes `null | segmentId`. Local authoring always creates pending membership with its operation. |
| `publications[segmentId]` | `[datasetId, segmentId]` row captures original writer, complete original operations, ordered operation IDs, pin, bytes, state, attempt count and unioned references. Acknowledged rows remain retained. |
| `segments[segmentId]` | Accepted immutable bytes and membership under `[datasetId, segmentId]`; reservation alone does not establish accepted content. |
| Discovery scalars | Current `remote` discovery pass ID, checkpoint, completion/reconciliation/in-progress/error and last-success fields. A same-target reconnect retains obligations but requires fresh reconciliation under a fresh binding generation. |
| Discovery `seen` | Current-pass seen marker per artifact (or equivalent retained current-pass reference membership). An omitted known reference still requires availability/content checking. |
| Discovery artifacts | `[datasetId, reference]` row with opaque reference, original bytes, segment ID, pending/applied/quarantined state, verified-pass marker and bounded rejected evidence. No JavaScript object-key interpretation of provider references is required. |
| Operation/segment receive dedup | Existing `operations` key and new `segments` key. Duplicate semantic operations preserve original values; same-ID different values or segment bytes cause integrity failure. |
| `entities` / `tombstones` / `highWater` | Existing `history` terminal winner projection, immutable operation journal and `collections.highWater`. Losing operations and DELETEs remain retained. |
| `blocked` / quarantine evidence | Persisted remote/artifact error plus bounded original/conflicting bytes or diagnostic references; existing `evidence` store remains local-only. |

Artifact keys need no generation/provider component because unsupported retarget is rejected while any corpus or artifact remains. Same-target reconnect preserves the identity and obligations. Every callback must check its exact provider/account/locator/dataset/generation pin inside the write transaction, including after a network wait.

## Transaction boundaries

Reservation reads eligible null-reservation rows and corresponding immutable operations, in canonical op-ID order. The first eligible original writer determines the segment envelope; other writers wait for another segment. Exact encoded size is calculated with the once-allocated segment ID, respecting the v1 1,000-operation and 1 MiB limits. Publication intent and every reserved row commit together. Broad overlapping native scopes serialize competing workers independently of Web Locks or JavaScript queues.

Sealing reconstructs the exact captured envelope and validates its complete bytes. The transaction rechecks every reservation and accepted segment bytes before storing sealed bytes/state. This is the F4 boundary: reservation → crash → conflicting accepted receive must refuse seal before any network publication. Unknown attempts retry the retained ID, bytes, writer and membership unchanged. A persisted in-flight state after process loss is unresolved/retryable, never evidence of confirmation.

Confirmation accepts only affirmative verified success or identical already-present content, exact sealed bytes/ID, valid references and no accepted/reference conflict. F2 requires retaining known physical obligations before acknowledgement. References are unioned. A reference-free acknowledgement can remove exact local membership but retains an unresolved logical segment-coverage obligation until receive verifies a physical reference for its exact bytes. Later enumeration omissions never erase known obligations.

Acknowledgement requires confirmed state and rechecks original operation values plus exact reservation membership. It deletes only that fixed membership and marks the publication acknowledged together. A second acknowledgement is idempotent; local Finish/edit/delete during upload or between confirm/ack remains pending.

Discovery records all pending references before cursor advancement in the same transaction. Pass ID/generation checks prevent stale progress. Empty pages with continuation remain incomplete. Cursor restart retains pending/known artifacts, and remote absence never creates a domain DELETE. A pass completes only after known omitted references have been checked as well as listed references.

Receive copies, bounds and validates the whole segment before effects. Inside the native write transaction it rechecks binding, physical original bytes, accepted/sealed segment bytes and every operation identity against newly committed competitors. Then it commits unknown operations, affected winners/tombstones, upward-only C, segment identity/membership and artifact applied/verified marker together. Received operations gain no local outbox row. A malformed tail, immutable conflict or request/transaction abort accepts no valid prefix.

Only IndexedDB request promises are awaited while native transactions are live. Parsing/pure calculations are synchronous; network/provider/timer waits remain outside. Strict durability is requested, without claiming protection from browser/OS permanent storage loss. Failure/quarantine records preserve accepted facts and block automatic ingestion/publication while healthy local commands can accumulate pending work.

## Shared decisions and runner API

`src/sync/remote.js` shares reservation construction, exact sealing bytes, confirmation validation, pin/destination equality, binding-target validation, coverage obligations and status derivation with the deterministic repository. Helpers contain no storage or provider effects. Native transaction checks remain adapter responsibilities. The simulation keeps its serial store, original failpoints and public error behavior; it is still useful as an independent trace oracle.

The asynchronous repository API needs `captureBinding`, `assertPin`, `bind`, `disconnect`, `reserve`, `seal`, `publications`, `beginAttempt`, `unknown`, `confirm`, `acknowledge`, `verifyDescriptor`, `beginPass`, `restartEnumeration`, `recordPage`, `pendingReferences`, `omittedReferences`, `receive`, `artifactFailure`, `runFailure`, `completePass` and `status`. A diagnostic consistent snapshot is useful for trace comparisons; it must exclude active runtime/provider credentials. Production runner orchestration remains a separate optional boundary, with byte-oriented abstract confirmation data supplying no unproven provider guarantee.

Status derives from retained facts and checks all known obligations. Exhausted C and blocked integrity/recovery prevent healthy status. Disconnected data is local-only. Incomplete discovery, work pending, in-progress processing, unresolved publication outcomes and retry/authorization failures remain diagnosable. `Synced` requires completed reconciliation, every known artifact applied and verified in that pass, no pending/quarantined artifact, no outbox/unacknowledged publication, no uncovered acknowledged publication and no binding/integrity error. A newly committed outbox row immediately makes healthy status false. No synchronization UI is added; eventual copy follows `ui-ux-guidelines.md`.

## Migration and proof boundary

Schema upgrade adds stores/indexes only. It preserves schema-2 journal/outbox/history, all IDs/writers/counters, receipts and active state. No reservation, sealed bytes, acknowledgement, accepted segment or remote coverage is fabricated. Missing remote state means unbound local-only with existing outbox genuinely pending. Native upgrade is atomic; subsequent initialization is retryable/idempotent.

Initialization must replace the schema-2 assumption that every journal operation has a null-reservation outbox row: received and acknowledged operations legitimately lack rows; reserved rows must match exact retained intent membership. Validate present membership and retained publications without inferring remote success from absence. Journal/projection repair continues preserving ambiguous damaged source evidence.

Native browser verification must compose reserve races, reservation/seal reloads, concurrent authoring, unknown/exact retry, competing acknowledgements, stale generations, F4 collision ordering, F2 missing own uploads, interrupted pagination, receive aborts, invalid tails and duplicate/conflicting physical/operation/segment identities. Representative persisted outcomes must match the deterministic model, including rollback. These establish native transaction atomicity, cross-connection serialization and reopen behavior only on exercised browsers. Provider confirmation/content indicators, eventual visibility, OAuth account/scope proof and permanent browser/OS storage retention remain later proof gates. No SPEC contradiction was found in this audit.
