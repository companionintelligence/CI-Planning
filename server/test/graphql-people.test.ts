import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { createTask as svcCreateTask } from '../src/services/tasks.js';
import { createBlock as svcCreateBlock } from '../src/services/blocks.js';
import { createPerson, selfPersonId, setEntityPeople } from '../src/services/people.js';

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
