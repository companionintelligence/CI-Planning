import { describe, it, expect, beforeEach } from 'vitest';
import { parseQuick } from '../src/engine/quickadd.js';
import { resetDb, startTestServer, api } from './helpers.js';

// Fixed reference so chrono is deterministic (its non-determinism risk).
const REF = new Date('2026-06-15T17:00:00.000Z'); // a Monday

const TIME = /^\d{2}:\d{2}$/;

describe('parseQuick — deterministic NL parse', () => {
  // No-date cases: title/tags/estimate are timezone-independent → assert exactly.
  const exact: Array<{ in: string; title: string; tags: string[]; est?: number }> = [
    { in: 'Pay invoice', title: 'Pay invoice', tags: [] },
    { in: 'Pay invoice #finance', title: 'Pay invoice', tags: ['finance'] },
    { in: 'Pay invoice ~20m', title: 'Pay invoice', tags: [], est: 20 },
    { in: 'Pay invoice ~ 45 min', title: 'Pay invoice', tags: [], est: 45 },
    { in: 'Email Steve #work #urgent ~15m', title: 'Email Steve', tags: ['work', 'urgent'], est: 15 },
    { in: 'Review PR', title: 'Review PR', tags: [] },
    { in: 'Buy milk #home', title: 'Buy milk', tags: ['home'] },
    { in: 'Plan offsite ~120m', title: 'Plan offsite', tags: [], est: 120 },
    { in: 'quick note #idea', title: 'quick note', tags: ['idea'] },
    { in: 'asdfghjkl', title: 'asdfghjkl', tags: [] }, // junk ⇒ whole string is the title
    { in: '  spaced   out   title  ', title: 'spaced out title', tags: [] },
    { in: 'Ship #a #b #c', title: 'Ship', tags: ['a', 'b', 'c'] },
  ];
  for (const c of exact) {
    it(`exact: "${c.in}"`, () => {
      const p = parseQuick(c.in, REF);
      expect(p.title).toBe(c.title);
      expect(p.tags).toEqual(c.tags);
      expect(p.estimatedMinutes).toBe(c.est);
      expect(p.dueAt).toBeUndefined();
      expect(p.scheduledFor).toBeUndefined();
    });
  }

  // Time-bearing ⇒ due_at (a deadline) + task_time. (tz-robust: assert presence.)
  const timed = ['Submit report tomorrow 9am', 'Standup today 3pm', 'Prep deck friday 10am', 'Dentist next monday 8:30am'];
  for (const phrase of timed) {
    it(`time ⇒ due_at + task_time: "${phrase}"`, () => {
      const p = parseQuick(phrase, REF);
      expect(p.dueAt, 'dueAt set').toBeTruthy();
      expect(p.dueAt!.endsWith('Z')).toBe(true); // a real UTC instant
      expect(p.taskTime).toMatch(TIME);
      expect(p.scheduledFor).toBeUndefined();
      expect(p.title.length).toBeGreaterThan(0);
    });
  }

  // Date-only ⇒ scheduled_for (intent), never due_at.
  const dated = ['Submit report tomorrow', 'Call dad next friday', 'Renew passport in 2 weeks', 'Prep deck friday'];
  for (const phrase of dated) {
    it(`date-only ⇒ scheduled_for: "${phrase}"`, () => {
      const p = parseQuick(phrase, REF);
      expect(p.scheduledFor, 'scheduledFor set').toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.dueAt).toBeUndefined();
      expect(p.title.length).toBeGreaterThan(0);
    });
  }

  it('combines tags + estimate + time in one phrase', () => {
    const p = parseQuick('Ship release friday 5pm ~90m #eng', REF);
    expect(p.tags).toEqual(['eng']);
    expect(p.estimatedMinutes).toBe(90);
    expect(p.dueAt).toBeTruthy();
    expect(p.taskTime).toMatch(TIME);
  });

  it('is deterministic against a fixed reference', () => {
    expect(parseQuick('Submit report tomorrow 9am #work ~30m', REF)).toEqual(
      parseQuick('Submit report tomorrow 9am #work ~30m', REF)
    );
  });
});

describe('POST /api/tasks/quick', () => {
  beforeEach(() => resetDb());

  it('creates a task from the deterministic parse, regardless of Ollama', async () => {
    const srv = await startTestServer();
    try {
      const res = await api<{ task: { title: string; tags: string[] }; parsed: { tags: string[] }; llm: boolean }>(
        srv.url,
        '/api/tasks/quick',
        { method: 'POST', json: { text: 'Pay the AMD invoice friday 3pm #finance ~20m' } }
      );
      expect(res.status).toBe(201);
      expect(res.body.task.title).toBe('Pay the AMD invoice');
      expect(res.body.task.tags).toEqual(['finance']);
      expect(typeof res.body.llm).toBe('boolean'); // true if Ollama up, false (fallback) if down
    } finally {
      await srv.close();
    }
  });

  it('400s on empty text', async () => {
    const srv = await startTestServer();
    try {
      const res = await api(srv.url, '/api/tasks/quick', { method: 'POST', json: { text: '   ' } });
      expect(res.status).toBe(400);
    } finally {
      await srv.close();
    }
  });
});
