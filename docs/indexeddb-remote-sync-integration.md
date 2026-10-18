# Production IndexedDB remote-sync persistence

Implemented against SPEC Draft v3 and the corrected deterministic state machine. The [preimplementation mapping](indexeddb-remote-sync-design.md) records the audit and proposed representation. No protocol/SPEC changes, Google/OAuth/network provider, sync UI, corpus transfer, import/restore or active-timer synchronization were added.

## Architecture and schema

`LocalRepository.remote()` returns the asynchronous `RemoteRepository` in `src/web/remote-repository.ts`. Both repositories use `src/web/idb.ts`: actual IndexedDB requests, overlapping native transaction scopes, requested strict durability, and results returned after transaction completion. Network/other asynchronous work never runs inside transactions. Production does not import `MemoryStore` or execute a graph-based transaction adapter.

Schema **3** adds:

| Store | Key and retained authority |
| --- | --- |
| `remote` | Dataset ID: provider/account/root locator, last binding, generation fence, block/error, current discovery pass and opaque checkpoint. Descriptor authority remains `collections`. |
| `publications` | Dataset/segment ID: allocated identity, original writer, exact operations and membership, immutable bytes, reserved/sealed/in-flight/unknown/confirmed/acknowledged state, attempts and unioned physical references. |
| `segments` | Dataset/segment ID: accepted exact bytes and membership, including verified own publication content. |
| `artifacts` | Dataset/opaque physical reference: pending/applied/quarantined, original bytes/segment identity, seen/verified pass, error and bounded rejected bytes/length. |

The latter three stores have dataset indexes. Existing `outbox.reservation` supplies exclusive publication membership; acknowledgement removes only exact confirmed rows. Immutable operations, losing versions, segment bytes and tombstones remain retained. Existing archives now include accepted/sealed exact segment text and only uncovered operations, with no binding/cursor/runtime metadata.

`src/sync/remote.js` supplies shared pure binding checks, reservation construction, serialization, confirmation validation, coverage and status decisions. The deterministic repository delegates to those helpers with its prior errors and persistence failpoints preserved. Native transitions explicitly check individual records inside write transactions.

Receive bounds/copies/validates the entire segment first. Acceptance rechecks binding and physical/segment/operation identities transactionally; it commits new immutable operations, affected winner/tombstone summaries, upward-only C, segment/dedup and applied marker together. It reads at most one prior winner and its authoritative journal operation per affected entity, rather than all historical versions. Startup audits the projection against the complete retained journal. A malformed tail or conflict accepts no prefix.

## Repository boundary and status

All transition methods are asynchronous:

- Binding: `captureBinding`, `assertPin`, `bind`, `disconnect`, `verifyDescriptor`.
- Publication: `reserve`, `seal`, `publications`, `beginAttempt`, `unknown`, `confirm`, `acknowledge`.
- Discovery/receive: `beginPass`, `restartEnumeration`, `recordPage`, `pendingReferences`, `omittedReferences`, `receive`.
- Failure/status: `artifactFailure`, `runFailure`, `completePass`, `status`; `snapshot` provides consistent internal diagnostics/model comparison.

Bindings pin provider/account/locator/dataset/generation. Same-target reconnect preserves obligations and repins pending publications only with explicit `resumePublications`; retained corpus rejects unsupported retargets. In-flight state surviving a crash is unresolved/retryable, never confirmation. Attempts and unknown retries reuse the same ID, bytes, writer and membership; attempt count is diagnostic only.

This phase deliberately stops at the repository boundary. The synchronous simulation runner is not installed as a production runner. A future asynchronous runner must await every repository transition, verify the descriptor, resume pending downloads, consume explicit page completion, recheck omitted known references, publish sealed bytes, and persist classified failures. As in the deterministic repository, raw `receive`/seal/confirmation validation rejection aborts without effects; the caller must await `artifactFailure` or `runFailure` before stopping the run. Persistence/transaction failure must not be mistaken for diagnosed remote damage. No provider guarantee is inferred from a caller-supplied confirmation.

`status()` shares deterministic labels internally; snapshot publication states distinguish in-flight/unknown outcomes. `Synced` requires completed reconciliation, no outbox/unacknowledged work, all known artifacts applied/verified for that pass, no unresolved acknowledged coverage and no error/block. A reference-free confirmation leaves a logical coverage obligation. A confirmation with verified physical references stores those obligations before acknowledgement, so later omitted/missing own uploads cannot disappear from reconciliation. A local mutation immediately makes status pending. These diagnostics are not rendered in the product.

## Migration

