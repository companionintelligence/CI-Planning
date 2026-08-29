> **Type:** Backend
> **Phase:** Revision-loop wave — the agent loop's write-only log
> **Branch:** `feat/plan-loop-capture`
> **Commit style:** `feat(learning): capture §A0 loop revisions as durable evidence`
> **Design:** [README.md](README.md)
> **Dependencies:** Blocked by ticket 1 (tables must exist). Blocks 3–4.

## Goal

Make the loop's revision log readable: every `runLoop` revision lands as a parseable
row in `plan_revision_log`, and every completed run lands as one row in
`plan_loop_runs` — while the existing compact `plan_revision` row in `audit_log`
keeps being written **byte-for-byte identically**. Merge this early: the corpus
starts accruing the day it lands, and nothing can recover history from before it.

## Non-goals

- **Do not change what reaches `audit_log`.** The same `plan_revision` audit row,
  same shape, same 4000-char cap, same fire-and-forget path. No readers of
  `audit_log` are added anywhere.
- **Do not change `runLoop`'s contract or behaviour** — same clauses, same
  defaults, same return value. The ONLY edit to `loop.ts` is adding `export` to the
  existing `auditRecord` function so the new sink can reuse it (loop.test.ts's 20
  call sites inject their own `record` and are untouched).
- **Do not make `writeAudit` awaited or `record` async.** The sink stays a
  synchronous `void` callback; durability-for-tests comes from a flush helper, not
  from blocking the plan path.
- **Do not throw from any evidence write.** A failed evidence insert must never
  break plan authoring — same posture as `writeAudit` (audit.ts:4-6).
- **Do not record anything in deterministic mode.** When `runLoop` is never called
  (smart mode off, or Ollama not ready — plan.ts:728), no rows are written. A run
  that didn't happen is a gap, not a data point.
- **Do not touch the other Phase M stages** (A3 rationale, A4 constraints, B4) —
  they don't go through `runLoop` today; wiring them is future work, not this wave.

## Pinned conventions

- **New service:** `server/src/services/plan-loop-learning.ts`, header comment
  stating the house contract (durable evidence → deterministic batch → bounded
  read; never online; no knobs) the way `classification-learning.ts:9-38` does, and
  that the audit row is unchanged on purpose. Exports for this ticket:
  - `recordPlanRevision(runId: string, ownerId: string, stage: string, rev: Revision): void`
    — inserts one `plan_revision_log` row AND calls the re-exported `auditRecord`
    (so the audit trail is written from exactly one place, unchanged).
  - `recordPlanRun(runId: string, ownerId: string, stage: string, result: LoopResult<unknown>, escapeReason: string | null): void`
    — inserts the `plan_loop_runs` row with `id = runId`.
  - `flushPlanLoopWrites(): Promise<void>` — awaits in-flight inserts; copy the
    floated-promise + `inFlight: Set<Promise<void>>` + drain-loop pattern from
    `lib/audit.ts:23-59` verbatim, including the swallow-rejection `.then(()=>{},()=>{})`.
- **Column values (pin exactly):**
  - `id`: `newId()` from `server/src/lib/ids.js`; `at`: `new Date().toISOString()`.
  - `defects`: `JSON.stringify(rev.defects.map((d) => d.rule))` — rule codes only.
  - `critique`: `rev.critique.slice(0, 1000)`.
  - `candidate`: `const c = JSON.stringify(rev.candidate); c.length > 8000 ? null : c`
    — NULL over truncation, because a sliced string is invalid JSON (the exact
    defect this wave exists to fix). The A1 candidate is a small number array;
    NULL should never occur in practice.
  - `passed`/`escaped`: `result.passed ? 1 : 0`, `result.escaped ? 1 : 0`.
- **Wiring in `agents/plan.ts`** (the single production `runLoop` call, ~line 747):
  1. Before the call: `const runId = newId();` and `let escapeReason: string | null = null;`.
  2. Pass `record: (ownerId, stage, rev) => recordPlanRevision(runId, ownerId, stage, rev)`
     in the options object (today no `record` is passed, so the default audit-only
     sink fires — the new sink must subsume it, hence the auditRecord re-use).
  3. In the existing `onEscape` callback (which currently only logs), add
     `escapeReason = info.reason;` — keep the log line.
  4. After `await runLoop(...)` returns:
     `recordPlanRun(runId, owner, 'order', result, escapeReason);` — fire-and-forget,
     placed BEFORE the existing `if (result.escaped) signalPlanNeedsReview(...)`
     (plan.ts:822).
  5. The `catch` block (plan.ts:824, mid-loop LLM death) writes nothing extra: any
     revisions already recorded stand as orphans (the no-FK design from ticket 1),
     and no runs row is written for a run that threw.
