# Portable protocol core implementation report

Completed 2026-10-17 against the repository's authoritative `SPEC.md` Draft v3 and the separately authorized first implementation request. This report covers the portable protocol and deterministic in-memory proof only. No web client, React UI, production IndexedDB, Google Drive, OAuth or PWA implementation was started.

Updated after the separately authorized [F1–F6 adversarial-review corrections](sync-core-corrections.md). The original 490-test snapshot had the state-machine gaps recorded in [the review](sync-core-implementation-review.md); the counts and guarantees below describe the corrected implementation.

## Files and modules

| Files | Result |
| --- | --- |
| `docs/existing-app-behavior.md` | Observed C# behavior classified PRESERVE / ADAPT FOR WEB / REMOVE; initial baseline result, storage failures/recovery, export and actual sleep-proof limits. |
| `protocol/v1/protocol.md` | Language-neutral normative wire, identity/equality, reducer, Lamport, publication, receive/discovery and rejection rules derived from SPEC. |
| `protocol/v1/schemas/{focus-session,descriptor,operation,segment}.schema.json` | Four closed JSON Schema Draft 2020-12 parsed shapes; explicit supplemental strict-wire requirements. |
| `protocol/v1/test-vectors/{manifest.json,README.md}` | Literal language-neutral positive/negative fixtures and consumer instructions, independent of source language or local storage layout. |
| `src/protocol/{constants,errors,utf8,json,validation,reducer,index}.js` | Dependency-free portable ECMAScript core, with no platform imports or I/O. |
| `src/simulation/{repository,transport,runner,index}.js` | Atomic clone-and-commit repository, ownership/command fencing and receipts, narrow recovery Finish, pinned publication state machine, adversarial byte transport and reconciliation runner. |
| `test/{protocol,protocol-review,conformance}.test.js` | Core validation/property tests, an independent reducer oracle and execution of every neutral vector group. |
| `test/{simulation,simulation-review,simulation-final-review,simulation-resources}.test.js` | Transaction boundary matrices, independent regression review, publication/discovery races, resource limits, recovery and convergence. |
| `test/{sync-coverage-regressions,snapshot-segment-regressions,standalone-resource-policy}.test.js` | Regressions for destination/publication coverage, received-description preservation, reservation/receive conflicts and standalone parser budgets. |
| `test-support/fixtures.js` | Deterministic fixture builders and seeded permutations, outside automatic test discovery. |
| `tools/verify-reference.ps1` | Rebuilds and runs the unchanged C# suite hidden with isolated generated data. |
| `package.json`, `.gitignore`, `README.md`, this report | Dependency-free test commands, ignored build evidence, API/proof boundaries and review instructions. |

`SPEC.md`, both architecture review documents and all reference implementation source files remain unchanged. Generated executables, isolated test data and reports are ignored under `.artifacts/`. No dependency install, lockfile, provider configuration or credentials are required.

## Test results

| Command / group | Result |
| --- | --- |
| `npm test` | **532/532 passed**, zero failed, skipped or cancelled. Counts include named crash-matrix subtests. |
| Core examples and seeded properties | 85 passed. |
| Independent protocol review/oracle | 10 passed. |
| Executable neutral conformance cases | 245 passed. |
| Transaction/transport simulation | 117 passed. |
| Independent simulation review | 16 passed. |
| Final receipt/recovery/publication review | 9 passed. |
| Resource, ID allocation and disconnected-exhaustion regressions | 9 passed. |
| Destination/publication coverage regressions | 24 passed. |
| Description and segment-identity regressions | 7 passed. |
| Standalone application resource policy | 10 passed. |
| `npm run test:reference` | **31/31 passed**, unchanged C# / .NET Framework 4.8 reference. |

The final JavaScript run used Node.js v24.3.0; the package requires Node.js 22 or newer. The initial reference run happened before production changes: 27/31 in the command sandbox's temporary location, then 31/31 in a writable repository artifact directory. The four initial failures were `File.InternalMove` access failures, resolved without source edits. The reference was rebuilt and rerun successfully at completion.

The 245 neutral cases comprise 204 strict wire cases, 17 reducer scenarios, 13 immutable-identity comparisons, three UUID orderings, two depth-only cases, two physical delivery sequences and four Lamport sequences. The manifest carries exact raw text or hex bytes, including literal byte-limit boundaries; consumers need no shared generator. JSON Schemas were checked as JSON with consistent local references. A third-party schema engine was unavailable locally; executable strict validators, rather than a permissive schema/parser combination, are the conformance authority under the documented contract.

