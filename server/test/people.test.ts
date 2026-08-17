import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { startTestServer, resetDb, api, createOwner, type TestServer } from './helpers.js';
import {
  projectMotivation, selfPersonId, createPerson, resolveByEmail, resolveOrCreateByEmail,
  setEntityPeople, attachMachinePeople, getEntityPeople, applyMotivationProjection,
  parseEmail, nameFromEmail, mergePeople, personForAccount, accountRoster, getPerson,
} from '../src/services/people.js';
import { removeEntityTags } from '../src/services/tags.js';

/**
 * People on work (docs/people-on-work.md) — Responsible + Beneficiaries over one model.
 *
 * The gates that actually carry the design:
 *  1. the motivation PROJECTION, especially empty ⇒ NULL (never 'us');
 *  2. `source='user'` always wins — a machine pass never edits a curated set;
 *  3. email→person resolution is OWNER-SCOPED (a cross-tenant address must not match);
 *  4. `us` reaches named people on a single-account install;
 *  5. one person can hold BOTH roles on the same item;
 *  6. no orphans — a hard delete clears entity_people.
 */

const OWNER = SYSTEM_OWNER;
const SECOND = '22222222-2222-7000-8000-000000000002';

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('the motivation projection', () => {
  // The axis's core correctness rule (0141): "shared benefit" is a positive claim,
  // "never asked" is the absence of one. Collapsing them would make the metric lie.
  it('projects an EMPTY beneficiary set to null, never to us', () => {
    expect(projectMotivation([], 'self')).toBeNull();
  });

  it('projects self-only to me, self+others to us, others-only to them', () => {
    expect(projectMotivation(['self'], 'self')).toBe('me');
    expect(projectMotivation(['self', 'p2'], 'self')).toBe('us');
    expect(projectMotivation(['p2', 'p3'], 'self')).toBe('them');
  });

  // Accounts make a set easier to fill; they never gate what the axis can express.
  // "Me and my wife", where the wife has no login, is exactly as much 'us' as a
  // roomful of colleagues.
  it('projects us from named people with no account at all', async () => {
    const self = await selfPersonId(OWNER);
    const wife = await createPerson(OWNER, { display_name: 'Wife', source: 'manual' });
    expect(wife.account_id).toBeNull();
    expect(projectMotivation([self!, wife.id], self)).toBe('us');
  });

  it('writes the derived value onto the task, and back to null when cleared', async () => {
    const self = await selfPersonId(OWNER);
    const mom = await createPerson(OWNER, { display_name: 'Mom' });
    const { body } = await api<{ task: { id: string } }>(srv.url, '/api/tasks', {
      method: 'POST', json: { title: 'Fix her sink' },
    });
    const id = body.task.id;

    await setEntityPeople(OWNER, 'task', id, 'beneficiary', [mom.id]);
    expect(await applyMotivationProjection(OWNER, id)).toBe('them');
    expect(motivationOf(id)).toEqual({ motivation: 'them', motivation_source: 'user' });

    await setEntityPeople(OWNER, 'task', id, 'beneficiary', [self!, mom.id]);
    expect(await applyMotivationProjection(OWNER, id)).toBe('us');

    // Emptying the set genuinely means unlabeled — it must not stick at 'us'.
    await setEntityPeople(OWNER, 'task', id, 'beneficiary', []);
    expect(await applyMotivationProjection(OWNER, id)).toBeNull();
    expect(motivationOf(id)).toEqual({ motivation: null, motivation_source: null });
  });

  // Regression: the projection UPDATEs the row AFTER drizzle's .returning() captured
  // it, so the RESPONSE (and the SSE payload built from it) trailed the database by one
  // write — the DB said 'them' while the client was handed the previous value. Asserting
  // only on the database would not have caught it; this asserts on what the caller sees.
  it('returns the freshly derived motivation, not the pre-write value', async () => {
    const mom = await createPerson(OWNER, { display_name: 'Mom' });
    const self = await selfPersonId(OWNER);

    const created = await api<{ task: { id: string; motivation: string | null } }>(srv.url, '/api/tasks', {
      method: 'POST', json: { title: 'Fresh on create', beneficiary_ids: [mom.id] },
    });
    expect(created.body.task.motivation).toBe('them');

    const patched = await api<{ task: { motivation: string | null } }>(
      srv.url, `/api/tasks/${created.body.task.id}`,
      { method: 'PATCH', json: { beneficiary_ids: [self!, mom.id] } },
    );
    expect(patched.body.task.motivation).toBe('us');

    const cleared = await api<{ task: { motivation: string | null } }>(
      srv.url, `/api/tasks/${created.body.task.id}`,
      { method: 'PATCH', json: { beneficiary_ids: [] } },
    );
    expect(cleared.body.task.motivation).toBeNull();
  });

  it('derives motivation through the task PATCH surface', async () => {
    const mom = await createPerson(OWNER, { display_name: 'Mom' });
    const { body } = await api<{ task: { id: string } }>(srv.url, '/api/tasks', {
      method: 'POST', json: { title: 'Errand' },
    });
    const res = await api(srv.url, `/api/tasks/${body.task.id}`, {
      method: 'PATCH', json: { beneficiary_ids: [mom.id] },
    });
    expect(res.status).toBe(200);
    expect(motivationOf(body.task.id).motivation).toBe('them');
  });
});

