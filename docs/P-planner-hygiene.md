# P — Planner hygiene: recurrence horizon + Clear Date Range (implementation spec + ticket board)

**Status:** Spec'd · not started · **`main` migration head `0086`.**
**Depends on / coordinates with:** the two lazy recurrence engines shipped by PR #181 (`enable_routines` [0073](../server/src/db/migrations/0073_enable_routines.ts), `pattern_day_optouts` [0074](../server/src/db/migrations/0074_pattern_day_optouts.ts), block `recurrence_exdates` [0075](../server/src/db/migrations/0075_block_recurrence_exdates.ts)); **Phase M** (`daily_plan`); **Phase N** follow-ups which already occupy `0085`/`0086` on `main`, so this phase's migration is the next free number after `main` head — provisionally **`0087`**. ⚠ **Concurrent branches (Phase O lanes) are also claiming `0087`+; treat the number as provisional and renumber to the next free slot at merge time** (idempotent PRAGMA-guarded, so the number is cosmetic). The one-off cleanup script [clear-planner-from.ts](../server/src/scripts/clear-planner-from.ts) (PR #188) is the seed P0 extracts from. Companion to [ROADMAP.md](ROADMAP.md), [GLOSSARY.md](GLOSSARY.md), archived [design-brief-recurrence-settings.md](archive/design-brief-recurrence-settings.md).

> **Why this phase.** The planner fills its far future with recurring blocks nobody asked for. `GET /api/blocks` does **lazy auto-placement on every read** via two independent engines — [patterns-place.ts](../server/src/engine/patterns-place.ts) (`ensurePatternsForRange`) and [blocks-recur.ts](../server/src/engine/blocks-recur.ts) (`ensureRecurringBlocksForRange`). Recurring generators with no end materialize instances for *any* future day the user navigates to, and deleting the instances doesn't stick (the next refetch re-creates them). PR #188 cleared the existing mess with a script; this phase adds the two missing product surfaces: **a knob that bounds how far ahead recurrence materializes (P1)** and **a first-class "clear a date range" action (P2)**, both built on one shared, tested engine (**P0**).

---

## Locked decisions (do not re-litigate)

1. **Clamp inside both engines**, not at the single caller `fetchBlocksForRange` — every materialization path (day view, `.ics` export, any future caller) is then bounded.
2. **P1 auto-prune deletes instances beyond the new horizon but does NOT `UNTIL`-cap rules.** The standing horizon clamp is what prevents re-materialization while the horizon is low; leaving rules uncapped keeps *raising* the horizon reversible (repeats come back). Only **P2 open-ended** clear caps rules (permanent stop). → the shared engine takes `suppress: 'auto' | 'none'`.
3. **Templates are never deleted** by any path. **Locked/manual blocks** survive P1's prune (`autoOnly:true`); P2's explicit tool may remove them (`autoOnly:false`, by design).
4. Only **P2 open-ended** carries the `parseRule` year-2000-ceiling caveat (a far-future `UNTIL` would be rejected *if a rule is later re-validated via a UI edit*; reads never re-validate). Document it in the engine header.

---

## Background: the invariant every ticket must preserve

- **`time_blocks`** is the calendar and has **no `owner_id`** (single-owner era — [0059](../server/src/db/migrations/0059_adopt_gcal_mirror.ts)). `patterns`, `daily_plan`, `pattern_day_optouts` **are** owner-scoped. Keep block queries global; keep those three keyed on owner.
- A **recurring template** is never rendered: `recurrence_rule IS NOT NULL AND recurrence_parent_id IS NULL`. **Instances** carry `recurrence_parent_id` + `occurrence_date` ([0034](../server/src/db/migrations/0034_block_recurrence.ts)).
- **Suppression primitives** (the sanctioned way to stop regeneration):
  - block instances → append day to `time_blocks.recurrence_exdates`; helper `excludeBlockOccurrence(id,date)` [blocks-recur.ts:58](../server/src/engine/blocks-recur.ts).
  - pattern containers → `pattern_day_optouts(owner_id, pattern_id, date)`; honored in `placePatternOnDay` [patterns-place.ts:123](../server/src/engine/patterns-place.ts).