## Invariants demonstrated

- **Set reduction:** all 720 permutations of six-operation sets, duplicate passes, independent BigInt-oracle comparisons and seeded thousands-operation permutations yield identical complete entity values and terminal tombstone sets. Whole-session UPSERT wins by numeric Lamport counter then unsigned UUID opId; writer and wall-clock time do not order versions.
- **Terminal deletion:** DELETE before creation, a late stale DELETE and greater-counter edits after deletion never revive an entity. Losers remain in immutable history. Copy/restore in vectors uses a fresh entity identity.
- **Exact wire:** decoded duplicate object names, invalid UTF-8/BOM/surrogates, malformed Gregorian dates/UUIDs, unsafe or fraction/exponent number tokens, wrong/missing/null values, unknown fields/versions/types, envelope mismatches and resource overflow cannot enter accepted state. NFC/NFD-distinct text remains distinct. No chronology is inferred from focus duration.
- **Lamport durability:** every accepted valid operation advances high-water as needed, including losers and operations for tombstoned entities. Duplicate delivery/replay/sealing never allocate a new version. Restart and writer rotation do not rewind C. Maximum-counter mutations abort intact; explicitly selected recovery Finish commits to a separate local collection atomically.
- **Local atomicity:** successful Finish/edit/delete commit the domain effect, immutable operation, high-water and outbox together. Finish also consumes expected active identity/revision/owner and stores an outcome receipt. Failures at every modeled boundary reopen as the entire old or entire new state, including an ambiguous failure after commit. Receipt aliases cannot later denote a different active session. Received descriptions survive no-ops and unrelated field edits exactly; authoring normalization runs only for an actual description change.
- **Receive atomicity:** complete structural validation precedes one bounded acceptance transaction; durable state rechecks immutable identities. Operations, projection/tombstones, high-water, segment/dedup state and applied marker commit together. No valid prefix from a bad segment is accepted.
- **Publication:** transactional reservations exclude competing membership; sealed IDs/bytes/original writer/membership remain unchanged. Unknown outcomes retry the same publication. Confirmation must be affirmative and match exact bytes. Acknowledgement removes only the confirmed segment's included reservations; newer or other-worker work stays pending. Old bindings cannot acknowledge a fresh generation. Seal rechecks accepted segment identity after reservation/recovery, before any network send. Destination changes with retained corpus are rejected pending a deliberate full transfer.
- **Discovery/status:** incomplete/empty continued pages are not completion. Cursor coverage has durable pending references. Interrupted/rejected scans resume or reconcile fully. Known physical artifacts are reread, including omitted references and own uploads registered atomically by confirmation before their first enumeration. Confirmations without locators leave an unresolved coverage obligation until verified discovery. Changed bytes stop the binding. Remote absence never produces domain DELETE. Unresolved work/errors prevent Synced.
- **Convergence:** two independent replicas each create, edit and delete while offline, then exchange reversed/duplicated publications with lost responses. Their complete retained operation maps, high-water, visible values and tombstones match exactly after delivery. Separate 2,000-session neutral replay, 2,200-operation transactional replay and 2,500-session seeded core replay retain terminal deletions and losing history.

These are executable proofs within the deterministic model, not a claim that real browser/OS/storage/provider behavior has already been verified.

## Failures and races exercised

Crash injection covers local Finish/edit/delete, whole-segment receive, discovery pending/checkpoint, reserve, seal, attempt, unknown, confirm, ack, recovery Finish and ordinary/recovery receipt aliases, including before and after commit. Tests also cover write failure, duplicate Finish/lost commit response, stale active revision, owner death/uncertainty/recovery, a returning obsolete owner, a live-owner attach, invalid owner tokens, stale history editors, fresh identity collisions and unsafe opaque reference names.

Transport tests cover competing clock allocators/receivers/sealers/runners, edits during upload, duplicated physical publication/delivery, response loss, reordered/delayed artifacts, partial/empty/paginated listing, transient incomplete reads, objects appearing during enumeration, interruption/rejected continuation, known objects omitted/unavailable/changed, malformed/unsupported/conflicting artifacts, descriptor/root/access/authorization failures and disconnected stale publication responses. New-target cutover with retained publication intents is rejected; deliberate original-target resume uses a fresh fence while preserving exact sealed bytes. Resource tests force 1,000 recovered authored operations with escape-heavy 120-scalar descriptions to split by bytes before the count limit, and verify exact complete membership and original writer preservation.

