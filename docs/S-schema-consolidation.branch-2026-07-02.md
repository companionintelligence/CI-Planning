# S — Schema consolidation candidates (post-Q) — implementation handoff

**Status:** Spec'd · not started (verified 2026-07-01: none of S1/S2 exists in `server/src` — no `daily_recap`/`tag_prefs` tables, no merged services) · **depends on Phase Q landing first.** ⚠️ **Reserved numbers are provisional:** the live migration head is currently **`0091`** (verified — `0091_recurrence_horizon`), *not* `0094`. Q's `0092`–`0094` have **not** landed yet, so S's `0095`/`0096` assume Q ships first exactly as planned. **Re-verify the head before assigning S's numbers** — if Q lands more or fewer than three migrations, S shifts accordingly. Companion to [Q-schema-hygiene.md](Q-schema-hygiene.md), [ROADMAP.md](ROADMAP.md). Planning doc only — no code, schema, or migration files have been created or modified to produce this; all SQL below is a **draft for a future implementer**, same convention as Q's drafts.

> **Why this doc exists.** A table-count question came up (47 business tables felt like a lot). Most of the 47 are structurally required (junction tables, per-feature staging tables, infra). Exactly two genuine merge candidates were found by checking grain (primary key shape) and actual call sites in `server/src`. This doc specs both. **`scheduling_prefs` is explicitly NOT included** — splitting it was already reviewed and declined (owner decision, 2026-07-01); revisiting that is a separate, owner-initiated decision only, not bundled here.

---

## Goal

Reduce real table count where — and only where — tables share identical grain (same primary key shape) and identical subject, verified against actual read/write call sites, not just column-list similarity. No business-logic behavior change beyond what the merge mechanically requires.

## Definition of done

- [ ] `daily_recap` replaces `daily_summaries` + `plan_outcomes` + `day_stars` (S1). Net **-2 tables**.
- [ ] `tag_prefs` replaces `pattern_prefs` + `category_prefs` (S2). Net **-1 table**.
- [ ] All five call-site files per ticket updated (listed below); `resetDb()` and `backup.ts`'s per-owner table list updated.
- [ ] `PRAGMA integrity_check` / `foreign_key_check` clean after both migrations.
- [ ] Server suite + typecheck green.
- [ ] `scheduling_prefs`, recurrence columns, and "default minutes" duplication are **untouched** — not in scope here (see "Explicitly out of scope" below).

---

## S1 — Daily recap consolidation: `daily_summaries` + `plan_outcomes` + `day_stars` → `daily_recap`

**Why these three.** All three are keyed identically — `(owner_id, date)`, one row per owner per day — and all three answer "how did this day go" (prose recap / planned-vs-completed counts / five-star score). Verified in `server/src`: three **independent, upsert-only writers**, each touching only its own columns, at three different times:

| Table (today) | Writer | When | Write style |
|---|---|---|---|
| `day_stars` | `jobs/freeze-stars.ts` | 00:20 local (cron `freeze_stars`) | INSERT-only, "first-freeze-wins" (checks row absence) |
| `plan_outcomes` | `jobs/aggregate-plan-outcomes.ts` | 01:30 local (cron `aggregate_plan_outcomes`) | `INSERT ... ON CONFLICT(owner_id,date) DO UPDATE` (partial) |
| `daily_summaries` | `agents/summarize.ts` | on-demand + cached | `INSERT ... ON CONFLICT(owner_id,date) DO UPDATE` (partial) |

