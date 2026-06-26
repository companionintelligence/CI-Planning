# Time Block Categories — Unified Implementation Plan (FINAL)

> Lead-architect synthesis of 6 subsystem reports, re-verified against the live codebase (head migration `0068`, next = `0069`), then adversarially critiqued (governance / scheduler / data-model lenses) and revised. Every new element cites the existing pattern it mirrors. Anchor edits on the named **symbols**, not the integer line numbers (the tree drifts).

## EXECUTIVE SUMMARY

We add a third value to the existing `tags.kind` taxonomy axis — `'category'` — a **Tag sub-level**, exactly as `'pattern'` and `'intention'` are sub-levels today. It groups a subset of *intention* tags via a `tag_categories` junction (verbatim mirror of `tag_patterns`), is configured by a `category_prefs` table (a *trimmed* mirror of `pattern_prefs`), and is stamped forward-only onto time-blocks via new `time_blocks.category_id` + `color_token` columns. One migration, `0069`. The same model surfaces on two screens: a new tab on the Tags page (mirroring `AllTasks.tsx` tabs + reusing `DirectionCard`) and a Settings catalog (mirroring `RoutineTypeSettings.tsx`). The deterministic auto-scheduler consumes it by **extending the existing Pass-1 `dayPlans` loop** — not by adding a parallel pass — with the two fill axes (tag-Plan vs category-Plan) made **mutually exclusive** so no time-block is double-processed.

## GLOSSARY noun statement

**This plan introduces NO new glossary noun. The 8-noun budget is untouched.** `tags.kind='category'` is a Tag *sub-level* ratified the same way `pattern`/`intention` are (`docs/GLOSSARY.md`), not a new entity. The data store is the `tag_categories` junction; nothing is retired. **However**, the user-facing word "Category" collides with the GLOSSARY's existing description of a pattern-tag as a "top-level category" — resolved by adopting the more specific surface label **"Time Block Category"** everywhere a user sees it, while keeping the canonical DB value `kind='category'`.

---

## 0. The reconciliation, decided

**Category is a third value of `tags.kind` (`'pattern' | 'intention' | 'category'`), a Tag SUB-LEVEL — NOT a new noun, NOT a new entity.** Grouped to intention tags by a `tag_categories` junction that mirrors `tag_patterns` exactly, configured by a `category_prefs` table that mirrors a trim of `pattern_prefs`. The "Time Block Category" tab on the Tags page and the catalog in Settings are two surfaces over this one model — exactly as the Tags page and Settings' pattern-windows are two surfaces over `tags.kind='pattern'` today.

Evidence this is the least-divergent choice:
- `tags.kind` is already a free-text taxonomy axis (`schema.ts` `notNull().default('intention')`). A third value is additive.
- `tag_patterns` is a clean intention→top-level junction with cascade FKs; `tag_categories` is a verbatim clone with `categoryTagId` swapped for `patternTagId`.
- `pattern_prefs` is a per-`(owner × tag)` config keyed by a tag id; `category_prefs` mirrors its fetch-merge-upsert shape, trimmed.
- Base/undeletable seeding via `is_base` is reused for the three defaults.

**Three corrections to the first draft (all confirmed against code, all fixed here):**

1. **There is NO `tags.categories` column, and there must not be one.** `tags.directions` is a *derived* read-shape assembled in `routes/tags.ts` via `directionsOf(id)` (`services/tags.ts`) reading the `tag_patterns` junction. Category membership lives in `tag_categories`; the API adds a derived `categories: string[]` via a new `categoriesOf(id)`. A JSON column would be the divergence.
2. **Exactly ONE new migration, `0069`.** Head is `0068_day_types`. Junction + prefs + base seed + `time_blocks` columns land in a single `0069_category_tags`, matching how `0037`/`0039` each bundled table + index + backfill.
3. **Tag-Plan and Category-Plan are mutually-exclusive container roles on the same row.** A time-block is filled by Auto via *either* its `tag` (existing Pass 1) *or* its `category_id`, never both — enforced at the SQL level (§4).

---

## 1. Unified data model + migration `0069_category_tags`

One migration, mirroring the bundle-everything style of `0039_pattern_prefs.ts`, with idempotent `CREATE TABLE IF NOT EXISTS` / `INSERT OR IGNORE` guards.

### 1a. `schema.ts` additions

**`tagCategories`** — clone of `tagPatterns`, swap the second column name:
```ts
// 0069: intention→category-tag membership (many-to-many). Mirror of tag_patterns.
// An intention with no row here is "Unsorted" in the Time Block Category view.
export const tagCategories = sqliteTable('tag_categories', {
  intentionTagId: text('intention_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
  categoryTagId:  text('category_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.intentionTagId, t.categoryTagId] }) }));
```

