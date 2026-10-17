# Focus Timer — Product & Technical Specification

**Status:** Draft v2  
**Project:** Focus Timer  
**Primary implementation target:** Web / PWA  
**Existing implementation:** Windows desktop application written in C++  
**Long-term target:** Multi-client, multi-platform ecosystem using a common synchronization protocol

---

# 1. Overview

Focus Timer is a local-first application for measuring focused work sessions.

An existing Windows implementation written in C++ already exists and must be treated as the primary behavioral reference for the current product.

Focus Timer is fundamentally a **stopwatch**, not a countdown timer.

A typical session behaves as follows:

```text
User starts a session
        ↓
elapsed focus time begins increasing
        ↓
user may pause for a distraction
        ↓
paused time is not counted
        ↓
user resumes
        ↓
focus time continues accumulating
        ↓
user finishes the session
        ↓
session is added to history
```

There is no predefined duration required for a session.

The objective of this project is to:

1. Understand the existing C++ application's behavior.
2. Preserve its useful product semantics.
3. Build a modern web/PWA version.
4. Keep all timer operation local-first.
5. Add reliable multi-device synchronization of completed session history.
6. Design synchronization as a platform-independent protocol.
7. Allow future C++, Android, iOS, CLI, desktop, or other clients to participate without redesigning existing implementations.

The web application is the first client of the new architecture.

It must not become the architectural definition of Focus Timer.

---

# 2. Core product principles

## 2.1 Local-first

Focus Timer MUST function completely without:

- an account;
- internet access;
- Google authentication;
- Google Drive;
- a Focus Timer-controlled backend;
- synchronization.

A user must always be able to:

- start a session;
- pause;
- resume;
- finish a session;
- inspect history;
- edit history;
- delete history;

using only local storage.

Remote synchronization is an optional capability.

---

## 2.2 No Focus Timer-owned backend

The application MUST NOT require a server operated by the Focus Timer developer for normal functionality.

No proprietary server should be responsible for:

- user accounts;
- session storage;
- session history;
- timer execution;
- conflict resolution;
- synchronization coordination.

The first remote synchronization provider will be Google Drive.

However:

> Google Drive is only a Sync Transport. It is not the Focus Timer synchronization architecture.

---

# 3. Fundamental synchronization requirement

Synchronization must be implementation-independent and platform-independent.

Future clients may include:

```text
Web / PWA        → TypeScript
Windows desktop  → C++
Android           → Kotlin
iOS               → Swift
CLI               → arbitrary language
```

All clients must be capable of participating in the same synchronized dataset.

No client may depend on another client's private local representation.

Therefore:

```text
C++ must not understand IndexedDB.

Web must not understand the Windows application's local database.

Android must not understand browser persistence.

Google Drive must not store IndexedDB-specific or TypeScript-specific data.
```

All implementations communicate using a documented, language-neutral:

# Focus Timer Sync Protocol

---

# 4. High-level architecture

The system is divided into independent layers.

```text
┌─────────────────────────────────┐
│          Application            │
│                                 │
│ Stopwatch / History / UI        │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│          Local Store            │
│                                 │
│ Web: IndexedDB                  │
│ C++: implementation-specific    │
│ Android: SQLite/etc.            │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│     Focus Timer Sync Core       │
│                                 │
│ Protocol                        │
│ Operations                      │
│ Logical clocks                  │
│ Merge rules                     │
│ Conflict resolution             │
│ Protocol versioning             │
└────────────────┬────────────────┘
                 │
                 ▼
┌─────────────────────────────────┐
│        Sync Transport           │
│                                 │
│ v1: Google Drive                │
│ future: other providers         │
└─────────────────────────────────┘
```

Dependency direction matters.

The Sync Core MUST NOT depend directly on:

- React;
- TypeScript-specific runtime behavior;
- IndexedDB;
- browser APIs;
- Google Drive;
- Google OAuth;
- Windows APIs;
- Android APIs.

---

# 5. Existing C++ implementation

Before implementing major functionality, Codex MUST inspect the existing Windows C++ implementation.

The existing application is a:

> behavioral reference, not an architectural reference.

Codex must first produce:

```text
docs/existing-app-behavior.md
```

This document must describe at minimum:

- start behavior;
- pause behavior;
- resume behavior;
- finish behavior;
- cancellation/reset behavior;
- how focused elapsed time is calculated;
- how paused time is handled;
- session descriptions;
- history behavior;
- history editing;
- history deletion;
- persistence;
- keyboard shortcuts;
- notifications;
- startup/shutdown behavior;
- relevant desktop-specific behavior;
- visible edge cases.

Behavior must be classified as:

