import { describe, it, expect } from 'vitest';
import { sessionToMarkdown, sessionToJson, exportFilename } from './plan-week-export.js';
import type { PlanningSession } from './api.js';

const SESSION: PlanningSession = {
  id: '019f6e48-1234-7abc-8def-000000000001',
  owner_id: 'owner-1',
  started_at: '2026-07-13T09:00:00.000Z',
  ended_at: '2026-07-13T09:12:00.000Z',
  entry_branch: 'fill_week',
  status: 'completed',
  llm_used: true,
  summary: 'Filled 4 open slots for the week of Jul 13.',
  created_at: '2026-07-13T09:00:00.000Z',
  transcript: [
    { role: 'system', text: 'Starting fill_week for 2026-07-13.', ts: '2026-07-13T09:00:00.000Z', kind: 'plan_week:horizon' },
    { role: 'user', text: 'Use a 3-day horizon.', ts: '2026-07-13T09:01:00.000Z' },
    { role: 'system', text: 'Staged 4 candidates.', ts: '2026-07-13T09:02:00.000Z' },
  ],
};

const EMPTY_SESSION: PlanningSession = {
  ...SESSION,
  id: '019f6e48-1234-7abc-8def-000000000002',
  ended_at: null,
  status: 'open',
  summary: null,
  transcript: [],
};

describe('sessionToMarkdown', () => {
  it('renders the H1, the metadata line, and one labelled block per turn in order', () => {
    const md = sessionToMarkdown(SESSION);
    const h1Index = md.indexOf('# fill_week · 2026-07-13');
    const metaIndex = md.indexOf('Status: completed · Started: 2026-07-13T09:00:00.000Z · Ended: 2026-07-13T09:12:00.000Z');
    const systemIndex = md.indexOf('**System** · 2026-07-13T09:00:00.000Z');
    const userIndex = md.indexOf('**You** · 2026-07-13T09:01:00.000Z');
    const secondSystemIndex = md.indexOf('**System** · 2026-07-13T09:02:00.000Z');

    expect(h1Index).toBe(0);
    expect(metaIndex).toBeGreaterThan(h1Index);
    expect(systemIndex).toBeGreaterThan(metaIndex);
    expect(userIndex).toBeGreaterThan(systemIndex);
    expect(secondSystemIndex).toBeGreaterThan(userIndex);
    expect(md).toContain('Starting fill_week for 2026-07-13.');
    expect(md).toContain('Use a 3-day horizon.');
    expect(md).toContain('Filled 4 open slots for the week of Jul 13.');
  });

  it('an empty transcript still produces the header — no throw', () => {
    expect(() => sessionToMarkdown(EMPTY_SESSION)).not.toThrow();
    const md = sessionToMarkdown(EMPTY_SESSION);
    expect(md.startsWith('# fill_week · 2026-07-13')).toBe(true);
    expect(md).toContain('Status: open · Started: 2026-07-13T09:00:00.000Z');
    expect(md).not.toContain('Ended:'); // no ended_at when the session is still open
  });
});

describe('sessionToJson', () => {
  it('round-trips: JSON.parse(sessionToJson(s)) deep-equals s', () => {
    expect(JSON.parse(sessionToJson(SESSION))).toEqual(SESSION);
    expect(JSON.parse(sessionToJson(EMPTY_SESSION))).toEqual(EMPTY_SESSION);
  });
});

describe('exportFilename', () => {
  it('returns plan-week-<started-date>-<id>.<ext> for json and md', () => {
    expect(exportFilename(SESSION, 'json')).toBe('plan-week-2026-07-13-019f6e48-1234-7abc-8def-000000000001.json');
    expect(exportFilename(SESSION, 'md')).toBe('plan-week-2026-07-13-019f6e48-1234-7abc-8def-000000000001.md');
  });

  it('contains no path separators or spaces', () => {
    const name = exportFilename(SESSION, 'json');
    expect(name).not.toMatch(/[/\\ ]/);
  });
});
