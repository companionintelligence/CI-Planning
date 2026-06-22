# Settings correction — direction-scoped Work Hours, Basics, per-direction leftover-fill

**Status:** Plan (authored 2026-06-21). Implementation pending review.
**Branch:** `claude/settings-direction-prefs`
**Migration:** `0038_direction_prefs`
**Baseline to hold green:** server **283** / client **118**, `tsc` clean (Node 26.3.0).
**GLOSSARY impact:** none — no new noun (see [Noun budget](#noun-budget)).

---

## 1. Why

The Settings menu and the auto-placement engine were built up across the
consolidation pass + cockpit-v2 + the tag-direction taxonomy (#82) + Pattern-blocks
(noun 8, mig `0037`). Three things are now out of alignment:

1. **"Work Hours" is still a single global window.** But scheduling is now
   *direction-scoped*: each direction tag (Home / Work / Community + user-added)
   already owns its own availability windows via **Pattern-blocks** (`pattern_blocks`,
   mig `0037`). The lone `workday_start`/`workday_end` pair in the "Work Hours" card
   is a vestige — the real hours live per-direction.

2. **Timezone is global-only.** A user whose Work direction is in one zone and Home
   in another can't express that. The ask: a base timezone that **all three
   directions inherit by default**, with an **unlock to override one**.

3. **"Fill the workday with leftovers" is one global toggle** (`auto_fill_workday`).
   It gates *all* leftover-filling at once. The ask: make it **per-direction**, so
   Home tasks can fill Home windows exactly the way Work tasks fill Work windows —
   each direction independently switchable.

### The fix in one line

Demote the global Work-Hours window; rename the card to **"Basics"** holding the
timezone(s); move leftover-fill into the **Schedule Patterns** card as a
**per-direction** toggle; wire both new per-direction facets (timezone override +
fill toggle) through a small `direction_prefs` sidecar and into the engine's Pass 2.

### Decisions locked (this session)

| # | Decision |
|---|----------|
| D1 | **Demote** the global Work-Hours window. Remove the Start/End inputs from Settings. Keep the `workday_start`/`workday_end` columns in the DB purely as the **untagged-task fallback** + any server-side grid bound. |
| D2 | Per-direction **timezone + fill** apply to **all** directions (base Home/Work/Community always shown; user-added directions included), mirroring the existing windows UI. |
| D3 | Deliverable is **plan-first**: this doc lands on a branch + PR for review; implementation follows on the same branch once approved. |

---

## 2. Current state (as built)

### Settings.tsx card order
1. **Work Hours** — `workday_start`/`workday_end`, **`auto_fill_workday`** toggle
   ("Fill the workday with leftovers"), `recall_keeps_pattern` toggle, single
   `timezone` select. — [`client/src/views/Settings.tsx:232`](client/src/views/Settings.tsx)
2. **Schedule Patterns** — per-direction windows; workday/weekend tabs; iterates
   `tags().filter(kind==='direction')`; ranges via the Pattern-blocks API. — [`Settings.tsx:263`](client/src/views/Settings.tsx)
3. Time-Block Settings (Plan | Concept) · 4. Concept Tags · 5. **Pattern Settings**
   (`pattern_types` — Habit/Routine/Ritual shapes; **unrelated**, do not touch) ·
   6. Models · 7. Companion Memory · 8. Integrations.

### Data
- `scheduling_prefs` (one row/owner): `timezone`, `workday_start`, `workday_end`,
  `auto_fill_workday` (bool, default true), plus focus/break/horizon knobs. —
  [`schema.ts:131`](server/src/db/schema.ts)
- `pattern_blocks` (mig `0037`): `(id, owner_id, direction_tag_id, day_type,
  start_time, end_time)` — N ranges per `(owner, direction, day_type)`. —
  [`schema.ts:202`](server/src/db/schema.ts)
- `tags` carry `kind` (`direction`|`intention`), `is_base`; Home/Work/Community are
  `kind='direction', is_base=1`, seeded by mig `0036`.

### Engine — `placeFlightPlan` Pass 2 ([`autoplan.ts:284`](server/src/engine/autoplan.ts))
```
if (auto_fill_workday == 1) {            // ← single global gate over ALL of Pass 2
  if (pattern windows exist) {
    Pass 2a: each direction-tagged task → union of its directions' windows
             (window times converted with the ONE global tz)
    Pass 2b: direction-less tasks → classic workday_start/end window
  } else {
    classic single workday_start/end window
  }
}
```
So "Home fills Home windows" is *already* implemented (Pass 2a) — but it can't be
toggled per direction, and every window is converted in the single global timezone.

### Confirmed blast radius
- `auto_fill_workday` is read in **exactly one** place: [`autoplan.ts:288`](server/src/engine/autoplan.ts).
- `workday_start`/`workday_end` on the **client** appear **only** in the Settings
  inputs being removed — the Planner grid does **not** read them — so removing the
  inputs has no grid impact.
- `resetDb()` ([`server/test/helpers.ts:48`](server/test/helpers.ts)) pins
  `timezone='UTC'`, workday `09:00–18:00`, `auto_fill_workday=1` each `beforeEach`.

---

## 3. Target design

### 3.1 Data model — migration `0038_direction_prefs`

A normalized sidecar keyed by direction tag. **NULL timezone ⇒ inherit base**
(`scheduling_prefs.timezone`); `auto_fill` defaults ON so today's all-on behavior
is preserved.

```sql
CREATE TABLE IF NOT EXISTS direction_prefs (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL REFERENCES owners(id),
  direction_tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  timezone         TEXT,                    -- NULL = inherit scheduling_prefs.timezone
  auto_fill        INTEGER NOT NULL DEFAULT 1,
  UNIQUE(owner_id, direction_tag_id)
);
CREATE INDEX IF NOT EXISTS ix_direction_prefs_owner ON direction_prefs(owner_id);
```

- **Additive + idempotent.** Backfill: for every existing owner × `kind='direction'`
  tag with no row, insert `(timezone=NULL, auto_fill=1)`. Rows are also created
  lazily on first write (PUT) for directions added later, so backfill is a
  convenience, not a correctness requirement.
- **Kept as-is in `scheduling_prefs`:** `timezone` (now the **base/default** zone),
  `workday_start`/`workday_end` (untagged fallback window), `auto_fill_workday`
  (gate for the untagged fallback only — see 3.3).
- Drizzle: add `directionPrefs` table to `schema.ts`; register `0038` in
  `migrations/index.ts`.

> **Why a table, not JSON on `scheduling_prefs`?** Matches the codebase's
> normalized sidecars (`pattern_blocks`, `tag_directions`, `entity_tags`), gives the
> engine a cheap indexed read, and cascades cleanly when a direction tag is deleted.

### 3.2 Server service + route

**`server/src/services/direction-prefs.ts`** (new)
```ts
export interface DirectionPref { timezone: string | null; auto_fill: boolean }
// dirTagId → DirectionPref (only rows that exist; caller applies defaults)
export function getDirectionPrefs(ownerId): Record<string, DirectionPref>
export function setDirectionPref(ownerId, dirTagId, patch: Partial<DirectionPref>): DirectionPref  // upsert
// Effective zone for a direction: override ?? base.
export function effectiveTz(ownerId, dirTagId, baseTz): string
```

**`server/src/routes/direction-prefs.ts`** (new), registered in the route index:
- `GET  /api/direction-prefs` → `{ [dirTagId]: { timezone, auto_fill } }` for all
  the owner's direction tags (defaults folded in: missing row ⇒ `{timezone:null,
  auto_fill:true}`), plus `base_timezone` for the client to show the inherited value.
- `PUT  /api/direction-prefs/:dirTagId` body `{ timezone?: string|null, auto_fill?: boolean }`
  — validate the tag exists and `kind='direction'` (404/422 mirroring
  [`routes/pattern-blocks.ts`](server/src/routes/pattern-blocks.ts)); validate
  `timezone` is a known IANA zone or `null`; upsert; return the row.

### 3.3 Engine — `placeFlightPlan` Pass 2 rewrite

Replace the single outer gate with per-direction gating. **Pass 2a** is no longer
gated by `auto_fill_workday`; each direction self-gates on its `auto_fill` and uses
its **effective timezone** for window conversion. **Pass 2b** (untagged fallback)
keeps the global `auto_fill_workday` gate + base timezone.

```
const dprefs = getDirectionPrefs(owner)                 // dirTagId → {timezone, auto_fill}
const patWindows = getPatternBlocks(owner, dayType)

// Pass 2a — direction-tagged tasks → their directions' windows
for each remaining direction-tagged task t:
  for each direction D of t (that has windows):
    if (dprefs[D]?.auto_fill ?? true) === false: continue   // ← per-direction gate
    tzD = dprefs[D]?.timezone ?? baseTz                      // ← per-direction tz
    for each window range of D (earliest-first):
      placeIntoWindow([t], zonedWallTimeToUTC(date, range.start, tzD),
                            zonedWallTimeToUTC(date, range.end,   tzD), …)

// Pass 2b — direction-less (untagged) tasks → classic workday window
if (auto_fill_workday == 1):
  placeIntoWindow(undirected, workday_start..workday_end @ baseTz, …)

// (no pattern windows configured at all) → classic single window, gated by auto_fill_workday
```

**Behavior-preservation check:** with `direction_prefs` defaulting `auto_fill=1`,
`timezone=NULL` (→ base = UTC in tests) **and** `auto_fill_workday=1`, the output is
byte-identical to today. The one intentional semantic change: when
`auto_fill_workday=0`, direction-tagged tasks **still** fill their windows now
(previously the global zero suppressed everything). This is the requested behavior —
the global flag now governs only untagged tasks. Any test asserting "global off ⇒ no
direction fill" must be re-pointed (see 3.5).

### 3.4 Client

**`api.ts`** — add `directionPrefs.list()` / `.set(dirTagId, {timezone?, auto_fill?})`,
types `DirectionPref` + `DirectionPrefsResponse { base_timezone, prefs }`.
**`stores/index.ts`** — `directionPrefs` resource + `refetchDirectionPrefs`.

**`Settings.tsx`**
- **Rename card "Work Hours" → "Basics".** Remove the Start/End time inputs.
  Keep the existing `timezone` select as the **base timezone**, relabeled
  "Default timezone — directions inherit this unless overridden". Relocate the
  `recall_keeps_pattern` toggle here (it is general, not work-hours-specific) or to
  Pattern Settings — **TBD-minor**, default: keep in Basics.
- **Per-direction timezone (Basics, all directions).** Under the base select, one
  row per direction: label + an **"Same as default" lock**. Locked (default) shows
  the inherited zone, disabled. Unlocking reveals a per-direction `<select>` of IANA
  zones; choosing persists `timezone=<zone>`; re-locking persists `timezone=null`.
  Saves via `PUT /api/direction-prefs/:id` (debounced/on-change, like the windows
  card saves on blur).
- **Schedule Patterns card — per-direction fill toggle.** For each direction, add a
  `Toggle`-style switch **"Fill open windows with leftover {Direction} tasks"** bound
  to that direction's `auto_fill`, persisted via the same PUT. Place it in the
  direction's header row, above its window ranges.
- Remove `workday_start`/`workday_end`/`auto_fill_workday` from `SettingsForm`,
  `DEFAULTS`, the `prefs()` effect, and the save body. (`auto_fill_workday` stays in
  the DB + `Prefs` type for the untagged fallback; it's simply no longer user-facing.
  If we want it user-controllable, surface it as a single "Untagged tasks" toggle at
  the foot of the Patterns card — **optional**, default: omit.)

All styling via the shared CI-Hub semantic tokens + existing `Toggle`/`input`
primitives — no new hex/inline styles (per the global-styles-first rule).

### 3.5 Tests

**Server**
- `direction-prefs.test.ts` (new): GET defaults (missing row ⇒ `auto_fill:true`,
  `timezone:null`); PUT validation (non-direction → 422, unknown tag → 404, bad IANA
  → 422); upsert + persistence; cascade delete with the direction tag.
- `autoplan` / `pattern-blocks.test.ts`: add **per-direction gating** — Home
  `auto_fill=1`, Work `auto_fill=0` ⇒ Home tasks land in Home windows, Work tasks
  do **not**. Add **per-direction timezone** — a Work override shifts that direction's
  window placement vs base. Re-point any "`auto_fill_workday=0` ⇒ nothing fills"
  assertion to the **untagged** path only.
- `migrate.test.ts` / baseline: assert `direction_prefs` exists; the schema-shape
  characterization snapshot gains the table (intentional `-u`).
- `helpers.ts` `resetDb()`: `direction_prefs` is emptied by the existing table wipe;
  no new pin needed (defaults are all-on). Confirm no leak into the Auto suite.

**Client**
- If Settings has render tests, assert the "Basics" heading, absence of Start/End,
  presence of per-direction tz lock + per-direction fill toggle. Otherwise a small
  unit test over any extracted helper (e.g. effective-zone display).

---

## 4. Noun budget

No new GLOSSARY noun. `direction_prefs` is **settings metadata on the existing
Pattern-block / Direction concept** (noun 8 = *Pattern-block*; Direction is a Tag
sub-level), analogous to how `scheduling_prefs` is metadata, not a noun. The
GLOSSARY already states "direction-less tasks fall back to the general
`workday_start`/`workday_end`" — this plan makes the implementation match that
sentence. GLOSSARY edit: extend the Pattern-block row to note each direction also
carries a **timezone** + **fill** preference; no row added.

---

## 5. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Engine regression on the all-on default | Defaults chosen so output is byte-identical when all `auto_fill=1` + base tz; add an explicit "defaults == legacy" test. |
| Auto-suite flakiness (known history) | `direction_prefs` defaults are deterministic + wiped by `resetDb`; do not add non-UTC tz to any shared pin. |
| Removing Start/End inputs breaks a hidden consumer | Verified client grep: only the removed inputs reference them; columns stay in DB for the server fallback. |
| Per-direction tz confuses users | UI defaults every direction to "Same as default" (locked); override is explicit opt-in. |
| Snapshot churn | Only intentional moves: schema-shape gains `direction_prefs`; `/api/direction-prefs` is new (no existing snapshot). Call out the `-u` in the PR. |

---

## 6. Hand-off ticket breakdown

Land as one PR (small, cohesive) or split T1–T3 (server) from T4–T5 (client):

- **T1 — Migration + schema.** `0038_direction_prefs` (DDL + backfill), `schema.ts`
  `directionPrefs`, register in `migrations/index.ts`. Idempotent.
- **T2 — Service + route.** `services/direction-prefs.ts`, `routes/direction-prefs.ts`,
  register route; validation mirrors `pattern-blocks`.
- **T3 — Engine.** Rewrite Pass 2 in `autoplan.ts` for per-direction gate + per-direction
  effective timezone; keep untagged fallback on `auto_fill_workday`.
- **T4 — Client API + store.** `api.ts` methods/types; `stores/index.ts` resource.
- **T5 — Settings UI.** "Basics" rename + remove Start/End; per-direction tz lock;
  per-direction fill toggle in Schedule Patterns; drop dead form fields.
- **T6 — Tests + GLOSSARY note + memory.** Server + client tests; extend the
  Pattern-block GLOSSARY row; refresh the `tag-taxonomy` / project-state memory.

**Acceptance:** server 283→(283+N) & client 118→(118+M) green, `tsc` clean both;
Home/Work/Community each independently fill their own windows; a Work tz override
visibly shifts Work-window placement; "Basics" shows no Start/End; preview-verified
on a Node-26 server.