- **Rules live in three places:** Routine rule on `patterns`; Habit rule on member **task**; plain recurring block on the `time_blocks` template. `patternsRecurringOnDate` [patterns-place.ts:295](../server/src/engine/patterns-place.ts) unions pattern+task rules.
- `occurrencesBetween` [recurrence.ts:105](../server/src/engine/recurrence.ts) honors `UNTIL`+`EXDATE`; `MAX_SPAN_DAYS=366*5` caps bounded spans at parse time.
- **Single materialization choke point:** `fetchBlocksForRange` [blocks.ts:59](../server/src/routes/blocks.ts) → both engines → range-select. Callers: `GET /api/blocks` day view + `.ics` export [blocks.ts:115](../server/src/routes/blocks.ts). The partial-range / `state=someday` branch [blocks.ts:89](../server/src/routes/blocks.ts) does **not** materialize.

| Intent | Mechanism | Reversible? | Used by |
|---|---|---|---|
| Bound how far ahead anything materializes (standing rule) | clamp engines' upper day-bound to `today + recurrence_horizon_days` | yes (raise it) | P1 |
| Skip a generator on a **bounded** window (resumes after) | per-day `recurrence_exdates` / `pattern_day_optouts` | yes (delete rows) | P2 bounded, P0 |
| Stop a generator **forever** from a date (open-ended) | cap rule `UNTIL=<start-1>` | yes (drop UNTIL) | P2 open-ended, P0 |
| Delete future auto-instances beyond a lowered horizon | delete only, **no** rule cap (`suppress:'none'`) | yes (raise horizon → re-materializes) | P1 prune |

---

## Ticket board

| Ticket | Title | Wave | Depends on | Parallel-safe with | Primary files (touch) |
|---|---|---|---|---|---|
| **T-P0-1** | `clear-range.ts` shared engine | 0 | — | — | `server/src/engine/clear-range.ts` (new) |
| **T-P0-2** | Refactor script onto engine | 0 | T-P0-1 | — | `server/src/scripts/clear-planner-from.ts` |
| **T-P0-3** | Engine unit tests | 0 | T-P0-1 | T-P0-2 | `server/test/clear-range.test.ts` (new) |
| **T-P1-1** | Migration `0087` + schema + `Prefs` type | 1 | T-P0-1 (merge) | T-P2-1 | `0087_*.ts`, `migrations/index.ts`, `schema.ts`, `client/src/lib/api.ts` |
| **T-P1-2** | Engine horizon clamps | 1 | T-P1-1 | T-P2-1 | `patterns-place.ts`, `blocks-recur.ts` |
| **T-P1-3** | PATCH validation + auto-prune | 1 | T-P1-1, T-P0-1 | T-P2-1 | `server/src/routes/prefs.ts` |
| **T-P1-4** | Settings "Recurrence duration" select | 2 | T-P1-1 | (client-serial) | `client/src/views/Settings.tsx` |
| **T-P1-5** | P1 route/engine tests | 1 | T-P1-2,3 | T-P2-3 | `server/test/recurrence-horizon.test.ts`, `prefs.test.ts` |
| **T-P2-1** | `POST /api/planner/clear` route | 1 | T-P0-1 | all P1 server | `server/src/routes/planner.ts` (new), `app.ts` |
| **T-P2-2** | Settings "Clear Date Range" card + api helper | 2 | T-P2-1, T-P1-1 | (client-serial) | `client/src/views/Settings.tsx`, `client/src/lib/api.ts` |
| **T-P2-3** | P2 route tests | 1 | T-P2-1 | T-P1-5 | `server/test/planner-clear-route.test.ts` (new) |

**Migration**: only **T-P1-1** (`0087`). P0 and P2 add none.

---

## Fan-out plan (where parallel work is SAFE)