**`categoryPrefs`** — a deliberate TRIM of `patternPrefs` (drops `auto_fill`, `reminder_offsets`, and `icon_shape` — no consumer; categories don't shade the Planner). Keeps the two load-bearing fields:
```ts
// 0069: per-owner, per-category-tag display config. TRIMMED mirror of pattern_prefs.
// color_token = USER-PICKABLE category color, also the forward-only stamp SOURCE (§2d).
// default_minutes = per-category session size consumed by placeIntoWindow.
export const categoryPrefs = sqliteTable('category_prefs', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  categoryTagId: text('category_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
  colorToken: text('color_token').notNull().default('primary'),
  defaultMinutes: integer('default_minutes').notNull().default(60),
}, (t) => ({ uq: unique().on(t.ownerId, t.categoryTagId) }));
```
The cloned `routes/pattern-prefs.ts` validation references the dropped fields — those branches are **removed**, not copied.

**`timeBlocks` two new columns** (mirror the nullable denormalized `tag` field + the `parentBlockId` `ON DELETE SET NULL` self-ref FK):
```ts
  // 0069: forward-only category stamp. category_id = the Time Block Category
  // (tags.kind='category'). color_token = category color FROZEN at create-time so
  // later edits/deletes of the category never re-color existing blocks.
  categoryId: text('category_id').references(() => tags.id, { onDelete: 'set null' }),
  colorToken: text('color_token'),
```

`tags.kind` comment updated to document the third value. No column change.

### 1b. The migration `up(db)`

1. `CREATE TABLE IF NOT EXISTS tag_categories (...)` — copy the `tag_patterns` DDL shape.
2. `CREATE TABLE IF NOT EXISTS category_prefs (...)` + index — copy the `0039` table+index idiom.
3. `ALTER TABLE time_blocks ADD COLUMN category_id ...` and `... color_token ...` — use the idempotent `pragma table_info` column-existence guard from `0040_pattern_default_minutes.ts`.
4. **Seed three base categories with collision-safe names (BLOCKER FIX).** `0036_tag_directions.ts` already seeds `me-time` and `family-time` as `kind='intention'`, and `tags.name` is UNIQUE — a plain insert of those names throws, and *promoting* them would strip them from the intention axis and orphan their `tag_patterns` rows. So seed single-word names `family`, `social`, `me` with `kind='category', is_base=1`. Defensively assert none already exist; fail loudly on collision rather than promote. (Single-word names also close the `displayTag` title-casing issue.) Display labels render via `displayTag` → "Family" / "Social" / "Me".
5. **Backfill `category_prefs`**: loop `owners × base-categories`, `INSERT OR IGNORE` one row each with distinct colors (`family→chart-1`, `social→chart-3`, `me→chart-5`), `default_minutes=60`. Do NOT create `tag_categories` rows — categories start empty/Unsorted.

### 1c. Register in `migrations/index.ts`

Append `m0069` to imports and the ordered `MIGRATIONS` array.

### Governance / GLOSSARY edits (same commit as the migration)

- GLOSSARY Tag-taxonomy bullet: add `category` as a second grouping axis orthogonal to pattern-tags (ungrouped = Unsorted), surfaced as **"Time Block Category"**. Reword the pattern-tag definition to drop the bare word "category" (e.g. "top-level **grouping**"). Extend the Naming note to list `tag_categories`/`category_prefs`.
- README schema section: add `tag_categories`, `category_prefs`, `time_blocks.category_id`/`color_token`; head moves to `0069`.

---

## 2. Server — service + routes

### 2a. `services/tags.ts` — three functions mirroring the direction trio
Append after `directionsOf`, copying its prepared-statement style:
- `setCategoryMemberships(intentionTagId, categoryTagIds)` — mirror `setTagDirections` (DELETE then INSERT OR IGNORE).
- `categoriesOf(intentionTagId): string[]` — mirror `directionsOf` (join `tag_categories → tags`, names ordered).
- Delete protection already generic: `tagIsUsed` queries `entity_tags` by `tag_id` — covers category tags unchanged.

### 2b. `routes/tags.ts` — extend existing endpoints (NO new tag endpoints)
- `categoryIds(names)` resolver — mirror `directionIds`, filter `kind='category'`.
- **POST `/api/tags`**: accept `'category'` kind; accept optional `categories?: string[]` (call `setCategoryMemberships`), parallel to `directions`. **BLOCKER FIX:** when `kind==='category'`, immediately upsert a default `category_prefs` row (so a block created against a brand-new custom category always has a stamp source at create-time and never falls through to the tag hash forever).
- **PATCH `/api/tags/:id`**: accept `categories?: string[]`; when present and `kind==='intention'`, call `setCategoryMemberships`. Drag-move between category cards uses this (single-element array), exactly as direction drag-move does.
- **GET `/api/tags`**: add `categories: r.kind === 'intention' ? categoriesOf(r.id) : []`.
- DELETE guard already rejects `is_base` + used tags (409) — covers base categories unchanged.

### 2c. `category_prefs` service + routes — mirror the SHAPE of `pattern_prefs`
- New `services/category-prefs.ts` — clone the fetch-merge-upsert structure, trimmed: `getCategoryPrefs(ownerId)` / `setCategoryPref(ownerId, categoryTagId, patch)`.
- New `routes/category-prefs.ts` — clone `GET /api/pattern-prefs` + `PUT /api/pattern-prefs/:id`, removing the dropped-field validation. Keep status codes: **404** missing tag, **422** wrong kind (409 stays reserved for the tags DELETE guards). Mount under `/api/category-prefs`.

### 2d. `routes/blocks.ts` — accept `category_id` + stamp `color_token`
- **POST**: add `category_id?` and `color_token?` to the body; set `categoryId`. Color stamp (forward-only): if `category_id` present, set `colorToken = body.color_token ?? getCategoryPrefs(owner)[category_id]?.color_token`. With the §2b backfill the lookup is always populated.
- **PATCH**: add `category_id`; re-stamp `color_token` only when `category_id` actually changes (a deliberate re-assignment), never on a config edit. `color_token` is forward-only against *config* edits; `category_id` itself is **live** (re-running Auto re-fills on the new category). Color-forward-only ≠ scheduling-forward-only — intentional.
- **GET**: new columns flow through automatically; add to the `Block` API type.

---

## 3. Client

- **`api.ts`** — `Tag` gains `categories: string[]`, widen `kind`; `tags.create`/`tags.update` accept `categories?`; `Block` gains `category_id?`/`color_token?`; new `api.categoryPrefs.{get,set}` mirroring the pattern-prefs namespace.
- **`tag-tax.ts`** — `groupByCategory` (clone of `groupByDirection`, filter `kind==='category'`, group by `t.categories.includes(...)`); `sortCategories` with `BASE_ORDER=['family','social','me']`. Same module, no new file.
- **`views/Tags.tsx`** — add the `AllTasks.tsx` tab idiom (`view()` signal + tab markup); categories tab label **"Time Block Categories"**. Reuse `DirectionCard`, generalizing its one coupling with a `membersOf?: (t) => string[]` prop (default `t => t.directions`; categories tab passes `t => t.categories`). Categories panel uses the same `<For>` + `DirectionCard`; `move`/`onAddTag`/delete-guard/add-category-form mirror the direction handlers with `kind:'category'`. Drag kind `'tag-chip'` unchanged; the active tab decides whether a drop edits `directions` or `categories`. An intention can belong to a pattern AND a category (two independent junctions).
- **`components/CategorySettings.tsx`** — clone `RoutineTypeSettings.tsx` (CRUD with locked defaults): name (rename = rename tag, UNIQUE → handle 409), color picker (`PATTERN_COLORS` + `colorVar`), `default_minutes`. No icon picker. Save → `api.categoryPrefs.set`; delete → `api.tags.remove`, disabled for `is_base`. Base 3 render first with a lock badge.
- **`views/Settings.tsx`** — mount `<CategorySettings />` after the pattern-windows section.
- **`ElementWizard.tsx` + `lib/element.ts`** — add `categoryId?` to `ElementForm`; thread `category_id` into the timeblock save body (both someday + scheduled). Add a category select/grid over `tags().filter(kind==='category')`, default "None", prefilled from the block's `category_id` on edit. Category is independent of the block's `tag` (tag stays the direction axis).
- **`lib/textures.ts` + `Planner.tsx`** — `blockColorVar(block, categoryPrefs)` precedence: stamped `block.color_token` → (transitional) live `categoryPrefs[category_id]?.color_token` → `tagColorVar(block.tag)` → `var(--primary)`. Block renderers call this instead of inline `tagColorVar`. Step 1 reads the *stamped* token, so editing a category never re-colors placed blocks.

---

## 4. Auto-scheduler — the precise pipeline edit (determinism preserved)

> **MAJOR DIVERGENCE FIX.** The first draft's standalone "Pass 1.5" iterated the *same* `time_blocks` rows `dayPlans` already iterates — a block with both `tag` and `category_id` would be filled twice. The fix is to **extend** Pass 1 and **partition** the rows disjointly.

### 4a. Disjoint partition (the structural guarantee)
`dayPlans` becomes the tag-Plan selector — add `AND category_id IS NULL`. A sibling `dayCategoryPlans` selects `... AND category_id IS NOT NULL`. **Invariant:** every scheduled timeblock container is owned by exactly one fill axis. Both order by `start_at, id` (adding the `id` tiebreak to both makes them strictly deterministic).

### 4b. Category-Plan fill — extends Pass 1, runs immediately after it
Right after the Pass-1 loop (`const placedInPlans = placedIds.size;`) and before the direction-window pass, iterate `dayCategoryPlans` using the identical Pass-1 call shape:
1. **Candidates by category over task SECONDARY tags:**
   ```sql
   SELECT DISTINCT entity_id FROM entity_tags
    WHERE entity_kind='task' AND level > 1 AND tag_id IN (
      SELECT intention_tag_id FROM tag_categories WHERE category_tag_id = :blockCategoryId
    )
   ```
   **Determinism MUST:** build a `Set` of ids, then `filtered = staged.filter(t => !placedIds.has(t.task_id) && candidateIds.has(t.task_id))` — preserve `staged` order; never iterate SQL row order. (Comment: must query `entity_tags` level>1 directly — `staged.tags` is level-1 only.)
2. **Place** with the existing helper unchanged: `placeIntoWindow(filtered, start, end, prefs, { parentBlockId: block.id, runId })`. `default_minutes` from `category_prefs` informs session sizing.
3. Merge `r.placedTaskIds` into `placedIds`; add `r.blocksCreated`. Reuses Pass-1 machinery verbatim; disjoint partition makes double-processing impossible.

### 4c. Supersession of pattern_blocks windows (emergent — no edit to `pattern_blocks`)
Supersession falls out of the existing `dayObstacles(includePlans=1)` path for ALL scheduled timeblocks regardless of `category_id`: an uncategorized block still carves its span out of overlapping pattern windows; a categorized block that matches zero tasks still blocks the span (the window pass flows around the empty container). This is literally "a time-block supersedes pattern_blocks windows for its span."

### 4d. Multi-category / overlapping blocks (determinism rules)
- Overlapping categorized blocks: iterated `start_at, id`; the earlier claims its span; the later sees the earlier's child blocks as obstacles and flows around.
- A task matching two categories: the earliest block by `(start_at, id)` with room wins; the second skips it (added to `placedIds`). Category priority is temporal. Flagged as a product confirmation (§8.6).

### 4e. Composition with reflow / ingest
`placeFlightPlan` is the engine of `reflow()` and `autoScheduleOnIngest()`, so category fill runs on all three entry points. Category-task blocks are plain `block_kind='task', source_kind='agent', is_auto=1` — snapshot/protected/diffed identically; a frozen category task becomes a `dayObstacles` obstacle and the next fill flows around it. `daily_plan` linking + `flight_plan` removal + `fillByPriority` all see category-placed tasks via `placedIds`. All three paths tested (incl. that category-task displacement doesn't over-trigger the replan nudge).

### 4f. Determinism guarantees
Both selectors order `start_at, id`; candidate filtering preserves `staged` order via Set intersection; matching keys on `category_id`/tag **ids** not names; no clock/randomness introduced; forward-only stamping keeps past renders immutable. Net change: `dayPlans` gains `AND category_id IS NULL` + `id` tiebreak; a sibling `dayCategoryPlans`; one new loop between Pass 1 and the window pass. `placeIntoWindow`, `dayObstacles`, `buildGaps`, `selectedStaged`, `fillByPriority` keep their signatures.

---

## 5. "Auto reading the calendar" — mapped to the 4 requested steps

1. **Find the day.** `placeFlightPlan` resolves `date` + `tz` and `selectedStaged(owner)`; `clearPriorAuto` clears prior auto blocks for reproducibility.
2. **Find scheduled events (fixed/locked meetings).** Bottom layer: every `placeIntoWindow` runs `dayObstacles`, which always treats locked blocks + `block_kind='meeting'` + live task blocks as immovable. Pass 1 (tag-Plans) runs first against these.
3. **Find time-blocks; identify DIRECTION and CATEGORY.** Containers are partitioned: `dayPlans` (direction = its `tag`) and `dayCategoryPlans` (category = its `category_id`). Exactly one Auto fill role each.
4. **Fill by secondary tag → category.** For each category-Plan, `tag_categories` yields the intention tags in that category; tasks whose **secondary** (`entity_tags.level>1`) tags include any become candidates; `placeIntoWindow` packs them as child blocks. Remaining tasks flow to pattern-windows, then the explicit priority workday fill.

Net layer order, as requested: **scheduled events → time-blocks → pattern-windows → tasks.**

---

## 6. Phased rollout (each phase independently shippable, CI-green)

- **Phase 1 — Data (`0069`).** Schema defs + migration (collision-safe seed) + `index.ts` + GLOSSARY/README edits. Ships invisibly. Gate: forward-idempotency + orphan-free tag tests under `TZ=UTC`.
- **Phase 2 — Tags view tab.** `Tag.categories` field, `tags.ts` service trio + route extensions (incl. create-time `category_prefs` backfill), `groupByCategory`, `Tags.tsx` tabs + `DirectionCard.membersOf`.
- **Phase 3 — Settings catalog.** `category-prefs` service + routes, `api.categoryPrefs`, `CategorySettings.tsx`, `Settings.tsx` mount.
- **Phase 4 — Time-block field + color.** `blocks.ts` `category_id` + forward-only stamp, `Block` type, `ElementWizard`/`element.ts` picker, `textures.ts` `blockColorVar` + `Planner` wiring. Scheduler still ignores it (safe).
- **Phase 5 — Scheduler.** The `autoplan.ts` partition + category-Plan loop. Determinism + reflow + ingest tests gate.

---

## 7. Test plan (highlights)

- **Migration:** creates both tables + 2 columns + 3 base categories + N owner×category prefs; idempotent re-run; assert no collision with `0036`'s `me-time`/`family-time` (both survive, distinct). No `down()` (the runner has none). Run under `TZ=UTC`.
- **Tag service/routes:** membership round-trip; POST `kind:'category'` also creates a default pref; an intention in both a pattern AND a category appears in both views; DELETE rejects base (409) + used (409).
- **category-prefs:** GET/PUT round-trip; wrong kind → 422; missing → 404.
- **blocks:** POST stamps `color_token` (incl. brand-new custom category); editing the category color later doesn't change the stamp (forward-only); PATCH re-assigning `category_id` re-stamps + changes future Auto fill (scheduling is live).
- **Scheduler determinism (critical):** byte-identical placement across runs; a block with both `tag` and `category_id` is filled exactly once (partition invariant); category fill matches only secondary tags; rename mid-run doesn't change the plan (id-keyed); uncategorized block carves its span; zero-match categorized block still blocks the span; overlapping blocks + multi-category task → earliest `(start_at,id)` wins; shuffling `tag_categories` insert order → identical placement; reflow + ingest paths run category fill identically.
- **Color resolution:** `blockColorVar` precedence (stamp → live transitional → tag hash → primary).

---

## 8. OPEN DECISIONS

1. **~~Base-category naming vs `displayTag`~~ — CLOSED.** Single-word collision-free names `family`/`social`/`me`.
2. **`category_prefs` field set — CONFIRM.** Trimmed to `{ color_token, default_minutes }` (icon/auto_fill/reminders dropped). Confirm `default_minutes` wanted as the per-category session fallback.
3. **Category matching: secondary tags only.** Per the request. Confirm a task matches a category *only* via secondary tags (its primary/direction tag stays the pattern-window axis).
4. **Re-stamp on PATCH category re-assignment — CONFIRM the two-axis distinction.** `color_token` forward-only vs `category_id` live + re-assignable.
5. **Muting semantics.** Mute is per-tag global (`tags.muted`); a muted intention is muted in both views. Confirm acceptable (matches today).
6. **~~Multi-category task tie-break~~ — CONFIRMED.** Earliest block by `(start_at, id)` with room wins; later overlapping blocks skip the task. Deterministic, no user config.
7. **~~Icon picker for categories~~ — CLOSED** toward defer (no consumer for `icon_shape`).

### Confirmed decisions (2026-06-25)
- **Surface label:** "Time Block Category" (canonical DB value stays `kind='category'`). Requires the one-line GLOSSARY reword in §1c.
- **Multi-category tie-break:** earliest block wins (§4d).
- **Status:** plan on hold — user is still adding requirements. Increment 2 folded in below (§9).

---

## 9. Increment 2 (2026-06-25) — category scoping, wizard picker, edit/note status

### Status of the three time-block bullets in this batch
- **Edit → full menu (req 1): ALREADY IMPLEMENTED.** The Planner block popover Edit (`Planner.tsx:726`) opens the full ElementWizard in `mode:'edit'` (`Planner.tsx:21`) — identical to "New Time Block." Today/Calendar expose only create. No work needed beyond the new category picker (§9c) landing in that same menu.
- **Note on a time block (req 2): ALREADY IMPLEMENTED.** Note textarea (`ElementWizard.tsx:410`) → `form.note` → persisted to `time_blocks.note` (`element.ts:190,198`; column from migration `0021`). No work needed.
- **Category instead of Direction tags (req 3): NEW** — see §9c.

### 9a. Confirmed model decisions (supersede earlier assumptions)
- **Time-block axis = Category ONLY; direction is IMPLIED by the category.** A wizard-created block stores `category_id` (§1a) and does **not** set a direction `tag`. The scheduler derives the block's direction(s) from the category's enabled directions (§9d). This supersedes any "block keeps both tag and category" reading: wizard time-blocks are category-Plans (`category_id IS NOT NULL`, `tag` null) — still inside the §4a disjoint partition.
- **Category↔Direction = a scheduling SCOPE; members are hand-filed.** A category's intention-tag members are hand-filed by drag-to-file (identical to the Patterns tab, via `tag_categories`). The Work/Home/Community toggles are a SEPARATE per-category scope controlling which directions' tasks the category's time-blocks may pull (§9d).

### 9b. New data: `category_direction_optouts` (opt-out polarity = "default all-on")
The requirement "all direction types are ON for all existing and new categories" is a default-true relation; its correct normalization is a sparse **opt-out** set, not a dense membership table:
```ts
// 0069: a row = this DIRECTION is OFF for this CATEGORY. Empty = all directions on.
// Opt-out polarity makes "default all-on for every existing & new category — and any
// future direction" fall out for free (no backfill on category/direction create).
// Precedent for default-on-with-opt-out: tags.muted (a per-tag opt-out flag).
export const categoryDirectionOptouts = sqliteTable('category_direction_optouts', {
  categoryTagId: text('category_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
  patternTagId:  text('pattern_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.categoryTagId, t.patternTagId] }) }));
```
- Folds into migration `0069` (still one migration). **No seed rows** (empty = all-on, so the "default all-on" requirement needs zero seeding).
- Service: `directionOptoutsOf(categoryTagId): string[]` and `setDirectionEnabled(categoryTagId, patternTagId, enabled)` (delete row → enable, insert → disable). Mirrors the junction read/write idiom.
- API: GET `/api/tags` adds `direction_optouts: string[]` on category rows; a PATCH toggles a single pair (parallel to the `categories`/`directions` membership edits).

### 9c. Wizard (req 3) — Category picker replaces the Direction picker for timeblocks
- For `kind()==='timeblock'`, render a **Category single-select** over `tags().filter(t => t.kind==='category')` (default "None") in place of the Pattern/Direction row of `<TagSection/>`; bind to `form.categoryId` (already threaded to `category_id`, §3f). Task/Habit kinds keep `<TagSection/>` (pattern+intention) unchanged.
- The Planner block chip + popover rendering `#{block.tag}` (`Planner.tsx:714,721`) switch to the category's display name + its stamped color via `blockColorVar` (§3g).
- A block's own secondary intention tags are not required by these reqs (matching is via the category, not the block's tags); leave that affordance unchanged/optional.

### 9d. Scheduler — category fill gains a direction-scope filter (extends §4b)
For each category-Plan block, a staged task is a candidate iff:
1. it has a SECONDARY tag (`entity_tags.level>1`) that is a member of the block's category (`tag_categories`), AND
2. its DIRECTION (primary pattern tag) is NOT in the category's opt-out set (`category_direction_optouts`) — i.e. that direction is enabled.

Determinism unchanged: still a `Set` intersection preserving `staged` order. A task with **no** direction is included on intention match alone (the scope filter only removes explicitly opted-out directions). [minor open detail — confirm direction-less handling]

### 9e. Tags Category tab UI (refines §3c)
Each category card renders: a row of N direction toggles (Work/Home/Community + any user directions), each ON unless present in the opt-out set (default ON); below, the hand-filed intention chips with the same drag-to-file / mute / delete affordances as `DirectionCard`. Toggling a direction calls `setDirectionEnabled`; "Add category" + base-locked behavior unchanged.

---

## 10. Gap review (2026-06-25) — corrections & paste-ready code

> 9-agent adversarial cross-check of §§1–9 against the live tree: **6 refuted claims, 18 gaps closed, 0 blockers remaining.** This section **supersedes any conflicting earlier statement** — notably the §2b "existing DELETE guard covers categories" claim (FALSE — see S2.6) and the §1a "comment already updated" implication (R1). Anchor edits on **symbols, not line numbers**.

### 10.0 Refuted claims / stale citations — fix first
- **R1 — the `tags.kind` comment is a CODE edit, not just a doc edit.** `schema.ts` still reads `// 'pattern' | 'intention'` and the prose calls a pattern a "top-level **category**" (the exact word collision §1c wants gone). Change the inline comment to `// 'pattern' | 'intention' | 'category'` and reword the prose "category" → "grouping".
- **R2 — migrations use raw `better-sqlite3`, NOT Drizzle/the `sqlite` singleton.** `0069` must use `db.exec(...)` / `db.prepare(...)` against the passed `db`, with `import { newId } from '../../lib/ids.js'`. No `uuid7()` / `sqlite.prepare` inside the migration.
- **R3 — backup already drops container blocks (pre-existing bug).** `backup.ts` exports `time_blocks` scoped by `task_id IN (owner task ids)`, so `block_kind='timeblock'` containers (`task_id IS NULL`) are never exported. Tag-Plans already vanish on restore; `category_id`/`color_token` ride those same rows. See CC1.
- **R4 — anchor on symbols, not the §9 integers.** The Edit/note/chip symbols are verified to exist; the line numbers are advisory only.
- **R5 — category-prefs mount point is concrete:** `routes/index.ts` is an explicit router array; insert `categoryPrefsRouter()` right after `patternPrefsRouter()` (+ import).
- **R6 — the client uses `request<T>(method, path, body)` (which prepends `/api`), not `fetch`.** Mirror the `patternPrefs` namespace; paths are `/category-prefs`.

### 10.1 Data / migration

**D1 — `schema.ts` defs + `tags.kind` comment (patches §1a; R1):**
```ts
  // a 'pattern' is a top-level GROUPING (Home/Work/Community); an 'intention' is grouped
  // under patterns via tag_patterns; a 'category' (0069) is a SECOND orthogonal grouping
  // axis over intentions via tag_categories — surfaced as "Time Block Category".
  kind: text('kind').notNull().default('intention'),       // 'pattern' | 'intention' | 'category'

// after tagPatterns:
export const tagCategories = sqliteTable('tag_categories', {
  intentionTagId: text('intention_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
  categoryTagId:  text('category_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.intentionTagId, t.categoryTagId] }) }));

// after patternPrefs — TRIMMED mirror:
export const categoryPrefs = sqliteTable('category_prefs', {
  id: text('id').primaryKey().$defaultFn(newId),
  ownerId: text('owner_id').references(() => owners.id).notNull(),
  categoryTagId: text('category_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
  colorToken: text('color_token').notNull().default('primary'),
  defaultMinutes: integer('default_minutes').notNull().default(60),
}, (t) => ({ uq: unique().on(t.ownerId, t.categoryTagId) }));

export const categoryDirectionOptouts = sqliteTable('category_direction_optouts', {
  categoryTagId: text('category_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
  patternTagId:  text('pattern_tag_id').references(() => tags.id, { onDelete: 'cascade' }).notNull(),
}, (t) => ({ pk: primaryKey({ columns: [t.categoryTagId, t.patternTagId] }) }));

// inside timeBlocks, after parentBlockId:
  categoryId: text('category_id').references((): AnySQLiteColumn => tags.id, { onDelete: 'set null' }),
  colorToken: text('color_token'),
```

**D2 — `server/src/db/migrations/0069_category_tags.ts` (patches §1b; R2). Collision-verified safe** (`0036` seeds `home`/`work`/`community` + `me-time`/`family-time`/`relax`/`socialize`; the new `family`/`social`/`me` are distinct under `UNIQUE(name)`):
```ts
import type { Database } from 'better-sqlite3';
import { newId } from '../../lib/ids.js';

export const id = '0069_category_tags';

const BASE_CATEGORIES = ['family', 'social', 'me'];
const BASE_COLORS: Record<string, string> = { family: 'chart-1', social: 'chart-3', me: 'chart-5' };

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tag_categories (
      intention_tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      category_tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (intention_tag_id, category_tag_id)
    );
    CREATE INDEX IF NOT EXISTS ix_tag_categories_cat ON tag_categories(category_tag_id);
    CREATE TABLE IF NOT EXISTS category_prefs (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owners(id),
      category_tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      color_token TEXT NOT NULL DEFAULT 'primary', default_minutes INTEGER NOT NULL DEFAULT 60,
      UNIQUE(owner_id, category_tag_id)
    );
    CREATE INDEX IF NOT EXISTS ix_category_prefs_owner ON category_prefs(owner_id);
    CREATE TABLE IF NOT EXISTS category_direction_optouts (
      category_tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      pattern_tag_id  TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (category_tag_id, pattern_tag_id)
    );
  `);

  const tbCols = (db.prepare(`PRAGMA table_info(time_blocks)`).all() as { name: string }[]).map((c) => c.name);
  if (!tbCols.includes('category_id')) db.exec(`ALTER TABLE time_blocks ADD COLUMN category_id TEXT REFERENCES tags(id) ON DELETE SET NULL`);
  if (!tbCols.includes('color_token')) db.exec(`ALTER TABLE time_blocks ADD COLUMN color_token TEXT`);

  const findByName = db.prepare(`SELECT id, kind FROM tags WHERE name = ?`);
  const insCat = db.prepare(`INSERT INTO tags (id, name, kind, is_base) VALUES (?, ?, 'category', 1)`);
  const catId: Record<string, string> = {};
  for (const name of BASE_CATEGORIES) {
    const existing = findByName.get(name) as { id: string; kind: string } | undefined;
    if (existing) {
      if (existing.kind !== 'category') throw new Error(`0069: base category name '${name}' already exists as kind='${existing.kind}'; rename it before migrating.`);
      catId[name] = existing.id;
    } else { const nid = newId(); insCat.run(nid, name); catId[name] = nid; }
  }

  const owners = db.prepare(`SELECT id FROM owners`).all() as { id: string }[];
  const insPref = db.prepare(`INSERT OR IGNORE INTO category_prefs (id, owner_id, category_tag_id, color_token, default_minutes) VALUES (?, ?, ?, ?, 60)`);
  for (const o of owners) for (const name of BASE_CATEGORIES) insPref.run(newId(), o.id, catId[name], BASE_COLORS[name]);
}
```

**D3 — register in `migrations/index.ts`:** add `import * as m0069 from './0069_category_tags.js';` and append `, m0069` to the `MIGRATIONS` array.

**D4 — docs:** GLOSSARY tag-taxonomy bullet (add `category` axis, reword pattern "category"→"grouping", extend Naming note); README schema head is **stale at `0061`** → update to `0069` + add the three tables + `time_blocks.category_id`/`color_token`.

### 10.2 Server

**S1 — `services/tags.ts`** append after `directionsOf` (mirror its prepared-statement style):
```ts
const delCats = sqlite.prepare(`DELETE FROM tag_categories WHERE intention_tag_id = ?`);
const insCat  = sqlite.prepare(`INSERT OR IGNORE INTO tag_categories (intention_tag_id, category_tag_id) VALUES (?, ?)`);
export function setCategoryMemberships(intentionTagId: string, categoryTagIds: string[]): void {
  delCats.run(intentionTagId); for (const c of categoryTagIds) insCat.run(intentionTagId, c);
}
const catsOfStmt = sqlite.prepare(`SELECT c.name AS name FROM tag_categories tc JOIN tags c ON c.id = tc.category_tag_id WHERE tc.intention_tag_id = ? ORDER BY c.name`);
export function categoriesOf(intentionTagId: string): string[] { return (catsOfStmt.all(intentionTagId) as { name: string }[]).map((r) => r.name); }

