> **Type:** Refactor · **Phase:** LLM streamline (2026-08-13) · **Branch:** `refactor/llm-tier-vocabulary` · **Commit style:** `refactor(llm): one name per model tier` · **Design:** this ticket is the spec · **Dependencies:** none — this is the first ticket; every later LLM ticket rebases on it

> **STATUS: DRAFT — pending owner approval of the breakdown. Do not create as an issue yet.**

## Goal

Give each model tier **one name** across the whole stack. Today one concept carries four
vocabularies, and a reader has to hold a translation table in their head to follow a single
request from Settings to `/api/generate`.

| Surface | Fast tier | Quality tier | Embed tier | Site |
|---|---|---|---|---|
| Code tier union | `'small'` | `'medium'` | (separate fns) | `server/src/mcp/ollama.ts:26` |
| Config field | `ollamaSmallModel` | `ollamaMediumModel` | `ollamaEmbedModel` | `server/src/lib/config.ts:157-160` |
| Env var | `OLLAMA_SMALL` | `OLLAMA_MEDIUM` | `OLLAMA_EMBED` | `server/src/lib/config.ts:270-272` |
| DB column | `fast_model` | `quality_model` | `embed_model` | `scheduling_prefs`, `server/src/lib/models.ts:74-77` |
| API field | `smallModel` | `mediumModel` | `embedModel` | `server/src/mcp/ollama.ts:165-167` |
| UI label | "Fast model" | "Quality model" | "Embedding model" | `client/src/views/Settings.tsx:1462-1464` |
| Warning label | `'Fast'` | `'Quality'` | — | `server/src/lib/models.ts:313` |

`models.ts:313` is the tell: the code has to *translate* `small → 'Fast'` at the moment it
speaks to a human, because the internal name and the user-facing name disagree.

**Converge on `fast` / `quality` / `embed`** — the vocabulary the DB columns and the UI already
use, so the two surfaces a user or operator actually reads stop needing a translation.

## Non-goals

- **No behavior change.** Resolution order, auto-selection, capability filters, and every prompt
  stay byte-identical. `git diff` is renames + the env alias below, nothing else.
- **Do not rename the DB columns.** `fast_model` / `quality_model` / `embed_model` are already
  the target names — no migration is in scope for this ticket.
- **Do not break `OLLAMA_SMALL` / `OLLAMA_MEDIUM`.** Operators have these in live `.env` files and
  in `docker-compose.yml`. Add `OLLAMA_FAST` / `OLLAMA_QUALITY` as the documented names and keep
  the old two as accepted aliases (see Schema required).
- Do not touch the call-site `{tier, temperature, timeoutMs}` options — that is llm-2.
- Do not touch degrade/availability behavior — that is llm-3.

## Pinned conventions

- `ModelTier` stays a string union exported from `server/src/mcp/ollama.ts`; new members are
  `'fast' | 'quality'`. Every `tier === 'medium'` ternary in `lib/models.ts` becomes
  `tier === 'quality'` — same branch, same order.
- Config field names follow the existing `ollama<Tier>Model` shape: `ollamaFastModel`,
  `ollamaQualityModel`, `ollamaEmbedModel`.
- API/JSON field names stay camelCase and keep the `Model` suffix: `fastModel`, `qualityModel`,
  `embedModel` on `OllamaStatus` and on `GET /api/integrations`.
- Env precedence is unchanged and stays documented in the `lib/models.ts` header comment
  (override → pin → installed default → auto) — only the tier NAMES in that header change.
- Alias resolution reads the new name first, then the legacy one; a legacy hit still counts as a
  pin (`ollamaPinned.fast === true`).

## Before implementation

1. `server/src/lib/models.ts` — the whole file. Its 68-line header is the spec for resolution;
   update the tier names in it and change nothing else about what it says.
2. `server/src/mcp/ollama.ts:26-30, 151-179` — `ModelTier`, `modelFor`, `OllamaStatus`.
3. `client/src/views/Settings.tsx:606-613, 1425-1465, 1689-1721` — both places the tier names
   surface in the UI (yes, there are two; unifying them is llm-8, renaming them is here).
4. `grep -rn "'small'\|'medium'\|smallModel\|mediumModel\|OLLAMA_SMALL\|OLLAMA_MEDIUM" server/src client/src`
   before starting, and again before committing — the second pass must return only the alias
   sites named in Schema required.

## Files impacted

