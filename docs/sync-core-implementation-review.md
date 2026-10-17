# Focus Timer Sync Core — adversarial implementation review

Follow-up: the subsequently authorized [F1–F6 corrections](sync-core-corrections.md) document implementation changes and regression results. This review is retained as evidence of the original reviewed snapshot; its findings and source line numbers below refer to that snapshot.

Reviewed 2026-10-17. Tracked repository baseline: 5f98064affd879d167e5c3371d5da815b51132b9. The implementation, protocol artifacts, and tests were already present as untracked working-tree files; this review concerns that working-tree snapshot, not an assertion that HEAD contains them.

Authority: SPEC.md, Draft v3 — architecture-reviewed. Scope: protocol artifacts, src/protocol/, src/simulation/, current tests/support, the C# behavioral reference, and docs/implementation-report.md. Source references below are repository-relative, with verified one-based line numbers.

No implementation, tests, SPEC, or existing review/report documents were edited. Review probes ran inline against disposable in-memory objects; no new test files or synchronization features were created.

## 1. Confidence assessment

**Rating: NEEDS CORRECTION.**

The strict wire implementation and set reducer are substantially sound. The test suite provides useful independent evidence, particularly literal rejection vectors and a separate BigInt-based reducer oracle. I found no counterexample to the valid-operation-set reducer or accepted bounded-segment wire semantics.

The surrounding state machine has confirmed gaps:

- **Two HIGH findings:** another remote target can be labelled Synced without the retained corpus; an acknowledged upload disappearing before its first listing is never checked.
- **Two MEDIUM findings:** edits rewrite unchanged received descriptions; recovery between reservation and sealing permits conflicting durable bytes under one segment identity.
- **Two LOW findings:** standalone parser APIs have no input byte policy, and neutral lifecycle-vector steps do not exercise the lifecycle their names suggest.

Correct F1-F4 and add the specific missing regressions before treating Phase 1/2 as complete or building the client around these interfaces. F5-F6 are bounded follow-up/API-evidence issues, not proof that normal bounded segment ingestion or Lamport arithmetic is broken. No BLOCKER-level defect was established; this is not an UNSAFE TO CONTINUE assessment of the entire protocol.

### Evidence gathered

- The current JavaScript suite was run with Node.js v24.3.0 and completed successfully: the reported 490 passing checks remain consistent with the current suite. Passing it did not prevent the counterexamples below.
- The retained .artifacts/reference-baseline/results.txt reports 31/31 C# checks passed. Reference source remained unchanged; the C# executable was not rebuilt/rerun during this review. Those checks do not establish synchronization behavior.
- Independent read-only probes reproduced all four behavioral findings below. A separate probe demonstrated the standalone parser policy gap.
- The parser/reducer reviewer also compared 10,000 independently parsed valid JSON samples and 50,000 lexical samples without finding an acceptance/value mismatch within the strict tested grammar. This is additional finite evidence, not an exhaustive parser proof.
- SHA-256 fingerprints confirmed that all 45 pre-existing files remained unchanged. This review document is the only added file.

## 2. Findings

### F1 — HIGH: changing remote target discards destination coverage but still reports Synced

**Exact implementation:** src/simulation/repository.js, TransactionalRepository.bind(), lines 183-214, especially the unacknowledged-publication-only guard at 190-195 and fresh discovery state at 196-207; completePass(), lines 682-692. src/simulation/runner.js, run(), lines 83-94, publishes only pending publications/outbox work.

**SPEC:** §19, lines 376-378: duplicate locators require reconciliation; another account receives the same dataset only through deliberate full immutable corpus copy/rebinding. §25, lines 503-505: Synced must be truthful about known work and binding integrity. Deferring the full corpus-copy workflow is legitimate; accepting its unsafe shortcut is not.

**Concrete execution:**

1. A local replica completes X and publishes it to account/root A.
2. Publication is acknowledged and X's outbox entry is removed.
3. Create descriptor-only root B under another account, using the same datasetId.
4. Call bind() for B. It succeeds because no publication is unacknowledged.
5. Run synchronization. Existing acknowledged publications still belong to A, no outbox work is eligible for B, and B remains empty.
6. The original replica reports Synced with X locally. A new replica joining B also reports Synced, but has no X.

**Observed probe:** original status=Synced; original live entities=1; B physical artifacts=0; new B replica status=Synced; new B replica live entities=0.

This is a confirmed false destination-coverage claim and a recoverability/divergence risk. The probe does not destroy the original local record. Losing that local copy later would expose the incomplete remote dataset.

**Why tests miss it:** test/simulation-review.test.js:114-149 and test/simulation.test.js:419-443 switch while an upload is outstanding and correctly reject the new destination. They do not switch after acknowledgement, or switch a receive-only retained corpus. Unsealed pending work also is not covered by the publication-only guard.

**Minimal correction:** until a deliberate complete-corpus transfer/reconciliation workflow exists, reject changes to an established remote destination that would leave retained source corpus uncovered, regardless of whether its operations are acknowledged, unsealed, or received. Do not treat acknowledgement at A as coverage at B. A later implemented transfer must verify/copy original immutable content and track destination-specific completion before reporting Synced.