const delOptOut = sqlite.prepare(`DELETE FROM category_direction_optouts WHERE category_tag_id = ? AND pattern_tag_id = ?`);
const insOptOut = sqlite.prepare(`INSERT OR IGNORE INTO category_direction_optouts (category_tag_id, pattern_tag_id) VALUES (?, ?)`);
export function setDirectionEnabled(categoryTagId: string, patternTagId: string, enabled: boolean): void {
  if (enabled) delOptOut.run(categoryTagId, patternTagId); else insOptOut.run(categoryTagId, patternTagId);
}
const optOutsOfStmt = sqlite.prepare(`SELECT p.name AS name FROM category_direction_optouts cdo JOIN tags p ON p.id = cdo.pattern_tag_id WHERE cdo.category_tag_id = ? ORDER BY p.name`);
export function directionOptoutsOf(categoryTagId: string): string[] { return (optOutsOfStmt.all(categoryTagId) as { name: string }[]).map((r) => r.name); }

// DELETE guard — tagIsUsed inspects entity_tags ONLY; category refs live in time_blocks.category_id + tag_categories.
const catRefByBlock  = sqlite.prepare(`SELECT 1 FROM time_blocks WHERE category_id = ? LIMIT 1`);
const catRefByMember = sqlite.prepare(`SELECT 1 FROM tag_categories WHERE category_tag_id = ? LIMIT 1`);
export function categoryIsReferenced(categoryTagId: string): boolean { return !!catRefByBlock.get(categoryTagId) || !!catRefByMember.get(categoryTagId); }
```

**S2 — `routes/tags.ts`:** (1) import the new fns; (2) add a `categoryIds(names)` resolver (mirror `directionIds`, `kind='category'`); (3) GET adds `categories: r.kind==='intention' ? categoriesOf(r.id) : []` and `direction_optouts: r.kind==='category' ? directionOptoutsOf(r.id) : []`; (4) POST widens `kind` to accept `'category'`, accepts `categories?`, and **on `kind==='category'` inserts a default `category_prefs` row** (the §2b create-time backfill); (5) PATCH accepts `categories?` (→ `setCategoryMemberships`) and `direction_toggle?: {patternTagId, enabled}` (→ `setDirectionEnabled`); (6) **DELETE guard fix — the §2b claim is FALSE:** add `if (tag.kind==='category' && categoryIsReferenced(id)) ctx.throw(409, 'category has members or is used by a time block')`. (`is_base` already blocks the base 3.)

**S3 — `services/category-prefs.ts` (NEW)** — trimmed clone of `pattern-prefs.ts`: `getCategoryPrefs(ownerId): Record<string, {color_token, default_minutes}>` and `setCategoryPref(ownerId, categoryTagId, patch)` with the same `INSERT … ON CONFLICT(owner_id, category_tag_id) DO UPDATE` upsert.

**S4 — `routes/category-prefs.ts` (NEW) + mount (R5)** — clone `pattern-prefs.ts` (a bare `new Router()` with `/api/...` baked into each path): `GET /api/category-prefs`, `PUT /api/category-prefs/:categoryTagId`; drop `auto_fill`/`reminder_offsets`/`icon_shape` validation; keep `404` (missing) / `422` (wrong kind); `writeAudit('category-prefs:'+id)`. Mount in `routes/index.ts` after `patternPrefsRouter()`.

**S5 — `routes/blocks.ts` category_id + color stamp + `tag XOR category_id` invariant:**
```ts
// POST — compute stamp before insert; set categoryId in .values():
const colorToken = body.category_id
  ? (body.color_token ?? getCategoryPrefs(currentOwnerId())[body.category_id]?.color_token ?? 'primary') : undefined;
