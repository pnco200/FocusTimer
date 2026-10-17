# Focus Timer Sync Protocol v1

This is the language-neutral normative protocol reference derived from `SPEC.md` Draft v3, especially §§9–18, 21–22, 26, 30–31 and 34–35. `SPEC.md` is authoritative if a transcription differs. MUST, MUST NOT and MAY express requirements, prohibitions and permissions. Local store layouts and transport API names are not wire formats.

## 1. Scope and identity

v1 synchronizes completed FocusSessions, complete replacement edits and terminal deletions. Active timers, ownership, preferences, credentials and provider metadata are local only. No network clock, upload time, filename, provider object ID or UUIDv7 time participates in conflict resolution.

All protocol identifiers use canonical UUIDs. `datasetId` identifies a historical collection; `deviceId` identifies the original writer installation; `opId` identifies an immutable operation globally; `segmentId` identifies an immutable batch; a session ID identifies an entity. Fresh installations and independently running restores use a new writer identity for newly authored work. Old operations and publications retain their original identities.

Deduplication keys are `(datasetId, opId)` for operations and `(datasetId, segmentId)` for segments. The materialization key is `(datasetId, entityType, entityId)`. Neither folders nor names narrow these keys. A descriptor's validated parsed semantic identity is immutable.

## 2. Exact wire grammar

All descriptor, segment, operation and session inputs obey these rules, including values nested inside larger artifacts:

| Property | Required interpretation |
| --- | --- |
| Encoding | UTF-8 without BOM. Reject malformed/overlong encodings, encoded surrogate code points, values above U+10FFFF and unpaired JSON `\u` surrogate escapes. A paired escape denotes the corresponding scalar. |
| JSON | RFC 8259 only. Whitespace is U+0020, U+0009, U+000D or U+000A. Reject trailing data, comments and duplicate object names **after escape decoding**. |
| Integers | Each numeric token must match `0\|[1-9][0-9]*` in its entirety. Reject signs, `-0`, fractions, exponents, strings, NaN and Infinity. Check the exact decimal value against its field range before converting to a limited numeric type. |
| Required fields | Every required field exists and is non-null with its exact type. Missing, null, empty text and zero are distinct. |
| UUID | Exactly `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`, lowercase ASCII hexadecimal, version nibble 4 or 7, RFC variant nibble 8, 9, a or b. Braces, URNs, uppercase, nil/max and all other versions/variants fail. |
| Timestamp | Exactly `YYYY-MM-DDTHH:mm:ss.SSSZ`, ASCII digits, years 0001–9999. Validate Gregorian days; leap years are divisible by 4 except centuries not divisible by 400. Hour 00–23, minute/second 00–59. No offsets, leap seconds, expanded years or normalization. |
| Description | 0–120 Unicode scalar values, inclusive. Preserve exact scalar sequence; never normalize, trim or case-fold during ingestion. Combining marks each count; a supplementary character counts once. |
| Container depth | Maximum 16. The root object has depth 1; each nested object or array adds one; scalars add none. |
| Descriptor/segment bytes | Each at most 1,048,576 complete raw UTF-8 bytes, including whitespace. Reject above the limit before unbounded allocation. |
| Segment operation count | 1–1,000 inclusive. An `opId` may not repeat inside a segment, even if the repeated operation is equal. |

UUID comparison is lexicographic comparison of the 16 unsigned RFC/network-order bytes. Canonical ASCII UUID text comparison produces the same result. Platform `Guid` memory layout, signed byte comparisons and locale collation are prohibited. For example, `00000001-0000-4000-8000-000000000001` sorts before `01000000-0000-4000-8000-000000000001`, even though a mixed-endian first 32-bit field may suggest the opposite. `7fffffff-0000-4000-8000-000000000001` sorts before `80000000-0000-4000-8000-000000000001`; signed bytes must not reverse them.

There is no canonical JSON serializer. Object member order, legal whitespace and equivalent string escape spellings are irrelevant to parsed operation equality. Exact sealed segment bytes have a separate immutability rule in §6.

