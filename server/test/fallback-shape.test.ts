import { describe, it, expect } from 'vitest';
import { guessEstimateMinutes, guessPriority } from '../src/agents/fallback-shape.js';

// The point of these heuristics is not that any single answer is right — it is that a
// no-LLM backlog stops being fifty rows of "30m · P3". So the tests assert the bands,
// the ordering between them, and the determinism the capture pipeline depends on.

describe('guessEstimateMinutes', () => {
  it('bands work by shape', () => {
    expect(guessEstimateMinutes('Finish the SBIR technical narrative')).toBe(90);
    expect(guessEstimateMinutes('Draft the API rate-limit policy')).toBe(60);
    expect(guessEstimateMinutes('Triage the GitHub issue backlog')).toBe(45);
    expect(guessEstimateMinutes('Book the family dinner reservation')).toBe(15);
  });

  it('falls back to 30m when nothing matches', () => {
    expect(guessEstimateMinutes('Dentist appointment')).toBe(30);
  });

  it('prefers the longer band when a title matches two', () => {
    // "draft" (60) and "memo" (90) both hit; the deep-work band wins.
    expect(guessEstimateMinutes('Draft the IC memo')).toBe(90);
  });

  it('is case-insensitive and word-bounded', () => {
    expect(guessEstimateMinutes('SEND the wire confirmation')).toBe(15);
    // "sender" must not read as "send".
    expect(guessEstimateMinutes('Update the sender allowlist')).toBe(45);
  });
});

describe('guessPriority', () => {
  it('blocking beats deadlined beats default', () => {
    expect(guessPriority('We are blocked on the signed MSA')).toBe(1);
    expect(guessPriority('Renew the business insurance policy before Friday')).toBe(2);
    expect(guessPriority('Photograph the prototype for the press kit')).toBe(3);
    expect(guessPriority('Someday: explore the Rust rewrite')).toBe(4);
  });

  it('stays inside the 1..5 range the schema documents', () => {
    for (const s of ['urgent', 'due tomorrow', 'nothing special', 'someday']) {
      const p = guessPriority(s);
      expect(p).toBeGreaterThanOrEqual(1);
      expect(p).toBeLessThanOrEqual(5);
    }
  });
});

describe('determinism', () => {
  it('the same text always yields the same numbers', () => {
    const text = 'Prepare the board deck and confirm the A/V requirements';
    const runs = Array.from({ length: 5 }, () => [guessEstimateMinutes(text), guessPriority(text)]);
    for (const r of runs) expect(r).toEqual(runs[0]);
  });

  it('a realistic backlog comes out varied, not uniform', () => {
    const backlog = [
      'Finish the SBIR technical narrative and budget justification',
      'Upload the accelerator pitch deck and founder video',
      'Register the company in SAM.gov',
      'Confirm the conference talk title and abstract',
      'Book the family dinner reservation',
      'Triage the GitHub issue backlog and label everything',
      'Dentist appointment',
      'Renew the business insurance policy',
    ];
    const estimates = new Set(backlog.map(guessEstimateMinutes));
    expect(estimates.size).toBeGreaterThanOrEqual(3);
  });
});
