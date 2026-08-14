> **Type:** Refactor · **Phase:** LLM streamline (2026-08-13) · **Branch:** `refactor/llm-degrade-contract` · **Commit style:** `refactor(llm): one degrade contract and one availability predicate` · **Design:** this ticket is the spec · **Dependencies:** llm-2 (call policy)

> **STATUS: READY. Re-verified against `main` @ `b110ff9` on 2026-08-14, after llm-1/2/4/5/6 merged — every line anchor below was checked by READING the file, not grepping. Four corrections from the first draft are marked ⚠️ inline.**

## Goal

"Ollama might be down, degrade gracefully" is the codebase's most-repeated rule and its
least-consistent implementation. There are **six** degrade shapes and **two disagreeing
availability predicates** for one contract.

### The six shapes

⚠️ Line anchors re-verified 2026-08-14 against `main` @ `b110ff9`; llm-2 and llm-4 shifted several
of these files, so the first draft's numbers are stale and these supersede them.

| Shape | Sites |
|---|---|
| `try { … } catch { return [] }` — swallow everything, no log | `agents/tags.ts:48`, `agents/subtasks.ts:72` |
| `catch { return { …, reason: err.message } }` — reason string in the result | `services/task-enrich.ts:176` |
| `catch → deterministic template pool` + `logger.warn` | `agents/render-copy.ts:320` |
| `catch (err) { if (!(err instanceof OllamaUnavailable)) throw err; … }` | `agents/ingest.ts:321`, `agents/memory-suggest.ts:320` |
| `catch { /* best-effort */ }` — empty map, no log | `agents/plan.ts:599` |
| pre-flight probe, then call | `agents/plan.ts:720`, `agents/plan.ts:938`, `services/triality-rationale.ts:242` |

Note `services/task-enrich.ts:144` and `agents/render-copy.ts:257` are also `catch` blocks but are
NOT LLM paths (a memory-search failure and a malformed stored signature respectively) — leave both
alone and say so in the PR body, so a reviewer running the DoD grep knows they are expected.

### The predicate bug

⚠️ **CORRECTION (2026-08-14): there are THREE `isAvailable()` call sites, not one.** The first
draft named only the authoring pre-flight. Verified by reading `agents/plan.ts` and
`scripts/seed-test-data.ts`:

| Site | What it gates | Effect of the swap |
|---|---|---|
| `agents/plan.ts:720` | `authorPlanOrder` smart-mode pre-flight | The bug as originally described: the full loop runs against an unusable Ollama. |
| `agents/plan.ts:938` | `parseInstruction` — throws `InstructError('unavailable')`, which the route maps to **503** | ⚠️ **User-visible.** Today a reachable-but-unpulled Ollama passes this gate and then fails deeper with a confusing model-not-found error; on `ready` it 503s cleanly with "AI is unavailable". An improvement, but it changes what the NL-instruct surface returns and MUST be called out in the PR. |
| `scripts/seed-test-data.ts:187` | `--no-llm` seeding decision | Behaviour-neutral, but it imports `isAvailable` so it must be migrated when the export is deleted. |

The predicates themselves:

- `isAvailable()` is `(await status()).available` (`mcp/ollama.ts:347-349`) — "Ollama answered
  `/api/tags`".
- `services/triality-rationale.ts:242` — `(await status()).ready`, with the comment
  *"`ready`, not `available` — a reachable Ollama whose model isn't pulled fails every call."*

`available` is precisely the signal `lib/models.ts:12-17` and `mcp/ollama.ts:152-160` were written
to stop anyone trusting: it is a green light with nothing behind it. The client already gates on
`ready` (`client/src/stores/index.ts:355`). So **`plan.ts` runs the full generate→judge→revise
loop against an Ollama that cannot serve a single call**, burns the loop's call budget on
failures, and lands on the deterministic baseline the long way around. Fixing this is the one
behavior change this ticket makes, and it is a fix, not a refactor.

## Non-goals

