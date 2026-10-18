# Production asynchronous synchronization orchestration

Implemented 2026-10-18 against SPEC Draft v3, the corrected deterministic runner, the sync-core implementation/review/correction reports, both IndexedDB integration reports, and the UI guidelines. Protocol v1, its validators/reducer/vectors, the deterministic implementation and C# reference are unchanged. This phase adds no provider, authorization, sync UI, timer synchronization, target transfer, or product feature.

## Architecture and execution

`src/web/sync-runner.ts` exports `SyncRunner(remoteRepository, transport)`. `run({signal?, maxPages?, maxPublications?})` executes one opportunity and returns `RemoteRepository.status()`. Limits default to Infinity and accept nonnegative safe integers. Concurrent calls on the same runner share its current execution; its first call's options govern that execution. Independent instances/connections remain protected by native repository transactions, membership reservations and binding fences.

The runner awaits the production `RemoteRepository` methods. It neither imports `MemoryStore` nor implements a second publication, receive, reducer or status state machine. Network work occurs between completed repository calls, never inside IndexedDB transactions. The execution is:

1. Capture/assert the binding and begin/resume its persisted pass. Fetch bounded complete descriptor bytes, parse with the unchanged validator, and verify exact dataset/descriptor identity.
2. Drain persisted pending downloads before requesting another listing page. Resume reserved/sealed/in-flight/unknown publications, or acknowledge a confirmed publication without uploading again. Descriptor validation and blocked-binding checks precede this work.
3. Continue the durable discovery checkpoint through explicit completion. An empty continued page remains incomplete. Commit every page's pending references with its checkpoint before reading. A rejected cursor permits one full restart per invocation; another rejection ends the opportunity for later retry. Restart preserves pending/known content.
4. Read all outstanding discoveries and recheck known references omitted from the scan. Every object read requests the normative byte bound and must affirm complete transfer. The repository validates the entire segment and commits receive atomically; no prefix is accepted.
5. Reserve eligible local work, seal exact bytes, prepare and persist creation identities, attempt publication, require exact affirmative confirmation, then acknowledge exact membership. All reservations for this opportunity are collected before fresh uploads. With resumed uploads, a snapshot of previously unreserved operation IDs supplies the eligibility cutoff. Commands authored during any upload remain pending for a later run.
6. Ask the repository to complete the pass and derive status from its durable conditions. Bounded page exits also clear `inProgress` through `completePass`; incomplete discovery cannot become Synced. A later completed pass starts another full scan to discover delayed/concurrent content.

`RemoteRepository` adds `retainRetryHandle`, `pendingOperationIds`, an optional reservation membership filter, and a bounded known-original lookup for oversized-content diagnosis. `retryHandle` is an optional opaque string in existing schema-3 publication records. The first committed handle wins; concurrently prepared losing handles are unused. Reopening audits the field; legacy records without it remain valid and acquire one before their next upload. No schema/wire version or store change is required. Handles, bindings and checkpoints remain excluded from archives.

Independent review found a production composition gap: a competing runner's diagnosed error could coexist with another completion setting `reconciled`, producing metadata rejected by startup audit. `completePass` now requires no retained error/block. A stale page callback does not overwrite the concurrent pass with a scheduling error. Two independent-connection tests prove successful reopen after both stale-page and concurrent-authorization interleavings.

## Byte transport contract

`src/web/sync-transport.ts` defines the complete interface for an already selected, bootstrapped binding:

| Method | Contract |
| --- | --- |
| `readDescriptor(pin, {maxBytes, signal})` | Complete bounded bytes for the pinned descriptor/account/target. Incomplete transfer throws retryable. |
| `enumerate(pin, continuation, {signal})` | Opaque continuation, reference array and explicit `complete`. No snapshot, order, uniqueness or immediate visibility guarantee. |
| `read(pin, reference, {maxBytes, signal})` | Bounded bytes plus affirmative complete-transfer flag. Oversize may be reported by typed byte-length evidence without returning the body. |
| `preparePublication(pin, {segmentId}, {signal})` | Allocate/derive an opaque creation identity only; it must publish no content. The runner persists the winning handle before create. |
| `publish(pin, {segmentId, bytes, retryHandle}, {signal})` | Reuse the durable handle and exact sealed bytes. Return verified `confirmed`/`already-present`, exact segment ID/bytes and optional verified physical references. An ordinary create/conflict response alone cannot confirm. |

`TransportError` distinguishes retryable/unknown, authorization, access, missing dataset/object, invalid continuation, malformed, unsupported and integrity outcomes. Arbitrary adapter exceptions become a generic retryable failure without copying potentially sensitive messages. Typed errors must themselves exclude credentials/private history. A missing/inaccessible root never triggers recreation. Initial remote candidate discovery, deliberate bootstrap creation, account authorization and target transfer are explicit workflows outside this pass; descriptor access is the bootstrap verification needed here.

