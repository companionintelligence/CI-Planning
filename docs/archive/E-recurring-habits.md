# E — Recurring tasks & habits (implementation spec)

Companion to [ROADMAP.md](ROADMAP.md). Depends on **B0** (migration runner + owner-scoped `lib/context.ts`) and **C** (rich task semantics: `scheduled_for`, `defer_until`, dependencies). This phase makes recurrence real and wires the decorative `habit` block kind into actual behavior.

## Goal
1. A **recurrence model** on `tasks` (`recurrence_rule` as an RFC-5545 RRULE string, `recurrence_parent_id` linking instances to a template, `is_habit` flag) — driven by **rrule.js**, never a hand-rolled expander.
2. A **bounded, idempotent generation job** (croner) that materializes upcoming instances on a rolling horizon so a recurring template can't grow `tasks` unbounded (ties to the scale budget).
3. **Per-instance complete/skip**, **missed-habit surfacing**, and a client **recurrence editor + habit streak display**, with **series-edit vs single-instance-edit** kept distinct.

## Non-goals
- Calendar-grid rendering of recurrence (Phase F owns the grid; E only produces tasks/blocks it renders).
- AI-assisted ordering of habit instances (deferred to **G**, which consumes E's history).
- Two-way sync of recurring events to Google/Outlook (Phase J; `external_events` is out of scope here).
- Notifications/reminders for missed habits (Phase H fires them; E only sets the surfacing state).
- Sub-daily recurrence (`FREQ=HOURLY/MINUTELY`) and `RRULE` set-arithmetic beyond a single rule + `EXDATE` — explicitly rejected at validation time.

## Current state (what exists today)
- **`server/src/db/schema.ts`** — `tasks` has `status` (`open | scheduled | in_progress | done | cancelled | deferred`), `dueAt`, `taskTime` (HH:MM pin), `parentId` (subtask link, **not** recurrence), `ownerId`. No recurrence columns. `time_blocks.blockKind` already lists `habit` as a value (`task | meeting | habit | focus | break | buffer`) but **nothing reads or writes it** — it is decorative.
- **`server/src/jobs/index.ts`** — `runJob(kind)` dispatches by `kind` over a `switch`, records a `job_runs` row, and `broadcast()`s `job:started`/`job:run`. `startCronJobs()` reads `scheduled_jobs` and registers each via `new Cron(job.cron, …)` from **croner**. Job kinds today: `ingest_gmail`, `ingest_gcal`, `promote_possibles`, `nightly_grooming`, `auto_schedule`.
- **`server/src/db/setup.ts`** — seeds five `scheduled_jobs` rows (e.g. `auto_schedule` at `0 3 * * *`) via `INSERT OR IGNORE`. **B0 folds this into numbered migrations; E adds its seed there, never edits `setup.ts`.**
- **`server/src/engine/scheduler.ts`** — `runScheduler(date)` builds the "today set" from `tasks` where `status = 'open'`, packs focus sessions into gaps, and is **idempotent per local day** (clears auto/unlocked/un-actioned blocks first). It reads tasks; it does not generate them. Recurrence must produce concrete `tasks` rows for the scheduler to see.
- **`server/src/lib/tz.ts`** — `zonedWallTimeToUTC(date, 'HH:MM', tz)` and `utcDayBounds(date, tz)` are the **only** sanctioned way to turn wall-clock into UTC instants; two-pass, DST-correct. `serverTimezone()` resolves the IANA zone. All E timestamps go through these.
- **`server/src/lib/dates.ts`** — `localISODate()` yields today's `YYYY-MM-DD` (used by the `auto_schedule` job).
- **`client/src/components/TaskForm.tsx`** — SolidJS modal with title/priority/due-date/task-time/estimate/notes/tags. No recurrence UI. Edits call `api.tasks.update(id, body)` with no series/single distinction.
- `rrule` is **not** a dependency in `server/package.json`.

## Design

### 1. Schema migration — recurrence columns + instance index
New numbered migration through the B0 runner (next free prefix after C's migrations; shown as `00NN` below). Additive only — no table rebuild needed.

```ts
// server/src/db/migrations/00NN_recurrence.ts
import type { Database } from 'better-sqlite3';
export const id = '00NN_recurrence';
export function up(db: Database): void {
  // addColumn-if-missing keeps this idempotent for B0 baseline adoption.
  const cols = (db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[]).map((c) => c.name);
  const add = (sql: string, name: string) => { if (!cols.includes(name)) db.exec(sql); };
  add(`ALTER TABLE tasks ADD COLUMN recurrence_rule TEXT`, 'recurrence_rule');         // RRULE string, null = one-off
  add(`ALTER TABLE tasks ADD COLUMN recurrence_parent_id INTEGER REFERENCES tasks(id)`, 'recurrence_parent_id');
  add(`ALTER TABLE tasks ADD COLUMN recurrence_dtstart TEXT`, 'recurrence_dtstart');   // UTC ISO anchor of the series
  add(`ALTER TABLE tasks ADD COLUMN recurrence_exdates TEXT`, 'recurrence_exdates');    // JSON string[]: skipped local dates
  add(`ALTER TABLE tasks ADD COLUMN occurrence_date TEXT`, 'occurrence_date');          // local YYYY-MM-DD of THIS instance
  add(`ALTER TABLE tasks ADD COLUMN is_habit INTEGER DEFAULT 0`, 'is_habit');
  // Idempotency guard: one materialized instance per (template, occurrence date).
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_task_occurrence
           ON tasks(recurrence_parent_id, occurrence_date)
           WHERE recurrence_parent_id IS NOT NULL`);
  // Scale-budget index: generator/scheduler scan owner + status + due cheaply.
  db.exec(`CREATE INDEX IF NOT EXISTS ix_task_owner_status_due ON tasks(owner_id, status, due_at)`);
}
```

Mirror the columns in `schema.ts` (`recurrenceRule`, `recurrenceParentId`, `recurrenceDtstart`, `recurrenceExdates` (json mode), `occurrenceDate`, `isHabit` boolean mode).

**Roles.** A **template** row has `recurrence_rule != null` and `recurrence_parent_id = null`; it is never scheduled directly (excluded from the scheduler's today-set — see §4). An **instance** row has `recurrence_parent_id = <template>` and `occurrence_date` set; it is an ordinary task the existing scheduler already handles. `is_habit` propagates template→instance.

### 2. RRULE engine — wrap rrule.js, do not hand-roll
DST/`UNTIL`/`COUNT`/`EXDATE` are exactly the traps Phase A already paid for. Add the dependency and confine all expansion to one module.

```ts
// server/src/engine/recurrence.ts
import { RRule, rrulestr } from 'rrule';
import { zonedWallTimeToUTC, utcDayBounds } from '../lib/tz.js';

