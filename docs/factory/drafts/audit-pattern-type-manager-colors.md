> **Type:** Frontend + Backend · **Phase:** Audit follow-up (2026-07-19) · **Branch:** `feat/pattern-type-manager-colors` · **Commit style:** `feat(patterns): type manager + per-item colors for routines, habits, objectives` · **Design:** owner rulings 2026-07-19 — per-ITEM colors; the objective's chosen color is its identity everywhere (Planner accent included) · **Dependencies:** soft — the "accent prefers the stored token" DoD item assumes `feat/planner-objective-accent` (spike #361 follow-up) has merged; if not, that one item moves to whichever lands second.

## Goal

Two owner-requested capabilities in one cohesive color thread:

1. **Pattern-type manager** — the backend CRUD for pattern types (`POST/PATCH/DELETE
   /api/pattern-types`, with builtin protection and in-use conflict handling) is fully built and
   has **zero** UI callers, so users are stuck with the three seeded types forever. Add a
   feature-local "Manage types" UI on the Routines panel (deliberately NOT re-adding the Settings
   section removed in PR #331).
2. **Per-item colors** — let the user pick a color for **each individual** routine, habit
   (both = `patterns` rows), and objective, shown in the Tasks view and — for objectives —
   driving the Planner accent. Today color exists only per-TYPE (`pattern_types.color_token`,
   mig 0017) and not at all on objectives.

## Non-goals

- **Do not re-add a Settings "Routine Types" section** (removed deliberately in PR #331); the
  manager lives on the Routines panel.
- **No changes to tag/direction/category colors** (`tag_prefs.color_token` and its pickers stay
  untouched).
- **No hex input** — colors are CI-Hub tokens from the existing `PATTERN_COLORS` palette only.
- **No block-level color changes** (`time_blocks.color_token` handling is untouched).
- Do not migrate `pattern_types.color_token` — per-type color stays as the fallback layer.

## Pinned conventions

**The color-resolution rule (applies at every display site):** `item.color_token ??
type.color_token ?? 'primary'` — the same saved-value-wins-else-fallback idiom
`directionColorForTask` already uses (`client/src/lib/pattern-meta.ts:92-94`). For objectives:
`objective.color_token ?? hash-derived` (the accent's existing fallback).

**Schema / migration:**
- Next free slot: **`0133`** (confirmed; 0132 is the head — re-verify with
  `ls server/src/db/migrations/` before writing).
- Template: `0132_owner_onboarded.ts` (the canonical single-column additive shape) + the
  `0129_objective_archive.ts` idiom for objectives: local `hasColumn(db, table, col)` PRAGMA
  guard (SQLite has no `ADD COLUMN IF NOT EXISTS`), **nullable TEXT, NO DEFAULT** (0129's header
  comment documents why: non-constant defaults are forbidden on ADD COLUMN; NOT NULL would force
  a rebuild).
- Register in `migrations/index.ts`: `import * as m0133 from './0133_item_colors.js'` (note the
  `.js` extension) + append to `MIGRATIONS`.

**Server — patterns (`services/patterns.ts`):**
- `PatternRow` (:36-46) has **no color_token — confirmed absent**; add it. Thread through
  `CreatePatternInput`/`UpdatePatternInput` (:247-257), the INSERT (:287), the UPDATE (:329),
  and `serializePattern` (:86-102). The PATCH route (`routes/patterns.ts:100-112`) casts the
  body to the input type — no route change.
- Pattern-type CRUD needs **no server change**: `TypeInput` already carries `color_token` +
  `icon_shape` (:155-163); the error contract is `missing_fields`→422, `builtin`→400
  ('built-in types cannot be deleted'), `in_use`→409 ('type is in use by patterns')
  (`routes/patterns.ts:34-66`).

**Server — objectives (`services/objectives.ts`):**
- Add `color_token` to `CreateObjectiveInput` (:410-420) + `createObjective`'s INSERT (:544-555)
  + its `stampRow` list (:557); to the update `patch` object (:585-596, the
  `'field' in body ? body.field ?? null : existing.field` idiom), the UPDATE column list
  (:598-608), and `patchToCamel` (:613-617).
- **Sync:** add `color_token` to `OBJECTIVE_FIELDS` (`sync/apply.ts:48-52` — mergeable cosmetic
  field, LWW is fine) AND `colorToken: 'color_token'` to `OBJECTIVE_CAMEL_TO_SNAKE` (:223-232)
  so online PATCHes stamp it. (A field missing from the allowlist is silently dropped on sync —
  :170-171 — which would un-sync the color across devices.) Patterns are not sync entities — no
  equivalent needed.
- Client `Objective` (:1169-1203), `ObjectiveInput` (:1284-1294), and `ObjectiveRecord` mirror
  the new field.

**Client — palette + picker:**
- Token list: `PATTERN_COLORS` (`pattern-meta.ts:39` — CORE + the 12 `tag-N` hues); CSS bridge
  `colorVar(token)` (:69-71). Tokens are CI-Hub keys, never hex.
- **The swatch-grid picker to clone: `PatternBlockSettings.tsx:121-140`** (`<For
  each={PATTERN_COLORS}>`, `w-5 h-5 rounded-full border-2`, selected =
  `border-foreground scale-110`). There is no `Tags.tsx` — this is the canonical picker.

**Client — display sites for the resolution rule:**
- `RoutinesPanel.tsx:472` — `PatternList` passes `color={colorVar(ty()?.color_token)}` to
  `PatternCard`; becomes item-first.
- `TaskCard.tsx:460` (routine texture tint) and `:542` (routine label icon) — both currently
  `colorVar(r().type?.color_token)`; becomes item-first.
- `AllTasks.tsx:145` (`RoutineGroup.colorToken`) + `:462` (group header tint) — item-first.
- `ObjectivesPanel.tsx:450-453` — `LevelIcon` is status-colored today; when
  `objective.color_token` is set, tint the icon with it (status still drives muted-vs-bright).
- **Planner accent** (dependency-gated): `lib/objective-accent.ts`'s single `accentColor()`
  seam (required by the accent ticket's addendum) prefers `colorVar(objective.color_token)`
  over the hash.

**Client — manager + picker anchors:**
- "Manage types" affordance: the Routines panel `Section` header cluster
  (`RoutinesPanel.tsx:427-441`, where the type icon already renders tinted per-type).
- Per-item picker for routines/habits: `PatternCard` header row (:222-247), expandable like
  PatternBlockSettings' edit row; save via the existing `api.patterns.update(p.id, {...})` path
  (:102/:108) + `color_token`.
- Per-objective picker: `ObjectiveModal.tsx` — a "Color" label block in the form fields
  (:129-198), included in the `save()` body (:94-102). Signals idiom:
  `createSignal(props.objective?.color_token ?? null)`.
- Type manager edits per-TYPE color/shape/name via `api.patternTypes.update` — these methods
  (`api.ts:213-220`) gain their first callers; surface the 400/409 errors via `showToast`.

**Backup:** no change — `patterns`, `pattern_types`, `objectives` are all OWNER_TABLES exported
via `SELECT *` (`backup.ts:196-198`) and import column-intersects (`:133`); the new columns are
nullable so **no EXPORT_VERSION bump** (policy comment `backup.ts:9-11`).

## Before implementation

1. Re-verify slot 0133 is still free; read `0132_owner_onboarded.ts` + `0129_objective_archive.ts`.
2. `services/patterns.ts:24-46, 86-102, 155-163, 180-244, 247-347` and `routes/patterns.ts:34-112`.
3. `services/objectives.ts:410-420, 544-623` + `sync/apply.ts:28-56, 170-171, 219-232`.
4. `pattern-meta.ts` in full; `PatternBlockSettings.tsx:71-165` (the picker to clone).
5. `RoutinesPanel.tsx:184-247, 419-500`; `TaskCard.tsx:395-466, 539-548`; `AllTasks.tsx:137-151,
   460-465`; `ObjectivesPanel.tsx:449-457`; `ObjectiveModal.tsx:63-102, 129-198`.
6. If the accent ticket has merged: `lib/objective-accent.ts` — the `accentColor()` seam.

## Files impacted

**New:**
- `server/src/db/migrations/0133_item_colors.ts` — `patterns.color_token` +
  `objectives.color_token`, both nullable TEXT, hasColumn-guarded.
- `client/src/components/PatternTypeManager.tsx` — the manage-types popover/modal (list, create,
  rename, per-type color+shape, delete with 400/409 surfacing).
- `client/src/components/PatternTypeManager.test.tsx`, `client/src/components/ItemColorPicker.tsx`
  (the shared swatch-grid, extracted from the PatternBlockSettings idiom) + its test.

**Changed:**
- `server/src/db/migrations/index.ts` — register m0133.
- `server/src/services/patterns.ts`, `server/src/services/objectives.ts`,
  `server/src/sync/apply.ts` — the field threading above.
- `client/src/lib/api.ts` — `Pattern`/`Objective`/`ObjectiveInput`/`ObjectiveRecord` +
  pattern-input types gain `color_token`.
- `client/src/components/RoutinesPanel.tsx` — Manage-types affordance + PatternCard picker +
  item-first color resolution.
- `client/src/components/TaskCard.tsx`, `client/src/views/AllTasks.tsx`,
  `client/src/components/ObjectivesPanel.tsx`, `client/src/components/ObjectiveModal.tsx` —
  resolution rule + objective picker.
- (Dependency-gated) `client/src/lib/objective-accent.ts` — token-first accent.

## Schema required

```sql
-- 0133_item_colors.ts (both guarded by hasColumn):
ALTER TABLE patterns   ADD COLUMN color_token TEXT;  -- nullable, no default; CI-Hub token key
ALTER TABLE objectives ADD COLUMN color_token TEXT;  -- nullable, no default; CI-Hub token key
```
No indexes (never queried by color), no UNIQUE, no FK. NULL = inherit (type color / hash).

## Definition of Done

- [ ] Migration 0133 applies idempotently (double-run safe) and registers in index.ts.
- [ ] PATCH `/api/patterns/:id` and PATCH `/api/objectives/:id` persist + return `color_token`;
      explicit `null` clears it (inherit).
- [ ] A synced objective op carrying `color_token` merges (allowlist) and an online PATCH stamps
      it (camel map).
- [ ] Routines panel: every PatternCard offers the swatch picker; the card + Section list render
      item-first color; the Section header offers Manage types.
- [ ] Manage types: create (name + shape + color), rename, recolor, delete — builtin delete
      shows the server's 400 message; in-use delete shows the 409 message; list updates live on
      the existing `pattern_type:*` broadcasts.
- [ ] TaskCard (texture + routine label) and AllTasks group headers render item-first color.
- [ ] ObjectiveModal offers the picker; ObjectivesPanel tints the level icon with a set color.
- [ ] If the accent ticket is merged: the Planner accent uses `colorVar(objective.color_token)`
      when set, hash otherwise — one function changed, tests updated.
- [ ] Backup round-trip carries both new columns (no code change — covered by an added test
      assertion, not new plumbing).

## Tests

Server (`server/test/patterns.test.ts` extensions + `server/test/objectives-*.test.ts` or a new
`item-colors.test.ts`):

- [ ] Pattern create/update round-trips `color_token`; `null` clears; serialize includes it.
- [ ] Objective create/update round-trips `color_token`; sync `applyOp` with the field merges it;
      a non-allowlisted control field still drops (regression guard).
- [ ] Migration idempotency (run 0133 twice — the standard migration test covers registration).
- [ ] Export → wipe → import preserves both columns (extend the v9 round-trip test's seeds).

Client:

- [ ] `ItemColorPicker` renders `PATTERN_COLORS`, marks selection, emits token / null.
- [ ] `PatternTypeManager`: create/rename/delete flows; 400 and 409 surfaced via toast.
- [ ] Resolution unit test: item token beats type token beats primary (a pure helper —
      extract `resolveItemColor(item, type)` rather than inlining the ?? chain four times).

Suites to keep green:

```bash
pnpm --filter server typecheck && pnpm --filter server test
pnpm --filter client exec tsc --noEmit && pnpm --filter client test && pnpm --filter client build
```

## Acceptance Criteria

- [ ] A user can create a fourth pattern type, and pick a distinct color for any individual
      routine, habit, or objective.
- [ ] That color is the item's identity in the Tasks view (cards, group headers, objectives
      panel) — and, once both tickets are in, on the Planner accent.
- [ ] Unset items look exactly as they do today (type color / hash fallback — zero visual
      regression for existing data).

## Subtasks

1. [ ] Migration 0133 + registration; server field threading (patterns, objectives, sync maps).
2. [ ] Server tests (round-trips, sync merge, backup assertion).
3. [ ] `ItemColorPicker` + resolution helper + unit tests.
4. [ ] Routines panel: PatternCard picker + item-first rendering + Manage-types UI + tests.
5. [ ] TaskCard/AllTasks/ObjectivesPanel/ObjectiveModal wiring.
6. [ ] (If accent merged) accent token-preference + test; run all five verification commands.