The JSON Schemas in `schemas/` describe parsed closed shapes with JSON Schema Draft 2020-12. They are necessary but **not sufficient** for wire conformance: ordinary JSON Schema cannot establish original numeric token spelling, duplicate decoded names, UTF-8 validity/BOM, exact byte limits, scalar-only strings, exact container depth, field-to-field identity equality or segment `opId` uniqueness. A schema engine may also implement `maxLength`/`format` incorrectly or treat `format` only as annotation. An implementation MUST perform all wire checks independently. The explicit date pattern supplies exact lexical form; actual calendar validation remains mandatory.

## 3. Closed v1 shapes

All shapes are closed: only the fields listed here are permitted. Field ordering is irrelevant.

**FocusSession:** `id` (UUID), `startedAt` (timestamp), `endedAt` (timestamp), `focusDurationMs` (integer 1–3,155,760,000,000 inclusive), `description` (scalar text). All five are required. Duration is focused time excluding pauses and is independent of wall-clock span. An end preceding its start is valid. Zero duration is invalid. Complete replacement MUST NOT infer duration, chronology or any omitted field.

**Dataset descriptor:** `application` (literal `"focus-timer"`), `protocolVersion` (integer 1), `datasetId` (UUID). All three are required. A descriptor is not a mutable device registry or segment index.

**Operation:** required envelope members `protocolVersion` (integer 1), `schemaVersion` (integer 1), `opId` (UUID), `datasetId` (UUID), `deviceId` (UUID), `entityType` (literal `"focusSession"`), `entityId` (UUID), `operation` (`"UPSERT"` or `"DELETE"`), `lamportCounter` (integer 1–9,007,199,254,740,991 inclusive). UPSERT additionally requires `payload`, a complete FocusSession whose `id` equals `entityId`. DELETE MUST have no `payload` member; a null payload is invalid. DELETE requires no prior known UPSERT.

**Segment:** `protocolVersion` (integer 1), `datasetId` (UUID), `deviceId` (UUID), `segmentId` (UUID), `operations` (bounded nonempty array). Each operation's `protocolVersion`, `datasetId` and `deviceId` equals the corresponding segment field. Each operation independently uses `schemaVersion=1`. A segment contains operations from one original writer; array order is irrelevant to reduction.

When accepting for a bound collection, the segment's dataset must equal the bound descriptor's dataset. Locators do not override identity.

## 4. Rejection classes and immutable equality

| Class | Cases and required handling |
| --- | --- |
| `malformed` | Invalid encoding/JSON, duplicate decoded names, wrong/missing/null required types, invalid lexical/range/scalar/date/UUID values, size/count/depth overflow, repeated `opId` within one segment, or envelope/payload identity mismatch. Quarantine diagnosed permanent malformed data with no partial acceptance. Retry a possibly transient incomplete read before diagnosing permanent damage. |
| `unsupported` | Unknown field, protocol version, schema version, operation name or entity type. Pause the affected synchronization; preserve local work and the artifact/reference where practical; never guess semantics or claim healthy sync. |
| `integrity` | A known immutable segment identity has different raw bytes, or a known operation identity has unequal parsed content. Stop affected automatic ingestion/publication pending deliberate repair, retaining accepted history, pending work and conflicting evidence. |

An otherwise well-typed descriptor with an `application` value different from `"focus-timer"` violates its required literal and is malformed. Unsupported selectors must have the required base type (for example, integer protocol version 2 is unsupported; null or string `"2"` is malformed). `SPEC.md` does not assign a precedence when a single input has several independent defect classes. Vectors isolate defects where necessary; any implementation must reject the complete artifact safely, without effects or a healthy result. Resource-limit rejection need not inspect unlimited future content to discover unsupported semantics.

Operation equality compares every defined member, integer values and exact scalar strings, recursively including all five payload members. It ignores object member order and equivalent escape spelling only. It does not normalize text, omit `deviceId`, compare merely `opId`, or round numbers. `UPSERT` has payload and `DELETE` has none. Equal `(datasetId, opId)` with different content is corruption, never a first-arrival winner. Different segments may carry the same equal operation.

