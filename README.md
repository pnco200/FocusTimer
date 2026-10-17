# Focus Timer protocol core

The first implementation phase proves the portable **Focus Timer Sync Protocol v1** before attaching a UI, real local database or remote provider. [SPEC.md](SPEC.md) Draft v3 is authoritative. The supplied Studytime C# implementation remains an unchanged behavioral reference.

## Run

Use Node.js 22 or newer. There are **no package dependencies** and no installation/build step.

```text
npm test
npm run test:protocol
npm run test:simulation
```

On Windows with the .NET Framework 4.8 compiler, verify the unchanged reference separately:

```text
npm run test:reference
```

The reference executable runs hidden, using isolated generated data under ignored `.artifacts/`. It does not open or edit the user's Studytime records. See [the behavioral baseline](docs/existing-app-behavior.md) for the initial test result and observed behavior.

## Layout and boundaries

| Path | Purpose |
| --- | --- |
| `src/protocol/` | Dependency-free ECMAScript modules: strict UTF-8/JSON, closed validators, UUID/date/integer/scalar rules, immutable operation equality, Lamport arithmetic, deterministic reducer. No platform imports or I/O. |
| `src/simulation/` | Clone-and-commit transactional store, repository, publication state machine, deterministic adversarial byte transport and generic reconciliation runner. |
| `protocol/v1/protocol.md` | Normative language-neutral rules derived from SPEC. |
| `protocol/v1/schemas/` | JSON Schema Draft 2020-12 parsed shapes, with explicit limitations. |
| `protocol/v1/test-vectors/` | Literal positive/negative wire bytes and portable reduction, identity, ordering, delivery and clock sequences. |
| `test/` | Executable vectors, permutation/property tests, crash-boundary injection, transport/concurrency tests and independent review regressions. |

ECMAScript was chosen to keep this first core executable without a compiler or third-party runtime library. Node supplies only the test runner and file access for loading fixtures. Protocol values use exact safe integers; wire integer lexemes are checked before conversion. Future C++, Kotlin, Swift and C# clients implement the documented protocol and consume the same fixtures, rather than depending on this source or storage layout.

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

The simulation accepts injected IDs and explicit timing checkpoints. Its ownership/liveness signals and transport clock are test inputs. Secure UUID generation, actual timer measurement/suspend behavior, cross-tab primitives, production persistence, full recovery/adoption/import/export workflows and provider integration need their own later platform tests. No React UI, IndexedDB implementation, OAuth, Drive, PWA, compaction, snapshots or real-time synchronization is included.

See [the implementation report and verified completion checklist](docs/implementation-report.md) for test results, coverage and the next-phase boundary.
The [adversarial review corrections](docs/sync-core-corrections.md) document the subsequent F1–F6 fixes and their regression evidence.
