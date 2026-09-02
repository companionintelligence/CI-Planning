/**
 * Ticket 4 of the balance-targets wave
 * (docs/factory/balance-targets-wave/bal-4-order-band.md): the day-authoring
 * `balanceLead` ordering band. Mirrors `aa3-memory-ordering.test.ts`'s two-layer
 * shape — pure comparator/exemption/rendering tests against the exported
 * functions, then a DB-backed `authorPlanOrder` integration layer (deterministic
 * mode only; this ticket never touches the LLM prompt's gate, only its content).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, createOwner, SECOND_OWNER_ID } from './helpers.js';
import {
  deterministicIndices,
  checkOrder,
  balanceLine,
  authorPlanOrder,
  type PlanTask,
} from '../src/agents/plan.js';
import { SHORTFALL_FLOOR_HOURS, BIAS_DIMENSIONS_MAX, type DimensionShortfall } from '../src/services/balance-budget.js';

const OWNER = SYSTEM_OWNER;
const DATE = '2026-08-26'; // Wednesday, week-of Mon 2026-08-24 .. Sun 2026-08-30

function pt(id: string, title: string, tags: string[] = [], priority = 3, due: string | null = null): PlanTask {
  return { task_id: id, title, priority, due_at: due, estimated_minutes: 30, tags };
}

// ─── Pure: deterministicIndices band position ──────────────────────────────

describe('bal-4 deterministicIndices balance band', () => {
  it('band order in one fixture: theme > memory > new_today > balance > due > priority', () => {
    // Each task is deliberately WORSE than the next on due/priority alone (so the
    // raw due-first sort would read F,E,D,C,B,A) — the assertion below shows every
    // earlier band overriding that raw order, landing A..F in band-precedence order.
    const tasks = [
      pt('A-theme', 'A', ['deep'], 5, '2026-12-31'),
      pt('B-memory', 'B', [], 5, '2026-12-30'),
      pt('C-new-today', 'C', [], 5, '2026-12-29'),
      pt('D-balance', 'D', [], 5, '2026-12-28'),
      pt('E-due', 'E', [], 5, '2026-01-01'), // earliest due among the untagged remainder
      pt('F-priority', 'F', [], 1, '2026-06-15'), // best priority, but a LATER due than E
    ];
    const order = deterministicIndices(
      tasks,
      'deep',
      'overdue',
      new Set(['B-memory']),
      new Set(['C-new-today']),
      new Set(['D-balance']),
    );
    expect(order.map((i) => tasks[i].task_id)).toEqual([
      'A-theme',
      'B-memory',
      'C-new-today',
      'D-balance',
      'E-due', // due beats priority: E's earlier due wins over F's better priority
      'F-priority',
    ]);
  });

  it('ranks a balance-lead task ahead of an earlier-due non-lead one', () => {
    const tasks = [pt('early-due', 'Taxes', [], 3, '2026-06-25'), pt('lead', 'Exercise', [], 3, '2026-12-31')];
    const order = deterministicIndices(tasks, null, 'overdue', undefined, undefined, new Set(['lead']));
    expect(tasks[order[0]].task_id).toBe('lead');
  });

  it('is byte-identical to the no-balance order when the set is absent/empty', () => {
    const tasks = [pt('early-due', 'Taxes', [], 3, '2026-06-25'), pt('other', 'Exercise', [], 3, '2026-12-31')];
    const withEmpty = deterministicIndices(tasks, null, 'overdue', undefined, undefined, new Set());
    const withAbsent = deterministicIndices(tasks, null, 'overdue');
    expect(withEmpty).toEqual(withAbsent);
    expect(tasks[withEmpty[0]].task_id).toBe('early-due'); // deadline wins, unaffected
  });
});

// ─── Pure: checkOrder exemption ─────────────────────────────────────────────

describe('bal-4 checkOrder balance exemption', () => {
  const tasks: PlanTask[] = [
    { task_id: 'lead', title: 'P3 lead', priority: 3, due_at: '2026-06-24', estimated_minutes: 30, tags: [] },
    { task_id: 'other', title: 'P1 other', priority: 1, due_at: '2026-06-24', estimated_minutes: 30, tags: [] },
  ];

  it('flags the priority inversion without a balanceLead exemption', () => {
    expect(checkOrder([0, 1], tasks, '2026-06-24')).toHaveLength(1);
  });

  it('does not flag a band-legal lead (P3 lead precedes P1 non-lead)', () => {
    expect(checkOrder([0, 1], tasks, '2026-06-24', null, undefined, new Set(['lead']))).toHaveLength(0);
  });

  it('still catches a genuine inversion between two non-lead tasks', () => {
    // 'other' is in the lead set, not 'lead' at index 0 — the exemption never applies to
    // index 0, so the inversion (P3 before P1, same due) is still flagged.
    expect(checkOrder([0, 1], tasks, '2026-06-24', null, undefined, new Set(['other']))).toHaveLength(1);
  });

  it('does NOT exempt a stale balance-lead task from a real inversion against a fresh non-lead one (code-review fix)', () => {
    // 'lead' is balance-lead but not newToday; 'other' is newToday but not balance-lead.
    // The band order is theme > memory > new_today > balance, so a task that is only
    // "fresh" outranks a task that is only "balance-lead" — the balance exemption must
    // not fire across that boundary. Without the `aFresh === fresh(b)` guard, this
    // inversion (P3 lead before P1 fresh, same due) was silently missed.
    expect(
      checkOrder([0, 1], tasks, '2026-06-24', null, undefined, new Set(['lead']), new Set(['other'])),
    ).toHaveLength(1);
  });

  it('still exempts a balance-lead task when BOTH tasks share the same newToday status', () => {
    // Neither task is newToday here, so the two are in the same freshness band and the
    // balance exemption should apply exactly as the plain band-legal-lead test above.
    expect(
      checkOrder([0, 1], tasks, '2026-06-24', null, undefined, new Set(['lead']), new Set()),
    ).toHaveLength(0);
  });
});

// ─── Pure: balanceLine rendering ────────────────────────────────────────────

describe('bal-4 balanceLine', () => {
  const dim = (category: string, shortfallMinutes: number): DimensionShortfall => ({
    category,
    target_hours: 10,
    scheduled_minutes: 0,
    shortfall_minutes: shortfallMinutes,
  });

  it('renders worst-first, capped at BIAS_DIMENSIONS_MAX, hours rounded to whole', () => {
    expect(BIAS_DIMENSIONS_MAX).toBe(2); // pin — the fixture below exercises exactly this cap
    const shortfalls = [dim('health', 615), dim('growth', 185), dim('career', 400)]; // 3 candidates, only 2 render
    expect(balanceLine(shortfalls)).toBe('\nBehind weekly targets: health (10h short), growth (3h short).');
  });

  it('empty string when nothing meets SHORTFALL_FLOOR_HOURS', () => {
    expect(SHORTFALL_FLOOR_HOURS).toBe(2);
    expect(balanceLine([dim('health', 119)])).toBe(''); // 119min < 120min floor
  });

  it('empty string on no shortfalls', () => {
    expect(balanceLine([])).toBe('');
  });
});

// ─── DB-backed authorPlanOrder integration (deterministic mode) ────────────

describe('bal-4 authorPlanOrder integration', () => {
  function insertTask(title: string, priority: number, dueAt: string | null, owner: string = OWNER): string {
    return (
      sqlite
        .prepare(
          `INSERT INTO tasks (id, title, owner_id, status, priority, due_at, estimated_minutes)
           VALUES (uuid7(), ?, ?, 'open', ?, ?, 30) RETURNING id`,
        )
        .get(title, owner, priority, dueAt) as { id: string }
    ).id;
  }
  function stage(taskId: string, position: number, owner: string = OWNER): void {
    sqlite.prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`).run(owner, taskId, position);
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
  function plannedOrder(owner: string = OWNER, date: string = DATE): string[] {
    return (sqlite.prepare(`SELECT task_id FROM daily_plan WHERE owner_id = ? AND date = ? ORDER BY position`).all(owner, date) as { task_id: string }[]).map(
      (r) => r.task_id,
    );
  }

  beforeEach(() => {
    // resetDb() already clears flight_plan/daily_plan/life_priorities/entity_categories/
    // tags/tasks and pins balance_bias_enabled = 1, timezone UTC (helpers.ts).
    resetDb();
  });

  it('AC1: a Health-categorized task leads when Health is 10h short, despite worse priority/due', async () => {
    const healthCat = seedCategory('health');
    setTarget('health', 10); // no time_blocks this week ⇒ full 10h shortfall, well above the 2h floor
    // Deliberately WORSE priority/due than the control task, so only the balance band explains the lead.
    const healthTask = insertTask('Go for a run', 5, '2026-12-31');
    const otherTask = insertTask('File a form', 1, '2026-08-26');
    categorize(healthTask, healthCat);
    stage(healthTask, 0);
    stage(otherTask, 1);

    await authorPlanOrder(OWNER, DATE);

    expect(plannedOrder()).toEqual([healthTask, otherTask]);
  });

  it('an OVERDUE task beats the balance lead end-to-end (escape hatch, wired)', async () => {
    // AC1's exact fixture, except the control task is now two weeks past due. The unit
    // tests above cover the comparator; this pins the wiring — `authorPlanOrder` has to
    // actually pass the plan date through as `overdueBefore` for the band to exist.
    const healthCat = seedCategory('health');
    setTarget('health', 10);
    const healthTask = insertTask('Go for a run', 5, '2026-12-31');
    const overdueTask = insertTask('Pay the invoice', 1, '2026-08-12'); // DATE is 2026-08-26
    categorize(healthTask, healthCat);
    stage(healthTask, 0);
    stage(overdueTask, 1);

    await authorPlanOrder(OWNER, DATE);

    expect(plannedOrder()).toEqual([overdueTask, healthTask]);
  });

  it('AC2: balance_bias_enabled = 0 ⇒ order is byte-identical to the no-bias (due/priority) order', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET balance_bias_enabled = 0 WHERE owner_id = ?`).run(OWNER);
    const healthCat = seedCategory('health');
    setTarget('health', 10);
    const healthTask = insertTask('Go for a run', 5, '2026-12-31');
    const otherTask = insertTask('File a form', 1, '2026-08-26');
    categorize(healthTask, healthCat);
    stage(healthTask, 0);
    stage(otherTask, 1);

    await authorPlanOrder(OWNER, DATE);

    // Without the bias, priority/due decide: otherTask (P1, due today) leads.
    expect(plannedOrder()).toEqual([otherTask, healthTask]);
  });

  it("trust_mode='cautious' suppresses the band even with the bias pref ON (0171)", async () => {
    // Two independent switches reach the same band: the owner's own `balance_bias_enabled`
    // (AC2 above) and the trust dial. Cautious is the tier that reviews every item, so it
    // sorts on nothing the owner did not type — the identical fixture to AC1, which leads
    // with the Health task on 'balanced', must fall back to plain due/priority here.
    sqlite.prepare(`UPDATE scheduling_prefs SET trust_mode = 'cautious' WHERE owner_id = ?`).run(OWNER);
    const healthCat = seedCategory('health');
    setTarget('health', 10);
    const healthTask = insertTask('Go for a run', 5, '2026-12-31');
    const otherTask = insertTask('File a form', 1, '2026-08-26');
    categorize(healthTask, healthCat);
    stage(healthTask, 0);
    stage(otherTask, 1);

    await authorPlanOrder(OWNER, DATE);

    expect(plannedOrder()).toEqual([otherTask, healthTask]);
  });

  it('pref off ⇒ dimensionShortfalls is never called, order unchanged', async () => {
    sqlite.prepare(`UPDATE scheduling_prefs SET balance_bias_enabled = 0 WHERE owner_id = ?`).run(OWNER);
    const healthCat = seedCategory('health');
    setTarget('health', 10);
    const healthTask = insertTask('Go for a run', 5, '2026-12-31');
    const otherTask = insertTask('File a form', 1, '2026-08-26');
    categorize(healthTask, healthCat);
    stage(healthTask, 0);
    stage(otherTask, 1);

    const balanceBudget = await import('../src/services/balance-budget.js');
    const spy = vi.spyOn(balanceBudget, 'dimensionShortfalls');
    try {
      await authorPlanOrder(OWNER, DATE);
      expect(spy).not.toHaveBeenCalled();
      expect(plannedOrder()).toEqual([otherTask, healthTask]);
    } finally {
      spy.mockRestore();
    }
  });

  it('service throw ⇒ authoring still resolves with a full deterministic order (never rejects)', async () => {
    const healthCat = seedCategory('health');
    setTarget('health', 10);
    const healthTask = insertTask('Go for a run', 5, '2026-12-31');
    const otherTask = insertTask('File a form', 1, '2026-08-26');
    categorize(healthTask, healthCat);
    stage(healthTask, 0);
    stage(otherTask, 1);

    const balanceBudget = await import('../src/services/balance-budget.js');
    const spy = vi.spyOn(balanceBudget, 'dimensionShortfalls').mockRejectedValue(new Error('boom'));
    try {
      await expect(authorPlanOrder(OWNER, DATE)).resolves.toBe('deterministic');
      // Degrades to an empty balanceLead ⇒ falls back to the plain due/priority order,
      // and — crucially — both tasks still land (no task is ever dropped on a service failure).
      expect(plannedOrder()).toEqual([otherTask, healthTask]);
    } finally {
      spy.mockRestore();
    }
  });

  it('owner isolation: each owner is authored against only its OWN mocked shortfalls', async () => {
    const OWNER_B = createOwner(SECOND_OWNER_ID);
    const healthCat = seedCategory('health', OWNER);
    const careerCat = seedCategory('career', OWNER_B);
    setTarget('health', 10, OWNER);
    setTarget('career', 10, OWNER_B);

    const aHealth = insertTask('A: run', 5, '2026-12-31', OWNER);
    const aOther = insertTask('A: form', 1, '2026-08-26', OWNER);
    categorize(aHealth, healthCat);
    stage(aHealth, 0, OWNER);
    stage(aOther, 1, OWNER);

    // B's task IS categorized health too, but B's mocked shortfall is 'career' — health
    // must NOT lead for B, proving A's dimension never leaks into B's authoring.
    const bHealth = insertTask('B: run', 5, '2026-12-31', OWNER_B);
    const bOther = insertTask('B: form', 1, '2026-08-26', OWNER_B);
    categorize(bHealth, healthCat);
    stage(bHealth, 0, OWNER_B);
    stage(bOther, 1, OWNER_B);

    const balanceBudget = await import('../src/services/balance-budget.js');
    const mkShortfall = (category: string): DimensionShortfall => ({ category, target_hours: 10, scheduled_minutes: 0, shortfall_minutes: 600 });
    const spy = vi.spyOn(balanceBudget, 'dimensionShortfalls').mockImplementation(async (owner: string) => {
      if (owner === OWNER) return [mkShortfall('health')];
      if (owner === OWNER_B) return [mkShortfall('career')];
      return [];
    });
    try {
      await authorPlanOrder(OWNER, DATE);
      await authorPlanOrder(OWNER_B, DATE);

      expect(spy).toHaveBeenCalledWith(OWNER, DATE);
      expect(spy).toHaveBeenCalledWith(OWNER_B, DATE);
      expect(plannedOrder(OWNER)).toEqual([aHealth, aOther]); // health leads for A
      expect(plannedOrder(OWNER_B)).toEqual([bOther, bHealth]); // health does NOT lead for B (career does, but B has no career task)
    } finally {
      spy.mockRestore();
    }
  });
});

// ─── Overdue escape hatch ──────────────────────────────────────────────────

/**
 * The bands below due/priority exist to reorder work against its deadline, which is
 * exactly what can bury a genuinely late task: "you are light on Health this week" is
 * not a reason to keep a two-weeks-overdue invoice off the top of the day. An overdue
 * task therefore leads ABOVE every inferred band.
 *
 * A deadline is also the one input here the owner stated outright rather than the
 * planner inferring it, so this holds in every trust tier — `orderingBandsFor` gates the
 * inferred bands only, never this one.
 */