### F2 — HIGH: an acknowledged upload disappearing before first enumeration escapes availability checks

**Exact implementation:** src/simulation/repository.js, acknowledge(), lines 508-524; omittedReferences(), lines 596-600; completePass(), lines 682-689. src/simulation/transport.js, publish(), lines 178-179, returns no physical reference. src/simulation/runner.js:76-81 checks only references registered through discovery/receive.

**SPEC:** §18, lines 351-355: a cache cannot bypass known-content availability/integrity verification; reconcile against known segment identities. §25: no unresolved known integrity/binding condition may be hidden behind Synced. §26's inability of a new client to detect already-missing historical data does not excuse this case: the original publisher knows its confirmed segmentId and exact bytes.

**Concrete execution:**

1. First pass enumerates an empty dataset.
2. It publishes and acknowledges S, then reports Synced.
3. Before S is returned by a later listing, remove/make its physical object unavailable.
4. Every later pass lists nothing. Neither discoveries.artifacts nor state.segments contains S, because acknowledgement never registered the upload as remotely known.
5. No omitted reference is checked; the acknowledged publication is excluded from pending work. Synced continues indefinitely.

**Observed probe:** first status=Synced; next three statuses=[Synced, Synced, Synced]; discovery artifacts=0; received known segments=0; own publication state=acknowledged; outbox=0.

Remote absence correctly does not create a domain DELETE. The defect is failure to detect known-corpus loss and an incorrect healthy status, not accidental deletion of the local entity.

**Why tests miss it:** test/simulation-final-review.test.js:175-176 explicitly runs a second pass before corrupting an own upload, with the comment “Retain physical-reference bytes.” test/simulation.test.js:596-612 begins with an already downloaded known object. Both bypass the gap between acknowledgement and first discovery.

**Minimal correction:** retain verified remote publication locator/handle information in the durable confirmation/acknowledgement path and include it in reconciliation. Alternatively, retain an unresolved known logical-segment coverage obligation until independent discovery/verification can establish the physical reference. A temporarily delayed listing may remain retryable; it must not erase the coverage obligation. No mutable global manifest is needed.

### F3 — MEDIUM: editing another field, or saving no change, rewrites received descriptions

**Exact implementation:** src/simulation/repository.js, authoredPayload(), lines 108-111, and edit(), lines 390-399. src/protocol/validation.js, authorDescription(), lines 82-85, is correct when used for the intended authoring transition.

**SPEC:** §8, line 121: fields are independently editable and an unchanged edit creates no operation. §9, line 147: trimming applies on Finish or a description edit; received/imported values are preserved exactly. §15: domain no-ops create no synchronization mutation.

**Concrete execution:**

1. Receive a valid UPSERT with description "  preserve exact  " or the empty string.
2. Open that completed record and submit the exact same snapshot, using the current baseOpId.
3. edit() calls authoredPayload() before comparing against the winner.
4. The whitespace description becomes "preserve exact"; empty becomes "Untitled session.".
5. A new operation is created, C advances, and the outbox becomes nonempty even though the user changed nothing.

A duration-only edit has the same unintended description rewrite.

**Observed probes:** for both descriptions, unchanged and duration-only submissions returned changed=true, C moved from 1 to 2, and one outgoing operation appeared. The resulting text was trimmed/defaulted.

**Why tests miss it:** test/simulation.test.js:183-194 checks a no-op on an already normalized, locally authored record. test/protocol-review.test.js:138-151 preserves arbitrary received text only through parsing; it does not compose reception with a subsequent edit.

**Minimal correction:** validate the supplied snapshot, check the current base inside the transaction, preserve an equal description byte-for-scalar, and invoke authorDescription only when the description itself was deliberately changed. Compare the resulting complete snapshot for no-op before allocating IDs/counter/outbox. Do not change the wire parser or normalize received history globally.

### F4 — MEDIUM: reservation/restart/receive can create two byte values for one segment ID

**Exact implementation:** src/simulation/repository.js, reserve(), lines 422-438; receive(), lines 622-625; seal(), lines 449-459. receive() checks a publication only after it has bytes; seal() does not recheck the accepted segment registry.

**SPEC:** §16: sealed segment identity/content is immutable; same segment identity with different bytes is an integrity fault. §17: durable identity/content checks must cover competing writers/receivers before effects are exposed.

**Concrete execution using the runner:**

1. Finish X and inject reserve.afterCommit. Reservation S survives with membership and bytes=null; no upload occurred.
2. Put a separately valid remote segment under S containing another operation.
3. Reopen the repository and resume the runner.
4. Receive accepts the remote S because the reserved local publication has no sealed bytes yet.
5. seal() persists different local bytes under the same S, without checking state.segments[S].
6. The runner makes a network publication attempt. The fake transport detects the conflict only afterward.

**Observed probe:** state.segments[S].bytes differs from state.publications[S].bytes; publication state=in-flight; one publish call occurred; the final Recovery required state came from transport rejection.

This requires a UUID collision or an adversarial artifact claiming the reserved ID; its likelihood in ordinary honest random-ID use is low. Nevertheless, the identity invariant is explicitly required, and the inconsistent durable state is reproducible. A less protective byte-store adapter need not detect the conflict before creating another physical object.