**Changed:**
- `server/src/mcp/ollama.ts` — `ModelTier`, `modelFor`, `GenerateOpts.tier`, `OllamaStatus.{smallModel,mediumModel}`, `status()`'s `effective()` block, `modelSources` keys
- `server/src/lib/config.ts` — `Config.ollama{Small,Medium}Model`, `ollamaPinned.{small,medium}`, the env reads at 263-277 and the comment at 266-269
- `server/src/lib/models.ts` — every `'small' | 'medium'` signature, `resolveModelDefault`, `explainModelDefault`, `generationSelectionWarnings` (the `'Fast'`/`'Quality'` translation at :313 collapses to the tier name itself)
- `server/src/agents/{quickadd,tags,subtasks,extract,plan,summarize,render-copy,memory-suggest,ingest}.ts` — `tier:` literals
- `server/src/services/{motivation,task-enrich,triality-rationale}.ts` — `tier:` literals
- `server/src/routes/llm.ts:26-28` — response field names
- `server/src/scripts/seed-test-data.ts` — `ModelTier` import + literals
- `client/src/lib/api.ts` — `LLMStatus` / `Integrations` types
- `client/src/stores/index.ts`, `client/src/views/Settings.tsx` — field reads
- `server/.env.example:190-193`, `docker-compose.yml:120`, `README.md:1568-1584, 1764-1770`, `ARCHITECTURE.md:1008`, `docs/local-tailscale-setup.md:181-183`

**New:** none.

## Schema required

**No DB migration.** One env-alias rule, implemented once in `lib/config.ts`:

| New name | Legacy alias | Precedence |
|---|---|---|
| `OLLAMA_FAST` | `OLLAMA_SMALL` | new wins; either sets `ollamaPinned.fast = true` |
| `OLLAMA_QUALITY` | `OLLAMA_MEDIUM` | new wins; either sets `ollamaPinned.quality = true` |
| `OLLAMA_EMBED` | — | unchanged |

The `ollamaError()` hint string in `mcp/ollama.ts:57-58` must name the NEW vars.

## Definition of Done

- [ ] `grep -rn "'medium'" server/src client/src` returns zero LLM-tier hits (matches in unrelated
      domains — e.g. sizing props — are fine and must be listed in the PR body).
- [ ] `OLLAMA_SMALL=llama3.2 pnpm --filter server start` still pins the fast tier, and
      `GET /api/integrations` reports `modelSources.fast === 'pin'`.
- [ ] `GET /api/integrations` returns `fastModel` / `qualityModel` / `embedModel`; no `smallModel`.
- [ ] Settings renders identically — same three selects, same three status states.
- [ ] Docs table in README lists `OLLAMA_FAST` / `OLLAMA_QUALITY` with the aliases noted.

## Tests

- [ ] `server/test/model-selection.test.ts` — rename tier literals; assert `explainModel('fast')`
      and `explainModel('quality')` return the same names/sources the old assertions did.
- [ ] New case in `model-selection.test.ts`: `OLLAMA_SMALL` alone still yields `source: 'pin'` for
      the fast tier (the alias regression this ticket's risk lives in).
- [ ] New case: `OLLAMA_FAST` and `OLLAMA_SMALL` both set ⇒ `OLLAMA_FAST` wins.
- [ ] `server/test/ollama.test.ts`, `server/test/settings-models-memory.test.ts` — field renames.

```
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter client build
```

## Acceptance Criteria

- [ ] Given a fresh checkout with no `OLLAMA_*` set, when Ollama is reachable, then auto-selection
      picks exactly the models it picked before this ticket.
- [ ] Given `OLLAMA_MEDIUM=qwen2.5:14b` (legacy only), then the quality tier resolves to it and
      reports `source: 'pin'`.
- [ ] Given a reader following one request from the Settings "Fast model" select to the
      `/api/generate` body, then the word `fast` is the only tier name they encounter.

## Subtasks

1. [ ] Rename in `lib/models.ts` (signatures, header comment, drop the `'Fast'`/`'Quality'` map).
2. [ ] Rename in `lib/config.ts` + add the two env aliases.
3. [ ] Rename `ModelTier` and `OllamaStatus` fields in `mcp/ollama.ts`; fix the error-hint string.
4. [ ] Sweep `tier:` literals across `agents/`, `services/`, `scripts/`.
5. [ ] Rename the API response fields in `routes/llm.ts` and the client types/reads.
6. [ ] Update `.env.example`, `docker-compose.yml`, `README.md`, `ARCHITECTURE.md`, `docs/`.
7. [ ] Update tests; add the two alias cases.