Segment identity equality is **byte equality**, including whitespace, member/array order and escape spelling. A semantically equivalent reserialization with an existing `(datasetId, segmentId)` is an integrity fault. Descriptor identity instead uses parsed semantic equality. UUIDs/checksums do not authenticate a first-seen author's content.

## 5. Ordering, reduction and Lamport high-water

Version order is ascending numeric `lamportCounter`, then ascending unsigned network-byte `opId`. `deviceId` is not an additional tie-break. A repeated immutable identity must be checked for equality before reduction.

For a valid accepted operation set, partition by materialization key. If any DELETE exists, the key is permanently tombstoned and has no visible session, regardless of all UPSERT counters. If representative tombstone metadata is retained, choose the maximum ordered DELETE. Otherwise select the complete payload of the maximum ordered UPSERT; no operations means absence. Retain all losing operations. Restore/copy uses a fresh entity ID. A stale DELETE can defeat newer edits; an arbitrarily large later UPSERT cannot revive a deleted ID.

Union and this reduction are associative, commutative and idempotent for valid immutable identities. Delivery order, repeated passes and duplicate physical artifacts cannot affect the resulting entity values or tombstone set. Conflicting identities are not a valid operation set and MUST NOT enter this algebra.

Each replica persists one dataset high-water `C`, initially 0. Durable acceptance of **every** valid remote operation atomically persists `max(C, operation.lamportCounter)`, including losing edits and operations for tombstoned IDs. A local mutation atomically allocates `C+1`, persists it as `C`, creates a new immutable `opId` and commits its command effects/outbox membership. Shared workers allocate from the same transactional value. Duplication, projection replay, sealing and retry do not create versions. Restart, writer rotation or rebuilding must never lower C; recover at least the retained C and accepted maximum.

At `C=9,007,199,254,740,991`, remote acceptance remains valid, but a new local synchronization mutation aborts for exhaustion. Never wrap, clamp, reset or re-version old operations. The deliberate local recovery collection/Finish exception is specified in `SPEC.md` §13; the old collection/binding/history remain intact and no save is reported without its complete committed operation.

Application authoring (separate from validation/merge) validates the 120-scalar input bound, trims only U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F and U+3000 from both ends, and substitutes `Untitled session.` if empty. Received/imported text, including empty strings or surrounding whitespace, remains exact.

## 6. Atomic local commands and publication

A successful authored history mutation atomically commits its validated domain transition/winner or tombstone, immutable operation, new C and outbox membership. Finish additionally consumes the expected active identity/revision/owner and commits a repeatable completion outcome. Validate selected dataset/binding generation and stale revisions inside the transaction. Unchanged edits/repeated deletions are no-ops. An aborted transaction leaves prior durable state intact; success is reported only after commit. No network work occurs inside a local transaction.

Publication proceeds through pending operation, transactional reservation, sealed immutable segment, in-flight attempt, unknown or confirmed outcome, then exact acknowledgement. Reserve each pending operation for at most one active publication intent. Before sending, atomically persist a stable segmentId, original writer/dataset, exact final UTF-8 bytes, exact operation IDs/values, reservations and pinned target binding generation. Seal one original writer's operations and enforce the count/byte limits. A one-operation segment is allowed; later work cannot enter a sealed batch.

A lost response leaves an unknown outcome. Retry the **same segmentId, bytes, writer, membership and pinned binding**. A provider create handle must be durable before an upload relying on it. Only confirmed success or verified identical already-present content permits atomic acknowledgement. Remove only the exact publication's included outbox reservations/IDs; concurrent new operations stay pending. A stale worker or account/dataset switch cannot acknowledge or redirect another binding's work. Retain immutable operations, sealed bytes and tombstones after acknowledgement. At-least-once physical publication is sufficient.

## 7. Whole-segment receive transaction

