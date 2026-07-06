import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { runWithOwner, currentOwnerId, SYSTEM_OWNER } from '../src/lib/context.js';
import { createOwner, resetDb, SECOND_OWNER_ID } from './helpers.js';

/**
 * T0: the multi-tenant test scaffolding — a 2nd-owner factory + resetDb pruning,
 * the plumbing every T1/T2 owner-isolation test builds on. DB-backed (runs in CI).
 * The pure-JS currentOwnerId behavior is in context-strict.test.ts.
 */
describe('T0 multi-tenant scaffolding', () => {
  beforeEach(() => resetDb());

  it('createOwner adds a 2nd owner with a valid (cloned) prefs row', () => {
    createOwner();
    const ids = (sqlite.prepare(`SELECT id FROM owners`).all() as { id: string }[]).map((o) => o.id);
    expect(ids).toContain(SYSTEM_OWNER);
    expect(ids).toContain(SECOND_OWNER_ID);
    const prefs = sqlite
      .prepare(`SELECT count(*) AS n FROM scheduling_prefs WHERE owner_id = ?`)
      .get(SECOND_OWNER_ID) as { n: number };
    expect(prefs.n).toBe(1);
  });

  it('runWithOwner routes currentOwnerId() per scope', () => {
    createOwner();
    expect(runWithOwner(SECOND_OWNER_ID, [], () => currentOwnerId())).toBe(SECOND_OWNER_ID);
    expect(runWithOwner(SYSTEM_OWNER, [], () => currentOwnerId())).toBe(SYSTEM_OWNER);
  });

  it('resetDb prunes non-system owners (no cross-file leak)', () => {
    createOwner();
    resetDb();
    const ids = (sqlite.prepare(`SELECT id FROM owners`).all() as { id: string }[]).map((o) => o.id);
    expect(ids).toEqual([SYSTEM_OWNER]);
  });
});
