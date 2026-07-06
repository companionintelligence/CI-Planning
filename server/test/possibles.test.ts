import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestServer, resetDb, createOwner, SECOND_OWNER_ID, api, type TestServer } from './helpers.js';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';

/**
 * Phase W · W9 — REST /api/possible-tasks owner-scoping lock. The route now delegates to
 * services/possibles.ts, which scopes every read/write by `proposed_owner_id` (the table's
 * owner key, T4) — closing the pre-extraction cross-tenant read-leak/IDOR. This test locks
 * the new behavior: GET returns only the caller's possibles; promote/dismiss of another
 * owner's id → 404. The legit-owner path (201 promote, {ok:true} dismiss) is unchanged.
 */
let srv: TestServer;
const OWNER = SYSTEM_OWNER;
const OTHER = SECOND_OWNER_ID;

function insertPossible(rawTitle: string, owner = OWNER, status = 'pending'): string {
  return (sqlite
    .prepare(`INSERT INTO possible_tasks (id, raw_title, status, proposed_owner_id) VALUES (uuid7(), ?, ?, ?) RETURNING id`)
    .get(rawTitle, status, owner) as { id: string }).id;
}
function possibleStatus(id: string): string | undefined {
  return (sqlite.prepare(`SELECT status FROM possible_tasks WHERE id = ?`).get(id) as { status: string } | undefined)?.status;
}

beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => { resetDb(); });

describe('possibles REST — owner scoping', () => {
  it('GET /api/possible-tasks returns only the caller\'s possibles', async () => {
    createOwner(OTHER);
    insertPossible('Mine', OWNER);
    insertPossible('Theirs', OTHER);

    const mine = await api(srv.url, '/api/possible-tasks');
    expect(mine.body.possibles.map((p: any) => p.raw_title)).toEqual(['Mine']);

    const theirs = await api(srv.url, '/api/possible-tasks', { headers: { 'x-test-owner': OTHER } });
    expect(theirs.body.possibles.map((p: any) => p.raw_title)).toEqual(['Theirs']);
  });

  it('promote of the caller\'s own possible succeeds (201) and flips status', async () => {
    const id = insertPossible('Mine', OWNER);
    const res = await api(srv.url, `/api/possible-tasks/${id}/promote`, { method: 'POST', json: {} });
    expect(res.status).toBe(201);
    expect(res.body.task).toMatchObject({ title: 'Mine', status: 'open' });
    expect(possibleStatus(id)).toBe('promoted');
  });

  it('promote of another owner\'s possible → 404, item untouched', async () => {
    createOwner(OTHER);
    const mine = insertPossible('Mine', OWNER);
    const res = await api(srv.url, `/api/possible-tasks/${mine}/promote`, {
      method: 'POST', json: {}, headers: { 'x-test-owner': OTHER },
    });
    expect(res.status).toBe(404);
    expect(possibleStatus(mine)).toBe('pending');
  });

  it('dismiss of the caller\'s own possible succeeds and flips status', async () => {
    const id = insertPossible('Mine', OWNER);
    const res = await api(srv.url, `/api/possible-tasks/${id}/dismiss`, { method: 'POST', json: {} });
    expect(res.body).toEqual({ ok: true });
    expect(possibleStatus(id)).toBe('dismissed');
  });

  it('dismiss of another owner\'s possible → 404, item untouched', async () => {
    createOwner(OTHER);
    const mine = insertPossible('Mine', OWNER);
    const res = await api(srv.url, `/api/possible-tasks/${mine}/dismiss`, {
      method: 'POST', json: {}, headers: { 'x-test-owner': OTHER },
    });
    expect(res.status).toBe(404);
    expect(possibleStatus(mine)).toBe('pending');
  });
});