// PATCH — re-stamp only when category_id changes:
if (body.category_id !== undefined) {
  update.categoryId = body.category_id;
  update.colorToken = body.category_id ? (getCategoryPrefs(currentOwnerId())[body.category_id]?.color_token ?? 'primary') : null;
}
// BOTH (computing effective tag/category from the merged row) — ENFORCED PARTITION INVARIANT:
if (effectiveTag != null && effectiveCategoryId != null) ctx.throw(422, 'a time block may set a tag OR a category, not both');
if (body.category_id != null && !sqlite.prepare(`SELECT 1 FROM tags WHERE id = ? AND kind = 'category' LIMIT 1`).get(body.category_id))
  ctx.throw(422, 'category_id must reference a kind=category tag');
```
This makes the `dayPlans`/`dayCategoryPlans` disjointness a **server-enforced** invariant, not a UI convention.

**S6 — recurrence propagation in `blocks-recur.ts` (3-point patch; without it recurring category-Plans silently never fill):** add `category_id, color_token` to (a) the `BlockTemplate` interface, (b) the template SELECT, (c) the instance INSERT columns/placeholders/args — copying the **frozen stamp verbatim** (do not re-derive per instance; preserves forward-only).

### 10.3 Client

**C1 — `api.ts`:** `Block` += `category_id?: string|null; color_token?: string|null;`. `Tag` widens `kind` to include `'category'`, += `categories: string[]; direction_optouts?: string[]`. `tags.create`/`update` accept `categories?`. New namespace mirroring `patternPrefs`:
```ts
  categoryPrefs: {
    list: (): Promise<{ prefs: Record<string, CategoryPref> }> => request('GET', '/category-prefs'),
    set: (categoryTagId: string, patch: Partial<CategoryPref>): Promise<{ pref: CategoryPref }> =>
      request('PUT', `/category-prefs/${categoryTagId}`, patch),
  },
