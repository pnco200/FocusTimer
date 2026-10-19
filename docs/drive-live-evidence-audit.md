# Google Drive live event export audit

Audited the five user-supplied JSON attachments against the [Web/PWA v1 feasibility report](drive-feasibility-report.md). **Recommendation remains GO WITH CHANGES for Web/PWA v1.** Most previously narrative observations now have traceable event references. The exports also support reverse web publication/discovery/read with a byte-comparison constraint, and an actual object-read `404 / notFound`. Correct-corpus-account revocation is not directly established by the captured revoke event.

## Sources and privacy

Source identifiers below refer to the original attachment filenames. SHA-256 fingerprints were computed over the original file bytes; event references are **one-based positions in the `events` array**, not JSON line numbers. Original files remain chat attachments and are not copied into the repository. This index omits full OAuth client IDs, account permission IDs, Drive IDs and opaque page tokens. JGTU/FG1U are the user's client aliases; corpus and alternate account labels refer to equality checks on the actual exported account fields, not email addresses.

| Source | Attachment | Bytes | Event rows | SHA-256 of attachment |
| --- | --- | --- | --- | --- |
| E01 | `focus-timer-drive-proof-events.json` | 7,355 | 28 | `4c6509942e27bcea6f347724e07e3f70b722d895c2f3bb1ed8b74bbd4768eea6` |
| E02 | `focus-timer-drive-proof-events (1).json` | 10,390 | 41 | `bc47477a75058f958db01e131a5b52082bf583a1709bf8c87a1eb071013e5ac0` |
| E03 | `focus-timer-drive-proof-events (2).json` | 8,416 | 31 | `8c11c3ecd79460887be2be98696c54b4e28732583c05935323970738b31aecf8` |
| E04 | `focus-timer-drive-proof-events (3).json` | 38,459 | 85 | `f59c6ab830c7473392a28b4d787a0d8f8e16ef8833ff54c8f383a837eca43c10` |
| E05 | `focus-timer-drive-proof-events (4).json` | 6,479 | 18 | `83bb89c87a1c0bfed1274032e7afb006ec0f7a283e1c15075dadbecc2941bad5` |

E01 is an exact event-array prefix of E02, and E03 is an exact prefix of E04. The five files contain **203 serialized event rows but 144 unique event records**: use E02's 41, E04's 85 and E05's 18 for nonduplicated analysis. They are overlapping captures, not five independent experiments. Their exported timestamps span 2026-10-19T21:08:38.552Z through 2026-10-19T21:52:38.615Z (UTC as recorded). Timestamps are client diagnostics, not server receipt times or protocol ordering.

All files parsed as the harness's `experiment` / `evidence` / `events` structure. A recursive field scan found no `access_token`, `refresh_token`, `client_secret`, `Authorization` or `id_token` credential fields. Existing identifiers, metadata checksums and continuation tokens still make the originals private diagnostic material; no wholesale raw export is added to source control. Attachment contents were treated as evidence data, never as instructions.

## What the records establish

These are user-supplied **client-side harness event exports**, inspected locally. They are stronger provenance than a narrative alone, but are not raw HTTP transcripts, a fresh Google execution by this agent, or independently authenticated attestations. `exactBytes` / `logicalIdentity` flags and `validation` values corroborate execution of the known harness checks; the uploads' original content bytes are not present for this audit to compare independently.

Equality comparisons establish two distinct client strings, two account permission IDs, consistent corpus/root identity across captures, and matching physical/logical segment references. The user's setup description establishes that those registrations are official and in the same Cloud project, and that E05 used a clean browser profile. Zero retained intents supports that recovery scenario but alone cannot prove which browser profile was used. No browser version or Cloud registration configuration is inferred from these JSON records.