```text
PRESERVE

ADAPT FOR WEB

REMOVE

UNSURE
```

Desktop implementation details MUST NOT automatically be migrated.

Examples:

- native Windows timers;
- native UI toolkit architecture;
- filesystem layout;
- threads;
- Windows event-loop assumptions;
- native serialization formats;
- native notification APIs.

---

# 6. Primary web client

The first new client will be a web application installable as a PWA.

Recommended baseline:

```text
TypeScript
React
Vite
IndexedDB
Service Worker / PWA
```

Libraries may be changed when justified.

Framework abstractions MUST NOT leak into the synchronization protocol.

---

# 7. Stopwatch domain model

Focus Timer is a stopwatch.

It MUST NOT be designed around:

```text
target duration
remaining duration
countdown completion
```

Instead, the core domain concept is accumulated focused time.

A running session conceptually contains:

```text
session started
       │
       ├──── focused interval ────┐
       │                          │
       ├──── pause ───────────────┤
       │                          │
       ├──── focused interval ────┤
       │                          │
       ├──── pause ───────────────┤
       │                          │
       └──── focused interval ────┘
                                  │
                                finish
```

The final session duration is:

```text
sum(all focused intervals)
```

Paused intervals MUST NOT contribute to focus duration.

---

# 8. Local active-session state

An active stopwatch exists only on the device where it was started.

Conceptually, local active state may contain:

```json
{
  "state": "running",
  "startedAt": "...",
  "runningSince": "...",
  "accumulatedFocusMs": 1250000,
  "description": "Database study"
}
```

When paused:

```json
{
  "state": "paused",
  "startedAt": "...",
  "runningSince": null,
  "accumulatedFocusMs": 1530000,
  "description": "Database study"
}
```

Exact implementation may differ.

The important invariant is:

```text
elapsed focus time
=
previously accumulated focus time
+
current running interval
```

A rendering interval must never be the source of truth.

---

# 9. Stopwatch timing correctness

The web application MUST NOT calculate elapsed focus time by incrementing a counter once per second.

For example, this is incorrect:

```text
every 1000 ms:
    elapsed += 1 second
```

Browsers may:

- throttle background tabs;
- suspend PWAs;
- delay timers;
- put devices to sleep.

Instead, while running, elapsed time should be derived from timestamps.

Conceptually:

```text
displayedFocusTime =
    accumulatedFocusMs
    +
    (now - runningSince)
```

UI intervals are only responsible for refreshing the display.

They are not responsible for measuring time.

---

# 10. Active stopwatch persistence

The active stopwatch SHOULD survive:

- browser refresh;
- PWA restart;
- browser restart where practical.

Its persisted state is local-device data.

The active stopwatch is NOT part of synchronization protocol v1.

---

# 11. Independent timers across devices

Timers running on separate devices are independent.

Example:

```text
Windows PC
    stopwatch running for Database Study

Phone
    user independently starts another stopwatch
```

Both may operate simultaneously.

Neither device needs to know that the other currently has an active timer.

When the sessions are eventually completed, both completed sessions may appear in synchronized history.

This is intentional.

---

# 12. No active-session handoff in v1

Protocol v1 MUST NOT attempt to synchronize:

- currently running timers;
- currently paused timers;
- timer ownership;
- remote pause/resume;
- active-session handoff.

Therefore:

```text
PC stopwatch running
       │
       ├── does NOT appear as running on phone
       │
       └── once completed, session history may sync
```

This avoids introducing distributed coordination into stopwatch operation.

A future protocol may define active-session synchronization separately.

It must not be required for v1.

---

# 13. Session completion

When a user finishes a stopwatch session, the active local stopwatch is converted into a history entity.

A completed session must at minimum record:

```text
globally unique ID
start timestamp
finish timestamp
focused duration
description
created timestamp
updated timestamp
```

Focused duration excludes pauses.

---

# 14. Canonical synchronized session model

A language-neutral representation should resemble:

```json
{
  "schemaVersion": 1,
  "id": "UUID",
  "entityType": "focusSession",
  "startedAt": "2026-10-17T15:20:00.000Z",
  "endedAt": "2026-10-17T16:43:10.000Z",
  "focusDurationMs": 4085000,
  "description": "Database final preparation",
  "createdAt": "2026-10-17T16:43:10.000Z",
  "updatedAt": "2026-10-17T16:43:10.000Z"
}
```

Note:

```text
endedAt - startedAt
```

does NOT necessarily equal:

```text
focusDurationMs
```

because pauses may have occurred.

Example:

```text
startedAt       15:00
endedAt         16:00

20 minutes paused

focusDuration   40 minutes
```

This distinction is fundamental to the data model.

---

# 15. Pause history

