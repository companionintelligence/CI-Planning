> **Type:** Refactor · **Phase:** LLM streamline (2026-08-13) · **Branch:** `refactor/llm-call-policy` · **Commit style:** `refactor(llm): name the call policies instead of repeating magic numbers` · **Design:** this ticket is the spec · **Dependencies:** llm-1 (tier vocabulary)

> **STATUS: DRAFT — pending owner approval of the breakdown. Do not create as an issue yet.**

## Goal

Every LLM call site currently hand-rolls `{ tier, temperature, timeoutMs }`. The same three
numbers are re-typed at 14 sites, and nothing says what the numbers MEAN — so a reader cannot
tell whether `temperature: 0.1` at one site and `0.2` at another is a deliberate difference or a
copy-paste drift, and tuning "all classifier calls" means finding all of them by grep.

Replace the loose triples with a small named policy table in `server/src/mcp/ollama.ts`, and have
call sites name a **purpose** instead of numbers.

Current spread (verified 2026-08-13):

| Site | tier | temp | timeout |
|---|---|---|---|
| `agents/tags.ts:39` | small | 0.1 | 15_000 |
| `agents/quickadd.ts:191` | small | 0.1 | 15_000 |
| `agents/quickadd.ts:207` | small | 0.1 | 15_000 |
| `services/motivation.ts:56` | small | 0.1 | 15_000 |
| `services/task-enrich.ts:199` | small | 0.2 | 20_000 |
| `agents/subtasks.ts:48` | small | 0.3 | 20_000 |
| `agents/memory-suggest.ts:237` | small | *(default 0.2)* | 30_000 |
| `agents/extract.ts:111-112` | medium | 0.1 | 60_000 |
| `agents/plan.ts:589-593` | small | 0.3 | 25_000 |
| `agents/plan.ts:748-752` | small | 0.2 | 25_000 |
| `agents/plan.ts:764-768` | medium | 0.1 | 30_000 |
| `agents/plan.ts:780-784` | small | 0.2 | 25_000 |
| `agents/plan.ts:945-949` | small | 0.1 | 25_000 |
| `agents/summarize.ts:395` | medium | 0.4 | 60_000 |
| `agents/render-copy.ts:307-308` | small/medium | 0.7 | 15_000/45_000 |
| `services/triality-rationale.ts:253` | small | 0.3 | *(caller budget)* |

Four distinct "constrained classifier" temperatures (0.1, 0.1, 0.2, 0.2) across calls that do
the same job, and `memory-suggest.ts` silently rides the `generate()` default of 0.2 while its
siblings state 0.1 explicitly.

## Non-goals

- **Do not change what any model actually receives** in this ticket. Every call site keeps the
  exact numbers it has today; the policy table's job is to NAME them, not to retune them. Any
  genuine retune is a separate, measured ticket (each prompt's header comment says why re-testing
  against a live model is mandatory — `agents/rubric.ts:15-17`).
- Do not change prompt text — that is llm-5.
- Do not change failure handling — that is llm-3.
- Do not introduce a provider abstraction. This codebase is deliberately Ollama-only and
  local-first (`services/plan-week.ts:11`); a pluggable-provider layer is not wanted.

## Pinned conventions

- The policy table lives in `server/src/mcp/ollama.ts` next to `GenerateOpts`, exported as
  `export const CALL_POLICY = { … } as const` with a `CallPurpose` union derived from its keys.
