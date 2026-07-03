import { describe, it, expect } from 'vitest';
import { focusState, focusCues, pendingCues, formatRemaining, overrunNote, WARN_LEAD_MS } from './focus.js';

// 10:00–11:00, one hour.
const S = Date.parse('2026-06-15T10:00:00.000Z');
const E = Date.parse('2026-06-15T11:00:00.000Z');
const at = (hhmm: string) => Date.parse(`2026-06-15T${hhmm}:00.000Z`);

describe('focusState', () => {
  it('phases: before / running / warning / ended', () => {
    expect(focusState(at('09:59'), S, E).phase).toBe('before');
    expect(focusState(at('10:30'), S, E).phase).toBe('running');
    expect(focusState(at('10:57'), S, E).phase).toBe('warning'); // end − 3 min
    expect(focusState(at('10:58'), S, E).phase).toBe('warning');
    expect(focusState(at('11:00'), S, E).phase).toBe('ended');
    expect(focusState(at('11:30'), S, E).phase).toBe('ended');
  });

  it('elapsedFrac runs 0→1, clamped', () => {
    expect(focusState(S, S, E).elapsedFrac).toBe(0);
    expect(focusState(at('10:30'), S, E).elapsedFrac).toBeCloseTo(0.5, 5);
    expect(focusState(at('12:00'), S, E).elapsedFrac).toBe(1);
  });

  it('depletionFrac reaches 1 at the warning threshold, not the end', () => {
    expect(focusState(S, S, E).depletionFrac).toBe(0);
    // At end−3min (57 min into a 57-min depletion span) → fully depleted.
    expect(focusState(at('10:57'), S, E).depletionFrac).toBeCloseTo(1, 5);
    expect(focusState(at('10:30'), S, E).depletionFrac).toBeCloseTo(30 / 57, 4);
    expect(focusState(at('11:00'), S, E).depletionFrac).toBe(1);
  });

  it('remainingMs counts down to 0', () => {
    expect(focusState(at('10:00'), S, E).remainingMs).toBe(60 * 60_000);
    expect(focusState(at('10:59'), S, E).remainingMs).toBe(60_000);
    expect(focusState(at('11:30'), S, E).remainingMs).toBe(0);
  });

  it('a zero-length block degrades without dividing by zero', () => {
    const st = focusState(S, S, S);
    expect(st.depletionFrac).toBe(1);
    expect(Number.isFinite(st.elapsedFrac)).toBe(true);
  });
});

describe('focusCues / pendingCues', () => {
  it('emits start / mid / warn / end in order for a normal block', () => {
    expect(focusCues(S, E).map((c) => c.kind)).toEqual(['start', 'mid', 'warn', 'end']);
    expect(focusCues(S, E).map((c) => c.at)).toEqual([S, at('10:30'), at('10:57'), E]);
  });

  it('drops cues that collide on a very short block (no double-fire)', () => {
    const shortE = at('10:02'); // 2-min block: warn (end−3min) is before start → dropped; mid≈10:01
    const kinds = focusCues(S, shortE).map((c) => c.kind);
    expect(kinds).toContain('start');
    expect(kinds).toContain('end');
    // strictly increasing instants
    const ats = focusCues(S, shortE).map((c) => c.at);
    for (let i = 1; i < ats.length; i++) expect(ats[i]).toBeGreaterThan(ats[i - 1]);
  });

  it('pendingCues returns only cues strictly after now', () => {
    expect(pendingCues(at('10:45'), S, E).map((c) => c.kind)).toEqual(['warn', 'end']);
    expect(pendingCues(at('11:30'), S, E)).toEqual([]);
  });
});

describe('formatRemaining', () => {
  it('formats mm:ss and clamps negatives', () => {
    expect(formatRemaining(90_000)).toBe('1:30');
    expect(formatRemaining(5_000)).toBe('0:05');
    expect(formatRemaining(-1_000)).toBe('0:00');
  });
});

describe('overrunNote', () => {
  it('describes the overrun only when it actually collides', () => {
    expect(overrunNote(at('11:10'), at('11:00'), 'Lunch with Dana')).toBe('Runs 10m into Lunch with Dana.');
    expect(overrunNote(at('11:10'), at('11:30'), 'Lunch')).toBeNull(); // fits before next
    expect(overrunNote(at('11:10'), null, null)).toBeNull(); // nothing next
  });

  it('WARN_LEAD_MS is 3 minutes', () => {
    expect(WARN_LEAD_MS).toBe(180_000);
  });
});