Before accepting any operation, obtain complete bounded bytes and validate the whole artifact: encoding/tokens/names, shapes/versions, ranges/resource bounds, uniqueness and all envelope identities. Verify the bound dataset, retained segment identity/bytes, and every `(datasetId, opId)` against durable content and candidate content. No prefix may affect healthy state.

Then, in one bounded local transaction, recheck current binding, immutable segment bytes and every immutable operation against durable state. Persist accepted bytes/operations, reducer effects/tombstones, high-water, deduplication and applied processing state together. Transactional uniqueness/content checks are mandatory even after prevalidation; competing receivers cannot silently overwrite or skip a conflict. A crash leaves the entire segment unaccepted or fully applied. A valid losing operation can be accepted without changing a visible winner.

Discovered/pending/applied/quarantined state is separate from operation deduplication. Merely seeing a reference is not acceptance. Preserve pending downloads through crashes. Malformed, unsupported or conflicting artifacts never partially alter accepted history. While a binding is blocked, healthy known-local v1 mutations may accumulate pending work; automatic publication stays stopped until deliberate repair/upgrade/rebind.

## 8. Discovery, retention and status

Enumeration discovers a set of candidates. Follow opaque continuations until **explicit completion**; empty/short pages with a continuation are incomplete. Persist a checkpoint only with accepted effects or durable pending references for every covered discovery. Interruptions/rejected continuations require retry from a valid earlier point or full reconciliation. Pending, quarantined and unsupported references remain unresolved for health status.

Every discovered physical reference, including new locators claiming a known segmentId, requires comparison with original bytes or an adapter-proven unchanged-content indicator that detects byte changes. Unknown/changed indicators require bounded reads. Known references omitted from a scan require availability/integrity checking. A known cache cannot permanently bypass verification. Provider-independent tests must not assume unique names, ordered/linearizable enumeration, atomic remote/local commit or exactly-once delivery.

Repeat full paginated reconciliation to discover delayed and concurrently published older artifacts. Neither UUID time/order, modified time, filename nor maximum sequence is a permanent frontier. One complete pass is not a global linearizable snapshot. An optional changes feed requires continuous durable coverage and cannot change operation semantics.

Missing/trashed artifacts, failed reads and remote absence **never** generate FocusSession DELETE or remove accepted local history. Known corpus loss requires recovery. Retain published segments, immutable accepted operations and tombstones indefinitely; no automatic compaction/age cutoff is v1. Year-offline replay converges when the retained supported valid corpus is eventually accessible. Undetected historical loss, first-seen unauthenticated modification, revoked access and permanently withheld only copies are recovery limits, not reasons to claim convergence.

## 9. Conformance artifacts

`test-vectors/manifest.json` contains reusable UTF-8 JSON fixture data. `wire` entries name a target kind and carry **either** exact `raw` text (encode as UTF-8 without BOM) **or** exact `hex` bytes. `expected` is `valid`, `malformed`, `unsupported` or `integrity`; valid entries include the exact parsed `value`. Preserve escapes in `raw`: they are part of the nested wire text, not instructions for a permissive parser to reinterpret first.

`reducers` entries carry an operation list, including duplicate deliveries where intentional. `expected.entities` is an entity-ID-sorted list of complete visible session payloads; `expected.tombstones` is a sorted list of entity UUIDs; `expected.highWater` is the maximum counter (or zero for an empty set). These fixtures use one dataset so the compact expected lists are unambiguous. Implementations MUST additionally exercise permutations, regrouping and repeated passes. `identity` entries compare exact wire artifact pairs in an immutable registry context; `ordering` entries specify UUID order. See the fixture README for the complete interface and coverage.

Release conformance additionally requires transactional failure injection, racing reservations/acknowledgements/receivers, response loss retries, partial/delayed discovery and multi-replica convergence. Parser/schema success alone is insufficient. No protocol contradiction was found in the referenced clauses; multi-defect error precedence is deliberately left unspecified rather than inventing a new cross-platform rule.