**Why tests miss it:** competing sealers and competing receivers are tested separately, including test/simulation-review.test.js:152-185. The suite does not crash after reservation and then receive an opposing identity before seal.

**Minimal correction:** inside seal(), recheck the accepted segment registry before committing final bytes. Detect a mismatch and block the binding before network publication. A reserved identity must not become a second conflicting sealed identity merely because it previously had no bytes. No new coordination framework is required.

### F5 — LOW: standalone untrusted parser entry points have no byte policy

**Exact implementation:** src/protocol/validation.js:155,157, parseSession()/parseOperation(); src/protocol/json.js:6-9, parseWireJson() defaults maxBytes to Infinity; src/protocol/utf8.js:7-32 constructs the full decoded string. README.md's Core API section advertises these wrappers as untrusted-wire entry points.

**SPEC:** §10 requires bounds before unbounded allocation/numeric loss; §32 requires bounds for untrusted imported/remote JSON. Important scope qualification: §10 gives an explicit 1 MiB byte cap to descriptors/segments, not a standalone operation/session artifact. Actual receive uses bounded parseSegment(). This is a public API/resource-policy gap, not demonstrated over-limit segment acceptance.

**Concrete boundary probe:** a valid tiny session preceded by 2,097,152 whitespace bytes was accepted by parseSession(); total input=2,097,318 bytes. The analogous descriptor was rejected before decode. A huge invalid description or unknown array likewise reaches decoding/AST construction before shape validation rejects it; size can grow with caller input.

**Why tests miss it:** byte-limit tests exercise parseDescriptor()/parseSegment(), and standalone session/operation tests exercise scalar/schema boundaries without large raw inputs.

**Minimal correction:** expose/document an explicit bounded standalone-input policy or caller-supplied byte ceiling and check it before decoding. Distinguish an application resource refusal from inventing a new protocol validity rule for standalone artifacts. Ensure callers cannot mistake these wrappers for automatically bounded untrusted entry points.

### F6 — LOW: neutral “restart” and “rotate-writer” steps execute no lifecycle

**Exact test/function:** test/conformance.test.js:101-115, Lamport sequence driver; line 113 merely asserts that an unhandled action is named restart or rotate-writer. protocol/v1/test-vectors/README.md:46 calls expectedHighWater the durable high-water after each step.

**SPEC:** §§13,21 require restart/rotation not to rewind persisted C; §§34-35 require evidence for those transitions.

**Concrete test-independence mismatch:** a repository implementation that resets C on reopen/rotation could still pass every neutral Lamport sequence: the driver never creates/reopens its store or rotates a writer and keeps a local JavaScript highWater variable instead.

**Why current overall tests do not expose this particular weakness:** separate repository restart/rotation/recovery tests provide real modeled lifecycle assertions. Therefore this is a fixture-driver/evidence limitation, not a finding that current repository C actually rewinds.

**Minimal correction:** reuse these existing fixtures through actual repository lifecycle transitions, or explicitly label their driver as arithmetic-only and cite the repository tests for durability. More copies of arithmetic vectors would not improve this proof.

## 3. SPEC-conformance trace for the implemented scope

The table inventories the normative MUST/MUST NOT obligations relevant to the portable core and represented transaction/state-machine seams, including the field-table rules that SPEC declares normative. Grouping adjacent clauses does not turn an untested platform obligation into a demonstrated core guarantee.

“Supported” means source and relevant tests establish the stated property within the documented model. “Partial” identifies a counterexample or evidence boundary. “Deferred” means a later-phase feature is not implemented or claimed as implemented; unsafe enabled paths remain findings despite a related workflow being deferred.

