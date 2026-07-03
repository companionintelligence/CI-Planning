# W2 Implementation Brief — Direction Revert

> **Parent plan:** [Z-naming-consolidation.md](Z-naming-consolidation.md). This brief is
> **self-contained** — you should not need the plan or the originating conversation to execute it.
> **Base:** current `main` (migration head **0104**). **Independent of W1** (disjoint tables) —
> can land before, after, or beside it.

## 1. Mission

The tag **grouping axis** (the top-level tags **Work / Life / Home** that other tags sort
under) was originally named **direction** (migration 0036). Migrations **0038** (value
`direction`→`pattern`) and **0043** (`tag_directions`→`tag_patterns`, `direction_tag_id`→
`pattern_tag_id`) renamed it to "pattern" — a **mistake**: it stole the word from the
*day-arrangement* concept and collided with the Routine table's `source_kind='pattern'`.

**W2 reverts that.** The grouping axis becomes **direction** again. This is a *revert*, not a
fresh rename — the service/route/wire layer **already says "direction"** (`setTagDirections`,
`directionsOf`, `/api/tags` field `directions`). Only the DB, a handful of `kind='pattern'`
readers, and the `pattern-prefs` endpoint still say "pattern".

**"Pattern" keeps exactly one meaning after this:** the day-arrangement (`pattern_blocks` +
`day_types`). Do **not** rename `pattern_blocks`.

## 2. ⚠️ The three senses of "pattern" — DECISION TABLE (read first)

The literal string `pattern` means three different things in this codebase. Classify every
occurrence before touching it. **Never do a bare find/replace of `'pattern'`.**

| Sense | How to recognize | This brief (W2)? |
|---|---|---|
| **Direction** (grouping tag) | `tags.kind='pattern'`, `tag_prefs.kind='pattern'`, `tag_patterns`, `pattern_tag_id`, "is this tag a grouping" checks | ✅ **REVERT → direction** |
| **Routine** (task bundle) | `source_kind='pattern'`, `sourceKind==='pattern'`, generator `kind==='pattern'`, `patterns`/`pattern_types`/`pattern_tasks` tables, `/api/patterns` | ❌ **W1 — do NOT touch** |
| **Pattern** (day arrangement) | `pattern_blocks` table, `pattern-blocks.ts` files, `DirectionWindows`, day-type windows | 🔒 **KEEP the name — leave as-is** |

## 3. Exact changes