Protocol v1 does NOT require individual pause intervals to be synchronized.

The canonical historical value is:

```text
focusDurationMs
```

The local client may track individual pause intervals while a stopwatch is active if useful for implementation or debugging.

Unless the existing C++ application's functionality requires otherwise, completed synchronized sessions do not need to preserve every individual pause.

This keeps the core session format simple and portable.

---

# 16. Session IDs

Synchronized entities MUST use globally unique identifiers.

Database-generated incremental integers MUST NOT be used as cross-device entity IDs.

Preferred:

```text
UUIDv7
```

Benefits include:

- global uniqueness;
- language-independent implementations;
- approximate chronological ordering.

UUIDv4 remains acceptable for identities where sortable time is irrelevant.

---

# 17. Local persistence

The web client should use IndexedDB.

IndexedDB is strictly an implementation detail.

The local store should conceptually contain:

```text
focusSessions

activeStopwatch

syncMetadata

syncOutbox

knownOperations

knownSegments

deviceIdentity
```

The IndexedDB schema is NOT part of the Focus Timer Sync Protocol.

---

# 18. Local-first mutation

All application operations must succeed locally first.

For example:

```text
User edits session description
        │
        ▼
Local database updated
        │
        +
sync operation added to outbox
        │
        ▼
UI reports success
        │
        ▼
remote synchronization happens later
```

Network availability must never be required to:

- finish a session;
- edit a session;
- delete a session;
- inspect history.

---

# 19. Synchronized state

Protocol v1 synchronizes only the application's core historical data.

## Synchronized

```text
completed focus sessions
session descriptions
session edits
session deletions
```

## Not synchronized

```text
active stopwatch
paused stopwatch
UI state
theme
notification settings
sound settings
keyboard settings
OAuth credentials
sync cursors
device identity
PWA state
general application preferences
```

Settings synchronization is explicitly outside v1 scope.

---

# 20. History editing

Completed sessions MUST be editable.

This behavior already exists in the C++ application and should be preserved.

At minimum, the architecture must support changing synchronized session data such as:

```text
description
focus duration
timestamps
```

The actual fields currently editable in the C++ implementation should be determined during Phase 0.

Editing a synchronized session MUST create a synchronization operation.

---

# 21. History deletion

Completed sessions MUST be deletable.

Deletion must synchronize.

Simply physically removing the local record is insufficient.

Example:

```text
Device A deletes session ABC offline.

Device B still contains ABC.

Both synchronize later.
```

Without synchronized deletion metadata, Device B could recreate ABC.

Therefore deletion requires a protocol-level tombstone operation.

---

# 22. Focus Timer Sync Protocol

The repository MUST contain:

```text
protocol/
└── v1/
    ├── protocol.md
    ├── schemas/
    └── test-vectors/
```

The protocol must be sufficient for implementing synchronization in another programming language.

A developer implementing the future C++ sync client MUST NOT need to inspect the TypeScript implementation to understand protocol behavior.

---

# 23. Protocol responsibilities

The protocol defines:

```text
entity format

operation format

device identity

dataset identity

logical clocks

operation ordering

conflict resolution

delete semantics

segment format

protocol versioning

convergence rules
```

The protocol does NOT define:

```text
IndexedDB tables

React components

Google OAuth implementation

Windows storage

Android storage

UI design
```

---

# 24. Dataset identity

A synchronized collection of Focus Timer history is called a:

```text
dataset
```

Each dataset has a globally unique:

```text
datasetId
```

Conceptually:

```json
{
  "protocolVersion": 1,
  "datasetId": "UUID",
  "application": "focus-timer",
  "createdAt": "..."
}
```

The dataset identity is independent from:

- Google account IDs;
- Drive file IDs;
- browsers;
- operating systems;
- local databases.

---

# 25. Device identity

Every Focus Timer installation gets its own `deviceId`.

Examples:

```text
Chrome PWA on desktop
Firefox on laptop
Windows C++ application
Android application
```

Recommended representation:

```text
UUIDv4
```

A device may optionally expose descriptive metadata:

```json
{
  "deviceId": "...",
  "platform": "web",
  "displayName": "Desktop"
}
```

Display metadata must never participate in protocol correctness.

---

# 26. Operation-based synchronization

Clients synchronize operations rather than database files.

Local changes generate immutable sync operations.

At minimum:

```text
UPSERT
DELETE
```

Conceptual operation:

```json
{
  "protocolVersion": 1,
  "opId": "UUID",
  "datasetId": "UUID",
  "deviceId": "UUID",
  "entityType": "focusSession",
  "entityId": "UUID",
  "operation": "UPSERT",
  "clock": {},
  "payload": {}
}
```

