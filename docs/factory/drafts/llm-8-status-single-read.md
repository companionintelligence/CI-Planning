> **Type:** Refactor · **Phase:** LLM streamline (2026-08-13) · **Branch:** `refactor/llm-status-single-read` · **Commit style:** `refactor(llm): one Ollama status read, one status card` · **Design:** this ticket is the spec · **Dependencies:** llm-3 (availability predicate), llm-7 (connections shape). Land last.

> **STATUS: READY. Re-verified against `main` @ `b110ff9` on 2026-08-14 (after llm-1/2/4/5/6 merged) by READING each cited file. One correction marked ⚠️ inline; the ticket's premise is otherwise intact and its dependencies (llm-3, llm-7) are still real.**

## ⚠️ Correction from the first draft (2026-08-14)

The first draft said `client/src/lib/api.ts:593` carries a "Dead surface (zero callers — see #392)"
comment about `api.llm.status`. **Misattributed** — that comment belongs to `api.memory.status` on
the line below it. `api.llm.status` sits at `api.ts:661` and carries **no comment at all**.

The underlying claim still holds and was re-verified: `api.llm.status` has **zero callers**
(`grep -rn "api\.llm" client/src` returns only `stores/index.ts:343`, which calls
`api.llm.integrations()`). So the wrapper is genuinely dead — just undocumented, not documented-
dead. Anyone hunting for the citation would otherwise have found a comment about a different
surface and concluded the ticket was wrong about the whole section.

## ⚠️ Second re-verification (2026-08-14, after llm-3 #529 and llm-7 #530 merged — `main` @ `ee7c816`)

Anchors re-read again on the post-merge tree; these supersede everything above:

| Thing | Now |
|---|---|
| `status()` | `mcp/ollama.ts:344` |
| test-mode cache guard | `mcp/ollama.ts:394` (`NODE_ENV !== 'test'`) — must survive |
| `isReady()` | `mcp/ollama.ts:424-425` — **new, added by llm-3**; it is `(await status()).ready` |
| `/api/llm/status`, `/api/integrations` | `routes/llm.ts:13`, `:18` — still two `status()` calls per page load |
| `api.llm.status` (dead) | `client/src/lib/api.ts:661`, zero callers |
| Settings model card | `client/src/views/Settings.tsx:~1433-1462` |
| Settings integrations row | `client/src/views/Settings.tsx:~1691-1720` ("Integrations" label at :1694, "Re-check" at :1696) |

**The case for this ticket got materially STRONGER, and its scope widened.** llm-3 introduced
`isReady()` as the single readiness predicate — and `isReady()` calls `status()`, which does a live
`/api/tags` fetch **plus three model resolutions** (each hitting `scheduling_prefs`). Its callers:

- `agents/plan.ts:728` — every `authorPlanOrder`
- `agents/plan.ts:949` — every `parseInstruction` (the NL-instruct route)
- `services/triality-rationale.ts` — every plan render (it now imports `isReady` directly)
- `scripts/seed-test-data.ts:188`

So the uncached probe now sits on the **day-authoring and NL-instruct hot paths**, not just the
Settings poll. `triality-rationale.ts` still budgets around the probe's cost (`BUDGET_MS`, the
"skip the call rather than start one" floor) — that budgeting is the symptom this cache removes.

⚠️ **Do NOT change `isReady`'s semantics or remove the budget** — llm-3 landed both deliberately.
This ticket makes the probe underneath them cheap; it does not touch what they mean.

⚠️ `routes/llm.ts` now also imports `listConnections` (llm-7). Leave the connections block alone —
this ticket is only about the `status()` calls at :13 and :18.

## Goal

`status()` (`mcp/ollama.ts:193`) does a live `fetch` of `${ollamaUrl}/api/tags` **and** three
model resolutions (each hitting `scheduling_prefs`) on every call. It is called from four places
with no coordination, two endpoints serve overlapping copies of it, and the Settings view renders
it twice.

### 1. Two endpoints, one payload

- `GET /api/llm/status` (`routes/llm.ts:12-14`) — returns the whole `OllamaStatus`.
- `GET /api/integrations` (`routes/llm.ts:17-55`) — calls `status()` again and re-projects nine of
  its fields by hand (`:20-36`).

The client wrapper for the first is **dead**: `api.llm.status` (`client/src/lib/api.ts:661`) has
zero callers — the UI reads the richer `integrations()`. `audit-dead-surface-inventory.md` item 3
lists it among the zero-caller wrappers. (⚠️ It carries no in-file comment saying so; see the
Correction above.)

### 2. Two status cards in one view

`client/src/views/Settings.tsx` renders Ollama state twice from the same resource:

- `:1425-1465` — the model-picker card: unavailable / missing-models / auto-select warnings / three selects
- `:1689-1721` — the Integrations card: a three-state Ollama row (red / amber / green) with a
  "Re-check" button

Both derive from `integrations()`. Both encode the same reachable-vs-usable distinction, in
different words, at different severities. A user changing a model in the first card has to scroll
to the second to see whether it took.

### 3. Uncoordinated probes

`status()` callers: `boot.ts:10`, `routes/llm.ts` ×2 per page load, `services/triality-rationale.ts:242`
(per plan render, on the latency-sensitive path — it even budgets for the probe at `:245-249` and
logs *"rationale budget spent on the availability probe"*, which is the cost showing up in
production). The installed-model cache it fills (`lib/models.ts:96-101`) is already a cache; the
probe that fills it is not.

## Non-goals

- **Do not cache the model-resolution result**, only the `/api/tags` probe. A Settings override is
  a DB write that must take effect on the next request; caching resolution would make saved model
  choices appear not to apply.