describe('provenance — a user-set field is permanent', () => {
  it('refuses a machine attach when any row in that role is user-set', async () => {
    const a = await createPerson(OWNER, { display_name: 'Ann' });
    const b = await createPerson(OWNER, { display_name: 'Bob' });
    const id = await newTask('Curated');

    await setEntityPeople(OWNER, 'task', id, 'responsible', [a.id], 'user');
    // A set the user curated is owned WHOLE — appending a guess to a list somebody
    // deliberately pruned would be worse than staying quiet.
    const wrote = await attachMachinePeople(OWNER, 'task', id, 'responsible', [b.id], 'calendar');
    expect(wrote).toBe(false);
    expect((await getEntityPeople('task', id)).responsible.map((p) => p.id)).toEqual([a.id]);
  });

  it('allows a machine attach onto an untouched role, and scopes the guard per-role', async () => {
    const a = await createPerson(OWNER, { display_name: 'Ann' });
    const b = await createPerson(OWNER, { display_name: 'Bob' });
    const id = await newTask('Half curated');

    await setEntityPeople(OWNER, 'task', id, 'beneficiary', [a.id], 'user');
    // 'responsible' is untouched, so the machine may still fill it.
    expect(await attachMachinePeople(OWNER, 'task', id, 'responsible', [b.id], 'calendar')).toBe(true);
    const people = await getEntityPeople('task', id);
    expect(people.responsible.map((p) => p.id)).toEqual([b.id]);
    expect(people.beneficiaries.map((p) => p.id)).toEqual([a.id]);
  });
});