| SPEC obligation | Implementation trace | Test/evidence and assessment |
|---|---|---|
| §§1,4: common protocol independent of UI/store/provider/runtime I/O | src/protocol/index.js and its internal-only imports | test/protocol.test.js:258 dependency-isolation check; source inspection. Supported. |
| §2: optional account/network/backend; only completed history on wire | Pure core; simulation receives symbolic bindings; closed operation/session shapes | Protocol shape tests and no external service modules. Local client UX deferred; no backend requirement introduced. |
| §2: no active timer synchronization, registries, GC, signatures, plugin framework, bridging | No such wire fields/mechanisms; only local owner simulation | Source/scope inspection. Supported. |
| §§5,7: stable active identity/revision, owner fencing, duplicate Finish outcome | repository.js:142-152,239-339 | simulation.test.js:139-180; simulation-review.test.js:53-89; final-review receipt/owner cases. Supported for injected liveness/time. |
| §§6-7: real monotonic measurement, no closed-time addition, checkpoint scheduling, no heartbeat death inference | Explicit focus samples and owner status are harness inputs; recoverOwner pauses and fences | Recovery tests establish transitions; real clock/lifetime/scheduling proof deferred and expressly not claimed. |
| §8: stale-base editor rejection and immutable entity identity | repository.js:390-400 and currentWinner():97-105 | simulation.test.js:209-221 and identity-collision regressions. Supported. |
| §§8-9,15: independent edits, exact received text, unchanged edit no operation | authoredPayload()/edit() | Partial: F3. Existing no-op test only covers normalized local text. |
| §§9,12: five-field full snapshot, required types/non-null, no audit/pause/runtime fields | validation.js:50-60,88-96,105-152 | protocol-review.test.js:154-174; literal wire cases. Supported. |
| §9: authoring fixed whitespace set/input bound/default separate from ingestion | validation.js:76-85 | protocol-review.test.js:138-151. Helper supported; edit integration fails F3. |
| §10: UTF-8 without BOM, scalar-only text and paired escapes | utf8.js:4-45; json.js:19-45 | Native Buffer boundary comparisons at protocol-review.test.js:110-121; direct hex vectors. Supported. |
| §10: duplicate names after decoding, only JSON syntax/whitespace, no parser normalization | json.js:12-99, null-prototype object/name checks at 64-73 | protocol.test.js:94-112; protocol-review.test.js:124-135. Supported. |
| §10: integer token grammar and bounds checked before lossy conversion | json.js:83-92; validation.js:43-47 | protocol.test.js:88-93; lexical/boundary vectors. Supported; no pre-validation Number rounding. |
| §10: canonical v4/v7 RFC-variant UUIDs, unsigned network ordering | validation.js:6-22 | protocol-review.test.js:77-94; independent byte conversion/ordering vectors. Supported. |
| §10: strict Gregorian UTC millisecond dates | validation.js:25-40 | protocol-review.test.js:97-107 and wire vectors. Supported; no host Date parser. |
| §§6,9-10: positive integer focus independent of wall span/reversed chronology | validation.js:88-96 | Reversed year-boundary chronology and duration min/max vectors. Supported. |
| §10: 0..120 scalars, exact normalization-distinct text | utf8.scalarCount(); validation.validateDescription() | Scalar/normalization tests. Parsing supported; subsequent edit integration partial F3. |
| §10: descriptor/segment 1 MiB before decode, depth 16, 1..1,000 ops, no repeated opId inside segment | json.js:6-9,47-52; validation.js:132-158; constants.js | Exact-byte/depth/count vectors and simulation-resources tests. Supported on actual segment path; standalone API caveat F5. |
| §§10,12,30: closed fields/versions/selectors; unsupported data not guessed | validation.shape()/version()/selector(); runner error handling | Negative wire vectors; simulation-review.test.js:206-221. Supported for bound artifacts. |
| §§11-12: descriptor, operation, writer/dataset/version/payload identity consistency | validation.js:99-152; repository.receive():618 | Envelope mismatch vectors and protocol-review.test.js:197-209. Supported. |
| §§11,14: dedup by dataset/op and entity key; mixed datasets not reduced together | reducer.js:33-48; single-dataset repository guards | Immutable-identity vectors and mixed-dataset rejection. Supported; a one-dataset API is an explicit implementation scope choice. |
| §13: all valid accepted ops advance C, including losers and post-delete UPSERTs | reducer.js:49; repository.projection():88-94 and receive() | simulation.test.js:224-236; reducer/neutral fixtures. Supported within store. |
| §13: atomic new C+1, no wall/device/time ordering or gratuitous versions | repository.localOperation():124-139; reducer.compareVersions():5-8 | Tie/loser tests, no-op/resource regressions; F3 incorrectly turns some no-ops into mutations. |
| §§13,21: retained high-water on reopen/rotation | MemoryStore retained state; rotateWriter():226-236 | Actual simulation lifecycle tests support it. Neutral fixture lifecycle alone does not: F6. |
| §13: exhaustion abort, deliberate recovery Finish with all effects atomic | localOperation():125; finishToRecovery():343-384 | simulation-review.test.js:259-316; final-review recovery/writer cases. Supported within model. |
| §14: any DELETE terminal; otherwise complete maximum UPSERT; retain losers | reducer.js:39-55; retained operation map | Independent oracle and explicit delete/tie vectors. Supported; see §4 mathematical audit. |
| §15: command/domain/op/outbox/C atomic, Finish consumes expected active once, no network in tx | MemoryStore.transaction():52-65; localOperation()/finish()/edit()/delete() | Crash matrices and receipts. Supported on ideal serial store; state contents still subject to F3. |
| §16: transactional unique membership reservation; one original writer; byte/count bounded batches | reserve():416-441; seal():444-462 | Competing sealer/member tests and escape-heavy recovered-corpus resource test. Supported for normal reservation paths. |
| §16: immutable sealed ID/bytes/original writer; no conflicting segment identity | seal()/receive() | Partial: F4 cross-path reservation/receive gap. |
| §16: unknown response retries exact bytes; affirmative exact confirmation before ack | runner.js:31-48; repository.beginAttempt()/unknown()/confirm() | Lost-response/reopen and invalid-confirmation tests. Supported conditional on adapter confirmation contract; model limitation in §5. |
| §16: ack exact membership only, retain later work and immutable history | acknowledge():508-524 | simulation-review.test.js:152-172; simulation.test.js:382-417. Supported; remote coverage bookkeeping is incomplete in F2. |
| §§16,19,25: stale bindings do not redirect/ack work | samePin()/requirePin(), generation checks; bind() | Stale in-flight acknowledgement supported. Full target-retarget safety partial: F1. |
| §17: bounded full validation before effects; transactional identity recheck; no valid-prefix ingestion | receive():603-646 | Receive matrices and conflicting-op/segment tests. Supported for receive against accepted/sealed identities; F4 identifies the missing reservation-to-seal counterpart. |
| §17: malformed/unsupported/integrity preserve valid state, evidence, pending work; blocked publication | artifactFailure():649-665; runFailure():668-679; requirePin() | Malformed/unsupported/oversized/changed-known regressions. Supported for handled runner faults. |
| §18: discovered/pending/applied/quarantined distinct; cursor with durable pending refs | recordPage():567-587; receive()/artifactFailure() | Discovery checkpoint/restart crash tests. Supported. |
| §18: all pages, empty continued pages not completion, no permanent time/name/UUID/sequence frontier | runner.js:62-81; transport.enumerate():128-151 | simulation.test.js:455-573. Supported for modeled snapshot/delayed scans; next full pass handles concurrent new refs. |
| §18: verify cached and omitted known content; new physical reference checked | receive():607-625; omittedReferences():596-600 | Existing received-reference tests supported. Publisher-known coverage partial: F2. |
| §§18,26: absence never creates domain DELETE or removes accepted state | runner error paths; no deletion from listing code | simulation.test.js:596-612 and related probes. Supported; F2 is false health, not a synthetic DELETE. |
| §19: offline descriptor/C/writer without account; pinned account/locator/dataset/generation | constructor():159-170; bind():183-214 | Local-only/generation tests. Actual client initialization/secure ID generation deferred to injected factory. |
| §§19-20: complete corpus on retarget, explicit adoption, no operation relabel | New datasetId rejected; full adoption/corpus copy deferred | Deferral is explicit; enabled same-dataset target switching violates intended guard: F1. |
| §21: only new authoring rotates writer; old pending/sealed ops stay unchanged | rotateWriter(); reserve() groups original operation writer | Recovered-corpus/resource and final-review writer tests. Supported. |
| §22: at-least-once, opaque pages, typed errors, byte transport without provider coupling | transport.js, runner.js, pin checks | Duplicate artifacts, paging/failure tests. Supported with documented modeled service assumptions. |
| §25: Synced requires no unresolved discovered artifacts/pending pub and complete pass | completePass()/status():682-708 | Normal pending/error cases supported; F1-F2 show incomplete binding/known-corpus obligations. |
| §§26,30: preserve work across missing root/authorization/unsupported failures | runFailure()/artifactFailure(); raw evidence bounded | simulation.test.js:652-679 and resources regressions. Supported for exercised bindings/artifacts. |
| §§28,31: retain losing ops, tombstones, accepted/sealed bytes after ack; no automatic GC | operations/segments/publications persist; ack only deletes outbox membership | Retention/replay assertions. Supported in memory; portable archive workflow/real storage retention deferred. |
| §32: no credential/history leak to developer; safe bounded data, no eval | No service I/O/credentials; strict parser | Source inspection and protocol import-isolation test; standalone resource-policy gap F5. UI rendering/storage security deferred. |
| §34: independent reusable wire/reducer/identity/ordering/resource vectors | protocol/v1/ and conformance.test.js | Meaningful finite evidence; native consumer/schema-engine execution not yet done; lifecycle-driver limitation F6. |
| §35: injected transaction boundaries, races, retries, multi-replica replay | MemoryStore, AdversarialTransport, test/simulation*.js | Broad finite coverage, not exhaustive state exploration; F1-F4 are missing compositions. |