export interface Template {
  recurrenceRule: string;           // e.g. 'FREQ=WEEKLY;BYDAY=MO,WE,FR'
  recurrenceDtstart: string;        // UTC ISO anchor
  taskTime: string | null;          // 'HH:MM' wall-clock, or null (all-day-ish)
  recurrenceExdates: string[];      // local YYYY-MM-DD already excluded/skipped
  timezone: string;
}

/** Local YYYY-MM-DD occurrences in [fromDate, toDate], honoring EXDATE. Deterministic. */
export function occurrencesBetween(t: Template, fromDate: string, toDate: string): string[] {
  const rule = rrulestr(`DTSTART:${toRRuleUTC(t.recurrenceDtstart)}\nRRULE:${t.recurrenceRule}`);
  const lo = new Date(utcDayBounds(fromDate, t.timezone).start);
  const hi = new Date(utcDayBounds(toDate, t.timezone).end);
  const ex = new Set(t.recurrenceExdates);
  // rrule.js operates on the DTSTART's clock; we anchor in UTC and re-derive the
  // LOCAL calendar date of each hit, so a MWF rule stays MWF across a DST flip.
  return rule.between(lo, hi, true)
    .map((d) => localDateOf(d, t.timezone))   // Intl-based, same source as tz.ts
    .filter((day, i, a) => a.indexOf(day) === i && !ex.has(day));
}

