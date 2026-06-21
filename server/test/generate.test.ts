import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { runWithOwner, SYSTEM_OWNER } from '../src/lib/context.js';
import { utcDayBounds } from '../src/lib/tz.js';
import { instanceStartUTC } from '../src/engine/recurrence.js';
import { generateRecurrences } from '../src/engine/recurrence-generate.js';
import { resetDb } from './helpers.js';

/**
 * Generation-job tests (Phase E, PR-2). The expander is covered by
 * recurrence.test.ts; here we exercise the DB-writing job: bounded horizon,
 * idempotent re-run, rolling window, template→`recurring` marking, missed-habit
 * flagging, and the day-gating fields a fresh instance carries.
 *
 * `today`/`horizonDays` are passed explicitly so every assertion is clock-free.
 */

const OWNER = SYSTEM_OWNER;
// Pin a concrete, non-UTC zone so the test is hermetic. resetDb() (since PR #81)
// resets all scheduling_prefs including timezone, but we still set it explicitly in
// beforeEach so the intent is self-documenting and a future resetDb() change can't
// silently break these DST assertions.
const TZ = 'America/Los_Angeles';

interface TemplateOpts {
  rule?: string;
  dtstart?: string;
  taskTime?: string | null;
  isHabit?: boolean;
  status?: string;
  estimatedMinutes?: number | null;
  priority?: number;
}

/** Insert a recurrence template (recurrence_rule set, no parent) and return its id. */
function insertTemplate(o: TemplateOpts = {}): string {
  return (
    sqlite
      .prepare(
        `INSERT INTO tasks
           (id, title, status, owner_id, priority, estimated_minutes, task_time, is_habit,
            recurrence_rule, recurrence_dtstart)
         VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(
        'Recurring thing',
        o.status ?? 'open',
        OWNER,
        o.priority ?? 3,
        o.estimatedMinutes ?? null,
        o.taskTime ?? null,
        o.isHabit ? 1 : 0,
        o.rule ?? 'FREQ=DAILY',
        o.dtstart ?? '2026-06-01T12:00:00.000Z'
      ) as { id: string }
  ).id;
}

const gen = (opts: { today?: string; horizonDays?: number }) =>
  runWithOwner(OWNER, () => generateRecurrences(opts));

interface InstanceRow {
  id: string;
  status: string;
  occurrence_date: string;
  scheduled_for: string | null;
  defer_until: string | null;
  task_time: string | null;
  due_at: string | null;
  source_kind: string;
  is_habit: number;
}

const instances = (tpl: string): InstanceRow[] =>
  sqlite
    .prepare(`SELECT * FROM tasks WHERE recurrence_parent_id = ? ORDER BY occurrence_date`)
    .all(tpl) as InstanceRow[];

const instanceOn = (tpl: string, day: string): InstanceRow | undefined =>
  sqlite
    .prepare(`SELECT * FROM tasks WHERE recurrence_parent_id = ? AND occurrence_date = ?`)
    .get(tpl, day) as InstanceRow | undefined;

const statusOf = (id: string) =>
  (sqlite.prepare(`SELECT status FROM tasks WHERE id = ?`).get(id) as { status: string }).status;

beforeEach(() => {
  resetDb();
  // Pin owner-1's planning zone so the generator and the assertions below agree
  // regardless of what other test files left in scheduling_prefs.
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = ? WHERE owner_id = ?`).run(TZ, OWNER);
});

describe('generateRecurrences — bounded horizon', () => {
  it('materializes exactly the occurrences in [today, today+horizon], no further', () => {
    const tpl = insertTemplate({ rule: 'FREQ=DAILY' });
    const r = gen({ today: '2026-06-10', horizonDays: 3 });

    expect(r.created).toBe(4); // 06-10, 11, 12, 13 (inclusive both ends)
    expect(instances(tpl).map((i) => i.occurrence_date)).toEqual([
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
    ]);
    // Nothing beyond the horizon was created.
    expect(instances(tpl).every((i) => i.occurrence_date <= '2026-06-13')).toBe(true);
  });

  it('a daily template never produces more than horizon+1 rows in one run', () => {
    const tpl = insertTemplate({ rule: 'FREQ=DAILY' });
    gen({ today: '2026-06-10', horizonDays: 14 });
    expect(instances(tpl).length).toBe(15); // 14 days ahead + today, not an unbounded sweep
  });
});

describe('generateRecurrences — idempotent re-run', () => {
  it('a second run in the same window inserts zero rows', () => {
    const tpl = insertTemplate({ rule: 'FREQ=DAILY' });
    gen({ today: '2026-06-10', horizonDays: 3 });
    const second = gen({ today: '2026-06-10', horizonDays: 3 });

    expect(second.created).toBe(0); // ux_task_occurrence holds
    expect(instances(tpl).length).toBe(4); // unchanged
  });
});