Later-phase normative obligations in §§3,5-8,19-20,23-24,27-29,32-33,36-38 that depend on real UI/timing, IndexedDB/native storage, creation/discovery UX, full adoption/import/archive, browser security, OAuth/Drive, accessibility, or deployment remain deferred. Their absence is not counted as a Phase 1/2 defect. §35's complete later workflows/platform proof must still be satisfied before the corresponding integration/release gate; the current count does not discharge them.

## 4. Reducer and interoperability audit

### Mathematical reduction

For one valid dataset, the implementation validates every operation and checks duplicate opId semantic equality before it participates. It keeps:

1. maximum version UPSERT per entity;
2. presence/maximum representative DELETE per entity;
3. maximum accepted counter;
4. a separate retained immutable operation corpus in the repository.

Taking maxima under a strict total order and unioning deletion presence is associative, commutative, and idempotent. Filtering all keys with any DELETE gives exactly SPEC §14. A DELETE need not arrive after an UPSERT; a greater UPSERT cannot clear it. Numeric counter precedes UUID order. Payload replacement selects one whole snapshot, not arrival-dependent field accumulation.

Conflicting immutable identities are outside the valid-set algebra and throw rather than receive a winner. The repository does not claim incremental materialization can reconstruct discarded losing history; it retains the operations. No global chronological replay is needed, although the simulation recomputes the projection from its retained map.

I found no reducer counterexample. The mathematical argument is stronger than shuffling one example, but remains conditional on valid immutable identities and correct surrounding acceptance/publication. F4 violates that surrounding invariant without refuting the reducer.