// export interface CategoryPref { color_token: string; default_minutes: number; }
```

**C2 — `tag-tax.ts` (BLOCKER: category-tag leak).** `directionsFirst` returns `...tags.filter(t => t.kind !== 'pattern')`, so `kind='category'` tags would surface as selectable task/intention chips. Fix to an allow-list and add grouping helpers:
```ts
export function directionsFirst(tags: Tag[]): Tag[] {
  return [...sortDirections(tags.filter((t) => t.kind === 'pattern')), ...tags.filter((t) => t.kind === 'intention')];
}
// + groupByCategory (mirror groupByDirection, group by t.categories.includes(cat.name), Unsorted = categories.length===0)
// + sortCategories (mirror sortDirections, BASE_ORDER = ['family','social','me'])
```
Rule: **a category is never a task/intention chip** — only the Categories tab + the timeblock picker. Add a `tag-tax.test.ts` case asserting a `kind='category'` tag is excluded from `directionsFirst`/`groupByDirection` and included by `groupByCategory`.

**C3 — `Tags.tsx`** — add the `AllTasks.tsx` tab idiom (tabs: Patterns | **Time Block Categories**). Generalize `DirectionCard` with `membersOf?: (t)=>string[]` (default `t=>t.directions`; categories pass `t=>t.categories`); the active tab routes a `'tag-chip'` drop to `tags.update({directions})` vs `{categories}`. Category card also renders the N direction toggles (→ `direction_toggle` PATCH), each ON unless in `direction_optouts`.

**C4 — `CategorySettings.tsx` (NEW) + `Settings.tsx` mount** — clone `RoutineTypeSettings.tsx`: name (rename = tag rename, UNIQUE → handle `409`), color picker (`PATTERN_COLORS`), `default_minutes`; **no icon**. Delete gated by `is_base` AND the server `409` (S2.6) → surface "in use, reassign first". Base 3 first with lock badge.

**C5 — `ElementWizard.tsx` + `element.ts`** — `ElementForm` += `categoryId?`. Timeblock save adds `category_id: form.categoryId || undefined` (someday + scheduled), and does **not** set `tag` (S5 enforces). Replace the Pattern row with a single-select over `tags().filter(t=>t.kind==='category')` (default "None"), prefilled from `category_id` on edit. **Collision guard in `ensureIntentionTags`:** extend the skip-set to `patternNames ∪ categoryNames` so a typed name matching a `kind='category'` tag is never attached to a task's intention axis.

**C6 — `textures.ts` + `Planner.tsx`:**
```ts
export function blockColorVar(block: Block, categoryPrefs?: Record<string, { color_token: string }>): string {
  if (block.color_token) return `var(--${block.color_token})`;              // stamped — immutable
  if (block.category_id && categoryPrefs?.[block.category_id]) return `var(--${categoryPrefs[block.category_id].color_token})`;
  return tagColorVar(block.tag);                                            // legacy tag-Plan
}
```
Block renderers call `blockColorVar(b(), categoryPrefs())`; add a `categoryPrefs` resource in `stores/index.ts` (refetch on `block:*` / a `category_pref:updated` broadcast); the chip shows the category `displayTag` + this color instead of `#{block.tag}`.

