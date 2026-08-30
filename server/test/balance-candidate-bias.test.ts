import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, createOwner, SECOND_OWNER_ID } from './helpers.js';
import { SHORTFALL_FLOOR_HOURS } from '../src/services/balance-budget.js';

/**
 * Ticket 3 of the balance-targets wave
 * (docs/factory/balance-targets-wave/bal-3-candidate-bias.md): bal-3 widens
 * `fillFlightPlanCandidates`'s fetch and bands under-served dimensions to the front
 * of what gets PROPOSED into staging (step 1 'fill'), without ever excluding a task
 * the old query would have staged unless it falls off the same LIMIT it always could.
 *
 * `dimensionShortfalls` is spied (not fully mocked) so most tests exercise the real
 * shortfall math end-to-end; one test (the throw case) swaps in a rejecting
 * implementation for a single call.
 */
const { dimensionShortfallsSpy } = vi.hoisted(() => ({ dimensionShortfallsSpy: vi.fn() }));
vi.mock('../src/services/balance-budget.js', async (importActual) => {
  const actual = await importActual<typeof import('../src/services/balance-budget.js')>();
  dimensionShortfallsSpy.mockImplementation(actual.dimensionShortfalls);
  return { ...actual, dimensionShortfalls: dimensionShortfallsSpy };
});

import { fillFlightPlanCandidates } from '../src/engine/autoplan.js';

const OWNER = SYSTEM_OWNER;
const FILL_DATE = '2026-08-29'; // Saturday — week-of Mon 2026-08-24 .. Sun 2026-08-30

function insertTask(title: string, priority = 3, owner: string = OWNER, dueAt: string | null = null): string {
  return (
    sqlite
      .prepare(`INSERT INTO tasks (id, title, owner_id, status, priority, due_at) VALUES (uuid7(), ?, ?, 'open', ?, ?) RETURNING id`)
      .get(title, owner, priority, dueAt) as { id: string }
  ).id;
}

function seedCategory(name: string, owner: string = OWNER): string {
  return (
    sqlite
      .prepare(`INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (uuid7(), ?, ?, 'category', 1) RETURNING id`)
      .get(owner, name) as { id: string }
  ).id;
}

function categorize(taskId: string, categoryTagId: string): void {
  sqlite
    .prepare(`INSERT INTO entity_categories (entity_kind, entity_id, category_tag_id, position) VALUES ('task', ?, ?, 0)`)
    .run(taskId, categoryTagId);
}

function setTarget(category: string, targetHoursPerWeek: number, owner: string = OWNER): void {
  sqlite
    .prepare(`INSERT INTO life_priorities (id, owner_id, category, target_hours_per_week) VALUES (uuid7(), ?, ?, ?)`)
    .run(owner, category, targetHoursPerWeek);
}

function stagedOrder(owner: string = OWNER): string[] {
  return (
    sqlite
      .prepare(`SELECT task_id FROM flight_plan WHERE owner_id = ? ORDER BY position`)
      .all(owner) as { task_id: string }[]
  ).map((r) => r.task_id);
}

function setBiasEnabled(on: boolean, owner: string = OWNER): void {
  sqlite.prepare(`UPDATE scheduling_prefs SET balance_bias_enabled = ? WHERE owner_id = ?`).run(on ? 1 : 0, owner);
}

/** `n` filler tasks (no category, priority=1) so anything inserted after them sits at
 *  base-rank n+1 in the original `priority, due_at, id` order. Each gets a distinct,
 *  strictly increasing `due_at` so their relative SQL order is deterministic — same
 *  priority alone would tie-break on `id`, and uuid7 ties within a millisecond read
 *  back in random order (a known flake source in a loop-built fixture like this one). */
function insertFillers(n = 20, owner: string = OWNER): string[] {
  return Array.from({ length: n }, (_, i) => insertTask(`Filler ${i}`, 1, owner, `2026-01-01T00:${String(i).padStart(2, '0')}:00.000Z`));
}

beforeEach(() => {
  resetDb();
  dimensionShortfallsSpy.mockClear();
});

