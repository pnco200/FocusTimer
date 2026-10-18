# Local-first web implementation report

Implemented 2026-10-17 under the separately authorized local-first web phase. `SPEC.md` was read in full before edits, the repository and C# behavior baseline were inspected, and the initial 532-test suite passed. The frozen `src/protocol/`, `src/simulation/`, protocol artifacts, original tests, `SPEC.md`, and C# source are unchanged.

## Delivered behavior

- Stopwatch start/pause/resume/finish/reset; original start and active ID survive resume; repeated start/pause are no-ops. Only running monotonic intervals count. Millisecond precision is retained locally and truncated on completion, including valid subsecond sessions. Hours never wrap at 24.
- Reset pauses before its accessible confirmation dialog. Cancelling resumes only previously running work; confirmed reset retains description and history. Finish clears active state and draft only after commit.
- Approximately five-second running checkpoints, approximately 700 ms description debounce, transition saves, best-effort owner close saves, paused reload/owner-loss recovery, and visible unsaved/error/recovery notices.
- Live-owner attachment across tabs. Followers observe the live timer without independently owning or completing it. Web Locks supply execution-lifetime evidence; transactional owner token/generation and active identity/revision fence every active write. Queued commands cannot retarget a new execution owner. Missing heartbeats never elect an owner. Deliberate recovery steals the lock and recovers paused, acknowledging potential uncheckpointed loss. With no Web Locks, explicit recovery is required.
- Completed-session history and three recent entries, specified finish/UUID order, locale-aware case-insensitive substring search, independent description/start/end/focus editing, stale-base rejection, unchanged-edit no-op, confirmed terminal deletion, and no-op unknown/repeated delete.
- Exact `bigint` totals/counts for today, Monday through today, and all time, attributed to local finish dates. Active work is excluded and all-time includes future records.
- CSV with quoting, formula protection, local timestamps, exact decimal seconds and optional reporting BOM; portable history JSON; lossless local-replica dataset archive with all immutable edits/deletes. All exports ignore search and exclude active state, preferences, and installation credentials. There are no sealed segments in this local-only implementation, so the archive contains an empty `segments` array and all operations in `unsegmentedOperations`.
- Responsive timer/history/editor, light/dark local preference, semantic controls, visible keyboard focus, native modal focus handling, Space shortcut outside text entry, persistent-storage request, manifest/icons, production offline caching, and safe service-worker update waiting.

## Architecture and changed files

| Module/files | Responsibility |
| --- | --- |
| `src/web/model.ts` | Local types, active validation/pins, history presentation order, local errors. Protocol session shape stays the existing five fields. |
| `src/web/timer.ts` | Small stopwatch with an injectable monotonic clock. Runtime anchors never enter storage or exports. Checkpoint reanchoring uses the pre-I/O sampling instant, preserving save latency. |
| `src/web/repository.ts` | Native IndexedDB transactions, schema/bootstrap, owner/revision checks, journal/projection/outbox/high-water mutation, completion receipts, stale editing, deletion, validated-journal repair/evidence, explicit new collection, counter-exhaustion recovery completion, archive export. |
| `src/web/client.ts` | Serialized local UI commands, Web Locks lifetime, BroadcastChannel observations/notifications, debounce/checkpoint opportunities, close/freeze/resume hooks and truthful errors. |
| `src/web/reporting.ts` | Exact totals/formatting, CSV/history JSON, browser download. |
| `src/web/App.tsx`, `main.tsx`, `style.css` | Responsive React application and dialogs, entry point, local theme, labels, navigation, storage/offline notices. No routing framework or state-management framework. |
| `src/web/service-worker.js`, `vite.config.ts` | Public shell-only offline cache, build-derived cache identity, all-or-failed install, waiting updates, old-cache cleanup only at activation. Static asset lookup handles `Vary: Origin`. |
| `public/manifest.webmanifest`, `icon.svg`, `icon-192.png`, `icon-512.png`, `tools/generate-icons.mjs` | Install metadata and reproducible code-generated app icons. |
| `index.html`, `tsconfig.json`, `package.json`, `package-lock.json`, `.gitignore` | Web entry, strict TS/Vite/test configuration, locked dependencies, scripts and ignored generated evidence. |
| `web-test/local.test.ts`, `e2e/app.spec.ts`, `playwright.config.ts` | Local/failure tests and real-browser production tests. |
| `README.md`, this report | Run instructions, behavior/architecture, evidence and proof limits. |

IndexedDB database `focus-timer-local-v1`, local schema version **1**, has `meta`, `collections`, `active`, `history`, `operations`, `outbox`, `receipts`, and `evidence` stores. History and operation stores have dataset/entity indexes. Completed history reads the materialized projection; it is not reconstructed on each render. The startup integrity/recovery pass uses the frozen reducer and comparator. Authored local commands use frozen validation/authoring and Lamport allocation; they are not passed through the transport simulation.

Each new history command uses one native read-write transaction with requested strict durability. Its session/tombstone, immutable operation, outbox membership, and high-water commit together. Finish also consumes the active identity/revision and writes its outcome receipt. A second or restarted Finish for that active identity returns the committed session. Unique keys prevent operation/identity overwrites. All successes wait for transaction `complete`. No transaction contains network, dialogs, timers, or unrelated asynchronous I/O.

A valid retained immutable journal can rebuild a damaged projection without minting operations; the damaged projection is retained in `evidence`. An unreadable journal/active/installation fails visibly. Explicit new-collection recovery retains original journals, projections, and metadata evidence rather than silently resetting them. There is no routine collection switch/adoption UI. Counter exhaustion has the narrow SPEC §13 atomic recovery completion into a deliberately selected new collection, leaving the original corpus intact.

