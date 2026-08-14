# LLM streamline wave — plan of record

Nine tickets removing duplication from the LLM path, connector config, and the connections
surface. Each `llm-N-*.md` in this folder is a full commit recipe. **This file is the live
status; update it as tickets land.**

Opened 2026-08-13.

## Status

| # | Ticket | Status | PR | Blocked by |
|---|---|---|---|---|
| 1 | [tier vocabulary](llm-1-tier-vocabulary.md) | ✅ merged 2026-08-14 | [#522](https://github.com/companionintelligence/CI-Planning/pull/522) | — |
| 2 | [call policy](llm-2-call-policy.md) | ✅ merged 2026-08-14 | [#526](https://github.com/companionintelligence/CI-Planning/pull/526) | 1 ✅ |
| 3 | [degrade contract](llm-3-degrade-contract.md) | ✅ merged 2026-08-14 | [#529](https://github.com/companionintelligence/CI-Planning/pull/529) | 2 ✅ |
| 4 | [classifier merge](llm-4-classifier-merge.md) | ✅ merged 2026-08-14 | [#525](https://github.com/companionintelligence/CI-Planning/pull/525) | 1 ✅ |
| 5 | [prompt single owner](llm-5-prompt-single-owner.md) | ✅ merged 2026-08-14 (re-scoped) | [#521](https://github.com/companionintelligence/CI-Planning/pull/521) | — |
| 6 | [config modes and pins](llm-6-config-modes-and-pins.md) | ✅ merged 2026-08-14 | [#524](https://github.com/companionintelligence/CI-Planning/pull/524) | 1 ✅ |
| 7 | [connections one surface](llm-7-connections-one-surface.md) | ✅ merged 2026-08-14 | [#530](https://github.com/companionintelligence/CI-Planning/pull/530) | 6 ✅ |
| 8 | [status single read](llm-8-status-single-read.md) | 🟢 ready after 3 + 7 — re-verified, 1 correction | — | 3, 7 |
| 8 | [status single read](llm-8-status-single-read.md) | ✅ merged 2026-08-14 — Settings merge verified in the preview | [#532](https://github.com/companionintelligence/CI-Planning/pull/532) | 3 ✅, 7 ✅ |
| 9 | [rubric consolidation retune](llm-9-rubric-consolidation-retune.md) | ✅ merged 2026-08-14 — **"Pay the electricity bill" defect FIXED** | [#533](https://github.com/companionintelligence/CI-Planning/pull/533) | 1 ✅, 5 ✅ |
| 10 | [suggestTags casing test](llm-10-suggesttags-casing-test.md) | ✅ merged 2026-08-14 | [#534](https://github.com/companionintelligence/CI-Planning/pull/534) | 4 ✅ |

# ✅ WAVE COMPLETE — all ten tickets merged 2026-08-13/14

`main` @ `c7eb8b4`. Post-merge: typecheck clean, suite at the documented 5 pre-existing
Windows-only failures, nothing new.

## Open follow-ups this wave produced

| Item | Origin | Status |
|---|---|---|
| ~~`GET /api/connections` can report `"connected"` for a token that cannot be decrypted~~ | found by end-to-end testing; introduced by #530 | ✅ **fixed** by [#536](https://github.com/companionintelligence/CI-Planning/pull/536) — the no-decrypt branch is gone; one KEK load per list, and an unopenable row reports `inactive`. Re-verified live against the original repro. |
| ~~Quick-add corrupts `"week-long"`~~ | found by end-to-end testing; pre-existing | ✅ **fixed** by [#535](https://github.com/companionintelligence/CI-Planning/pull/535) |
| ~~`"Send the invoice"` subtask false positive~~ | measured in llm-9 | ✅ **fixed** — sixth worked example, measured `TTTTT → FFFFF` with no regressions. Round 2 in `docs/complexity-rubric-measurement-2026-08.md`. |
| ~~Nothing pins the merged Ollama card's three states~~ | noted in llm-8 | ✅ **fixed** — decision extracted to `client/src/lib/ollama-health.ts`, 10 tests; all three states also exercised live in the preview. |
| ~~No in-flight dedupe on a cold probe cache~~ | noted in llm-8 | ✅ **fixed** — concurrent callers join one `/api/tags` request; `fresh` deliberately does not join. |
| `pnpm --filter server vitest run` in ticket templates needs `exec` | found in llm-10 | **out of scope** — factory-kit tooling, not the planner app. The planner's own docs use `pnpm test`, which is correct. |
| Ticket template uses `pnpm --filter server vitest run`, which fails — needs `exec` | found in llm-10 | fix when next editing a ticket |

## Integration check — 8 + 9 + 10 (2026-08-14)

Merged together onto `main` @ `ee7c816`: **clean merge, typecheck clean, full suite back to the
documented 5 pre-existing Windows-only failures** (230 files passed).

⚠️ **The integration caught a defect a per-branch run could not.** llm-9 was authored against
`a0f0b2e`, before llm-3 (#529) landed. Two problems followed, both fixed on its branch:

1. **Conflict in `agents/subtasks.ts`** — #529 rewrote that function's control flow
   (`try {` → `llmOrNull(...)`) while llm-9 rewrote its prompt. Resolved by hand so BOTH survive:
   the `llmOrNull` wrapper *and* `COMPLEXITY_DEFINITION`.
2. **Its test then failed** — `enrichment-rubric.test.ts` replaced `mcp/ollama.js` wholesale, so
   the real `llmOrNull` was undefined at call time
   (`No "llmOrNull" export is defined on the ... mock`). Fixed to a partial mock that spreads the
   original and stubs only `generateJson`.

**Lesson for future waves: rebase a long-running branch onto `main` before trusting its green
suite.** A branch can be green against a stale base and broken against the current one.

## Known ticket-template bug

`pnpm --filter server vitest run …` (used in several wave tickets' Tests sections) fails with
`ERR_PNPM_RECURSIVE_RUN_NO_SCRIPT` — the package has no `vitest` script, only `test`. The working
form is **`pnpm --filter server exec vitest run …`**. Fix when next editing a ticket.

**Six of nine landed.** `main` @ `b110ff9`.

## Accepted decisions (2026-08-14)

- **`suggestTags` case-sensitivity** (#525): a model answering `"finance"` for a `"Finance"` tag
  is now kept, canonically cased, instead of silently dropped. Accepted as a latent bug fix.
  **Follow-up owed: no test pins this behaviour** — the surface has no test file at all.
- **llm-2's three test-double edits** (#526): accepted. The doubles replace `generateJson`
  entirely and branched on the raw `opts.tier`, so they were coupled to call-site argument shape,
  not behaviour. The ticket's "no mock edits needed" clause was a bad tripwire.

## Pre-implementation re-verification (2026-08-14)

llm-3, llm-7 and llm-8 were re-read against `main` @ `b110ff9` **by opening every cited file**,
not grepping — the correction for four earlier drafting errors. Seven more were found:

| Ticket | Correction |
|---|---|
| 3 | **Three `isAvailable()` call sites, not one** — `plan.ts:720` (authoring), `plan.ts:938` (`parseInstruction`, a user-facing **503** path), `seed-test-data.ts:187`. |
| 3 | **`llmOrNull` was unimplementable as drafted.** `parseJsonLoose` throws a bare `Error`, indistinguishable from a real bug. A typed `LlmParseError` is now a prerequisite step. |
| 3 | All degrade-site line anchors were stale after llm-2/llm-4; re-verified and replaced. |
| 3 | Two `catch` blocks (`task-enrich.ts:144`, `render-copy.ts:257`) are **not** LLM paths and must be left alone — named so the DoD grep isn't misread. |
| 7 | **`GET /api/oauth/google/accounts` is already deleted** (T13). A whole work item and its owner-ruling question were moot; only a stale header comment at `oauth.ts:25` remains. |
| 7 | llm-6 landed: read `config.memory.mode` / `config.memory.serverUrl`, never `process.env`. |
| 8 | The "Dead surface" comment cited at `api.ts:593` belongs to `api.memory.status`, not `api.llm.status` (`api.ts:661`, which has no comment). The dead-wrapper claim itself re-verified as true. |

## The standing rule for every ticket in this wave

Before adding a **config variable**, an **env pin**, a **connection surface**, or an **LLM
call site**, check whether one already exists that should be reused. Never introduce a
parallel mechanism when an existing one covers the case — that is the exact defect this wave
removes. State in each PR body which existing mechanism was reused, or why none fit.

Where to look:

| Element | Single source of truth |
|---|---|
| Variables | `server/src/lib/config.ts`. A bare `process.env` read outside it needs a stated reason (today: `lib/crypto` reads `CP_KEK_B64` before config exists; `connectors/memory.ts` re-reads `MEMORY_MODE` per call so tests can toggle it — llm-6 folds the second into config as a getter). |
| Pins | `config.ollamaPinned` / `config.google.envPinned` / `config.vapidEnvPinned` — three shapes today, one after llm-6. NB "pin" also means calibration combo pins and pinned task times; llm-6 documents the collision. |
| Connections | `lib/connections.ts` + the `connection_tokens` table, all providers. Memory has a parallel surface today; llm-7 folds it in. |
| Callers | `generate` / `generateJson` / `embed` from `mcp/ollama.ts`. Call parameters converge in llm-2; failure handling in llm-3. |

## Sequencing

```
1 ✅ ─┬─> 2 ──> 3 ──┐
      ├─> 4         ├─> 8
      └─> 6 ──> 7 ──┘
5 ✅ ─┴─> 9
```

2, 4 and 6 are cleared to run concurrently but held pending owner go-ahead (2026-08-13
review). 2∩6 and 4∩6 are empty. 2∩4 shares four files
(`agents/quickadd.ts`, `agents/tags.ts`, `agents/memory-suggest.ts`,
`services/task-enrich.ts`) in disjoint regions — llm-2 owns the call-options object, llm-4
owns the merge/constrain logic and the result types.

## Integration check (2026-08-14)

Branches 2, 4 and 6 were merged together onto `origin/main` as `integration/llm-wave-246`:
all three merge **clean** (pairwise and three-way), `pnpm --filter server typecheck` is
clean, and the 11 affected test files pass **211/211**. 2∩4 shares three files
(`agents/quickadd.ts`, `agents/tags.ts`, `services/task-enrich.ts`) — the lane fence held.

## Ticket-quality note — four drafting errors so far

Implementing agents found four factual errors in these recipes, all mine, none design-level:
`memory-suggest.ts` listed in llm-5 as carrying a never-invent clause it does not have; llm-4
simultaneously forbidding output changes *and* mandating a case-insensitive helper for
`tags.ts`; `mcp/ollama.ts` listed in llm-6's impacted files despite having no pin reads; and
llm-2's "no mock-fixture edits should be needed" tripwire, which assumed test doubles assert
on behaviour when in fact they intercept below the resolution point and assert on call-site
argument shape. **Before llm-3, llm-7 and llm-8 go out, verify impacted-file lists by READING
each file, not by grepping**, and do not write tripwires that assume mock internals.

## Runner protection (owner directive, 2026-08-13)

The measured prompt-pipeline runners must survive this wave untouched:

- **`agents/loop.ts`** (§A0 harness): generator ≠ evaluator is expressed as a TIER split —
  generator on `fast`, judge on `quality`. llm-2's policy table must keep the four `plan_*`
  purposes distinct; merging them would erase the contract. The loop's error contract
  (`loop.ts:232`) requires stage callbacks to THROW on transport failure — llm-3 is amended
  with an explicit fence (never `llmOrNull` inside loop stages).
- **`render-copy.ts` + `voice-gate.ts`** (voice loop): the gate stays model-free and
  import-isolated from the generator; the two exits stay distinct (transport failure →
  rotation pool; gate rejection → regenerate once).
- Only llm-9 may change prompt text, and only under its N≥5 measurement protocol.

## Live defects this wave carries

Two are real bugs, not tidiness:

- **llm-3** — `agents/plan.ts` pre-flights smart-mode planning on `isAvailable()` ("Ollama
  answered") while the client and `services/triality-rationale.ts` both use `ready` ("the
  model is actually pulled"). On any install whose model isn't pulled, the full
  generate→judge→revise loop runs against an Ollama that cannot serve one call.
- **llm-5** ✅ — the banned-word list the gate enforced contained two words the prompt never
  disclosed. Fixed.

## Verification gotchas — read before measuring any prompt change

- **`llama3.2` at `temperature: 0.1` is not deterministic.** Incidental fields drifted between
  two runs of an identical prompt (priority 1 then 3 for the same entry). Sample N≥5 and
  compare only rubric-governed verdicts, never whole payloads.
- **A `thinking`-capable model returns `""` under `format:"json"`** (`lib/models.ts:26-46`),
  which reads exactly like "output unchanged". Assert non-emptiness before claiming a match.
  Selection excludes these models, but an explicit override or env pin bypasses the filter.
- **Five test failures are pre-existing and Windows-only** — `test/restore.test.ts` (5) and
  `test/cli-scripts-env.test.ts` (collection error at `new URL(import.meta.url).pathname` →
  `C:\C:\...`). Confirm against a clean checkout before blaming a change.
