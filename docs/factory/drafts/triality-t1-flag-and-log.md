# [Factory] Triality T1 — `triality_enabled` flag + `triality_log` table + Settings toggle

> **Type:** Backend + small UI · **Phase:** Triality Wave 1 · **Branch:** `feat/triality-flag-log` · **Commit style:** `feat(triality): flag, append-only log, settings toggle (dark)` · **Design:** `docs/triality-design.md` §7 · **Dependencies:** none

## Goal

Land the entire Triality persistence surface, dark: the master flag (default off),
the append-only outcome log, prefs plumbing so the flag round-trips through
`GET/PATCH /api/prefs`, and a Settings toggle. No consumer exists yet — flag-on
changes nothing observable except the prefs payload.

## Non-goals

No scoring, no vector code, no routes under `/api/triality/*`, no GraphQL, no card
UI, no log *writes* (T3/T4 write; this ticket only creates the table + read/insert
helpers' schema ground). No new cron job — Triality never gets one (design §8).

## Pinned conventions (verified 2026-07-29 — re-verify at build)

- Flag column shape: `integer('…', { mode: 'boolean' }).default(false)` — copy
  `timeSenseEnabled` (`server/src/db/schema.ts` ~L265, scheduling_prefs block).
- Prefs plumbing lives in `server/src/services/prefs.ts` (`updatePrefs` whitelist +
  `serializePrefs`); `routes/prefs.ts` is a thin shell — do not add logic there.
- Migration style: 0137 (`addColumn`-if-missing via `PRAGMA table_info`) for the
  column; 0138 (`CREATE TABLE IF NOT EXISTS` + index) for the table. `export const
  id`, `up(db)`, append to `MIGRATIONS` in `migrations/index.ts`. **Numbers =
  next-free at build time** (head was 0138 when drafted).
- `uuid7()` UDF for PKs (raw-SQL insert convention, CON-1).
- Settings toggle idiom: the `memory_pull_enabled` / Time-Sense toggles in
  `client/src/views/Settings.tsx` (button-toggle bound to the prefs `form()`
  machinery — unlike CalibrationPins, which deliberately isn't; this IS a pref field).

## Before implementation

Read: `migrations/0137_close_ritual.ts`, `0138_calibration_history.ts`,
`services/prefs.ts` (whole file — find the boolean whitelist), `test/helpers.ts`
`resetDb`, the Time-Sense toggle block in `views/Settings.tsx`.

## Files impacted

- **New:** `server/src/db/migrations/<next-free>_triality_flag.ts`,
  `server/src/db/migrations/<next-free+1>_triality_log.ts`
- **Changed:** `server/src/db/migrations/index.ts`, `server/src/db/schema.ts`
  (scheduling_prefs column + `trialityLog` table), `server/src/services/prefs.ts`,
  `server/test/helpers.ts` (resetDb), `client/src/views/Settings.tsx`,
  `client/src/lib/api.ts` (prefs type)

## Schema required

- `scheduling_prefs.triality_enabled` INTEGER boolean NOT-NULL-safe default `0`.
- `triality_log` exactly as design §7: `id` TEXT PK (uuid7) · `owner_id` TEXT NOT
  NULL REFERENCES owners(id) ON DELETE CASCADE · `shown_at` TEXT NOT NULL ·
  `local_date` TEXT NOT NULL ('YYYY-MM-DD', owner-tz) · `slot` TEXT NOT NULL
  ('habitual'|'contextual'|'novel' — enforced in code, **not** a CHECK constraint;
  repo convention) · `action_kind` TEXT NOT NULL ('task'|'routine'|'flight'|'template')
  · `action_ref` TEXT NOT NULL · `scores` TEXT NOT NULL (JSON) · `outcome` TEXT NOT
  NULL DEFAULT 'shown' · `outcome_at` TEXT.
  Index: `ix_triality_log_owner_date (owner_id, local_date)`.

## Definition of Done

- [ ] Fresh DB boots and migrates; both migrations idempotent on re-run
- [ ] `GET /api/prefs` includes `triality_enabled: false` by default; PATCH flips it
- [ ] Settings shows the toggle (copy: "Triality — three next-action suggestions on
      Balance → Metrics"), persisted via the normal prefs form
- [ ] `resetDb` clears `triality_log`
- [ ] Flag-off behavior everywhere else is byte-identical (no other surface reads it yet)

## Tests

- [ ] migration idempotency: run `up` twice on one DB, no throw, single column/table
- [ ] prefs round-trip: PATCH `{triality_enabled: true}` → GET reflects it; bad value 422s
      consistent with the existing boolean-field handling in `updatePrefs`
- [ ] `resetDb` after an inserted `triality_log` row leaves the table empty
- [ ] client: Settings toggle renders and dispatches the PATCH (existing Settings test idiom)

Verify: `pnpm --filter server test` · `pnpm --filter client test` · `pnpm typecheck`
(server) · `pnpm --filter client typecheck` — all green, `TZ=UTC`.

## Acceptance Criteria

A flag-off owner's API traffic and UI are indistinguishable from main before this
ticket, except that `GET /api/prefs` carries one new false field and Settings shows
one new toggle.

## Subtasks

1. Column migration + schema.ts + MIGRATIONS append
2. Table migration + schema.ts + MIGRATIONS append + resetDb
3. prefs service whitelist + serialize + api.ts type
4. Settings toggle
5. Tests per section above
