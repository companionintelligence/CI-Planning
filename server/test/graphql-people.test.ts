import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { createTask as svcCreateTask } from '../src/services/tasks.js';
import { createBlock as svcCreateBlock } from '../src/services/blocks.js';
import { createPerson, selfPersonId, setEntityPeople, getEntityPeople } from '../src/services/people.js';
import { sqlite } from '../src/db/index.js';

/**
 * People on work (0151) over GraphQL — the SDL wiring for one model exposed as two
 * peer fields, on BOTH TaskType and TimeBlockType, plus the directory queries.
 *
 * The block cases are the interesting ones: a task-backed block with no people of its
 * own inherits its task's, each set independently.
 */
let srv: TestServer;

async function gql(query: string) {
  const res = await fetch(`${srv.url}/api/graphql`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return (await res.json()) as { data?: any; errors?: { message: string }[] };
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

async function seedTask(title: string): Promise<string> {
  const res = await svcCreateTask(SYSTEM_OWNER, { title });
  if (!res.ok) throw new Error('seed failed');
  return res.task.id;
}

describe('directory queries', () => {
  it('lists people with isSelf derived', async () => {
    const self = await selfPersonId(SYSTEM_OWNER);
    await createPerson(SYSTEM_OWNER, { display_name: 'Mom', emails: ['mom@example.com'] });
    const { data, errors } = await gql(`{ people { id displayName isSelf confirmed emails } }`);
    expect(errors).toBeUndefined();
    expect(data.people.find((p: any) => p.id === self).isSelf).toBe(true);
    const mom = data.people.find((p: any) => p.displayName === 'Mom');
    expect(mom).toMatchObject({ isSelf: false, confirmed: true, emails: ['mom@example.com'] });
  });

  it('exposes the minimal account roster', async () => {
    createOwner(SECOND_OWNER_ID, 'Owner B');
    const { data, errors } = await gql(`{ accountRoster { accountId name personId } }`);
    expect(errors).toBeUndefined();
    // Minimal by design — no email, no role. Not yet materialized, so personId is null.
    expect(data.accountRoster).toContainEqual({ accountId: SECOND_OWNER_ID, name: 'Owner B', personId: null });
  });

  it('hides another tenant’s person', async () => {
    createOwner(SECOND_OWNER_ID, 'Owner B');
    const theirs = await createPerson(SECOND_OWNER_ID, { display_name: 'Theirs' });
    const { data } = await gql(`{ person(id: "${theirs.id}") { id } }`);
    expect(data.person).toBeNull();
  });
});

describe('both sets on a task', () => {
  it('returns responsible and beneficiaries, and the derived motivation', async () => {
    const self = await selfPersonId(SYSTEM_OWNER);
    const mom = await createPerson(SYSTEM_OWNER, { display_name: 'Mom' });
    const id = await seedTask('Fix her sink');
    await setEntityPeople(SYSTEM_OWNER, 'task', id, 'responsible', [self!]);
    await setEntityPeople(SYSTEM_OWNER, 'task', id, 'beneficiary', [mom.id]);

    const { data, errors } = await gql(
      `{ task(id: "${id}") { responsible { displayName } beneficiaries { displayName } } }`,
    );
    expect(errors).toBeUndefined();
    expect(data.task.responsible.map((p: any) => p.displayName)).toEqual(['System']);
    expect(data.task.beneficiaries.map((p: any) => p.displayName)).toEqual(['Mom']);
  });

  it('writes both sets through createTask and derives motivation from beneficiaries', async () => {
    const self = await selfPersonId(SYSTEM_OWNER);
    const mom = await createPerson(SYSTEM_OWNER, { display_name: 'Mom' });
    const { data, errors } = await gql(`mutation {
      createTask(input: {
        title: "Groceries for mum"
        responsibleIds: ["${self}"]
        beneficiaryIds: ["${mom.id}"]
      }) { task { id motivation responsible { displayName } beneficiaries { displayName } } success }
    }`);
    expect(errors).toBeUndefined();
    expect(data.createTask.task.motivation).toBe('THEM');
    expect(data.createTask.task.responsible).toEqual([{ displayName: 'System' }]);
    expect(data.createTask.task.beneficiaries).toEqual([{ displayName: 'Mom' }]);
  });

  it('re-derives motivation to null when beneficiaries are cleared', async () => {
    const mom = await createPerson(SYSTEM_OWNER, { display_name: 'Mom' });
    const id = await seedTask('Errand');
    await gql(`mutation { updateTask(input: { id: "${id}", beneficiaryIds: ["${mom.id}"] }) { success } }`);
    const before = await gql(`{ task(id: "${id}") { motivation } }`);
    expect(before.data.task.motivation).toBe('THEM');

    await gql(`mutation { updateTask(input: { id: "${id}", beneficiaryIds: [] }) { success } }`);
    const after = await gql(`{ task(id: "${id}") { motivation } }`);
    // Emptying the set means unlabeled — it must not stick at THEM.
    expect(after.data.task.motivation).toBeNull();
  });
});

describe('blocks inherit from their task', () => {
  it('inherits each set independently, and own rows win', async () => {
    const self = await selfPersonId(SYSTEM_OWNER);
    const mom = await createPerson(SYSTEM_OWNER, { display_name: 'Mom' });
    const colleague = await createPerson(SYSTEM_OWNER, { display_name: 'Chris' });
    const taskId = await seedTask('Backed task');
    await setEntityPeople(SYSTEM_OWNER, 'task', taskId, 'responsible', [self!]);
    await setEntityPeople(SYSTEM_OWNER, 'task', taskId, 'beneficiary', [mom.id]);

    const res = await svcCreateBlock(SYSTEM_OWNER, {
      title: 'Do it', task_id: taskId,
      start_at: '2026-06-22T09:00:00.000Z', end_at: '2026-06-22T10:00:00.000Z',
    });
    if (!res.ok) throw new Error('block seed failed');
    const blockId = res.block.id;

    const inherited = await gql(
      `{ timeBlock(id: "${blockId}") { responsible { displayName } beneficiaries { displayName } } }`,
    );
    expect(inherited.data.timeBlock.responsible.map((p: any) => p.displayName)).toEqual(['System']);
    expect(inherited.data.timeBlock.beneficiaries.map((p: any) => p.displayName)).toEqual(['Mom']);

    // Give the BLOCK its own attendee list; beneficiaries must still inherit.
    await setEntityPeople(SYSTEM_OWNER, 'time_block', blockId, 'responsible', [colleague.id]);
    const mixed = await gql(
      `{ timeBlock(id: "${blockId}") { responsible { displayName } beneficiaries { displayName } } }`,
    );
    expect(mixed.data.timeBlock.responsible.map((p: any) => p.displayName)).toEqual(['Chris']);
    expect(mixed.data.timeBlock.beneficiaries.map((p: any) => p.displayName)).toEqual(['Mom']);
  });
});

/**
 * Review fixes (PR #574) — a task-backed block must be able to say "nobody".
 * "No rows" used to mean BOTH "never set, inherit" and "deliberately cleared", so
 * removing the last chip silently restored the task's people.
 */
describe('per-role pinning (0154)', () => {
  it('pinning one role leaves the OTHER still inheriting', async () => {
    // The 0153 regression: one flag for the whole block meant stating a meeting's
    // attendees also pinned its empty beneficiary set, silently ending inheritance for
    // a field the user never touched.
    const self = await selfPersonId(SYSTEM_OWNER);
    const mom = await createPerson(SYSTEM_OWNER, { display_name: 'Mom' });
    const chris = await createPerson(SYSTEM_OWNER, { display_name: 'Chris' });
    const taskId = await seedTask('Backing');
    await setEntityPeople(SYSTEM_OWNER, 'task', taskId, 'responsible', [self!]);
    await setEntityPeople(SYSTEM_OWNER, 'task', taskId, 'beneficiary', [mom.id]);

    const made = await svcCreateBlock(SYSTEM_OWNER, {
      title: 'Standup', task_id: taskId,
      start_at: '2026-06-22T09:00:00.000Z', end_at: '2026-06-22T10:00:00.000Z',
      responsible_ids: [chris.id], // ONLY responsible stated
    });
    if (!made.ok) throw new Error('seed failed');
    expect((made.api.responsible as { display_name: string }[]).map((p) => p.display_name)).toEqual(['Chris']);
    // Beneficiaries were never mentioned, so they still track the task.
    expect((made.api.beneficiaries as { display_name: string }[]).map((p) => p.display_name)).toEqual(['Mom']);
  });

  it('null resumes inheriting — a pin is reversible', async () => {
    // Without an unpin path a block that once had people could never track its task
    // again, and 0153's own doc promised otherwise.
    const self = await selfPersonId(SYSTEM_OWNER);
    const chris = await createPerson(SYSTEM_OWNER, { display_name: 'Chris' });
    const taskId = await seedTask('Backing');
    await setEntityPeople(SYSTEM_OWNER, 'task', taskId, 'responsible', [self!]);

    const made = await svcCreateBlock(SYSTEM_OWNER, {
      title: 'Standup', task_id: taskId,
      start_at: '2026-06-22T09:00:00.000Z', end_at: '2026-06-22T10:00:00.000Z',
      responsible_ids: [chris.id],
    });
    if (!made.ok) throw new Error('seed failed');

    const { updateBlock } = await import('../src/services/blocks.js');
    const cleared = await updateBlock(SYSTEM_OWNER, made.block.id, { responsible_ids: [] });
    if (!cleared.ok) throw new Error('clear failed');
    expect(cleared.api.responsible).toEqual([]); // nobody — pinned

    const unpinned = await updateBlock(SYSTEM_OWNER, made.block.id, { responsible_ids: null });
    if (!unpinned.ok) throw new Error('unpin failed');
    expect((unpinned.api.responsible as { display_name: string }[]).map((p) => p.display_name)).toEqual(['System']);
  });
});

describe('a block can express nobody', () => {
  it('inherits by default, keeps an explicit clear, and keeps an explicit set', async () => {
    const self = await selfPersonId(SYSTEM_OWNER);
    const chris = await createPerson(SYSTEM_OWNER, { display_name: 'Chris' });
    const taskId = await seedTask('Backing task');
    await setEntityPeople(SYSTEM_OWNER, 'task', taskId, 'responsible', [self!]);

    const made = await svcCreateBlock(SYSTEM_OWNER, {
      title: 'Standup', task_id: taskId,
      start_at: '2026-06-22T09:00:00.000Z', end_at: '2026-06-22T10:00:00.000Z',
    });
    if (!made.ok) throw new Error('block seed failed');
    // Default: no rows of its own ⇒ inherit.
    expect((made.api.responsible as { display_name: string }[]).map((p) => p.display_name)).toEqual(['System']);

    const { updateBlock } = await import('../src/services/blocks.js');
    const cleared = await updateBlock(SYSTEM_OWNER, made.block.id, { responsible_ids: [] });
    if (!cleared.ok) throw new Error('clear failed');
    // The fix: an explicit clear STICKS instead of falling back to the task.
    expect(cleared.api.responsible).toEqual([]);

    const set = await updateBlock(SYSTEM_OWNER, made.block.id, { responsible_ids: [chris.id] });
    if (!set.ok) throw new Error('set failed');
    expect((set.api.responsible as { display_name: string }[]).map((p) => p.display_name)).toEqual(['Chris']);

    // And the pin survives a re-read through the list path, not just the write response.
    const { data } = await gql(`{ timeBlock(id: "${made.block.id}") { responsible { displayName } } }`);
    expect(data.timeBlock.responsible.map((p: any) => p.displayName)).toEqual(['Chris']);
  });
});

/**
 * Review fixes (PR #574, round 3) — GraphQL could READ a block's people but had no
 * input to write them, so a GraphQL-only client had to fall back to REST.
 */
describe('block people over GraphQL', () => {
  it('writes both sets on create, and expresses all three states on update', async () => {
    const self = await selfPersonId(SYSTEM_OWNER);
    const chris = await createPerson(SYSTEM_OWNER, { display_name: 'Chris' });
    const taskId = await seedTask('Backing');
    await setEntityPeople(SYSTEM_OWNER, 'task', taskId, 'responsible', [self!]);

    const made = await gql(`mutation {
      createTimeBlock(input: {
        title: "Standup"
        taskId: "${taskId}"
        startAt: "2026-06-22T09:00:00.000Z"
        endAt: "2026-06-22T10:00:00.000Z"
        responsibleIds: ["${chris.id}"]
      }) { timeBlock { id responsible { displayName } beneficiaries { displayName } } success }
    }`);
    expect(made.errors).toBeUndefined();
    const blockId = made.data.createTimeBlock.timeBlock.id;
    expect(made.data.createTimeBlock.timeBlock.responsible.map((p: any) => p.displayName)).toEqual(['Chris']);

    // [] pins to nobody.
    const cleared = await gql(
      `mutation { updateTimeBlock(input: { id: "${blockId}", responsibleIds: [] }) { timeBlock { responsible { displayName } } success } }`,
    );
    expect(cleared.errors).toBeUndefined();
    expect(cleared.data.updateTimeBlock.timeBlock.responsible).toEqual([]);

    // null resumes inheriting — the third state a plain array cannot carry.
    const inherited = await gql(
      `mutation { updateTimeBlock(input: { id: "${blockId}", responsibleIds: null }) { timeBlock { responsible { displayName } } success } }`,
    );
    expect(inherited.errors).toBeUndefined();
    expect(inherited.data.updateTimeBlock.timeBlock.responsible.map((p: any) => p.displayName)).toEqual(['System']);
  });
});

/**
 * Recurring instances take the template's people at materialisation and keep them —
 * copy-on-create, exactly like tags and categories. Pinned so the copy itself cannot
 * regress; the KNOWN limitation (a template edit does not reach already-materialised
 * occurrences) is documented in blocks-recur.ts rather than papered over here.
 */
describe('recurring instances carry their template’s people', () => {
  it('copies people and pins onto each new instance', async () => {
    const { ensureRecurringBlocksForRange } = await import('../src/engine/blocks-recur.js');
    const chris = await createPerson(SYSTEM_OWNER, { display_name: 'Chris' });
    const day = (n: number) => {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() + n);
      d.setUTCHours(9, 0, 0, 0);
      return d.toISOString();
    };
    const tmpl = await svcCreateBlock(SYSTEM_OWNER, {
      title: 'Weekly standup', block_kind: 'timeblock',
      start_at: day(1), end_at: day(1),
      recurrence_rule: 'FREQ=DAILY;COUNT=3',
    });
    if (!tmpl.ok) throw new Error('template failed');
    await setEntityPeople(SYSTEM_OWNER, 'time_block', tmpl.block.id, 'responsible', [chris.id]);

    await ensureRecurringBlocksForRange(SYSTEM_OWNER, day(0), day(5));
    const instances = sqlite
      .prepare(`SELECT id FROM time_blocks WHERE recurrence_parent_id = ? ORDER BY start_at`)
      .all(tmpl.block.id) as { id: string }[];
    expect(instances.length).toBeGreaterThan(0);
    // Every occurrence carries the attendees — the defect was that none of them did.
    for (const inst of instances) {
      expect((await getEntityPeople('time_block', inst.id)).responsible.map((p) => p.display_name))
        .toEqual(['Chris']);
    }
  });
});

/**
 * Review fix (round 4) — the client cannot tell "nobody" from "inheriting" by looking
 * at an empty set, so the server reports which it is instead of the UI guessing from
 * session state.
 */
describe('blocks report whether each set is inherited', () => {
  it('flags inherited, own, and pinned-to-nobody distinctly, per role', async () => {
    const self = await selfPersonId(SYSTEM_OWNER);
    const mom = await createPerson(SYSTEM_OWNER, { display_name: 'Mom' });
    const chris = await createPerson(SYSTEM_OWNER, { display_name: 'Chris' });
    const taskId = await seedTask('Backing');
    await setEntityPeople(SYSTEM_OWNER, 'task', taskId, 'responsible', [self!]);
    await setEntityPeople(SYSTEM_OWNER, 'task', taskId, 'beneficiary', [mom.id]);

    const made = await svcCreateBlock(SYSTEM_OWNER, {
      title: 'Standup', task_id: taskId,
      start_at: '2026-06-22T09:00:00.000Z', end_at: '2026-06-22T10:00:00.000Z',
    });
    if (!made.ok) throw new Error('seed failed');
    // Nothing stated yet → both inherited.
    expect(made.api.responsible_inherited).toBe(true);
    expect(made.api.beneficiaries_inherited).toBe(true);

    const { updateBlock } = await import('../src/services/blocks.js');
    const own = await updateBlock(SYSTEM_OWNER, made.block.id, { responsible_ids: [chris.id] });
    if (!own.ok) throw new Error('set failed');
    expect(own.api.responsible_inherited).toBe(false);
    expect(own.api.beneficiaries_inherited).toBe(true); // the other role is untouched

    const nobody = await updateBlock(SYSTEM_OWNER, made.block.id, { responsible_ids: [] });
    if (!nobody.ok) throw new Error('clear failed');
    // Empty AND not inherited — the distinction the flag exists to carry.
    expect(nobody.api.responsible).toEqual([]);
    expect(nobody.api.responsible_inherited).toBe(false);

    const back = await updateBlock(SYSTEM_OWNER, made.block.id, { responsible_ids: null });
    if (!back.ok) throw new Error('unpin failed');
    expect(back.api.responsible_inherited).toBe(true);
  });
});
