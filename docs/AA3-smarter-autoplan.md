# AA3 — Smarter autoplan (memory-aware ordering)

**Status: design (not built).** This pins down the one-line AA3 v-next bullet from
`docs/AA-memory-agentic.md` into an implementable spec. Decision (owner, 2026-07-06):
ship **AA3a — memory-aware ordering** with the signal *"rank memory-related tasks
earlier."* **AA3b — memory actuals into estimate calibration** is defined here but
**deferred** (rationale in [§ AA3b](#aa3b--memory-actuals-into-calibration-deferred)).

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

**Memory connector.** `graphData(owner, {from,to})` / `graphContext(owner)` /
`graphSearch(owner, q)` (`server/src/connectors/memory.ts`) return the owner's graph;
`MemoryUnavailable` is the deterministic degrade. Gated by `memory_pull_enabled`
(`scheduling_prefs`) + `memoryConnectorAvailable(owner)` — the **same gate** AA1 uses.

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
   owner-local day (reuse `utcDayBounds`). One call; author-once already bounds frequency.
2. Memory terms = the normalized names of `person` and `event` nodes in that graph
   (lowercased; also each event node's `tag`/`properties.tag` when present).
3. A task is **related** iff any of its tags (the level-1 names already in `PlanTask.tags`)
   equals a memory term, **or** its title shares a *significant token* with a memory term.
   Significant token = a lowercased word of length ≥ 4 after stripping punctuation, to keep
   matches conservative (avoid "the"/"and"/short-word false positives). Exact person/event
   name containment also counts regardless of token length.
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

**Smart (`genPrompt`).** Append one context line after `themeLine`/`constraint`, e.g.
`\nToday's memory context: <event> with <people> — favour related tasks (indices: 2, 5) earlier.`
The related indices are passed explicitly so the model doesn't have to re-derive relatedness
from titles. Empty set → no line (prompt byte-identical).

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

## AA3b — memory actuals into calibration (deferred)

**Why deferred.** Z0 calibration models the user's *estimate-vs-actual* bias from **done
tasks with timer `actual_minutes`**. A promoted memory-suggested task is already a normal
task: complete it with a timer and it calibrates through the existing path — **no new code
needed** for that case. The only genuinely new idea is to treat a **past memory event's
real elapsed duration** (`end − start` once the event is in the past) as a proxy
`actual_minutes` for its mirrored task when the user logged no timer. That conflates two
different signals — "how long the event was scheduled/ran" vs. "how long the user actually
spent" — and would quietly bias the user's personal calibration with third-party data.

**If pursued later,** the firm definition is: for a `source_kind='memory'` task whose linked
event has a *past* `end`, and which is `done` with `actual_minutes IS NULL`, backfill a
**separate** signal (not `tasks.actual_minutes`) into a memory-scoped calibration input, and
keep it out of the user's own `global`/`tag` scopes unless explicitly opted in. Recommend
building only after AA3a ships and there's real promoted-memory-task volume to validate
against. Until then, memory tasks calibrate exactly like any other task.

---

## Rollout

Single PR for AA3a (server-only): the matcher + the three plug-ins (`deterministicIndices`,
`genPrompt`, `checkOrder`) + `authorPlanOrder` wiring + tests + this doc's status flip.
Sequenced **after** the reflow-correctness work (PR #296/#297, merged) and independent of
the still-deferred live-smoke — AA3a is exercised end-to-end in fixture mode.

Related: `docs/AA-memory-agentic.md` (AA0–AA4), `docs/archive/M-ai-scheduler.md` §A0/§A2/§A4
(authoring loop + hint seam), `docs/Z-focus-ritual.md` (Z0 calibration).
