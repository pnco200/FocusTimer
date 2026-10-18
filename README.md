# Focus Timer

A usable local-first stopwatch for the web, built with React, TypeScript, Vite, and transactional IndexedDB. Start, pause, resume, finish, reset, edit completed sessions, search/delete history, see basic totals, and export CSV, history JSON, or a full local operation archive. No account or network is needed after the production shell has been cached.

[SPEC.md](SPEC.md) Draft v3 is authoritative. The portable **Sync Protocol v1**, conformance vectors, and supplied C# behavioral reference are unchanged. The deterministic model and production IndexedDB repository share pure local and remote lifecycle decisions. Durable remote state and provider-independent asynchronous orchestration are implemented; Google Drive, OAuth and synchronization UI remain unimplemented.

Contributors should follow the [UI/UX guidelines](docs/ui-ux-guidelines.md): explain consequences and user actions, not implementation details. Technical precision remains in the data and developer documentation; normal UI uses the language of sessions, history, backups, and offline use.

## Run

Use Node.js 24 (or supported Node 22.12+). Install the locked dependencies, then start the development server:

```text
npm ci
npm run dev
```

Open the localhost URL printed by Vite. To use the installable/offline production shell:

```text
npm run build
npm run preview
```

Deploy `dist/` on an HTTPS static origin at `/`. IndexedDB belongs to that origin: changing hostname or port gives a different local installation. Keep exports before clearing site data. The development server intentionally does not register a service worker. The production worker caches only the public app shell/assets and waits for old tabs to close before activating an update.

For LAN testing, add `-- --host 0.0.0.0` to the dev or preview command. Local history works over LAN HTTP with IndexedDB and cryptographic random numbers: `src/web/ids.ts` uses `crypto.randomUUID()` when available and otherwise creates canonical UUIDv4 values with `crypto.getRandomValues()`. It never uses `Math.random()`. On insecure LAN HTTP, Chromium omits `randomUUID`, Web Locks, persistent-storage APIs, and service workers. An idle timer is ready automatically; an existing running or paused session requires explicit **Continue here** recovery. The idle check and ownership change happen in one transaction, so startup cannot silently recover a session started in another tab. Offline reopening/PWA installation require HTTPS (or localhost). Missing optional APIs do not prevent local saves.

Space starts/pauses/resumes outside text fields. Reset pauses before confirmation and resumes on cancellation only if previously running. The session editor shows read-only local timestamps and adjusts focus by signed whole minutes while preserving seconds and milliseconds; history and totals use the viewer's local timezone. All export buttons ignore the search filter. Use Data & storage to request persistent browser storage or read the timing/recovery limitations.

```text
npm test                 # all 532 existing core tests + web/local tests
npm run test:browser     # production browser checks; build first
npm run test:protocol
npm run test:simulation
npm run test:async-runner # production async runner + production IndexedDB repository
```

The browser suite uses installed Chrome and Edge on Windows, including an emulated mobile viewport; see `playwright.config.ts`. It does not modify your normal browser profile. The suite starts a production preview on port 4173 and a separate source repository harness on port 4174; keep both ports free. Production assets must exist (`npm run build`).

On Windows with the .NET Framework 4.8 compiler, verify the unchanged reference separately:

```text
npm run test:reference
```

The reference executable runs hidden, using isolated generated data under ignored `.artifacts/`. It does not open or edit the user's Studytime records. See [the behavioral baseline](docs/existing-app-behavior.md) for the initial test result and observed behavior.

## Layout and boundaries

| Path | Purpose |
| --- | --- |
| `src/web/` | React UI, local stopwatch, Web Locks/BroadcastChannel coordination, native IndexedDB repository, reporting, and offline shell source. |
| `web-test/` | Stopwatch, transactional failure/recovery, fencing, editing, export, and exact statistics checks with fake-indexeddb. |
| `e2e/` | Real Chrome/Edge IndexedDB, tab ownership, failures, reload recovery, offline production use, responsive/keyboard checks. |
| `public/` | Manifest and install icons; build emits a versioned service worker. |
| `src/protocol/` | Dependency-free ECMAScript modules: strict UTF-8/JSON, closed validators, UUID/date/integer/scalar rules, immutable operation equality, Lamport arithmetic, deterministic reducer. No platform imports or I/O. |
| `src/simulation/` | Clone-and-commit transactional store, repository, publication state machine, deterministic adversarial byte transport and generic reconciliation runner. |
| `src/sync/` | Pure local authoring/materialization and remote reservation/sealing/confirmation/coverage/status decisions shared with production persistence. |
| `protocol/v1/protocol.md` | Normative language-neutral rules derived from SPEC. |
| `protocol/v1/schemas/` | JSON Schema Draft 2020-12 parsed shapes, with explicit limitations. |
| `protocol/v1/test-vectors/` | Literal positive/negative wire bytes and portable reduction, identity, ordering, delivery and clock sequences. |
| `test/` | Executable vectors, permutation/property tests, crash-boundary injection, transport/concurrency tests and independent review regressions. |