/** The concrete UTC start instant for an instance on `localDay`, via the sanctioned tz path. */
export function instanceStartUTC(localDay: string, taskTime: string | null, tz: string): string {
  return zonedWallTimeToUTC(localDay, (taskTime ?? '00:00').slice(0, 5), tz);
}
```

Key rule: **rrule.js computes the recurrence pattern; `lib/tz.ts` computes the wall-clock→UTC instant.** Never let rrule.js own the timezone math — it pins to the DTSTART clock, and the codebase's DST contract lives in `tz.ts`. `toRRuleUTC`/`localDateOf` are thin Intl shims (reuse the formatter pattern already in `tz.ts`).

Validation: `parseRule(s)` round-trips through `rrulestr`, rejects `FREQ=HOURLY|MINUTELY|SECONDLY`, requires a `FREQ`, and caps `COUNT`/`UNTIL` span at the horizon ceiling (§3). Invalid rule → 422, never a thrown 500.

### 3. Generation job — bounded, idempotent (croner)
A new job kind `generate_recurrences`, seeded as a `scheduled_jobs` row **in a migration** (not `setup.ts`), dispatched by the existing `runJob` switch in `jobs/index.ts`.

```ts
// server/src/jobs/index.ts  (new case in execute())
case 'generate_recurrences': {
  const r = generateRecurrences();
  return { itemsCreated: r.created, itemsUpdated: r.skippedMissed,
           log: `Materialized ${r.created} instances; flagged ${r.skippedMissed} missed habits` };
}
```

```ts
// server/src/engine/recurrence.ts  (the job body)
const HORIZON_DAYS = 14;        // bounded rolling window — the scale-budget cap
const MAX_PER_TEMPLATE = 60;    // hard ceiling per template per run (defense in depth)

