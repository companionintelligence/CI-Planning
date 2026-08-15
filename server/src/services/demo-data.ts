import { store } from '../db/store.js';
import { createTask, createRecurringTask } from './tasks.js';
import { createObjective, linkObjectiveTask } from './objectives.js';
import { createBlock } from './blocks.js';
import { ownerTimezone } from '../engine/recurrence-generate.js';
import { localDateInTZ, zonedWallTimeToUTC } from '../lib/tz.js';
import { logger } from '../lib/logger.js';

/**
 * The demo dataset the "Try with sample data" button installs.
 *
 * Small, curated and wholly generic BY DESIGN. It replaced a path that ran the fixture
 * Gmail/Calendar connectors through ingest → promote, which produced ~100 invented-but
 * -business-shaped tasks and, worse, put fixture contents in front of every new user and
 * into every screenshot. Nothing here is derived from anyone's real data.
 *
 * It writes through the ORDINARY SERVICES — `createTask`, `createRecurringTask`,
 * `createObjective`, `createBlock` — not raw SQL. A demo assembled by hand-written
 * INSERTs drifts from what the app itself produces (missing tag levels, no habit
 * pattern, no audit row, no sync stamp), and then the demo stops being a demonstration
 * of the product. The cost is that this file has to know the same argument shapes the
 * routes use; the benefit is that a task seeded here is indistinguishable from one the
 * user typed.
 *
 * Everything lands in the OWNER'S timezone, and the Time Block is placed on whatever
 * "today" is when the button is pressed — a demo dated to the day it was written is a
 * demo of an empty calendar a week later.
 */

/** Where the Deep-work Time Block sits, owner-local. Two hours, three tasks inside. */
const DEEP_WORK = { start: '09:00', end: '11:00' } as const;

/** Owner-local clock pins for the meals. The other habits stay unpinned so the
 *  autoscheduler has something to actually place — a demo where everything is already
 *  nailed down shows none of the scheduling. */
const MEAL_TIMES = { Breakfast: '07:30', Lunch: '13:00', Dinner: '18:30' } as const;

const MARKETPLACE_DOC = 'https://docs.ci.computer/docs/contributing/submitting-to-marketplace';

/** The objective's three steps, in order. The first carries the link the reviewer needs. */
const OBJECTIVE_STEPS: { title: string; notes?: string; minutes: number }[] = [
  {
    title: 'Review Hub Requirements',
    notes: `What the Hub expects before an app can be listed: ${MARKETPLACE_DOC}`,
    minutes: 40,
  },
  { title: 'Update App', minutes: 40 },
  { title: 'Investigate Companion Memory Plug-In', minutes: 40 },
];

/** One-off tasks, one per direction, left in the backlog so Auto has work to place. */
const LOOSE_TASKS: { title: string; direction: string; minutes: number }[] = [
  { title: 'Review notes', direction: 'work', minutes: 30 },
  { title: 'Get groceries', direction: 'home', minutes: 45 },
  { title: 'Drop off donations', direction: 'community', minutes: 30 },
];

/** Daily habits. `time` pins a wall clock; absent means the engine chooses. */
const HABITS: { title: string; direction: string; minutes: number; time?: string }[] = [
  { title: 'Breakfast', direction: 'home', minutes: 30, time: MEAL_TIMES.Breakfast },
  { title: 'Lunch', direction: 'home', minutes: 30, time: MEAL_TIMES.Lunch },
  { title: 'Dinner', direction: 'home', minutes: 45, time: MEAL_TIMES.Dinner },
  { title: 'Email triage', direction: 'work', minutes: 30 },
  { title: 'Gym', direction: 'community', minutes: 60 },
];

const OBJECTIVE_TITLE = 'Launch app in Companion-Hub';

export interface DemoSeedResult {
  tasks: number;
  habits: number;
  objectives: number;
  blocks: number;
  /** Set when the seed declined to run; the caller reports it verbatim. */
  skipped?: string;
}

/**
 * Guarantee the three direction tags exist, with `kind = 'direction'`, before anything
 * is tagged.
 *
 * Not belt-and-braces — it prevents a silent corruption. Tasks here are tagged BY NAME,
 * and `syncLeveledEntityTags` resolve-or-CREATES a name it cannot find, using the
 * default kind (`intention`). So on an owner missing their base tags, seeding would
 * manufacture intention tags called "work"/"home"/"community", leaving the demo with no
 * directions at all — the autoscheduler would place none of it, and the owner's tag
 * vocabulary would carry three lookalikes that shadow the real thing.
 *
 * `provisionOwner` (lib/owners.ts) gives every real owner these rows, so this is
 * normally a no-op; it matters for an owner provisioned before that existed, and it is
 * what makes the seed correct on its own terms rather than by inheritance.
 * Mirrors provisionOwner's insert exactly, `is_base = 1` included.
 */
