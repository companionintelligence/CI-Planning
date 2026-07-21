# Handoff — 2026-07-20 · Categories⇄Balance feature + UI-comment backlog

> ## ✅ CLOSED OUT (2026-07-21)
>
> Everything below is **delivered**; this doc is kept as the historical plan. Where the
> plan and the shipped code disagree, the code wins. Delivery map:
>
> - **Independent UI backlog 1–2 + backlog-3 part 1** (Jobs Run-all · Schedule Day fix —
>   which was a *misleading-success* bug, not an unwired button; the repoint also fixed
>   `POST /api/auto/fill` ignoring `body.date` · Focus FAB · Plan-my-week → Calendar):
>   **#413** (merged).
> - **Phase B (capture)** — migration `0135_categories_capture` (category backfill +
>   per-element `texture_enabled`/`texture_color_token` on tasks AND time_blocks),
>   `entity_categories` write/read wiring (blocks DERIVE own → task's live categories),
>   1–3 picker on both wizard tabs, quick-add category classifier: **#414** (merged).
> - **Phase C (renderer)** — `elementTextureStyle` (opt-out → override → even category
>   stripes in position order → legacy motif), opacity 0.06→0.03, un-gated to all
>   tasks/blocks; TaskCards show categories instead of intention secondary tags:
>   **#415** → delivered to main via **#417** (a stacked-merge catch-up: #414 had merged
>   an earlier branch snapshot).
> - **Phase D (polish)** — Balance Focus-Area "N open" → related-tasks modal (pure
>   client-side join), functional Calendar category overlay (the old category row was
>   inert) + palette toggle + intention-row retirement, Tags per-chip Category selects:
>   **#416** → main via **#417**.
> - **Backlog 3 leftovers** (Today-style Focus header card, day-scoped + restyled
>   reminder picker): **#418**. `feat/tasks-search` rebased → **#419**.
> - Migration head is now **`0135`**; next free slot **`0136`**.

> Read this first. State of the world at the end of the 2026-07-20 session. Do **not**
> continue building the Categories feature past Phase A without reading the "Decisions"
> box — the owner locked several choices.

## TL;DR