- **SQL style:** `store().prepare('INSERT INTO ...').run(...)` with positional `?`
  params, matching `lib/audit.ts:26-30`.

## Before implementation

Read `server/src/agents/loop.ts` in full (Revision/LoopResult shapes, `auditRecord`
at line 133, the `record` option at 114-115), `server/src/lib/audit.ts` in full (the
floated-promise pattern you are copying and the reason it exists), and
`server/src/agents/plan.ts:720-840` (the call site, its onEscape, its catch, and
`signalPlanNeedsReview`).

## Files impacted

**New:**
- `server/src/services/plan-loop-learning.ts`
- `server/test/plan-loop-capture.test.ts`

**Changed:**
- `server/src/agents/loop.ts` — `export` keyword on `auditRecord` only
- `server/src/agents/plan.ts` — the five wiring points above

## Schema required

None — ticket 1 created the tables.

## Definition of Done

- [ ] A smart-mode plan run writes one `plan_loop_runs` row and one
      `plan_revision_log` row per iteration, all sharing `run_id`
- [ ] The same run still writes the same `plan_revision` audit rows as before
      (count and shape unchanged)
- [ ] A deterministic-mode run writes zero rows to all three destinations
- [ ] An evidence-insert failure neither throws nor prevents the plan from
      persisting
- [ ] `loop.test.ts` passes unmodified

## Tests

New `server/test/plan-loop-capture.test.ts`, driving `runLoop` directly with mock
generate/judge callbacks (the loop.test.ts pattern — no Ollama), with the `record`
sink wired to the real service, then `await flushPlanLoopWrites()` before every
assertion:

- [ ] A run that passes on iteration 1 → one runs row (`passed=1, escaped=0,
      escape_reason NULL, iterations=1`) + one revision row (`iter=1,
      reason='judged'`, `defects='[]'`)
- [ ] A run that revises then plateaus → runs row has `escaped=1,
      escape_reason='plateau'`; revision rows are `iter` 1..n under one `run_id`
- [ ] A deterministic-fail iteration stores `score=0`,
      `reason='deterministic-fail'`, and the defect rule codes as a JSON array
      (parse it back and assert deep equality)
- [ ] `candidate` round-trips: `JSON.parse` of the stored column deep-equals what
      `describe()` returned
- [ ] The audit row still lands: after `flushAudits()`, `audit_log` has one
      `action='plan_revision'` row per iteration (import `flushAudits` from
      `lib/audit.js`)
- [ ] Rows are owner-scoped: two owners' runs never share `owner_id`
- [ ] `critique` longer than 1000 chars is stored capped at exactly 1000

```bash
pnpm --filter server exec vitest run server/test/plan-loop-capture.test.ts
pnpm --filter server exec vitest run server/test/loop.test.ts
pnpm typecheck
```

## Acceptance Criteria

- [ ] Given smart mode with Ollama ready, when a day plan is authored, then the
      full generate→judge history of that run is reconstructable by JOINing
      `plan_loop_runs` to `plan_revision_log` on `run_id`
- [ ] Given the loop stalls, then `escape_reason` records which bound tripped
      ('plateau' | 'max-iterations' | 'budget')
- [ ] Given `audit_log` before and after this change for an identical run, the
      `plan_revision` rows are indistinguishable
- [ ] Given the DB insert of evidence fails, the owner still gets their plan

## Subtasks

1. [ ] Export `auditRecord` from `loop.ts` (no other loop.ts change)
2. [ ] Write `services/plan-loop-learning.ts` (record × 2, flush, header contract comment)
3. [ ] Wire the five points in `plan.ts`
4. [ ] Write `plan-loop-capture.test.ts` (seven cases above)
5. [ ] Run the verification commands, then the full suite
