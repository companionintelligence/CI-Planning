/**
 * Phase M §A2 (same-tag batching) and §C2 (day_theme bias) tests.
 *
 * These tests exercise the deterministic authoring path (planning_mode = 'basic').
 * All tests run under TZ=UTC and use SYSTEM_OWNER + resetDb() for isolation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb } from './helpers.js';
import {
  tagGroupPostPass,
  deterministicIndices,
  checkOrder,
  todayThemeTag,
  authorPlanOrder,
  type PlanTask,
} from '../src/agents/plan.js';

const OWNER = SYSTEM_OWNER;

// ─── DB helpers ──────────────────────────────────────────────────────────────

function insertTask(title: string, priority = 3, dueAt: string | null = null, est = 30): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, status, priority, due_at, estimated_minutes)
         VALUES (uuid7(), ?, ?, 'open', ?, ?, ?) RETURNING id`,
      )
      .get(title, OWNER, priority, dueAt, est) as { id: string }
  ).id;
}

function addTag(taskId: string, tagName: string): void {
  let tag = sqlite.prepare(`SELECT id FROM tags WHERE name = ?`).get(tagName) as { id: string } | undefined;
  if (!tag) tag = sqlite.prepare(`INSERT INTO tags (id, name, owner_id) VALUES (uuid7(), ?, ?) RETURNING id`).get(tagName, OWNER) as { id: string };
  sqlite
    .prepare(`INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`)
    .run(taskId, tag.id);
}

function stage(taskId: string, position = 0): void {
  sqlite
    .prepare(`INSERT OR IGNORE INTO flight_plan (owner_id, task_id, selected, position) VALUES (?, ?, 1, ?)`)
    .run(OWNER, taskId, position);
}

function dailyPlanRows(date: string): { task_id: string; position: number; source: string }[] {
  return sqlite
    .prepare(`SELECT task_id, position, source FROM daily_plan WHERE owner_id = ? AND date = ? ORDER BY position`)
    .all(OWNER, date) as { task_id: string; position: number; source: string }[];
}

function setDayTheme(theme: Record<string, string>): void {
  sqlite
    .prepare(`UPDATE scheduling_prefs SET day_theme = ? WHERE owner_id = ?`)
    .run(JSON.stringify(theme), OWNER);
}

// ─── §A2 unit tests: tagGroupPostPass ────────────────────────────────────────

describe('§A2 tagGroupPostPass', () => {
  it('clusters two tag groups that arrive interleaved', () => {
    const tasks: PlanTask[] = [
      { task_id: 'A', title: 'A', priority: 3, due_at: null, estimated_minutes: 30, tags: ['work'] },
      { task_id: 'B', title: 'B', priority: 3, due_at: null, estimated_minutes: 30, tags: ['email'] },
      { task_id: 'C', title: 'C', priority: 3, due_at: null, estimated_minutes: 30, tags: ['work'] },
      { task_id: 'E', title: 'E', priority: 3, due_at: null, estimated_minutes: 30, tags: ['email'] },
      { task_id: 'F', title: 'F', priority: 3, due_at: null, estimated_minutes: 30, tags: ['email'] },
    ];
    // Input order: work-A first, email-B, work-C, email-E, email-F
    // 'work' group first appears at pos 0 → work tasks come first
    const result = tagGroupPostPass([0, 1, 2, 3, 4], tasks);
    expect(result.map((i) => tasks[i].title)).toEqual(['A', 'C', 'B', 'E', 'F']);
  });

  it('preserves group order (the group that first appears keeps its position)', () => {
    const tasks: PlanTask[] = [
      { task_id: 'A', title: 'A', priority: 3, due_at: null, estimated_minutes: 30, tags: ['email'] },
      { task_id: 'B', title: 'B', priority: 3, due_at: null, estimated_minutes: 30, tags: ['work'] },
      { task_id: 'C', title: 'C', priority: 3, due_at: null, estimated_minutes: 30, tags: ['email'] },
    ];
    const result = tagGroupPostPass([0, 1, 2], tasks);
    expect(result.map((i) => tasks[i].title)).toEqual(['A', 'C', 'B']);
  });

  it('single task: no-op', () => {
    const tasks: PlanTask[] = [
      { task_id: 'X', title: 'X', priority: 3, due_at: null, estimated_minutes: 30, tags: ['work'] },
    ];
    expect(tagGroupPostPass([0], tasks)).toEqual([0]);
  });

  it('no-tags tasks: handled without throw; empty tags array forms own group', () => {
    const tasks: PlanTask[] = [
      { task_id: 'A', title: 'A', priority: 3, due_at: null, estimated_minutes: 30, tags: ['work'] },
      { task_id: 'B', title: 'B', priority: 3, due_at: null, estimated_minutes: 30, tags: [] },
      { task_id: 'C', title: 'C', priority: 3, due_at: null, estimated_minutes: 30, tags: ['work'] },
      { task_id: 'D', title: 'D', priority: 3, due_at: null, estimated_minutes: 30, tags: [] },
    ];
    expect(() => tagGroupPostPass([0, 1, 2, 3], tasks)).not.toThrow();
    const result = tagGroupPostPass([0, 1, 2, 3], tasks);
    // 'work' group (first appears at pos 0) then untagged '' group (pos 1)
    expect(result.map((i) => tasks[i].title)).toEqual(['A', 'C', 'B', 'D']);
  });

  it('all same tag: order unchanged (stable)', () => {
    const tasks: PlanTask[] = [
      { task_id: 'A', title: 'A', priority: 1, due_at: null, estimated_minutes: 30, tags: ['work'] },
      { task_id: 'B', title: 'B', priority: 2, due_at: null, estimated_minutes: 30, tags: ['work'] },
      { task_id: 'C', title: 'C', priority: 3, due_at: null, estimated_minutes: 30, tags: ['work'] },
    ];
    expect(tagGroupPostPass([0, 1, 2], tasks)).toEqual([0, 1, 2]);
  });

  it('priority inversion scenario: checkOrder detects defect on a bad candidate', () => {
    // Verify the defect-detection logic: B(P3-work) before A(P1-email), same due_at → inversion
    const tasks: PlanTask[] = [
      { task_id: 'A', title: 'P1-email', priority: 1, due_at: '2026-06-24', estimated_minutes: 30, tags: ['email'] },
      { task_id: 'B', title: 'P3-work', priority: 3, due_at: '2026-06-24', estimated_minutes: 30, tags: ['work'] },
      { task_id: 'C', title: 'P1-work', priority: 1, due_at: null, estimated_minutes: 30, tags: ['work'] },
    ];
    // B(P3) before A(P1) with same due → inversion
    const defects = checkOrder([1, 2, 0], tasks, '2026-06-24');
    expect(defects.length).toBeGreaterThan(0);
  });

  it('checkOrder is theme-aware: a themed task leading an unthemed one is not a defect', () => {
    // B(P3-deep-work, themed) before A(P1-email, unthemed), same due → normally an
    // inversion, but the theme justifies B leading on a deep-work day.
    const tasks: PlanTask[] = [
      { task_id: 'A', title: 'P1-email', priority: 1, due_at: '2026-06-24', estimated_minutes: 30, tags: ['email'] },
      { task_id: 'B', title: 'P3-deep', priority: 3, due_at: '2026-06-24', estimated_minutes: 30, tags: ['deep-work'] },
    ];
    expect(checkOrder([1, 0], tasks, '2026-06-24')).toHaveLength(1); // no theme → defect
    expect(checkOrder([1, 0], tasks, '2026-06-24', 'deep-work')).toHaveLength(0); // themed → allowed
  });
});

// ─── §A2 integration: authorPlanOrder clusters tags ──────────────────────────

describe('§A2 authorPlanOrder integration', () => {
  const DATE = '2026-06-23'; // Tuesday

  beforeEach(() => {
    resetDb();
  });

  it('clusters tasks by their primary tag in daily_plan', async () => {
    const work1 = insertTask('Work A', 3, null, 30);
    const email1 = insertTask('Email B', 3, null, 30);
    const work2 = insertTask('Work C', 3, null, 30);
    const email2 = insertTask('Email D', 3, null, 30);

    addTag(work1, 'work');
    addTag(email1, 'email');
    addTag(work2, 'work');
    addTag(email2, 'email');

    // Stage in interleaved order: work, email, work, email
    stage(work1, 0);
    stage(email1, 1);
    stage(work2, 2);
    stage(email2, 3);

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows(DATE);
    expect(rows).toHaveLength(4);

    const taskById = new Map(
      (sqlite.prepare(`SELECT id, title FROM tasks`).all() as { id: string; title: string }[]).map((t) => [t.id, t.title]),
    );

    const workPositions = rows
      .filter((r) => ['Work A', 'Work C'].includes(taskById.get(r.task_id) ?? ''))
      .map((r) => r.position);
    const emailPositions = rows
      .filter((r) => ['Email B', 'Email D'].includes(taskById.get(r.task_id) ?? ''))
      .map((r) => r.position);

    // Each group must be contiguous (no interleaving)
    expect(Math.max(...workPositions) - Math.min(...workPositions)).toBe(workPositions.length - 1);
    expect(Math.max(...emailPositions) - Math.min(...emailPositions)).toBe(emailPositions.length - 1);
    // The two groups must not overlap
    const allWork = new Set(workPositions);
    for (const ep of emailPositions) expect(allWork.has(ep)).toBe(false);
  });

  it('clustering YIELDS to priority: a post-pass that would invert priority is discarded (fallback to the priority order)', async () => {
    // The §A2 safety property end-to-end (not just the pure checkOrder unit test): same-tag
    // clustering must never ship a priority inversion. Deterministic priority order is
    // W1(P1), E1(P2), W2(P3). The tag post-pass would cluster the two 'work' tasks first →
    // W1, W2, E1 → P3 before P2 = inversion → checkOrder flags it → authorPlanOrder keeps the
    // un-clustered priority order (plan.ts:471 fallback). Pre-fix this branch had no coverage.
    const w1 = insertTask('Work P1', 1, null, 30);
    const e1 = insertTask('Email P2', 2, null, 30);
    const w2 = insertTask('Work P3', 3, null, 30);
    addTag(w1, 'work');
    addTag(e1, 'email');
    addTag(w2, 'work');
    stage(w1, 0);
    stage(e1, 1);
    stage(w2, 2);

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows(DATE);
    const posOf = (id: string) => rows.find((r) => r.task_id === id)!.position;
    // Priority order preserved: P1 < P2 < P3 by position; clustering NOT applied.
    expect(posOf(w1)).toBeLessThan(posOf(e1));
    expect(posOf(e1)).toBeLessThan(posOf(w2)); // E1(P2) before W2(P3) — no inversion
  });

  it('is idempotent: second call for same (owner, date) is a no-op', async () => {
    const t1 = insertTask('Task 1', 3, null, 30);
    const t2 = insertTask('Task 2', 3, null, 30);
    addTag(t1, 'work');
    addTag(t2, 'email');
    stage(t1, 0);
    stage(t2, 1);

    await authorPlanOrder(OWNER, DATE);
    const rows1 = dailyPlanRows(DATE);

    // Change staged order (should not matter — already authored)
    sqlite.prepare(`UPDATE flight_plan SET position = 99 WHERE task_id = ?`).run(t1);

    await authorPlanOrder(OWNER, DATE); // should be a no-op
    const rows2 = dailyPlanRows(DATE);
    expect(rows2).toEqual(rows1);
  });

  it('handles a single staged task without error', async () => {
    const t1 = insertTask('Solo task', 3, null, 30);
    addTag(t1, 'work');
    stage(t1, 0);

    await authorPlanOrder(OWNER, DATE);
    const rows = dailyPlanRows(DATE);
    expect(rows).toHaveLength(1);
    expect(rows[0].task_id).toBe(t1);
  });

  it('handles zero staged tasks without error', async () => {
    await authorPlanOrder(OWNER, DATE);
    const rows = dailyPlanRows(DATE);
    expect(rows).toHaveLength(0);
  });
});

// ─── §C2 unit tests: todayThemeTag ───────────────────────────────────────────

describe('§C2 todayThemeTag', () => {
  it('returns the theme tag for a matching weekday', () => {
    // 2026-06-22 is a Monday
    const theme = { mon: 'deep-work', tue: 'admin' };
    expect(todayThemeTag(theme, '2026-06-22')).toBe('deep-work');
  });

  it('returns null when no entry for that weekday', () => {
    const theme = { mon: 'deep-work' };
    expect(todayThemeTag(theme, '2026-06-23')).toBeNull(); // Tuesday
  });

  it('returns null for null dayTheme', () => {
    expect(todayThemeTag(null, '2026-06-22')).toBeNull();
  });

  it('returns null for undefined dayTheme', () => {
    expect(todayThemeTag(undefined, '2026-06-22')).toBeNull();
  });

  it('returns null for empty dayTheme object', () => {
    expect(todayThemeTag({}, '2026-06-22')).toBeNull();
  });

  it('handles all short weekday names correctly', () => {
    // 2026-06-22 Mon, 23 Tue, 24 Wed, 25 Thu, 26 Fri, 27 Sat, 28 Sun
    const theme = { mon: 'deep', tue: 'admin', wed: 'collab', thu: 'learn', fri: 'review', sat: 'off', sun: 'plan' };
    expect(todayThemeTag(theme, '2026-06-22')).toBe('deep');
    expect(todayThemeTag(theme, '2026-06-23')).toBe('admin');
    expect(todayThemeTag(theme, '2026-06-24')).toBe('collab');
    expect(todayThemeTag(theme, '2026-06-25')).toBe('learn');
    expect(todayThemeTag(theme, '2026-06-26')).toBe('review');
    expect(todayThemeTag(theme, '2026-06-27')).toBe('off');
    expect(todayThemeTag(theme, '2026-06-28')).toBe('plan');
  });
});

// ─── §C2 unit tests: deterministicIndices with themeTag ──────────────────────

describe('§C2 deterministicIndices with themeTag', () => {
  it('theme-tagged tasks rank before non-themed tasks at same priority and due_at', () => {
    const tasks: PlanTask[] = [
      { task_id: 'A', title: 'No theme', priority: 3, due_at: null, estimated_minutes: 30, tags: ['work'] },
      { task_id: 'B', title: 'Themed', priority: 3, due_at: null, estimated_minutes: 30, tags: ['deep-work'] },
      { task_id: 'C', title: 'Also themed', priority: 3, due_at: null, estimated_minutes: 30, tags: ['deep-work', 'work'] },
    ];
    const indices = deterministicIndices(tasks, 'deep-work');
    const posA = indices.indexOf(0);
    const posB = indices.indexOf(1);
    const posC = indices.indexOf(2);
    expect(posB).toBeLessThan(posA);
    expect(posC).toBeLessThan(posA);
  });

  it('theme beats deadline (theme is the primary key)', () => {
    // theme → due → priority → id: a themed task leads even an urgent unthemed one.
    const tasks: PlanTask[] = [
      { task_id: 'A', title: 'Themed, no deadline', priority: 3, due_at: null, estimated_minutes: 30, tags: ['deep-work'] },
      { task_id: 'B', title: 'Not themed, urgent due', priority: 3, due_at: '2026-06-22T09:00:00Z', estimated_minutes: 30, tags: ['admin'] },
    ];
    const indices = deterministicIndices(tasks, 'deep-work');
    expect(indices[0]).toBe(0); // A (themed) leads despite no deadline
    expect(indices[1]).toBe(1); // B (urgent but unthemed) second
  });

  it('theme is primary; deadline then priority order within a theme band', () => {
    // Sort key: themeTag → due → priority → id
    // A: P3 deep-work (themed) due=null
    // B: P1 admin (not themed) due=null
    // Theme is primary → A (themed) before B (P1 but unthemed).
    const tasks: PlanTask[] = [
      { task_id: 'A', title: 'P3 themed', priority: 3, due_at: null, estimated_minutes: 30, tags: ['deep-work'] },
      { task_id: 'B', title: 'P1 not themed', priority: 1, due_at: null, estimated_minutes: 30, tags: ['admin'] },
    ];
    const indices = deterministicIndices(tasks, 'deep-work');
    expect(indices[0]).toBe(0); // A (themed, even though P3) first
    expect(indices[1]).toBe(1); // B (P1 but not themed) second
  });

  it('no themeTag: same ordering as without theme', () => {
    const tasks: PlanTask[] = [
      { task_id: 'A', title: 'P1', priority: 1, due_at: null, estimated_minutes: 30, tags: ['deep-work'] },
      { task_id: 'B', title: 'P3', priority: 3, due_at: null, estimated_minutes: 30, tags: ['admin'] },
    ];
    const withNull = deterministicIndices(tasks, null);
    const withUndef = deterministicIndices(tasks);
    expect(withNull).toEqual(withUndef);
    expect(withNull[0]).toBe(0); // P1 first
  });
});

// ─── §C2 integration: authorPlanOrder applies day_theme ──────────────────────

describe('§C2 authorPlanOrder integration', () => {
  const DATE = '2026-06-22'; // Monday

  beforeEach(() => {
    resetDb();
  });

  it('themed weekday: theme-tagged tasks rank before non-themed (same priority, same deadline)', async () => {
    setDayTheme({ mon: 'deep-work' });

    const themed1 = insertTask('Deep A', 3, null, 30);
    const themed2 = insertTask('Deep B', 3, null, 30);
    const notThemed = insertTask('Admin C', 3, null, 30);

    addTag(themed1, 'deep-work');
    addTag(themed2, 'deep-work');
    addTag(notThemed, 'admin');

    // Stage in unfavorable order: admin first, then deep-work tasks
    stage(notThemed, 0);
    stage(themed1, 1);
    stage(themed2, 2);

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows(DATE);
    expect(rows).toHaveLength(3);

    const taskById = new Map(
      (sqlite.prepare(`SELECT id, title FROM tasks`).all() as { id: string; title: string }[]).map((t) => [t.id, t.title]),
    );

    const deepWorkPositions = rows
      .filter((r) => ['Deep A', 'Deep B'].includes(taskById.get(r.task_id) ?? ''))
      .map((r) => r.position);
    const adminPositions = rows
      .filter((r) => taskById.get(r.task_id) === 'Admin C')
      .map((r) => r.position);

    // All deep-work positions must come before admin position
    for (const dwPos of deepWorkPositions) {
      for (const adPos of adminPositions) {
        expect(dwPos).toBeLessThan(adPos);
      }
    }
  });

  it('non-themed weekday (Tuesday, no day_theme entry): order unchanged from non-themed', async () => {
    const DATE_TUE = '2026-06-23'; // Tuesday
    setDayTheme({ mon: 'deep-work' }); // no 'tue' entry

    const t1 = insertTask('P1 task', 1, null, 30);
    const t2 = insertTask('P3 task', 3, null, 30);
    addTag(t1, 'admin');
    addTag(t2, 'deep-work'); // deep-work tag, but no theme for Tuesday

    stage(t1, 0);
    stage(t2, 1);

    await authorPlanOrder(OWNER, DATE_TUE);

    const rows = dailyPlanRows(DATE_TUE);
    expect(rows).toHaveLength(2);
    // Without theme, P1 (t1) comes first
    expect(rows[0].task_id).toBe(t1);
    expect(rows[1].task_id).toBe(t2);
  });

  it('empty day_theme: no change in ordering', async () => {
    setDayTheme({});

    const t1 = insertTask('P1', 1, null, 30);
    const t2 = insertTask('P3', 3, null, 30);
    addTag(t1, 'admin');
    addTag(t2, 'deep-work');
    stage(t1, 0);
    stage(t2, 1);

    await authorPlanOrder(OWNER, DATE);
    const rows = dailyPlanRows(DATE);
    expect(rows).toHaveLength(2);
    expect(rows[0].task_id).toBe(t1); // P1 still first
  });

  it('null day_theme: no change in ordering', async () => {
    // day_theme is already NULL from resetDb
    const t1 = insertTask('P1', 1, null, 30);
    const t2 = insertTask('P3 themed', 3, null, 30);
    addTag(t1, 'admin');
    addTag(t2, 'deep-work');
    stage(t1, 0);
    stage(t2, 1);

    await authorPlanOrder(OWNER, DATE);
    const rows = dailyPlanRows(DATE);
    expect(rows).toHaveLength(2);
    expect(rows[0].task_id).toBe(t1); // P1 first, no theme influence
  });

  it('source is "deterministic" for basic planning_mode', async () => {
    const t1 = insertTask('T1', 3, null, 30);
    const t2 = insertTask('T2', 3, null, 30);
    stage(t1, 0);
    stage(t2, 1);

    await authorPlanOrder(OWNER, DATE);
    const rows = dailyPlanRows(DATE);
    for (const row of rows) {
      expect(row.source).toBe('deterministic');
    }
  });
});

// ─── §A2 + §C2 interaction: both apply together ───────────────────────────────

describe('§A2 + §C2 combined', () => {
  const DATE = '2026-06-22'; // Monday

  beforeEach(() => {
    resetDb();
  });

  it('theme bias orders groups, then post-pass clusters each group', async () => {
    setDayTheme({ mon: 'deep-work' });

    const dw1 = insertTask('DW-1', 3, null, 30);
    const ad1 = insertTask('AD-1', 3, null, 30);
    const dw2 = insertTask('DW-2', 3, null, 30);
    const ad2 = insertTask('AD-2', 3, null, 30);

    addTag(dw1, 'deep-work');
    addTag(ad1, 'admin');
    addTag(dw2, 'deep-work');
    addTag(ad2, 'admin');

    // Stage in mixed order: admin first, deep-work second, etc.
    stage(ad1, 0);
    stage(dw1, 1);
    stage(ad2, 2);
    stage(dw2, 3);

    await authorPlanOrder(OWNER, DATE);

    const rows = dailyPlanRows(DATE);
    expect(rows).toHaveLength(4);

    const deepWorkIds = [dw1, dw2];
    const adminIds = [ad1, ad2];

    const dwPositions = rows.filter((r) => deepWorkIds.includes(r.task_id)).map((r) => r.position);
    const adPositions = rows.filter((r) => adminIds.includes(r.task_id)).map((r) => r.position);

    // deep-work group (themed) should come first
    for (const dwPos of dwPositions) {
      for (const adPos of adPositions) {
        expect(dwPos).toBeLessThan(adPos);
      }
    }

    // Each group is contiguous
    expect(Math.max(...dwPositions) - Math.min(...dwPositions)).toBe(dwPositions.length - 1);
    expect(Math.max(...adPositions) - Math.min(...adPositions)).toBe(adPositions.length - 1);
  });
});

