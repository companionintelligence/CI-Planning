> **Type:** DB Migration + Backend
> **Phase:** Balance-targets wave — stated targets reach the scheduler
> **Branch:** `feat/balance-week-log`
> **Commit style:** `feat(balance): durable weekly target-vs-actual snapshot + snapshot_balance cron`
> **Design:** [README.md](README.md)
> **Dependencies:** Blocked by ticket 1; independent of 2–5

## Goal

Make the loop learnable: a weekly batch job freezes each completed week's
target / scheduled / timed numbers per dimension into an append-only, owner-scoped
`balance_week_log`. This is the wave's durable-evidence stage under the house
contract (`services/classification-learning.ts` header): the live bias reads the
*instruction*; this log is the *history* any future learning reads ("missed Health 6
weeks running"). Merge early — missed weeks can never be recovered (no backfill;
past calendars mutate and `life_priorities` has no history).

## Non-goals

- **Do not read the log anywhere in this ticket.** Ticket 7 adds the readout; no
  engine, agent, or prompt may read it in this wave at all.
- **Do not gate on `balance_bias_enabled`** — history accrues regardless, like
  `classification_log` accrues with learning surfaces off.
- **Do not backfill** past weeks. First rows appear on the first Monday after merge.
- **Do not update frozen rows.** `INSERT OR IGNORE` only — first-freeze-wins,
  the `freeze_stars` doctrine (a frozen week never recomputes).
- **No learning, no LLM, no knobs, no client change.**

## Pinned conventions

- **Migration:** `server/src/db/migrations/0164_balance_week_log.ts` — **slot
  verified 2026-08-29** (ticket 2's note applies identically: 0157/0158/0161 are
  merged to `origin/main`; 0159/0160 double-claimed on paper by G-INT; 0162 claimed
  by the revision-loop-wave; this ticket steps past all four to 0164). **Re-verify
  at implementation time** per README "Cross-wave dependencies." Skeleton per 0127
  (line-1 type import, `export const id`, why-comment, `up`, idempotent
  `CREATE TABLE IF NOT EXISTS`, register in `index.ts` with `.js` import). Same
  file also seeds the cron row (0150 shows job-seed style):
  `INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (newId(), 'snapshot_balance', 'snapshot_balance', '40 4 * * 1')`
  — Monday 04:40. Checked against every cron row actually merged to `origin/main`
  (`grep -ohE "'[0-9]+ [0-9*]+ \* \* [0-9*]+'" server/src/db/migrations/*.ts`, 21
  rows, nearest neighbors 03:50/04:10/04:20/05:00 Monday) AND against G-INT's
  claimed-on-paper 04:30 Monday (`calibrate_placement`) — 04:40 is clear of both.
  Runs after the calibrate_* passes (single-GPU serialisation reasoning in 0150's
  comment — cite it even though this job needs no model).
- **Table** (raw SQL only — deliberately NOT mirrored in `schema.ts`: the parity
  test asserts only modelled tables, and nothing app-side reads this via Drizzle;
  same doctrine as the close-loop wave's log tables — say so in the migration
  comment):

  ```sql
  CREATE TABLE IF NOT EXISTS balance_week_log (
    id                TEXT PRIMARY KEY,             -- newId() (UUIDv7)
    owner_id          TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
    week_start        TEXT NOT NULL,                -- owner-local Monday, YYYY-MM-DD
    category          TEXT NOT NULL,                -- life_priorities.category key; bare TEXT, code-enforced (house rule: no CHECK)
    target_hours      INTEGER NOT NULL,             -- life_priorities.target_hours_per_week at snapshot time
    scheduled_minutes INTEGER NOT NULL,             -- ticket 1's calendar measure for that week
    timed_minutes     INTEGER NOT NULL,             -- finished time_entries via task categories (SQL_CATEGORY_ENTRIES shape, triality-vector.ts:194)
    created_at        TEXT NOT NULL,                -- ISO-8601 UTC, stamped in code (new Date().toISOString())
    UNIQUE(owner_id, week_start, category)
    -- The UNIQUE(owner_id, week_start, category) index also serves the owner-scoped
    -- recent-weeks read (leftmost owner_id), so no separate index — the 0127 pattern.
  );
  ```
