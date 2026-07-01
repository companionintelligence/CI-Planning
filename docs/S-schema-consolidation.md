# S — Schema consolidation candidates (post-Q) — implementation handoff

**Status:** SPEC'd · not started · **depends on Phase Q (merged, PR #205; `main` migration head `0094`)** · reserves `0095`/`0096`/`0097` (verify head before branching — see §0). Planning doc only — no code/schema/migration files created to produce it; all SQL below is a **draft for a future implementer** (same convention as Q's drafts). Companion to [Q-schema-hygiene.md](Q-schema-hygiene.md), [ARCHITECTURE.md](../ARCHITECTURE.md), [ROADMAP.md](ROADMAP.md), [GLOSSARY.md](GLOSSARY.md).

> **This is the single canonical consolidation spec.** It reconciles two earlier drafts (this `S` doc and a parallel `Q2-table-consolidation.md`) into one, and was **hardened by an adversarial review pass** — the write-ups below fold in every confirmed finding (a silent star-freeze breakage, two missed raw-SQL production readers, several missed test fixtures, backup-version + docs-sync gaps) and a risk-tiering of S1.

> **Why this doc exists.** A table-count question came up (47 business tables felt like a lot). Most are structurally required (junction/staging/infra). Exactly two genuine merge candidates were found by checking grain (PK shape) **and actual call sites in `server/src`** (not column-list similarity alone). **`scheduling_prefs` is explicitly NOT included** — splitting it was reviewed and declined (owner decision, 2026-07-01); revisiting is a separate owner-initiated decision.

> **Overriding rule.** Unlike Phase Q (pure hygiene, no behavior change), this phase touches business logic and **client-facing API response shapes**. The GET/PUT JSON contracts (`/api/summary`, `/api/stars`, `/api/pattern-prefs`, `/api/category-prefs`) **must stay byte-identical** — these are *storage* refactors behind the existing routes/services. **Do not trust "just repoint the service": several readers issue raw SQL against the physical tables** (enumerated per ticket) and bypass the service layer.

---

## §0 — READ FIRST: guardrails

