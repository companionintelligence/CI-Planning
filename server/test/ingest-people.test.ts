import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { ALL_SCOPES, SYSTEM_OWNER, runWithOwner } from '../src/lib/context.js';
import type { GoogleClient, CalendarEvent, EmailMessage } from '../src/mcp/google.js';

// Deterministic extraction — one task per event, so the assertions are about PEOPLE.
vi.mock('../src/agents/extract.js', () => ({
  extractTasks: vi.fn(async (source: { subject?: string; text: string }) => [
    {
      title: (source.subject ?? source.text).slice(0, 200) || 'Prep',
      summary: undefined, priority: 3, dueAt: null, estimatedMinutes: null, tags: [], confidence: 0.9,
    },
  ]),
}));

import { ingestEvents, ingestEmails } from '../src/agents/ingest.js';
import { createPerson, getEntityPeople, selfPersonId } from '../src/services/people.js';
import { promotePossible } from '../src/services/possibles.js';

/**
 * People detection at ingest (0151) — "when new tasks come in, identify who is involved".
 *
 * The load-bearing policy: ingest reads far more than the owner ever promotes, so it
 * RESOLVES against the existing directory but never CREATES. Unknown addresses wait as
 * hints on source_payload and become people only at promotion.
 *
 * Deliberately RESPONSIBLE only. Who is on an invite is observable; who the work is FOR
 * is a judgment nothing in the invite states, so beneficiaries are left to the owner and
 * the existing motivation classifier.
 */

function fakeClient(events: CalendarEvent[] = [], emails: EmailMessage[] = []): GoogleClient {
  return {
    mode: 'fixture',
    async listEmails() { return emails; },
    async listEvents() { return events; },
  };
}

const email = (over: Partial<EmailMessage> = {}): EmailMessage => ({
  id: 'msg-1', from: '"Dana Reyes" <dana@example.com>', subject: 'Can you review the draft?',
  body: 'Please take a look before Friday.', receivedAt: new Date().toISOString(), ...over,
});

const run = <T>(fn: () => Promise<T>) => runWithOwner(SYSTEM_OWNER, ALL_SCOPES, fn);

function futureDate(daysAhead: number, hourOffset = 0): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysAhead);
  d.setUTCHours(9 + hourOffset, 0, 0, 0);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

const event = (over: Partial<CalendarEvent> = {}): CalendarEvent => ({
  id: 'evt-1', title: 'Quarterly review', description: 'Bring the deck',
  start: futureDate(1), end: futureDate(1, 1), ...over,
});

beforeEach(() => {
  sqlite.exec(`
    DELETE FROM possible_task_people; DELETE FROM possible_task_tags; DELETE FROM possible_tasks;
    DELETE FROM entity_people; DELETE FROM time_blocks; DELETE FROM tasks; DELETE FROM tags;
    DELETE FROM person_emails;
    DELETE FROM people WHERE account_id IS NULL OR account_id <> owner_id;
  `);
});

describe('resolving known people (calendar)', () => {
  it('attaches an attendee already in the directory as responsible', async () => {
    const chris = await createPerson(SYSTEM_OWNER, {
      display_name: 'Chris', emails: ['chris@example.com'],
    });

    await run(() => ingestEvents(fakeClient([event({ attendees: ['"Chris" <chris@example.com>'] })])));

    // gcal is NOT review-gated: ingestEvents auto-promotes the batch (AF-3), so the
    // people land straight on the real task. Assert there rather than on the
    // intermediate possible, which no longer exists as 'pending'.
    const taskId = (sqlite.prepare(`SELECT id FROM tasks LIMIT 1`).get() as { id: string }).id;
    const people = await getEntityPeople('task', taskId);
    // The owner leads (position 0) and the detected attendee follows — it is their planner.
    expect(people.responsible.map((p) => p.display_name)).toEqual(['System', 'Chris']);
    expect(people.responsible[1].id).toBe(chris.id);
    // Who the work is FOR is never guessed from an invite.
    expect(people.beneficiaries).toEqual([]);
  });

  it('never attaches the owner to their own item', async () => {
    const self = await selfPersonId(SYSTEM_OWNER);
    sqlite
      .prepare(`INSERT INTO person_emails (owner_id, person_id, email) VALUES (?, ?, 'me@example.com')`)
      .run(SYSTEM_OWNER, self);

    await run(() => ingestEvents(fakeClient([event({ attendees: ['me@example.com'] })])));
    const taskId = (sqlite.prepare(`SELECT id FROM tasks LIMIT 1`).get() as { id: string }).id;
    expect((await getEntityPeople('task', taskId)).responsible).toEqual([]);
  });

  it('ignores an event with no people at all', async () => {
    await run(() => ingestEvents(fakeClient([event()])));
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM entity_people`).get() as { n: number }).n).toBe(0);
  });

  it('creates an unknown attendee as PROVISIONAL, because the item became a task', async () => {
    await run(() => ingestEvents(fakeClient([event({ attendees: ['"Dana Reyes" <dana@example.com>'] })])));
    const dana = sqlite
      .prepare(`SELECT confirmed, source FROM people WHERE display_name = 'Dana Reyes'`)
      .get() as { confirmed: number; source: string } | undefined;
    // confirmed = 0 is what makes this reviewable in Settings → People rather than
    // silently indistinguishable from someone the owner added deliberately.
    expect(dana).toEqual({ confirmed: 0, source: 'calendar' });
  });
});

describe('the review-gated path never grows the directory (email)', () => {
  // Email is where the volume is, and it is the ONLY review-gated source — so this is
  // the case the "resolve, never create, while scanning" policy actually protects.
  it('stashes an unknown sender as a hint and creates nobody', async () => {
    await run(() => ingestEmails(fakeClient([], [email()])));

    expect(
      (sqlite.prepare(`SELECT COUNT(*) AS n FROM people WHERE display_name = 'Dana Reyes'`).get() as { n: number }).n,
    ).toBe(0);

    const row = sqlite.prepare(`SELECT status, source_payload AS p FROM possible_tasks LIMIT 1`).get() as
      | { status: string; p: string }
      | undefined;
    expect(row?.status).toBe('pending'); // held for review, exactly as before
    expect(JSON.parse(row!.p).people_hints).toEqual(['"Dana Reyes" <dana@example.com>']);
  });

  it('creates the person only once the owner approves', async () => {
    await run(() => ingestEmails(fakeClient([], [email()])));
    const possible = sqlite.prepare(`SELECT id FROM possible_tasks LIMIT 1`).get() as { id: string };

    const res = await run(() => promotePossible(SYSTEM_OWNER, possible.id));
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const people = await getEntityPeople('task', res.taskId);
    expect(people.responsible.map((p) => p.display_name)).toEqual(['System', 'Dana Reyes']);
    const dana = sqlite
      .prepare(`SELECT confirmed, source FROM people WHERE display_name = 'Dana Reyes'`)
      .get() as { confirmed: number; source: string };
    expect(dana).toEqual({ confirmed: 0, source: 'email' });
  });

  it('reuses a sender already in the directory instead of duplicating them', async () => {
    const dana = await createPerson(SYSTEM_OWNER, { display_name: 'Dana R', emails: ['dana@example.com'] });
    await run(() => ingestEmails(fakeClient([], [email()])));
    const possible = sqlite.prepare(`SELECT id FROM possible_tasks LIMIT 1`).get() as { id: string };
    const res = await run(() => promotePossible(SYSTEM_OWNER, possible.id));
    if (!res.ok) throw new Error('promote failed');

    const resp = (await getEntityPeople('task', res.taskId)).responsible;
    expect(resp.map((p) => p.display_name)).toEqual(['System', 'Dana R']); // owner leads
    expect(resp[1].id).toBe(dana.id);
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM people WHERE owner_id = ?`).get(SYSTEM_OWNER) as { n: number }).n)
      .toBe(2); // self + Dana, no duplicate
  });
});

