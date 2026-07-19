> **Type:** Frontend + Backend
> **Phase:** FTUE / Weekly Planning Assistant
> **Branch:** `feat/onboarding-wizard`
> **Commit style:** `feat(onboarding): first-run wizard shell`
> **Design:** this ticket is the spec (+ `docs/ftue-plan.md` §3 "What must be set" and §5 "The FTUE flow", steps 1, 2, 4)
> **Dependencies:** T2 (Weekly Planning Assistant — provides the reusable stepper primitive AND the planning-session record with `entry_branch`)

> ### 🚧 LIVE — issue #347, open and not started. Verify the pins before implementing.
> A **pre-implementation artifact**: nothing here has been built (no branch, no commits), and every
> `file:line` below is a snapshot from 2026-07-14 authoring. Since then the migration head moved
> **0126 → 0130** and the ENTITY wave (#357–#375) landed. Read the code for current behavior; the
> durable pointers here are the *file + symbol* names.
>
> ⚠️ **Its migration slot is TAKEN.** The ticket claims `0128_owner_onboarded`, but `0128` is now
> `sleep_hours`; its "current head is `0126`" line is stale. The ticket's own *"confirm the next
> free slot at implementation time"* caveat is the right instinct — and T1 has since taken `0131`,
> so **use `0132`** (free as of 2026-07-18, no open PR claiming it) and rename the file, the `id`
> export, the `index.ts` import, and the `MIGRATIONS` append to match. Re-confirm at start: this
> answer moves every time a migration lands.

## Goal

Ship a **first-run onboarding wizard** that a brand-new / not-yet-confirmed owner sees exactly once, reusing the T2 stepper primitive. Three steps, each prefilled and skippable, that stop the identity from being stuck at the seeded migration value and stop timezone/work-hours/trust from being rediscovered later:

1. **Welcome + identity** → `PATCH /api/owner/profile` (`name`, `email`) so the owner replaces the seeded `owners.name`/`owners.email` instead of living as the migration-hardcoded identity forever.
2. **Time + place** → confirm the browser-detected IANA timezone (reuse the existing TZ auto-adopt path) and set work hours (`workday_start` / `workday_end`), all via `PATCH /api/prefs`.
3. **Trust dial** → set `trust_mode` (`cautious` / `balanced` / `hands_off`), Balanced preselected — reuse the shipped 0070 dial, do not rebuild it.

Completion (or skip) marks the owner **onboarded** via a new nullable `scheduling_prefs.onboarded_at` flag (the "confirmed owner" signal — none exists today) and records a T2 planning-session with `entry_branch="onboarding"`.

## Non-goals

- Do **not** build Step 3 "Connect a source" / Google OAuth or Step 5 "Run first sync" — that is **T12**. This ticket ends at the trust dial.
- Do **not** rebuild or re-derive the trust toggle logic. Reuse `trust_mode` and the same `balanced`/`hands_off` semantics the top-bar Suggest/Schedule toggle already writes (`client/src/App.tsx` ~L81-91). `cautious` is added as a selectable third option only.
- Do **not** define, migrate, or duplicate the `planning_sessions` table / `entry_branch` column — that is **owned by T2**. Only *call* T2's creation primitive with `entry_branch="onboarding"`.
- Do **not** add work-hours or timezone editors to `Settings.tsx`, and do **not** change the existing Settings Profile card. The wizard is additive.
- Do **not** touch the `Settings.tsx` `SettingsForm` type or `DEFAULTS`.
- Do **not** gate the wizard on `aiAvailable()` — it is deterministic, no LLM.

## Pinned conventions

- **Migration:** new `server/src/db/migrations/0128_owner_onboarded.ts` exporting `const id = "0128_owner_onboarded"` and `function up(db: Database): void` using **raw better-sqlite3** prepared statements. SQLite `ALTER TABLE … ADD COLUMN` has no `IF NOT EXISTS`, so guard with a `PRAGMA table_info(scheduling_prefs)` column check (copy the `hasColumn` helper idiom from `0070_trust_mode.ts`). Additive, idempotent, **forward-only**. **Confirm the next free slot is still 0128 (T1 takes 0127) at implementation time** (open PRs may have claimed it; bump if so and rename the file/id/import to match).
- **Register** the migration: add `import * as m0128 from "./0128_owner_onboarded.js"` and append `m0128` to the `MIGRATIONS` array in `server/src/db/migrations/index.ts` (current head is `0126_default_categories`).
- **Drizzle mirror** (`server/src/db/schema.ts`, `schedulingPrefs` table ~L195): add `onboardedAt: text('onboarded_at'),` — nullable ISO-8601 TEXT, no default (NULL = not yet onboarded). No CHECK constraint.
- **Client Prefs type** (`client/src/lib/api.ts`, `interface Prefs` ~L738): add `onboarded_at?: string | null;`. No new API method needed — `api.prefs.update` already accepts `Partial<Prefs>`, and `updatePrefs` in `server/src/services/prefs.ts` is a generic snake→camel passthrough (`fromApi<Partial<schedulingPrefs.$inferInsert>>`), so `{ onboarded_at }` writes with **no server-side whitelist edit**.
- **Reuse, don't add, API surface:** `api.owner.updateProfile({ name, email })` (`client/src/lib/api.ts` L482), `api.prefs.update({ … })` (L298), `api.auth.me()` (L465) for the identity prefill. All already exist.
- **Owner scoping:** `PATCH /api/owner/profile` and `PATCH /api/prefs` already scope to `currentOwnerId()` (`server/src/routes/owner.ts` L52, `server/src/routes/prefs.ts` L27). No new route — no scoping work.
- **Stepper primitive:** reuse the reusable stepper introduced by **T2** (the "Plan Your Week" assistant). Confirm its exact exported component name + import path at implementation (T2 defines it); do not fork a second stepper.
- **Trust values:** exactly `'cautious' | 'balanced' | 'hands_off'` (the `Prefs.trust_mode` union, `client/src/lib/api.ts` L745). Balanced is the default and the preselected option (matches `docs/ftue-plan.md` §4 and `App.tsx`).
- **Mount idiom:** a first-run **full-viewport overlay** component, mounted once inside `Shell` in `client/src/App.tsx` next to `<ElementWizard />` (L154), so it covers both the auth-gated (`SessionGate`) and ungated (`UngatedRouter`) routers via the single `Shell`. Reuse existing `.card` / button classes; this is NOT the `elementModal` signal and NOT the `.modal-backdrop` bottom-sheet.

## Before implementation

Read these to match reality (do not guess):

- `docs/ftue-plan.md` — §3 (settings to capture: identity, timezone, work hours, trust dial) and §5 (step-by-step FTUE; note steps 3 & 5 are explicitly out of scope here → T12).
- `client/src/stores/index.ts` — the TZ auto-adopt effect (L322-341, `Intl.DateTimeFormat().resolvedOptions().timeZone`, `cp-tz-auto-adopted` localStorage marker), the `prefs` resource + `refetchPrefs` (L305-307), and `aiAvailable` (L302, for context only — not a gate here).
- `client/src/App.tsx` — the Suggest/Schedule trust toggle (`mode()`/`setMode()`, L81-91) for how `trust_mode` maps to the dial; the `Shell` mount point for `<ElementWizard />` (L154); both router paths (`SessionGate` L184, `UngatedRouter` L261) render `Shell`.
- `server/src/routes/owner.ts` — `PATCH /api/owner/profile` body shape + validation (`name` non-empty ≤120 chars; `email` must pass `EMAIL_RE` or be null/'' to clear), L28-58.
- `server/src/routes/prefs.ts` + `server/src/services/prefs.ts` — how PATCH `/api/prefs` accepts snake_case and passes through to Drizzle (generic `fromApi`, no per-field whitelist).
- `client/src/views/Settings.tsx` — the Profile card (`profileName`/`profileEmail`/`saveProfile`, L78-96) and that **work hours are NOT edited anywhere in Settings today** (the `SettingsForm` type L18-36 has no `workday_start`/`workday_end`); the wizard is the first UI to set them.
- `server/src/db/migrations/0070_trust_mode.ts` — the `hasColumn(db, table, col)` guard pattern to copy for the idempotent `ADD COLUMN`.
- **T2's deliverable** — confirm (a) the reusable stepper component's export name/path and (b) the exact planning-session creation surface (endpoint or service + the accepted `entry_branch` values). This ticket assumes both exist per the T2 dependency; if T2's `entry_branch` set does not yet include `"onboarding"`, add it there or coordinate — do not invent a parallel table here.

## Files impacted

**New:**
- `server/src/db/migrations/0128_owner_onboarded.ts` — adds nullable `scheduling_prefs.onboarded_at`, backfills existing active owners as onboarded.
- `client/src/components/OnboardingWizard.tsx` — the first-run overlay (3 steps on the T2 stepper), gated on `prefs()?.onboarded_at == null`.
- `server/src/db/migrations/0128_owner_onboarded.test.ts` — migration behavior (column added, active owners backfilled, fresh owner left NULL).
- `client/src/components/OnboardingWizard.test.tsx` — gating + step wiring (see Tests).

**Changed:**
- `server/src/db/schema.ts` — add `onboardedAt: text('onboarded_at')` to `schedulingPrefs`.
- `server/src/db/migrations/index.ts` — import + append `m0128`.
- `client/src/lib/api.ts` — add `onboarded_at?: string | null` to `interface Prefs`.
- `client/src/App.tsx` — mount `<OnboardingWizard />` inside `Shell` (next to `<ElementWizard />`).

## Schema required

One additive column. **No new table** (the planning-session/`entry_branch` schema belongs to T2).

- Table `scheduling_prefs`, new column `onboarded_at`:
  - Type: `TEXT`, **nullable**, **no default** (NULL = owner has not completed/dismissed onboarding; non-NULL ISO-8601 = onboarded, and doubles as the timestamp).
  - No FK, no CHECK, no index (read only via the already-loaded `prefs()` singleton; the row is fetched by `owner_id` which is already indexed).
- Migration `0128_owner_onboarded.up(db)`:
  - Idempotent add: `if (!hasColumn(db, 'scheduling_prefs', 'onboarded_at')) db.exec("ALTER TABLE scheduling_prefs ADD COLUMN onboarded_at TEXT;")`.
  - Backfill (so upgrades never retrigger the wizard): mark any owner that already has data as onboarded, while leaving a fresh/seed owner (no tasks) NULL:
    `db.prepare("UPDATE scheduling_prefs SET onboarded_at = CURRENT_TIMESTAMP WHERE onboarded_at IS NULL AND owner_id IN (SELECT DISTINCT owner_id FROM tasks)").run();`
  - Forward-only; no data destroyed.
- Drizzle mirror + `index.ts` registration as pinned above.

## Definition of Done

- [ ] `0128_owner_onboarded.ts` adds `scheduling_prefs.onboarded_at` (nullable TEXT, guarded/idempotent) and backfills owners that have ≥1 task; registered in `index.ts`; Drizzle `schedulingPrefs` mirrors the column.
- [ ] `Prefs.onboarded_at?: string | null` added to `client/src/lib/api.ts`; no new API method added.
- [ ] `OnboardingWizard.tsx` renders **only** when `prefs()` has resolved **and** `prefs()!.onboarded_at == null` (never while `prefs()` is `undefined`/loading, so a slow prefs fetch cannot flash the wizard at an already-onboarded owner).
- [ ] Step 1 prefills name/email from `api.auth.me()` and writes via `api.owner.updateProfile({ name, email })` (email empty → `null`).
- [ ] Step 2 shows the browser-detected IANA zone (`Intl.DateTimeFormat().resolvedOptions().timeZone`) for confirmation and persists `timezone`, `workday_start`, `workday_end` via `api.prefs.update` (work hours prefilled `09:00`/`18:00`).
- [ ] Step 3 sets `trust_mode` via `api.prefs.update`, Balanced preselected; options are exactly `cautious` / `balanced` / `hands_off` reusing the shipped dial (no new dial logic).
- [ ] Finishing the last step **and** an explicit Skip both `PATCH /api/prefs { onboarded_at: <ISO now> }`, then `refetchPrefs()`, so the overlay closes and never reappears.
- [ ] On completion, a T2 planning-session is recorded with `entry_branch="onboarding"` (via T2's primitive — not a new table).
- [ ] `<OnboardingWizard />` is mounted once inside `Shell` (`client/src/App.tsx`), covering both `SessionGate` and `UngatedRouter`.
- [ ] No changes to `Settings.tsx`, the `elementModal` signal, or the top-bar Suggest/Schedule toggle behavior.
- [ ] All verification commands below pass.

## Tests

- [ ] **migration (server):** after applying through 0128, `PRAGMA table_info(scheduling_prefs)` includes `onboarded_at`; an owner seeded WITH a task is backfilled non-NULL; an owner with a `scheduling_prefs` row but **zero tasks** keeps `onboarded_at` NULL. Re-running `up` is a no-op (idempotent).
- [ ] **prefs passthrough (server):** `PATCH /api/prefs { onboarded_at: "<iso>" }` for the current owner persists and round-trips via `GET /api/prefs` (proves the generic `updatePrefs` writes the new column with no whitelist change).
- [ ] **gating (client):** `OnboardingWizard` renders nothing while `prefs()` is loading; renders nothing when `onboarded_at` is set; renders the step shell when `prefs().onboarded_at == null`.
- [ ] **step wiring (client):** advancing Step 1 calls `api.owner.updateProfile` with the entered name/email (empty email → `null`); Step 2 calls `api.prefs.update` with `timezone` + `workday_start` + `workday_end`; Step 3 calls `api.prefs.update` with the chosen `trust_mode` (default `balanced`).
- [ ] **completion (client):** finishing or skipping calls `api.prefs.update({ onboarded_at })` and records the `entry_branch="onboarding"` planning-session exactly once; the overlay then unmounts.

```
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter client typecheck
pnpm --filter client test
pnpm --filter client build
```

## Acceptance Criteria

- [ ] **Given** a fresh empty DB (seed owner, no tasks), **when** the app loads, **then** the onboarding overlay appears once; **and** after finishing Step 3 (or Skip) it never appears again on reload (because `onboarded_at` is now set).
- [ ] **Given** an existing DB upgraded to head 0128 (owner already has tasks), **when** the app loads, **then** the overlay does **not** appear (backfilled onboarded).
- [ ] **Given** Step 1 with name "Ada" / email "ada@x.io", **when** the user advances, **then** `owners.name`/`owners.email` are updated (verifiable via `api.auth.me()`), replacing the seeded identity.
- [ ] **Given** a browser in `America/Los_Angeles`, **when** Step 2 renders, **then** that zone is shown pre-selected and, on confirm, `scheduling_prefs.timezone` = `America/Los_Angeles` with `workday_start`=`09:00`/`workday_end`=`18:00` (unless edited).
- [ ] **Given** Step 3 with Balanced preselected, **when** the user picks Hands-off and finishes, **then** `scheduling_prefs.trust_mode` = `hands_off` and the top-bar toggle reads "Schedule" (same dial, no divergence).
- [ ] **Given** completion, **then** exactly one planning-session with `entry_branch="onboarding"` is recorded via the T2 primitive.
- [ ] `Settings.tsx`, the trust top-bar toggle, and the `elementModal` wizard are behaviorally unchanged.

## Subtasks

1. [ ] Add migration `0128_owner_onboarded.ts` (guarded `ADD COLUMN onboarded_at TEXT` + backfill owners with ≥1 task); register `m0128` in `index.ts`; mirror `onboardedAt` on `schedulingPrefs` in `schema.ts`. Run `pnpm --filter server test` (migration + prefs passthrough tests).
2. [ ] Add `onboarded_at?: string | null` to `Prefs` in `client/src/lib/api.ts`.
3. [ ] Build `OnboardingWizard.tsx`: full-viewport overlay gated on resolved-`prefs()` + `onboarded_at == null`, using the T2 stepper; Step 1 identity (`api.auth.me` prefill → `api.owner.updateProfile`).
4. [ ] Step 2 time + place: browser-TZ confirm + `workday_start`/`workday_end` (default 09:00/18:00) → `api.prefs.update`.
5. [ ] Step 3 trust dial: `cautious`/`balanced`(default)/`hands_off` → `api.prefs.update`, reusing the shipped dial semantics.
6. [ ] Completion/Skip handler: `api.prefs.update({ onboarded_at: new Date().toISOString() })` → `refetchPrefs()`, and record the `entry_branch="onboarding"` T2 planning-session.
7. [ ] Mount `<OnboardingWizard />` inside `Shell` in `client/src/App.tsx` (next to `<ElementWizard />`).
8. [ ] Write `OnboardingWizard.test.tsx` (gating + step wiring + completion). Run `pnpm --filter client typecheck && pnpm --filter client test && pnpm --filter client build`.