Parallelism is bounded by **shared-file collisions**, not logical deps. The two hot shared files are **`client/src/views/Settings.tsx`** (T-P1-4 + T-P2-2) and **`client/src/lib/api.ts`** (T-P1-1 + T-P2-2). Everything else is disjoint.

- **Wave 0 — serial, one branch/agent.** T-P0-1 → then T-P0-2 + T-P0-3 in parallel (they only read the engine). **Land P0 before Wave 1** — both features import `clearPlannerRange`. *Fan-out: low (1 agent, 2 sub-tasks at the end).*
- **Wave 1 — fan out 2 server tracks in parallel (disjoint files).**
  - **Track A (P1 server):** T-P1-1 → T-P1-2 + T-P1-3 (both depend on the schema add in T-P1-1; run after it, can be two agents on `engines` vs `prefs.ts`). Then T-P1-5 (tests).
  - **Track B (P2 server):** T-P2-1 → T-P2-3 (tests).
  - Only shared touch: **`app.ts`** router registration (Track B adds `plannerRouter`) and **`api.ts`** `Prefs` type (Track A) vs `planner` helper (Track B, deferred to Wave 2). Keep the `api.ts` `planner` helper out of Wave 1 to avoid the collision — add it in T-P2-2.
  - *Fan-out: high (2–4 agents). Use `isolation: 'worktree'` per agent since they mutate the tree.*
- **Wave 2 — client, serialize the shared files.** T-P1-4 then T-P2-2 (both edit `Settings.tsx`; T-P2-2 also edits `api.ts`). One agent, sequential, or two agents with an explicit ordering barrier. *Fan-out: none (same-file writes).*

Barrier points: **Wave 0 → Wave 1** (P0 must be merged), and **Wave 1 → Wave 2** (client needs the route + `Prefs` type). Within a wave, run the listed tracks concurrently.

---

## T-P0-1 — `clear-range.ts` shared engine

**Goal:** one pure, transactional, dry-runnable function for "clear + suppress a planner range," used by the CLI, P1 prune, and P2 endpoint. No duplicated deletion/suppression logic anywhere.

**New file:** `server/src/engine/clear-range.ts`.

**API:**
```ts
export interface ClearRangeInput {
  owner: string;                 // SYSTEM_OWNER_ID (CLI/prune) | currentOwnerId() (endpoint)
  start: string;                 // required local YYYY-MM-DD; clears >= this local day
  end?: string | null;          // optional inclusive local YYYY-MM-DD; omitted => open-ended
  suppress?: 'auto' | 'none';   // 'auto' (default): open-ended→UNTIL-cap, bounded→exdates/optouts. 'none': delete only.
  autoOnly?: boolean;           // true => only is_auto=1 AND is_locked=0 blocks are deleted. default false.
  dryRun?: boolean;             // default true — compute + report, write nothing.
}
export interface ClearRangeResult {
  mode: 'open-ended' | 'bounded';
  blocksDeleted: number;
  dailyPlanDeleted: number;
  generators: { kind:'block'|'pattern'; id:string; label:string;
                action:'until-cap'|'exdates'|'optouts'|'none'; daysSuppressed:number;
                oldRule?:string; newRule?:string }[];
}
export function clearPlannerRange(input: ClearRangeInput): ClearRangeResult;
```

