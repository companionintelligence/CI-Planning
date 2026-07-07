# AA3 — Smarter autoplan (memory-aware ordering)

**Status: AA3a BUILT; AA3b BUILT (reframed).** This pins down the one-line AA3 v-next
bullet from `docs/AA-memory-agentic.md` into an implementable spec. Decision (owner,
2026-07-06/07): ship **AA3a — memory-aware ordering** ("rank memory-related tasks
earlier") and **AA3b — a better default estimate for memory-drafted tasks** (reframed
from the doc's original "memory actuals → calibration", which was a category error; see
[§ AA3b](#aa3b--better-default-estimate-for-memory-drafted-tasks-built)).

AA3a shipped in `server/src/agents/plan.ts` (`memoryTerms` / `memoryRelatedTasks` /
`loadMemoryRelated` + the `memoryCmp` band in `deterministicIndices`, the carve-out in
`checkOrder`, the `memoryLine` in `genPrompt`, all wired through `authorPlanOrder`).
Tests: `server/test/aa3-memory-ordering.test.ts`. Band position landed as recommended:
**after theme, before deadlines.** (Supersedes the planning-only PR #300.)

Guiding discipline (inherited from Phase Z / AA): **flag-off or connector-unavailable ⇒
byte-identical to today.** Memory only ever *reorders* the authored plan; it never adds,
drops, or auto-schedules work, and it changes no placement geometry.

---

## Background — the two seams (code-verified 2026-07-06)

**Ordering.** `authorPlanOrder(owner, date)` in `server/src/agents/plan.ts` freezes the
day's task order into `daily_plan` (author-once per `(owner, date)`). Placement and reflow
only *read* `daily_plan.position` — they never re-author — so authoring is the single,
correct place to inject an ordering signal. Two ordering paths already exist and both take
soft biases today:

- **Deterministic** (`deterministicIndices`, used in basic mode and as the smart-mode
  fallback): a banded comparator — **theme** (§C2) → primary (due or priority per
  `fill_order`) → secondary → `task_id`. The §C2 theme band is the exact precedent for a
  new leading band.
- **Smart** (`genPrompt` + the §A0 generate/judge/revise loop): soft guidance via
  `themeLine` (§C2) and `constraintLine` (§A4 `plan_hints`). `checkOrder` validates the
  result and is **theme-aware** so a themed task legitimately leading a higher-priority one
  isn't flagged as an inversion.

**Calibration.** `computeScopedCalibration(ownerId)` (`server/src/services/calibration.ts`,
nightly `calibrate_estimates` job) reads **done** tasks with `estimated_minutes > 0 AND
actual_minutes > 0`, computes `ratio = actual/estimated`, and writes robust per-scope stats
to `estimate_calibration`. Suggest-only; `actual_minutes` comes only from summed timer
sessions. Relevant to AA3b below.

**Memory connector.** `graphData(owner, {from,to})` and `graphSearch(owner, q)`
(`server/src/connectors/memory.ts`) return a `MemoryGraph` (`{ nodes, links }`);
`graphContext(owner)` returns an LLM-ready **text** snapshot (`Promise<string>`), not a
graph — AA3a uses `graphData`. `MemoryUnavailable` is the deterministic degrade. Gated by
`memory_pull_enabled` (`scheduling_prefs`) + `memoryConnectorAvailable(owner)` — the
**same gate** AA1 uses.

---

## AA3a — memory-aware ordering

### Signal: rank memory-related tasks earlier

When memory is on and available, a staged task that **relates to today's memory context**
(the people/events on the owner's graph for the authoring day) gets a soft rank boost —
applied to **both** the deterministic sort and the smart prompt, so it works with AI off.

**Relatedness (deterministic, pure, unit-testable).** Build a set of *memory terms* from
the day's graph, then mark each `PlanTask` related or not:

1. Pull the day's graph once per authoring run:
   `graphData(owner, { from: dayStartUTC, to: dayEndUTC })` for the authoring date's
   owner-local day — `utcDayBounds(date, tz)` where `tz` is `scheduling_prefs.timezone`
   with a `serverTimezone()` fallback (the same tz-resolution the rest of plan.ts uses;
   never server-local bounds). One call; author-once already bounds frequency.
2. Memory terms = the normalized names of `person` and `event` nodes in that graph
   (lowercased), plus each event node's tag read from `MemoryNode.properties.tag` (there is
   no top-level `tag` field on `MemoryNode` — it lives under `properties`).
3. A task is **related** iff: a tag (the level-1 names in `PlanTask.tags`) equals a term or
   event tag; **or** a *significant token* of its title matches a term token; **or** its
   title contains a full **event**-name phrase (`title.includes(phrase)`). Significant
   token = a lowercased word of length ≥ 4 after stripping punctuation, to keep matches
   conservative (short words don't match). NOTE: full-phrase containment is applied to
   **event** names only; **person** names contribute *tokens* (a person is matched by first
   or last name, e.g. "lindqvist"), not a whole-name phrase.
4. Result: `memoryRelated: Set<taskId>`. Empty when flag-off / unavailable / no graph terms
   → every downstream branch is a no-op (identical-to-today).

> Conservatism is deliberate: a noisy matcher that reorders the whole day is worse than one
> that fires only on clear hits. The token rule + name containment is the v1; tuning
> (stemming, tag-only mode) is a follow-up, not a launch blocker.

### Where it plugs in

**Deterministic (`deterministicIndices`).** Add a `memoryRelated?: Set<string>` param and a
**`memoryCmp` band placed immediately after the theme band, before the due/priority
primary** — related (0) leads unrelated (1). Rationale for the position: an explicit
day-theme is a stronger, user-declared signal and keeps precedence; memory context is the
next-strongest "what today is actually about" signal; deadlines/priority break ties within
each band exactly as now. When the set is empty the band is inert and the output is
byte-identical.

**Smart (`genPrompt`).** Append one context line after `themeLine`/`constraint` that gives
memory the **same priority as the deterministic band** — *ahead of* the prompt's deadline/
priority weighing (below only theme), not a mere tiebreaker. Otherwise the model, told
"deadlines first," would fight `memoryCmp` and churn the revise loop. The related indices
are passed explicitly so the model doesn't re-derive relatedness from titles, e.g.
`\nToday's memory context: tasks at indices 2, 5 relate to today's commitments — order them earliest (after any theme), ahead of the deadline and priority weighing above.`
Empty set → no line (prompt byte-identical).

**`checkOrder`.** Extend with the same `memoryRelated` set and treat a related task leading
an unrelated higher-priority/earlier-due one as **non-defective** (exactly the theme
carve-out), so the smart loop's validator doesn't reject a correctly memory-led order and
fall back.

### Data flow & safety

- `authorPlanOrder` is already `async` and owner-scoped; it gains a single `graphData`
  call wrapped in try/catch → `MemoryUnavailable` (and flag-off) yield an empty term set,
  never a throw. Fetch is injectable (a `deps` param defaulting to the real connector),
  mirroring `suggestFromMemory`'s injectable `polish` — so tests never touch the network.
- Read-only; no writes to memory; no new autonomy surface; suggestion/auto-schedule paths
  untouched. Reflow is unaffected (it reads the frozen `daily_plan`).
- Cost: one extra graph read on the day's first authoring only (author-once). Negligible.

### Tests (TDD)

- `memoryRelated` matcher: tag hit, title-token hit, name-containment hit, short-word
  non-match, empty-graph empty-set. (Pure fn — no server.)
- Deterministic order: related task leads an earlier-due unrelated one **only** when the set
  is non-empty; **identical output** when the set is empty (the flag-off / unavailable
  invariant, asserted against the pre-AA3a order).
- Smart prompt: the context line appears iff related indices exist; absent otherwise.
- `checkOrder`: a memory-led order is not flagged an inversion.
- Integration: `memory_pull_enabled` off ⇒ `daily_plan` order byte-identical; on + fixture
  graph ⇒ the related task's position moves earlier. `MemoryUnavailable` ⇒ identical to off.

No migration, no new flag (reuses `memory_pull_enabled`). No client change.

---

## AA3b — better default estimate for memory-drafted tasks (BUILT)

**Reframed (owner, 2026-07-07).** The original one-liner ("memory actuals → Z0
calibration") was a category error: Z0 calibration models the user's *estimate-vs-actual
bias* (a ratio), and a memory event has no user estimate to compare against — so there's no
ratio to harvest, and feeding event durations in would pollute the user's bias model with
third-party data. The real, well-defined value is at **suggestion time**: give a
memory-drafted task a smarter default `estimated_minutes` than the flat 30 m. And since
CI-Server *rarely* records an event end/duration, the payoff is almost entirely in a better
**no-duration fallback** (an event *never* lacks a start — `eventCandidates` filters
start-less nodes — so "no scheduled window" means "no end").

**The estimate ladder** (`memory-suggest.ts › memoryFallbackEstimate` + `templateTask`):

1. **Event has a real scheduled duration** (`end − start > 0`) → use it, unchanged. The
   event's own duration is the strongest signal and always wins; it is NOT bias-adjusted
   (calibration's bias is about the user's estimates, not a calendar's scheduled length).
2. **No duration** (the common case) → the owner's TYPICAL ACTUAL length:
   `median(actual_minutes)` over their **done, memory-sourced** tasks (`source_kind='memory'`,
   the population a promoted memory task belongs to — memory drafts are untagged, so
   tag/subtype scopes don't apply), else the **global** median over all their done tasks —
   each gated by `CONFIDENCE_FLOOR` (5) samples so outliers can't set the prior.
3. **No usable history** → `DEFAULT_ESTIMATE_MIN` (30), the prior behavior.

Reads `actual_minutes` (timer truth) only — *not* `estimated_minutes` and *not*
`estimate_calibration` (which stores ratio percentiles, not absolute minutes, and so can't
answer "how long is this task"). Still **suggest-only**: it seeds a possible's
`proposed_estimated_minutes`, which the user reviews before promote — exactly the boundary
the flat 30 m default already had. Early on, completed-memory-task volume is low, so the
global median carries it; still better than a blind 30 m.

Tests (`server/test/aa3b-memory-estimate.test.ts`): the `memoryFallbackEstimate` ladder
(no history → 30; sub-floor → next tier; memory-median preferred over global when ≥ floor),
and integration via `suggestFromMemory` in fixture mode — an event WITH a duration uses it
(history ignored), an end-less event uses the history median.

---

## Rollout

AA3a shipped as PR #301 (server-only): the matcher + the three plug-ins
(`deterministicIndices`, `genPrompt`, `checkOrder`) + `authorPlanOrder` wiring. AA3b ships
as its own follow-up PR off merged main (the estimate ladder in `memory-suggest.ts` +
tests + this section). Both are server-only, exercised end-to-end in fixture mode, and
independent of the still-deferred live-smoke.

Related: `docs/AA-memory-agentic.md` (AA0–AA4), `docs/archive/M-ai-scheduler.md` §A0/§A2/§A4
(authoring loop + hint seam), `docs/Z-focus-ritual.md` (Z0 calibration).
