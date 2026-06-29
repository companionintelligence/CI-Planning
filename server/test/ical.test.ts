import { describe, it, expect } from 'vitest';
import { blocksToICal, toICalUTC, toICalDate, escapeText, fold, type ICalBlock } from '../src/lib/ical.js';

// Inject a fixed "now" so DTSTAMP is deterministic.
const NOW = new Date('2026-06-29T12:00:00.000Z');
const ics = (blocks: ICalBlock[]) => blocksToICal(blocks, { now: NOW });

describe('iCal helpers', () => {
  it('toICalUTC → YYYYMMDDTHHMMSSZ', () => {
    expect(toICalUTC('2026-06-29T09:05:03.000Z')).toBe('20260629T090503Z');
  });
  it('toICalDate → YYYYMMDD', () => {
    expect(toICalDate('2026-06-29T23:30:00.000Z')).toBe('20260629');
  });
  it('escapeText escapes backslash, semicolon, comma, and newline (backslash first)', () => {
    expect(escapeText('a,b; c\\d\ne')).toBe('a\\,b\\; c\\\\d\\ne');
  });
  it('fold wraps >75-octet lines with a leading space; unfolding restores the original', () => {
    const long = 'X'.repeat(200);
    const folded = fold(long);
    const physical = folded.split('\r\n');
    expect(physical.length).toBeGreaterThan(1);
    physical.forEach((l) => expect(l.length).toBeLessThanOrEqual(75));
    physical.slice(1).forEach((l) => expect(l.startsWith(' ')).toBe(true));
    expect(folded.replace(/\r\n /g, '')).toBe(long);
  });
  it('fold never splits a multi-byte UTF-8 codepoint', () => {
    const folded = fold('é'.repeat(80)); // 160 octets
    // Each physical line must decode cleanly (no replacement char from a split sequence).
    folded.split('\r\n').forEach((l) => expect(l.includes('�')).toBe(false));
    expect(folded.replace(/\r\n /g, '')).toBe('é'.repeat(80));
  });
});

describe('blocksToICal', () => {
  it('empty list → a valid, empty VCALENDAR (no VEVENT), CRLF-terminated', () => {
    const out = ics([]);
    expect(out.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(out).toContain('VERSION:2.0');
    expect(out).toContain('PRODID:-//Companion Planning//EN');
    expect(out).toContain('CALSCALE:GREGORIAN');
    expect(out).toContain('X-WR-CALNAME:Companion Planning');
    expect(out).not.toContain('BEGIN:VEVENT');
    expect(out.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
    expect(out.endsWith('\r\n')).toBe(true);
  });

  it('one VEVENT per block, with a stable UID and UTC DTSTART/DTEND + DTSTAMP', () => {
    const out = ics([
      { id: 'a1', title: 'Deep work', start_at: '2026-06-29T16:00:00.000Z', end_at: '2026-06-29T17:30:00.000Z' },
      { id: 'b2', title: 'Lunch', start_at: '2026-06-29T19:00:00.000Z', end_at: '2026-06-29T19:30:00.000Z' },
    ]);
    expect((out.match(/BEGIN:VEVENT/g) ?? []).length).toBe(2);
    expect(out).toContain('UID:a1@companion.planning');
    expect(out).toContain('DTSTART:20260629T160000Z');
    expect(out).toContain('DTEND:20260629T173000Z');
    expect(out).toContain('SUMMARY:Deep work');
    expect(out).toContain('DTSTAMP:20260629T120000Z');
  });

  it('all-day block → VALUE=DATE with an exclusive next-day DTEND', () => {
    const out = ics([{ id: 'c3', title: 'Holiday', start_at: '2026-06-29T00:00:00.000Z', end_at: '2026-06-29T00:00:00.000Z', all_day: true }]);
    expect(out).toContain('DTSTART;VALUE=DATE:20260629');
    expect(out).toContain('DTEND;VALUE=DATE:20260630');
    expect(out).not.toMatch(/DTSTART:2026\d{4}T/); // not the date-time form
  });

  it('escapes TEXT in SUMMARY/DESCRIPTION', () => {
    const out = ics([{
      id: 'd4', title: 'Plan A; B, C\\D\nline2',
      start_at: '2026-06-29T16:00:00.000Z', end_at: '2026-06-29T17:00:00.000Z',
    }]);
    expect(out).toContain('SUMMARY:Plan A\\; B\\, C\\\\D\\nline2');
  });

  it('CATEGORIES = tag + secondary_tags (comma-separated)', () => {
    const out = ics([{
      id: 'e5', title: 'Tagged', start_at: '2026-06-29T16:00:00.000Z', end_at: '2026-06-29T17:00:00.000Z',
      tag: 'work', secondary_tags: ['email', 'urgent'],
    }]);
    expect(out).toContain('CATEGORIES:work,email,urgent');
  });

  it('DESCRIPTION carries the "why now" rationale + a non-default status', () => {
    const out = ics([{
      id: 'f6', title: 'Why', start_at: '2026-06-29T16:00:00.000Z', end_at: '2026-06-29T17:00:00.000Z',
      rationale: 'highest priority', status: 'completed',
    }]);
    expect(out).toContain('DESCRIPTION:Why now: highest priority\\nStatus: completed');
  });
});