Every operation MUST have a globally unique `opId`.

Operations MUST be idempotent.

Applying the same operation twice must have the same final effect as applying it once.

---

# 27. Outbox model

Every mutation to synchronized data creates a local operation.

Conceptually:

```text
Finish stopwatch
        │
        ▼
Create completed FocusSession
        +
Create UPSERT operation
        │
        ▼
commit locally
        │
        ▼
sync later
```

Similarly:

```text
Edit session
    ↓
UPSERT operation
```

and:

```text
Delete session
    ↓
DELETE operation
```

From the application's perspective, modifying the local entity and generating the corresponding outgoing sync operation should be atomic.

---

# 28. Immutable per-device journals

Remote synchronization MUST use append-oriented, immutable operation history.

Each device owns its own journal.

Conceptually:

```text
Dataset
│
├── Device A
│   ├── Segment 001
│   ├── Segment 002
│   └── Segment 003
│
├── Device B
│   ├── Segment 001
│   └── Segment 002
│
└── Device C
    ├── Segment 001
    └── Segment 002
```

A device may append new segments to its own journal.

A device MUST NOT modify another device's published segments.

Published segments are immutable.

---

# 29. Why journals are preferred

This architecture is deliberately preferred over a single shared file such as:

```text
history.json
```

A shared mutable history file creates situations such as:

```text
Device A downloads history.json

Device B downloads history.json

A adds session X
B adds session Y

A uploads history.json
B uploads history.json

→ one write may overwrite the other
```

Preventing this correctly requires:

- optimistic concurrency;
- revisions/ETags;
- retries;
- merge-before-write;
- careful recovery.

With independent journals:

```text
A publishes operation X

B publishes operation Y
```

Neither needs to overwrite the other's data.

Both operations remain available.

Every client eventually reads:

```text
X + Y
```

and independently derives the same state.

This significantly reduces the number of distributed-write race conditions.

---

# 30. Sync segments

Journals should not necessarily create one remote file per operation.

Operations should be grouped into immutable **segments**.

Example:

```json
{
  "protocolVersion": 1,
  "datasetId": "...",
  "deviceId": "...",
  "segmentId": "...",
  "createdAt": "...",
  "operations": [
    {},
    {},
    {}
  ]
}
```

Once uploaded successfully, a segment must never change.

Clients may batch based on:

- operation count;
- serialized size;
- elapsed time;
- lifecycle opportunities.

Batching policy is not part of protocol semantics.

---

# 31. Deterministic convergence

A fundamental invariant is:

```text
same valid operation set
          ↓
same materialized history
```

This must hold regardless of:

- operation arrival order;
- client programming language;
- operating system;
- transport;
- network timing.

Examples:

```text
Client A receives:
1, 2, 3

Client B receives:
3, 1, 2

Result must be identical.
```

---

# 32. Logical clocks

Raw physical timestamps alone MUST NOT determine conflict resolution.

Device clocks may be wrong.

The preferred v1 mechanism is:

```text
Hybrid Logical Clock (HLC)
```

or another explicitly documented equivalent.

The protocol specification must define precisely:

- representation;
- comparison algorithm;
- local clock advancement;
- incorporation of remote clocks;
- tie-breaking.

Every language implementation must reproduce the algorithm exactly.

A final deterministic tie-breaker such as:

```text
opId
```

may be used where required.

---

# 33. Concurrent edits

Example:

```text
Initial description:
"Study"

Device A offline:
"Study databases"

Device B offline:
"Study final"

Both reconnect later.
```

Both operations remain valid historical operations.

Protocol v1 may resolve the resulting entity using deterministic:

```text
Last-Writer-Wins
```

according to the logical clock.

All clients must eventually select the same result.

The losing operation remains represented in operation history even if normal UI does not expose conflict history.

Field-level CRDT merging is explicitly not required for v1.

---

# 34. Edit versus delete conflicts

Delete is represented by an operation just like an update.

Example:

```text
Device A:
DELETE session ABC

Device B:
EDIT session ABC
```

The winner is determined by the same deterministic version-ordering rules.

This avoids special-case nondeterminism.

A DELETE operation creates a tombstone materialization.

---

# 35. Tombstones

Deleted entities MUST remain logically represented as deleted for synchronization purposes.

Otherwise old offline clients could resurrect deleted sessions.

Conceptually:

```text
entity ABC
latest operation = DELETE
```

means:

```text
ABC does not appear in normal history
```

but the protocol still knows that ABC was intentionally deleted.

---

# 36. Journal retention

Protocol v1 may retain operation segments indefinitely.

For normal personal Focus Timer usage, this is acceptable.

Premature distributed garbage collection should not be implemented.