**Design (generalize the script's logic):** resolve `tz` from `scheduling_prefs` for `owner`; `startUTC = zonedWallTimeToUTC(start,'00:00',tz)`, bounded `endUTC = zonedWallTimeToUTC(addDays(end,1),'00:00',tz)`. In one `sqlite.transaction()`, **suppress first, then delete**:
- **Suppress** (skip entirely when `suppress:'none'`): enumerate block templates + union of pattern/task rules with occurrences in the window (`occurrencesBetween`). Open-ended → `capRule(rule, UNTIL=startUTC-1s)` written to the owning row (`time_blocks`/`patterns`/`tasks`). Bounded → per-day `recurrence_exdates` (blocks) / `pattern_day_optouts` (patterns).
- **Delete**: `time_blocks` with `start_at>=startUTC [AND <endUTC]` AND NOT template `[AND is_auto=1 AND is_locked=0 when autoOnly]`; drop their `entity_tags`; `external_events` cascade; `daily_plan.block_id` SET NULL. Then `daily_plan` rows in `[start,end]` (owner-scoped).
- `dryRun` returns identical counts without writing.

**Relevant existing code to lift:** current [clear-planner-from.ts](../server/src/scripts/clear-planner-from.ts) (`capRule`, `untilToken`, `addDays`, the enumeration + delete blocks). `removeEntityTags` usage per [blocks.ts:461](../server/src/routes/blocks.ts). `excludeBlockOccurrence` for the exdate path.

**Expected project state after:** engine exists + exported; nothing wired to it yet; typecheck green; script unchanged (still works standalone until T-P0-2).

**Definition of done:**
- [ ] Pure engine — no `process.*`, no snapshot, no console.
- [ ] Handles open-ended + bounded × `suppress:auto|none` × `autoOnly`.
- [ ] `npm run typecheck` clean; no new dependency.

**Tests:** covered by T-P0-3.

---

## T-P0-2 — Refactor the CLI script onto the engine

**Goal:** the script becomes an argv parser + snapshot wrapper around `clearPlannerRange`; behavior byte-identical to today.

**File:** [clear-planner-from.ts](../server/src/scripts/clear-planner-from.ts). Keep `--apply` snapshot (`lib/backup`) and the explicit-cutoff guard **in the script** (CLI concerns). Delegate all clear/suppress to the engine (`suppress:'auto'`, `autoOnly:false`, open-ended since the script is "from a cutoff").

**Expected project state after:** one implementation of clear/suppress (engine); script is a thin CLI. Dry-run report shape unchanged.

**DoD:** [ ] script dry-run + `--apply` produce the same output as before the refactor; [ ] typecheck green.

---

## T-P0-3 — Engine unit tests

**File:** `server/test/clear-range.test.ts` (`startTestServer`/`resetDb`; `timezone='UTC'`).
**Tests / DoD:**
- [ ] open-ended `suppress:auto`: daily block template rule gets `UNTIL`; future instances deleted; a re-run of `ensureRecurringBlocksForRange` over the future range creates **0** rows.
- [ ] bounded over `[D,D+2]`: exactly 3 exdates added, only those 3 instances deleted, `D+3` still re-materializes.
- [ ] pattern (Routine on pattern row; Habit on member task) → `pattern_day_optouts`; `placePatternOnDay` for a suppressed day returns `skippedAlreadyPlaced`.
- [ ] `suppress:'none'`: instances deleted, rules **unchanged**, exdates/optouts **unchanged**.
- [ ] `autoOnly:true` spares `is_locked=1` / `is_auto=0`; `autoOnly:false` removes them.
- [ ] templates (`recurrence_parent_id IS NULL`) always survive.
- [ ] `dryRun:true` writes nothing but returns the same numbers as the apply.

---

## T-P1-1 — Migration `0087` + schema + `Prefs` type

**Goal:** persist `recurrence_horizon_days` (default 7).
**Files/edits:**
- New `server/src/db/migrations/0087_recurrence_horizon.ts`: `ALTER TABLE scheduling_prefs ADD COLUMN recurrence_horizon_days INTEGER DEFAULT 7` with the PRAGMA-guard idempotency of [0073](../server/src/db/migrations/0073_enable_routines.ts). Register in [migrations/index.ts](../server/src/db/migrations/index.ts) (`import * as m0087` + append to `MIGRATIONS`).
- [schema.ts:175](../server/src/db/schema.ts) region: add `recurrenceHorizonDays: integer('recurrence_horizon_days').default(7),` — comment: "recurrence materialization ceiling (distinct from planningHorizonDays, the auto-scheduler today-set window)."
- [api.ts:547](../client/src/lib/api.ts) (`interface Prefs`, near the `planning_horizon_days` field at :564): add `recurrence_horizon_days?: number;`. *(Do NOT touch the `planner` helper here — that's T-P2-2, avoids the shared-file collision.)*

**Expected project state after:** migration head **0087**; column exists; type-visible to client; no behavior change yet.
**DoD:** [ ] migration idempotent + registered; [ ] schema + `Prefs` updated; [ ] typecheck (server+client) green.

---

## T-P1-2 — Engine horizon clamps (decision #1)

**Goal:** neither engine materializes past `today + recurrence_horizon_days`.
**Files/edits (both engines already read `scheduling_prefs` for tz — add the horizon read there):**
- [patterns-place.ts:357](../server/src/engine/patterns-place.ts) (in `ensurePatternsForRange`, def at :346): `const days = localDaysInRange(...).filter(d => d >= today && d <= addDays(today, horizon));`
- [blocks-recur.ts:79](../server/src/engine/blocks-recur.ts) `ensureRecurringBlocksForRange`: same clamp on its `days` filter.
- Read `recurrence_horizon_days` (default 7) in each. **Read surface unchanged** — the SELECT still returns any already-materialized block in the requested range; only creation is capped.

**Expected project state after:** far-future navigation no longer creates repeats beyond the horizon; existing rows still render.
**DoD:** [ ] both engines clamp; [ ] `.ics` export + day view both bounded (they share `fetchBlocksForRange`); [ ] typecheck green. **Tests:** T-P1-5.

---

## T-P1-3 — PATCH validation + auto-prune on shorten (decision #2)

**Goal:** reject bad values; when the horizon is lowered, delete future auto-instances beyond the new bound (no rule cap).
**File:** [prefs.ts:19](../server/src/routes/prefs.ts) `PATCH /api/prefs`:
- If `recurrence_horizon_days` present and ∉ `{7,15,30,60,90,180}` → `ctx.status=422` before update.
- Read the **old** value first; after the update, if `new < old`: `snapshot()` then `clearPlannerRange({ owner: currentOwnerId(), start: addDays(today, newHorizon+1), suppress:'none', autoOnly:true, dryRun:false })`. Return `{ prefs, pruned: result.blocksDeleted }`.
- Broadcast `block:deleted` (mirror the day-clear broadcast at [blocks.ts:523](../server/src/routes/blocks.ts)) so clients refetch. Audit `action:'update'` stays; add the prune to the audit entity note.

**Expected project state after:** lowering the horizon is a safe, snapshotted, reversible prune (raising it re-materializes on next read); raising does nothing immediately.
**DoD:** [ ] 422 on out-of-set; [ ] shorten prunes auto-instances beyond bound, keeps locked/manual/templates, snapshots, reports `pruned`; [ ] rules NOT capped (assert reversibility). **Tests:** T-P1-5.

---

## T-P1-4 — Settings "Recurrence duration" select

**Goal:** owner-facing control.
**File:** [Settings.tsx](../client/src/views/Settings.tsx) Scheduling `section`, next to the [planning_horizon control at :442](../client/src/views/Settings.tsx). A `<select>` {7,15,30,60,90,180}; `onChange` → (if lowering, `confirm()` using the `pruned` count returned by the PATCH) → `api.prefs.update({recurrence_horizon_days})` → `refetchPrefs()` → `showToast` on error. Add to `interface SettingsForm` [:20](../client/src/views/Settings.tsx), `DEFAULTS` [:40](../client/src/views/Settings.tsx) (`7`), and hydration `createEffect` [:95](../client/src/views/Settings.tsx) (`?? 7`). Copy: "Recurrence duration — generate repeats this many days ahead." Hint: lowering removes auto-placed repeats beyond the window.

**Expected project state after:** control persists + reflects stored value after reload; shorten shows a confirm with the count.
**DoD:** [ ] select wired + hydrated + persisted; [ ] shorten confirm path; [ ] client typecheck/build green.

---

## T-P1-5 — P1 tests

**Files:** `server/test/recurrence-horizon.test.ts`, extend `server/test/prefs.test.ts`.
**Tests / DoD:**
- [ ] `FREQ=DAILY` block template; `GET /api/blocks?from=today&to=today+30` → **7** instances at default; set horizon 30 → 30 (drive via route to prove wiring).
- [ ] same for a recurring pattern (Routine + Habit).
- [ ] `PATCH {recurrence_horizon_days:45}` → 422; `{…:30}` → 200 + persisted.
- [ ] seed `is_auto=1` instances at today+10/+20; lower 30→7 → both pruned; a `is_locked=1` at today+15 survives; template survives; response `pruned===2`.
- [ ] lower then raise → fresh `GET` re-creates the pruned days (proves no rule cap / reversibility).

---

## T-P2-1 — `POST /api/planner/clear` route

**Goal:** owner-facing clear-range endpoint with preview.
**Files:** new `server/src/routes/planner.ts`; register in [app.ts](../server/src/app.ts) alongside `blocksRouter`/`prefsRouter`.
- Body `{ start, end?, dry_run? }`; validate `start` ISO present, `end>=start` if given (`400` otherwise).
- `clearPlannerRange({ owner: currentOwnerId(), start, end, suppress:'auto', autoOnly:false, dryRun:!!dry_run })` — the engine branches on `end`: bounded→exdates/optouts, open-ended→UNTIL-cap.
- Non-dry-run: `snapshot()` to `backups/companion-preclear-<ts>.db` first; include `backup` in the response; `writeAudit({action:'clear-range', entity:'planner:<start>..<end>'})`; broadcast `block:deleted`.
- Response: `ClearRangeResult & { backup?: string }`.

**Expected project state after:** the script's power is available over HTTP, owner-scoped, with a dry-run preview + snapshot.
**DoD:** [ ] validation; [ ] dry-run writes nothing; [ ] apply snapshots+audits+broadcasts; [ ] open-ended caps, bounded skips-window. **Tests:** T-P2-3.

---

## T-P2-2 — Settings "Clear Date Range" card + api helper

**Goal:** the UI surface.
**Files:** [api.ts](../client/src/lib/api.ts) add `planner: { clearRange: (b) => request('POST','/planner/clear', b) }`; [Settings.tsx](../client/src/views/Settings.tsx) a **destructive** card (danger styling per [color-styling-rules.md](color-styling-rules.md)): required start `<input type=date>`, optional end, **Preview** (`clearRange({start,end,dry_run:true})` → "will delete N blocks, suppress M generators; open-ended stops repeats forever / bounded skips the window"), **Clear** behind a confirm → `dry_run:false` → toast summary + backup path → refetch blocks.

**Expected project state after:** owner can preview+clear any range from Settings; never needs the CLI.
**DoD:** [ ] preview counts accurate; [ ] apply requires confirm; [ ] surfaces backup path; [ ] client build green.

> **Client-serial note:** T-P2-2 edits `Settings.tsx` (also touched by T-P1-4) and `api.ts` (also touched by T-P1-1). Run **after** both, or resolve as a single client commit — see Wave 2.

---

## T-P2-3 — P2 route tests

**File:** `server/test/planner-clear-route.test.ts`.
**Tests / DoD:**
- [ ] `dry_run:true` returns counts, writes nothing.
- [ ] open-ended apply: instances gone, rule `UNTIL`-capped, future `GET` empty.
- [ ] bounded `[D,D+2]`: only that window cleared, `D+3` still materializes.
- [ ] missing `start` → 400; `end<start` → 400.
- [ ] audit row written; response includes `backup` path on apply.

---

## Global definition of done (phase complete when)
- [ ] Migration head **0087**; `recurrence_horizon_days` end-to-end (schema → route → engines → Settings).
- [ ] One clear/suppress engine (`clear-range.ts`) behind the CLI, the prune, and the endpoint.
- [ ] Templates never deleted; locked/manual preserved by P1 prune; horizon changes reversible.
- [ ] All new `*.test.ts` green; `pnpm --filter server typecheck` + client build green in CI ("Typecheck + Unit + Integration").
- [ ] `resetDb` baseline in [helpers.ts:63](../server/test/helpers.ts) includes any pref a test depends on.
