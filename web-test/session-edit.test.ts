import { describe, expect, it } from 'vitest';
import { MAX_DURATION_MS, validateSession } from '../src/protocol/index.js';
import { prepareSessionEdit, type Session } from '../src/web/model';

const base: Session = {
  id: '44000000-0000-4000-8000-000000000001',
  startedAt: '2026-10-17T10:00:00.125Z',
  endedAt: '2026-10-17T10:10:00.375Z',
  focusDurationMs: 1_530_125, // 25 minutes, 30.125 seconds; independent of the wall-clock span.
  description: 'Read a chapter',
};

describe('completed-session minute adjustments', () => {
  it.each([['+2', 1_650_125], ['-3', 1_350_125], ['0', 1_530_125], ['5', 1_830_125]] as const)(
    '%s minutes preserves timestamps, identity, and the exact seconds/millisecond remainder', (input, expected) => {
      const edited = prepareSessionEdit(base, base.description, input);
      expect(edited).toEqual({ ...base, focusDurationMs: expected });
      expect(edited.focusDurationMs % 60_000).toBe(30_125);
      expect(Object.keys(edited).sort()).toEqual(Object.keys(base).sort());
      expect(base.focusDurationMs).toBe(1_530_125);
    });

  it('keeps description editing and a zero-adjustment no-op', () => {
    expect(prepareSessionEdit(base, 'A new description', '0')).toEqual({ ...base, description: 'A new description' });
    expect(prepareSessionEdit(base, base.description, '0')).toEqual(base);
  });

  it.each(['1.5', '-0.5', 'abc', '', ' ', '1e2', '0x10', '+', '--1', '9007199254740993'])(
    'rejects fractional or invalid input %j', input => {
      expect(() => prepareSessionEdit(base, base.description, input)).toThrow('whole number of minutes');
    });

  it.each(['-2', '-3'])('rejects a zero or negative resulting duration (%s)', input => {
    expect(() => prepareSessionEdit({ ...base, focusDurationMs: 120_000 }, base.description, input)).toThrow('greater than zero');
  });

  it('retains 1 ms and enforces the existing protocol duration ceiling without rounding', () => {
    expect(prepareSessionEdit({ ...base, focusDurationMs: 60_001 }, base.description, '-1').focusDurationMs).toBe(1);
    expect(prepareSessionEdit({ ...base, focusDurationMs: MAX_DURATION_MS - 60_000 }, base.description, '+1').focusDurationMs).toBe(MAX_DURATION_MS);
    expect(() => prepareSessionEdit({ ...base, focusDurationMs: MAX_DURATION_MS }, base.description, '+1')).toThrow('supported limit');
  });

  it('blocks editor saves of reversed timestamps while the frozen protocol still accepts the original', () => {
    const reversed = { ...base, endedAt: '2026-10-17T09:00:00.000Z' };
    expect(validateSession(reversed)).toEqual(reversed);
    expect(() => prepareSessionEdit(reversed, 'Changed', '+1')).toThrow('editing is unavailable');
    expect(reversed.endedAt).toBe('2026-10-17T09:00:00.000Z');
  });

  it('permits equal timestamps without deriving or altering focus', () => {
    const sameInstant = { ...base, endedAt: base.startedAt };
    expect(prepareSessionEdit(sameInstant, base.description, '+1')).toEqual({ ...sameInstant, focusDurationMs: base.focusDurationMs + 60_000 });
  });
});