Deleting old operations safely requires proving that every relevant client has incorporated them, which becomes difficult with clients that may remain offline for months.

Future versions may introduce:

```text
snapshots

checkpoints

safe journal compaction
```

These are not v1 requirements.

---

# 37. Eventual consistency

Synchronization is eventually consistent.

Real-time synchronization is not required.

Example:

```text
Laptop offline
    ↓
creates sessions A and B

Phone offline
    ↓
creates session C

Laptop reconnects
    ↓
publishes A and B

Phone reconnects
    ↓
publishes C
    ↓
downloads A and B

Laptop later syncs
    ↓
downloads C

Both contain:
A
B
C
```

---

# 38. Sync Transport abstraction

The synchronization core communicates with remote storage through a transport-neutral abstraction.

Conceptually:

```ts
interface SyncTransport {
    initializeDataset(...): Promise<...>;

    readDatasetMetadata(...): Promise<...>;

    listDevices(...): Promise<...>;

    listSegments(...): Promise<...>;

    readSegment(...): Promise<...>;

    publishSegment(...): Promise<...>;

    getStatus(...): Promise<...>;
}
```

This exact TypeScript API is not mandatory.

The abstraction is mandatory.

---

# 39. Transport independence

The Sync Core must not know whether the remote provider is:

```text
Google Drive

WebDAV

OneDrive

Dropbox

local filesystem

S3-compatible storage

future Focus Timer service

another provider
```

Adding a new transport must not require modifications to:

- stopwatch logic;
- history semantics;
- operation semantics;
- logical clocks;
- conflict resolution.

---

# 40. Google Drive transport

Google Drive will be the first implementation.

Conceptually:

```text
Focus Timer/
└── sync/
    └── v1/
        ├── dataset.json
        │
        └── devices/
            ├── <device-A>/
            │   └── segments/
            │       ├── <segment-1>.json
            │       └── <segment-2>.json
            │
            └── <device-B>/
                └── segments/
                    └── <segment-1>.json
```

The actual Drive implementation may use a different physical arrangement if the API strongly favors it.

Logical semantics must remain unchanged.

Google Drive file IDs must never become Focus Timer entity IDs.

---

# 41. Google authentication

Google authentication exists exclusively to authorize synchronization storage access.

It is NOT the Focus Timer identity model.

Without Google authentication:

```text
Focus Timer still works.
```

With Google authentication:

```text
Focus Timer gains Drive synchronization.
```

Future platforms should use appropriate public-client OAuth flows.

Examples:

```text
Web
    browser-compatible OAuth + PKCE where applicable

Windows
    native/desktop public-client flow

Android
    Android-appropriate Google authorization
```

No client-side application may contain a secret expected to remain confidential.

---

# 42. Google Drive scope

The implementation should request the narrowest practical Drive access.

Focus Timer should not require arbitrary access to unrelated user documents.

The transport should operate only on application-managed synchronization data where possible.

---

# 43. User ownership

Focus Timer data belongs entirely to the user.

Users must be able to:

- use the app without Google;
- disconnect synchronization;
- retain local sessions after disconnecting;
- export history;
- delete remote synchronization files;
- interpret the documented file format without a Focus Timer server.

No developer-controlled infrastructure should be necessary to recover the user's historical data.

---

# 44. Import and export

Focus Timer SHOULD support explicit history export.

At minimum:

```text
JSON
```

The export format should be documented.

It must not be a raw IndexedDB dump.

Import should validate:

- format version;
- IDs;
- timestamps;
- durations;
- entity schema.

Malformed imports must fail safely.

---

# 45. Future C++ synchronization

The existing Windows implementation should eventually be capable of participating in the same dataset.

Conceptually, adding synchronization to C++ should require:

```text
C++ FocusSession representation
        │
        ▼
protocol serializer/parser
        │
        ▼
Focus Timer Sync reducer
        │
        ▼
Google Drive SyncTransport
```

The web application should not require redesign when this happens.

Example:

```text
Web:
creates session W

Windows:
creates session C

both sync

Web history:
W
C

Windows history:
W
C
```

---

# 46. Future Android application

The same applies to Android.

Conceptually:

```text
Android UI
        ↓
Android local storage
        ↓
Focus Timer Sync Protocol
        ↓
Google Drive SyncTransport
```

No web API is required.

The Android implementation should be verifiable against the same protocol test vectors.

---

# 47. Protocol test vectors

Documentation alone is not enough to guarantee cross-language interoperability.

The repository MUST include language-neutral test vectors.

For example:

```text
protocol/v1/test-vectors/

    basic-sync/

    duplicate-operations/

    out-of-order-operations/

    concurrent-edit/

    edit-vs-delete/

    concurrent-delete/

    clock-tie/

    multi-device/

    long-offline-device/
```

