# Phase Z — Naming Consolidation (Direction / Pattern / Routine)

> **Status:** PLANNING (not built), 2026-07-02. Phase letter `Z` provisional.
> **Lineage:** completes **CON-3 §3b** (the `patterns`→`routines` rename deferred in CON-3;
> tracked DEFERRED in [recap_state_A-S.md:157](recap_state_A-S.md), [ROADMAP.md](ROADMAP.md),
> [GLOSSARY.md](GLOSSARY.md)) **and reverses the 0038/0043 direction→pattern mis-rename**
> (see §1). Migration head **0104**; next free **0105**.

## 1. The problem — "pattern" was made to mean three things

There are **three genuinely distinct concepts**. The word "pattern" got smeared across all
three, mostly by two migrations that renamed the wrong thing.

| Concept | Plain meaning | Owner's words |
|---|---|---|
| **Direction** | one top-level grouping — **Work / Life / Home** | *"individually they are directions"* |
| **Pattern** | the *arrangement of directions across a day* (Work 9–12, Home 12–1, Work 1–6…) | *"Work Life Home in a day are what makes a pattern"* |
| **Routine** | a reusable *bundle of tasks* | (Phase G collection) |

### How the code drifted

- **Routine** has always lived in the `patterns` table (Phase G, mig 0013) — **misnamed
  since day one**. The domain layer already half-fixed it: audit writes `entity: routine:`,
  `entity_tags.entity_kind='routine'`, helpers are `createRoutineWithTasks`, the flag is
  `enable_routines`. Only the tables/API/SSE still say "pattern."
- **Direction** was correctly named `tag_directions` / `direction_tag_id` / `kind='direction'`
  in **0036** — then **0038** renamed the value `direction`→`pattern` and **0043** renamed
  `tag_directions`→`tag_patterns`, `direction_tag_id`→`pattern_tag_id`. **That was the
  mistake:** it renamed the *individual grouping* to "pattern," colliding with both the
  Routine table and the real day-arrangement sense.
- **The rest of the codebase never went along with 0038/0043** — strong evidence the rename
  was wrong, not the concept:
  - [`services/pattern-blocks.ts`](../server/src/services/pattern-blocks.ts): `export type DirectionWindows` … `// dirTagId → ranges`
  - [`agents/direction.ts`](../server/src/agents/direction.ts): `inferDirection`
  - client still says `DirectionColumn`, `byDirection`, `Tag.directions` (the
    `direction→patternTag` client rename was **HELD, never merged** — see
    [project_direction_rename_held])
  - [0069](../server/src/db/migrations/0069_category_tags.ts) created **`category_direction_optouts`**
    — went *back* to "direction" — but gave it a `pattern_tag_id` column. A table that
    contradicts its own column name is the clearest proof 0038/0043 half-landed.
- **Pattern** (the day arrangement) is the one thing named **correctly**: `pattern_blocks`
  (+ `day_types`) is exactly "a named availability window tying a *direction* to a time range
  on a day type." The set of a day-type's windows **is** the day's pattern.

### The upshot
This phase does three surgical things, giving each word exactly one meaning:
1. `patterns` (task bundle) → **`routines`** (finish §3b).
2. Tag axis `pattern` → **revert to `direction`** (undo 0038/0043).
3. **Keep** `pattern_blocks` = **Pattern** (the day arrangement), and *optionally* make
   "Pattern" a first-class, pickable concept (W2-P).

After this, `kind='pattern'` is gone (→ `direction`) and `source_kind='pattern'` is gone
(→ `routine`); **"pattern" survives only on `pattern_blocks`, meaning one thing.** The old
shared-string hazard (`source_kind='pattern'` vs `kind='pattern'`) dissolves entirely.

## 2. Target vocabulary

| Concept | Old (as-built) | New |
|---|---|---|
| Task bundle | `patterns` / `pattern_types` / `pattern_tasks` / `pattern_day_optouts`; "Pattern" | **`routines` / `routine_types` / `routine_tasks` / `routine_day_optouts`; "Routine"** |
| Grouping (Work/Life/Home) | `tags.kind='pattern'`, `tag_patterns`, `pattern_tag_id`; "pattern-tag" | **`tags.kind='direction'`, `tag_directions`, `direction_tag_id`; "Direction"** |
| Day arrangement | `pattern_blocks` (+ `day_types`); noun "Pattern-block" | **`pattern_blocks` kept; noun "Pattern"** (windows = pattern-blocks) |