- `GenerateOpts` gains `purpose?: CallPurpose`. Explicit `tier`/`temperature`/`timeoutMs` still
  win when passed, so a one-off (render-copy's per-tier timeout) needs no new machinery.
- Each policy entry carries a one-line comment stating WHY those numbers — the repo's
  constraint-stating comment style (see `agents/rubric.ts`, `lib/models.ts` headers).
- Timeouts stay numeric-separator formatted (`15_000`).

## Proposed policy names (exact values preserved)

| Purpose | tier | temperature | timeoutMs | Sites it replaces |
|---|---|---|---|---|
| `classify` | fast | 0.1 | 15_000 | tags, quickadd ×2, motivation |
| `classify_wide` | fast | 0.2 | 20_000 | task-enrich |
| `brainstorm` | fast | 0.3 | 20_000 | subtasks |
| `extract` | quality | 0.1 | 60_000 | extract |
| `plan_generate` | fast | 0.2 | 25_000 | plan generate + revise |
| `plan_judge` | quality | 0.1 | 30_000 | plan judge |
| `plan_narrate` | fast | 0.3 | 25_000 | plan rationale, triality rationale |
| `plan_instruct` | fast | 0.1 | 25_000 | plan instruct |
| `suggest` | fast | 0.2 | 30_000 | memory-suggest (its implicit 0.2 becomes explicit) |
| `narrate` | quality | 0.4 | 60_000 | summarize |
| `voice` | per-surface | 0.7 | 15_000 / 45_000 | render-copy (keeps its `cfg.tier` override) |

Note the two entries that differ only by temperature (`classify` 0.1 vs `classify_wide` 0.2) —
that difference is preserved on purpose here, and is exactly the kind of question the named table
makes askable. Flag it in the PR body; do not resolve it in this ticket.

## Before implementation

1. `server/src/mcp/ollama.ts:32-103` — `GenerateOpts`, `generate`, `generateJson`.
2. Every row of the table above, at the cited line, to confirm the numbers still match.
3. `server/src/agents/render-copy.ts:296-321` — the one site with a computed timeout; confirm the
   override path works before converting it.
4. `server/src/services/triality-rationale.ts:240-256` — the one site whose timeout comes from a
   caller-supplied budget, not a constant; it passes `timeoutMs` explicitly and keeps doing so.

## Files impacted

**Changed:**
- `server/src/mcp/ollama.ts` — `CALL_POLICY`, `CallPurpose`, `GenerateOpts.purpose`, resolution in `generate()`
- `server/src/agents/{tags,quickadd,subtasks,extract,plan,summarize,render-copy,memory-suggest}.ts`
- `server/src/services/{motivation,task-enrich,triality-rationale}.ts`
- `ARCHITECTURE.md` — one paragraph in the AI/agents section naming the policy table as the single place call parameters live

**New:** none.

## Schema required

None.

## Definition of Done

- [ ] `grep -rn "temperature:" server/src --include="*.ts" | grep -v mcp/ollama.ts | grep -v test`
      returns zero hits.
- [ ] `grep -rn "timeoutMs:" server/src/agents server/src/services | grep -v test` returns only
      `render-copy.ts` and `triality-rationale.ts` (the two documented computed-timeout sites).
- [ ] Every `CALL_POLICY` entry has a comment saying why those numbers.
- [ ] The `classify` / `classify_wide` split is called out in the PR body as an open question.

## Tests

- [ ] New `server/test/llm-call-policy.test.ts`: for each purpose, assert the resolved
      `{tier, temperature, timeoutMs}` equals the value the old call site used — a table test
      driven by the table above, so a future retune must be deliberate.
- [ ] `server/test/ollama.test.ts` — assert an explicit `temperature`/`timeoutMs` still overrides
      the purpose's value.
- [ ] Existing agent tests pass unchanged (no mock-fixture edits should be needed; if one is,
      the ticket changed behavior and must be reworked).

```
pnpm --filter server typecheck
pnpm --filter server test
```

## Acceptance Criteria

- [ ] Given any call site converted by this ticket, when the request body reaching
      `${ollamaUrl}/api/generate` is captured, then it is byte-identical to before the change.
- [ ] Given a developer asked to raise every classifier timeout, then exactly one edit in
      `CALL_POLICY` accomplishes it.

## Subtasks

1. [ ] Add `CALL_POLICY` + `CallPurpose` + `purpose` resolution in `mcp/ollama.ts`.
2. [ ] Write `llm-call-policy.test.ts` FIRST, asserting the current numbers.
3. [ ] Convert the classifier sites (tags, quickadd ×2, motivation, task-enrich, subtasks).
4. [ ] Convert extract, memory-suggest, summarize.
5. [ ] Convert the four `plan.ts` sites and `triality-rationale.ts`.
6. [ ] Convert `render-copy.ts`, keeping its per-surface tier + timeout override.
7. [ ] Update `ARCHITECTURE.md`.