- **Do not wrap the `runLoop` stage callbacks in `llmOrNull` — they must keep THROWING.**
  (Added 2026-08-13, owner review.) The `generate`/`judge`/`revise` callbacks handed to
  `runLoop` in `agents/plan.ts:748-784` are governed by the loop's own error contract
  (`agents/loop.ts:232`): a genuine generator/judge transport error propagates OUT of the
  loop to the authoring caller, which catches it and falls back to the deterministic
  baseline. A `null` returned INTO the loop instead would flow through `check()`/`judge()`
  as a candidate, silently breaking the stall→baseline escape hatch and the call-budget
  accounting — undoing the §A0 runner design. `llmOrNull` is for best-effort garnish paths
  (rationales, tags, subtasks), never for loop stages. The DoD's "zero bare swallows" rule
  does NOT apply inside loop stage callbacks; the loop and its caller ARE the handler.
  Corollary for `render-copy.ts`: preserve the two distinct exits — transport failure →
  break straight to the rotation pool; gate rejection → regenerate once. The conversion
  must not blur them.
- **Do not change any caller's OBSERVABLE degraded output.** `suggestTags` still returns `[]`,
  `enrichTaskFromMemory` still returns `{enriched:false, reason}`, `renderCopy` still returns a
  pool line, `ingest` still stages `fallbackTask`. Only the plumbing converges.
- Do not remove the injectable seams (`MotivationLLM`, `generateFn`, `embedFn`, `deps.graphData`).
  Consolidating those is out of scope; they are how the tests stay offline.
- Do not add retries. `runLoop` (`agents/loop.ts`) owns bounded retry for authoring stages, and a
  blanket transport retry would multiply latency on the interactive quick-add path.
- Do not touch `mcp/client.ts`'s circuit breaker or `MemoryUnavailable` — connector error
  unification is llm-7.

## Pinned conventions

- ⚠️ **CORRECTION (2026-08-14): a typed parse error is a PREREQUISITE, not an optional extra.**
  The first draft said `llmOrNull` returns `null` on "`OllamaUnavailable` or a JSON-parse failure"
  and re-throws everything else. That is **not implementable as written**: `parseJsonLoose`
  (`mcp/ollama.ts:198-215`) throws a bare `new Error(...)`, indistinguishable from a genuine bug
  except by matching its message string. So this ticket must FIRST add:
  ```ts
  /** Thrown when a model reply cannot be parsed as JSON. Distinct from a caller bug, so
   *  `llmOrNull` can degrade on it without swallowing real errors. */
  export class LlmParseError extends Error { … name = 'LlmParseError' }
  ```
  thrown by `parseJsonLoose` in place of the bare `Error`. Callers that catch broadly are
  unaffected (it still extends `Error`); nothing else changes.
- One helper in `server/src/mcp/ollama.ts` — place it after `resolveCall`/`generateJson` (the file
  gained `CallPolicy`/`CALL_POLICY`/`resolveCall` in llm-2 and is now ~351 lines):
  ```ts
  export async function llmOrNull<T>(
    op: string,                       // log key, e.g. 'suggestTags'
    fn: () => Promise<T>,
  ): Promise<T | null>
  ```
  Returns `null` on `OllamaUnavailable` **or** `LlmParseError` (the two failures every caller
  currently conflates), `logger.warn`s once with `{ op, err }`, and **re-throws anything else** —
  matching the existing `ingest.ts:321` rule, the only site that gets this right today.
- `isAvailable()` is **deleted**. It is replaced by `isReady()` (`(await status()).ready`), which
  is what both the client and `triality-rationale.ts` already mean by "can we call the model".
  `status().available` stays on the status object for the Settings card, which legitimately shows
  reachable-vs-usable as distinct states (`client/src/views/Settings.tsx:1698-1721`).
- Callers that must report *why* they degraded keep their own `catch` (task-enrich's `reason`
  string is a user-visible contract) but call `llmOrNull` inside it — never a bare `catch {}`.
- Every degrade path logs at most once, at `warn`, with the op name. Silent `catch {}` is banned;
  `plan.ts:601-603` and `tags.ts:45-47` are the two sites that currently violate this.

## Before implementation

1. `server/src/mcp/ollama.ts:18-24, 43-65, 105-131, 263-266` — the error class, the error builder,
   `parseJsonLoose`, `isAvailable`.
2. Every site in the two tables above, at the cited lines.
3. `server/src/agents/plan.ts:690-800` — the loop wiring, to confirm the `isAvailable → isReady`
   swap changes only the pre-flight branch and not the in-loop `catch`.
4. `server/test/plan-container.test.ts` and any test that stubs Ollama as reachable-but-empty —
   the predicate change may flip an assertion, and if it does, the OLD assertion was encoding the
   bug.

## Files impacted