The schema-2 upgrade creates empty stores/indexes only. Every prior operation/ID/writer/counter, pending row, receipt, projection and active checkpoint remains intact; all prior work stays genuinely pending. It fabricates no binding, reservation, sealed bytes, acknowledgement or coverage. Native versionchange rollback retains schema 2 and retries safely. Initialization/marker updates remain independently atomic and repeatable.

Initialization now distinguishes pending operations from positively retained accepted/acknowledged evidence, since received and acknowledged operations legitimately have no outbox row. It verifies publication membership/bytes, accepted journal identities, artifact originals, binding fences and discovery metadata. Missing or ambiguous authority is preserved and refused, never interpreted as success. Reinitialization does not reset publication/pass state or create operations.

## Verification

| Check | Result |
| --- | --- |
| `npm run test:core` (through `npm test`) | **532/532 passed**; complete existing deterministic/protocol suite. |
| `npm run test:web` | **135/135 passed** across seven files; includes 46 new remote persistence/boundary checks. |
| `npm run test:browser` | **201/201 passed in 3.6 minutes**: 67 scenarios each in Chrome desktop, Chrome Pixel 7 emulation and Edge desktop; 57 new native remote checks. |
| Strengthened byte-transport response-loss/retry composition | **3/3 passed**, rerun in all three browser projects after the full run. The test transport retains accepted bytes outside the destroyed page, loses its first response, verifies exact retry and returns same-content confirmation before native acknowledgement. |
| `npm run test:reference` | **31/31 passed**, unchanged C# reference rebuilt. |
| `npm run build`, final TypeScript check | **Passed** after the final audit correction; 47 production modules. |
| `git diff --check` | **Passed**. |

The final audit caught and corrected a metadata-validation edge: repeated disconnect before any first binding legitimately advances the generation while retaining no last target. Reopen now preserves that local-only pending corpus and permits a first binding with the correct generation. Its focused regression passes; the full web suite was rerun after the correction. No remote protocol transition changed. Earlier resource-test contention exceeded a 20-second test timeout; the meaningful byte/count assertions pass with a 60-second allowance and completed within the final 9.83-second complete web run.

Native tests use isolated Chrome/Edge Playwright profiles and the exact production TypeScript repository served by the test-only Vite harness. The normal application scenarios use the built production bundle. Tests never access the user's browser profile or live history. The native scenarios cover schema-2 migration and aborted upgrade/retry; two DedicatedWorkers racing reservation; committed reservation/seal reloads; authoring during upload and between confirmation/acknowledgement; competing acknowledgement; publication response loss/unknown/reload/exact retry; stale reconnect generation; F4 reservation/crash/conflicting receive/seal; F2 physical loss and unresolved logical coverage; discovery checkpoint interruption/rollback and empty continued page; receive aborts and document destruction during a pending transaction; invalid segment tails; duplicate physical/operation delivery and competing immutable identity conflicts.

Engine integration tests additionally exercise every receive conceptual abort boundary, reservation/seal/attempt/unknown/confirm/ack rollback, exact-byte/count limits and original writers, two complete model-comparison traces, maximum C, defensive argument copying, archive byte preservation, bounded projection, metadata-damage refusal and never-bound disconnect/reopen. These use `fake-indexeddb` and are not claimed as native browser proof. Existing protocol/deterministic tests remain unchanged.

## Differences, limits and remaining work

Production uses individual native records and asynchronous transactions; the model uses a synchronous serial graph. Production retains one current discovery scalar record plus per-artifact pass markers, rather than historical generation graphs. Same-target obligations are retained; stale generations cannot commit. Projection is incrementally reduced from verified summaries during bounded receive; model snapshots replay the full corpus. Representative traces compare semantic state after every committed transition, normalizing only store keys, default abstract provider and set ordering.

Browser tests prove the exercised transaction/connection/document-reload behavior. They do not prove physical power loss, hardware flush, browser-process/OS crashes, eviction, disk corruption/quota exhaustion, actual mobile scheduling, Firefox/Safari or every interleaving. Chrome mobile is Pixel 7 emulation on Windows. Strict durability is a request, not universal storage survival. Publication proofs are abstract byte confirmations/caller failure injection: real provider read-back, eventual visibility, authorization/account identity, create retry handles and unchanged-content indicators remain unproven. No IndexedDB incompatibility or SPEC issue was found.

Before provider integration: implement and test awaited provider-independent orchestration against this boundary, including error persistence/cancellation, omitted-reference reconciliation and retry opportunities; define durable adapter creation/retry metadata before any create relying on it; complete the SPEC authorization/scope/cross-client proof gates; then implement provider-specific descriptor/bootstrap, pagination, bounded reads, verified publication/read-back and error classification. OAuth/Drive, final synchronization UI, full corpus transfer/adoption and import/restore remain separately scoped. Local runtime/lifecycle platform proof limits from the prior report remain.