### 10.4 Scheduler (`engine/autoplan.ts`) — determinism preserved

**SCH1 — partition + tiebreak:** `dayPlans` WHERE gains `AND tb.category_id IS NULL`, ORDER BY gains `, tb.id`. Add a sibling `dayCategoryPlans(date,tz)` selecting `... AND tb.category_id IS NOT NULL ... ORDER BY tb.start_at, tb.id`. Disjointness is guaranteed by the S5 `tag XOR category_id` `422`.

**SCH2 — category-Plan fill loop**, inserted between `const placedInPlans = placedIds.size;` and Pass 2a. **Reuse the Pass-2a `dirNameToId` prefetch idiom** (hoist one `name→pattern-id` map above both passes — no per-task SQL):
```ts
const patNameToId = new Map<string,string>();
for (const pt of sqlite.prepare(`SELECT id, name FROM tags WHERE kind='pattern'`).all() as {id:string;name:string}[]) patNameToId.set(pt.name, pt.id);

for (const plan of dayCategoryPlans(date, tz)) {
  const candIds = new Set((sqlite.prepare(
    `SELECT DISTINCT entity_id FROM entity_tags WHERE entity_kind='task' AND level>1
       AND tag_id IN (SELECT intention_tag_id FROM tag_categories WHERE category_tag_id=?)`).all(plan.category_id) as {entity_id:string}[]).map(r=>r.entity_id));
  if (candIds.size === 0) continue;
  const optOut = new Set((sqlite.prepare(`SELECT pattern_tag_id FROM category_direction_optouts WHERE category_tag_id=?`).all(plan.category_id) as {pattern_tag_id:string}[]).map(r=>r.pattern_tag_id));
  const dirIdsOf = (t) => t.tags.map((n)=>patNameToId.get(n)).filter((id)=>id!==undefined);
  const filtered = staged.filter((t) => {
    if (placedIds.has(t.task_id) || !candIds.has(t.task_id)) return false;
    const dirs = dirIdsOf(t); return dirs.length === 0 || !dirs.every((d)=>optOut.has(d));   // include unless EVERY direction opted out
  });
  if (filtered.length === 0) continue;
  const r = placeIntoWindow(filtered, Date.parse(plan.start_at), Date.parse(plan.end_at), prefs, { parentBlockId: plan.id, runId });
  r.placedTaskIds.forEach((id)=>placedIds.add(id)); blocksCreated += r.blocksCreated;
}
```
Determinism: Set-intersection over `staged` order, id-keyed, no clock/randomness. **`category_prefs.default_minutes` is NOT consumed here** — `placeIntoWindow` has no per-window duration arg; session size comes from each task's estimate. (See Q2.)

