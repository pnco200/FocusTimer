# IndexedDB local synchronization integration

## Boundary audit, before implementation

The development web client already uses database `focus-timer-local-v1`, schema 1. `history` is a materialized winner/tombstone projection; `operations` contains complete immutable v1 operations. Finish/edit/delete already write those stores, `collections.highWater`, and `outbox` in one native IndexedDB transaction. Finish also consumes `active/current` and stores an active-ID receipt. `meta/installation` holds the selected dataset and installation writer. Active checkpoints, ownership tokens/generations and fractional running focus are local records, never operations.

The deterministic repository instead keeps a cloned graph containing operations, entities, tombstones, C, outbox, receipts and active ownership. Its serial clone/commit mechanism cannot be a browser persistence adapter. The duplicated *domain decisions* are authored snapshots, operation construction, no-op edit normalization and projection/winner selection. The duplicated entities/history are a deliberate materialized cache, not a second authority. The immutable journal remains authoritative, with retained projection evidence for repairs.

The web client uses execution-lifetime Web Locks when available, BroadcastChannel for observations, and transactional active identity/revision/token/generation fences. With no Web Locks it can claim an idle timer transactionally; started timers require deliberate recovery. Neither BroadcastChannel nor heartbeat silence is a correctness primitive. This coordination remains in place.

No production binding, publication intent, sealed bytes, acknowledgement, discovery cursor or receive state exists. Every v1 web operation is local and pending with `reservation: null`. The simulation's remote lifecycle is intentionally outside this phase. No acknowledgement or publication state will be inferred from absence of an outbox row.

## Implementation decisions

- Extract only pure local semantic decisions from the verified simulation into `src/sync/local.js`, shared by the deterministic model and IndexedDB repository. Keep the frozen wire protocol and deterministic tests unchanged. Persist individual records through real IndexedDB requests; never load a graph and emulate a transaction in memory.
- Keep the database name and existing keys. Upgrade the local schema to 2 transactionally, adding dataset indexes for pending work and receipts. Version change closes current connections; blocked upgrades report an actionable reload/close-tabs error.
- Audit/adopt the selected v1 collection and write the repository marker in one read-write transaction. Retain original descriptor/writer/entity/op IDs, counters, receipts, active checkpoints and operation/outbox values. Recover C upward only. Never create operations because storage layout changed.
- A valid projected operation absent from, or conflicting with, the journal is ambiguous damage, not permission to delete history or manufacture UPSERTs. Refuse adoption and preserve the source. A damaged/missing projection can be rebuilt when its journal provides the corresponding authority, retaining the damaged projection as evidence. An unsupported reservation or missing pending membership also fails conservatively; this client has never published work.
- Finish validates/replays a durable receipt against its original operation. New receipts also pin the source dataset. A recovery Finish checks fresh entity identity in both original and destination collections. All command results wait for transaction completion.
- No new UI, import/adoption into a different dataset, remote binding, sealing, receive, publication, Drive or OAuth is introduced. Schema adoption of an existing same-dataset journal needs no new product decision under SPEC §29. Projection-only or native legacy data needs an explicitly scoped import/recovery decision; it is preserved and refused here.

## Production architecture

`LocalRepository` is the production browser repository; there is no `MemoryStore` in the application bundle. `src/sync/local.js` owns pure authored-session, unchanged-description edit, operation-construction and winner-metadata decisions, using the unchanged portable validator/reducer. The deterministic repository delegates its authored snapshots/operations/edits to these helpers. Its transaction mechanism and transport remain a separate test model. No deterministic core test was changed.

Each production command opens a native read-write transaction covering the eight stores. Overlapping transactions from independent connections therefore serialize read/check/write of the same persisted C and winner. These relatively broad scopes deliberately favor correctness; future profiling may justify narrower overlapping scopes. No Web Lock, UI command queue, BroadcastChannel message or cached graph supplies database isolation. Only IndexedDB request promises are awaited while a transaction is live, avoiding automatic transaction closure across unrelated asynchronous work. Strict durability is requested, and success is returned only after `complete`.