> **Governance / GLOSSARY.** This **un-ratifies** the 2026-07-01 "ratify `kind='pattern'`"
> decision. New canon: **Direction** = the Tag grouping sub-level (brand-set Work/Life/Home,
> `is_base`, plus user-added; `tags.kind='direction'`). **Pattern** = a named day-arrangement
> of directions (noun #8, was "Pattern-block"; a *pattern-block* is demoted to "one window
> within a Pattern"). **Routine** (noun #3) keeps its name; its `(internal: patterns)` note
> flips to `(internal: routines)`. No noun is added or removed — budget of 9 holds. Delete
> the GLOSSARY "§3b deferred" note and the README "`pattern_types` load-bearing, do not
> rename" warning (the collisions they guarded are gone).

## 3. Workstreams

Each is its own PR **based on `main`** (NOT stacked — see §5). W1 and W2 touch disjoint
tables. W2-P is an optional follow-on to W2. W3 (Habit audit) gates a decision inside W1.

---

### W1 — Routine rename (Cluster A, §3b) — the core ask

**Migration `0105_rename_patterns_to_routines`** (idempotent, guarded, `ALTER … RENAME`):
- `patterns`→`routines`; `pattern_types`→`routine_types`; `pattern_tasks`→`routine_tasks`
  (`pattern_id`→`routine_id`); `pattern_day_optouts`→`routine_day_optouts` (`pattern_id`→`routine_id`)
- Data: `UPDATE time_blocks SET source_kind='routine' WHERE source_kind='pattern'` (placement marker)
- Rider (owner-approved): `scheduling_prefs.recall_keeps_pattern`→`recall_keeps_routine`
- Guard each step (table/column-exists); `PRAGMA foreign_key_check` at the end.

> The `routine_types` table still holds a builtin **type** named `'Routine'` (with
> `'Habit'`/`'Ritual'`) — fine; the table is the umbrella, `name='Routine'` is one flavor.

**Server:** `routes/patterns.ts`→`routes/routines.ts` (`/api/patterns`→`/api/routines`,
`/api/pattern-types`→`/api/routine-types`; SSE `pattern:*`→`routine:*`, `pattern_type:*`→
`routine_type:*`; envelope keys `patterns`/`pattern`/`pattern_types`→`routines`/`routine`/
`routine_types`). `services/patterns.ts`→`services/routines.ts`. `engine/patterns-place.ts`→
`engine/routines-place.ts` (`ensurePatternsForRange`→`ensureRoutinesForRange`,
`placePatternOnDay`→`placeRoutineOnDay`, `validatePatternRule`→`validateRoutineRule`; update
the `source_kind='routine'` marker + idempotency query). `routes/backup.ts` — table list +
raw `SELECT id FROM patterns` reader; **bump EXPORT_VERSION**; **restore back-compat** so a
pre-Z backup (old `patterns` keys) still imports (alias old→new, version-gated). Grep
`app.ts`/router registration, `jobs/`, `mcp/`.

**schema.ts:** `patterns`/`patternTypes`/`patternTasks` exports → `routines`/`routineTypes`/
`routineTasks`; fix the "Patterns (Phase G)" block comment; `recallKeepsPattern`→`recallKeepsRoutine`.

**Client:** `views/Patterns.tsx`→`views/Routines.tsx`; `lib/pattern-meta.ts`→`lib/routine-meta.ts`
(it's the *type* palette — Cluster A); `lib/api.ts` repoint + types `Pattern`/`PatternType`→
`Routine`/`RoutineType`; SSE listeners `pattern:*`→`routine:*`; keep `RoutinesPanel.tsx`/
`RoutineTypeSettings.tsx`.

**Tests:** split by cluster first; update Cluster-A raw-SQL fixtures that run *after a full
migration* (leave partial-chain replays to 0013 alone — §4); regenerate
`baseline.characterization.test.ts`.

---

### W2 — Direction revert (undo 0038/0043) — Work/Life/Home = Directions *(D0 resolved)*

**Migration `0106_revert_pattern_tag_to_direction`** (idempotent, guarded):
- Values: `UPDATE tags SET kind='direction' WHERE kind='pattern'`;
  `UPDATE tag_prefs SET kind='direction' WHERE kind='pattern'`
- `tag_patterns`→`tag_directions` (`pattern_tag_id`→`direction_tag_id`)
- `pattern_blocks`: **keep the table**, rename its column `pattern_tag_id`→`direction_tag_id`
  (a pattern-block ties a *direction* to a window — that's the point)
- `category_direction_optouts`: rename column `pattern_tag_id`→`direction_tag_id` (table name
  already says "direction" — this ends its self-contradiction; `category_tag_id` unchanged)
- `PRAGMA foreign_key_check`.

**Server:** `routes/pattern-prefs.ts`→`routes/direction-prefs.ts` (`/api/pattern-prefs`→
`/api/direction-prefs`; guard `kind==='direction'`). `services/tags.ts` wire helpers
`setTagPatternTags`/`patternTagsOf`/`patternTagIds` → `...DirectionTags`/`directionTagsOf`/
`directionTagIds`; keep/confirm the `/api/tags` wire field as `directions` (it never changed —
the patternTag rename was HELD). `services/pattern-blocks.ts` already says `DirectionWindows`/
`dirTagId` — just repoint the `pattern_tag_id` SELECTs to `direction_tag_id`. `agents/direction.ts`
already correct. Audit raw-SQL `kind='pattern'` readers on the **tags/tag_prefs** side (NOT
`source_kind='pattern'` — that's W1).

**schema.ts:** `tagPatterns`/`patternTagId` exports → `tagDirections`/`directionTagId`
(in `tag_directions`, `pattern_blocks`, `category_direction_optouts`); update the taxonomy
comments (the "renamed from tag_directions in 0043" comment gets reversed).

**Client:** mostly **no change** — it already says `DirectionColumn`, `byDirection`,
`Tag.directions` (HELD rename never merged). Verify against current `main`; abandon branch
`claude/rename-direction-to-pattern-tag` for good. Only touch: `PatternBlockSettings.tsx`/
`SchedulePatternEditor.tsx` reads of the `pattern-prefs` endpoint → `direction-prefs`.

**Docs/tests:** GLOSSARY taxonomy section (pattern-tag→Direction); `tag-directions.test.ts`,
pattern-block/direction-prefs fixtures; baseline snapshot; audit `backup.ts` list for
`tag_patterns`→`tag_directions`.

---

### W2-P — Make **Pattern** first-class (owner said yes) — follow-on to W2

Today a "pattern" is *implicit*: whatever `pattern_blocks` rows exist for a `day_type`. A
`day_type` (workday / weekend / custom) is already **a named day-arrangement you assign to
dates** — i.e. it already *is* a Pattern. So first-class Pattern = **surface `day_types` as
the "Pattern" noun**, with `pattern_blocks` as the windows that compose it.

**Recommended shape (relabel, not a new table):**
- Glossary: "Pattern" = noun #8 = a named day-arrangement (internal: `day_types` +
  `pattern_blocks`). "Day type" becomes an internal/legacy term.
- UI: the day-type manager/picker is presented as **Patterns** — "assign Tuesday the *Deep
  Work* pattern," pick/duplicate/edit a Pattern; each Pattern shows its direction windows.
- No table rename required (day_types stays the backing store; renaming it collides with
  history and the calendar-assignment keys `day_of_week_map`/`day_assignments`). Optional
  cosmetic: none.

**Decision D2 — depth of "first-class":**
- **(a) Relabel only (recommended):** glossary + UI copy + component names present day-types
  as Patterns. Low risk, no migration.
- **(b) New pickable entity:** a distinct Pattern layer above day_types (e.g. saved/duplicable
  Pattern presets, a Pattern gallery). Bigger — own spec, own phase. Only if (a) proves too thin.

> Sequence W2-P **after** W2 so the low-risk rename lands first; W2-P is product/UI work, not
> a rename, and shouldn't gate it.

---

### W3 — Habit-model audit (gates W1's Habit handling)

GLOSSARY says *"Habit is a Task subtype, **not** a pattern type."* Code still seeds a builtin
Habit `routine_type` + `ensureHabitPattern` (mirrors every `subtype='habit'` task into a
Habit-type routine). Investigate readers first: who reads `routine_types WHERE name='Habit'`,
is `ensureHabitPattern` still called (PR #181 moved habit creation to a task checkbox), does
any placement/briefing/star path depend on a habit being a routine row? Then decide with owner:
(a) remove the bridge (Habit = Task subtype only; data migration to detach existing Habit-type
routine rows), or (b) keep + rename only (`ensureHabitRoutine`). Ritual stays (owner deferred).

---

### W4 — Drop vestigial `auto_mode` (independent, any time) — ✅ SHIPPED

**As-built (2026-07-12; migration `0123_drop_auto_mode` — renumbered twice at merge, 0107→0122→0123)**: `DROP COLUMN` with a
guarded intent-carry backfill first (the top-bar toggle kept WRITING `auto_mode` after 0070,
so `'schedule'` + still-default `'balanced'` upgrades to `'hands_off'`; an explicit
non-default dial is never overridden). `autoMode` removed from schema.ts; baseline snapshot
updated. The toggle itself now drives `trust_mode` (Schedule ⇔ `hands_off`, Suggest ⇔
`'balanced'`). NO EXPORT_VERSION bump: instead the import path (`insertRows`) intersects a
backup's keys with the live table shape, so pre-drop exports still restore (and the same
tolerance covers the earlier 0048/0061/0081 drops).

## 4. Cross-cutting mechanics (every migration/PR)

- **Historical migrations stay frozen.** 14 files (0013/0014/0025/0035/0036/0037/**0038**/0039/
  0040/**0043**/0068/0069/0073/0074) reference old names and are replayed as-is by tests —
  never edit. The rename/revert lands only in the new tail migration(s). Full-chain tests see
  new names; partial-replay tests see old. Audit both.
- **better-sqlite3 renames:** `ALTER TABLE RENAME`/`RENAME COLUMN` auto-update FK refs,
  indexes, triggers when `legacy_alter_table` is OFF (default). Still run
  `PRAGMA foreign_key_check`. FKs are ON by default in this build.
- **Baseline snapshot** (`server/test/baseline.characterization.test.ts`) pins columns —
  regenerate and **eyeball** on each PR.
- **schema-parity / drift tests** — check for `kind='pattern'` or old table-name asserts.
- **EXPORT_VERSION** bumps on any backup-payload table/column rename (W1, W2, W4). Add
  **restore back-compat** for pre-Z exports (alias old table keys → new).
- **Docs sync** per slice: GLOSSARY (Direction/Pattern/Routine, delete "§3b deferred" +
  un-ratify `kind='pattern'`), README (table catalog + API table, delete "load-bearing"
  warning), ROADMAP (drop "deferred" line, add Phase Z), ARCHITECTURE (ER nodes), recap
  `recap_state_A-S.md:157`.
- **Migration numbers provisional** — renumber at merge (PRAGMA-guarded, cosmetic).

## 5. Sequencing & PR strategy

**Avoid the stacked-merge trap** (a PR based on a feature branch merges *into that branch*,
not main — verify content reached main with a content grep, not `git ls-tree`). Every PR is
**based on `main`, merged sequentially**:

1. **W3-audit** → decide Habit outcome → feeds W1.
2. **W1** (routines + `recall_keeps_routine`) — largest; the ask; land first.
3. **W2** (revert to direction) — disjoint tables; base on then-current main, rebase clean.
   Abandon the HELD `direction→pattern-tag` branch.
4. **W2-P** (first-class Pattern) — product/UI follow-on to W2; own PR.
5. **W4** (drop `auto_mode`) — independent; slot in any time.

Each PR: full server + client suites green, baseline regenerated, docs synced, adversarial
self-review (6-lens) before requesting review.

## 6. Risks & gotchas

- **Grep discipline:** never replace bare `'pattern'`. Scope by table/column/route.
  `source_kind='pattern'`→routine (W1) vs `kind='pattern'`→direction (W2) are different columns.
- **W2 is largely a *revert*** — lower risk than a fresh rename, because client + services +
  `agents/direction.ts` already say "direction." The surface that actually changes is the DB
  (0038/0043 undo) + `pattern-prefs`→`direction-prefs` + `services/tags.ts` wire helpers.
- **Restore of old backups** silently no-ops if the import loop keys on new names and the
  payload has old ones → data loss. Add alias + regression test.
- **SSE contract break:** a tab open across deploy misses `routine:*` if still listening for
  `pattern:*` → ship client+server together per workstream (single PR each).
- **`tsc` skips `test/`** — exported-signature renames compile clean but break test callers
  only at CI runtime. Run the real suites.
- **`external_events.direction`** (`'inbound'|'outbound'`, sync) is a *different* concept —
  leave it. Don't sweep it into the grouping-direction rename.

## 7. Open decisions

- **D0** — Cluster B name: **RESOLVED → `direction`** (revert 0038/0043; not `area`). Owner:
  "individually they are directions."
- **D1** — Habit model: remove bridge vs rename-only. **Decided by W3 audit + owner.**
- **D2** — First-class Pattern depth: **RESOLVED → (a) relabel-only.** Glossary + UI present
  day-types as Patterns; no new entity, no migration.
- **D3** — W1 + W4 share one EXPORT_VERSION bump / migration window, or ship separate?
- **D4** — Phase letter `Z` (or fold as CON-4). Cosmetic.

## Definition of done

- [ ] `patterns*` → `routines*` across tables/API/SSE/engine/client; `source_kind='routine'`;
      `recall_keeps_routine`.
- [ ] Tag axis reverted to **direction** (value/tables/columns/routes/services); `pattern_blocks`
      kept as the **Pattern** (day-arrangement); its column is `direction_tag_id`.
- [ ] "Pattern" surfaced first-class per D2; `auto_mode` dropped.
- [ ] Habit-model contradiction resolved (removed or consciously deferred with a ticket).
- [ ] EXPORT_VERSION bumped; pre-Z backups still restore (regression test).
- [ ] Baseline snapshot regenerated; full server + client suites green.
- [ ] GLOSSARY/README/ROADMAP/ARCHITECTURE/recap synced; "§3b deferred", "load-bearing", and
      "ratify `kind='pattern'`" notes removed/reversed.