The protocol/simulation remain dependency-free ECMAScript, executable directly with Node. The web layer is strict TypeScript. It imports the existing validators, authoring rule, Lamport arithmetic, version comparison, and reducer; React and IndexedDB never enter the portable core. Future clients implement the documented protocol and consume the same fixtures, independently of this browser database format.

The production repository uses IndexedDB schema **3** in the original `focus-timer-local-v1` database. Schema-1/2 web history retains its IDs, operations, receipts, pending membership and writer identity. Schema 3 adds binding/discovery, publication, accepted-segment and physical-artifact stores without inventing remote success. Local commands and remote transitions use overlapping native transactions. `LocalRepository.remote()` exposes asynchronous reservation, exact-byte sealing/retry, confirmation/acknowledgement, discovery, bounded receive and internal status APIs. No network runs in these transactions. The archive includes exact accepted/sealed bytes and all remaining operations, excluding remote metadata. See the [local integration report](docs/indexeddb-sync-integration.md), [remote design mapping](docs/indexeddb-remote-sync-design.md) and [remote persistence report](docs/indexeddb-remote-sync-integration.md) for migration, verification and remaining proof limits.

## Asynchronous synchronization

`new SyncRunner(localRepository.remote(), transport)` from `src/web/sync-runner.ts` runs the production asynchronous persistence boundary through `SyncTransport` (`src/web/sync-transport.ts`). `run({signal, maxPages, maxPublications})` verifies the binding/descriptor, resumes durable downloads/publications, reconciles all pages and omitted known references, publishes exact retained bytes, and returns repository-derived status. Creation identities are persisted before upload; cancellation/reload preserves unresolved work and upload-time commands remain pending for a later run. Local storage failures propagate to the caller.

No provider is installed or automatically scheduled by the application. Test-only adversarial/HTTP transports exercise two independent IndexedDB replicas, cancellation, response loss and document reload. See the [async orchestration report](docs/async-sync-orchestration.md) for the contract, native results, differences from the deterministic model and exact Drive proof questions.

## Core API

Import from `src/protocol/index.js`. `parseSession`, `parseDescriptor`, `parseOperation` and `parseSegment` accept `Uint8Array` wire bytes. These are the untrusted-wire entry points. `validate*` functions validate already-constructed semantic objects and return independent snapshots; they cannot recover numeric token spelling or duplicate names erased by another JSON parser. Never place `JSON.parse` before a wire entry point.

`parseSession(bytes, {maxBytes})`, `parseOperation(bytes, {maxBytes})` and `parseWireJson(bytes, {maxBytes})` apply a default input budget of `DEFAULT_MAX_PARSE_BYTES` (1 MiB) before UTF-8 decoding or JSON allocation. Callers may supply a nonnegative safe integer byte budget, or explicitly opt out with `Infinity` when they enforce their own input bound. Exceeding this application budget throws `ResourceLimitError` with `code: 'resource-limit'`, `resource: 'input-bytes'`, and `limit`/`actual` byte counts; it makes no protocol-validity judgment. Standalone sessions/operations have no separate v1 wire byte cap. Descriptor/segment parsers always enforce their normative 1 MiB cap as a `malformed` protocol error, and do not accept an override.

`ProtocolError.classification` is `malformed`, `unsupported` or `integrity`. Structural parsing cannot identify conflicts with previously accepted immutable values; the repository performs those checks transactionally. JSON Schemas likewise supplement the strict validators and cannot replace wire checks.

`reduceOperations(operations, initialHighWater = 0)` reduces **one dataset** and returns `{entities, tombstones, highWater}`. Entities and tombstone UUIDs are sorted by entity UUID for deterministic comparison. The reducer retains no input references. Any DELETE permanently suppresses the entity; otherwise the maximum numeric Lamport counter/unsigned UUID opId selects a complete payload. Conflicting repeated operation identities throw; equal duplicates have no additional effect. Persist the operation corpus separately so losers remain recoverable.

`nextCounter` throws `CounterExhaustedError` at the exact maximum. `authorDescription` is an authoring convenience, separate from parsing/merge; its default is the exact SPEC §9 literal `Untitled session.` including its period. This differs from the reference's period-free default and is recorded in the baseline.

## Transactional simulation