export function generateRecurrences(): { created: number; skippedMissed: number } {
  const tz = prefsTimezone();                       // scheduling_prefs.timezone || serverTimezone()
  const today = localISODate();
  const horizon = addLocalDays(today, HORIZON_DAYS);
  let created = 0, skippedMissed = 0;

  const templates = sqlite.prepare(
    `SELECT * FROM tasks WHERE recurrence_rule IS NOT NULL AND recurrence_parent_id IS NULL
       AND status NOT IN ('cancelled') AND owner_id = ?`
  ).all(currentOwnerId());                            // owner-scoped via lib/context.ts (B0)

  const ins = sqlite.prepare(
    `INSERT OR IGNORE INTO tasks                       -- unique index makes re-run a no-op
       (title, due_at, task_time, estimated_minutes, priority, status,
        owner_id, recurrence_parent_id, occurrence_date, is_habit, source_kind)
     VALUES (@title,@due,@time,@est,@prio,'open',@owner,@parent,@day,@habit,'recurrence')`
  );

  for (const t of templates as TemplateRow[]) {
    const days = occurrencesBetween(toTemplate(t, tz), today, horizon).slice(0, MAX_PER_TEMPLATE);
    for (const day of days) {
      const r = ins.run({
        title: t.title, due: instanceStartUTC(day, t.task_time, tz), time: t.task_time,
        est: t.estimated_minutes, prio: t.priority, owner: t.owner_id,
        parent: t.id, day, habit: t.is_habit,
      });
      if (r.changes > 0) created++;                   // INSERT OR IGNORE → 0 when already present
    }
    if (t.is_habit) skippedMissed += flagMissedHabits(t.id, today, tz);
  }
  broadcast(currentOwnerId(), 'recurrence:generated', { created, skippedMissed });
  return { created, skippedMissed };
}
```

- **Bounded:** only `[today, today+HORIZON_DAYS]` is ever materialized, capped per template. The table can't grow with wall-clock time — old instances age out as completed/skipped history; new ones appear only as the window rolls. This is the scale-budget tie-in.
- **Idempotent:** `INSERT OR IGNORE` against `ux_task_occurrence` means a second run in the same window inserts **zero** rows (`r.changes === 0`). No "have we generated this?" bookkeeping.
- **Deterministic:** same templates + same `today` + same tz ⇒ identical instance set. No `Date.now()` inside the expander; `today`/`horizon` are the only clock reads, threaded in.
- Seed cron: `'15 3 * * *'` (just after `auto_schedule` at `0 3`, so fresh instances exist before the day is packed). Also callable on-demand from the recurrence route after a template create/edit so new series appear immediately.

### 4. Scheduler & today-set interaction
Templates must never be scheduled; instances must. The scheduler's candidate query (`scheduler.ts`, `status = 'open'`) already excludes templates **if** we keep templates out of `open` — set a template's `status` to `'recurring'` (a new non-schedulable status) so the existing `eq(tasks.status, 'open')` filter skips them with **no scheduler edit**. Instances are plain `open` tasks and flow through unchanged, including the pinned-appointment path (`taskTime` + same-day `dueAt`) that habits with a fixed time will hit.

### 5. Per-instance complete / skip & missed surfacing
- **Complete:** existing `PATCH /api/tasks/:id` → `status='done'` already works on an instance row (it is a normal task). No new endpoint.
- **Skip:** `POST /api/tasks/:id/skip` sets instance `status='skipped'` **and** appends the instance's `occurrence_date` to the **template's** `recurrence_exdates`, so a regenerate won't resurrect it. Owner-scoped.
- **Missed habits:** `flagMissedHabits(templateId, today, tz)` finds instances with `occurrence_date < today` still `status='open'` for a habit template and sets `status='missed'` (new terminal-ish status). They surface in the client as broken-streak markers; Phase H later turns these into notifications. Counted as `skippedMissed` in the job log.

### 6. Series-edit vs single-instance-edit (the distinct-edit contract)
The client and API must make the scope explicit; never guess.

```ts
// PATCH /api/tasks/:id  accepts ?scope=instance|series  (default: instance)
```

- **`scope=instance`** — edits only this row (title/time/estimate for this one day). Detaches nothing; the unique index still protects the slot.
- **`scope=series`** — applies to the **template** (and its `recurrence_rule`/`recurrence_dtstart`/`task_time`). On a rule change: delete **future** un-actioned instances (`occurrence_date >= today AND status='open' AND recurrence_parent_id=template`), keep past/completed/skipped, then call `generateRecurrences()` to re-materialize the window under the new rule. Idempotent by construction.

Resolution helper `resolveEditTarget(id, scope)` returns the template id for `series`, the row id for `instance`; routes in `tasks.ts` branch on it.

### 7. Client — recurrence editor + streak display (SolidJS)
In `TaskForm.tsx`, add a "Repeat" control inside the existing `expanded()` block (mirrors the due-date/task-time row pattern):

```tsx
// signals: const [repeat, setRepeat] = createSignal<'none'|'daily'|'weekly'|'custom'>('none');
//          const [byday, setByday]   = createSignal<string[]>([]);  // ['MO','WE','FR']
//          const [isHabit, setIsHabit] = createSignal(false);
// On submit, compose body.recurrence_rule from (repeat, byday) → 'FREQ=WEEKLY;BYDAY=MO,WE,FR'.
```

- Presets (Daily / Weekly-by-weekday with a MTWTFSS toggle row / Custom RRULE textarea for power users) keep the common path off raw RRULE while still allowing it.
- A **habit** checkbox sets `is_habit`; when on, show a compact streak strip (last 7 occurrences as filled/empty/skipped dots) fed by a `GET /api/tasks/:id/streak` that counts consecutive `done` instances back from `today` (skipped breaks display but a configurable rule can keep the streak — default: skip breaks streak, missed breaks streak).
- **Edit modal**: when `props.editTask` is a recurring instance or template, show a scope toggle ("This task" / "This and future") wired to the `?scope=` param from §6.

## Tests
- **`recurrence.test.ts` (engine, deterministic):**
  - **Weekly MWF expands correctly:** `FREQ=WEEKLY;BYDAY=MO,WE,FR` over a fixed 4-week window yields exactly the right local dates, in order, no dupes.
  - **DST week:** same MWF rule across the US spring-forward week (e.g. `America/Los_Angeles`, 2026-03-08) still yields Mon/Wed/Fri **local** dates, and each instance's `due_at` resolves through `zonedWallTimeToUTC` to the correct instant (no 23/25-hour drift, no skipped or doubled day).
  - `COUNT`/`UNTIL` honored; `EXDATE` removes exactly the excluded local day; invalid rule rejected (422 path), `FREQ=HOURLY` rejected.
- **`generate.test.ts` (job):**
  - **Idempotent re-run:** run `generateRecurrences()` twice on the same `today`+templates ⇒ second run inserts 0 rows (`ux_task_occurrence` holds); instance count unchanged.
  - **Bounded:** instances never exceed `HORIZON_DAYS` ahead; a daily template produces ≤ `HORIZON_DAYS`+1 rows, not an unbounded sweep.
  - Rolling the window forward one day adds exactly the newly-in-window occurrences and nothing retroactive.
- **Edit scope:** `scope=instance` mutates one row, leaves siblings + template untouched; `scope=series` rule change deletes future-open instances, preserves completed/skipped/past, regenerates correctly; second regenerate is a no-op.
- **Complete/skip/missed:** completing an instance is terminal; skip adds the date to template EXDATE and survives a regenerate; an open past habit instance becomes `missed` after the job.
- **Scheduler integration:** templates (`status='recurring'`) never appear as blocks; instances pack normally; an existing Phase-A scheduler test stays green.
- **Standing suites:** server Vitest + container Playwright pass unchanged.

## Acceptance criteria
1. A recurring task generates the next N instances on a **bounded** horizon and regenerates as the window rolls; the table cannot grow unbounded.
2. Weekly-by-MWF expands to the correct local days **including across a DST week**, with correct UTC instants via `lib/tz.ts`.
3. **Series edit** and **single-instance edit** are distinct and both correct; future regeneration respects the chosen scope.
4. Per-instance **complete** and **skip** work; skip is durable across regeneration (EXDATE); **missed habits surface**.
5. Generator **re-run is idempotent** — zero duplicate instances on a second run in the same window.
6. The decorative `habit` is now behaviorally real: habit instances carry `is_habit`, and the client shows a streak.
7. All schema changes shipped as **new numbered migrations** through the B0 runner; `setup.ts` untouched; `rrule` added to `server/package.json`. Existing suite green.

## Risks / notes
- **Timezone ownership split.** rrule.js anchors to the DTSTART clock and is easy to misuse across DST. Mitigation: rrule.js owns the **pattern only**; `lib/tz.ts` owns every wall-clock→UTC conversion. The DST test is the guard. Do not pass IANA zones into rrule.js expecting it to honor them like `tz.ts` does.
- **Unbounded growth is the default failure.** Without `HORIZON_DAYS` + the unique index, a daily habit would append forever. The horizon cap + `INSERT OR IGNORE` are load-bearing, not optional — they are the scale-budget contract.
- **Detached/edited instances.** A `scope=instance` edit must not be clobbered by regeneration. The unique index protects the slot, but a series-rule change deletes only `status='open'` future rows — an edited-but-still-open instance is preserved by virtue of the index; document that edited instances should be marked (e.g. a future `is_detached` flag) if richer divergence is ever needed. Out of scope now; noted.
- **`recurring`/`missed` statuses** are additions to the `status` enum comment in `schema.ts`; ensure any status-filtering UI/API allowlists are updated, or the scheduler's `open`-only filter silently does the right thing (preferred).
- **Croner already in use** — `generate_recurrences` registers through the same `startCronJobs()` path; no new scheduler runtime. Degrade gracefully: if rrule.js throws on a malformed stored rule, log + skip that template, never fail the whole job run.
- **Owner scoping** flows from B0: the generator reads `currentOwnerId()` and broadcasts `broadcast(ownerId, …)`. Do not reintroduce a hardcoded `1`.

## Effort
**M** — roughly 4–6 days. The expander wrapper + migration are small; the cost is the DST-correct test matrix, the series-vs-instance edit semantics end-to-end (API + `TaskForm.tsx`), and the streak/missed surfacing. The generation job itself is ~60 lines on top of the existing `runJob` switch.

## Suggested PR breakdown
1. **Schema + RRULE engine** (no UI): migration (recurrence columns, unique + owner/status/due indexes), `schema.ts` mirror, `engine/recurrence.ts` (`occurrencesBetween`, `instanceStartUTC`, `parseRule`), add `rrule` dep. Ship with `recurrence.test.ts` (incl. the DST case). No behavior change yet.
2. **Generation job + scheduler glue:** `generate_recurrences` case in `jobs/index.ts`, seed migration for the `scheduled_jobs` row, `recurring` status so templates skip the today-set, missed-habit flagging. Ship with `generate.test.ts` (idempotent + bounded).
3. **Per-instance complete/skip + edit scope:** `POST /:id/skip`, `?scope=` on `PATCH /api/tasks/:id`, EXDATE durability, `GET /:id/streak`. Edit-scope tests.
4. **Client editor + streak:** `TaskForm.tsx` repeat control + habit checkbox + scope toggle; streak strip. Wire to the routes above.

Splitting this keeps the deterministic engine (the part that must be right) reviewable in isolation before any UI or job wiring lands on top.

---

## E′ — Habit → Pattern revision (pulled in by Phase G)

> **Status:** PRs 1–4 above are **shipped/merged** (engine, generation job,
> instance ops, client editor + streaks). E′ is the **revision** Phase G requires:
> "habit" becomes a **Pattern type**, not a `tasks.is_habit` flag. Recurrence stays
> a **task-level** concern here (Patterns are collections only — see
> [G-rituals-reflection.md](G-rituals-reflection.md) and
> [design-today-cockpit.md](design-today-cockpit.md)). Each ticket carries
> **Goal · Acceptance · Tests · State**.

### E′-1 — Map habits onto the pattern model (migration)
- **Goal.** Backfill every `is_habit` template into a **habit-type pattern** (one
  pattern per habit) with its recurring task as the member; stop reading
  `tasks.is_habit` for behaviour (keep the column until G2 lands, then ignore/drop).
- **Acceptance.** Each former habit is exactly one habit-type pattern; the task's
  RRULE / generation / instances are untouched; nothing duplicated; migration
  idempotent on re-run.
- **Tests.** Idempotent backfill on a copy of a habit-bearing DB; instance counts +
  occurrence dates unchanged pre/post; owner-scoped.
- **State.** not-started.

### E′-2 — Streaks & skip/complete keyed off habit patterns
- **Goal.** `GET /api/tasks/:id/streak`, skip, and complete semantics resolve
  "is this a habit?" via **habit-type pattern membership** instead of `is_habit`;
  the streak strip reads the same data.
- **Acceptance.** Streak counts, EXDATE-durable skips, and missed-flagging behave
  identically to the shipped E behaviour; the client streak strip is unchanged.
- **Tests.** `generate.test.ts` + `recurrence-ops.test.ts` pass unchanged against
  pattern-backed habits; streak parity test (pre/post identical).
- **State.** not-started. *(Recurrence engine, generation job, and EXDATE/streak
  logic from PRs 1–4 are reused as-is; only the "what is a habit" lookup changes.)*
