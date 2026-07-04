# Phase Z — Time-Sense · HANDOFF (2026-07-04)

Continuation guide for the next session picking up **Phase Z "Time-Sense"** (Focus
Ritual + Calibration Loop). Read this with the spec [Z-focus-ritual.md](Z-focus-ritual.md)
open — the spec's build-order table (§6) is the source of truth for what's built vs. pending.

> ⚠️ **Name collision.** There are TWO unrelated "Phase Z" efforts. THIS one is
> **Time-Sense** (focus ritual + calibration, `docs/Z-focus-ritual.md`). The OTHER is
> **naming-consolidation** (`docs/Z-naming-consolidation.md`, the `pattern`→`direction`
> tag-axis revert, migration `0105_revert_direction_axis`). Don't conflate them.

---

## TL;DR — where things stand

**Time-Sense is ~75% shipped. Everything below is MERGED to `main` and live behind a
per-owner feature flag (`scheduling_prefs.time_sense_enabled`, default OFF).** With the
flag off, behavior is byte-identical to pre-Z (Phase N), enforced by tests.

| Slice | What | Status |
|---|---|---|
| Master flag | `time_sense_enabled` (mig `0106`) + Settings toggle + `lib/flags.ts` | ✅ merged (#246) |
| **Z0** | Scoped `estimate_calibration` (mig `0107`, robust MAD math, fallback ladder, combo pins) + read/pin routes | ✅ merged (#246) |
| **Z1** | EOD Alignment — `reflections(kind='evening')`, `summarizeEvening`, modal-only authorship | ✅ merged (#246) |
| **Z2** | Daily Brief folds in last night's EOD Alignment (`morningCarryover`) | ✅ merged (#246) |
| **Z6** | Suggest-only estimate chip (`suggestEstimate` + `/api/calibration/suggest/:id` + ElementWizard chip) | ✅ merged (#246) |
| **Z3a** | T4 server engines — "Keep working" (`extendBlock`) + "Schedule again" (`/reschedule`) | ✅ merged (#246) |
| **Z4** | Focus-cue background reminders (`source=focus_*`) + push `vibrate` + firing gate + arm/clear endpoints | ✅ merged (#251) |
| **Z3b** | Focus Ritual client screen (`FocusRitual.tsx` + `lib/focus.ts`) | ✅ merged (#251) |
| **Z5** | Per-cue prefs matrix (per-timer × per-channel) + Settings UI + experiment arms | ⬜ **NOT STARTED** |
| **Z7** | Voice loop — `renderCopy` + small-model tier + deterministic gate + `copy_history` | ⬜ **NOT STARTED** |

**Migration head on `main` = `0107`. Next free = `0108`.** PRs #246 (`bcdf214`) and
#251 (`92ed29b`) both merged; all files verified present on `origin/main`.

---

## What remains: Z5 and Z7

### Z5 — per-cue prefs matrix + experiment arms (spec §4, §5.1)

Today there is only the **one master flag**. Z5 expands it into the granular control the
spec wants and the A/B machinery.

- **New prefs** (mig `≥0108_focus_prefs`, mirror the `enable_rituals`/`enable_routines`
  boolean-column pattern on `scheduling_prefs`, OR a small per-owner kv set):
  `focus_ritual_enabled`, `haptic_cues_enabled`, `ambient_color_enabled`,
  `calibration_loop_enabled`, and `z_experiment_arm` (A/B/C/D bucket, §5.2).
- **Wire the gates:** the Focus screen (`FocusRitual.tsx`) already gates haptics on a
  capability check and animation on `prefers-reduced-motion`; Z5 adds the per-channel
  user prefs on top (e.g. skip `navigator.vibrate` when `haptic_cues_enabled=false`;
  skip the ambient layer when `ambient_color_enabled=false`). Per-timer (T1–T4) config
  can key off `focusCues()` kinds.
- **Settings UI:** a per-timer × per-channel grid under a "Time-Sense" section (the
  master toggle already lives in `client/src/views/Settings.tsx`).
- **Experiment arm assignment** (§5.2): randomize per owner, fixed for the study
  (between-subjects 2×2 haptic×color — decided, NOT a crossover; see §5.2 rationale).
- The A/B **metrics** (§5.3) read from `estimate_calibration` + block/reminder data —
  mostly already captured; the "keep working" / "schedule again" rates use
  `source_kind='reschedule'` on `flight_plan` and the extend endpoint.

### Z7 — the Voice loop (spec §2V)

One language path for every human-facing line (timing notes, T4 copy, calibration chips,
Daily Brief, EOD narrative), so the voice is consistent and **never repeats**.

- **`renderCopy(surface, payload)` service** (`server/src/agents/…`): deterministic
  payload → small-model draft → **deterministic gate** (length, banned words,
  required-datum presence, repetition check) → emit + record; on failure/Ollama-down →
  rotation-pool fallback with datum-slotting. Generator ≠ evaluator; bounded retries.
- **`copy_history(owner_id, surface, signature, created_at)`** support table
  (mig `≥0109_copy_history`) — per-surface rolling window (K≈30 high-freq / 14 medium /
  4 low, §2V.3). Declare as non-noun support state.
- Uses the existing `generate(tier:'small')` Ollama seam (`server/src/mcp/ollama.ts`,
  `agents/summarize.ts` pattern). Reserve `tier:'medium'` for the EOD/weekly narrative.
- Retrofit the existing callers (timing note, T4 line, calibration chip, Brief, EOD) to
  route through `renderCopy` once it exists.

---

## Where everything lives (merged code)

**Server**
- `server/src/lib/flags.ts` — `timeSenseEnabled(ownerId)`.
- `server/src/services/calibration.ts` — `computeScopedCalibration`, `robustStats`
  (cap [0.1,10] + median±3·MAD), `resolveCalibration` (ladder tag_combo→tag→category→
  subtype→objective→global), `detectComboSuggestions`, `suggestEstimate`, `scopeLabel`.
- `server/src/jobs/calibrate-estimates.ts` — nightly (01:30) recompute; **flag-off branch
  is byte-identical Phase N + purges scoped rows**.
- `server/src/agents/summarize.ts` — `summarizeEvening`, `gatherEvening`, `morningCarryover`.
- `server/src/engine/extend-block.ts` — `extendBlock` (bounded forward cascade, §1.1a).
- `server/src/engine/reminders.ts` — `syncBlockFocusReminders`/`clearBlockFocusReminders`,
  focus-cue `contentFor` + vibrate, block-status firing gate.
- Routes on `server/src/routes/blocks.ts`: `/extend`, `/reschedule`, `/focus-reminders`
  (POST+DELETE). Calibration routes on `server/src/routes/calibration.ts`
  (`/scopes`, `/suggest/:id`, `/pins`). Evening routes on `server/src/routes/reflections.ts`.
- Migrations `0106_time_sense_flag.ts`, `0107_calibration_scope.ts`.

**Client**
- `client/src/lib/focus.ts` — pure ritual logic (phase/depletion/cues/formatRemaining/overrunNote).
- `client/src/components/FocusRitual.tsx` — the focus screen.
- `client/src/views/Today.tsx` — current-block derivation (30s tick) + flag-gated "Focus" button.
- `client/src/lib/api.ts` — `blocks.extend/reschedule/armFocusReminders/clearFocusReminders`,
  `calibration.suggest`, `ExtendResult`/`ExtendMove`/`EstimateSuggestion` types, `DaySummary.evening`.
- `client/src/index.css` — `focus-breath` keyframe + `prefers-reduced-motion` guard.
- `client/public/sw.js` — passes `vibrate` to `showNotification`.

**Tests:** `server/test/time-sense.test.ts`, `server/test/focus-reminders.test.ts`, `server/test/extend-block.test.ts`;
`client/src/lib/focus.test.ts`.

---

## Critical gotchas (do not relearn the hard way)

1. **Solid module-scope `createMemo` evaluates EAGERLY** → a memo reading a resource
   declared later throws in the minified container bundle (passes tsc + vitest, fails ONLY
   the `Build, screenshot-test, publish` CI job). Keep every memo **component-scoped**, or
   declare the resource before the memo. (See `main`'s `fix(stores)` commit + memory
   `reference_solid_module_memo_ordering`.)
2. **Flag round-trip must be API-tested, not raw-SQL.** Most tests flip
   `time_sense_enabled` via `UPDATE scheduling_prefs …`, which bypasses the real
   Settings path (`PATCH /api/prefs` → `fromApi` → Drizzle `.set` → serialize). Keep at
   least one API round-trip test per new pref (see `server/test/time-sense.test.ts` "round-trips").
3. **Preview harness port hop:** `pnpm dev` moves Vite to 5174 when 5173 is occupied by a
   stale server; the preview proxy points at the configured port → `chrome-error`.
   Navigate the browser directly to the actual Vite port. Also beware a **stale
   prior-session server on :3848** serving old schema (a 500 "near where: syntax error" =
   empty SET = it lacks a column your code added).
4. **`estimate_calibration` is scope-keyed** (PK `owner_id, scope_kind, scope_ref`). The
   legacy `GET /api/calibration` (routes/review.ts) reads the `scope_kind='global'` row
   explicitly. New scoped surface is `GET /api/calibration/scopes`.
5. **Block status is never `'in_progress'`** (task-only). "Current/running block" is
   derived from the clock (client) or a running `time_entries` row (server, `ended_at IS NULL`).
6. **`plan_outcomes` + `aggregate_plan_outcomes` were dropped (mig 0095)** — planned-vs-done
   is derived on demand (`gatherEvening`).

---

## Decisions already made (don't re-litigate)

- `reflections.kind = 'evening'`; modal-only authorship (`POST /api/reflections/evening/open`).
- T4 "Keep working" = fixed **+10 min** (calibration-suggested overflow is a later refinement).
- T3 3-min-warning sound **off** by default.
- `calibrate_estimates` cron runs **nightly 01:30** (was weekly).
- Calibration is **suggest-only** — the job never writes `estimated_minutes` (test-enforced).
- Experiment design = **between-subjects 2×2 (haptic × color), NOT a crossover** (§5.2).
- Focus background reminders are armed **per-block by the Focus screen** (no mass-arming of
  every auto-placed block).

---

## Verify / dev setup

- Server tests: `cd server && TZ=UTC pnpm exec vitest run` (worktrees lack node_modules →
  `pnpm install --frozen-lockfile` first, ~5s warm). Client: `pnpm --filter client test`.
  Type-check: `pnpm exec tsc --noEmit` in each package. At last merge: server **1304 pass/3 skip**,
  client **258 pass**.
- To see the Focus Ritual: enable the flag (Settings → "Time-Sense", or
  `PATCH /api/prefs {time_sense_enabled:true}`), have a `task`/`focus`/`habit` block whose
  `[start_at, end_at]` spans now, then the "Focus" button appears in Today's Day Overview.
- Branch `claude/z-time-sense` is fully merged → safe to delete. This handoff lands on
  `claude/z-handoff`.
