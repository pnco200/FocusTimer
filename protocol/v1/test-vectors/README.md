# Portable v1 conformance vectors

`manifest.json` is ordinary UTF-8 JSON, without a BOM. It is fixture data, not implementation source. No particular programming language, JSON library, local database or transport API is required to consume it. The intentionally large exact-byte boundary entries are literal wire fixtures, so implementations do not need a shared fixture generator or padding convention.

The top-level `format` is `focus-timer-protocol-v1-conformance-vectors` and `version` is 1. Arrays contain named cases; case names are unique within an array. Numeric JSON fixture metadata is exact within the protocol's safe integer range. Do not confuse manifest metadata with a nested wire input's original numeric tokens.

## Wire inputs

Each `wire` case has `name`, `kind` (`session`, `descriptor`, `operation` or `segment`), and exactly one of:

- `raw`: a JSON string whose decoded scalar text is the exact wire text. Encode that text in UTF-8 without adding a BOM, newline or normalization.
- `hex`: lowercase pairs of hexadecimal ASCII characters encoding exact bytes, including deliberately invalid UTF-8 inputs. Decode pairs directly; do not UTF-8 encode the hex characters themselves.

`expected` is `valid`, `malformed`, `unsupported` or `integrity`. All currently standalone cases are `valid`, `malformed` or `unsupported`: immutable integrity conflicts need registry context and therefore appear in `identity`. A `valid` case includes `value`, the expected parsed object. Compare scalar strings and numeric values exactly while ignoring object member order. JSON escape spelling in `raw` is deliberately retained inside the string; using a permissive parser before the strict validator loses the evidence needed to reject duplicate fields or nonconforming number tokens.

The suite isolates defect classes except where they imply the same safe class. It does not prescribe a new precedence for multiple unrelated defects. Protocol/schema/name selectors with a known integer/string type but unsupported value differ from malformed wrong-type selectors. An unknown nested protocol version is unsupported even when the enclosing v1 version differs. A repeated opId *inside* a segment is malformed even if the two operations are semantically equal or conflict; a repeated accepted identity *across* valid artifacts is checked by the registry rules.

Boundary cases include exactly 1,048,576-byte descriptor/segment inputs, one byte over, 1,000/1,001 operations, maximum exact safe counter, maximum duration, 120/121 supplementary scalars, Gregorian extremes and exact timestamp grammar. Positive sessions intentionally include reversed/equal wall times and focus exceeding wall-clock span.

## Reducers

Each `reducers` case has `operations` and `expected`:

| Expected field | Meaning |
| --- | --- |
| `entities` | Complete visible FocusSession payloads, sorted by canonical entity ID ascending. |
| `tombstones` | Terminally deleted entity UUIDs, sorted ascending. |
| `highWater` | Maximum accepted counter, or zero for the empty set. |

Each fixture uses one dataset. These arrays may deliberately repeat equal operations. Feed the same list in arbitrary permutations, in differently sized/ordered batches and in repeated passes; every result must match. Regrouping may not put a repeated opId inside a wire segment, because the wire profile disallows that while the operation-set model permits duplicate delivery. The 2,000-session replay case includes 400 retained tombstones and greater-counter edits that cannot revive them. It tests 2,800 operations, 1,600 visible sessions and high-water 12,000.

## Immutable identity and ordering

Each `identity` case has `kind`, `first`, `second` and `expected`. The artifacts use the same raw/hex convention as wire cases and are individually valid. Accept `first` into an initially empty immutable registry; then compare/accept `second` with the same identity. `equal` means an idempotent duplicate; `integrity` means conflicting content with no replacement/partial acceptance. For operation cases compare **parsed fields and values**. For segment cases compare **exact complete bytes**. Equivalent whitespace/escapes/member ordering therefore can pass operation equality and still fail segment equality. These vectors do not authorize ignoring any defined operation member.

Each `ordering` case contains `values` in arbitrary order and `expected` ascending UUIDs. Compare unsigned RFC/network bytes, never platform mixed-endian `Guid` storage, signed bytes or locale collation.

## Resource-only cases

`resources` exercises the generic strict JSON container-depth guard separately from closed-shape validation. `raw`, `actualContainerDepth`, `maximumContainerDepth` and `expected` (`within-limit` or `malformed`) describe the depth rule only. A full v1 artifact cannot legally reach depth 16 because its closed shapes are shallow; a deeply nested array is still malformed as a complete segment even when the depth is within the resource bound. Corresponding full-artifact rejections appear in `wire`.

## Delivery and high-water sequences

`deliveries` contains physical-artifact fixtures: `artifacts` gives a unique local test `reference` plus raw/hex bytes, and `passes` gives lists of discovered references. References are opaque fixture locators, never protocol identity. Accept every referenced artifact under normal whole-segment/identity rules. Duplicate references and distinct references carrying identical segment bytes must be safe. `expected` gives the final compact reducer projection, or `expectedAfterPass` gives that projection after each pass. A completed pass before a delayed artifact appears cannot justify a permanent discovery frontier.

`lamport` contains `initialHighWater` and ordered `steps`. `accept` incorporates the supplied valid operation without allocating a local version; `local` allocates the next counter or returns `expectedError`; `restart`, `rotate-writer` and `rebuild-projection` must retain the dataset high-water. `expectedCounter` specifies a successful local allocation and `expectedHighWater` specifies the durable high-water after each step. These fixtures describe only clock semantics; full commands still require atomic domain/operation/outbox/clock persistence. Duplicate delivery, losing edits, restart and rotation cannot lower or gratuitously increment the counter.

The JavaScript consumer runs these steps against `MemoryStore` and `TransactionalRepository`, rather than retaining a separate arithmetic clock. It initializes the durable clock from `initialHighWater` in an explicit fixture-only transaction; a short retained history does not imply a lower initial clock. It accepts each supplied remote operation through a valid one-operation segment and `receive()`, allocates local versions through real active-session Finish commands, reopens a new repository over the same store for `restart`, and calls `rotateWriter()` with a distinct writer ID for rotation. It checks the fixture's expected durable clock after every transition, retained state across reopening/rotation, and atomic operation/outbox/domain results or an intact failed Finish. These are modeled storage lifecycle checks, not proof of production database durability.

The repository has no standalone projection-rebuild API. For `rebuild-projection`, the JavaScript harness discards only its materialized projection caches in a fixture transaction and redelivers a retained segment through `receive()`. The production receive path rebuilds the projection from the complete retained operation registry; the harness checks the prior projection, operation registry, outbox and expected durable clock survive. No new synchronization mutation or version is allocated.

Transaction crashes, binding changes, interrupted enumeration and competing workers additionally require invariant tests against the local simulation. These JSON fixtures intentionally avoid encoding any platform-specific repository or transport API.