async function ensureDirectionTags(ownerId: string): Promise<void> {
  const ins = store().prepare(
    `INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (uuid7(), ?, ?, 'direction', 1)`,
  );
  for (const name of ['work', 'home', 'community']) {
    const found = await store()
      .prepare(`SELECT 1 FROM tags WHERE owner_id = ? AND name = ? AND kind = 'direction' LIMIT 1`)
      .get(ownerId, name);
    if (!found) await ins.run(ownerId, name);
  }
}

/**
 * Place today's meal blocks at the wall-clock times the demo promises.
 *
 * WHY THIS IS NOT LEFT TO THE ENGINE. A habit becomes a routine Pattern, and
 * `engine/patterns-place.ts` lays a routine out by PACKING it into the workday window —
 * it never reads the member's `task_time`. Seeded on a day whose Deep-work block already
 * owns 09:00–11:00, breakfast/lunch/dinner came out at 11:10, 11:50 and 12:30, and the
 * placement was then mirrored back onto today's instances, overwriting their 07:30/13:00
 * /18:30 pins. Tomorrow onward is correct because nothing has placed those days yet.
 *
 * So today is pinned here, and the routine packer is told to stand down for these
 * patterns using ITS OWN contract: a block carrying `source_kind = 'pattern'` and
 * `source_ref = <pattern id>` inside the local day is the marker it checks before
 * placing (patterns-place.ts, "Marker: any pattern-owned blocks … already?"). Writing
 * the marker is what keeps this from double-booking rather than fighting the engine.
 *
 * Shape mirrors the packer's free-placement branch exactly — a `timeblock` container
 * with the task block inside it — so a pinned meal is indistinguishable from a packed
 * one, and group-move still carries it.
 *
 * This is the one place the module uses raw INSERTs: `createBlock` cannot stamp
 * `source_kind`/`source_ref`, and without them the marker does not exist and the packer
 * would add a second copy of every meal.
 *
 * NB the underlying product gap is real and unfixed: a habit carrying a `task_time` is
 * packed rather than pinned on any day the engine places. Worth its own change.
 */
async function pinMealsForToday(
  ownerId: string,
  templateId: string,
  title: string,
  time: string,
  minutes: number,
  today: string,
  tz: string,
): Promise<number> {
  const pattern = await store()
    .prepare(
      `SELECT p.id FROM patterns p JOIN pattern_tasks pt ON pt.pattern_id = p.id
        WHERE pt.task_id = ? AND p.owner_id = ? LIMIT 1`,
    )
    .get<{ id: string }>(templateId, ownerId);
  // Today's materialized instance is what the calendar shows; the template is never
  // rendered. Without it the block would point at a row the day view filters out.
  const instance = await store()
    .prepare(
      `SELECT id FROM tasks WHERE owner_id = ? AND recurrence_parent_id = ? AND scheduled_for = ? LIMIT 1`,
    )
    .get<{ id: string }>(ownerId, templateId, today);
  if (!pattern || !instance) return 0;

  const startAt = zonedWallTimeToUTC(today, time, tz);
  const endAt = new Date(Date.parse(startAt) + minutes * 60_000).toISOString();
  const ref = String(pattern.id);

  const container = await store()
    .prepare(
      `INSERT INTO time_blocks (id, owner_id, title, block_kind, tag, start_at, end_at,
                                is_locked, is_auto, source_kind, source_ref, status)
       VALUES (uuid7(), ?, ?, 'timeblock', 'home', ?, ?, 0, 1, 'pattern', ?, 'planned') RETURNING id`,
    )
    .get<{ id: string }>(ownerId, title, startAt, endAt, ref);
  await store()
    .prepare(
      `INSERT INTO time_blocks (id, task_id, owner_id, title, block_kind, start_at, end_at,
                                is_locked, is_auto, source_kind, source_ref, status, parent_block_id)
       VALUES (uuid7(), ?, ?, ?, 'task', ?, ?, 0, 1, 'pattern', ?, 'planned', ?)`,
    )
    .run(instance.id, ownerId, title, startAt, endAt, ref, container!.id);
  return 2;
}

/**
 * Has this owner already got the demo? Keyed on the objective title, which is the one
 * row in the set that is unique and unlikely to be typed by hand.
 *
 * Idempotence matters more than it looks: the button is reachable from a wizard the
 * user can re-enter, and a second press must not leave them with two of everything to
 * delete by hand.
 */
async function alreadySeeded(ownerId: string): Promise<boolean> {
  const row = await store()
    .prepare(`SELECT 1 FROM objectives WHERE owner_id = ? AND title = ? AND status != 'archived' LIMIT 1`)
    .get(ownerId, OBJECTIVE_TITLE);
  return !!row;
}