describe('email resolution is owner-scoped', () => {
  it('never matches an identical address in another tenant’s directory', async () => {
    createOwner(SECOND, 'Owner B');
    const mine = await createPerson(OWNER, { display_name: 'Shared Address', emails: ['dup@example.com'] });
    const theirs = await createPerson(SECOND, { display_name: 'Their Person', emails: ['dup@example.com'] });
    expect(mine.id).not.toBe(theirs.id);

    expect(await resolveByEmail(OWNER, 'dup@example.com')).toBe(mine.id);
    expect(await resolveByEmail(SECOND, 'dup@example.com')).toBe(theirs.id);
  });

  it('parses the header shapes mail and calendar actually send', () => {
    expect(parseEmail('"Alex Hartman" <alex@example.com>')).toBe('alex@example.com');
    expect(parseEmail('<alex@example.com>')).toBe('alex@example.com');
    expect(parseEmail('  ALEX@Example.COM ')).toBe('alex@example.com');
    expect(parseEmail('not an address')).toBeNull();
    expect(parseEmail(null)).toBeNull();
  });

  it('names an unknown address without inventing anything', () => {
    expect(nameFromEmail('"Chris Chamberlain" <c@x.com>')).toBe('Chris Chamberlain');
    expect(nameFromEmail('alex.hartman@example.com')).toBe('Alex Hartman');
  });

  it('creates provisional entries as unconfirmed, and only on demand', async () => {
    const id = await resolveOrCreateByEmail(OWNER, 'new.person@example.com', 'gcal');
    const rows = sqlite
      .prepare(`SELECT display_name, confirmed, source FROM people WHERE id = ?`)
      .all(id) as { display_name: string; confirmed: number; source: string }[];
    expect(rows[0]).toEqual({ display_name: 'New Person', confirmed: 0, source: 'gcal' });
    // Idempotent: a second sighting resolves to the same row, not a duplicate.
    expect(await resolveOrCreateByEmail(OWNER, 'new.person@example.com', 'gcal')).toBe(id);
  });

  it('leaves an address pointing at whoever already owns it', async () => {
    const first = await createPerson(OWNER, { display_name: 'First', emails: ['x@example.com'] });
    const second = await createPerson(OWNER, { display_name: 'Second', emails: ['x@example.com'] });
    // Silently reassigning would rewrite history on every task `first` is named on.
    expect(await resolveByEmail(OWNER, 'x@example.com')).toBe(first.id);
    expect(second.emails).toEqual([]);
  });
});

describe('accounts vs named people', () => {
  it('never lists the system sentinel as a pickable account', async () => {
    // It is not a login anybody has; listOwners excludes it for the same reason.
    expect((await accountRoster(OWNER)).map((r) => r.account_id)).not.toContain(
      '00000000-0000-7000-8000-000000000001',
    );
  });

  it('still reaches us with an EMPTY roster — the single-account case', async () => {
    // The whole point of the correction: `us` means you + another person, not you +
    // another *account*. With no roster to pre-fill from, the picker falls back to
    // named people and the axis still reaches 'us'. (In this suite the tenant IS the
    // sentinel, so the roster is genuinely empty — exactly the case under test.)
    expect(await accountRoster(OWNER)).toEqual([]);

    const self = await selfPersonId(OWNER);
    const wife = await createPerson(OWNER, { display_name: 'Wife' });
    const id = await newTask('Plan the trip');
    await setEntityPeople(OWNER, 'task', id, 'beneficiary', [self!, wife.id]);
    expect(await applyMotivationProjection(OWNER, id)).toBe('us');
  });

  it('lists a real second account, self first', async () => {
    createOwner(SECOND, 'Owner B');
    expect((await accountRoster(SECOND)).map((r) => r.account_id)).toEqual([SECOND]);
  });

  it('materializes an account into the directory only when picked, idempotently', async () => {
    createOwner(SECOND, 'Owner B');
    expect((await accountRoster(OWNER)).find((r) => r.account_id === SECOND)?.person_id).toBeNull();

    const first = await personForAccount(OWNER, SECOND);
    const again = await personForAccount(OWNER, SECOND);
    expect(first!.id).toBe(again!.id);
    expect(first!.account_id).toBe(SECOND);
    expect(first!.is_self).toBe(false);
  });

  it('derives is_self rather than storing it', async () => {
    const self = await selfPersonId(OWNER);
    const { body } = await api<{ people: { id: string; is_self: boolean }[] }>(srv.url, '/api/people');
    expect(body.people.find((p) => p.id === self)!.is_self).toBe(true);
  });

  it('refuses to delete the self row through the API', async () => {
    const self = await selfPersonId(OWNER);
    const res = await api(srv.url, `/api/people/${self}`, { method: 'DELETE' });
    expect(res.status).toBe(422);
  });

  it('does not let a client claim an account link', async () => {
    const res = await api<{ person: { account_id: string | null } }>(srv.url, '/api/people', {
      method: 'POST', json: { display_name: 'Impostor', account_id: SECOND },
    });
    expect(res.status).toBe(201);
    expect(res.body.person.account_id).toBeNull();
  });
});