describe('overdue escape hatch', () => {
  const DAY = '2026-08-26';
  const LATE = '2026-08-12'; // two weeks before DAY
  const SOON = '2026-09-30';

  it('an overdue task outranks a balance-lead one', () => {
    const tasks = [pt('lead', 'Exercise', [], 3, SOON), pt('late', 'Pay invoice', [], 3, LATE)];
    const order = deterministicIndices(tasks, null, 'overdue', undefined, undefined, new Set(['lead']), DAY);
    expect(tasks[order[0]].task_id).toBe('late');
  });

  it('outranks theme and memory too — it is the outermost band', () => {
    const tasks = [
      pt('themed', 'Deep thing', ['deep'], 1, SOON),
      pt('related', 'Call Sam', [], 1, SOON),
      pt('late', 'Pay invoice', [], 5, LATE), // worst priority, still first
    ];
    const order = deterministicIndices(
      tasks, 'deep', 'overdue', new Set(['related']), undefined, undefined, DAY,
    );
    expect(tasks[order[0]].task_id).toBe('late');
  });

  it('holds under fill_order=priority, where deadline is otherwise the secondary key', () => {
    const tasks = [pt('p1', 'Urgent-ish', [], 1, SOON), pt('late', 'Pay invoice', [], 5, LATE)];
    const order = deterministicIndices(tasks, null, 'priority', undefined, undefined, undefined, DAY);
    expect(tasks[order[0]].task_id).toBe('late');
  });

  it('due TODAY is not overdue — it is not late yet', () => {
    // Otherwise every task due today would be promoted out of the lower bands on any
    // busy day, which empties the bands rather than protecting late work.
    const tasks = [pt('lead', 'Exercise', [], 3, SOON), pt('today', 'Due today', [], 3, `${DAY}T09:00:00.000Z`)];
    const order = deterministicIndices(tasks, null, 'overdue', undefined, undefined, new Set(['lead']), DAY);
    expect(tasks[order[0]].task_id).toBe('lead');
  });

  it('orders WITHIN the overdue group by the usual keys, and leaves the rest alone', () => {
    const tasks = [
      pt('late-later', 'Late B', [], 3, '2026-08-20'),
      pt('late-earlier', 'Late A', [], 3, '2026-08-01'),
      pt('lead', 'Exercise', [], 3, SOON),
    ];
    const order = deterministicIndices(tasks, null, 'overdue', undefined, undefined, new Set(['lead']), DAY);
    expect(order.map((i) => tasks[i].task_id)).toEqual(['late-earlier', 'late-later', 'lead']);
  });

  it('is inert without a date — the pure-comparator callers keep a byte-identical order', () => {
    const tasks = [pt('lead', 'Exercise', [], 3, SOON), pt('late', 'Pay invoice', [], 3, LATE)];
    const withBand = deterministicIndices(tasks, null, 'overdue', undefined, undefined, new Set(['lead']));
    const withNull = deterministicIndices(tasks, null, 'overdue', undefined, undefined, new Set(['lead']), null);
    expect(withBand).toEqual(withNull);
    expect(tasks[withBand[0]].task_id).toBe('lead'); // balance band still wins when unset
  });
});