### Cross-language contract

protocol/v1/protocol.md:13-108 is sufficient for an independent TypeScript/C#/C++/Kotlin/Swift v1 parser/reducer:

- Exact integers and decimal lexical validation precede limited numeric conversion. BigInt is a test-oracle technique, not a wire field/runtime dependency.
- Canonical ASCII UUID comparison equals unsigned network-byte order; .NET mixed-endian memory is explicitly excluded.
- Scalar counts, paired escapes, no normalization, strict UTC grammar, Gregorian validity, and duplicate decoded names are explicit.
- Unknown/missing/null/forbidden payload cases and malformed/unsupported/integrity classes are specified. Multiple simultaneous defect classes deliberately have no precedence; safe rejection, not matching one arbitrary error first, is required.
- Parsed operation equality versus byte-exact segment identity is explicit.

Production operationEqual() uses JSON.stringify at reducer.js:12-13, but first reconstructs every field through validateOperation() in a fixed field order. Its values are restricted exact integers/strings/closed payloads. This is not a hidden requirement that native clients reproduce JavaScript property insertion order or serializer spelling.

The four schemas are parsed-shape supplements. They cannot independently detect original number spelling, duplicate keys, raw UTF-8/bytes/depth, or field equality. Those limits are correctly disclosed. Schema-engine execution was not demonstrated; no inconsistent schema shape was found. An independent native implementation would add confidence, but its absence is not current protocol nonconformance.

The period in the authored default "Untitled session." follows SPEC §9's exact literal and is openly documented against the older reference; it is not counted as a hidden code deviation.

## 5. Transaction, crash, publication, and discovery model

### What the memory model establishes

MemoryStore.transaction(), repository.js:52-65, clones the entire committed state, performs synchronous work on the clone, and replaces one private state pointer at line 60. Failure before that replacement leaves old state; failure at afterCommit leaves complete new state but returns an error. Defensive read/result copies prevent ordinary caller mutation of the committed graph.

This correctly models an ideal serial atomic transaction and ambiguous post-commit response. Finish receipts bind active identity to outcome, reject alias reuse for another active session, and survive reopen against the same store. Counter, operation, projection, outbox, and active consumption execute inside that model. Receive validates before one transaction and rechecks durable identities inside it.

Reopening reuses the same MemoryStore object: this is process-restart state-machine evidence, not power-loss, disk-flush, IndexedDB durability, independent-browser-process, or native-store recovery evidence. Transactions are synchronous serial callbacks; nested work is rejected, not asynchronously scheduled. Real database isolation, unique constraints, transaction lifetime/auto-close, quota exceptions, read/write races across contexts, and execution-lifetime evidence must be established by the later adapter.

The completion report explicitly states this boundary. It is not itself a defect that a memory proof cannot establish the platform contract. Tests should retain that distinction rather than equate a trace boundary with a physical storage guarantee.

### Limits of the current adversary

The transport can delay/reorder/duplicate, interrupt reads, lose upload responses, and snapshot pages across controlled barriers. Competing workers share one serial store; asynchronous interleavings occur at network awaits or injected crashes. That explores useful state-machine compositions, not every browser scheduler/store behavior.

The fake transport's already-present path (transport.js:174-179) consults all internally stored objects, including ones excluded by its own available/readable controls, compares internal bytes, and echoes the expected bytes in confirmation. A client-side read would fail for some of those objects (157-158). This is a stronger service-side verification assumption than a read/list-only storage API.

I do not classify that alone as a generic protocol violation: §22 permits an affirmative verified same-content publication result, and the fake does compare stored bytes. It also does not prove a real Drive 409/read-verification path. When adding a real adapter or claiming that fault combination covered, require either modeled affirmative server-side verification or an accessible read-back; an unavailable object cannot simply be assumed a successful client-verifiable retry. F2 remains independently reproducible with an ordinary successful initial upload and no response loss.

### Paths that withstand review

Exact acknowledgement membership, an operation created during upload, unknown-outcome byte retry, old-generation acknowledgement fencing, accepted-op conflicts inside receive, durable pending references before cursor movement, delayed older artifacts on a later full pass, and no DELETE-from-absence all have credible source/test support. These strengths do not repair F1-F4's untested combinations.

## 6. Test-suite quality and independence

**490 passing checks meaningfully increase confidence, but they are not 490 independent guarantees.**

Useful independent evidence:

- protocol-review.test.js:35-68 uses separate grouping/filtering/sorting and BigInt counter differences to select expected complete winners/tombstones. It does not call production comparison/reduction to generate expected answers.
- Literal neutral valid/invalid wire fixtures supply declared values/classes. Hex fixtures exercise malformed bytes directly.
- UUID byte tests compare with independently converted bytes; UTF-8 width boundaries compare against Node Buffer (protocol-review.test.js:77-121).
- Direct assertions cover full snapshot fields, terminal delete, stale editor/owner identities, exact memberships, and retained state—not only success codes.

Coverage that is more limited than its size/name suggests:

- protocol.test.js:230 and 251 compute expected complete projections using reduceOperations itself. Their permutation/duplicate results establish invariance, not independent winner semantics. The large case independently checks counts/high-water, not every expected payload. This is supplemented, not invalidated, by the separate oracle/literal reducer vectors.
- All 720 permutations in each small test concern a fixed six-operation topology. A seeded 2,500-session replay adds scale/order variation, but does not generate binding migrations, reserve/receive identity conflicts, or acknowledgement-to-first-discovery loss.
- Random encoder/decoder roundtrip could share a codec bug; explicit native boundary comparisons and independent lexical probes are valuable counterweights.
- crashMatrix(), simulation.test.js:59-73, derives both expected committed state and available failure labels from the production happy-path execution. It establishes all-or-nothing relative to that path. If a required write and its step were omitted, this matrix alone could still pass. Keep independent assertions of required postconditions, as several existing tests already do.
- The neutral Lamport lifecycle actions are no-ops in their driver (F6). Their arithmetic expectedHighWater values are not persistence tests.
- Test filenames containing “review” describe useful regressions but do not make every oracle independent. Shared fixture builders are not intrinsically bad; deriving both the assertion and tested semantics from the same function is the relevant risk.

The discovered bugs come mainly from missing compositions of already-tested features: receive→no-op edit, acknowledge→retarget, acknowledge→loss-before-listing, and reserve-crash→receive→seal. Adding more permutations of the existing reducer topology would not expose them.

## 7. Claimed-guarantees audit

The following classifications concern the claims as written in docs/implementation-report.md, within its explicit deterministic-model scope. “Convincingly demonstrated” is not a real-storage/provider certification.

### Invariant claims, report lines 43-51

| Claim | Classification | Evidence / limitation |
|---|---|---|
| Set reduction, numeric/UUID ordering, complete values, no writer/wall-clock order | convincingly demonstrated | Source/mathematical argument, separate oracle, literal vectors and permutations. |
| Terminal deletion, retained losers, fresh identity for copy examples | convincingly demonstrated | Explicit counterexamples to ordinary LWW and retained operation-map assertions; full copy workflow is not implemented. |
| Exact wire rejects invalid/unsupported/resource-overflow input from accepted state | convincingly demonstrated for bounded segment/descriptor ingestion | Strict parser/validator plus vectors. Do not extend to unbounded standalone API resources; F5. |
| Lamport durability, losers/deleted ops, restart/rotation, exhaustion and recovery | convincingly demonstrated within the memory model | Actual repository tests support it; neutral lifecycle labels add no durability evidence (F6). |
| Local atomicity and repeatable Finish receipts, old-or-new ambiguous commit result | convincingly demonstrated within the memory model | Clone/commit source, matrices and independent receipt assertions. Domain no-op integration still fails F3. |
| Whole-segment receive atomicity and durable identity rechecks | convincingly demonstrated for receive against accepted/sealed identities | Complete validation and transactional rechecks. The cross-path reserved identity hole F4 remains. |
| Publication reservations, immutable retry, exact affirmative confirmation/ack, stale binding fence | partially demonstrated | Normal retry/membership/fence paths hold; F4 allows conflicting accepted/sealed bytes and F1 loses destination coverage. |
| Discovery/status, reread known/omitted content, no synthetic delete, no false healthy unresolved state | partially demonstrated | Existing discovered references work; F2 omits acknowledged uploads not yet enumerated, and F1 can report an empty new target healthy. |
| Two-replica and thousands-operation convergence | convincingly demonstrated for the listed finite retained-corpus scenarios | They reach the same valid operation set. They do not demonstrate arbitrary allowed binding/discovery executions; F1-F2 can prevent equal delivery sets. |

### Original completion checklist, report lines 73-86

| # | Claim | Classification | Audit |
|---|---|---|---|
| 1 | Existing reference behavior documented | convincingly demonstrated | Baseline document covers the C# behavior, new editing, adaptation, and physical-sleep limits. |
| 2 | Existing reference tests still pass | convincingly demonstrated as retained execution evidence | 31/31 report exists and reference source is unchanged; not rerun in this review. |
| 3 | Protocol v1 documentation exists | convincingly demonstrated | Exact language-neutral reference inspected. |
| 4 | Schemas/validators exist | convincingly demonstrated | Four closed shapes and strict validators exist; independent schema-engine execution remains unverified as disclosed. |
| 5 | Language-neutral vectors exist and execute | convincingly demonstrated as fixture existence/execution | 245-case grouped manifest is used; F6 limits what some action names establish. |
| 6 | Pure deterministic reducer exists | convincingly demonstrated | No platform I/O; defensive validated values and independent mathematical/oracle support. |
| 7 | Lamport semantics implemented/tested | convincingly demonstrated within the model | High-water and recovery paths supported; no platform durability implication. |
| 8 | Terminal DELETE tested | convincingly demonstrated | Before/after/stale/higher-counter cases. |
| 9 | Transactional simulation exists | convincingly demonstrated | Serial clone-and-commit plus post-commit ambiguity. |
| 10 | Adversarial memory transport exists | convincingly demonstrated | Fault controls/barriers are real; capabilities/limitations in §5. |
| 11 | Publication/retry/ack behavior tested | partially demonstrated | Meaningful normal/competing-worker tests; missing F1/F2/F4 compositions prevent complete guarantee. |
| 12 | Discovery/receive crash behavior tested | partially demonstrated | Crash durability within model is tested; known-publisher coverage is incomplete (F2). |
| 13 | Multi-client convergence demonstrated | convincingly demonstrated for the executed scenarios | Finite scenario proof, conditional on common valid delivered set. |
| 14 | Relevant suite passes | convincingly demonstrated as execution fact | JavaScript rerun succeeded; retained C# evidence supports its separate count. Passing is not conformance certification. |