**SCH3 — VERIFIED, no code:** `dayObstacles(includePlans=1)` already treats every scheduled `timeblock` as an obstacle (supersession is emergent for category-Plans too); `fillByPriority` excludes `placedIds`; `clearPriorAuto` deletes only `block_kind='task' AND source_kind='agent'` children (manual `is_auto=0` container survives); reflow + ingest both run through `placeFlightPlan`.

**SCH4 — legacy "Auto into this Plan" (`placeFlightPlan(blockId)`):** for a category-only block (`tag` NULL) the existing path falls through to placing **all** staged tasks. Branch on `block.category_id` and reuse the SCH2 candidate + opt-out filter.

**SCH5 — tests** (under `TZ=UTC`): byte-identical replay; partition invariant (both-set → `422`); secondary-only matching (level>1); opt-out exclusion; direction-less inclusion; multi-category `(start_at,id)` tie-break; `tag_categories` insert-order shuffle → identical; `placeFlightPlan(blockId)` on a category block places only members; reflow + ingest parity.

### 10.5 Cross-cutting
- **CC1 — backup container coverage (R3):** add `category_prefs` to `OWNER_TABLES`; export `tag_categories` + `category_direction_optouts` globally beside `tag_patterns`; **and fix the pre-existing container-export bug** (export/delete/import `block_kind='timeblock'` containers, not just `task_id`-scoped rows) or category-Plans don't survive a round-trip. (See Q5.)
- **CC2 — `EXPORT_VERSION`:** keep `'1'` (additive superset; `g(key)` defaults missing keys to `[]`) rather than bumping to `'2'` (rejects all existing exports). (See Q3.)
- **CC3 — audit/SSE VERIFIED:** tag CRUD already `writeAudit`; block mutations already `broadcast('block:*')`. Only new audit entity is `category-prefs:${id}` (S4).

