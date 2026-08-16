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
    expect(people.responsible.map((p) => p.id)).toEqual([chris.id]);
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
    expect(people.responsible.map((p) => p.display_name)).toEqual(['Dana Reyes']);
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

    expect((await getEntityPeople('task', res.taskId)).responsible.map((p) => p.id)).toEqual([dana.id]);
    expect((sqlite.prepare(`SELECT COUNT(*) AS n FROM people WHERE owner_id = ?`).get(SYSTEM_OWNER) as { n: number }).n)
      .toBe(2); // self + Dana, no duplicate
  });
});