1. **The default worktree is often STALE** (Phase Q's #1 gotcha). Branch fresh from `origin/main`, then confirm head `0094`:
   ```bash
   git fetch origin main
   ls server/src/db/migrations/ | grep -E '^[0-9]{4}_' | sort | tail -3   # highest must be 0094
   ```
   If not `0094`, main moved — re-derive free numbers and re-verify every column list here against the live schema.

2. **Migration numbers are provisional** (`0095` = S1-A, `0096` = S1-B, `0097` = S2 — shift per whichever tiers ship, in what order). Register each in [`migrations/index.ts`](../server/src/db/migrations/index.ts) (`import * as mNNNN from './NNNN_name.js';` + append to `MIGRATIONS`). **Ship the tickets as separate PRs** (each edits `migrations/index.ts`, `schema.ts` where modelled, and the baseline snapshot → expect merge-order renumbering, append-only/cosmetic).

3. **Migration mechanism.** S1-A is a plain `DROP TABLE` + `DELETE FROM scheduled_jobs` — a **normal (non-`manual`) migration** is fine (dropping leaf tables under FK-on is safe). S1-B and S2 are table **merges**; they are *not* single-table rebuilds, so `rebuildTable` doesn't fit — write a bespoke migration. These specific source tables are all **leaf** (nothing FK-references them), so a non-`manual` `CREATE`+`INSERT..SELECT`+`DROP` under FK-on is technically safe. **But the repo convention Phase Q established (`0030/0068/0093/0094`) is `export const manual = true` + `foreign_keys=OFF` around the swap** — prefer that for consistency and forward-safety (a future implementer who copies a non-`manual` merge onto a *non-leaf* table would cascade-delete children). If you go non-`manual`, add a comment explaining the leaf-only justification.

4. **SQLite can't `ALTER COLUMN`/drop a default/change a PK.** All migrations forward-only, idempotent; guard on the target already existing/absent.

5. **Identity is UUIDv7 TEXT** (post-`0030`); all five tables are already `owner_id TEXT NOT NULL` after Phase Q. Trust the live shape over old declared types.

6. **The schema-shape golden WILL fail and must be regenerated in lockstep.** [`baseline.characterization.test.ts.snap`](../server/test/__snapshots__/baseline.characterization.test.ts.snap) pins every table's name + column list. Regenerate deliberately (`vitest -u`) and **eyeball the diff**.

7. **Backup/export-import: bump `EXPORT_VERSION`.** [`routes/backup.ts`](../server/src/routes/backup.ts) has `OWNER_TABLES` + `EXPORT_VERSION` (currently `'1'`; import rejects a mismatch). Export asymmetry: `daily_summaries`/`pattern_prefs`/`category_prefs` are exported; `plan_outcomes`/`day_stars` are **not**.

8. **Client API contracts are frozen** (see Overriding rule). Routes/services become thin adapters over the new storage.

9. **Test-harness rules** ([`helpers.ts`](../server/test/helpers.ts)): sequential shared DB, migrations on import, `TZ=UTC`, pin dates. Many tests hit these tables by **raw SQL** (enumerated per ticket) — not covered by "the service is a thin adapter". Verify `pnpm --filter server test` (`TZ=UTC`) + `pnpm --filter server typecheck`; both CI jobs green.

10. **Docs are a required touch point** (repo treats doc drift as ship-relevant — cf. PRs #203/#204). Each ticket's DoD syncs README.md + ARCHITECTURE.md (schema tables, ER nodes, cron table, sequence diagram, migration-head strings) + GLOSSARY.md.

11. **Review bots:** Copilot autofix may push to the branch — reconcile, don't clobber.

---

## Goal & Definition of done

Reduce real table count where — and only where — tables share identical grain and subject, verified against actual read/write call sites. No behavior change beyond what the merge mechanically requires, and **no HTTP-contract change**.

- [ ] **S1-A:** dead `plan_outcomes` dropped + its `aggregate_plan_outcomes` cron retired. Net **-1 table**.
- [ ] **S1-B (optional):** `daily_recap` replaces `daily_summaries` + `day_stars`. Net **-1 more table**.
- [ ] **S2 (optional):** `tag_prefs` replaces `pattern_prefs` + `category_prefs`. Net **-1 table**.
- [ ] All call-site files per ticket updated (incl. the **raw-SQL readers/fixtures**), `resetDb()`, `backup.ts` + `EXPORT_VERSION`, baseline golden, and docs.
- [ ] `integrity_check` / `foreign_key_check` clean after each migration; server suite + typecheck green.
- [ ] `scheduling_prefs`, recurrence columns, and "default minutes" duplication **untouched** (see Out of scope).

---

## Findings that shaped this plan

**Day-grain trio — same `(owner_id, date)` grain, but three *different* lifecycles:**

| Table | Lifecycle | Writer | Production readers | In `schema.ts`? | In backup? |
|---|---|---|---|---|---|
| `daily_summaries` | **Mutable cache**, self-invalidating via `inputs_hash`; partial upsert | `agents/summarize.ts` (on-demand) | `GET /api/summary` | ❌ | ✅ |
| `plan_outcomes` | **Mutable rollup**, nightly-recomputed; partial upsert | `jobs/aggregate-plan-outcomes.ts` (01:30) | **NONE** (grep-confirmed; only `learning-loops.test.ts`) | ❌ | ❌ |
| `day_stars` | **Write-once immutable freeze**; INSERT, first-freeze-wins; `frozen_at NOT NULL` | `jobs/freeze-stars.ts` (00:20) | `GET /api/stars` (frozen row else live `computeStars()`) | ❌ | ❌ |

- **`plan_outcomes` is dead weight** → drop it (S1-A) rather than embalm it in a merged table.
- Co-locating an **immutable freeze** (`day_stars`) with a **mutable cache** (`daily_summaries`) is the real design problem (S1-B) — solvable, but the freeze guard must change (⚠️ in S1-B).

**Prefs pair** — `category_prefs` is a literal "trimmed mirror" of `pattern_prefs` (its own header says so). Shared `(owner_id, tag_id)` grain, identical fetch-merge-upsert service shape, both `→ tags(id) ON DELETE CASCADE`. **Hidden raw-SQL readers that bypass the services** (must be repointed by hand): `engine/reminders.ts:135`, `routes/reflections.ts:43,52`.

---

## Scope map — three tickets, tiered by risk/ROI

| Ticket | Title | Migration | Risk | ROI | Recommend |
|---|---|---|---|---|---|
| **S1-A** | Drop dead `plan_outcomes` + retire its cron | `0095` | **low** | **high** — one fewer table + one fewer nightly job, no cache/immutability/client/export impact | ✅ **do it** |
| **S1-B** | Co-locate `daily_summaries` + `day_stars` → `daily_recap` | `0096` | **high** | medium — second table drop, but the risk is concentrated here | ⚠️ optional |
| **S2** | Merge `category_prefs` → `pattern_prefs` as `tag_prefs` | `0097` | med | modest — DRY + one fewer table; API surface unchanged | optional |

**Recommended path:** ship **S1-A** first (cheap win). Treat S1-B and S2 as separate, explicitly-opted-in PRs. See Decision points + Sequencing vs multi-tenant.

---

## S1-A — Drop `plan_outcomes` and retire its cron (migration `0095`)

**Problem.** `plan_outcomes` (created `0083`) is written nightly by `aggregate_plan_outcomes` but read by **no production code** (grep-confirmed; only `learning-loops.test.ts`). Not exported. Dead weight. If a "planned vs completed" reader is ever wanted, it's trivially re-derivable from `time_blocks`+`tasks` (all the job does).

**Coupled removals (all four, or the build/cron breaks):**
1. **Migration `0095_drop_plan_outcomes.ts`** (non-`manual`): `DROP TABLE IF EXISTS plan_outcomes;` **and** `DELETE FROM scheduled_jobs WHERE kind='aggregate_plan_outcomes';` — the cron seed lives in *already-applied* `0083` (`INSERT OR IGNORE`); editing `0083` can't un-seed existing DBs, so a new migration must delete the row or [`startCronJobs`](../server/src/jobs/index.ts) keeps firing a job whose table is gone.
2. Remove the `case 'aggregate_plan_outcomes'` dispatcher (~`jobs/index.ts:193-200`) + its module import (~`:19`).
3. Delete [`jobs/aggregate-plan-outcomes.ts`](../server/src/jobs/aggregate-plan-outcomes.ts).
4. Delete the `describe('aggregatePlanOutcomes', …)` block (~`:112-206`) in [`learning-loops.test.ts`](../server/test/learning-loops.test.ts) — it imports the deleted module (file won't compile otherwise) and `SELECT`s `plan_outcomes`. **Keep the independent `calibrateEstimates` block.**

**Also:** remove the `DELETE FROM plan_outcomes` line from `resetDb`; regenerate the baseline golden (§0.6); docs (§0.10 — README schema-table row + enumeration; ARCHITECTURE §5.2 row + cron-table row `aggregate_plan_outcomes | daily 01:30` + sequence-diagram step `Cron->>DB: aggregate_plan_outcomes (01:30)` + ER node `PO["plan_outcomes"]`).

**Tests/DoD:** migration test (table gone, no orphaned enabled cron row, idempotent); suite + typecheck green; head `0095`.

---

## S1-B — Co-locate `daily_summaries` + `day_stars` → `daily_recap` (migration `0096`, HIGHER RISK)

> Assumes **S1-A shipped** (no `plan_outcomes`). If you instead keep `plan_outcomes`, add `planned`/`completed` columns + a third backfill source + keep that cron repointed to `daily_recap` — but the recommended path is drop-then-merge.

**New shape** (union of both tables' columns — no name collisions):
```sql
CREATE TABLE daily_recap (
  owner_id     TEXT NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  date         TEXT NOT NULL,
  -- from daily_summaries (mutable cache)
  prose        TEXT,
  stats        TEXT,
  focus        TEXT,
  llm          INTEGER,
  inputs_hash  TEXT,
  -- from day_stars (immutable freeze)
  star_objective INTEGER, star_habits INTEGER, star_tasks INTEGER,
  star_bonus     INTEGER, star_note   INTEGER,
  total          INTEGER,
  frozen_at      TEXT,                          -- NULL = stars not frozen for this day
  created_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (owner_id, date)
);
```
> **The one real semantic shift** (flagged): columns that were `NOT NULL` in their own table become **nullable** — a row can exist with only one writer's columns filled (stars frozen for a day with no summary yet, or vice-versa). "Row exists" no longer means "this specific fact is known." Safe because the summary writer always supplies its columns and only `JSON.parse`s `stats`/`focus` on an `inputs_hash` cache-hit (impossible for a stars-only NULL-hash row). Live shapes to preserve exactly: today `stats` is `TEXT NOT NULL` (no default) and `focus` is `TEXT NOT NULL DEFAULT '[]'`; the `star_*`/`total` are `NOT NULL DEFAULT 0` and `frozen_at` is `NOT NULL`.

### ⚠️ Write-path reconciliation (the critical part — a naive port silently breaks freezing)
- **Summary** ([`agents/summarize.ts`](../server/src/agents/summarize.ts), cache-read ~`:203` + upsert ~`:235`): table → `daily_recap`; partial upsert of the summary columns only (never touches `star_*`/`frozen_at`).
- **Freeze** ([`jobs/freeze-stars.ts`](../server/src/jobs/freeze-stars.ts)): **🚨 the existence guard (~`:46-49`, `SELECT total … WHERE owner_id=? AND date=?`) means "already frozen" today only because a `day_stars` row exists *only* when frozen.** After the merge a summary upsert creates the `(owner,date)` row first (`frozen_at` NULL), so an existence-based guard would early-return and **stars would never freeze on any day the user opened a briefing.** Change the guard to test frozen-ness: `SELECT frozen_at FROM daily_recap WHERE owner_id=? AND date=?; if (row?.frozen_at != null) return {created:false};` and make the write a **guarded partial upsert** of star columns only:
  ```sql
  INSERT INTO daily_recap (owner_id,date, star_objective,…,total, frozen_at) VALUES (?,?, …, ?)
  ON CONFLICT(owner_id,date) DO UPDATE SET star_objective=excluded.star_objective, …, total=excluded.total,
    frozen_at=excluded.frozen_at, updated_at=CURRENT_TIMESTAMP
  WHERE daily_recap.frozen_at IS NULL;   -- first-freeze-wins
  ```
- **Read** ([`routes/stars.ts`](../server/src/routes/stars.ts), ~`:40`): `FROM day_stars` → `FROM daily_recap` **and add `AND frozen_at IS NOT NULL`** so un-frozen rows (created by the summary writer) aren't misread as frozen; else fall back to live `computeStars()` (`frozen:false`). `GET /api/stars` + `GET /api/summary` response JSON must stay identical.

### Migration `0096_daily_recap.ts` (bespoke merge; prefer `manual`+FK-off per §0.3)
`CREATE TABLE daily_recap (…)` → backfill by UNION of the two sources' `(owner,date)` keys with a `LEFT JOIN` each (handles sparse days) → `DROP TABLE daily_summaries; DROP TABLE day_stars;`. (`daily_summaries` is a regenerable cache — copying is optional but cheap.)

### Call sites to update (all verified in `server/src`)
| File | Change |
|---|---|
| `jobs/freeze-stars.ts` | ⚠️ guard→`frozen_at IS NOT NULL`; INSERT→guarded partial upsert (above). |
| `agents/summarize.ts` | `daily_summaries`→`daily_recap` (cache-read + upsert). |
| `routes/stars.ts` | `day_stars`→`daily_recap`; add `AND frozen_at IS NOT NULL`. |
| `routes/backup.ts` | `OWNER_TABLES` `daily_summaries`→`daily_recap`; export/delete/insert follow; **bump `EXPORT_VERSION`**. Flag: `day_stars` data now enters backup scope for the first time (a fix, not regression). |
| `test/helpers.ts` (`resetDb`) | replace the `daily_summaries`+`day_stars` DELETEs with one `DELETE FROM daily_recap`. |
| **`test/daily-summaries-schema.test.ts`** | **Obsoleted** — pins the `daily_summaries` 9-col shape *and* calls `m0094.up()` directly. Delete or rewrite against `daily_recap`. |
| **`test/migrate.test.ts:29`** | `cols(db,'daily_summaries')).toContain('focus')` → assert on `daily_recap`. |
| **`test/stars.test.ts`** | `frozenRow()` + counts read `SELECT * FROM day_stars` (cols `total`/`star_objective`) → repoint to `daily_recap`. |
| `test/__snapshots__/baseline.characterization…snap` | re-record (§0.6). |

**Tests to add:** **summary-upsert-first THEN freeze → stars actually freeze (`created:true`)** (the regression guard for the trap above); freeze-then-summary → frozen stars unchanged; all writers update their own columns without clobbering; `GET /api/summary` + `GET /api/stars` shapes identical; `foreign_key_check`/`integrity_check` clean; export-import round-trip at bumped `EXPORT_VERSION`. Docs sync (§0.10).

**Risk tier:** high — the freeze-guard rewrite + frozen client contract are the sharp edges.

---

## S2 — `pattern_prefs` + `category_prefs` → `tag_prefs` (migration `0097`)

**New shape:**
```sql
CREATE TABLE tag_prefs (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES owners(id),
  tag_id           TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('pattern','category')),
  auto_fill        INTEGER,              -- pattern-only; NULL/default for category rows
  reminder_offsets TEXT,                 -- pattern-only
  icon_shape       TEXT,                 -- pattern-only
  color_token      TEXT NOT NULL DEFAULT 'primary',
  default_minutes  INTEGER NOT NULL DEFAULT 60,
  UNIQUE (owner_id, tag_id)
);
CREATE INDEX ix_tag_prefs_owner ON tag_prefs(owner_id);
```
> `kind` is denormalized from `tags.kind` (avoids a join on every read); `UNIQUE(owner_id, tag_id)` prevents cross-axis collisions (a tag has one kind). **Behavioral divergence to preserve:** `category_prefs.color_token` is the source of the forward-only frozen stamp onto `time_blocks.color_token` (`routes/blocks.ts`); `pattern_prefs.color_token` has no such path. `category_prefs.default_minutes` **is** read (wizard prefill); `pattern_prefs.default_minutes` **is** read/returned by the server (see `services/pattern-prefs.ts`) but has no `time_blocks` stamping path.

**Migration `0097_tag_prefs.ts`:** `CREATE` → `INSERT SELECT …,'pattern',auto_fill,reminder_offsets,icon_shape FROM pattern_prefs` + `INSERT SELECT …,'category',NULL,NULL,NULL FROM category_prefs` → recreate owner index → `DROP` both. Prefer `manual`+FK-off (§0.3).

### Call sites to update — **including the two hidden raw-SQL production readers the services don't cover:**
| File | Change |
|---|---|
| `services/pattern-prefs.ts`, `services/category-prefs.ts` | Collapse into one `services/tag-prefs.ts` keyed by `kind` (natural DRY win); `getCategoryPrefs` returns only `{color_token,default_minutes}` (shape unchanged), `getPatternPrefs` all. |
| `routes/pattern-prefs.ts`, `routes/category-prefs.ts` | Stay **two separate routes** (different validation); both call the shared service with `kind` fixed. Response/request shapes unchanged. |
| **🚨 `engine/reminders.ts:135`** | Raw `SELECT reminder_offsets FROM pattern_prefs WHERE owner_id=?` — **production** reader (push-notification scheduling; fires on task create/update/recurrence/block-sync), NOT via the service. → `… FROM tag_prefs WHERE owner_id=? AND kind='pattern'`. |
| **🚨 `routes/reflections.ts:43,52`** | Raw `LEFT JOIN category_prefs cp ON cp.owner_id=r.owner_id AND cp.category_tag_id=r.category_id` (today-goal + weekly-goal; backs `color_token` output). → `LEFT JOIN tag_prefs tp ON tp.owner_id=r.owner_id AND tp.tag_id=r.category_id AND tp.kind='category'`. |
| `routes/blocks.ts` | Preserve the forward-only color stamp (reads `getCategoryPrefs` → unchanged once service is repointed). |
| `routes/tags.ts` (~`:82`) | On category-tag create, seeds a default pref via `setCategoryPref(...,{})` — preserve. |
| `schema.ts` | Replace `patternPrefs` + `categoryPrefs` with one `tagPrefs` model; **update the schema-parity test** (currently guards `pattern_prefs`) to `tag_prefs`. |
| `routes/backup.ts` | Two entries (`pattern_prefs`,`category_prefs`) → one (`tag_prefs`); the payload shape changes (two keys → one `tag_id`+`kind` shape); rewrite export/delete/insert (~`:18-19,115-116,190-191,221-222`); **bump `EXPORT_VERSION`**. |
| `test/helpers.ts` (`resetDb`) | **No change** — neither is explicitly listed; both cascade-delete when `tags` is cleared via `tag_id`→`tags ON DELETE CASCADE`; `tag_prefs` inherits the same cascade. |

**Tests — only truly-unchanged (API-driven):** `blocks-category.test.ts`, `category-fill.test.ts` (verified: zero prefs-table refs). **MUST be rewritten** (raw SQL against the dropped tables/cols): `pattern-prefs.test.ts` (`:42`,`:227`), `reflections.test.ts` (`:171`), `reminders.test.ts` (`:59`), `pattern-blocks.test.ts` (`:58`), `cockpit-ux.test.ts` (`:156-157`), `audit.test.ts` (`:68`). (Re-grep `pattern_prefs`/`category_prefs` + the drizzle exports across `server`+`client` to be exhaustive.) Add: a pattern-tag + category-tag row coexist without collision; tag delete cascades regardless of `kind`; both API contracts unchanged; export-import round-trip at bumped `EXPORT_VERSION`; re-record baseline golden; docs sync (README/ARCHITECTURE row; GLOSSARY `pattern_prefs`→`tag_prefs`).

**Risk tier:** medium — smaller than S1-B, but the two hidden raw-SQL readers make it bite harder than it looks; the services are near-identical so the merge is close to mechanical.

---

## Net impact & sequencing vs multi-tenant

**Net table count:** 47 (post-Q) → **44** if all ship (S1-A −1, S1-B −1, S2 −1). This is the only concrete table-count reduction found; recurrence/"default minutes" duplication is column/logic duplication, not table duplication.

**These consolidations are NOT multi-tenant prerequisites.** All five tables are **already owner-scoped** (`owner_id TEXT NOT NULL` after Phase Q) — tenant-clean today. Multi-tenant's real blockers are the **owner-*less* tables** — `time_blocks` (blocker #1), the tag axis (`tags`/`tag_patterns`/`tag_categories`/`entity_tags`), and `scheduled_jobs` — documented in [Q-schema-hygiene.md](Q-schema-hygiene.md)'s multi-tenant-bridge section. Consolidating already-owner-scoped tables buys ~nothing for tenant isolation.

**Recommended sequencing:**
- **S1-A (drop `plan_outcomes`)** — worth doing anytime, including before multi-tenant: pure removal, zero multi-tenant interaction, shrinks the surface multi-tenant would otherwise carry.
- **S1-B / S2** — cosmetic table-count reduction, not a multi-tenant dependency. Doing risky behavior-adjacent refactors immediately before a large multi-tenant change stacks risk and rebasing. **Prioritize the multi-tenant owner-less-table work over these**, and do S1-B/S2 deliberately as their own PRs whenever you want the tidier base (before or after multi-tenant works equally well).

---

## Decision points for the owner
- **D1 — scope of S1:** do **S1-A now** (recommended, low risk); treat **S1-B as a separate optional PR**. Doing S1-A does not commit you to S1-B.
- **D2 — (only if S1-B) export the merged star data?** `day_stars` isn't exported today. Recommendation: export the whole `daily_recap` row (frozen stars re-derive; harmless); bump `EXPORT_VERSION`.
- **D3 — do S2 at all?** Modest ROI + hidden raw-SQL readers. Optional; own PR, after S1.

## Explicitly out of scope
- **`scheduling_prefs` split** — reviewed and declined (owner decision, 2026-07-01).
- **Recurrence unification** (`tasks`/`time_blocks`/`patterns`) and **"default minutes" single-source** (~7 columns / 5 places) — logic duplication, not table-count; design-first, separate future decision.
- **Owner-scoping the tag axis / `time_blocks` / `scheduled_jobs`** — that's the multi-tenant phase, not here. `tag_prefs.tag_id` still points at the tenant-global `tags` axis; unchanged.