At-least-once publication is sufficient. There are no generic provider paths, scope names, file/folder identifiers, OAuth fields, unique-name assumptions, multi-object atomicity, permanent cursors or unproven unchanged-content shortcuts. Provider allocation can require a network call; losing its response before handle persistence is harmless because preparation cannot create content. An adapter must prove that its retained handle supports safe repeated creates/read-back after an unknown upload outcome.

## Cancellation, restart and failures

The runner checks cancellation after awaited operations and passes the signal to transport calls. A cooperating adapter can abort its request; an adapter that ignores the signal may keep that await outstanding until it settles. The runner does not assume that abort prevented provider acceptance. Once an attempt is durable, an interrupted/lost network result becomes unknown. A destroyed execution may instead leave in-flight, which is equally unresolved and retried using retained identity/bytes/handle. No late callback is allowed to confirm/receive under a stale binding.

Cancellation never rolls back a committed transaction. A cancellation immediately after reservation, seal, retry-handle persistence, confirmation or receive retains that exact committed fact. Confirmed-but-unacknowledged work resumes acknowledgement; it does not require another publication. Cancellation after read but before receive leaves a durable pending reference and no accepted operation. Error persistence deliberately ignores the cancelled signal so a surviving execution can record retry state. Abrupt document destruction can skip error persistence entirely; durable obligations still suffice to resume. No correctness depends on unload events.

Malformed/unsupported/integrity artifact failures retain bounded evidence through `artifactFailure`; known original bytes remain preserved. Oversized changed known objects are integrity faults. Incomplete/truncated reads remain retryable without quarantine. Missing known objects/access/root failures retain local operations and block as appropriate; absence creates no domain DELETE. Descriptor/publication/provider failures are persisted with `runFailure`. Stale generations cannot persist failure into a new binding.

Native storage errors escape to the caller. They are not interpreted as remote corruption, swallowed as successful status, or followed by fabricated quarantine. If failure persistence itself fails, that storage failure also escapes. Existing persisted in-progress/in-flight state is safe to resume. The caller remains responsible for displaying a local-save failure and scheduling a later opportunity; no scheduler or sync UI is installed in this phase.

## End-to-end results and evidence boundaries

`test-support/async-transport.ts` is test-only. Each transport method yields asynchronously and can hold a precise boundary. It supports delayed visibility/readability, reverse and duplicate delivery, duplicate physical publication, pagination/empty continued/partial pages, rejected continuations, transient errors, accepted publication response loss, unavailable known objects, immutable byte mutation, malformed/unsupported content and authorization/access/root errors. Confirmation checks presently readable stored bytes after any acceptance barrier; it cannot simply echo an unavailable upload as success. Non-deterministic prepared handles exercise first-committed-handle races. It is absent from the production application dependency graph and generated assets.

The engine integration uses the production runner and production IndexedDB request/transaction code through `fake-indexeddb`, with independent databases and distinct writers. Two replicas independently create, edit and delete offline; the transport duplicates/reorders pages and physical publications, delays visibility, loses an accepted upload response, and both repositories close/reopen. After later full passes, both retain the exact union of **8 operations**, **2 visible sessions**, **2 tombstones**, high-water **4**, no pending downloads/outbox entries or unacknowledged publications, and **Synced** status. The lost upload retries the same ID, bytes and handle with no identity reallocation.

The native browser integration uses two actual IndexedDB databases, the production runner and an HTTP byte transport. Playwright-owned storage outlives destroyed documents, so reload discards the client execution while remote accepted bytes survive. Its offline shared-history scenario produces the exact union of **8 operations**, **2 visible sessions**, **2 tombstones**, high-water **5**, empty outboxes, applied discovered artifacts, acknowledged own publications and **Synced** on both replicas. It includes a terminal delete defeating the other replica's offline edit, empty continued pages, reversed/duplicate references, lost accepted-upload response, and reloads of both replicas.

Native reload tests also stop after reservation/seal/confirmation, before acknowledgement, after reference persistence, and after remote read before receive. Other tests reload while actual pagination/read/publication fetches are outstanding. Engine cancellation tests cover those boundaries plus pre-acceptance upload cancellation, creation-identity allocation before persistence, concurrent handle allocation, stale generation after provider acceptance, reference-free confirmation coverage, wrong confirmation bytes, omitted/missing/changed/oversized known content and local receive/confirm/unknown/failure transaction aborts.

## Verification

All requested suites and the production build passed after implementation and review.