## Verification

Final verification commands/results are recorded after completion below. Test evidence is generated under ignored `.artifacts/` and `test-results/`, not committed as user data.

| Check | Result |
| --- | --- |
| Original protocol/conformance/simulation tests (`npm run test:core`, also part of `npm test`) | 532 passed; frozen files unchanged. |
| Web/local tests (`npm run test:web`, also part of `npm test`) | 29 passed. |
| Production Playwright suite (`npm run test:browser`) | 33 passed: 11 scenarios across Chrome desktop, Chrome mobile viewport, and Edge desktop. The final date-control millisecond/reversed-date regression also passed in all three environments. |
| C# reference (`npm run test:reference`) | 31/31 passed, unchanged source, hidden process and isolated data. |
| TypeScript + production bundle (`npm run build`) | Passed; no compiler errors. |
| Dependency audit | Installed dependencies audited with zero known vulnerabilities after updating the test runner. |

Environment: Windows, Node **24.3.0**, Chrome **155.0.8059.80**, Edge **155.0.4283.45**. The phone tests emulate Pixel 7 on installed desktop Chrome; they are not physical Android tests.

Automated browser scenarios cover daily commands and pause exclusion; independent duration editing/unchanged dates; search-independent JSON download; deletion confirmation; actual five-second IndexedDB checkpoint and reload; live second-tab attachment; fenced takeover and returning old tab; reset cancellation/confirmation; injected quota-style transaction abort with active retention and successful retry; production service-worker offline reload plus timer/edit/export; theme, viewport fit and keyboard handling; owner-close lock release and paused attachment recovery; stale editor across tabs; simulated lifecycle suspension; and no-Web-Locks deliberate fallback. Desktop and phone screenshots were visually inspected.

Local tests additionally abort real IDB API transactions (fake-indexeddb engine) after each Finish write boundary, prove competing/restarted duplicate Finish, serialized counters, stale revision/owner, no-op/independent edits and terminal deletion, journal repair/evidence retention, unreadable-source preservation, atomic counter-exhaustion recovery, complete archive corpus, checkpoint I/O latency and throttled rendering, reversed wall clocks, Unicode scalar bounds, submillisecond truncation, exact totals beyond safe-number aggregation, CSV injection escaping, queued-command fencing, and errors surviving unrelated successful checkpoints.

## Assumptions and proof still required

1. **Physical OS sleep/hibernation:** not exercised. `performance.now()` measures live intervals without wall-clock subtraction. Browser `freeze`/`resume` uses the conservative paused-checkpoint fallback and warns about missing focus; the test dispatches lifecycle events, not real system suspension. Some OS sleep paths may deliver no lifecycle event. Continuity and fallback coverage on physical sleep are still a SPEC §§6/36 platform proof gate; the app discloses this in Data & storage. No wall-clock gap is silently added. Pause before sleeping when exact accounting matters.
2. **Power loss / real quota exhaustion / eviction:** transaction aborts and reloads were tested, including in actual Chrome/Edge IndexedDB. Sudden OS power loss, browser database corruption, hardware flush behavior, full-disk exhaustion, private-mode lifetime, and eviction were not. `durability: 'strict'` is requested but is not a universal hardware guarantee. Persistent-storage granting remains browser policy, and data clearing still deletes the only local copy unless separately exported.
3. **Mobile and other engines:** no physical Android/iOS device, Firefox, or Safari proof. Mobile tests establish responsive layout and emulated Chromium behavior. No-Web-Locks behavior was simulated. Real device lifecycle scheduling, file downloads, storage prompts, installability, accessibility assistive technology, and long background freezing require target testing.
4. **Orderly close and scheduling:** browser shutdown handlers are best effort. Recovery correctness uses the last committed checkpoint without adding closed time, even if the close handler does not run. Checkpoint/debounce intervals are opportunities, not maximum-loss promises. Web Locks lifetime/steal and normal owner close were proven in the installed desktop browsers, not every crash/OS-kill case.
5. **Updates/deployment:** offline production reload and public asset caching passed. HTTPS deployment, actual PWA install/uninstall, multi-version deployment/update while tabs remain open, browser restarts, and future schema migrations still need integration testing. Service workers wait rather than force active tab replacement; database version changes close old connections and request reload. Schema v1 has no destructive migration.
6. **Import/restore:** this phase implements reporting/history/archive **export** and local validated-journal projection repair. Portable history import, archive restore, legacy migration, deliberate adoption, and a user-facing retained-collection recovery browser are not implemented. Archive restoration must preserve original operations/tombstones, rotate the new authoring writer, and never recreate visible history as newer edits.

## Remaining before Drive integration

- Complete the physical sleep/background/lifetime, storage failure, PWA update/install, and target-device proof gates above; resolve any measured defects without changing protocol semantics.
- Add the required portable import/archive restore/adoption recovery workflows with transactional validation, tombstone-aware merge and durable job identities when that phase is authorized.
- Connect the frozen runner semantics to bounded IndexedDB sealing, inbound whole-segment acceptance, durable discovery/publication records, and binding generation checks; preserve the current operation/outbox corpus. This local slice intentionally contains no remote worker or transport adapter.
- Prove SPEC §§24/36's narrow-scope cross-client authorization and provider retry/pagination/error matrix before selecting/enabling Drive. Then separately implement explicit discovery/create/join/bind/disconnect and optional provider I/O. No Google credentials, OAuth, remote requests/UI, other transports, Android/native clients, encryption, snapshots/compaction, tags, or projects were added in this phase.