describe('the shared model', () => {
  it('lets one person hold BOTH roles on the same item', async () => {
    // You are usually both responsible for and a beneficiary of your own work — which
    // is exactly why `role` is in the primary key.
    const self = await selfPersonId(OWNER);
    const id = await newTask('Go to the gym');
    await setEntityPeople(OWNER, 'task', id, 'responsible', [self!]);
    await setEntityPeople(OWNER, 'task', id, 'beneficiary', [self!]);
    const people = await getEntityPeople('task', id);
    expect(people.responsible.map((p) => p.id)).toEqual([self]);
    expect(people.beneficiaries.map((p) => p.id)).toEqual([self]);
  });

  it('keeps array order as position, so index 0 is the lead', async () => {
    const a = await createPerson(OWNER, { display_name: 'Ann' });
    const b = await createPerson(OWNER, { display_name: 'Bob' });
    const id = await newTask('Two on it');
    await setEntityPeople(OWNER, 'task', id, 'responsible', [b.id, a.id]);
    expect((await getEntityPeople('task', id)).responsible.map((p) => p.display_name)).toEqual(['Bob', 'Ann']);
  });

  it('drops a borrowed person id from another tenant', async () => {
    createOwner(SECOND, 'Owner B');
    const theirs = await createPerson(SECOND, { display_name: 'Not Mine' });
    const id = await newTask('Mine');
    await setEntityPeople(OWNER, 'task', id, 'responsible', [theirs.id]);
    expect((await getEntityPeople('task', id)).responsible).toEqual([]);
  });

  it('merges a duplicate, moving attachments and surviving a both-on-one-task collision', async () => {
    const keep = await createPerson(OWNER, { display_name: 'Alex Hartman' });
    const dup = await createPerson(OWNER, { display_name: 'A. Hartman', emails: ['a@example.com'] });
    const id = await newTask('Both named');
    // Both on the SAME task in the SAME role — a plain UPDATE would violate the PK.
    await setEntityPeople(OWNER, 'task', id, 'responsible', [keep.id, dup.id]);

    const merged = await mergePeople(OWNER, keep.id, dup.id);
    expect(merged!.id).toBe(keep.id);
    expect(merged!.emails).toEqual(['a@example.com']);
    expect((await getEntityPeople('task', id)).responsible.map((p) => p.id)).toEqual([keep.id]);
  });

  it('exposes both sets on the task read surface', async () => {
    const mom = await createPerson(OWNER, { display_name: 'Mom' });
    const id = await newTask('Read surface');
    await setEntityPeople(OWNER, 'task', id, 'beneficiary', [mom.id]);
    const { body } = await api<{ tasks: { id: string; beneficiaries: { id: string }[] }[] }>(srv.url, '/api/tasks');
    const row = body.tasks.find((t) => t.id === id)!;
    expect(row.beneficiaries.map((p) => p.id)).toEqual([mom.id]);
  });
});

describe('no orphans', () => {
  it('clears entity_people on a hard delete, through the shared tag seam', async () => {
    const p = await createPerson(OWNER, { display_name: 'Someone' });
    const id = await newTask('Doomed');
    await setEntityPeople(OWNER, 'task', id, 'responsible', [p.id]);

    // removeEntityTags is the cascade primitive every hard-delete path calls; people
    // ride it so no delete site can clean tags and orphan people.
    await removeEntityTags('task', id);
    expect((await getEntityPeople('task', id)).responsible).toEqual([]);
  });

  it('takes attachments with a deleted person', async () => {
    const p = await createPerson(OWNER, { display_name: 'Transient' });
    const id = await newTask('Attached');
    await setEntityPeople(OWNER, 'task', id, 'responsible', [p.id]);
    await api(srv.url, `/api/people/${p.id}`, { method: 'DELETE' });
    expect((await getEntityPeople('task', id)).responsible).toEqual([]);
  });
});