describe('checkOrder — band exemptions never hide a buried overdue task', () => {
  const DAY = '2026-08-26';
  const late = (id: string, tags: string[] = []): PlanTask =>
    ({ task_id: id, title: `${id} (overdue)`, priority: 3, due_at: '2026-08-12', estimated_minutes: 30, tags });
  const soon = (id: string, tags: string[] = []): PlanTask =>
    ({ task_id: id, title: id, priority: 3, due_at: '2026-09-30', estimated_minutes: 30, tags });

  it('flags a themed task placed ahead of an overdue one', () => {
    // The exemption `continue`s past BOTH defect checks, so before the overdue guard
    // this pairing was silently allowed — the exact burial the escape hatch prevents.
    const tasks = [soon('themed', ['deep']), late('overdue')];
    expect(checkOrder([0, 1], tasks, DAY, 'deep')).toHaveLength(1);
  });

  it('flags a memory-related task placed ahead of an overdue one', () => {
    const tasks = [soon('related'), late('overdue')];
    expect(checkOrder([0, 1], tasks, DAY, null, new Set(['related']))).toHaveLength(1);
  });

  it('flags a balance-lead task placed ahead of an overdue one', () => {
    const tasks = [soon('lead'), late('overdue')];
    expect(checkOrder([0, 1], tasks, DAY, null, undefined, new Set(['lead']))).toHaveLength(1);
  });

  it('still exempts a band lead when BOTH tasks share the same overdue status', () => {
    // The guard is a same-band check, not a blanket disable: two overdue tasks (or two
    // on-time ones) still get the ordinary theme/memory/balance exemptions.
    const bothLate = [late('lead'), late('other')];
    expect(checkOrder([0, 1], bothLate, DAY, null, undefined, new Set(['lead']))).toHaveLength(0);
    const bothSoon = [soon('lead'), soon('other')];
    expect(checkOrder([0, 1], bothSoon, DAY, null, undefined, new Set(['lead']))).toHaveLength(0);
  });

  it('does not flag an overdue task leading an on-time one', () => {
    expect(checkOrder([0, 1], [late('overdue'), soon('other')], DAY)).toHaveLength(0);
  });
});