Each contains:

```text
input operations

expected resulting materialized state
```

A compliant implementation in TypeScript, C++, Kotlin, Swift, or another language must produce the same expected output.

---

# 48. Compatibility authority

The TypeScript implementation is NOT itself the specification.

The authority is:

```text
protocol.md
+
schemas
+
test vectors
```

If another client must reverse-engineer TypeScript source to reproduce behavior, the protocol specification is incomplete.

---

# 49. Schema evolution

Protocol and synchronized entity formats must support explicit versioning.

Compatible optional fields may be introduced only when older clients can safely ignore them.

Breaking semantic changes require a new protocol version.

Example:

```text
protocol/v1

protocol/v2
```

Clients encountering an unsupported version must fail safely.

They must not guess its meaning.

---

# 50. Sync lifecycle

Synchronization may be attempted on events such as:

```text
application startup

application foreground

completed session

edited session

deleted session

network reconnect

manual Sync action

periodic opportunity
```

Correctness must not depend on a particular polling frequency.

---

# 51. User-facing sync state

The UI should expose understandable synchronization status.

Examples:

```text
Local only

Synced

Syncing…

Offline — changes saved locally

Sync error — changes safe locally

Google Drive disconnected
```

A synchronization error must never imply that local data was discarded.

---

# 52. Error handling

Synchronization must gracefully handle:

- internet unavailable;
- expired OAuth authorization;
- revoked permissions;
- Google Drive API failure;
- rate limiting;
- missing remote files;
- missing dataset folder;
- malformed segments;
- duplicate segments;
- unexpected operation order.

Malformed remote artifacts must not corrupt valid local history.

---

# 53. Security

Synchronized data MUST NOT include:

```text
OAuth access tokens

OAuth refresh tokens

client secrets

browser credentials

passwords
```

Authentication material remains client-local.

Where persistent credentials are necessary, each platform should use suitable secure storage.

---

# 54. Privacy

Focus session descriptions may contain private information.

Focus Timer should not transmit session history to the developer.

No mandatory behavioral telemetry should be required.

Remote synchronization occurs only through providers explicitly authorized by the user.

---

# 55. Encryption

Application-level end-to-end encryption is NOT required for v1.

The architecture should allow it later.

If introduced, encryption should occur above the Sync Transport layer.

Conceptually:

```text
Sync Core
   ↓
serialize
   ↓
encrypt
   ↓
Sync Transport
```

The transport should not need to understand encrypted domain payloads.

Key management must be separately designed before implementing encryption.

---

# 56. PWA behavior

The web version should be installable where supported.

After initial successful loading, core functionality should work offline.

The application must remain useful when:

```text
Google is offline

Drive is unavailable

the internet is unavailable
```

The service worker must avoid inappropriate caching of OAuth-sensitive responses.

---

# 57. Responsive design

The UI should support:

- desktop;
- laptop;
- tablet;
- phone.

The C++ layout does not need to be reproduced pixel-for-pixel.

Product behavior should remain familiar while presentation adapts to device form factor.

---

# 58. Accessibility

Core stopwatch functionality must be keyboard-accessible.

Controls must use semantic labels.

Focus indicators should remain visible.

Application state should not be represented through color alone.

Reasonable WCAG-compatible contrast should be maintained.

---

# 59. Notifications

Where supported, clients may notify the user about relevant stopwatch events.

Notification behavior is platform-specific.

Notification configuration is not synchronized.

Permission should be requested contextually.

---

# 60. History UI

Completed focus sessions must be visible locally.

Each history entry should expose at minimum:

```text
date

start/finish information where useful

focused duration

description
```

The UI should clearly represent focused duration rather than assuming wall-clock session length.

---

# 61. Statistics

Advanced statistics are outside the first implementation milestone.

Future features may include:

```text
focus time per day

focus time per week

monthly totals

streaks

tags

projects

trends
```

The basic session representation should make these possible without over-engineering protocol v1.

---

# 62. Recommended repository layout

A reasonable organization is:

```text
/
├── apps/
│   └── web/
│
├── packages/
│   ├── domain/
│   └── sync/
│
├── protocol/
│   └── v1/
│       ├── protocol.md
│       ├── schemas/
│       └── test-vectors/
│
├── docs/
│   ├── existing-app-behavior.md
│   ├── architecture.md
│   └── sync-architecture.md
│
└── SPEC.md
```

Exact monorepo tooling is implementation-specific.

The important architectural boundary is:

```text
stopwatch/domain
        ≠
local persistence
        ≠
sync protocol
        ≠
sync transport
```

---

# 63. Stopwatch testing