- A long screenshot-driven session shipped a run of fixes/features (PRs #405–#411) and
  opened a **4-phase "Categories ⇄ Balance + textures"** feature — **Phase A (model) is
  up as PR #411**; B/C/D are planned, not built.
- The owner then handed a **third batch of UI comments** (this doc's "New UI backlog").
  Some fold into the Categories phases; the rest are independent (Jobs, Calendar bug,
  Focus view, Balance modal).
- **Migration head after #411 = `0134_categories_balance`.** Next free slot **`0135`**.

## Open PRs / branches (this session)

| PR / branch | State | What |
|---|---|---|
| **#411** `feat/categories-balance-model` | OPEN | Categories⇄Balance **Phase A** (migration 0134, entity_categories, seed 6 = Balance dims, flag off) |
| **#410** `feat/auto-defer-sweep` | OPEN | unified auto-defer + `/api/review/sweep` + top-bar sweep button + hands_off auto-place + richer quick-add enrichment + P1/slot preview + similar-task guard + NL-on-timeblock |
| `feat/tasks-search` | pushed, **no PR** | always-visible Tasks search bar (title+tag, client-side) |
| `docs/ui-comments-round2` | pushed, **no PR** | round-2 Today/Planner UI stubs (items 6–11) |
| `docs/handoff-2026-07-20-categories-ui` | this doc | — |
| #405–#409 | MERGED | extend-block focus/habit · ErrorBoundary · T13 connections · T14 voice · missed-review surface |

---

## Feature: Categories ⇄ Balance + per-element striped textures (4 phases)

### Decisions (LOCKED by owner)
- **Unify** Categories with Balance's six Core Dimensions
  (`health/career/relationships/growth/leisure/finance`). Seed categories from those;
  **remove** the old block categories (personal/professional/social + family + custom).
- **Add/remove of categories is behind a feature flag that ships OFF**
  (`client/src/lib/flags.ts` `CATEGORIES_EDITABLE=false`). The six are fixed this
  delivery; rename/recolour stays allowed.
- Categories are a **1–3 multi-select** tag axis (like `direction`) on **tasks AND blocks**.
- Multi-category texture = **even stripes in category order** (`entity_categories.position`).
- Textures become **optional per element** (edit menu, tasks+blocks), **2px** line
  spacing (denser), opacity **−50%** (0.06→0.03), **user-settable colour**, default from
  the element's categories.
- **Reuse over new** (owner asked): there IS an existing category-tag mechanism —
  `kind='category'` axis + `tag_categories` (intention→category grouping) + category
  `tag_prefs` (migration 0069). Phase A **reused it**; the only new storage is
  `entity_categories` (per-entity 1–3), which the single `time_blocks.category_id` column
  couldn't express.

### Phase A — MODEL — ✅ DONE (PR #411)
Migration `0134`: purge old category tags (+ prefs/memberships/opt-outs; null block
`category_id`), seed the six is_base categories (hue-matched to Balance via nearest
`--tag-N`: health→tag-1 career→tag-7 relationships→tag-11 growth→tag-9 leisure→tag-5
finance→tag-2), add `entity_categories(entity_kind, entity_id, category_tag_id,
position)`. `services/tags.ts`: `setEntityCategories`/`entityCategoryNames`/
`categoryIdsForOwner`. `owners.ts` provisioning + `CATEGORY_BASE_ORDER` updated. Flag +
`CategorySettings` gating. Tests green (server 2120/3skip).
⚠️ **Migration is destructive** (removes existing category data) and runs on next boot.

### Phase B — CAPTURE (edit menu + NL) — TODO
- Replace the single block-only Category dropdown (`ElementWizard.tsx` ~L131 `categoryId`,
  ~L989 timeblock-gated) with a **1–3 Category picker on BOTH Task and Time-Block tabs**.
- Wire `entity_categories` through `saveElement` (`lib/element.ts`) + `services/blocks.ts`
  + `services/tasks.ts` (write on create/update for both kinds). Keep `time_blocks.
  category_id` writing for back-compat OR retire it (decide).
- **"Describe it" best-guess categories (1–3):** extend `enrichQuick`/`quickVocab`
  (`agents/quickadd.ts`, `routes/tasks.ts`) — it already classifies direction+secondary
  this session; add a constrained category classifier + a `quickParse` field.

### Phase C — RENDERER (the textures) — TODO
- Rework `lib/textures.ts`: **2px** line spacing, opacity **−50%**, and COLOUR from
  element override → categories (**even stripes** via a `repeating-linear-gradient` of the
  category `color_token`s in `position` order when >1) → fallback.
- **Render on ALL element types** (today gated routine-only: `Planner.tsx` ~L541 `pat()`,
  `TaskCard.tsx` ~L421 `isRoutineTask`).
- **Per-element on/off + colour override** needs storage — add it in Phase B (a column or
  entity flag on task/time_block, or a small `entity_texture` row).
- Texture colour today is `currentColor` @6% (tag only seeds geometry); no per-element
  colour path exists yet.
- ⚠️ `PatternBlockOverlay.tsx` is the SEPARATE direction-window hatch (10%/8px). The
  round-2 stub **item 6 ("remove the window hatch") is SUPERSEDED** by this feature
  (keep + enhance textures instead of removing).

### Phase D — BALANCE polish — TODO
- `Balance.tsx` already reads `life_priorities` by the same six keys → unified by NAME.
  Align its Tailwind swatch colours with the category `color_token`s; later surface
  per-category time-tracking.

### Folded-in comments (2026-07-20 batch 3 → into the phases above)
- **TaskCard:** show the element's **Categories instead of the secondary (intention)
  tags** on task cards. [screenshot: intentions struck through]
- **Tags view:** add a **Category select on the Directions tab** AND on the **Time-Block
  Categories tab** (the drag-to-refile cards). *(The owner's screenshots still show
  SOCIAL/PERSONAL/PROFESSIONAL — pre-migration; they haven't run 0134 yet.)*
- **Calendar overlays:** show **Categories instead of the huge INTENTION list**, plus a
  **toggle (colour icon)** switching the brand teal-monochrome style ↔ the colourful
  per-tag style used on Today (more descriptive).
- **Balance Focus Areas:** each Focus-Area card gets a **button → popup modal listing the
  related OPEN TASKS** for that dimension/category. [screenshot 2]

### "Hide secondary tags" — advice (owner asked before doing)
Secondary tags = **intentions** (`kind='intention'`, `entity_tags` level>1). If HIDDEN
(not deleted): the data + the `tag_directions`/`tag_categories` grouping + auto-tag output
all **survive**; intentions just disappear from task cards, the Calendar INTENTION overlay
list, and the tag filter — and **Categories become the visible secondary axis** (matches
"show categories instead of secondary"). Only a later **DELETE** would leave the intention
grouping / filter / auto-tag surfaces purposeless. **Recommendation: hide, don't delete.**

---

## New UI backlog (independent of Categories — 2026-07-20 batch 3)

Fresh screenshot comments not tied to the Categories feature:

1. **Jobs view — "Run all" button.** Add a Run-all control in the Jobs header (runs every
   runnable job kind; the run-now surface already exists per job — `routes/jobs.ts`
   `RUN_NOW_KINDS`). Single-tenant scope note applies.
2. **Calendar (Day view) — "Schedule Day" button does nothing (BUG).** The `Schedule Day`
   button in the Day/Week/Month calendar header is a no-op. Needs repro + wire-up (likely
   to the auto/schedule path for the viewed day).
3. **Focus view — reshape to match Today.**
   - Add the **same header container as the Today view**, with all the same button options.
   - Add the **FAB** (+ Add) button.
   - **Move "Plan my week"** out of Focus → to the **Calendar view**.
   - **"Add reminder":** only offer the **day's tasks** as reminder targets; **style the
     popup better**.
4. **Calendar overlays toggle** (also listed under Categories/Phase-C folded comments):
   brand-colour vs. colourful per-tag style toggle.

---

## Repo facts worth carrying
- **Migration head `0134`; next slot `0135`.** 0134 is destructive (category data).
- **`CATEGORIES_EDITABLE=false`** (`client/src/lib/flags.ts`) — flip + rebuild to enable
  category add/remove once Balance-dimension editing is designed.
- **`entity_categories`** is the new per-entity 1–3 store; `time_blocks.category_id` stays
  for back-compat reads until Phase B decides to retire it.
- **Dev-box Ollama:** the owner's Settings→Models now points at `llama3.2:latest`
  (fast) / `llama3.1:latest` (quality) — the defaults (`qwen2.5:0.5b`/`gemma3n:e4b`)
  aren't installed, and installed `qwen3.5:*` return empty under `format:json`. When "AI
  does nothing", diff `resolveModel` output vs `GET :11434/api/tags`.
- **CLIENT typecheck can pass locally on a stale `tsconfig.tsbuildinfo`** while CI (clean
  checkout) fails — `rm client/tsconfig.tsbuildinfo` before trusting a green local run.
- **Screenshots in this batch predate migration 0134** (they show the old categories /
  no categories) — the owner hasn't restarted their stack to migrate their dev DB.