Independent review found and fixed identity reuse, opaque-reference prototype collisions, null active-description checkpoints, changed malformed known artifacts, temporary dataset restoration, invalid publication outcomes, stale recovery authoring identity, command receipt alias reuse and invalid owner recovery tokens. Additional regressions ensure oversized evidence stays bounded, receive-only/no-op/retry paths allocate no unnecessary identity, invalid generated segment IDs cannot reserve outbox work, and disconnect cannot hide exhausted local counter status.

## SPEC consistency and scope decisions

No unresolved SPEC deviation is known within the corrected scope; the separate adversarial review found real gaps in the original completion claim, now addressed by the linked correction pass. This remains finite state-machine evidence within the documented model. No blocking SPEC contradiction was found and `SPEC.md` was not edited. The author's default is the exact §9 literal `Untitled session.` including its period; the reference's default lacks that period, so the baseline records the adaptation explicitly. Multiple independent error defects have no mandated classification precedence in SPEC; fixtures isolate classifications and all such artifacts are rejected atomically instead of inventing a new precedence rule.

The chosen implementation language and folder layout are advisory implementation choices. JSON Schema supplements the custom strict wire validator; it cannot express original token spellings, duplicate decoded names, raw byte/depth limits or cross-field equality on its own. Standalone parser input budgets are configurable application policy with distinct resource refusal, not new wire rules. The single-primary-dataset memory repository includes a nested local collection only to prove the narrow §13 recovery transaction. Full collection selection/adoption/import/archive/corpus-copy UX and persistence are not implemented. Target changes with any retained corpus/known references are explicitly rejected until such a deliberate workflow exists, while disconnect/original-target resume is supported and tested.

## Original completion checklist, verified item by item

| # | Original criterion | Verified evidence |
| --- | --- | --- |
| 1 | Existing reference behavior is documented. | `docs/existing-app-behavior.md`, all requested behavior areas and three treatment classifications. **PASS** |
| 2 | Existing reference tests still pass. | Final `npm run test:reference`: 31/31; source unchanged. **PASS** |
| 3 | Protocol v1 documentation exists. | `protocol/v1/protocol.md`, language-neutral normative rules. **PASS** |
| 4 | Schemas/validators exist. | Four closed schemas and strict `src/protocol/` validators. **PASS** |
| 5 | Language-neutral conformance vectors exist. | Manifest + consumer README; all 245 cases executed. **PASS** |
| 6 | Pure deterministic reducer exists. | `src/protocol/reducer.js`; permutation/oracle/dependency-isolation tests. **PASS** |
| 7 | Lamport semantics are implemented and tested. | Exact counters/high-water, losing/deleted-entity acceptance, restart/rotation, exhaustion and recovery tests. **PASS** |
| 8 | Terminal DELETE behavior is tested. | Before/after/stale/high-counter UPSERT vectors and convergence tests. **PASS** |
| 9 | Transactional local simulation exists. | `MemoryStore` / `TransactionalRepository`; full-state old-or-committed crash matrices. **PASS** |
| 10 | Adversarial in-memory transport exists. | `AdversarialTransport`, scripted faults, visibility, paging, duplication and deterministic barriers. **PASS** |
| 11 | Publication/retry/ack behavior is tested. | Full lifecycle, immutable retry, exact membership, competing workers, stale bindings, retained-corpus retarget refusal and reservation/receive identity conflicts. **PASS** |
| 12 | Discovery/receive crash behavior is tested. | Pending/checkpoint and whole-segment matrices, restart, own-upload coverage before first enumeration, confirmation/ack ambiguity and integrity tests. **PASS** |
| 13 | Multi-client convergence is demonstrated. | Both replicas create/edit/delete offline; exact retained operation maps and materialized state converge. **PASS** |
| 14 | Complete relevant test suite passes. | JavaScript 532/532 and unchanged reference 31/31; zero unresolved failures. **PASS** |

## Next phase, not started

A separately authorized local-first client can now consume this protocol: real transactional persistence/recovery, timer/history commands and editing, local tab ownership, responsive accessible UI, offline/PWA behavior and actual suspend/clock proof. It must replace simulated commit/liveness guarantees with platform evidence and implement deliberate collection/import/archive/recovery workflows. Drive/OAuth and native clients remain later integrations with their own explicit proof gates; they must reuse this protocol without changing identity, ordering, deletion, retry or receive semantics.