/**
 * Install the demo dataset for one owner. Returns what it created, or `skipped` when
 * the owner already has it.
 *
 * Not wrapped in a single transaction, deliberately: `createRecurringTask` materializes
 * instances through `generateRecurrences`, which runs its own transactions, and nesting
 * those under one outer transaction would hold a write lock across the whole seed. The
 * cost is that a mid-way failure leaves a partial demo — recoverable by deleting the
 * objective and pressing the button again, and far cheaper than the alternative.
 */
export async function seedDemoData(ownerId: string, now: Date = new Date()): Promise<DemoSeedResult> {
  const result: DemoSeedResult = { tasks: 0, habits: 0, objectives: 0, blocks: 0 };
  if (await alreadySeeded(ownerId)) return { ...result, skipped: 'Sample data is already loaded' };

  await ensureDirectionTags(ownerId);
  const tz = await ownerTimezone(ownerId);
  // Owner-local 'today' derived from the INJECTED clock, so a test can pin the day
  // and the demo still lands on the real one in production.
  const today = localDateInTZ(now.toISOString(), tz);

  // ── Loose tasks: one per direction, unscheduled ─────────────────────────────
  for (const t of LOOSE_TASKS) {
    const res = await createTask(ownerId, {
      title: t.title,
      estimated_minutes: t.minutes,
      priority: 3,
      tags: [t.direction],
    });
    if (res.ok) result.tasks++;
  }

  // ── Habits: daily, the meals pinned to a clock ──────────────────────────────
  for (const h of HABITS) {
    const res = await createRecurringTask(ownerId, {
      title: h.title,
      subtype: 'habit',
      recurrence_rule: 'FREQ=DAILY',
      estimated_minutes: h.minutes,
      priority: 3,
      tags: [h.direction],
      ...(h.time ? { task_time: h.time } : {}),
    });
    if (!res.ok) continue;
    result.habits++;
    // A pinned habit is placed here for today; an unpinned one is left for the routine
    // packer, so the demo shows both a fixed rhythm and the engine doing its job.
    if (h.time) {
      result.blocks += await pinMealsForToday(ownerId, res.template.id, h.title, h.time, h.minutes, today, tz);
    }
  }

  // ── The objective and its three steps ───────────────────────────────────────
  const objective = await createObjective(ownerId, {
    title: OBJECTIVE_TITLE,
    description: 'Get Companion Planning listed on the Companion Hub marketplace.',
    horizon: 'quarter',
  });
  const stepTaskIds: string[] = [];
  if (objective.ok) {
    result.objectives++;
    for (const step of OBJECTIVE_STEPS) {
      const res = await createTask(ownerId, {
        title: step.title,
        ...(step.notes ? { notes: step.notes } : {}),
        estimated_minutes: step.minutes,
        priority: 2,
        scheduled_for: today,
        tags: ['work'],
      });
      if (!res.ok) continue;
      result.tasks++;
      stepTaskIds.push(res.task.id);
      await linkObjectiveTask(objective.row.id, res.task.id);
    }
  }

  // ── The Deep-work Time Block, with the objective's steps inside it ──────────
  // Created BEFORE the members so `parent_block_id` has something to point at, and
  // given an explicit direction so the block reads as work time rather than anonymous.
  const container = await createBlock(ownerId, {
    title: 'Deep work',
    block_kind: 'timeblock',
    block_type: 'scheduled',
    tag: 'work',
    start_at: zonedWallTimeToUTC(today, DEEP_WORK.start, tz),
    end_at: zonedWallTimeToUTC(today, DEEP_WORK.end, tz),
  });
  if (container.ok) {
    result.blocks++;
    // Split the container evenly across however many steps actually got created, so a
    // partial failure above still yields a tidy block rather than overlapping children.
    const startMs = Date.parse(zonedWallTimeToUTC(today, DEEP_WORK.start, tz));
    const endMs = Date.parse(zonedWallTimeToUTC(today, DEEP_WORK.end, tz));
    const slice = stepTaskIds.length ? Math.floor((endMs - startMs) / stepTaskIds.length) : 0;
    for (const [i, taskId] of stepTaskIds.entries()) {
      const from = startMs + i * slice;
      const member = await createBlock(ownerId, {
        task_id: taskId,
        title: OBJECTIVE_STEPS[i]?.title ?? 'Step',
        block_kind: 'task',
        start_at: new Date(from).toISOString(),
        end_at: new Date(from + slice).toISOString(),
        parent_block_id: container.block.id,
      });
      if (member.ok) result.blocks++;
    }
  }

  logger.info('demo-data seeded', { ownerId, ...result });
  return result;
}