**Changed:**
- `server/src/mcp/ollama.ts` — add `LlmParseError` (thrown by `parseJsonLoose`), `llmOrNull` and `isReady`; delete `isAvailable`; drop it from the `ollama` object export at :351
- `server/src/scripts/seed-test-data.ts:25,187` — ⚠️ migrate its `isAvailable` import/use to `isReady` (missed by the first draft)
- `server/src/agents/tags.ts` — `catch {}` → `llmOrNull`, gains a log
- `server/src/agents/subtasks.ts` — same
- `server/src/agents/plan.ts` — `isAvailable()` → `isReady()` at **:720 AND :938**; `generateRationales`'s silent catch (:599) → `llmOrNull`
- `server/src/agents/memory-suggest.ts`, `server/src/agents/ingest.ts` — `instanceof` blocks → `llmOrNull`, keeping their distinct fallbacks
- `server/src/agents/render-copy.ts` — keep the pool fallback, route the call through `llmOrNull`
- `server/src/services/task-enrich.ts` — keep the `reason` contract, drop the duplicate try/catch
- `server/src/services/triality-rationale.ts` — `(await status()).ready` → `isReady()`
- `server/src/scripts/seed-test-data.ts` — `isAvailable` import
- `ARCHITECTURE.md` — state the one contract in the AI section

**New:** none.

## Schema required

None.

## Definition of Done

- [ ] `grep -rn "isAvailable" server/src client/src` returns zero hits.
- [ ] `grep -rn "catch {" server/src/agents server/src/services | grep -v test` returns zero
      bare swallows on an LLM path (non-LLM sites — e.g. `JSON.parse` of a stored signature at
      `render-copy.ts:248-252` — are out of scope and must be listed in the PR body).
- [ ] `plan.ts` pre-flights on `ready`; a reachable Ollama with no pulled model authors the
      deterministic order **without** attempting the loop.
- [ ] Each degrade path emits exactly one `warn` naming its op.

## Tests

- [ ] New `server/test/llm-degrade.test.ts`: `llmOrNull` returns `null` on `OllamaUnavailable`,
      `null` on `LlmParseError`, and **re-throws** a `TypeError` (the guard against swallowing
      genuine bugs).
- [ ] `parseJsonLoose` throws `LlmParseError` on unparseable output, and it still satisfies
      `instanceof Error` so existing broad catches are unaffected.
- [ ] ⚠️ New: `parseInstruction` (`plan.ts:938`) returns `InstructError('unavailable')` when Ollama
      is reachable but the model is not pulled — the 503 path this ticket changes.
- [ ] New case in `server/test/plan-container.test.ts`: with `setInstalledModels([])` (reachable,
      nothing pulled), `authorPlanOrder` returns `'deterministic'` and makes **zero** calls to
      `/api/generate`. This is the regression test for the predicate bug.
- [ ] `server/test/render-copy.test.ts` — pool fallback still fires on transport failure.
- [ ] `server/test/memory-suggest.test.ts`, `server/test/tag-tasks-job.test.ts` — unchanged
      outputs on an unavailable model.

```
pnpm --filter server typecheck
pnpm --filter server test
```

## Acceptance Criteria

- [ ] Given Ollama is reachable but `fastModel` is not pulled, when a smart-mode day is authored,
      then the plan is deterministic, one warn is logged, and no generate request is issued.
- [ ] Given `suggestTags` hits a transport failure, then it returns `[]` **and** the failure is
      visible in the log (today it is not).
- [ ] Given a caller's own bug throws a `TypeError` inside an LLM callback, then it propagates and
      is not silently degraded away.

## Subtasks

1. [ ] Add `llmOrNull` + `isReady` to `mcp/ollama.ts`; write `llm-degrade.test.ts`.
2. [ ] Add the failing `plan-container` case for the `available`/`ready` bug; watch it fail.
3. [ ] Swap `plan.ts:722` to `isReady()`; the case passes.
4. [ ] Convert the silent-swallow sites (`tags`, `subtasks`, `plan.generateRationales`).
5. [ ] Convert the `instanceof` sites (`ingest`, `memory-suggest`) keeping their fallbacks.
6. [ ] Convert `render-copy`, `task-enrich`, `triality-rationale`.
7. [ ] Delete `isAvailable` and its `ollama` object entry; fix importers.
8. [ ] Document the one contract in `ARCHITECTURE.md`.