// ── helpers ───────────────────────────────────────────────────────────────────

function motivationOf(taskId: string): { motivation: string | null; motivation_source: string | null } {
  return sqlite
    .prepare(`SELECT motivation, motivation_source FROM tasks WHERE id = ?`)
    .get(taskId) as { motivation: string | null; motivation_source: string | null };
}

async function newTask(title: string): Promise<string> {
  const { body } = await api<{ task: { id: string } }>(srv.url, '/api/tasks', { method: 'POST', json: { title } });
  return body.task.id;
}

/**
 * Review fixes (PR #574). Each of these pins a defect the first pass shipped — several
 * of them passed their original tests because those asserted on the database while the
 * bug lived one layer out.
 */
describe('review fixes', () => {
  it('returns FRESH arrays for an empty result — no shared module state', async () => {
    // `{ ...EMPTY }` off a module constant is a shallow copy: both callers got the SAME
    // two arrays, so one mutation poisoned every later empty result process-wide.
    const a = await getEntityPeople('task', 'no-such-task-a');
    a.responsible.push({ id: 'x' } as never);
    const b = await getEntityPeople('task', 'no-such-task-b');
    expect(b.responsible).toEqual([]);
    expect(b.beneficiaries).toEqual([]);
  });

  it('resolves an ACCOUNT address to that account, never a duplicate person', async () => {
    // person_emails is only seeded when owners.email is set, and it routinely is not —
    // so the owner's own address was unresolvable and promotion minted a second,
    // is_self:false "you", which then projected 'them' for their own work.
    sqlite.prepare(`UPDATE owners SET email = 'me@example.com' WHERE id = ?`).run(OWNER);
    const self = await selfPersonId(OWNER);

    const resolved = await resolveOrCreateByEmail(OWNER, '"Me" <me@example.com>', 'calendar');
    expect(resolved).toBe(self);
    expect(
      (sqlite.prepare(`SELECT COUNT(*) AS n FROM people WHERE owner_id = ?`).get(OWNER) as { n: number }).n,
    ).toBe(1); // still just the self row — nobody invented
  });

  it('does NOT adopt a same-named stranger as an account', async () => {
    createOwner(SECOND, 'Chris');
    const neighbour = await createPerson(OWNER, { display_name: 'Chris', emails: ['neighbour@example.com'] });

    const account = await personForAccount(OWNER, SECOND);
    // A name match is not identity — merging them would retroactively relabel every
    // task the neighbour was on.
    expect(account!.id).not.toBe(neighbour.id);
    expect(account!.display_name).toBe('Chris (2)');
    expect((await getPerson(OWNER, neighbour.id))!.account_id).toBeNull();
  });

  it('skips junk that parseEmail rejected instead of storing it', async () => {
    const p = await createPerson(OWNER, { display_name: 'Junk', emails: ['not an address', 'ok@example.com'] });
    expect(p.emails).toEqual(['ok@example.com']);
  });

  it('carries emails and the ATTACHMENT provenance on entity reads', async () => {
    const mom = await createPerson(OWNER, { display_name: 'Mom', emails: ['mom@example.com'] });
    const id = await newTask('With provenance');
    await setEntityPeople(OWNER, 'task', id, 'responsible', [mom.id], 'user');
    await setEntityPeople(OWNER, 'task', id, 'beneficiary', [mom.id], 'calendar');

    const people = await getEntityPeople('task', id);
    // emails were always [] here, despite the type (and the GraphQL SDL) promising them.
    expect(people.responsible[0].emails).toEqual(['mom@example.com']);
    // The attachment's source is what tells a curated set from a detected one; the
    // directory row's own `source` cannot.
    expect(people.responsible[0].attachment_source).toBe('user');
    expect(people.beneficiaries[0].attachment_source).toBe('calendar');
    expect(people.responsible[0].source).toBe('manual'); // the row's own origin, unchanged
  });
});
