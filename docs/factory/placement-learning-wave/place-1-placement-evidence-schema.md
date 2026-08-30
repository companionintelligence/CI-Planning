> **Type:** DB Migration
> **Phase:** Placement-learning wave — G-INT (timing intelligence)
> **Branch:** `feat/placement-evidence-schema`
> **Commit style:** `feat(db): 0166 placement evidence log, preference rollup and survival table`
> **Design:** [README.md](README.md)
> **Dependencies:** None — ticket 1 of 6

## Goal

Land the storage the loop needs, in one migration at slot `0166`, mirroring
`0149_classification_learning.ts` end to end. Three tables in the same three-role split the
house pattern uses (`classification_log` → `classification_exemplars` →
`classification_accuracy`):

1. **`placement_log`** — durable, append-only evidence. One row per engine placement,
   opened when the scheduler places and closed if the owner moves it. Carries `candidates`,
   the **menu of free gaps the scheduler weighed** — the load-bearing part: without it
   "moved 9am → 7pm" cannot be told apart from "7pm was already full".
2. **`placement_preferences`** — regenerable rollup; the learned hour band `pickGap` reads.
3. **`placement_survival`** — measurement, so ticket 6 can show whether placements start
   surviving the day untouched.

This ticket lands three empty tables and nothing else.

## Non-goals

- **No `time_blocks` column.** Do not add `moved_from`, `placed_hour` or anything else.
  `time_blocks` **is** modelled in `schema.ts:138`, so a column there would need a
  `schema.ts` edit and would churn `baseline.characterization.test.ts.snap`.
- **No `schema.ts` change.** These are raw-SQL-only tables, exactly like the 0149
  classification trio, `triality_weights` (0142) and `calibration_history` (0138).
  Verified: `grep -c classification server/src/db/schema.ts` → `0`.
  `server/test/schema-parity.test.ts` iterates only what `schema.ts` exports, so a
  migration-only table is invisible to it.
- **No service, no reads, no writes.** Placement capture is ticket 2, correction capture is
  ticket 3, the batch is ticket 4.
- **No cron row and no job kind.** The `calibrate_placement` seed is migration `0167` in
  ticket 4 — one concern per file, as `0149` → `0150` does. Do not touch
  `server/src/jobs/index.ts`, `OWNER_SCOPED_KINDS`, `README.md` or `ARCHITECTURE.md`.
- **No route and no client change.** The route is ticket 6.
- **No enforcement column and nothing that enables one** — no `forbidden_hours`,
  `pinned_hour`, `never_place_before` or any deny-list shape. The rollup is a ranking
  input, not a constraint.
- **No learning-rate knob** — no `weight`, `decay`, `alpha` or tunable strength.
  `period_days` records what window a reading covered; nothing reads it back to change
  behaviour.
- **No CHECK constraints.** `slot_key` and every flag are bare `TEXT`/`INTEGER` with a `--`
  vocabulary comment (repo convention, stated in 0140, 0142, 0149, 0151).
- **No `manual = true`.** That flag exists only for CON-1 rebuilds that toggle
  `PRAGMA foreign_keys`; `CREATE TABLE IF NOT EXISTS` runs inside the runner's transaction.
- **No FK from the log to `time_blocks` or `tasks`.** `reflow()` deletes and recreates auto
  blocks constantly and `resetDb()` clears both tables wholesale — a cascade would erase
  the corpus continuously in production and between test files.
- **No UNIQUE on `(block_id)`** — matching `classification_log`, which has none.
  One-open-row-per-block is ticket 3's problem to solve in code.
- **No backfill.** Nothing today records where the scheduler put a block or what it
  considered, so there is nothing to recover.
- **Do not touch `server/src/lib/owners.ts`.** Verified: none of the 0149 tables appear in
  `purgeOwnerData()` (`owners.ts:227`) or `NON_PORTABLE_OWNER_TABLES` (`owners.ts:306`);
  the `ON DELETE CASCADE` sweeps them from `DELETE FROM owners`. Follow that precedent and
  say so in the PR description so the omission reads as deliberate.
- **Do not add these to `OWNER_SCOPED_TABLES` in `server/test/owner-delete.test.ts`**
  (`owner-delete.test.ts:20`). That list is asserted to have rows *before* the delete, so an
  entry without a `populate()` seed fails; `classification_log` is deliberately absent
  there despite the same cascade.

## Pinned conventions

Verified against the tree — do not substitute.

- **File skeleton.** Line 1 is exactly `import type { Database } from 'better-sqlite3';`
  (type-only). Then `export const id = '0166_placement_evidence';`, a block comment
  explaining *why*, then `export function up(db: Database): void`. All 154 migration
  files (numbered to 0156 — 0009 and 0119 are unused) follow this with zero exceptions. Idempotent, forward-only, additive:
  `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` throughout; no `down`.
