# Google Drive bootstrap and root-discovery evidence

Reviewed 2026-10-18. This is an isolated feasibility analysis for SPEC §§19, 22–24 and 36, read alongside the synchronization implementation/review/correction reports, production IndexedDB persistence reports, asynchronous runner report, `src/web/sync-transport.ts`, and UI guidelines. It adds no production adapter, persistence schema, authorization flow or final sync UI.

**Gate status: documented mechanisms are plausible; official-client live proof is outstanding.** No authenticated Drive operation was performed for this analysis. All sequences below are proposed experiments or safety requirements, not observations of successful Google requests. The narrow-scope cross-client gate must pass before bootstrap can be called feasible for Focus Timer. An existing connected Drive integration uses its own OAuth application and cannot supply that proof.

## Current authoritative provider evidence

The Google documentation below was retrieved on 2026-10-18. These are the exact provider behaviors used in this analysis; consequences and application rules in subsequent sections are deductions, not additional Google guarantees.

| Source | Documented behavior relied upon | Limit of the evidence |
| --- | --- | --- |
| [Files resource](https://developers.google.com/workspace/drive/api/reference/rest/v3/files) | File names need not be unique within a folder; file IDs identify resources. `parents` describes the containing folder. `properties` is visible to apps with access; `appProperties` is private to the requesting app. | A label/property is not an authorization grant, immutable logical identity, unique key or authenticity proof. |
| [Generate file IDs](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/generateIds) | `GET /drive/v3/files/generateIds` returns IDs for the requesting user, suitable for later creation; `space=drive`, `type=files`, and `drive.file` are supported. | Generating IDs does not publish descriptor bytes or reserve an account-global dataset identity. It does not prove another OAuth client can use/read the result. |
| [Create and manage files](https://developers.google.com/workspace/drive/api/guides/create-file) | A generated ID can be passed in `files.create` metadata. Retrying a successful create with that ID yields HTTP 409 and avoids another physical file. Folders support generated IDs. | A 409 does not attest to descriptor content, expected parent, dataset identity or current readability. Distinct IDs still create distinct resources. |
| [Create and populate folders](https://developers.google.com/workspace/drive/api/guides/folder) | Folders are metadata-only files with MIME type `application/vnd.google-apps.folder`. Creation can specify a parent folder ID. | Separate root, child-folder and descriptor requests have no collective commit in this documented flow. |
| [Search for files and folders](https://developers.google.com/workspace/drive/api/guides/search-files) and [custom properties](https://developers.google.com/workspace/drive/api/guides/properties) | Queries support parent membership and custom-property key/value matches. Public `properties` and private `appProperties` have different visibility. | Search only finds authorized, matching resources. Public metadata does not make file content public or bypass `drive.file`. Cross-client private-property behavior remains part of authorization testing. |
| [files.list](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/list) | Continue using `nextPageToken`; discard a rejected token and restart. The service can return fewer than `pageSize`; `incompleteSearch` means some results are absent. Added/removed files can change expected results. | A completed finite scan is not an atomic account-wide absence or singleton certificate. The reviewed v3 wording does not explicitly promise an observable empty continued page; the experiment must tolerate it without claiming it occurred. |
| [Upload file data](https://developers.google.com/workspace/drive/api/guides/manage-uploads) | Multipart upload carries metadata and complete content in one request for small files. | It does not atomically create a folder tree. Client response loss still requires same-ID retry and byte read-back. |

## Representation and retained local authority

The proposed experiment uses the SPEC representation: one visible root folder, one `segments` child folder, and one complete immutable `dataset.json` blob. Protocol descriptor content remains exactly `application`, `protocolVersion`, and `datasetId`. It gains no provider IDs, readiness flag or segment list.

A **local bootstrap intent** is distinct from a production sync binding. It retains account context, expected local dataset/descriptor, exact descriptor UTF-8 bytes, a bootstrap-attempt identity, root/segments-folder/descriptor generated IDs, intended parent relationships, and each request's unresolved/verified state. Persist every retained ID before the first create using it. Persist both the intent and its selected IDs transactionally so competing tabs cannot each treat their own allocation as the winning local attempt. Losing allocations publish no content and may remain unused. Tokens are never intent fields.

Use public custom `properties` only as candidate hints for this experiment, for example application=`focus-timer`, role=`dataset-root`/`segments`/`descriptor`, dataset UUID and bootstrap-attempt UUID. They remain adapter metadata, not new wire fields. Metadata may be copied, edited or absent; validate actual descriptor bytes and resource relationships. Do not assume `appProperties` is a portable cross-client rendezvous. Neither property form expands the token's authorized file set.

The eventual local locator contains all three stable Drive IDs plus the pinned account and validated dataset identity. An opaque encoded locator is sufficient for the generic contract. Keep it in local adapter metadata and outside protocol artifacts and portable archives. Retaining a locator reduces dependence on search; it never grants access by itself.

## Proposed durable bootstrap experiment

1. Check the authorized account and exact selected scope. Enumerate candidate roots completely, retaining incomplete/ambiguous outcomes. This is information for an explicit create/join choice; zero returned roots is not permission for automatic creation.
2. After a deliberate choice to create a remote representation of this local dataset, commit the bootstrap intent. Request three generated IDs with `space=drive&type=files`, then atomically retain the selected triple before any resource creation. A lost allocation response is harmless: no dataset content has been created.
3. Create the root at its retained ID with folder MIME type and candidate hints. If its response is lost, retry that ID. On success or 409, read back metadata and verify expected ID, folder type, non-trashed state and expected placement. Do not infer confirmation from 409.
4. Create the segments folder at its retained ID, with `parents=[rootId]`; apply the same retry/read-back rule. A missing/inaccessible parent stops this attempt. It does not allocate a replacement root.
5. Create the descriptor **last**, with its retained ID, `parents=[rootId]`, `application/json`, and exact already-retained complete bytes in one multipart request. Never create an empty descriptor and patch it. After success, lost response or conflict, read complete bounded bytes; compare exact bytes for the creator's retained intent and parse/verify logical descriptor identity. Conflict with different bytes or identity is an integrity fault.
6. Read all retained resources again. Verify folder types, parent edges, readable complete descriptor and expected dataset. Enumerate the root's children to surface all currently discoverable competing descriptor/folder candidates, and recheck root discovery for known conflicts. An incomplete scan prevents a claim that discovery completed. This detects the finite observed state; it cannot rule out a concurrent hidden root.
7. Bind only the exact explicitly approved locator after those checks, with the account/dataset/generation committed together. A candidate being first or sole in a scan is never the reason to bind. This phase does not call the production binding or runner methods.

The descriptor-last sequence makes common interruption boundaries detectable: root only, root plus segments folder, missing/unreadable descriptor, or wrong placement are incomplete. The descriptor is an immutable identity artifact, not a mutable commit manifest. Its presence alone is never sufficient: deletion/movement after its creation can make the representation incomplete. No automatic cleanup, overwrite, alternative-ID retry or new bootstrap follows an ambiguous outcome.

Retries preserve the exact intent. Metadata-only folders have no byte payload, so validate their resource identity and necessary type/parent relationships; names remain labels. Descriptor validation additionally requires exact retained bytes for this create attempt. After a known-object read failure, preserve the unresolved state even if listing omits it.

## Discovery and reconnect outcomes

Keep discovery completeness separate from candidate validity and from user selection. Deduplicate returned references only by physical file ID, not name, property, UUID, or enumeration order. A new client without retained component IDs must gather every visible relevant child candidate and validate contents/relationships; a filename or role-property match cannot select one descriptor or segments folder.

| Observed state | Required interpretation and action |
| --- | --- |
| No candidates; scan interrupted, rejected or `incompleteSearch=true` | Discovery unresolved. Retry/full reconciliation; never report “no existing history” or create automatically. |
| No candidates after a completed scan | No authorized matching roots observed in that pass. Account, scope, removed hints, delayed visibility or actual absence remain possible. Offer only an explicit recovery/create decision; do not certify global absence. |
| One structurally valid candidate | A join option with validated identity and observed validity. Require deliberate selection; do not auto-bind because the scan returned one. |
| Multiple roots with different dataset IDs | Separate histories. Preserve and surface all observed candidates; no automatic merge, oldest/newest/UUID/name election or first-result choice. |
| Multiple root IDs with the same dataset ID | Possible duplicate corpus copies. Selection/consolidation requires deliberate full-content reconciliation and preservation of the union/archive. Matching descriptor bytes do not prove identical segments. |
| Root without a valid readable descriptor or segments folder | Incomplete/unreadable candidate. Do not treat it as a new empty history. An existing durable intent may retry its own exact IDs; another client cannot invent missing components for it. |
| Multiple valid descriptors or segment folders inside a root | Ambiguous component mapping, even if names/properties agree. Retain the alternatives and require explicit reconciliation; no first-child election. |
| Unsupported or malformed descriptor | Preserve the locator and bounded diagnostic evidence. Do not bind or replace with an empty descriptor. |
| Known pinned locator absent from a search | Directly validate the pinned IDs. An omitted list result does not erase a binding or authorize replacement. |
| Known root or descriptor returns 404/403 | Missing/inaccessible remains ambiguous at the provider boundary. Preserve local history/outbox and stop automatic publication; no automatic recreation. |

After ordinary reconnect, retain the existing locator, verify the account and all required resources, and revalidate descriptor identity before resuming. Authorization renewal cannot silently redirect to another account or to a newly found root. A chosen locator must remain fixed throughout any outstanding bootstrap/read request.

After reinstall or local locator loss, search is recovery candidate discovery, conditional on the unresolved official-client `drive.file` authorization gate. A separately retained non-secret root locator may help locate a candidate, but is neither authorization nor proof of its contents. A portable dataset archive intentionally lacks provider locators; its immutable corpus can validate/recover history but cannot recreate the old account binding automatically. Loss of unpublished local intent/content cannot be repaired by a root search.

A new client cannot prove that historical segments were never removed, that all first-seen bytes are authentic, or that a descriptor plus empty segments folder represents an originally empty history. Structural validation detects observed incompleteness; retained known identities detect known loss. Those are different from complete historical recovery.

## Concurrent bootstrap: finite safety and singleton limits

The provider's generated-ID mechanism solves **one retained intent's idempotent resource creation**. It does not solve independent clients agreeing which dataset to create.

| Concurrency case | Safe result / remaining limit |
| --- | --- |
| Tabs share one local store and one dataset | A transactional winning intent/triple prevents duplicate local attempts. Web Locks may coordinate work but are not the durable uniqueness authority. |
| Two clients deliberately share the same retained IDs, bytes and account | Same-ID retry should converge on the same physical resources under the documented create behavior; every response still needs read-back. Cross-client use of those IDs and file access requires live official-client proof. |
| Same retained IDs, different descriptor bytes or placement | Read-back mismatch stops the attempt. A 409 does not elect either client's desired content as correct. |
| Same dataset UUID, independently allocated Drive IDs | Two remote copies can exist. Discover/reconcile both; matching dataset UUID does not authorize choosing one. |
| Different dataset UUIDs and independent IDs | Two distinct histories can exist. Later discovery surfaces both; neither automatically becomes “the shared history.” |

An adversarial schedule exposes the limit: A and B each finish a scan observing zero roots; each has a distinct deliberate local bootstrap intent; each creates its own tree; each can temporarily observe only its own tree during a follow-up scan. Additional scans or waiting a fixed interval cannot prove another intent does not exist. A deterministic folder name, timestamp/UUID ranking, or marker property cannot provide a conditional create/lock. This conclusion follows from the available operations and the contract's explicit lack of atomic/snapshot discovery; it is not a claim that every Drive scan is delayed.

The safe product contract is therefore explicit creation/selection, durable same-intent retry, no singleton claim, and surfacing all discovered conflicts. Later discovery of another root never silently changes the selected locator. Same-dataset copies need deliberate corpus reconciliation; different datasets remain separate. No independent client is allowed to automatically join its own sole result on the premise that it won a global race.

If the requirement instead means “independent first installations must never create two physical datasets, including while neither can observe the other,” this Drive design cannot establish that guarantee without an additional shared coordination authority or pre-agreed shared creation identity. Neither is introduced here. SPEC §19 already permits concurrent distinct datasets and requires their ambiguity to be surfaced. Meeting that finite-safety requirement must not be reported as an account-global singleton proof.

## Required live evidence before approval

Use disposable synthetic data and official Focus Timer clients after the narrow-scope gate is available. Record granted scope, stable anonymized client/account labels, request phase, HTTP status/reason, retained-ID reuse, byte/identity comparisons and observed candidate sets; exclude access tokens and private history.

The minimum run must: retry lost responses at each of three creates; reopen after every durable intent/component boundary; discover each incomplete tree; discover zero/one/multiple roots and multiple components without auto-selection; run two independent stores creating same and different dataset IDs; verify exact shared-ID retry; clear a client's locator and reauthorize through a second web ID; repeat with desktop/native; move/trash/deny access to each component; append a competing root during discovery and find it in later full passes. Record actual observations separately from documented expectations. A finite successful run raises confidence in those scenarios; it does not establish a global singleton or universal visibility bound.

Until those records exist, this document supplies an experiment design and the architectural limit, not completion of the authorization/bootstrap proof gate.