---

## 11. Decisions (post-gap-review) — ALL RESOLVED

**Status (2026-06-25): all 8 closed — plan is implementation-ready.** Q1/Q3/Q7/Q8 adopted as the recommended defaults; Q2/Q4/Q5/Q6 confirmed by the user (all the recommended option). The §10 code already reflects every choice.

---

## 12. Parallelization / fan-out plan

**Verdict: yes — but only as `1 serial FOUNDATION wave → 4 file-disjoint parallel lanes`.** The 5 phases are NOT independently parallelizable as-is because they share hub files; the fix is to pull every shared/contended surface into a foundation wave first, after which the four feature slices touch *disjoint* files and can run concurrently in separate worktrees.

### 12.1 Why a foundation wave is mandatory (the three hard serializers)
1. **Migration number.** Exactly one branch may own `0069`. Two parallel branches each adding a migration both grab `0069` → guaranteed conflict. Foundation owns the only migration.
2. **Drizzle schema types.** `tagCategories`, `categoryPrefs`, `categoryDirectionOptouts`, and `timeBlocks.categoryId/colorToken` are imported across server code — **nothing in lanes A–D type-checks** until `schema.ts` has them.
3. **Shared hub files.** `api.ts`, `stores/index.ts`, `services/category-prefs.ts`, `routes/index.ts`, `backup.ts` are each needed by 2–3 phases. Editing them in parallel = conflicts. Freeze them in the foundation.

### 12.2 Wave 0 — FOUNDATION (serial, one branch/PR). Settles every shared surface:
- **Data:** `0069_category_tags.ts` + `schema.ts` defs + `migrations/index.ts` (Phase 1) + GLOSSARY/README.
- **Shared server infra:** the *entire* category-prefs stack — `services/category-prefs.ts` (get/set) **and** `routes/category-prefs.ts` + its mount in `routes/index.ts`. (Pure infra over the new table; no feature logic. Putting the route here decouples lane C's wizard prefill from lane B at runtime.)
- **Client contracts:** `api.ts` — ALL additions at once: `Tag.categories`/`direction_optouts`, `Block.category_id`/`color_token`, `api.categoryPrefs` + `CategoryPref`. Plus the `categoryPrefs` resource in `stores/index.ts`.
- **Backup:** `backup.ts` CC1 (container coverage + the 3 new tables) — data-layer, belongs with the foundation.

After Wave 0 merges, **every file two phases would have fought over is frozen.**

### 12.3 Wave 1 — PARALLEL (4 worktrees, after Wave 0 merges). Provably file-disjoint:
| Lane | Slice | Files (no overlap with other lanes) | Runtime deps |
|---|---|---|---|
| **A** | Tags tab | server `services/tags.ts`, `routes/tags.ts`; client `tag-tax.ts`, `Tags.tsx` | Wave 0 |
| **B** | Settings catalog UI | client `CategorySettings.tsx` (new), `Settings.tsx` | Wave 0 (category-prefs route + api) |
| **C** | Time-block field + color | server `routes/blocks.ts`; client `ElementWizard.tsx`, `element.ts`, `Planner.tsx`, `textures.ts` | Wave 0 (`getCategoryPrefs`, `api.categoryPrefs`, `blockColorVar` store) |
| **D** | Scheduler | server `engine/autoplan.ts`, `blocks-recur.ts` + tests | Wave 0 (schema only) |

No two lanes share a file → **merge order among A–D is irrelevant**, and each lane is independently CI-green (compiles against Wave 0's contracts; ships its own tests — D inserts category rows directly in tests, so it's green even before C exists to create them via UI).

### 12.4 Residual risks & mitigations
- **`routes/index.ts`** touched only by Wave 0 (the mount) — single owner, no contention.
- **Half-feature on main:** each PR is green alone, but the feature only fully works once all merge. Acceptable — no PR breaks `main`; visible-to-user surfaces (A/B/C) can merge last if you want it dark until complete.
- **Determinism (D)** is the riskiest *logic*, but it's file-isolated; its adversarial test suite (SCH5) gates it on its own.
- **Shared sequential test DB** (harness gotcha): run each lane's `pnpm test` inside its own worktree; CI serializes — no cross-lane DB bleed.

### 12.5 Critical path
`Wave 0` → `max(A, B, C, D)`. Wall-clock ≈ foundation + the longest single lane (D, the scheduler), instead of the sum of all five phases.

1. **Primary-direction rule for the opt-out filter (SCH2/§9d).** A task may carry several level-1 tags. → **All level-1 tags resolving to a `kind='pattern'` tag count as its directions; exclude the task only if EVERY such direction is opted out; zero pattern tags ⇒ include.** (Adopted in SCH2; no per-task query.)
2. **Should `category_prefs.default_minutes` drive the wizard's default block length?** It's dead-weight in the scheduler. → **Yes — wizard is the sole consumer; prefill new-block length from the picked category (fallback 60). Else drop the column.**
3. **Backup `EXPORT_VERSION`.** → **Keep `'1'`** (additive).
4. **Legacy "Auto into this Plan" on a category-only block — branch (SCH4) or disable?** → **Branch** (reuse the category filter; never fall through to "all staged").
5. **Pre-existing container-backup bug (CC1) — fix in this PR or defer?** → **Fix now** (small; category-Plans are useless across restore until fixed) + round-trip regression test.
6. **Deleted-category lifecycle — block delete while referenced, or allow an inert orphan?** → **Block delete (409 via `categoryIsReferenced`)**; mirrors `tagIsUsed`. (Alternative: allow orphan — block keeps frozen color, becomes an inert span-reserving container.)
7. **Direction-toggle PATCH — single or batched?** → **Single toggle per request** (one PATCH per click).
8. **Base-seed collision policy** (only a *user-created* `family`/`social`/`me` can collide). → **Fail loudly** ("rename before migrating") rather than promote (which mangles user data).