/**
 * Review fixes (PR #574).
 */
describe('review fixes', () => {
  it('puts the OWNER first on a promoted task — it is their planner', async () => {
    // Ingest skips self when recording detections; promotion is where they come back.
    // Without this a calendar-detected task listed the attendees and left the owner off
    // their own work, so "what am I on the hook for" would never match it.
    await createPerson(SYSTEM_OWNER, { display_name: 'Chris', emails: ['chris@example.com'] });
    await run(() => ingestEvents(fakeClient([event({ attendees: ['chris@example.com'] })])));

    const taskId = (sqlite.prepare(`SELECT id FROM tasks LIMIT 1`).get() as { id: string }).id;
    const people = await getEntityPeople('task', taskId);
    expect(people.responsible.map((p) => p.display_name)).toEqual(['System', 'Chris']);
    expect(people.responsible[0].is_self).toBe(true); // position 0 = the lead
  });

  it('drops an attendee who was uninvited between ingests', async () => {
    await createPerson(SYSTEM_OWNER, { display_name: 'Chris', emails: ['chris@example.com'] });
    await createPerson(SYSTEM_OWNER, { display_name: 'Dana', emails: ['dana@example.com'] });

    // First pass: both on the invite.
    await run(() => ingestEmails(fakeClient([], [email({ from: 'chris@example.com' })])));
    let rows = sqlite.prepare(`SELECT COUNT(*) AS n FROM possible_task_people`).get() as { n: number };
    expect(rows.n).toBe(1);

    // Second pass: the SAME message id now reports a different sender. Detection is
    // INSERT-only no longer — a stale person must not survive the re-ingest.
    sqlite.prepare(`DELETE FROM sync_state`).run(); // replay the same window
    await run(() => ingestEmails(fakeClient([], [email({ from: 'dana@example.com' })])));
    const names = sqlite
      .prepare(
        `SELECT p.display_name AS n FROM possible_task_people ptp JOIN people p ON p.id = ptp.person_id`,
      )
      .all() as { n: string }[];
    expect(names.map((r) => r.n)).toEqual(['Dana']);
  });

  it('clears stale hints when an event loses its unknown attendees', async () => {
    await run(() => ingestEmails(fakeClient([], [email({ from: 'stranger@example.com' })])));
    expect(JSON.parse((sqlite.prepare(`SELECT source_payload AS p FROM possible_tasks LIMIT 1`).get() as { p: string }).p).people_hints)
      .toEqual(['stranger@example.com']);

    await createPerson(SYSTEM_OWNER, { display_name: 'Known', emails: ['known@example.com'] });
    sqlite.prepare(`DELETE FROM sync_state`).run();
    await run(() => ingestEmails(fakeClient([], [email({ from: 'known@example.com' })])));
    // Written even when EMPTY — otherwise the old hint would be promoted later.
    expect(JSON.parse((sqlite.prepare(`SELECT source_payload AS p FROM possible_tasks LIMIT 1`).get() as { p: string }).p).people_hints)
      .toEqual([]);
  });
});