| Command | Result |
| --- | --- |
| `npm run test:core` | 532/532 passed. |
| `npm run test:web` | 176/176 passed across nine files. |
| `npm run test:async-runner` | 41/41 passed across two files. Included in the aggregate web count. |
| `npm run test:browser` | 228/228 passed in 2.9 minutes. Nine new scenarios in each of three projects (27 new native checks). |
| `npm run test:reference` | 31/31 passed; unchanged reference rebuilt. |
| `npm run build` | Passed: TypeScript check and Vite production build, 47 application modules. |
| `git diff --check` | Passed. Generated assets contain no adversarial transport, test harness or MemoryStore. |

Browser projects are installed Chrome desktop, Chrome Pixel 7 emulation and Edge desktop on Windows. The test harness is separate from application pages and absent from `dist`. Browser/server tests require host execution because the command sandbox does not support their communicating processes. No live provider/account/user browser profile is used.

## Differences from the deterministic runner

- Every repository operation now awaits actual transaction completion. Native storage failures propagate; artificial `InjectedFailure` is unnecessary.
- Durable downloads/publications resume before further enumeration, preventing a failing continuation from starving already committed obligations. Fresh publication still follows complete discovery/rechecks.
- A durable opaque creation identity separates preparation from content publication. The deterministic model did not need provider allocation metadata.
- Opportunity membership is fixed before uploads; upload-time authoring waits for a later run. This changes scheduling, never operation identity/clock, sealed content or acknowledgement membership.
- Bounds/complete transfer are explicit transport arguments/results, cancellation is conservative, early bounded exits end pass activity, and competing-page completion cannot poison reopen metadata.
- There is no new status algorithm: the existing shared `remoteStatus`, confirmation validation, coverage rules, reservation/sealing helpers and repository checks remain authoritative.

## Remaining assumptions and exact Drive proof questions

Proven now: the exercised production IndexedDB transitions compose with real asynchronous orchestration, reload/cancellation, exact retries, stale binding fences and two-replica convergence. Engine tests supplement actual browser evidence; they do not replace it. The finite scenarios do not prove every possible interleaving.

Still abstract: a transport truthfully verifies bytes/account/target, enforces bounds during transfer, eventually exposes retained reachable valid content, preserves immutable objects and creation identities, and classifies provider ambiguity accurately. Synced means no known pending work at the last completed pass; it is not a linearizable global snapshot or evidence another replica received anything. Permanent withholding/removal of the only remote copy, unknown historical deletion or unauthenticated first-seen tampering cannot be solved by this runner.

Real Google Drive integration must answer these questions with provider evidence before enabling it:

1. Under the selected narrow scope, can each planned official web/native OAuth registration discover/read every other's descriptor and segments, publish mutually readable content, and rejoin after reinstall/reconnect without unrelated Drive access? Sharing a Cloud project or root locator alone is insufficient. If this fails, stop and explicitly revisit the transport/scope decision.
2. Can simultaneous explicit bootstrap creations and incomplete/ambiguous/duplicate roots be surfaced without first-result election? Are creation intents/generated IDs durable before create, and is an incomplete tree never treated as a bound empty dataset?
3. Does the actual generated-ID create path retry exactly the retained ID/content after acceptance with response loss? Does every conflict/409 path verify descriptor/segment identity and exact readable bytes before affirmative confirmation? What happens when that read-back is delayed, inaccessible, changed or interrupted?
4. Does real paginated enumeration consume short/empty continued pages, preserve incomplete-search status, restart rejected continuations safely, and discover appended/delayed objects on later full passes? Can all known omitted objects be checked without treating absence as DELETE?
5. Are descriptor/object transfers bounded before unbounded allocation, with truncation distinguished from diagnosed malformed content? Can cached provider content indicators actually detect byte changes, including changes under a known physical reference? Until proven, reread bytes.
6. Do expiration, revocation, wrong account, permission denial, missing/inaccessible root and service/quota failures map conservatively to these typed failures while retaining local work and preventing wrong-target acknowledgement or automatic recreation?
7. Are authorization tokens transient/appropriately protected and excluded from transport metadata persistence, diagnostics, URLs, archives, application caches and service-worker responses? Does reconnect remain user-driven where required, without promising closed-PWA progress?
8. What actual listing/read/create costs and retry/backoff/jitter behavior support the retained many-year corpus? Scheduling must remain bounded without using timestamps/names as permanent discovery frontiers or weakening v1 retention.

Actual OS/browser-process failure, physical power loss/disk flush, eviction, quota exhaustion, physical mobile scheduling, Safari/Firefox, and prior stopwatch suspend/clock proof remain platform obligations. Strict IndexedDB durability is a request, not universal survival. This phase stops before Drive/OAuth; it supplies the production orchestration boundary on which those separately evidenced integrations can depend.
