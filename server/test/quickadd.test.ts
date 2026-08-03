import { describe, it, expect, beforeEach } from 'vitest';
import { flushAudits } from '../src/lib/audit.js';
import { sqlite } from '../src/db/index.js';
import { parseQuick, type ParsedQuick } from '../src/engine/quickadd.js';
import { mergeEnrichment } from '../src/agents/quickadd.js';
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

  // Time-bearing ⇒ due_at (a deadline) + task_time + scheduled_for (AD1: task_time is
  // authoritative, so the timed task is scheduled onto that day). (tz-robust: assert presence.)
  const timed = ['Submit report tomorrow 9am', 'Standup today 3pm', 'Prep deck friday 10am', 'Dentist next monday 8:30am'];
  for (const phrase of timed) {
    it(`time ⇒ due_at + task_time + scheduled_for: "${phrase}"`, () => {
      const p = parseQuick(phrase, REF);
      expect(p.dueAt, 'dueAt set').toBeTruthy();
      expect(p.dueAt!.endsWith('Z')).toBe(true); // a real UTC instant
      expect(p.taskTime).toMatch(TIME);
      expect(p.scheduledFor, 'scheduledFor set for a timed mention (AD1)').toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(p.title.length).toBeGreaterThan(0);
    });
  }

  it('AD1: a timed mention sets scheduled_for to the parsed instant\'s local date + task_time', () => {
    // 9am tomorrow relative to Mon 2026-06-15 → Tue 2026-06-16 09:00 local.
    const p = parseQuick('Submit report tomorrow 9am', REF);
    expect(p.scheduledFor).toBe('2026-06-16');
    expect(p.taskTime).toBe('09:00');
    expect(p.dueAt).toBeTruthy();
  });

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

describe('mergeEnrichment — constrained classification overlay (2026-07-20)', () => {
  const VOCAB = { directions: ['Work', 'Home', 'Community'], others: ['finance', 'errands', 'health'] };
  const base = (over: Partial<ParsedQuick> = {}): ParsedQuick => ({ title: 'call mom', tags: [], ...over });

  it('adds the model direction (canonical casing) when the entry named none', () => {
    const out = mergeEnrichment(base(), { direction: 'home' }, VOCAB);
    expect(out.tags).toEqual(['Home']);
  });

  it('never overrides an explicit direction from the entry', () => {
    const out = mergeEnrichment(base({ tags: ['work'] }), { direction: 'Home' }, VOCAB);
    expect(out.tags).toEqual(['work']); // parsed tag wins; no second direction
  });

  it('rejects an invented direction (not in the vocabulary)', () => {
    const out = mergeEnrichment(base(), { direction: 'Gym' }, VOCAB);
    expect(out.tags).toEqual([]);
  });

  it('adds at most two EXISTING secondary tags, deduped against the parse', () => {
    const out = mergeEnrichment(
      base({ tags: ['finance'] }),
      { tags: ['finance', 'errands', 'health', 'made-up'] },
      VOCAB,
    );
    expect(out.tags).toEqual(['finance', 'errands', 'health']); // finance deduped, made-up rejected, cap 2 added
  });

  it('never overrides parsed estimate/priority; fills only the gaps', () => {
    const out = mergeEnrichment(
      base({ estimatedMinutes: 20, priority: 1 }),
      { estimatedMinutes: 90, priority: 4, direction: 'Home' },
      VOCAB,
    );
    expect(out.estimatedMinutes).toBe(20);
    expect(out.priority).toBe(1);
    const filled = mergeEnrichment(base(), { estimatedMinutes: 15, priority: 2 }, VOCAB);
    expect(filled.estimatedMinutes).toBe(15);
    expect(filled.priority).toBe(2);
  });

  // ── Phase B: the categories axis (its own field — never mixed into tags) ──
  const CAT_VOCAB = { ...VOCAB, categories: ['health', 'career', 'finance', 'leisure'] };

  it('categories: constrained to the vocabulary, canonical casing, capped at 3, deduped', () => {
    const out = mergeEnrichment(
      base(),
      { categories: ['Finance', 'HEALTH', 'finance', 'made-up', 'career', 'leisure'] },
      CAT_VOCAB,
    );
    expect(out.categories).toEqual(['finance', 'health', 'career']); // order kept, dupe+invented dropped, cap 3
    expect(out.tags).toEqual([]); // never leaks into the tag axes
  });

  it('categories: parse-carried categories win over the model suggestion', () => {
    const out = mergeEnrichment(base({ categories: ['leisure'] }), { categories: ['finance'] }, CAT_VOCAB);
    expect(out.categories).toEqual(['leisure']);
  });

  it('categories: absent from the output when neither parse nor model provide any', () => {
    const out = mergeEnrichment(base(), { direction: 'Home' }, CAT_VOCAB);
    expect(out.categories).toBeUndefined();
  });

  it('categories: a vocab without categories rejects every model pick', () => {
    const out = mergeEnrichment(base(), { categories: ['health'] }, VOCAB); // VOCAB has no categories list
    expect(out.categories).toBeUndefined();
  });
});

