# Focus Timer UI principles

**Explain consequences and user actions, not implementation details.** Apply these rules to every new screen, label, notice, validation error, tooltip, and confirmation, whether written by a human or an AI contributor. SPEC.md remains authoritative for behavior and architecture; these guidelines govern presentation.

1. Explain what will happen and what the user can do.
2. Use the user’s vocabulary: sessions, history, backups, offline use, and sync.
3. Prefer concise copy. Remove a sentence if the user can still make the right decision without it.
4. Use progressive disclosure for advanced exports and uncommon recovery options. Keep consequences visible before confirmation.
5. Preserve internal precision without exposing unnecessary precision. Show durations such as `1 min 24 sec` or `1 hr 12 min`; never round stored data or change exports to match the display.
6. Errors explain what happened and a useful next step. Keep unsaved-work warnings visible, especially when closing the app could lose work.
7. Technical diagnostics belong outside normal product UI. Never render arbitrary exception messages. Preserve typed errors and their details for tests and debugging; do not log private descriptions or credentials.
8. New features should make sophisticated internals feel simple. Do not make users learn the architecture to use them.

## Vocabulary

| Engineering concept | Product language |
| --- | --- |
| IndexedDB / local persistence | Saved on this device |
| Persistent storage API | Protect local data |
| Eviction / clearing site storage | Browser data being cleared |
| Application shell / cache | Ready to use offline |
| Active checkpoint | Last saved point |
| Lifecycle suspension / owner loss | Session interrupted; continue paused |
| Owner fencing / tab coordination | Continue in this tab |
| Dataset / materialized projection | History |
| Operation journal / segments / tombstones | Full data archive, for backup or recovery |
| Unicode scalar bound | Character limit |
| Milliseconds / focusDurationMs | Duration, shown with useful precision |
| Transport / publication acknowledgement | Sync / synced |

Translate the meaning, not just the word. For example, a storage failure needs “Keep this tab open and try again,” not a definition of the database. Avoid internal identifiers or timing intervals in normal copy.

## Important limitations stay visible

- Never imply that data protection prevents deliberate browser data clearing. Keep the backup reminder beside the protection control.
- Offline readiness must reflect actual readiness. If reopening may need internet access, say so.
- A recovered session resumes paused from the last saved point; some unsaved time may be missing. Recommend pausing before closing the app or putting the device to sleep.
- Deletion is permanent. A new history retains the previous history for recovery but does not display it. Continuing in another tab may lose unsaved work. Explain these consequences before the action.
- Archives are downloadable for backup or recovery; do not imply that an in-app restore flow exists until it does.

## Future sync and review

Future sync UI should use “Local only,” “Connect Google Drive,” “Syncing…,” “Synced,” “Offline — changes saved on this device,” “Sync needs attention,” “Reconnect Google Drive,” and “Last synced…,” when those states are supported. Keep protocol, cursor, counter, journal, and transport details in diagnostics. This is copy guidance, not authorization to implement sync.

Before shipping copy changes, review visible text and accessible names, test keyboard access to disclosures, and retain tests that prove precision, export formats, save failures, and recovery behavior. `TimerClient.lastError` retains the original failure for debugging; product messages are selected by `ui-copy.ts`. Startup failures likewise remain available as the original error in component state. Do not weaken technical guarantees to simplify the words.
