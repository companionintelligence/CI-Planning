> **Type:** DB Migration + Frontend
> **Phase:** Balance-targets wave — stated targets reach the scheduler
> **Branch:** `feat/balance-bias-pref`
> **Commit style:** `feat(prefs): balance_bias_enabled toggle (default on)`
> **Design:** [README.md](README.md)
> **Dependencies:** None (parallel with ticket 1)

## Goal

Add `scheduling_prefs.balance_bias_enabled` (default ON — owner ruling 2026-08-29) and
wire it end-to-end: migration → schema.ts mirror → GraphQL prefs map → client api type
→ Settings toggle. Tickets 3 and 4 gate every behavioural change on it.

## Non-goals

- **Do not gate the suggest surface (ticket 5) or the weekly snapshot (ticket 6) on
  this pref.** It gates BIAS only — the pure-read surfaces stay, like the drawer does.
- **Do not nest it under `time_sense_enabled`.** Unlike `calibration_loop_enabled`,
  this is not a Time-Sense channel; it renders unconditionally in the Planning
  section of Settings.
- **Do not add an env var, a strength dial, or per-dimension toggles.**
- **Do not consume the pref anywhere yet** — no engine/agents change in this ticket.

## Pinned conventions

- **Migration:** `server/src/db/migrations/0159_balance_bias_pref.ts` — **slot
  assumed**: head here is 0156; the close-loop wave reserves 0157/0158; two sibling
  waves are planning in parallel. Renumber file, `export const id`, and the
  `migrations/index.ts` import position to the actual head at implementation time
  (README, cross-wave section). Skeleton (copy 0156 exactly):
  - Line 1 `import type { Database } from 'better-sqlite3';`
  - `export const id = '0159_balance_bias_pref';`
  - Block comment saying WHY (targets-reach-placement wave; bias gate; default on by
    owner ruling; suggest surface deliberately not gated)
  - `hasColumn` guard via `PRAGMA table_info` (SQLite has no ADD COLUMN IF NOT
    EXISTS — mirror 0156's helper verbatim), then
    `ALTER TABLE scheduling_prefs ADD COLUMN balance_bias_enabled INTEGER NOT NULL DEFAULT 1;`
  - Idempotent, forward-only, no `down`. Register in `migrations/index.ts` with a
    `.js` import appended in numeric order.
- **schema.ts mirror** (parity test `server/test/schema-parity.test.ts` fails
  otherwise): in the `scheduling_prefs` table object next to
  `capacityHoursPerWeek` (`schema.ts:338`):
  `balanceBiasEnabled: integer('balance_bias_enabled').notNull().default(1),`
- **Entity mirror:** add the column to
  `server/src/db/entities/SchedulingPrefsEntity.ts` following the
  `calibration_loop_enabled` column's decorator shape in that file.
- **GraphQL:** `server/src/graphql/prefs-resolvers.ts` — add
  `['balanceBiasEnabled', 'balance_bias_enabled'],` to the field map (line ~106
  block) and a `balanceBiasEnabled: (p: Row) => !!p.balanceBiasEnabled,` resolver
  (line ~264 block), mirroring `calibrationLoopEnabled` byte-for-byte in style. Add
  the field to the SDL type where `calibrationLoopEnabled` is declared.
- **Client api:** `client/src/lib/api.ts` prefs interface (~line 1286):
  `balance_bias_enabled?: boolean; // balance-targets wave: bias gate (default true)`
- **Settings:** `client/src/views/Settings.tsx` — extend the `Prefs` type (line 46
  cluster), the `ToggleField` union (line 56), the defaults object (line 74:
  `balance_bias_enabled: true`), the load mapping (line ~224:
  `balance_bias_enabled: p.balance_bias_enabled ?? true,`), and render in the
  Planning section (NOT inside the Time-Sense `<Show>`):
  `<Toggle field="balance_bias_enabled" label="Balance bias" hint="Nudge auto-planning toward life dimensions running behind their weekly target." />`
- **REST prefs route:** whatever route persists Settings prefs today must accept the
  key — find it by tracing where `calibration_loop_enabled` is whitelisted
  server-side and add the field in the same place(s).

## Before implementation

Read `db/migrations/0156_capacity_hours_per_week.ts` (skeleton + guard),
`test/schema-parity.test.ts` (why the mirror is mandatory),
`graphql/prefs-resolvers.ts:80-120` and `:250-270`, `views/Settings.tsx:40-80`,
`:215-230`, `:1355-1372`, and grep `calibration_loop_enabled` across `server/src` to
enumerate every wiring point.

## Files impacted

**New:**
- `server/src/db/migrations/0159_balance_bias_pref.ts`

**Changed:**
- `server/src/db/migrations/index.ts`
- `server/src/db/schema.ts`
- `server/src/db/entities/SchedulingPrefsEntity.ts`
- `server/src/graphql/prefs-resolvers.ts` (+ SDL file where SchedulingPrefs is declared)
- server prefs route file (whitelist — path found via the grep above)
- `client/src/lib/api.ts`
- `client/src/views/Settings.tsx`

## Schema required

`scheduling_prefs.balance_bias_enabled INTEGER NOT NULL DEFAULT 1` — no index, no FK.

## Definition of Done

- [ ] Migration applies idempotently (run twice; second run no-ops)
- [ ] `pnpm --filter server exec vitest run server/test/schema-parity.test.ts` passes
- [ ] Toggle renders in Settings Planning section, persists a round-trip, defaults ON
- [ ] GraphQL exposes `balanceBiasEnabled` read/write

## Tests

- [ ] schema-parity green (covers migration ↔ schema.ts)
- [ ] Prefs round-trip: save false → reload → false; absent → true (extend the
      existing prefs/settings server test where `calibration_loop_enabled` is covered)

```bash
pnpm --filter server exec vitest run server/test/schema-parity.test.ts
pnpm typecheck && pnpm test
```

## Acceptance Criteria

- [ ] Given a fresh DB, when migrations run, then the column exists with default 1
- [ ] Given the toggle turned off in Settings, when prefs reload, then it stays off

## Subtasks

1. [ ] Grep `calibration_loop_enabled` server+client; list every wiring point
2. [ ] Write migration + register; renumber to actual head if it moved
3. [ ] Mirror in schema.ts + entity; run parity test
4. [ ] Wire GraphQL map/resolver/SDL + REST whitelist
5. [ ] Wire api.ts + Settings toggle
6. [ ] Run verification