describe('POST /api/tasks/quick/parse — T14 parse-only preview twin', () => {
  beforeEach(() => resetDb());

  it('returns the parse and writes NOTHING (no task, no audit row)', async () => {
    const srv = await startTestServer();
    try {
      const res = await api<{ parsed: { title: string; tags: string[]; estimatedMinutes?: number; taskTime?: string; scheduledFor?: string }; llm: boolean }>(
        srv.url,
        '/api/tasks/quick/parse',
        { method: 'POST', json: { text: 'Pay the AMD invoice friday 3pm #finance ~20m' } },
      );
      expect(res.status).toBe(200);
      expect(res.body.parsed.title).toBe('Pay the AMD invoice');
      expect(res.body.parsed.tags).toEqual(['finance']);
      expect(res.body.parsed.estimatedMinutes).toBe(20);
      expect(res.body.parsed.taskTime).toMatch(TIME);
      expect(res.body.parsed.scheduledFor).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof res.body.llm).toBe('boolean'); // truthful: true only when Ollama enriched
      // ZERO writes — the wizard previews client-side; only its Add creates.
      const tasks = sqlite.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number };
      await flushAudits();
      const audits = sqlite.prepare(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number };
      expect(tasks.n).toBe(0);
      expect(audits.n).toBe(0);
    } finally {
      await srv.close();
    }
  });

  it('400s on empty text', async () => {
    const srv = await startTestServer();
    try {
      const res = await api(srv.url, '/api/tasks/quick/parse', { method: 'POST', json: { text: '  ' } });
      expect(res.status).toBe(400);
    } finally {
      await srv.close();
    }
  });
});

