> **Type:** Refactor · **Phase:** LLM streamline (2026-08-13) · **Branch:** `refactor/config-modes-and-pins` · **Commit style:** `refactor(config): one shape for connector modes and env pins` · **Design:** this ticket is the spec · **Dependencies:** llm-1 (tier vocabulary touches the same config block)

> **STATUS: DRAFT — pending owner approval of the breakdown. Do not create as an issue yet.**

## Goal

`lib/config.ts` is documented as the single source of truth for environment
(`GoogleConfig`, `:64-70`: *"later WPs consume this block; they do NOT re-derive these values from
env"*). Three things break that promise, and one word — **"pin"** — now means three unrelated
things in this codebase.

### 1. Two connectors, two mode mechanisms

| | Google | Memory |
|---|---|---|
| Values | `'live' \| 'fixture' \| 'off'` | `'live' \| 'fixture' \| 'off'` — identical |
| Read at | `lib/config.ts:251-255`, once at boot | `connectors/memory.ts:131-135`, **per call** |
| Exposed as | `config.google.mode` | `memoryMode()` |
| Env-pinned flag | `config.google.envPinned` | none |
| Fixture-in-prod guard | `lib/config.ts:473-486` | `lib/config.ts:488-502` — copy-paste of the same 14 lines |

`MEMORY_MODE` is therefore read in **two** files, and `config.ts` reads it only to enforce a guard
over a value it does not store. `memory.ts:24-26` documents the per-call read as deliberate (tests
toggle it) — that is a real constraint, but it is a reason for a *lazy accessor on config*, not a
reason for a second mechanism.

`CI_SERVER_URL` is likewise read in both `connectors/memory.ts` and `routes/memory.ts`.

### 2. Three shapes for "the operator pinned this via env"

- `config.ollamaPinned: { small, medium, embed }` (`:161-163`) — a per-tier record
- `config.google.envPinned: boolean` (`:84-86`) — a scalar on the sub-config
- `config.vapidEnvPinned: boolean` (`:168-170`) — a scalar at top level

Three names, three placements, one idea. Every consumer re-learns the local convention.

### 3. "Pin" means three unrelated things

| Meaning | Site |
|---|---|
| Operator env pin | `config.ollamaPinned`, `lib/models.ts:211` (`ModelSource = 'pin'`) |
| User-pinned estimate scope | `calibration_combo_pins`, `services/calibration.ts:143-145`, `client/src/components/CalibrationPins.tsx` |
| Pinned task start time | "Time PINS are applied…", `agents/plan.ts:844`; the AD1 pin pass |

Three domain nouns sharing one word, in a codebase where a reader is expected to grep.

### 4. Dead config that looks like a security control

`AuthConfig.kekB64` (`:35-37`) is parsed from `CP_KEK_B64` and **never read** — the real consumer
reads `process.env` directly. The file's own comment at `:25-31` argues that config fields which
look like controls but enforce nothing should be removed, then keeps this one "for parity".

### 5. Two `.env.example` files with no stated contract

Root (37 lines, docker-compose only) and `server/.env.example` (246 lines). Neither says which one
an operator should copy for which path. `docs/recap_state_A-S.md:181` already flags the server
one as mostly-commented.

## Non-goals

- **Do not change any resolved value.** Every mode, pin, and guard resolves to exactly what it
  resolves to today. This is shape and naming only.
- **Do not rename `calibration_combo_pins` or its routes/columns.** That is a DB + REST + UI
  rename with real migration cost and no LLM benefit. Scope here is limited to *documenting* the
  collision (a glossary note in `ARCHITECTURE.md` and a comment at each of the three sites).
- Do not merge the two `.env.example` files. Give each a one-line header saying which install path
  it serves and cross-referencing the other.
- Do not move `CP_KEK_B64` itself out of `process.env` — `lib/crypto` reads it directly by design
  (it must work before config is constructed). Only the unused `AuthConfig.kekB64` field goes.
- Do not add config validation framework (zod et al). The hand-written fail-closed guards are the
  house style and they read well; only the two duplicated fixture guards get factored.

## Pinned conventions

- New shared shape in `lib/config.ts`, above the interfaces:
  ```ts
  /** A connector whose transport is env-selected. `envPinned` = the env named the mode
   *  explicitly, so any in-app override is read-only. */
  export type ConnectorMode = 'live' | 'fixture' | 'off';
  export interface ModeConfig { mode: ConnectorMode; envPinned: boolean; }
  ```
  `config.google` keeps its extra fields and satisfies `ModeConfig`. `config.memory: ModeConfig`
  is added, with `mode` as a **getter** so the per-call re-read `connectors/memory.ts:24-26`
  relies on is preserved exactly.
- One helper replaces the two copy-pasted guards:
  ```ts
  function refuseFixtureInProduction(envVar: string, whatItServes: string): void
  ```
  Both call sites keep their current message text verbatim — the messages are good and operators
  may be grepping for them.
- Env pins converge on one shape: `config.pins: { ollama: { fast, quality, embed }, google, vapid }`
  — one place a reader looks to answer "what did the operator fix by hand?".
  `ModelSource = 'pin'` (`lib/models.ts:211`) keeps its name; it is now the only "pin" in the LLM
  path and its meaning is stated once.
- `connectors/memory.ts` keeps `memoryMode()` as a thin re-export of `config.memory.mode`, so no
  caller churns and the test-toggle behavior is provably unchanged.
- Comment style stays constraint-stating, matching the surrounding file.

## Before implementation

1. `server/src/lib/config.ts` — the whole file, especially `:64-87` (GoogleConfig + envPinned),
   `:141-179` (Config), `:245-255`, `:273-277`, `:473-502` (the twin guards).
2. `server/src/connectors/memory.ts:20-37, 126-135` — the documented per-call-read constraint.
3. `server/src/routes/memory.ts` — the second `CI_SERVER_URL` reader.
4. `server/src/services/{google-config,vapid-config}.ts` — the two runtime hot-apply paths that
   consume `envPinned`; confirm the new `config.pins` shape does not break their read-only checks.
5. `server/test/settings-models-memory.test.ts` and any test that sets `MEMORY_MODE` mid-run — the
   getter must keep those green.

## Files impacted

**Changed:**
- `server/src/lib/config.ts` — `ConnectorMode` / `ModeConfig`, `config.memory`, `config.pins`, `refuseFixtureInProduction`, delete `AuthConfig.kekB64`
- `server/src/connectors/memory.ts` — `memoryMode()` delegates; `CI_SERVER_URL` via config
- `server/src/routes/memory.ts` — read the same config field
- `server/src/lib/models.ts`, `server/src/mcp/ollama.ts` — `config.ollamaPinned` → `config.pins.ollama`
- `server/src/services/google-config.ts`, `server/src/services/vapid-config.ts` — `envPinned` reads
- `server/src/routes/llm.ts:48` — `config.google.envPinned` read
- `server/src/services/calibration.ts`, `client/src/components/CalibrationPins.tsx`, `server/src/agents/plan.ts` — one comment each disambiguating "pin"
- `.env.example`, `server/.env.example` — one header line each
- `ARCHITECTURE.md` — a short glossary entry for the three "pin" meanings; `README.md:1602, 1624` — note `MEMORY_MODE` now lives in config

**New:** none.

## Schema required

None. No DB change.

## Definition of Done

- [ ] `grep -rn "process.env.MEMORY_MODE\|process.env.CI_SERVER_URL" server/src` returns hits only
      in `lib/config.ts`.
- [ ] `grep -rn "ollamaPinned\|envPinned\|vapidEnvPinned" server/src` returns only `config.pins.*`.
- [ ] `AuthConfig.kekB64` no longer exists; `CP_KEK_B64` still works (crypto reads it directly).
- [ ] The fixture-in-production guard exists once; both messages are unchanged strings.
- [ ] Each of the three "pin" sites carries a comment naming which pin it is and linking the other
      two; `ARCHITECTURE.md` has the glossary entry.
- [ ] Both `.env.example` files state which install path they serve.

## Tests

- [ ] `server/test/settings-models-memory.test.ts` — passes unedited (proves the getter preserved
      the per-call read).
- [ ] New `server/test/config-modes.test.ts`: `MEMORY_MODE` flipped after config construction is
      observed by `memoryMode()`; `GOOGLE_MODE` is **not** re-read (it is boot-pinned by design) —
      encoding the deliberate asymmetry so nobody "fixes" it later.
- [ ] New case: `MEMORY_MODE=fixture` + `NODE_ENV=production` + no `CP_ALLOW_FIXTURE` throws with
      the exact existing message; same for `GOOGLE_MODE`.
- [ ] New case: `OLLAMA_FAST` set ⇒ `config.pins.ollama.fast === true`.
- [ ] `server/test/memory-connector.test.ts`, `memory-ciportal.test.ts` unchanged.

```
pnpm --filter server typecheck
pnpm --filter server test
NODE_ENV=production MEMORY_MODE=fixture pnpm --filter server start   # must refuse to boot
```

## Acceptance Criteria

- [ ] Given an operator asking "what have I pinned by env", when they read `config.pins`, then
      every env-pinned decision in the app is in one object.
- [ ] Given a reader greps `pin`, then each hit says which of the three pins it is.
- [ ] Given every existing boot guard, then each still fires with its current message.

## Subtasks

1. [ ] Add `ConnectorMode` / `ModeConfig` / `config.memory` getter; delegate `memoryMode()`.
2. [ ] Move `CI_SERVER_URL` into config; fix both readers.
3. [ ] Factor `refuseFixtureInProduction`; verify both messages byte-identical.
4. [ ] Introduce `config.pins`; migrate the three consumers.
5. [ ] Delete `AuthConfig.kekB64`; confirm `CP_KEK_B64` still resolves via `lib/crypto`.
6. [ ] Add the three "pin" disambiguation comments + the `ARCHITECTURE.md` glossary entry.
7. [ ] Header both `.env.example` files; update `README.md` env tables.
8. [ ] Add `config-modes.test.ts`.