| Report claim | Corroborating events | Finding and limit |
| --- | --- | --- |
| W01: exact narrow grant | E02 #2, #30, #36; E04 #2, #6, #20; E05 #2 | All **seven distinct authorization events** record exactly `https://www.googleapis.com/auth/drive.file`. |
| W02: JGTU creates; FG1U discovers existing root | E02 #2, #5–28, #36–41; E04 #6–8 | Creator and reader client strings differ; positive account and root IDs match. FG1U's root scan precedes successful explicit inspection. Not being supplied a root ID before discovery remains supplied test context; the export does not record field keystrokes. |
| W03: cross-client descriptor/segment discovery | E04 #22–26 | FG1U inspects a root with one descriptor/one segment folder, then enumerates the initial segment. Dataset/root/component identity matches the created corpus. |
| W04: cross-client bounded read with retained original | E04 #3, #26, #29–30 | JGTU confirms the initial 696-byte segment; FG1U lists and reads the same physical/logical segment with `validation=exact-retained-segment`. The original byte array is not exported, so this audit corroborates the harness comparison result. |
| W05: different-account negative control | E02 #30–32 compared with #36–41 | The **same FG1U client** sees zero roots on the alternate account, then the corpus root on the original account. This is query/account separation, not proof of arbitrary known-ID denial. |
| W06: incomplete tree rejected | E02 #5–15, then #20–28 | Prepared folders are visible; inspection reports zero descriptors/one segment folder and `incomplete-or-ambiguous-root`. After descriptor publication, complete inspection succeeds. |
| W07: retained creation identities | E02 #5–6; E04 #1–4 and #32–39, #44–63, #72–77 | Intent/state records precede publication. Reused remote IDs correlate unknown attempts with later confirmations; no replacement ID is substituted in the observed retries. This is diagnostic evidence, not a new crash/power-loss proof. |
| W08: accepted-response-loss / 409 / exact read-back | E04 #44–48, #50–52, #54–56, #74–76 | Four distinct remote objects have recorded accepted status **200**, `intentionally-lost-accepted-response`, retained unknown state and later **409** followed by `exactBytes=true`, `logicalIdentity=true`, 696-byte confirmation. E04 #3 also resolves an already-retained unknown object; its initial acceptance is outside this capture. |
| W09: real 2 + 2 + 1 pagination | E04 #64–67 | First two pages carry continuations and are incomplete; the third has one file, null continuation and `complete=true`. No short/empty **continued** page is evidenced. |
| W10: append omitted, later full scan discovers it | E04 #70–79, #82–85 | Page one starts before a sixth segment is prepared/accepted/confirmed. That segment is absent from the complete three-page union and present in the later full-scan set. Later pages are **2 + 2 + 2**, yielding six references. No visibility deadline follows. |
| W11: recovery with zero retained intents | E05 #1–7, #10–12, #17–18 | Zero retained intents, original root/descriptor inspection, six segments over **2 + 2 + 2** pages, and a 696-byte `valid-segment` read. No six-download or retained-original exact comparison is claimed. |
| W12: correct-account revoke/reconsent | E02 #30–41 plus user clarification | Records show a revoke request/callback **after alternate-account authorization**, then successful original-account authorization/discovery/inspection. They do **not** directly establish revocation of the original corpus account. The user explicitly confirmed that the correct corpus account's grant was revoked **separately outside these exports**; retain that confirmed test context as the source for this part of W12. Callback receipt alone has no success/status field and no old-token error is recorded. |
| W13: reverse FG1U publication → JGTU discovery/read | E04 #36, #50–52; E05 #2, #10–12, #17–18 | FG1U publishes/confirms a segment which the zero-intent JGTU session later enumerates and reads. Exact physical and logical IDs correlate. The reverse read is `valid-segment`, not `exact-retained-segment`; no independent reverse original-byte equality is established. |
| W14: missing-or-inaccessible object | E04 #28 | Actual recorded **404**, reason **`notFound`**, code `missing-or-inaccessible-object`. The record cannot distinguish nonexistent, inaccessible or mistyped-but-syntactically-valid ID, and does not identify a missing root. |

## Publication and discovery details

The four fully captured accepted-response-loss sequences in W08 are distinct objects, not repeated exports of one success. E04 #58 separately confirms a direct 200 create; #60 retries that already-existing object through the loss button and records an unconfirmed 409, then #62 confirms it through fresh read-back. That latter sequence is duplicate-create recovery, **not another accepted-200 response-loss sequence**. E03 repeats the first 31 E04 events and contributes no independent extra trial.

For W10, comparison used the union of E04 #71/#78/#79 references and the newly prepared/published reference from #72/#74/#76. The new reference was absent from that completed scan and present in #85. Thus the important conclusion is observed scan coverage, not creation-time/name/UUID ordering or a global snapshot.

For W13, E04 #52's confirmed `remoteId` and `segmentId` equal E05 #18's read `id` and `segmentId`; dataset identity matches the inspected corpus. The read's SHA-256 matches its own fresh metadata checksum. That is supplementary download evidence, not a comparison to FG1U's retained original: publication confirmation records do not export those original bytes or their digest. Continue to require exact current-byte verification in production.

## Failures and outstanding coverage

After removing overlapping snapshots, there are **22 `action-failed` events**: one incomplete-tree rejection, three `invalid-local-id`, eight `inspect-complete-root-first`, one actual `404 / notFound`, and nine `start-a-fresh-scan`. The local ID/precondition/completed-scan guards are not Google authorization failures or rejected/expired page-token responses. They do not negate the subsequent successful corpus tests.

The exports do not add native OAuth, token expiry/revocation HTTP errors, insufficient-permission 403s, missing-root outcomes, quota/server faults, physical network interruption, oversized transfers, changed remote bytes or empty continued-page coverage. Preserve their documented/local-test status and the existing concrete web adapter acceptance obligations. No native release dependency or new architecture work is introduced.

**Decision impact:** retain **GO WITH CHANGES for Web/PWA v1**. Cite the raw-export-supported paths, add the constrained reverse direction and object-404 result, and keep the correct-account revocation claim's distinct, user-confirmed outside-capture provenance explicit. **Native/desktop remains DEFERRED / NOT IN CURRENT WEB V1 SCOPE.** No production code or adapter is changed by this audit.