Import `MemoryStore`, `TransactionalRepository`, `AdversarialTransport` and `SyncRunner` from `src/simulation/index.js`. Reopen a repository with the same `MemoryStore` to inspect committed state after a simulated crash. `store.trace` lists conceptual persistence boundaries; `store.failNext(label)` fails the next matching boundary, including `beforeCommit` and `afterCommit`. State and byte snapshots are defensive copies.

The repository models active identity/revision/owner fencing, completion receipts, stale-editor checks, transactional Lamport allocation, outbox reservations, immutable seal/attempt/unknown/confirm/ack transitions, and whole-segment receive. `finishToRecovery(command, {descriptor, deliberateDestination: true})` models SPEC §13's narrow counter-exhaustion exception: one transaction consumes the original active state and commits a separate local collection's descriptor/session/operation/clock/outbox/receipt. `recoverySnapshot(datasetId)` exposes that collection for inspection. Writer rotation affects new authoring in all represented local collections while retaining old immutable operations.

Every remote step checks a pinned account/locator/dataset/binding generation. Disconnect fences old requests and retains their work. Reconnecting the original validated target with `resumePublications: true` explicitly repins retained publication intents to a fresh generation without changing IDs, bytes or membership. Changing an established account or locator is rejected whenever the replica retains history or known artifact references, including acknowledged, received-only, tombstoned and unsealed work. A deliberate full-corpus transfer belongs to a later workflow; acknowledgement at one destination never establishes coverage at another. Empty replicas can select another destination.

Affirmative transport confirmations may include a `references` array of opaque physical locators whose exact bytes were verified. The confirmation transaction retains those references and original bytes before acknowledgement, so later reconciliation verifies an own upload even if it has never appeared in enumeration. Confirmations without physical references retain a logical coverage obligation: exact outbox membership may be acknowledged, but status remains pending until discovery locates and verifies the segment. Known obligations survive original-target reconnection. Sealing also rechecks accepted segment bytes inside its transaction, preventing a reservation recovered after a crash from conflicting with an intervening receive.

The test transport accepts scripted `error`, `partial`, `reject-cursor`, `truncated` and `response-lost` events through `queue(method, event)`, plus `holdNext(method)` barriers for deterministic worker/command interleavings. It supports pagination, reversed/duplicate discovery, duplicate physical publication, delayed visibility/readability and availability changes. `SyncRunner.run({maxPages, maxPublications})` can stop at bounded opportunities without claiming a completed reconciliation. No external service is contacted.

## Proof limits

The memory store models serial atomic transactions by cloning a durable state image, performing conceptual writes, and replacing the image at one commit boundary. Reopening a repository against the same store represents process restart. Failure injection at each recorded boundary proves old-or-complete command state in this model. It does **not** prove real disk, IndexedDB, quota, OS scheduling or execution-lifetime locking behavior.

The simulation accepts injected IDs and explicit timing checkpoints. Its ownership/liveness signals and transport clock are test inputs. The web client now adds real browser IndexedDB transactions and execution-lifetime Web Locks with transactional fencing. Browser tests establish the scenarios in [the web implementation report](docs/web-implementation-report.md), not universal power-loss, OS-sleep, eviction, or physical mobile guarantees.

The stopwatch uses `performance.now()` rather than wall-clock duration or display ticks. Detected browser lifecycle suspension falls back to the durable checkpoint paused, with a missing-time notice. Physical system sleep continuity remains a target proof gate: pause before sleeping when exact accounting matters. Close callbacks are best effort and the crash-loss window can exceed five seconds. Browsers without Web Locks claim idle timers transactionally and require explicit fenced recovery for started sessions, rather than a heartbeat-based owner election.

Switching away from the app requests a checkpoint when the page becomes hidden; it does not itself pause the stopwatch or release ownership. A freeze/resume uses the conservative paused fallback while retaining the surviving owner's control. If the page is discarded/reloaded on LAN HTTP, a started session requires **Continue here** recovery; the message does not assume another tab exists. HTTPS enables Web Locks for automatic owner coordination, but does not guarantee continuous background execution or eliminate the suspension timing fallback. These lifecycle paths are tested separately; physical Android scheduling and system sleep still need device-specific proof.

History import, portable archive restore, adoption, and provider integration remain later workflows. Exported archives already retain every local operation, including edits/deletions; the app can repair its materialized history from a valid retained journal and preserves damaged sources for deliberate recovery. No snapshots, compaction, remote UI, native client, tags, or projects are introduced.

See [the implementation report and verified completion checklist](docs/implementation-report.md) for test results, coverage and the next-phase boundary.
The [adversarial review corrections](docs/sync-core-corrections.md) document the subsequent F1–F6 fixes and their regression evidence.
