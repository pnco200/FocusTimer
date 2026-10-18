type ErrorContext = 'save' | 'open' | 'export' | 'edit' | 'description';

export function ownershipNotice(hasRecentOwnerSample: boolean): string {
  return hasRecentOwnerSample
    ? 'Your timer is open in another tab. Use that tab, or continue here.'
    : 'Your saved session needs to be recovered. Continue here from the last saved point.';
}

export function startupHeading(error: unknown): string {
  const failure = error as { code?: unknown; classification?: unknown } | null;
  return failure?.code === 'recovery' || ['malformed', 'unsupported', 'integrity'].includes(String(failure?.classification))
    ? 'Your saved sessions need attention'
    : 'Focus Timer couldn’t start';
}

/** Product copy boundary. Keep the original error for diagnostics, never interpolate it here. */
export function userError(error: unknown, context: ErrorContext = 'save'): string {
  const failure = error as { code?: unknown; name?: unknown; classification?: unknown } | null;
  const messages: Record<string, string> = {
    'edit-minutes': 'Enter whole minutes, such as +5, -3, or 0.',
    'edit-positive': 'The adjusted duration must be longer than zero. Subtract fewer minutes.',
    'edit-limit': 'This duration is too long. Add fewer minutes.',
    'edit-dates': 'This session’s finish time is earlier than its start time, so it can’t be edited. You can still keep or export it.',
    'edit-description': 'Use up to 120 characters for the description.',
    'stale-editor': 'This session changed or was deleted. Close and reopen it to review the latest version.',
    'stale-owner': 'The timer is open in another tab. Use that tab or choose “Continue here”.',
    'stale-active': 'The timer has changed. Check it before trying again.',
    'counter-exhausted': 'This history can’t accept more changes. Open Data & storage for recovery options.',
    recovery: 'Your saved data needs attention. Export a backup if you can, then reopen Focus Timer.',
    'secure-random-unavailable': 'This browser can’t create secure session IDs. Try an updated browser with secure random number support.',
    'storage-unavailable': 'This browser can’t save sessions on this device. Allow this site to save data, or try another browser.',
    'storage-blocked': 'Close your other Focus Timer tabs, then try opening your sessions again. Your saved sessions are still on this device.',
  };
  if (typeof failure?.code === 'string' && Object.hasOwn(messages, failure.code)) return messages[failure.code];
  if (context === 'description') return 'Use up to 120 characters for the description.';
  if (context === 'open') {
    if (failure?.name === 'SecurityError' || failure?.name === 'NotAllowedError') return 'Allow this site to save data in your browser, then try again. You can also try a normal browsing window.';
    if (failure?.name === 'QuotaExceededError') return 'There isn’t enough space to open Focus Timer. Free up space and try again. Your existing data has not been replaced.';
    return failure?.name === 'VersionError' || failure?.classification === 'unsupported'
      ? 'Update Focus Timer, then try opening your sessions again.'
      : 'We couldn’t open Focus Timer. Try again. Your existing data has not been replaced.';
  }
  if (context === 'export') return 'We couldn’t export your data. Try exporting again.';
  if (failure?.name === 'QuotaExceededError') return 'There isn’t enough space to save your changes. Free up space and try again. Keep this tab open until they’re saved.';
  if (context === 'edit') return 'We couldn’t save this session. Keep the editor open and try again.';
  return 'We couldn’t save your changes. Keep this tab open and try again. You can export your saved history as a backup.';
}