Tests must cover:

```text
start

pause

resume

multiple pauses

finish

reset/cancel

description handling

reload while running

reload while paused

browser timer throttling

persistence recovery
```

Tests must verify that paused time is excluded from:

```text
focusDurationMs
```

---

# 64. Domain testing

Tests should verify:

- focus session creation;
- history persistence;
- editing;
- deletion;
- input validation;
- conversion from active stopwatch to completed session.

---

# 65. Sync protocol testing

At minimum verify:

```text
idempotency

duplicate operation delivery

arbitrary operation order

two independent devices

simultaneous edits

edit versus delete

two offline devices

logical-clock comparison

tie-breaking

eventual convergence
```

---

# 66. Transport testing

Google Drive tests should cover:

```text
new dataset creation

existing dataset discovery

segment publication

segment listing

segment download

OAuth expiration

permission failure

missing remote directory

retryable API errors
```

Transport tests must not be used as a substitute for protocol tests.

The protocol should first be proven using an in-memory transport.

---

# 67. End-to-end synchronization tests

Tests should simulate at least two independent clients.

Example:

```text
Client A database
Client B database
```

Scenario:

```text
A creates session X

B creates session Y

A edits X offline

B edits X offline

A deletes Y

operations exchanged in arbitrary order

sync repeated
```

Both final materialized stores must converge deterministically.

---

# 68. Cross-language compatibility

When other implementations are added:

```text
                 protocol test vector
                         │
        ┌────────────────┼────────────────┐
        ▼                ▼                ▼
   TypeScript           C++             Kotlin
        │                │                │
        └──────── expected state ────────┘
```

No implementation gets special authority.

---

# 69. Observability

Debug information should make synchronization failures diagnosable.

Useful information may include:

```text
protocol version

dataset ID

device ID

last successful sync

number of pending operations

number of known remote segments

number of known operations
```

Debug output MUST NOT expose authentication tokens.

---

# 70. Performance

Normal application interaction must never wait for network access.

The following should feel immediate:

```text
start stopwatch

pause

resume

finish

edit history

delete history

browse history
```

Synchronization occurs asynchronously.

Remote journals are consumed into local materialized state.

The normal history UI should not reconstruct all state directly from Google Drive every time it renders.

---

# 71. Expected data scale

The architecture should comfortably support many years of individual Focus Timer usage.

Segments should batch operations sufficiently to avoid excessive remote file counts.

Complex distributed garbage collection should not be introduced prematurely.

---

# 72. Non-goals for v1

Protocol/application v1 does NOT require:

```text
developer-hosted backend

real-time synchronization

running-timer synchronization

cross-device pause/resume

timer handoff

single-active-timer global enforcement

settings synchronization

collaborative accounts

social features

team accounts

field-level CRDTs

advanced statistics

application-level E2E encryption

remote timer execution
```

These must not delay core functionality.

---

# 73. Implementation phases

## Phase 0 — Existing C++ analysis

Before major implementation changes:

1. Inspect the existing C++ application thoroughly.
2. Produce:

```text
docs/existing-app-behavior.md
```

3. Identify:
   - stopwatch semantics;
   - pause semantics;
   - history edit capabilities;
   - deletion behavior;
   - persistence behavior;
   - edge cases.
4. Compare existing behavior against this SPEC.
5. Flag genuine contradictions rather than silently choosing behavior.

---

## Phase 1 — Architecture and protocol

Produce:

```text
docs/architecture.md

docs/sync-architecture.md

protocol/v1/protocol.md

protocol/v1/schemas/

protocol/v1/test-vectors/
```

Do not start with Google Drive.

First formalize the synchronization contract.

---

## Phase 2 — Sync Core

Implement the protocol against a simple:

```text
InMemorySyncTransport
```

Simulate multiple independent clients.

Prove:

```text
idempotency
+
conflict handling
+
eventual convergence
```

before introducing external APIs.

---

## Phase 3 — Web local-first application

Implement the web/PWA client with:

```text
stopwatch

pause/resume

local persistence

completed history

history editing

history deletion

responsive UI

offline support
```

Everything must function without Google.

---

## Phase 4 — Google Drive transport

Implement:

```text
GoogleDriveSyncTransport
```

without changing protocol/domain semantics.

Integrate OAuth and remote journal persistence.

---

## Phase 5 — Multi-device hardening

Test:

```text
multiple browsers

offline operation

long offline periods

concurrent edits

deletes

reconnects

OAuth failures

Drive failures

duplicate sync attempts
```

---

## Phase 6 — Production hardening

Audit:

- architecture boundaries;
- stopwatch correctness;
- persistence;
- PWA behavior;
- concurrency;
- security;
- accessibility;
- malformed remote data;
- test coverage;
- failure recovery.