- **Registration.** `server/src/db/migrations/index.ts` — add
  `import * as m0166 from './0166_placement_evidence.js';` in numeric order **after
  whatever the tail import actually is at implementation time** — do not assume `m0156`.
  `0157`/`0158` (close-loop wave) and `0161` (an unrelated close-ritual change) merged to
  `main` after this plan was written; `0162` (revision-loop wave) may also have merged by
  then. Run `tail -3 server/src/db/migrations/index.ts` first and append `m0166` after the
  real last entry in the exported `MIGRATIONS` array. The `.js` extension is required (ESM).
- **Slot number.** `0166`, not `0157` and not the `0159`/`0160` this plan originally
  claimed. `0157`/`0158` are **merged to `main`** (close-loop wave, via #586/#587) — no
  longer "on paper." `0159`/`0160` were independently claimed by both this wave and the
  balance-targets wave (N2); this wave moved off them, documented in [README.md](README.md)
  § reserved slots. If `0166`/`0167` are ALSO taken by the time you start — re-sweep with
  the command in that section — renumber this file and ticket 4's; nothing else in either
  ticket references the numbers.
- **Owner column.** `owner_id TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE`.
- **Timestamps.** ISO-8601 `TEXT`, stamped in code via `new Date().toISOString()`. Never a
  SQL `CURRENT_TIMESTAMP` default on a decision stamp — `time_blocks.created_at` uses one
  and its space-separated format must never be string-compared with these.
- **Ids.** `TEXT PRIMARY KEY`, UUIDv7 supplied by `newId()` from `server/src/lib/ids.js`
  (the log only; the two rollups are keyed by composite PK with no surrogate id).
- **Enums / flags are bare TEXT / INTEGER enforced in code**, documented by a trailing `--`
  comment.
- **Index naming.** `ix_<table>_<cols>`, each with a `--` comment naming the read it
  serves. No index redundant with a PK prefix.
- **Rollup shape.** `classification_exemplars` has a composite PK, no surrogate `id` and no
  index — every read is a PK-prefix scan on `owner_id`. Mirror that for both rollups.
- **`resetDb()`** (`server/test/helpers.ts:32`) — add one `DELETE FROM` per new table with a
  `-- 0166:` comment, alongside the existing `triality_log` / `triality_weights` entries.
  `placement_preferences` is read by a production path, so a leftover row would silently
  bend another test file's Auto placement.

## Before implementation

Read, in order: `0149_classification_learning.ts` (the template — match its comment density
and three-role split), `0156_capacity_hours_per_week.ts` (latest slot, current house style),
`server/src/db/migrations/index.ts`, `server/test/helpers.ts` (`resetDb`), and
`server/test/schema-parity.test.ts` (to confirm why no `schema.ts` change is needed).

## Files impacted

**New:**
- `server/src/db/migrations/0166_placement_evidence.ts`

**Changed:**
- `server/src/db/migrations/index.ts` — import + `MIGRATIONS` entry
- `server/test/helpers.ts` — three `DELETE FROM`s in `resetDb()`

## Schema required

```sql
CREATE TABLE IF NOT EXISTS placement_log (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  -- Nullable and deliberately NOT foreign keys: the evidence outlives the block and the
  -- task. reflow() deletes and recreates auto blocks on every run, and resetDb() clears
  -- both tables wholesale — a cascade would erase the corpus continuously.
  block_id        TEXT,
  task_id         TEXT,
  -- The learned grain: the task's level-1 direction tag NAME ('work' | 'home' |
  -- 'community' | ...), or the literal '(none)'. A name, never a tag id — a renamed or
  -- deleted tag must not orphan the evidence.
  slot_key        TEXT    NOT NULL,
  auto_run_id     TEXT,              -- the Auto run that made this placement (0052); NULL outside a run
  -- What the scheduler chose.
  chosen_start_at TEXT    NOT NULL,
  chosen_end_at   TEXT    NOT NULL,
  chosen_hour     INTEGER NOT NULL,  -- 0-23, OWNER-LOCAL hour of chosen_start_at
  -- 1 when pickGap found a gap that fully fit; 0 when it fell back to the largest gap and
  -- truncated. A truncated placement is forced, not chosen, so it expresses no preference
  -- and the batch excludes it from both sides of the ledger.
  fit             INTEGER NOT NULL,
  -- THE MENU: the free gaps the scheduler weighed, as a JSON array
  -- [{"s":<epoch ms>,"e":<epoch ms>,"c":<cursor epoch ms>}], day order, capped in code.
  -- This is what makes a correction learnable at all.
  candidates      TEXT    NOT NULL,
  -- Where the owner moved it. NULL until they do — the twin of
  -- classification_log.final_value.
  moved_start_at  TEXT,
  moved_end_at    TEXT,
  moved_hour      INTEGER,           -- 0-23, owner-local hour of moved_start_at
  placed_at       TEXT    NOT NULL,
  moved_at        TEXT,
  local_date      TEXT    NOT NULL   -- 'YYYY-MM-DD', owner-local day of placed_at
);
-- The learning read: one owner's rows for one key over a date window.
CREATE INDEX IF NOT EXISTS ix_placement_log_owner_key_date
  ON placement_log(owner_id, slot_key, local_date);
-- The correction read: the still-open row for a block, which updateBlock closes on a drag.
CREATE INDEX IF NOT EXISTS ix_placement_log_block
  ON placement_log(block_id);

CREATE TABLE IF NOT EXISTS placement_preferences (
  owner_id      TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  slot_key      TEXT    NOT NULL,
  -- Owner-local hours (0-23, fractional) of where corrections LANDED. Same p25/p50/p75
  -- idiom as estimate_calibration / calibration_history (0138): a BAND, not a point, so
  -- the bias is neutral across a span instead of pulling everything to one hour.
  p25_hour      REAL    NOT NULL,
  p50_hour      REAL    NOT NULL,
  p75_hour      REAL    NOT NULL,
  corrections   INTEGER NOT NULL,   -- corrected rows the band was built from
  sample_count  INTEGER NOT NULL,   -- decided rows (corrected + accepted) for the key
  computed_date TEXT    NOT NULL,   -- 'YYYY-MM-DD', owner-local day of the run
  PRIMARY KEY (owner_id, slot_key)
);

CREATE TABLE IF NOT EXISTS placement_survival (
  owner_id      TEXT    NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  computed_date TEXT    NOT NULL,   -- 'YYYY-MM-DD', owner-local day of the run
  -- A recorded PARAMETER of the reading (the peer of classification_accuracy.held_out),
  -- not a tunable: nothing reads it back to change behaviour.
  period_days   INTEGER NOT NULL,
  decided       INTEGER NOT NULL,   -- rows that reached an outcome in the period
  accepted      INTEGER NOT NULL,   -- placements whose slot arrived and were never moved
  corrected     INTEGER NOT NULL,
  -- Stored rather than derived, and NULL when decided = 0, so an unmeasured period is
  -- distinguishable from one that scored 0%. The trend must draw a GAP, never a zero.
  survival_rate REAL,
  keys_learned  INTEGER NOT NULL,   -- placement_preferences rows for the owner after the run
  biased        INTEGER NOT NULL,   -- 0 | 1: was gap choice biased during the period
  PRIMARY KEY (owner_id, computed_date)
);
```

## Definition of Done

- [ ] `0166_placement_evidence.ts` exists, matches the pinned skeleton, and is registered in
      `migrations/index.ts` in numeric order
- [ ] All three tables and both indexes are created, idempotently
- [ ] `resetDb()` clears all three, each with a `-- 0166:` comment
- [ ] `schema.ts` is unchanged and `schema-parity.test.ts` still passes
- [ ] `time_blocks` and `tasks` are unchanged and the characterization snapshot is unaffected
- [ ] Running the migration twice is a no-op

## Tests

- [ ] `migrate.test.ts` still passes — it asserts `applied.length`, the `schema_migrations`
      count and `PRAGMA user_version` all equal `MIGRATIONS.length` (`migrate.test.ts:22-24`),
      so the count follows automatically; no hardcoded number to bump
- [ ] All three tables and both indexes exist after migrations
      (`SELECT name FROM sqlite_master WHERE type IN ('table','index')`)
- [ ] Re-running `up()` on an already-migrated DB throws nothing
- [ ] `DELETE FROM owners WHERE id = ?` cascades all three tables to zero
- [ ] A `placement_log` row survives deletion of its `block_id` block
- [ ] `schema-parity.test.ts` and `baseline.characterization.test.ts` pass with no churn

```bash
pnpm --filter server exec vitest run server/test/migrate.test.ts
pnpm --filter server exec vitest run server/test/schema-parity.test.ts
pnpm --filter server exec vitest run server/test/baseline.characterization.test.ts
pnpm --filter server exec vitest run server/test/owner-delete.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given a fresh DB, when migrations run, then `placement_log`, `placement_preferences`
      and `placement_survival` all exist
- [ ] Given an already-migrated DB, when migrations run again, then nothing changes and
      nothing throws
- [ ] Given an owner is deleted, then their rows in all three tables are removed by cascade
- [ ] Given a `placement_log` row and its `block_id` block is deleted, then the log row
      survives (no FK, no cascade)
- [ ] `git diff --stat` touches no file outside the three listed under **Files impacted**
      (plus the new test file)

## Subtasks

1. [ ] Read `0149_classification_learning.ts` and `0156_capacity_hours_per_week.ts`
2. [ ] Confirm the slot is still free: `ls server/src/db/migrations/ | tail -5`
3. [ ] Write `0166_placement_evidence.ts` with the DDL above and a block comment saying why
       the menu (`candidates`) exists, why there are no FKs to `time_blocks`/`tasks`, and
       why `fit = 0` rows are not evidence
4. [ ] Register it in `migrations/index.ts`
5. [ ] Add the three `DELETE FROM`s to `resetDb()` with `-- 0166:` comments
6. [ ] Add the table/index existence, idempotency, cascade and block-deletion tests
7. [ ] Run the five verification commands; confirm no snapshot churn