- **Job:** `server/src/services/balance-snapshot.ts` exporting
  `snapshotBalanceWeek(ownerId: string, now: Date): Promise<{ weekStart: string; rows: number }>`
  — computes the **previous** completed week (`weekBoundsFor` on now-minus-7-days,
  owner-local), one row per dimension the owner has a `life_priorities` row for,
  `INSERT OR IGNORE` all rows in one transaction. Zero targets still snapshot
  (target 0 is evidence). No Ollama involvement — degradation N/A; the job never
  throws for an owner with no priorities (rows: 0).
- **Dispatch:** `server/src/jobs/index.ts` — `case 'snapshot_balance'` beside
  `calibrate_classification` (~line 384), log string
  `` `Balance snapshot: ${r.rows} row(s) for week ${r.weekStart}` ``, and add
  `'snapshot_balance'` to `OWNER_SCOPED_KINDS` (~line 505) with a one-line comment
  (evidence never pooled — the WHO-rule comment style at line 388).
- **`lib/owners.ts` deletion:** add `balance_week_log` to the owner-purge deletes
  where `life_priorities` is handled (FK CASCADE covers the FK path; the purge list
  is explicit by convention — match it).
- **Backup:** add the table to `routes/backup.ts` owner export/import exactly where
  `life_priorities` appears in its three lists (allowlist ~112, export ~411,
  import ~563).

## Before implementation

Read `db/migrations/0127_life_priorities.ts` and `0150_calibrate_classification_job.ts`
(both skeletons), `jobs/index.ts:368-412` + `:490-510`, `services/triality-vector.ts:194-200`
(SQL_CATEGORY_ENTRIES), `routes/backup.ts:100-120`, and the close-loop wave README's
"raw-SQL-only tables" decision (`git show aade3a64:docs/factory/close-loop-wave/README.md`).

## Files impacted

**New:**
- `server/src/db/migrations/0164_balance_week_log.ts`
- `server/src/services/balance-snapshot.ts`
- `server/test/balance-snapshot.test.ts`

**Changed:**
- `server/src/db/migrations/index.ts`
- `server/src/jobs/index.ts`
- `server/src/lib/owners.ts`
- `server/src/routes/backup.ts`

## Schema required

Exactly the table + cron seed above. No schema.ts mirror (pinned).

## Definition of Done

- [ ] Migration idempotent (twice; second no-ops); cron row seeded once
- [ ] Job writes one row per (owner, prev-week, dimension); re-run inserts 0
- [ ] Frozen rows never change when the calendar is edited afterwards and the job re-runs
- [ ] `snapshot_balance` owner-scoped in dispatch; purge + backup lists updated
- [ ] schema-parity still green (table deliberately unmodelled)

## Tests

- [ ] Snapshot of a seeded week: target/scheduled/timed all correct per pinned rules
- [ ] Re-run same week ⇒ 0 new rows; changed calendar + re-run ⇒ values frozen
- [ ] Owner with no priorities ⇒ rows: 0, no throw
- [ ] Owner isolation
- [ ] Backup export/import round-trips the table

```bash
pnpm --filter server exec vitest run server/test/balance-snapshot.test.ts
pnpm --filter server exec vitest run server/test/schema-parity.test.ts server/test/backup.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given the Monday 04:40 run, when the previous week had targets, then frozen
      rows exist for all six-or-fewer stated dimensions and never mutate
- [ ] Given a re-run or a later calendar edit, then history is unchanged

## Subtasks

1. [ ] Migration (table + cron seed) + register; renumber if head moved
2. [ ] `balance-snapshot.ts` (prev-week bounds, timed-minutes query, OR IGNORE tx)
3. [ ] Dispatch case + OWNER_SCOPED_KINDS
4. [ ] owners.ts purge + backup.ts lists
5. [ ] Five tests; run verification