---

# 74. Acceptance criteria

## Stopwatch

A user can:

```text
start

pause

resume

finish
```

a focus session.

Paused time is not included in focus duration.

No countdown duration is required.

---

## Local-first behavior

Focus Timer remains fully usable without authentication or internet access.

---

## Persistence

Committed session history survives application restart.

Active stopwatch state survives ordinary reload/restart where technically practical.

---

## History

Users can:

```text
view

edit

delete
```

completed sessions.

---

## Optional synchronization

Google authentication is required only when synchronization is explicitly enabled.

---

## Multi-device convergence

Two independent clients can:

```text
create sessions

edit sessions

delete sessions

remain offline

reconnect later

exchange operations
```

and eventually produce identical synchronized history.

---

## Independent active timers

Two devices may simultaneously run independent stopwatches.

This does not constitute a protocol conflict.

Only resulting completed history participates in synchronization.

---

## Idempotency

Running synchronization repeatedly without new operations changes nothing after convergence.

---

## Transport isolation

Replacing Google Drive with an in-memory transport requires no change to:

```text
stopwatch domain

session semantics

logical clocks

merge semantics
```

---

## Platform neutrality

Protocol code and documentation must not rely on:

```text
React

DOM

IndexedDB

browser APIs

Windows APIs

Android APIs
```

---

## Future client compatibility

A future C++ client can join the same dataset without requiring redesign of the web application.

---

## User ownership

Disconnecting Google leaves Focus Timer fully usable and preserves local history.

---

# 75. Architectural invariants

These rules are non-negotiable unless this SPEC is deliberately revised.

### Invariant 1

```text
Focus Timer works without cloud synchronization.
```

### Invariant 2

```text
The stopwatch is local to the device that runs it.
```

### Invariant 3

```text
Active timers are not synchronized in protocol v1.
```

### Invariant 4

```text
Completed history is synchronized.
```

### Invariant 5

```text
Local actions do not require remote round-trips.
```

### Invariant 6

```text
Paused time is not focused time.
```

### Invariant 7

```text
Google Drive is replaceable.
```

### Invariant 8

```text
IndexedDB is replaceable.
```

### Invariant 9

```text
The Sync Protocol is language-neutral.
```

### Invariant 10

```text
The same operation set must produce the same synchronized state on every compliant client.
```

### Invariant 11

```text
One client is never the backend of another.
```

### Invariant 12

```text
A future client can join without redesigning existing clients.
```

### Invariant 13

```text
Published journal segments are immutable.
```

### Invariant 14

```text
Each device writes only to its own journal.
```

### Invariant 15

```text
User history remains usable without infrastructure controlled by the Focus Timer developer.
```

---

# 76. Target long-term architecture

The desired architecture should eventually allow:

```text
                         ┌─────────────────┐
                         │  Google Drive   │
                         │  SyncTransport  │
                         └────────┬────────┘
                                  │
                                  │
                    Focus Timer Sync Protocol
                                  │
              ┌───────────────────┼───────────────────┐
              │                   │                   │
              ▼                   ▼                   ▼
         Web / PWA           Windows App          Android App
         TypeScript              C++                 Kotlin
              │                   │                   │
              ▼                   ▼                   ▼
          IndexedDB         local storage           SQLite
```

Each platform:

- controls its own stopwatch;
- controls its own local database;
- can operate offline;
- independently implements the common protocol;
- independently communicates with the synchronization transport.

No platform owns the others.

---

# 77. Definition of architectural success

The synchronization architecture is considered successful when this scenario requires no redesign:

```text
2026:
Web app supports synchronization.

Later:
C++ application gains synchronization.

Later:
Android application is released.

Later:
another remote transport is implemented.
```

Existing clients continue to work.

The new client or transport implements existing contracts rather than forcing architectural changes elsewhere.

That is a foundational requirement of Focus Timer.

---

# 78. Mandatory Codex workflow

Codex MUST NOT begin by blindly rewriting the existing C++ application.

Before major implementation:

1. Read this complete SPEC.
2. Inspect the existing C++ Focus Timer implementation.
3. Produce `docs/existing-app-behavior.md`.
4. Produce an architecture proposal.
5. Identify contradictions or unclear behavior.
6. Fully specify Sync Protocol v1.
7. Create schemas and test vectors.
8. Implement an in-memory multi-client synchronization test harness.
9. Demonstrate deterministic convergence.
10. Implement the web client.
11. Implement Google Drive only after the protocol abstraction is proven.

Optimize for:

```text
correctness

simplicity

portability

recoverability

maintainability

testability
```

before cleverness.