### Other material completion-report claims

| Claim / report location | Classification | Audit |
|---|---|---|
| Listed documents/modules/test-support/script files exist, lines 9-19 | convincingly demonstrated | Inventory/source inspected; existence does not prove semantics. |
| No web/React/IndexedDB/Drive/OAuth/PWA implementation started, lines 3,90 | convincingly demonstrated | Source inventory and dependency inspection support scope claim. |
| Portable core has no platform imports/I/O, line 13 | convincingly demonstrated | Source plus import-isolation test. Node-only test/fixture access and structuredClone memory simulation are outside the portable core. |
| 490 passing checks, reported subgroup counts include nested matrix cases, lines 27-39 | convincingly demonstrated as reported test execution, not independent-property count | Successful fresh aggregate run; manifest grouping/source matches described kinds. Not a claim of 490 unique invariants. |
| All schema supplements checked, but no third-party schema engine run, line 39 | partially demonstrated | JSON shapes/refs inspected; schema-engine interoperability is explicitly unverified. |
| Failures/races exercised as listed, lines 57-61 | partially demonstrated as overall coverage | Listed cases exist; they do not cover the concrete compositions in F1-F4. |
| “No wire, reducer or synchronization-semantic deviations from SPEC,” line 65 | not demonstrated; contradicted | No portable reducer/wire defect found, but F1-F4 contradict the broader synchronization/domain-integration assertion. |
| Full corpus-copy/adoption/import/archive workflows deferred; pending target changes rejected, line 67 | partially demonstrated | Workflows are indeed absent; rejection only protects unacknowledged publications, not acknowledged/received corpus (F1). |
| A separately authorized client can now consume the core, line 90 | partially demonstrated | Portable protocol is a sound base; fix the enabled-state-machine defects before relying on completion/readiness. Real adapters still need the acknowledged later proof gates. |

Historical descriptions that earlier regressions were fixed are not re-proven merely by accepting the report; the current code/regression tests were inspected instead. No claim of actual browser/OS/provider correctness is attributed to the report, because it expressly disclaims it at line 53.

## 8. Specific missing adversarial checks

These recommendations are tied to plausible reproduced defects, not test-count growth. No tests were added during this review.

| Check | Independent expected result |
|---|---|
| Publish at A, acknowledge, then bind descriptor-only B; also exercise receive-only corpus and unsealed pending work | Reject unsupported retarget, or prove complete original-corpus coverage at B before Synced. A fresh B replica must not silently omit known history. |
| Publish own S; remove/make it unavailable before any second enumeration | Reconciliation retains a known coverage obligation; missing content prevents healthy status while local history stays intact. Changed bytes are already detected if the object is returned by enumeration. |
| Receive empty/surrounding-whitespace description; submit exact no-op and duration/date-only edits | Exact text preserved; no-op leaves complete state/C/outbox unchanged; only the deliberately edited field changes. |
| Crash reserve.afterCommit; receive opposing S; reopen and seal | No conflicting local sealed bytes or network send; identity fault detected locally. |
| Direct standalone parser oversized raw input | Defined early resource refusal/caller policy before decode, without incorrectly redefining bounded segment conformance. |
| Existing neutral restart/rotation sequences driven through actual lifecycle | C and retained corpus survive a real modeled reopen/rotation, or the fixture is explicitly described as arithmetic-only. Reuse existing vectors. |

For crash tests, add independent invariant assertions alongside the production-derived snapshots: each committed authored op has the expected outbox membership/counter/domain result; a consumed active ID has exactly one completion; each immutable segment identity has one byte value across accepted and sealed registries; every acknowledged target coverage obligation is represented in reconciliation state.

## 9. Scope check and disposition

No premature production web client, UI, IndexedDB/native persistence adapter, OAuth/Drive integration, service worker/PWA, telemetry/backend, compaction/snapshots, signatures, active-timer sync, or multi-provider bridge was found.

Local active ownership, receipt fencing, and a nested recovery collection are simulation seams specifically needed by the crash/recovery requirements; they are not a production timer or collection-management feature. Injected IDs, elapsed samples, owner-death signals, and ideal serial transactions correctly remain explicit assumptions.

Full dataset adoption/import/export/archive and transfer workflows can remain later work. The present API must reject unsafe unsupported transitions rather than infer that absence of pending local work proves a new remote has the corpus. That is why F1 is a current correction, not a request to implement the later workflow now.

The next step is a focused correction task for F1-F4 and the listed regression compositions, followed by review of the revised claims. This review implements none of those changes.