### 3a. Migration `0105_revert_pattern_tag_to_direction.ts`
*(Use the next free number at branch time — 0105 if W1 hasn't merged, else 0106. Provisional;
renumber at merge. Follow the repo's guarded/idempotent migration idiom.)*

```
-- Values (mirrors 0038 in reverse)
UPDATE tags      SET kind='direction' WHERE kind='pattern';
UPDATE tag_prefs SET kind='direction' WHERE kind='pattern';

-- tag_patterns → tag_directions (+ column). Guard: only if old name still exists.
ALTER TABLE tag_patterns RENAME TO tag_directions;
ALTER TABLE tag_directions RENAME COLUMN pattern_tag_id TO direction_tag_id;

-- pattern_blocks: KEEP the table name, rename only the column.
ALTER TABLE pattern_blocks RENAME COLUMN pattern_tag_id TO direction_tag_id;

-- category_direction_optouts: table name already says "direction"; fix the column.
ALTER TABLE category_direction_optouts RENAME COLUMN pattern_tag_id TO direction_tag_id;
```
- Guard each step (`PRAGMA table_info` / table-exists) so a re-run is a no-op.
- End with `PRAGMA foreign_key_check;` — SQLite auto-updates FK refs on RENAME when
  `legacy_alter_table` is OFF (better-sqlite3 default), but verify.
- `pattern_tag_id` is part of the composite PK in `tag_directions` and
  `category_direction_optouts` — `RENAME COLUMN` updates PK/index refs automatically; confirm
  in the post-migration snapshot.

### 3b. `schema.ts`
- `export const tagPatterns = sqliteTable('tag_patterns', {…})` → `tagDirections` /
  `'tag_directions'`; column `patternTagId: text('pattern_tag_id')` → `directionTagId:
  text('direction_tag_id')` (schema.ts:267–273).
- `categoryDirectionOptouts.patternTagId` (schema.ts:296) → `directionTagId` /
  `'direction_tag_id'`.
- `patternBlocks.patternTagId` (schema.ts:306) → `directionTagId` / `'direction_tag_id'`
  (table export `patternBlocks`/`'pattern_blocks'` **stays**).
- Fix the taxonomy comments at schema.ts:253–266 (the "renamed from tag_directions in 0043"
  note reverses) and the `tags.kind` comment (`'pattern'` → `'direction'`).

### 3c. Server readers — flip `kind='pattern'` → `'direction'` and `pattern_tag_id` → `direction_tag_id`
All are the **Direction** sense (verified). File:line references (re-grep to confirm before editing):
- `agents/ingest.ts:38` — `kind = 'pattern'`
- `engine/autoplan.ts:177-178` — `SELECT pattern_tag_id FROM category_direction_optouts`
- `engine/autoplan.ts:181, 545` — `kind = 'pattern'`
- `engine/reminders.ts:135` — `SELECT reminder_offsets FROM tag_prefs … kind='pattern'`
- `lib/owners.ts:15` — comment `(kind='pattern')`
- `routes/possibles.ts:28` — `r.kind === 'pattern' ? 1 : 2` (entity_tags level for a grouping tag)
- `routes/tags.ts:15, 73` — `kind = 'pattern'` / `body.kind === 'pattern' ? 'pattern' : …`
  (the create contract: accept `'direction'` now; see §5 back-compat note)
- `routes/tags.ts:114, 126, 129, 130` — `direction_toggle.patternTagId` wire field →
  `directionTagId` (client sends this — coordinate 3d)
- `routes/tags.ts:173` — comment `tag_patterns … cascade`
- `scripts/import-plan.ts:121` — `INSERT … INTO tag_patterns (…, pattern_tag_id)`
- `services/tags.ts:210, 212, 221-222` — `tag_patterns`/`pattern_tag_id` inside the (already
  direction-named) `setTagDirections`/`directionsOf` trio
- `services/tags.ts:256-261, 266` — `category_direction_optouts … pattern_tag_id`;
  `setDirectionEnabled(…, patternTagId, …)` param → `directionTagId`

### 3d. Files RENAMED vs KEPT (the nuance — get this right)
- **RENAME** `routes/pattern-prefs.ts` → `routes/direction-prefs.ts` and
  `services/pattern-prefs.ts` → `services/direction-prefs.ts`. These are prefs **of the
  grouping tags** (they filter `tag_prefs WHERE kind='pattern'` and validate
  `tag.kind==='pattern'`). Rename `/api/pattern-prefs` → `/api/direction-prefs`, the
  `:patternTagId` route param → `:directionTagId`, the `kind !== 'pattern'` guard → `'direction'`,
  `setPatternPref` → `setDirectionPref`, the audit entity `pattern-prefs:` → `direction-prefs:`,
  and the `kind='pattern'` upsert literal → `'direction'` (services/pattern-prefs.ts:54,64,69,75,77,96,106;
  routes/pattern-prefs.ts:16,18,20,24,26,66,73). Update the router registration in `app.ts`.
- **KEEP** `routes/pattern-blocks.ts` + `services/pattern-blocks.ts` (they are the **Pattern /
  day-arrangement**). Inside them, only: `pattern_tag_id` → `direction_tag_id`
  (services/pattern-blocks.ts:10,15,18,19,32,35) and the `kind !== 'pattern'` guard →
  `'direction'` (routes/pattern-blocks.ts:37). `DirectionWindows`/`dirTagId` are already correct.
- **KEEP** `agents/direction.ts` (`inferDirection`) — already correct.

### 3e. Client
Largely **already correct** — the `direction→patternTag` client rename was HELD and never
merged, so the client still says `DirectionColumn`, `byDirection`, `Tag.directions`. Verify
against current `main` and touch only:
- The `direction_toggle` payload field `patternTagId` → `directionTagId` (must match 3c
  routes/tags.ts:130). Grep `client/src` for `patternTagId` / `direction_toggle`.
- Any client reads of `/api/pattern-prefs` → `/api/direction-prefs` (check
  `PatternBlockSettings.tsx`, `SchedulePatternEditor.tsx`, `lib/api.ts`, `lib/day-windows.ts`).
- Do **not** rename `pattern_blocks`-related client (that's the Pattern day-arrangement).

### 3f. Backup / restore (`routes/backup.ts`) + EXPORT_VERSION
- Table-key rename: `tag_patterns` → `tag_directions` at backup.ts:164 (export SELECT), 288
  (restore DELETE), 298 (restore insert). `pattern_blocks` key **stays** (line 33/174/277/308).
- **Bump `EXPORT_VERSION`.**
- **Restore back-compat (required — else silent data loss):** a pre-Z export has key
  `tag_patterns` and, inside `pattern_blocks`/`tag_patterns`/`category_direction_optouts` rows,
  a `pattern_tag_id` **column key**. On import, map old→new: `tag_patterns`→`tag_directions`,
  and rewrite each row's `pattern_tag_id` field → `direction_tag_id` for those three tables.
  Version-gate on the imported payload's version. Add a regression test that restores a
  pre-Z fixture.

### 3g. Tests + snapshot
- `server/test`: `tag-directions.test.ts` (API portion), pattern-block/pattern-prefs fixtures
  that raw-SQL `tag_patterns`/`pattern_tag_id`/`kind='pattern'` **after a full migration run**.
  Leave partial-chain replays (migrating up to 0036/0043) untouched — they legitimately see
  the old names (§5).
- Regenerate `server/test/baseline.characterization.test.ts` and **eyeball** the diff
  (`tag_patterns`→`tag_directions`, three `pattern_tag_id`→`direction_tag_id`).
- Check `schema-parity`/drift tests for `kind='pattern'` asserts.

## 4. DO NOT TOUCH (out of scope for W2)
- `source_kind='pattern'` / `sourceKind==='pattern'` — **routine** placement marker
  (`routes/blocks.ts:474`). That's **W1**.
- `scripts/clear-planner-from.ts:44,48` `g.kind === 'pattern'` — this is a **generator** kind
  (recurring **routine** placement), not a tag kind. **W1.** (Verify: it reads placement
  generators, not `tags`.)
- The `patterns`/`pattern_types`/`pattern_tasks` tables + `/api/patterns` — **W1**.
- `pattern_blocks` **table name** and `pattern-blocks.ts` **file names** — the Pattern
  day-arrangement; **keep**.
- `external_events.direction` (`'inbound'|'outbound'`) — a *different* "direction" (sync).
  **Leave it.**

## 5. Mechanics & gotchas
- **Historical migrations are frozen.** 0036/0037/0038/0043/0069/0074/0097 reference the old
  names and are replayed as-is by tests — **never edit them**. The revert lands only in the
  new tail migration. Full-chain tests see new names; partial-replay tests see old.
- **Create-contract back-compat:** `routes/tags.ts:73` currently maps request `kind='pattern'`.
  After the flip it should accept `'direction'`; decide whether to also still accept the legacy
  `'pattern'` string from old clients for one release (recommended: accept both on input,
  always store `'direction'`).
- **`tsc` skips `test/`** — signature renames (`setPatternPref`→`setDirectionPref`,
  `patternTagId` params) compile clean but break test callers only at CI runtime. **Run the
  real suites**, don't trust `tsc`.
- Ship client + server **together** (single PR) — the `direction_toggle.patternTagId` wire
  rename is a coordinated contract change.

## 6. Definition of done
- [ ] Migration reverts values + renames `tag_patterns`→`tag_directions` and the three
      `pattern_tag_id`→`direction_tag_id` columns; `pattern_blocks` table name unchanged;
      `PRAGMA foreign_key_check` clean.
- [ ] All §3c readers + §3d `pattern-prefs`→`direction-prefs` updated; `pattern-blocks.ts`
      kept but its column/kind refs flipped.
- [ ] Client `patternTagId` wire field + `/api/pattern-prefs` refs updated; no other client change.
- [ ] `EXPORT_VERSION` bumped; pre-Z backup restores correctly (regression test).
- [ ] Baseline snapshot regenerated; **full server + client suites green**.
- [ ] GLOSSARY taxonomy section: "pattern-tag" → **Direction**; note `kind='pattern'` is
      un-ratified. (README/ROADMAP catalog rows can ride with W1 or this PR.)
- [ ] Adversarial self-review (repo 6-lens) before requesting review. Base `main`, own PR
      (not stacked).

## 7. Verify locally
- `grep -rn "pattern_tag_id\|tag_patterns\|kind = 'pattern'\|kind='pattern'" server/src`
  → should return **only** frozen `db/migrations/*` files afterward.
- `grep -rn "'pattern'" server/src` → remaining hits should be **only** the Routine
  (`source_kind`) and Pattern-day-arrangement (`pattern_blocks`) senses.