| Store | Authority / behavior |
| --- | --- |
| `meta` | Installation writer/selected dataset, and version-2 repository-adoption marker. Installation format remains 1; database version is independently 2. |
| `collections` | Immutable descriptors and per-dataset high-water. Initialization recovers C to at least its retained value and journal maximum. |
| `operations` | Immutable complete operations keyed by dataset/op ID, with dataset/entity indexes. Local authoring uses `add`, so a key collision aborts instead of overwriting. Losing versions and terminal DELETE operations remain indefinitely. |
| `history` | Indexed materialized winner/tombstone cache. Edits/deletes authorize against entity-indexed operations inside the write transaction, so a stale cache cannot revive a deleted entity or authorize a stale base. New projection metadata uses the frozen reducer and comparator. |
| `outbox` | One pending membership per local operation, committed with that operation and its clock/domain effect. Version 2 adds a dataset index. There is no remote acknowledgement or local sealing in this phase. |
| `active` | Fractional local focus, stable active ID/start, revision and owner fence. Start/pause/resume/checkpoint/reset remain local-only. |
| `receipts` | Durable completed outcome keyed by consumed active ID, with a dataset index. New receipts record original source dataset, destination, operation ID and exact original session. A replay verifies its operation and returns the original outcome, even after later edit/delete, with no new IDs/counter/outbox. Legacy receipts are retained verbatim; their absent source metadata is not guessed. |
| `evidence` | Retained damaged projection or deliberate new-history source metadata; never published or exported as wire history. |

Finish checks expected source dataset, active identity/revision and owner token/generation in its native transaction. It commits the immutable UPSERT, materialized session, C, pending membership, receipt and cleared active checkpoint together. Narrow counter-exhaustion recovery additionally checks entity freshness in the original collection and commits the new collection/cutover in the same transaction; old collection data remains intact. A prior committed receipt may return its historical outcome after ownership changes, but never consumes a new active timer.

`syncState()` supplies an internally consistent read-only snapshot of descriptor, writer, C, operations and pending memberships, excluding all active/runtime data. Archive export consumes that snapshot. It is a local persistence boundary for later integration, not an implementation of the network runner interface.

## Migration strategy and failure handling

1. Native `versionchange` creates the two indexes transactionally, without changing existing records. On failure, schema 1 and its data survive. On success, schema 2 may exist before domain adoption has completed; original records remain intact and adoption retries independently.
2. Initialization validates the selected collection's journal, projected immutable identities, pending membership, completion receipts and active checkpoint in one read-write transaction. C can only advance. A missing/damaged projection is repaired from the validated journal with retained evidence. Valid projected facts missing/conflicting in the journal cause recovery-required, rather than deletion or fabricated mutation history.
3. The marker and any projection/high-water repairs commit together. Failure leaves all data and the marker at their previous state. Reinitialization/reload makes no extra operation, receipt or history entry.
4. Retained unselected collections remain unchanged. This phase has no collection-selection/adoption UI; a future selection must validate that collection before use. An explicitly requested new-history recovery can still preserve a damaged old collection without forcing it through a successful audit.

Valid schema-1 web history already has matching operations and pending memberships under SPEC §19, so no reauthoring/product decision is needed. Projection-only legacy data, missing pending rows or non-null reservations are not treated as published history. They are retained and refused for explicit recovery. A future importer must apply SPEC §§20/27/29, with deliberate scope and tombstone behavior. This phase does not import C# AppData or unrelated datasets.

Blocked upgrades explain that the user should close other Focus Timer tabs and retry; exceptions and internal IDs are not rendered. Open repositories close on `versionchange`; `TimerClient` retains its existing reload-required handling. No synchronization UI was added.

## Verification

Existing app tests use the production bundle on port 4173. Direct repository tests use the exact production TypeScript source compiled by Vite on port 4174 in a separate test-only page; that harness is absent from `dist/` and introduces no application debug global. Tests use isolated Playwright profiles and databases, never the user's normal browser data. The sandbox could not start the communicating browser/server processes; real browser runs used the authorized host execution path.

Environment: Windows, Node 24.3.0, Playwright 1.64.1, installed Chrome 155.0.8059.80 and Edge 155.0.4283.45. The third project emulates Pixel 7 on desktop Chrome.

| Check | Result |
| --- | --- |
| `npm run test:core` | 532 passed; existing deterministic tests and v1 protocol files unchanged. |
| `npm run test:web` | 89 passed across five files, including 18 integration regressions. |
| `npm run test:browser` | 144/144 passed in 3.3 minutes: 48 scenarios each in Chrome desktop, Chrome Pixel 7 emulation and Edge desktop. Includes 66 new browser checks. |
| `npm run test:reference` | 31/31 passed, unchanged C# source. |
| `npm run build` | TypeScript and production Vite build passed. |

Browser scenarios cover fresh installation; production-app existing-history startup and reload; exact schema-1 corpus/IDs/description/tombstone/receipt/checkpoint retention; writer/C restart durability; two independent tabs without Web Locks racing same-base edits and allocating different counters on independent entities; obsolete-owner Finish refusal; duplicate/racing/restarted Finish; native `transaction.abort()` after every Finish write and before commit; native edit/delete abort; actual operation-key `ConstraintError`; simulated response loss **after a native commit**; document destruction while a real native transaction remains pending after operation/receipt writes; aborted schema upgrade followed by retry; blocked old connection release; interrupted adoption followed by reopen; and refusal of projection-only data without alteration. Existing production timer, recovery, stale editor, ownership, no-lock fallback, PWA/offline, export and responsive tests also run.