describe('generateRecurrences — rolling window', () => {
  it('advancing today by one day adds only the newly-in-window occurrence, nothing retroactive', () => {
    const tpl = insertTemplate({ rule: 'FREQ=DAILY' });
    gen({ today: '2026-06-10', horizonDays: 3 }); // 06-10..13
    const rolled = gen({ today: '2026-06-11', horizonDays: 3 }); // 06-11..14

    expect(rolled.created).toBe(1); // only 06-14 is new
    expect(instances(tpl).map((i) => i.occurrence_date)).toEqual([
      '2026-06-10',
      '2026-06-11',
      '2026-06-12',
      '2026-06-13',
      '2026-06-14',
    ]);
  });
});

describe('generateRecurrences — templates skip the today-set', () => {
  it("marks an 'open' template 'recurring' so the scheduler's open-only filter ignores it", () => {
    const tpl = insertTemplate({ rule: 'FREQ=DAILY', status: 'open' });
    expect(statusOf(tpl)).toBe('open');

    gen({ today: '2026-06-10', horizonDays: 1 });

    expect(statusOf(tpl)).toBe('recurring'); // template excluded from scheduling
    // Instances themselves are plain open tasks.
    expect(instanceOn(tpl, '2026-06-10')!.status).toBe('open');
  });
});

describe('generateRecurrences — missed habits', () => {
  it('flags past, still-open habit instances as missed; leaves today/future open', () => {
    const tpl = insertTemplate({ rule: 'FREQ=DAILY', isHabit: true });
    gen({ today: '2026-06-08', horizonDays: 1 }); // creates 06-08, 06-09 (both open)

    const r = gen({ today: '2026-06-10', horizonDays: 1 }); // creates 06-10, 06-11; flags the past two

    expect(r.missed).toBe(2);
    expect(instanceOn(tpl, '2026-06-08')!.status).toBe('missed');
    expect(instanceOn(tpl, '2026-06-09')!.status).toBe('missed');
    expect(instanceOn(tpl, '2026-06-10')!.status).toBe('open'); // today is not missed
  });

  it('does not flag missed for a non-habit recurring template', () => {
    const tpl = insertTemplate({ rule: 'FREQ=DAILY', isHabit: false });
    gen({ today: '2026-06-08', horizonDays: 1 });
    const r = gen({ today: '2026-06-10', horizonDays: 1 });

    expect(r.missed).toBe(0);
    expect(instanceOn(tpl, '2026-06-08')!.status).toBe('open'); // overdue, not "missed"
  });

  it('a completed past habit instance is not re-flagged missed', () => {
    const tpl = insertTemplate({ rule: 'FREQ=DAILY', isHabit: true });
    gen({ today: '2026-06-08', horizonDays: 1 }); // 06-08, 06-09
    sqlite.prepare(`UPDATE tasks SET status='done' WHERE id = ?`).run(instanceOn(tpl, '2026-06-08')!.id);

    const r = gen({ today: '2026-06-10', horizonDays: 1 });

    expect(r.missed).toBe(1); // only 06-09 (06-08 was done)
    expect(instanceOn(tpl, '2026-06-08')!.status).toBe('done');
  });
});

describe('generateRecurrences — instance day-gating fields', () => {
  it('a timed instance is gated by defer_until and pinned via task_time + same-day due_at', () => {
    const tpl = insertTemplate({ rule: 'FREQ=DAILY', taskTime: '09:00', estimatedMinutes: 45 });
    gen({ today: '2026-06-10', horizonDays: 0 }); // just 06-10

    const inst = instanceOn(tpl, '2026-06-10')!;
    expect(inst.status).toBe('open');
    expect(inst.source_kind).toBe('recurrence');
    expect(inst.scheduled_for).toBe('2026-06-10');
    expect(inst.defer_until).toBe(utcDayBounds('2026-06-10', TZ).start); // not schedulable before its day
    expect(inst.task_time).toBe('09:00');
    expect(inst.due_at).toBe(instanceStartUTC('2026-06-10', '09:00', TZ)); // pins as an appointment
  });

  it('a timeless instance carries no due_at but is still gated to its day', () => {
    const tpl = insertTemplate({ rule: 'FREQ=DAILY', taskTime: null });
    gen({ today: '2026-06-10', horizonDays: 0 });

    const inst = instanceOn(tpl, '2026-06-10')!;
    expect(inst.due_at).toBeNull();
    expect(inst.task_time).toBeNull();
    expect(inst.scheduled_for).toBe('2026-06-10');
    expect(inst.defer_until).toBe(utcDayBounds('2026-06-10', TZ).start);
  });
});

describe('generateRecurrences — robustness', () => {
  it('skips a template with a malformed stored rule without failing the run', () => {
    const good = insertTemplate({ rule: 'FREQ=DAILY' });
    insertTemplate({ rule: 'TOTALLY NOT A RULE' });

    const r = gen({ today: '2026-06-10', horizonDays: 2 });

    expect(r.templates).toBe(2);
    expect(r.created).toBe(3); // only the good template produced rows (06-10,11,12)
    expect(instances(good).length).toBe(3);
  });

  it('excludes cancelled templates', () => {
    const tpl = insertTemplate({ rule: 'FREQ=DAILY', status: 'cancelled' });
    const r = gen({ today: '2026-06-10', horizonDays: 3 });

    expect(r.templates).toBe(0);
    expect(instances(tpl).length).toBe(0);
  });
});