No cross-joins between the three exist today — each has its own reader (`routes/stars.ts` for `day_stars`; `agents/summarize.ts`'s own cache read for `daily_summaries`; no reader yet found for `plan_outcomes` besides its own writer and tests). That independence is exactly what makes this a clean merge: no shared query logic to reconcile.

**New shape** (union of all columns — no name collisions between the three):

```sql
CREATE TABLE daily_recap (
  owner_id     TEXT NOT NULL REFERENCES owners(id),
  date         TEXT NOT NULL,
  -- from daily_summaries (Q4 shape: owner_id already NOT NULL by this point)
  prose        TEXT,
  stats        TEXT,
  focus        TEXT,
  llm          INTEGER,
  inputs_hash  TEXT,
  -- from plan_outcomes
  planned      INTEGER,
  completed    INTEGER,
  -- from day_stars
  star_objective INTEGER,
  star_habits    INTEGER,
  star_tasks     INTEGER,
  star_bonus     INTEGER,
  star_note      INTEGER,
  total          INTEGER,
  frozen_at      TEXT,
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, date)
);
```

> Columns that used to be `NOT NULL` in their own table (e.g. `prose`, `planned`, `star_objective`) become **nullable** here — a row can now legitimately exist with only one writer's columns filled in (e.g. stars frozen for a day that has no summary yet). This is the one real semantic shift: "row exists" no longer means "this specific fact is known."

**Migration draft — `0095_daily_recap.ts`** (illustrative; numbers assume Q's `0092`-`0094` land first — reverify head before implementing):

```ts
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS daily_recap ( /* as above */ );
    CREATE INDEX IF NOT EXISTS ix_daily_recap_owner_date ON daily_recap(owner_id, date);

    -- Backfill: one INSERT..ON CONFLICT per source table, mirroring the
    -- partial-upsert pattern each writer will use going forward.
    INSERT INTO daily_recap (owner_id, date, prose, stats, focus, llm, inputs_hash, created_at, updated_at)
      SELECT owner_id, date, prose, stats, focus, llm, inputs_hash, created_at, updated_at FROM daily_summaries
      ON CONFLICT(owner_id, date) DO UPDATE SET
        prose=excluded.prose, stats=excluded.stats, focus=excluded.focus,
        llm=excluded.llm, inputs_hash=excluded.inputs_hash;

    INSERT INTO daily_recap (owner_id, date, planned, completed)
      SELECT owner_id, date, planned, completed FROM plan_outcomes
      ON CONFLICT(owner_id, date) DO UPDATE SET
        planned=excluded.planned, completed=excluded.completed;

    INSERT INTO daily_recap (owner_id, date, star_objective, star_habits, star_tasks, star_bonus, star_note, total, frozen_at)
      SELECT owner_id, date, star_objective, star_habits, star_tasks, star_bonus, star_note, total, frozen_at FROM day_stars
      ON CONFLICT(owner_id, date) DO UPDATE SET
        star_objective=excluded.star_objective, star_habits=excluded.star_habits,
        star_tasks=excluded.star_tasks, star_bonus=excluded.star_bonus,
        star_note=excluded.star_note, total=excluded.total, frozen_at=excluded.frozen_at;

    DROP TABLE daily_summaries;
    DROP TABLE plan_outcomes;
    DROP TABLE day_stars;
  `);
}
```

**App call sites to update** (all verified in `server/src`, not guessed):

| File | Change needed |
|---|---|
| `jobs/freeze-stars.ts` | Table `day_stars`→`daily_recap`. **Important:** the existence check (line ~46-49, `SELECT total FROM day_stars WHERE owner_id=? AND date=?`) currently means "stars already frozen." After the merge, a row can exist from another writer with `frozen_at` still NULL — the check must become `... AND frozen_at IS NOT NULL`, or first-freeze-wins silently breaks (it would treat "summary already written" as "stars already frozen" and skip freezing). The INSERT also becomes an upsert (only star columns), not a bare INSERT. |
| `jobs/aggregate-plan-outcomes.ts` | Table `plan_outcomes`→`daily_recap`; `ON CONFLICT` target column list unchanged (already partial). |
| `agents/summarize.ts` | Table `daily_summaries`→`daily_recap` in both the cache-read SELECT (~line 203) and the upsert (~line 235). |
| `routes/stars.ts` | `FROM day_stars` → `FROM daily_recap`, add `AND frozen_at IS NOT NULL` to the frozen-row query (~line 40) so un-frozen rows (written by the other two jobs) don't get misread as frozen. |
| `routes/backup.ts` | Per-owner table list (~line 12) and the export/restore/delete blocks (~lines 114, 124, 189-190, 202, 208): replace `daily_summaries` with `daily_recap`. **Side effect worth flagging to the team:** `day_stars` and `plan_outcomes` are *not* in this backup list today — merging brings that data into backup/restore scope for the first time. That's a fix, not a regression, but call it out explicitly so it isn't read as unexpected scope creep. |
| `test/helpers.ts` (`resetDb`) | Replace the three `DELETE FROM daily_summaries / plan_outcomes / day_stars` lines with one `DELETE FROM daily_recap`. |
| `test/learning-loops.test.ts`, `test/__snapshots__/baseline.characterization.test.ts.snap` | Reference `plan_outcomes` directly — will need updating/re-recording. Re-grep at implementation time for any test added since. |

**Tests to add:** first-freeze-wins still holds when `daily_recap` already has a row from `aggregate-plan-outcomes` or `summarize` for that date (the specific regression the `frozen_at IS NOT NULL` fix targets); all three writers can independently update the same row without clobbering each other's columns; `foreign_key_check`/`integrity_check` clean after migration.

**Risk tier:** medium — drops two tables and renames a third (not purely additive like Q2), but low row counts in practice and no shape-changing rebuild (unlike Q3/Q4) — it's a straight consolidate-and-backfill.

---

## S2 — Preference consolidation: `pattern_prefs` + `category_prefs` → `tag_prefs`

**Why these two.** `services/category-prefs.ts` is documented in its own header comment as *"a trimmed mirror of services/pattern-prefs.ts."* Both tables: one row per `(owner_id, tag_id)`, both fetch-merge-upsert with the identical shape of service function, both reference `tags(id) ON DELETE CASCADE`. `category_prefs` just has 3 fewer columns (no `auto_fill`, `reminder_offsets`, `icon_shape` — categories don't use pattern-block auto-fill or reminders).

**New shape:**

```sql
CREATE TABLE tag_prefs (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES owners(id),
  tag_id           TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('pattern','category')),
  auto_fill        INTEGER,              -- pattern-only; NULL for category rows
  reminder_offsets TEXT,                 -- pattern-only
  icon_shape       TEXT,                 -- pattern-only
  color_token      TEXT NOT NULL DEFAULT 'primary',
  default_minutes  INTEGER NOT NULL DEFAULT 60,
  UNIQUE (owner_id, tag_id)
);
```

> `kind` here is a **prefs discriminator**, not a copy of `tags.kind`. `tags.kind` is actually a three-value taxonomy — `'pattern' | 'intention' | 'category'` (verified in `schema.ts`; `'intention'` is the default) — but only `'pattern'` and `'category'` tags ever get a prefs row (intentions carry no display/auto-fill config), which is why the `CHECK` is restricted to those two. It's still derivable by joining `tags.kind` and filtering to those two values, so it's denormalized here on purpose to avoid a join on every read. A reasonable implementer could drop it and join instead; note the trade-off, don't dictate it. **Do not** assume `tags.kind` is two-valued — an earlier draft of this doc said so and it was wrong; `'intention'` rows exist and must simply never appear in `tag_prefs`.

**Migration draft — `0096_tag_prefs.ts`:** same shape as S1 — `CREATE TABLE`, two `INSERT...SELECT` backfills (one from each source table, tagging `kind` accordingly), `DROP TABLE pattern_prefs; DROP TABLE category_prefs;`.

**App call sites to update:**

| File | Change needed |
|---|---|
| `services/pattern-prefs.ts`, `services/category-prefs.ts` | These two are near-duplicate fetch-merge-upsert functions today. The merge is a natural point to also collapse them into one `services/tag-prefs.ts` with a `kind` parameter — reduces code duplication, not just table count. (Optional, but the doc flags it since it's a very small lift once the table exists.) |
| `routes/pattern-prefs.ts`, `routes/category-prefs.ts` | Stay as **two separate routes** — they validate different fields (pattern validates `auto_fill`/`reminder_offsets`/`icon_shape`; category doesn't) — both call into the shared service with `kind` fixed. |
| `routes/backup.ts` | Two list entries (`pattern_prefs`, `category_prefs`) → one (`tag_prefs`); update the export/restore/delete blocks (~lines 18-19, 115-116, 190-191, 221-222). |
| `test/helpers.ts` (`resetDb`) | No change needed — neither table is explicitly listed today; both cascade-delete for free when `tags` is cleared (`ON DELETE CASCADE` via `tag_id`/`pattern_tag_id`/`category_tag_id`). `tag_prefs` inherits the same cascade, so this stays true. |

**Tests to add:** a pattern-tag row and a category-tag row can coexist without collision; deleting a tag cascades correctly regardless of `kind`; existing pattern-prefs/category-prefs API contracts (response shape) are unchanged from the caller's perspective.

**Risk tier:** low-medium — smaller blast radius than S1 (4 files vs 7), and the two services are already nearly identical, so the merge is closer to mec