describe('bal-3: candidate bias', () => {
  it('characterization: bias off ⇒ staging is byte-identical to the original single query', async () => {
    setBiasEnabled(false);
    const health = seedCategory('health');
    setTarget('health', 14); // would normally clear the floor by a wide margin
    const fillers = insertFillers(20);
    const healthTask = insertTask('Health task', 2); // base-rank 21 — past the old LIMIT
    categorize(healthTask, health);

    const added = await fillFlightPlanCandidates(OWNER, { date: FILL_DATE });

    // Original query: priority, COALESCE(due_at,'9999-12-31'), id, LIMIT 20 — the 20
    // fillers (priority 1) all rank ahead of the health task (priority 2), which never
    // clears the LIMIT. Bias must not touch this: byte-identical to today.
    expect(added).toBe(20);
    expect(stagedOrder()).toEqual(fillers);
    expect(stagedOrder()).not.toContain(healthTask);
    expect(dimensionShortfallsSpy).not.toHaveBeenCalled(); // gate order: pref-off short-circuits before the shortfall check
  });

  it('a ≥2h shortfall dimension promotes a matching task ranked past base position 20', async () => {
    const health = seedCategory('health');
    setTarget('health', 14); // 0 scheduled ⇒ 14h shortfall, well past the 2h floor
    insertFillers(20);
    const healthTask = insertTask('Health task', 2); // base-rank 21
    categorize(healthTask, health);

    const added = await fillFlightPlanCandidates(OWNER, { date: FILL_DATE });

    expect(added).toBe(20);
    expect(stagedOrder()).toContain(healthTask);
    expect(stagedOrder()[0]).toBe(healthTask); // leads precede the rest
  });

  it('two eligible dimensions both lead, worst-first; a third (over the cap) does not', async () => {
    const health = seedCategory('health');
    const career = seedCategory('career');
    const leisure = seedCategory('leisure');
    setTarget('health', 14); // worst shortfall (840 min)
    setTarget('career', 10); // second (600 min)
    setTarget('leisure', 6); // third — clears the floor too, but the cap is 2 (360 min)
    const fillers = insertFillers(20); // ranks 1-20
    const healthTask = insertTask('Health task', 2); // rank 21
    const careerTask = insertTask('Career task', 3); // rank 22
    const leisureTask = insertTask('Leisure task', 4); // rank 23
    categorize(healthTask, health);
    categorize(careerTask, career);
    categorize(leisureTask, leisure);

    const added = await fillFlightPlanCandidates(OWNER, { date: FILL_DATE });

    // Widened window (60) sees all 23; leads = [health, career] partition to the front
    // (worst-first, as the fixture's own priority order already reflects), then the
    // 20-filler "rest" — CANDIDATE_LIMIT (20) slices off before the leisure task, which
    // never gets a bias promotion because the cap (2) excluded its dimension.
    expect(added).toBe(20);
    const order = stagedOrder();
    expect(order[0]).toBe(healthTask);
    expect(order[1]).toBe(careerTask);
    expect(order).not.toContain(leisureTask);
    expect(order.slice(2)).toEqual(fillers.slice(0, 18));
  });

  it('a 1.9h shortfall (under the 2h floor) is inert — original path, task not promoted', async () => {
    const health = seedCategory('health');
    setTarget('health', SHORTFALL_FLOOR_HOURS - 0.1); // 1.9h ⇒ under the exported floor
    insertFillers(20);
    const healthTask = insertTask('Health task', 2); // base-rank 21

    categorize(healthTask, health);
    const added = await fillFlightPlanCandidates(OWNER, { date: FILL_DATE });

    expect(added).toBe(20);
    expect(stagedOrder()).not.toContain(healthTask);
  });

  it('stable order inside each half — no re-sort within leads or within rest', async () => {
    const health = seedCategory('health');
    setTarget('health', 14);
    const fillers = insertFillers(20); // rest half, ranks 1-20
    // Three health tasks past the LIMIT, inserted in a deliberately scrambled priority
    // order so a re-sort bug (vs. a stable partition) would be caught.
    const h3 = insertTask('Health C', 5);
    const h1 = insertTask('Health A', 2);
    const h2 = insertTask('Health B', 3);
    [h3, h1, h2].forEach((id) => categorize(id, health));

    await fillFlightPlanCandidates(OWNER, { date: FILL_DATE });

    const order = stagedOrder();
    // Leads half keeps the original priority order (h1 < h2 < h3), NOT insertion order.
    expect(order.slice(0, 3)).toEqual([h1, h2, h3]);
    // Rest half is exactly the fillers, in their original order.
    expect(order.slice(3)).toEqual(fillers.slice(0, 17));
  });

  it('owner isolation: owner B\'s targets do not bias owner A\'s fill', async () => {
    createOwner(SECOND_OWNER_ID);
    seedCategory('health', SECOND_OWNER_ID);
    setTarget('health', 14, SECOND_OWNER_ID); // owner B has a big shortfall
    // Owner A has NO life_priorities row and its own "health" tag id differs (per-owner
    // tags table), so even a same-named task can't cross-match.
    const healthA = seedCategory('health', OWNER);
    insertFillers(20, OWNER);
    const healthTaskA = insertTask('Health task (owner A)', 2, OWNER); // base-rank 21
    categorize(healthTaskA, healthA);

    const added = await fillFlightPlanCandidates(OWNER, { date: FILL_DATE });

    expect(added).toBe(20);
    expect(stagedOrder(OWNER)).not.toContain(healthTaskA); // A's own fill sees no shortfall of its own
  });

  it('a thrown shortfall-service error degrades to the unbiased result, no rejection', async () => {
    const health = seedCategory('health');
    setTarget('health', 14);
    insertFillers(20);
    const healthTask = insertTask('Health task', 2);
    categorize(healthTask, health);
    dimensionShortfallsSpy.mockImplementationOnce(async () => {
      throw new Error('simulated shortfall-service failure');
    });

    await expect(fillFlightPlanCandidates(OWNER, { date: FILL_DATE })).resolves.toBe(20);
    expect(stagedOrder()).not.toContain(healthTask); // fell back to the original unbiased query
  });
});
