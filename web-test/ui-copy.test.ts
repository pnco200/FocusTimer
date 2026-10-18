import { describe, expect, it } from 'vitest';
import { LocalError } from '../src/web/model';
import { sessionDurationText } from '../src/web/reporting';
import { ownershipNotice, startupHeading, userError } from '../src/web/ui-copy';

describe('product presentation', () => {
  it('mentions another tab only when it has recently reported a timer', () => {
    expect(ownershipNotice(false)).toBe('Your saved session needs to be recovered. Continue here from the last saved point.');
    expect(ownershipNotice(false)).not.toContain('other tab');
    expect(ownershipNotice(true)).toBe('Your timer is open in another tab. Use that tab, or continue here.');
  });
  it.each([
    [1, 'Less than 1 sec'], [1472, '1 sec'], [84_999, '1 min 24 sec'],
    [2_538_125, '42 min 18 sec'], [4_320_125, '1 hr 12 min'], [90_000_001, '25 hr 0 min'],
  ] as const)('shows %s milliseconds in readable form without exposing fractions', (duration, expected) => {
    expect(sessionDurationText(duration)).toBe(expected);
  });

  it('does not expose arbitrary exception text, including on open, export, and edit paths', () => {
    const technical = new Error('IndexedDB schema failure for private session description: UUID / Lamport / journal');
    for (const context of ['save', 'open', 'export', 'edit', 'description'] as const) {
      expect(userError(technical, context)).not.toMatch(/IndexedDB|schema|UUID|Lamport|journal|private session/);
      expect(userError(technical, context)).toMatch(/try|Try|reopen|opening|characters/);
    }
    expect(technical.message).toContain('IndexedDB');
  });

  it('gives useful actions for conflicts, storage failures, and rare recovery without internal terminology', () => {
    expect(userError(new LocalError('stale-editor', 'Winner revision changed'))).toContain('Close and reopen');
    expect(userError(new LocalError('stale-owner', 'Owner fencing generation changed'))).toContain('Continue here');
    expect(userError(new DOMException('Injected transaction detail', 'QuotaExceededError'))).toContain('Keep this tab open');
    expect(userError({ code: 'counter-exhausted' })).toContain('Data & storage');
    expect(userError(new LocalError('edit-positive', 'focusDurationMs invariant'))).toContain('longer than zero');
    expect(userError(new LocalError('edit-minutes', 'Fractional integer input'))).toContain('whole minutes');
    expect(userError({ classification: 'unsupported', message: 'schemaVersion 99' }, 'open')).toContain('Update Focus Timer');
  });

  it('distinguishes startup API failures from damaged or incompatible saved history', () => {
    for (const error of [new TypeError('crypto.randomUUID is not a function'), new DOMException('Open failed', 'UnknownError'),
      new LocalError('secure-random-unavailable', 'No secure crypto'), new LocalError('storage-unavailable', 'No IndexedDB')]) {
      expect(startupHeading(error)).toBe('Focus Timer couldn’t start');
      expect(userError(error, 'open')).not.toMatch(/corrupt|saved data needs attention/);
    }
    expect(startupHeading(new LocalError('recovery', 'Missing installation metadata'))).toBe('Your saved sessions need attention');
    expect(startupHeading({ classification: 'unsupported' })).toBe('Your saved sessions need attention');
    expect(userError({ code: 'secure-random-unavailable' }, 'open')).toContain('updated browser');
    expect(userError({ code: 'storage-unavailable' }, 'open')).toContain('Allow this site to save data');
    expect(userError(new DOMException('Denied', 'SecurityError'), 'open')).toContain('Allow this site');
    expect(userError(new DOMException('Full', 'QuotaExceededError'), 'open')).toContain('Free up space');
  });
});