describe('POST /api/tasks/quick', () => {
  beforeEach(() => resetDb());

  it('creates a task from the deterministic parse, regardless of Ollama', async () => {
    const srv = await startTestServer();
    try {
      const res = await api<{ task: { title: string; tags: string[]; secondary_tags: string[] }; parsed: { tags: string[] }; llm: boolean }>(
        srv.url,
        '/api/tasks/quick',
        { method: 'POST', json: { text: 'Pay the AMD invoice friday 3pm #finance ~20m' } }
      );
      expect(res.status).toBe(201);
      expect(res.body.task.title).toBe('Pay the AMD invoice');
      // AF-11: quick-add levels its flat #tags by kind — 'finance' names no direction
      // tag (it's created kind='intention'), so it lands at level 2 (secondary_tags)
      // and the level-1 `tags` list stays empty. The parse still surfaces the raw name.
      expect(res.body.task.tags).toEqual([]);
      expect(res.body.task.secondary_tags).toEqual(['finance']);
      expect(res.body.parsed.tags).toEqual(['finance']);
      expect(typeof res.body.llm).toBe('boolean'); // true if Ollama up, false (fallback) if down
    } finally {
      await srv.close();
    }
  });

  it('rides the shared createTask service — exactly one audit row per quick-add', async () => {
    // Quick-add used to insert directly into tasks (its own audit + reminders),
    // skipping the service seam. Now it calls createTask like POST /api/tasks, so
    // service-side rules apply and the audit trail is single-sourced.
    const srv = await startTestServer();
    try {
      const res = await api<{ task: { id: string } }>(
        srv.url,
        '/api/tasks/quick',
        { method: 'POST', json: { text: 'Audit me #ops' } },
      );
      expect(res.status).toBe(201);
      await flushAudits();
      const rows = sqlite
        .prepare(`SELECT action FROM audit_log WHERE entity = ?`)
        .all(`task:${res.body.task.id}`) as { action: string }[];
      expect(rows).toEqual([{ action: 'create' }]);
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

  // AD1: a scheduled quick-add is placed on its day right away (task_time → exact block;
  // no time → that day's window/workday gap). Reads the created block by task id.
  const blocksOf = (taskId: string) =>
    sqlite
      .prepare(`SELECT start_at, end_at, is_auto FROM time_blocks WHERE task_id = ? AND block_kind = 'task' ORDER BY start_at`)
      .all(taskId) as { start_at: string; end_at: string; is_auto: number }[];

  it('places a block at the parsed task_time when a time is given', async () => {
    const srv = await startTestServer();
    try {
      // "at 2pm tomorrow" → scheduled_for = tomorrow, task_time = 14:00 (tz=UTC baseline).
      const res = await api<{ task: { id: string; scheduled_for: string | null; task_time: string | null } }>(
        srv.url,
        '/api/tasks/quick',
        { method: 'POST', json: { text: 'Call the vet tomorrow 2pm ~30m' } },
      );
      expect(res.status).toBe(201);
      const { id, scheduled_for, task_time } = res.body.task;
      expect(scheduled_for).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(task_time).toBe('14:00');
      const blocks = blocksOf(id);
      expect(blocks.length).toBe(1);
      // Placed exactly at (scheduled_for, 14:00) — task_time is authoritative.
      expect(blocks[0].start_at).toBe(`${scheduled_for}T14:00:00.000Z`);
      expect(blocks[0].end_at).toBe(`${scheduled_for}T14:30:00.000Z`);
      expect(blocks[0].is_auto).toBe(0); // user-intent, not auto-clearable
    } finally {
      await srv.close();
    }
  });

  it('a time-LESS scheduled quick-add places into that day (workday gap when no direction window)', async () => {
    const srv = await startTestServer();
    try {
      const res = await api<{ task: { id: string; scheduled_for: string | null; task_time: string | null } }>(
        srv.url,
        '/api/tasks/quick',
        { method: 'POST', json: { text: 'Buy groceries tomorrow ~45m' } },
      );
      expect(res.status).toBe(201);
      const { id, scheduled_for, task_time } = res.body.task;
      expect(scheduled_for).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(task_time).toBeFalsy(); // no time given
      const blocks = blocksOf(id);
      expect(blocks.length).toBe(1);
      // No direction window → earliest workday gap on that date (09:00, tz=UTC baseline).
      expect(blocks[0].start_at).toBe(`${scheduled_for}T09:00:00.000Z`);
      expect(blocks[0].end_at).toBe(`${scheduled_for}T09:45:00.000Z`);
    } finally {
      await srv.close();
    }
  });

  it('a bare (no-date) quick-add creates no block', async () => {
    const srv = await startTestServer();
    try {
      const res = await api<{ task: { id: string; scheduled_for: string | null } }>(
        srv.url,
        '/api/tasks/quick',
        { method: 'POST', json: { text: 'Pay invoice #finance ~20m' } },
      );
      expect(res.status).toBe(201);
      expect(res.body.task.scheduled_for).toBeFalsy();
      expect(blocksOf(res.body.task.id).length).toBe(0);
    } finally {
      await srv.close();
    }
  });
});
