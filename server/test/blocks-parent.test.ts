import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { resetDb, startTestServer, api, createOwner, SECOND_OWNER_ID, type TestServer } from './helpers.js';

/**
 * `parent_block_id` on CREATE — the Plan-as-container attach, establishable in one call.
 *
 * Previously `POST /api/blocks` silently dropped `parent_block_id`: the route's body type
 * never declared it, so it never reached `createBlock` and the row landed with a NULL
 * parent — while the route still answered 201. The client's own typed contract
 * (`create: (body: Partial<Block> & {...})`, and `Block` HAS `parent_block_id`) advertises
 * the field, so callers were told by tsc that it worked. Silently dropping a field the
 * caller supplied is the bug; these tests pin that it now lands, or is refused loudly.
 *
 * The parent must be a REAL container of YOURS: the self-referential FK
 * (`0023_block_parent`) only proves the row exists — not that you own it, and not that
 * it's a `timeblock`. Both are checked in the service so REST and GraphQL share one answer.
 */

const at = (h: string) => `2026-06-20T${h}:00.000Z`;
const row = (id: string) =>
  sqlite.prepare(`SELECT parent_block_id, owner_id FROM time_blocks WHERE id = ?`).get(id) as
    | { parent_block_id: string | null; owner_id: string }
    | undefined;

/** A raw insert so a block can be planted for ANOTHER owner (the API only ever acts as the test owner). */
function insertBlock(ownerId: string, over: Record<string, unknown> = {}): string {
  const r: Record<string, unknown> = {
    owner_id: ownerId, title: 'Foreign plan', block_kind: 'timeblock',
    start_at: at('10:00'), end_at: at('12:00'), is_auto: 0, is_locked: 0,
    source_kind: 'manual', status: 'planned', ...over,
  };
  const keys = Object.keys(r);
  return (sqlite
    .prepare(`INSERT INTO time_blocks (id, ${keys.join(', ')}) VALUES (uuid7(), ${keys.map(() => '?').join(', ')}) RETURNING id`)
    .get(...keys.map((k) => r[k])) as { id: string }).id;
}

/** A Plan container owned by the test owner, via the public route. */
async function makePlan(srv: TestServer): Promise<string> {
  const res = await api(srv.url, '/api/blocks', {
    method: 'POST',
    json: { title: 'Deep work', block_kind: 'timeblock', start_at: at('14:30'), end_at: at('16:30') },
  });
  expect(res.status).toBe(201);
  return res.body.block.id as string;
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('POST /api/blocks — parent_block_id', () => {
  it('attaches to a Plan container at create time (was silently dropped)', async () => {
    const planId = await makePlan(srv);
    const res = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'A2 · design review', start_at: at('15:00'), end_at: at('16:00'), parent_block_id: planId },
    });

    expect(res.status).toBe(201);
    // The response must tell the truth about what landed — the old bug returned null here.
    expect(res.body.block.parent_block_id).toBe(planId);
    expect(row(res.body.block.id)?.parent_block_id).toBe(planId);
  });

  it('still creates a loose block when no parent is given', async () => {
    const res = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Loose', start_at: at('09:00'), end_at: at('10:00') },
    });
    expect(res.status).toBe(201);
    expect(res.body.block.parent_block_id ?? null).toBeNull();
  });

  it('accepts an explicit null parent as loose (not a 422)', async () => {
    const res = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Explicit null', start_at: at('09:00'), end_at: at('10:00'), parent_block_id: null },
    });
    expect(res.status).toBe(201);
    expect(res.body.block.parent_block_id ?? null).toBeNull();
  });

  it('refuses a parent that does not exist with 422 — not a 500 from the FK', async () => {
    const res = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Orphan', start_at: at('15:00'), end_at: at('16:00'), parent_block_id: '00000000-0000-7000-8000-00000000dead' },
    });
    expect(res.status).toBe(422);
    expect(sqlite.prepare(`SELECT count(*) n FROM time_blocks WHERE title = 'Orphan'`).get()).toEqual({ n: 0 });
  });

  it('refuses ANOTHER owner\'s block as parent — the FK proves existence, not ownership', async () => {
    createOwner();
    const foreignPlan = insertBlock(SECOND_OWNER_ID);

    const res = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Graft', start_at: at('15:00'), end_at: at('16:00'), parent_block_id: foreignPlan },
    });

    expect(res.status).toBe(422);
    // Nothing of mine may hang off their tree, and their block is untouched.
    expect(sqlite.prepare(`SELECT count(*) n FROM time_blocks WHERE parent_block_id = ?`).get(foreignPlan)).toEqual({ n: 0 });
    expect(row(foreignPlan)?.owner_id).toBe(SECOND_OWNER_ID);
  });

  it('refuses a non-container parent (only block_kind=timeblock can own children)', async () => {
    const chip = (await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Just a chip', start_at: at('09:00'), end_at: at('10:00') },
    })).body.block.id as string;

    const res = await api(srv.url, '/api/blocks', {
      method: 'POST',
      json: { title: 'Nested under a chip', start_at: at('09:15'), end_at: at('09:45'), parent_block_id: chip },
    });
    expect(res.status).toBe(422);
  });
});

describe('PATCH /api/blocks/:id — parent_block_id (same invariant, same answer)', () => {
  it('attaches to a Plan container (the established attach-on-drop path)', async () => {
    const planId = await makePlan(srv);
    const chip = (await api(srv.url, '/api/blocks', {
      method: 'POST', json: { title: 'Chip', start_at: at('15:00'), end_at: at('16:00') },
    })).body.block.id as string;

    const res = await api(srv.url, `/api/blocks/${chip}`, { method: 'PATCH', json: { parent_block_id: planId } });
    expect(res.status).toBe(200);
    expect(row(chip)?.parent_block_id).toBe(planId);
  });

  it('detaches on an explicit null (Alt-drag pull-out must keep working)', async () => {
    const planId = await makePlan(srv);
    const chip = (await api(srv.url, '/api/blocks', {
      method: 'POST', json: { title: 'Chip', start_at: at('15:00'), end_at: at('16:00'), parent_block_id: planId },
    })).body.block.id as string;
    expect(row(chip)?.parent_block_id).toBe(planId);

    const res = await api(srv.url, `/api/blocks/${chip}`, { method: 'PATCH', json: { parent_block_id: null } });
    expect(res.status).toBe(200);
    expect(row(chip)?.parent_block_id).toBeNull();
  });

  it('refuses ANOTHER owner\'s block as parent — no cross-owner graft via update either', async () => {
    createOwner();
    const foreignPlan = insertBlock(SECOND_OWNER_ID);
    const mine = (await api(srv.url, '/api/blocks', {
      method: 'POST', json: { title: 'Mine', start_at: at('15:00'), end_at: at('16:00') },
    })).body.block.id as string;

    const res = await api(srv.url, `/api/blocks/${mine}`, { method: 'PATCH', json: { parent_block_id: foreignPlan } });

    expect(res.status).toBe(422);
    expect(row(mine)?.parent_block_id).toBeNull(); // unchanged — no mutation on a refused op
  });
});