Engine tests additionally compare complete local operation/outbox/clock/materialized outcomes with the deterministic repository through Finish, edit, no-op and DELETE; inject edit/delete failures at each relevant write; verify high-water repair rollback with marker rollback; reject ambiguous receipts/reservations/pending membership; reject source-ID reuse during recovery Finish; show that stale projection data cannot authorize resurrection; and prove receipt retries work with an unavailable ID factory.

## Differences from the memory model and proof limits

- Browser commands use separate native database connections/transactions and IndexedDB unique constraints, not synchronous clone/commit. Derived Maps used for validation/reduction are computations within a transaction, not substitutes for atomic persistence. Operation reads for editing are entity-indexed; the full startup integrity pass still replays the selected retained corpus.
- Active checkpoints retain fractional milliseconds and truncate only on completion, as the pre-existing stopwatch requires. The deterministic active fixture model uses whole milliseconds. Owner lifetime evidence comes from browser Web Locks when available; transactional fencing remains necessary and is verified with that API disabled. There is no heartbeat election.
- The web API exposes no command-ID alias namespace. Its durable idempotency key is the consumed active ID, which cannot be reused. New receipts additionally pin the original dataset; old receipt metadata is preserved rather than invented. Replaying a historical receipt does not reapply a mutation.
- Publication/receive/discovery/binding semantics remain proven **only in the deterministic model**. No exact publication bytes or confirmation state exists in the pre-integration web database. This phase preserves all pending work; it does not fabricate an acknowledgement, reservation, sealed segment or remote acceptance. Real browser storage for those later transitions must be added with the corresponding transport phase before enabling its runner. `LocalRepository` is not a drop-in synchronous `TransactionalRepository` adapter.
- Native reload, document teardown, database abort and unique-constraint behavior are real browser evidence. The post-commit response loss is an injected caller failure after the actual transaction completed. The pending-transaction teardown fixture keeps native requests outstanding; it proves document-close rollback, not every timing of process/OS failure. Physical power loss, hardware flush, disk exhaustion, eviction, database corruption, browser-process kill and full browser restart are not proven. Strict durability requests do not establish those guarantees universally.
- Chrome mobile uses an emulated Pixel 7 viewport on Windows; no physical Android/iOS, Safari or Firefox proof is claimed. Prior physical sleep/hibernation, browser lifecycle and PWA deployment/update/install proof limits remain as documented in the web report.

No SPEC conflict was found. IndexedDB provides the required atomic transaction/isolation boundary for these local commands on the tested browsers; no v1 guarantee or wire field was changed to fit it.

## Files changed in this phase

- `src/sync/local.js`: shared pure local semantic helpers.
- `src/simulation/repository.js`: delegate three existing local decisions to the shared helpers; unchanged state machine/transport and deterministic tests.
- `src/web/repository.ts`: schema 2, safe journal adoption, authoritative transactional winner checks, immutable writes, validated/source-pinned receipts, ambiguity injection seam, consistent sync snapshot and archive integration.
- `src/web/ui-copy.ts`: user-facing blocked-update recovery copy.
- `web-test/sync-repository.test.ts`: engine integration, failure, migration and model-comparison regressions.
- `e2e/fixtures/{legacy.ts,repository.html,repository-harness.ts}`: independent schema-1 fixture and test-only direct repository page.
- `e2e/repository.spec.ts`, `e2e/startup.spec.ts`, `playwright.config.ts`: native transaction/concurrency/migration tests, production upgrade regression and separate direct-source test server.
- `README.md`, this report: architecture, migration and verification boundaries.

The workspace already contained uncommitted web implementation files and changes to `.gitignore`, `SPEC.md`, `package.json` and the lockfile. Those pre-existing changes were preserved. This phase did not change the SPEC, frozen protocol modules/artifacts, deterministic test files, reference source, timer, ownership coordinator, service-worker policy or dependencies.

## Before Drive/OAuth

Implement the separately scoped durable binding, local segment reservation/sealing/exact-byte lifecycle, pinned confirmations/acknowledgements, bounded inbound acceptance and discovery checkpoint repository methods, with native crash/concurrency tests, before enabling a production remote runner. Then satisfy SPEC §§24/36's provider authorization/cross-client, retry/read-back, pagination, errors and privacy proof gates. Import/archive restore/deliberate adoption and physical target/lifecycle proof remain separately scoped work. Google Drive, OAuth, remote discovery/publication/receive and synchronization status UI have not been implemented.