- **Do not remove the "Re-check" button.** Ollama can come up after the app (`Settings.tsx:1689`);
  the button must bust the cache. That is the cache's escape hatch and the reason a TTL alone
  is not enough.
- **Do not change the three-state semantics** (unavailable / reachable-but-unusable / ready). They
  are correct and hard-won; this ticket renders them **once** instead of twice.
- Do not delete the `GET /api/llm/status` **route**. It is a legitimate diagnostic endpoint and is
  tested; only the dead client wrapper goes. State this in the route's comment.
- Do not restyle Settings. Move and merge the existing markup; no new design.

## Pinned conventions

- Probe cache lives in `mcp/ollama.ts` beside `status()`:
  ```ts
  const PROBE_TTL_MS = 30_000;   // Settings polls faster than this; boot + Re-check bypass it
  export async function status(owner?: string, opts?: { fresh?: boolean }): Promise<OllamaStatus>
  ```
  `fresh: true` bypasses and refills. The cache holds only the `/api/tags` result (`InstalledModel[]`
  + reachability + error); everything else is recomputed per call, so per-owner overrides stay live.
- `NODE_ENV === 'test'` disables the cache entirely — same rule and same reasoning as the existing
  `setInstalledModels` test guard (`mcp/ollama.ts:236-243`): suite behavior must not depend on
  call ordering.
- `GET /api/integrations` calls `status()` once (cached); the "Re-check" button calls
  `GET /api/llm/status?fresh=1`, which is the one caller that passes `fresh`.
- `triality-rationale.ts` uses the cached read — its own comment says the probe is a cost it
  budgets around, and the cache is the fix it was describing.
- In Settings, the merged card lives where the model picker is now (`:1425`, inside the
  Connections → Integrations section) — the selects and the health line belong together.

## Before implementation

1. `server/src/mcp/ollama.ts:151-266` — `OllamaStatus`, `status()`, the test guard.
2. `server/src/routes/llm.ts` — both handlers; confirm `/api/integrations` needs nothing from
   `status()` beyond the nine fields it projects.
3. `client/src/views/Settings.tsx:600-620, 1425-1465, 1689-1725` — both cards, and
   `client/src/stores/index.ts:336-360` — the resource + `aiAvailable()`.
4. `client/src/lib/api.ts:590-600, 655-665` — the dead wrapper and its comment.
5. `server/test/ollama.test.ts` — how `status()` is currently asserted; the cache must not make
   any existing assertion order-dependent.

## Files impacted

**Changed:**
- `server/src/mcp/ollama.ts` — probe cache, `opts.fresh`, test-mode bypass
- `server/src/routes/llm.ts` — `?fresh=1` on `/api/llm/status`; one `status()` call in `/api/integrations`; a comment marking the route as diagnostic-only
- `server/src/services/triality-rationale.ts` — drop the probe-cost budgeting comment now that it is stale; keep the budget itself
- `client/src/lib/api.ts` — delete the dead `llm.status` wrapper (or repoint it at `?fresh=1` for the Re-check button — see Subtasks)
- `client/src/views/Settings.tsx` — merge the two cards into one
- `client/src/stores/index.ts` — `refetchIntegrations` triggers the fresh read
- `ARCHITECTURE.md` — note the probe cache + its two bypasses

**New:** none.

## Schema required

None.

## Definition of Done

- [ ] One `status()` probe per 30s under steady-state polling; verifiable by counting requests to
      `/api/tags` in `preview_logs` or a stub.
- [ ] "Re-check" still surfaces an Ollama that came up seconds ago (bypasses the cache).
- [ ] A model changed in Settings and saved takes effect on the **next** request, with no re-check
      and no wait — the resolution path is not cached.
- [ ] Settings shows Ollama health in exactly one place, keeping all three states and the
      auto-select warnings.
- [ ] `grep -rn "api.llm.status" client/src` returns zero hits; the route still exists and is tested.

## Tests

- [ ] New cases in `server/test/ollama.test.ts`: two `status()` calls within the TTL issue one
      `/api/tags` fetch; `{ fresh: true }` issues a second; under `NODE_ENV=test` the cache is off
      (guards the rest of the suite).
- [ ] A Settings override written between two cached `status()` calls is reflected in the second —
      the regression test for the non-goal above.
- [ ] `server/test/settings-models-memory.test.ts` passes unedited.
- [ ] Client: Settings renders one Ollama block; assert the three states still render
      (extend the existing Settings test if one covers this; otherwise note the gap in the PR body).

```
pnpm --filter server typecheck
pnpm --filter server test
pnpm --filter client build
```

Manual, via the preview: start the app with Ollama **down**, confirm the red state; start Ollama;
confirm the row stays red until "Re-check", then goes green. Screenshot both.

## Acceptance Criteria

- [ ] Given the Settings page open and polling, when 60 seconds pass, then at most 2 `/api/tags`
      requests were made (not one per poll).
- [ ] Given a plan render with the triality garnish, then it no longer spends its call budget on a
      live availability probe.
- [ ] Given a user picks a new fast model and saves, then the next AI call uses it immediately.

## Subtasks

1. [ ] Add the probe cache + `fresh` + the test-mode bypass; add the three `ollama.test.ts` cases.
2. [ ] Add the "override is not cached" regression test; confirm it passes.
3. [ ] Wire `?fresh=1` into `/api/llm/status`; point "Re-check" at it (this decides whether the
       client wrapper is deleted or repurposed — pick one and say which in the PR body).
4. [ ] Merge the two Settings cards into the model-picker location; delete the duplicate markup.
5. [ ] Drop the stale probe-cost comment in `triality-rationale.ts`.
6. [ ] Manual preview check with Ollama down → up → Re-check; attach screenshots.
7. [ ] Update `ARCHITECTURE.md`.
