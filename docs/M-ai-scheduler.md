# M — AI scheduler: make AI planning real, add reactive reflow, back the stubbed claims (implementation spec)

**Status:** Draft v2 · **Depends on:** A (deterministic scheduler), F (locked/meeting/completed blocks), G (flight-plan / two-step Auto), J (inbound calendar sync). Companion to [ROADMAP.md](ROADMAP.md) and [K-auto-defense.md](archive/K-auto-defense.md).

> **Changelog v1 → v2 (durable day plan):** A critique found the v1 mechanism broken — `flight_plan` is consumed (rows deleted) on placement and has no date column, so an authored order cannot survive into a reflow. v2 introduces a durable, day-scoped **`daily_plan`** table written at placement and read by reflow; bounds authoring to **once per day + explicit reruns**; and makes reruns **targeted** (only untagged / likely-mistagged tasks). `plan_revisions` is downgraded to an `audit_log` reuse. Issues this does *not* fix are listed under "Known issues" at the end.

> **📍 Alignment note (2026-06-24, migration head `0061`).** Renamed from `L-ai-scheduler-plan.md` → **Phase M**: `L` is taken by Multi-device sync ([L-multi-device-sync.md](L-multi-device-sync.md)). This phase **supersedes Phase K** — its Workstream B is the code-accurate version of the old `K-auto-defense.md` (archived at [archive/K-auto-defense.md](archive/K-auto-defense.md); its "auto_schedule cron calls runScheduler" line was stale). Proposed migrations renumbered **0058→0062, 0059→0063, 0060→0064** because the Google-connector track already shipped 0058–0061. Dependencies A/F/G/J are all **shipped & merged**, and this builds on the now-shipped autoplan engine (PRs #121–129), so M is buildable today. **Option A** is the chosen direction.

This plan closes three gaps between the docs and the code:
1. **AI auto-scheduling is deterministic bin-packing; the only LLM scheduling step is dormant.** Marketed "local-LLM auto-block" is ~0% AI in the scheduling path.
2. **Reactive reflow (the "Motion lesson", ARCHITECTURE §4.3) is absent** — only a nightly `review_day` cron defers misses the morning after.
3. **Stubbed/overstated claims:** `day_theme` (never read), `overrun` status (never set), `sqlite-vec` (not even a dependency; dedupe is an O(n²) cosine loop).

The chosen direction (all three on the maximal path): **real LLM planning**, **full Phase-K reactive reflow**, and **implement all three stubs**. The reflow stays deterministic; an opt-in escalation hook (B4) bridges to the LLM only on explicit user accept.

---

## §0 — The one architectural decision everything hangs on

### The finding that revises the naive plan

There are **two** placement engines, and the LLM hook is in the one users don't drive:

| | `engine/scheduler.ts` → `runScheduler` | `engine/autoplan.ts` → `placeFlightPlan` |
|---|---|---|
| Endpoint | `POST /api/schedule/run` ([routes/schedule.ts:11](../server/src/routes/schedule.ts)) | `POST /api/auto/run` ([routes/flight-plan.ts:119](../server/src/routes/flight-plan.ts)) |
| Reads order from | `tasks` (priority/due/age) — **not** flight_plan | **`flight_plan.position`** via `selectedStaged` (`ORDER BY fp.position`, [autoplan.ts:81](../server/src/engine/autoplan.ts)) |
| LLM hook | `orderForToday` ([scheduler.ts:148](../server/src/engine/scheduler.ts)) — **dormant** | **none** |
| Status | Phase-A original; semi-legacy | **Phase-G cockpit reality** (Fill→Place, Plans-first, direction windows, workday fallback, Undo, schedule-mode) |

The LLM hook lives in the engine that doesn't read `flight_plan`, while the engine that *does* read `flight_plan.position` (the real user path) has no LLM. The [K-auto-defense.md](archive/K-auto-defense.md) spec wraps `runScheduler`, and its "Current state" line *"auto_schedule cron calls runScheduler"* is **stale** — that cron now calls `fillFlightPlanCandidates` ([jobs/index.ts:60](../server/src/jobs/index.ts)).

### Resolution — LLM authors once, determinism executes forever (Option A)

- **Canonical placement = `placeFlightPlan`** (autoplan.ts), fed from a durable day plan.
- **The LLM authors into a durable, day-scoped `daily_plan` table** — *not* `flight_plan`, which is ephemeral staging that placement deletes (see the v2 changelog). `daily_plan(owner, date, task_id, position, rationale, source, block_id)` is the frozen order + rationale for the day. Placement reads `daily_plan.position` (fallback: deterministic key when absent), links `block_id` as it places, then clears the `flight_plan` staging rows as today.
- **The deterministic seam is "placement & reflow always read the frozen `daily_plan` order."** Placement never calls the LLM.
- **Phase-K reflow reconstructs from `daily_plan`** — it reads the frozen order, re-stages only the *movable* tasks (blocks not protected/in-progress), and re-runs `placeFlightPlan` around the frozen blocks. The durable table is what gives the consume-once `placeFlightPlan` an idempotent-rebuild property. *(This is why the real fix was a durable store, not the choice of engine.)*
- `runScheduler` / `/api/schedule/run` becomes legacy (align or retire — see cross-cutting).

> **Why this matters:** "real LLM planning" (A) and "deterministic reflow" (B) collide if the LLM runs on every reflow — you get non-reproducible output and anti-thrash death, exactly what K forbids ([K-auto-defense.md:13,156](archive/K-auto-defense.md)). Authoring once into a persisted order, then placing/reflowing deterministically over that frozen order, is the rule that lets all three workstreams coexist.

**Alternative (Option B):** route everything back through `runScheduler` and make it read `flight_plan.position`. Possible, but partially unwinds Phase G. **Recommend A.** Every spec below assumes A.

### §0 task — establish the seam

- **Goal.** A single `authorPlanOrder(owner, date)` writes the frozen order into `daily_plan`; `placeFlightPlan` and every reflow read it; placement is provably LLM-free.
- **Acceptance.** `authorPlanOrder` upserts `daily_plan` rows (`position`, `rationale`, `source`) for the day's selected tasks; runs the LLM **only** when the prefs toggle (A5) is on, else writes deterministic positions (`source='deterministic'`); `placeFlightPlan` orders by `daily_plan.position` and links `block_id` on placement; same `daily_plan` order + same obstacles ⇒ same placement (block ids churn — diff keys on `task_id`).
- **File state.** `selectedStaged` currently orders by `fp.position` ([autoplan.ts:75-85](../server/src/engine/autoplan.ts)) **and deletes staged rows on placement** ([autoplan.ts:416-418](../server/src/engine/autoplan.ts)) — which is exactly why the order must live in a durable table; no authoring layer or `daily_plan` exists.
- **Files changing.** **Migration 0064** `daily_plan`; `server/src/agents/plan.ts` (`authorPlanOrder` writes `daily_plan`); `server/src/engine/autoplan.ts` (order by `daily_plan.position`; set `block_id`; invoke authoring once/day behind toggle); `server/src/engine/scheduler.ts` (drop unused `orderForToday`; mark legacy).
- **Tests.** New `authoring.test.ts`: `daily_plan` written by LLM order; toggle-off ⇒ deterministic positions; Ollama-down ⇒ deterministic fallback, no throw; placement reads `daily_plan` order; **the placed order survives a simulated reflow** (the v1-regression guard).
- **DoD.** Authoring/placement separable; the day's order is durable across placement + reflow; placement LLM-free; existing autoplan tests green. **Effort: ~1 day** (was 0.5; +`daily_plan`).

---

## Workstream A — Real LLM planning (#1)

Today `orderForToday` ([plan.ts:21](../server/src/agents/plan.ts)) is a ≤30-task reorder, gated off by default and wired into the wrong engine. "Real" planning = the LLM does more than reorder, and its work is visible and persisted into the flight-plan.

### §A0 — AI-in-the-loop authoring harness (applies to A1–A4 and B4)

Every LLM authoring stage runs as a **bounded generate → evaluate → iterate** loop with a *separate* evaluator. This is the contract all AI stages below conform to — AI output is checked against the stage's goal, never self-graded, and never spins or silently ships a failing result.

- **Goal.** A reusable harness (`agents/loop.ts`) that turns a one-shot LLM call into a scored, bounded, inspectable, resumable revision loop.
- **The contract.**
  1. **Generator ≠ evaluator.** Generation and scoring are distinct calls with distinct prompts; the generator never grades its own output (reward-hacking guard). Generator = `small` tier; **judge = `medium` tier**.
  2. **Rubric = deterministic checks + LLM-judged quality.** Each stage declares a rubric mixing mechanical assertions (exact, single-pass) with an LLM quality score (0–1). A candidate **passes** only when *all* deterministic checks pass **and** the judge's median score ≥ threshold. Verify mechanically wherever possible.
  3. **Self-consistency on the judge.** Local judges are noisy — sample the evaluator **3× and take the median**; deterministic checks run once.
  4. **Bounded recursion.** `max_iterations` (default 3) **and** plateau detection (stop if score gains < ε over 2 rounds). Hard cap — on local hardware, iterations × judge-samples multiply inference fast (infinite-loop + cost-bomb guard).
  5. **Append-only revision log.** Every candidate + its rubric scores is appended to the existing **`audit_log`** (reusing the `job_runs`/`audit_log` instinct — no new table) → **inspectability** ("why this plan") + resumability. *(v2: downgraded from a dedicated `plan_revisions` table — reruns are rare and targeted, so the log stays small.)*
  6. **Human escape hatch on stall.** Hitting `max_iterations` without passing does **not** ship the best failing candidate as if it passed — it falls back to the stage's deterministic baseline and raises a "plan needs review" signal on B4's nudge channel. The loop stops; the human sees it.
  7. **Cost discipline (local + Ollama).** Fan-out small (**2–3**) in early/cheap stages; reserve deeper loops for late/high-value stages; a global per-run call budget trips the escape hatch when exceeded.
- **File state.** No loop/eval harness exists; `generate`/`generateJson` are one-shot ([mcp/ollama.ts](../server/src/mcp/ollama.ts)); `ModelTier = 'small' | 'medium'` (judge uses `medium`); `job_runs`/`audit_log` are the append-only precedent.
- **Files changing.** New `server/src/agents/loop.ts` (runner: generate → score → iterate, plateau/cap, budget) + per-stage rubric modules; revision entries written to `audit_log` (no new migration).
- **Tests.** Generator never receives the eval prompt (separation asserted); a deterministic-fail blocks pass even at judge=1.0; judge median over 3 samples; loop stops on plateau and on `max_iterations`; escape hatch falls back + signals (no spin); revision log append-only + resumable; budget cap honored.
- **DoD.** All AI stages route through the harness; no stage self-grades; every run is capped, logged, and either passes its rubric or visibly escalates. **Effort: ~2–3 days (prerequisite for A1).**

#### §A0.1 — The loop and the three prompts

The loop is **generate → evaluate → revise** — three separate calls so the generator never grades itself. Worked here for the **ordering** stage (A1); rationale (A3) reuses it with a different rubric; A4 uses only the generator + schema validation.

```
authorPlanOrder(owner, date, scope='full'):                 # scope: 'full' (first plan) | 'dirty' (rerun)
  if scope=='full' and dailyPlanAuthored(owner, date): return   # author ONCE/day; reruns are explicit
  tasks = (scope=='dirty') ? dirtySet(owner, date)            # rerun: untagged ∪ likely-mistagged only
                           : selectedStaged(owner)            # first plan: the whole staged set
  if tasks<2 or !aiEnabled or !ollamaUp: return persist(deterministicOrder(tasks) -> daily_plan)  # escape

  cand = generate(GEN_PROMPT, tasks, ctx)             # small tier        ── PROMPT 1
  best = null; bestScore = -1
  for iter in 1..MAX_ITER(=3):
    detFails = deterministicChecks(cand, tasks)        # exact, single pass (the hard gate)
    score = detFails.empty
              ? median([judge(JUDGE_PROMPT, tasks, cand) x3])   # medium tier, 3×  ── PROMPT 2
              : 0                                       # a deterministic fail cannot pass, even at judge=1
    append audit_log(action='plan_revision', stage='order', iter, cand, detFails, score)
    if score > bestScore: best = cand; bestScore = score
    if detFails.empty and score >= PASS(=0.8): return persist(cand -> daily_plan)  # PASS → freeze order
    if iter>1 and (bestScore - prevBest) < EPS(=0.05): break            # plateau detection
    cand = revise(REVISE_PROMPT, tasks, cand, detFails, judgeCritique)  # small tier  ── PROMPT 3

  escapeHatch('order')                                 # stall: fall back + raise "needs review" nudge (B4)
  return persist(deterministicOrder(tasks) -> daily_plan)
```

Cost bound: per iteration = 1 generate/revise + ≤3 judge samples ≈ 4 calls, × `MAX_ITER` ⇒ ≤ ~13 calls then stop. The deterministic checks **gate** the judge, so the judge only ever rates subjective dimensions (it can't reward a plan that breaks a hard rule).

**Cadence (v2).** Authoring runs the LLM **at most once per `(owner, date)`** — the first time a day is planned. `autoScheduleOnIngest` and reflow **never author** (they read the existing `daily_plan` order), so background email/calendar sync can't trigger the loop. Re-authoring happens only on an explicit user trigger: the B4 "Re-plan" accept or a manual re-plan. This — not the per-run budget — is what actually bounds inference cost.

**Targeted rerun (v2).** A rerun (`scope='dirty'`) does **not** re-rank the whole day. `dirtySet(owner, date)` = tasks in today's `daily_plan` that are **untagged** (`NOT EXISTS` an `entity_tags` level-1 row) **or likely-mistagged** (the existing auto-tagger's top suggestion — [services/auto-tag.ts], [agents/tags.ts](../server/src/agents/tags.ts) — disagrees with the current tag, or is low-confidence). The rerun fixes those tags, re-positions/re-rationales **only** the dirty tasks within the existing order, and leaves every clean task's `daily_plan.position` fixed. This minimizes churn (anti-thrash-friendly), bounds the LLM to genuinely uncertain items, improves exactly what tags drive (batching A2, `day_theme` C2), and defuses "the generator overfits one judge" since only a handful of items move.

**① Generator** — `small` tier, JSON output
```
SYSTEM: You are a day-planning assistant. You order a FIXED set of tasks for one day. You never
invent, drop, merge, or reschedule tasks — you choose sequence only. Reply with JSON only.

USER:
Order today's tasks from first to last. Weigh, in this order:
1) hard deadlines (sooner due = earlier); 2) priority (P1 highest);
3) momentum — group related work, minimize context switches;
4) front-load demanding work while focus is fresh.
{theme_line}        # e.g. "Today's theme: deep-work — favour deep-work-tagged tasks earlier."
{constraint_line}   # A4 hint, e.g. "Constraint: no 'errands' before 12:00."
Capacity today: ~{capacityMin} focused minutes.

Tasks (index: [priority] title (due) ~estimate tags):
{task_lines}

Reply with ONLY a JSON array containing every index exactly once, in your chosen order. Example: [3,0,1,2]
```

**② Judge / evaluator** — `medium` tier, JSON output, independent (gets the candidate, NOT the generator's reasoning)
```
SYSTEM: You are a strict planning reviewer. You did NOT create this plan. Score ONLY the qualities
asked; be skeptical and reserve high scores for genuinely good ordering. Reply with JSON only.

USER:
Judge ONLY these subjective qualities (deadline/priority correctness are verified separately — ignore them):
- momentum: related work grouped, context switches minimized
- focus_fit: demanding / high-stakes work placed while focus is freshest
- coherence: reads like a sensible human day, not an arbitrary list

Tasks (index: [priority] title (due) ~estimate tags):
{task_lines}

Proposed order (first → last): {ordered_titles}

Reply with ONLY:
{"momentum":0..1,"focus_fit":0..1,"coherence":0..1,"overall":0..1,"critique":"one sentence on the biggest weakness"}
```

**③ Reviser / repair** — `small` tier, JSON output
```
SYSTEM: You revise a task ordering to fix specific defects. Keep what works; change only what the
feedback calls out. You never add or drop tasks. Reply with JSON only.

USER:
The current order has problems. Produce a better order that fixes them.

Tasks (index: [priority] title (due) ~estimate tags):
{task_lines}

Current order: {current_indices}

Must-fix (mechanical violations):
{deterministic_failures}    # e.g. "- index 4 (P1) must come before index 2 (P3)"
                            #      "- 'email' tasks (1,5,7) must be contiguous"
Reviewer note: {judge_critique}

Reply with ONLY a JSON array containing every index exactly once, in the improved order.
```

**Stage reuse.** A3 (rationale): same three roles — generator writes the one-line "why now"; deterministic rubric = (one line, ≤140 chars, mentions the task's title/tag, non-empty); judge scores a single dimension, *truthfulness* vs the task's priority/deadline; reviser repairs flagged hallucinations. A4 (NL constraints): generator (prompt ①-style) + **schema validation as the whole rubric** — no judge, no reviser; invalid ⇒ 422.

### A1 — Activate + persist ordering
- **Goal.** The LLM ranks selected staged tasks (deadlines, priority, momentum) and persists into `daily_plan` **once per day**; the order survives placement, cron re-runs, and reflows.
- **Acceptance.** Toggle on + Ollama up ⇒ `daily_plan` order reflects the LLM ranking; off/down ⇒ deterministic order; no task ever dropped (append-missing rule); a second automatic trigger that day is a no-op (author-once).
- **Loop & rubric (§A0).** Shallow loop (converges fast). Deterministic checks: every staged task present once; no priority inversion (P1 before P3); no past-due placed after an equal-priority later-due; tag groups contiguous (A2). LLM-judge: momentum / context-switch quality. Escape hatch = the deterministic priority order (A1 already falls back to it).
- **File state.** `authorPlanOrder` + `daily_plan` from §0; `flight_plan` is ephemeral staging (deleted on placement), so the order lives in `daily_plan`, not `flight_plan`.
- **Files changing.** `agents/plan.ts` (ranking + `daily_plan` persistence + author-once guard), `engine/autoplan.ts` (invoke once/day), `client/src/lib/api.ts` + Fill UI (optional "AI ordered" indicator).
- **Tests.** Extend [plan.test.ts](../server/test/plan.test.ts): order persisted; partial/garbage LLM output → safe fallback; `<2`-task guard.
- **DoD.** Frozen LLM order drives placement; idempotent across re-runs. **Effort: ~2 days.**

### A2 — Same-tag batching
- **Goal.** Same-tag work clusters adjacently in the frozen order (ARCHITECTURE §4.1 "task batching").
- **Acceptance.** Shared-tag tasks become contiguous in `daily_plan.position` via a deterministic post-pass (guaranteed even if the LLM ignores it); never reorders across a hard priority/deadline boundary; no-tags case unchanged.
- **File state.** Tag lookup exists: `taskTagNames` / `entityTagLevels` ([services/tags.ts], used at [autoplan.ts:24,71](../server/src/engine/autoplan.ts)).
- **Files changing.** `agents/plan.ts` (prompt + stable tag-group post-pass).
- **Tests.** Two tag groups → contiguous runs; priority invariant held; no-tags unchanged.
- **DoD.** Tag clustering visible in positions; priority/deadline invariants intact. **Effort: ~1 day.**

### A3 — Per-block rationale
- **Goal.** A one-line "why now" persisted per placement, shown in block detail (ARCHITECTURE §4.2 step 7).
- **Acceptance.** AI-authored placements carry a `rationale`; toggle-off ⇒ null; UI renders it; degrades silently when absent.
- **Loop & rubric (§A0).** Deterministic checks: one line, ≤140 chars, references the task title or tag, non-empty. LLM-judge: truthfulness vs the task's priority/deadline (catches hallucinated reasons). This is the stage that justifies a deeper loop; keep per-block fan-out at 2.
- **File state.** `rationale` now lives in **`daily_plan`** (the §0 table), written at authoring time — durable across placement, so the separate-requests problem disappears. No `time_blocks.rationale` column needed.
- **Files changing.** No new migration (uses `daily_plan.rationale` from 0064). `agents/plan.ts` writes `daily_plan.rationale`; block detail joins `daily_plan` on `block_id` to display it (`autoplan.ts` sets `block_id` on placement). Client block-detail + `api.ts` type.
- **Tests.** Rationale authored → linked via `block_id` → shown on the block; null when AI off; survives reflow (block id churns, `block_id` re-linked).
- **DoD.** Rationale visible on AI-authored blocks, absent otherwise, no UI break when null. **Effort: ~1 day.**
- **✅ Shipped (as-built).** `generateRationales` ([plan.ts](../server/src/agents/plan.js)) makes ONE batch LLM call (small tier) after a passing authoring loop, keyed by task position; `sanitizeRationale` collapses to a single line, trims, and caps at 140 chars; failures/blanks → null (best-effort, never throws). Written into `daily_plan.rationale` by `persistOrder` **only** on `source='llm'` — basic mode, Ollama-down, and escape-hatch fallbacks all leave it null. The blocks API attaches `rationale` per block via a `daily_plan WHERE block_id` join ([routes/blocks.ts](../server/src/routes/blocks.js), mirroring `secondaryTagsOf`); `placeFlightPlan` already links `block_id`, and a reflow re-links it (rationale survives the churn). Client: `Block.rationale` type + a "why now" line (✨ `Sparkles`) in the chip's `BlockMenu` popover ([Planner.tsx](../client/src/components/Planner.js)), hidden when null. **Simplification:** the spec's per-block §A0 loop with an LLM-judge truthfulness pass is **not** built — a single batch call + deterministic sanitization is the gate; the truthfulness judge is a future enhancement. Tests: [authoring-llm.test.ts](../server/test/authoring-llm.test.ts) +3 — rationale per position on the LLM path, null on the deterministic fallback, sanitization (blank→null, whitespace-collapse, >140 truncation), and the blocks-API `block_id` join surviving a reflow. 80 server files / 695 passed; 137 client; both `tsc` clean.

### A4 — NL planning constraints (stretch)
- **Goal.** `POST /api/plan/instruct { text }` → LLM parses free text ("no deep work after 3pm, batch errands") into **structured pins / ordering hints** the deterministic placer consumes — never free placement.
- **Acceptance.** Parsed constraints yield (a) time pins (appointment-style fixed blocks) and/or (b) ordering/tag-window hints for authoring; invalid input → 422, no mutation; placement stays deterministic given parsed hints; Ollama-down → 503, no partial writes.
- **Loop & rubric (§A0).** The rubric is **pure schema validation** (parses to the typed constraint schema; referenced tags/times exist; no contradictory pins) — **no LLM judge needed**; invalid ⇒ escape hatch (422), never a partial apply.
- **File state.** Pinning supported in placement (Plan/direction windows in autoplan; `taskTime` pins in scheduler). No NL endpoint.
- **Files changing.** New `routes/plan.ts` (`/api/plan/instruct`), `agents/plan.ts` (constraint parser → typed schema), `engine/autoplan.ts` (apply hints in authoring), client command-bar entry.
- **Tests.** Each constraint type → expected pins/hints; adversarial/empty rejected; deterministic placement given hints; Ollama-down handled.
- **DoD.** NL text yields only bounded, structured inputs to the deterministic placer. **Effort: ~2 days (ship after A1–A3).**

### A5 — Prefs + UI toggle
- **Goal.** Turn dormant `planningMode` into a real Settings control; default `ritual` (deterministic); `auto` enables A1–A3. Makes "AI auto-block" honest.
- **Acceptance.** Toggle in Settings flips authoring live; default off; copy: "AI orders your plan; placement stays deterministic."
- **File state.** `planningMode` exists, default `'ritual'` ([schema.ts:155](../server/src/db/schema.ts)); exposed in `api.ts` ([api.ts:421](../client/src/lib/api.ts)); no UI sets it. Prefs are written by **`routes/prefs.ts`**.
- **Files changing.** Settings view + `routes/prefs.ts`, authoring gate reads it. No migration (column exists).
- **Tests.** Toggle persists; authoring respects it; existing settings tests green.
- **DoD.** User-visible toggle gates the whole AI path; honest copy. **Effort: ~0.5 day.**

**Workstream A effort: ~1 week + §A0 harness ~2–3 days (foundational prerequisite)** (A4 stretch additional ~2 days).

---

## Workstream B — Phase-K reactive reflow (#2)

Follows [K-auto-defense.md](archive/K-auto-defense.md) with **one substitution throughout: the engine wrapped is `placeFlightPlan`** (deterministic, reads frozen `flight_plan.position`), not `runScheduler`. The doc's "Current state" + §2 need that correction (cross-cutting).

### B1 — Reflow core + anti-thrash
- **Goal.** `reflow(date, reason)` re-places only auto/unlocked blocks deterministically from the frozen `daily_plan` order, protecting in-progress / recently-moved / over-cap blocks, and returns a "what moved" diff.
- **Acceptance.** Snapshot → `computeProtected` (in-progress via clock; stability window; displacement cap) → `freezeAsLocked` → **re-stage movable tasks from `daily_plan` (preserving `position`)** → `placeFlightPlan(owner,{date})` → `diffBlocks`; identical input ⇒ empty diff; in-progress never moves; cap bounds churn; `freezeAsLocked` restores `is_locked` even on throw; **the LLM is never called** (reflow reads `daily_plan`, never authors).
- **File state.** `placeFlightPlan` clears prior auto via `clearPriorAuto` ([autoplan.ts:187](../server/src/engine/autoplan.ts)) and routes around `dayObstacles` — freezing protected blocks as locked makes them surviving obstacles. It is **consume-once** (deletes staged rows on place), so reflow must **re-stage from the durable `daily_plan`** first — that step is what makes `placeFlightPlan` reflow-capable. `AutoResult` exists; no diff; no `last_moved_at` (confirmed absent).
- **Files changing.** New `server/src/engine/auto-defense.ts` (`reflow`, `computeProtected`, `freezeAsLocked`/`unfreeze`, `restageFromDailyPlan`, `diffBlocks`). **Migration 0062**: `time_blocks.last_moved_at`. Extend `AutoResult` with `diff`. Exercised via `POST /api/schedule/run` (re-pointed to drive reflow) only. New `auto-defense.test.ts`.
- **Tests.** Diff keyed on `task_id` (+ session index, since block ids churn on rebuild); in-progress protected; cap respected; stability window; idempotent twice-run; freeze restores on throw; **no-overlap / no-lost-minutes property tests stay green**.
- **DoD.** Deterministic bounded reflow with diff; anti-thrash proven; no triggers yet. **Effort: ~2 days.**

### B2 — Triggers + debounce
- **Goal.** `requestReplan(reason)` fires a single debounced reflow on real-world shifts; gated by a prefs toggle; never throws into a handler.
- **Acceptance.** Per-owner trailing debounce (1.5s) collapses bursts to one run; wired into `ingestEvents` (meeting writes for today), `routes/tasks.ts` create/update/delete in today's set, and a missed-block sweep; re-entrancy guard prevents reflow→reflow; toggle off ⇒ no-op.
- **File state.** `ingestEvents` writes meeting blocks ([agents/ingest.ts]); `autoScheduleOnIngest` already runs on ingest ([jobs/index.ts:30,39](../server/src/jobs/index.ts)); owner-scoped `broadcast`/`runWithOwner` exist.
- **Files changing.** `engine/auto-defense.ts` (`requestReplan`, `scheduleDebounced`). **Migration 0063**: `scheduling_prefs.auto_defense_enabled` (recommend default **on** — reflow is bounded + nudge-gated). Wire `agents/ingest.ts`, `routes/tasks.ts`, and the missed-block sweep (also kept in the `auto_schedule` cron body as a safety net).
- **Tests.** 5 calls/DEBOUNCE_MS ⇒ one reflow; prefs-off ⇒ no reflow/broadcast; missed block → `skipped` + task re-queued; no reflow-storm; trigger paths swallow errors.
- **DoD.** Reflows fire reactively, bounded, gated, loop-safe. **Effort: ~1.5 days.**
- **✅ Shipped (as-built).** `requestReplan(reason, owner?, date?)` + `sweepMissedBlocks(owner?, date?, now?)` in [auto-defense.ts](../server/src/engine/auto-defense.js); per-owner 1.5 s trailing debounce (`unref`'d), `auto_defense_enabled` gate, re-entrancy guard, errors swallowed; the debounced fire broadcasts `schedule:done` with the diff (B3 seam). Wired into `routes/tasks.ts` create/update/delete; the `auto_schedule` cron pairs `sweepMissedBlocks` + `requestReplan('missed')`; the `sync_calendar` cron fires `requestReplan('calendar')` on any inbound change. **Note vs plan:** the calendar trigger lives in the `sync_calendar` cron (after `syncAll`) rather than `ingestEvents`, because the meeting mirror moved into the connector reconciler ([agents/sync.ts](../server/src/agents/sync.js)) post-WP5. Tests: [replan.test.ts](../server/test/replan.test.ts) (9) — debounce collapse, toggle-off no-op, missed-block sweep (skip/requeue/in-progress/completed), HTTP trigger wiring on/off.

### B3 — Client toast + diff
- **Goal.** A one-line "Re-planned: N blocks moved" toast on real change only.
- **Acceptance.** [stores/index.ts:36](../client/src/stores/index.ts) handler reads `d.diff`; toast only when `moved+added > 0`; no-op cron runs silent; optional expandable "what changed" list.
- **File state.** Bare `on('schedule:done', () => refetchBlocks())`; `showToast` supports actions ([stores/index.ts:191](../client/src/stores/index.ts)).
- **Files changing.** `stores/index.ts` (extend handler), `lib/api.ts` (`ReplanDiff` type), optional diff-list component.
- **Tests.** Toast iff `moved+added>0`; refetch always; no toast on empty diff.
- **DoD.** Honest, low-noise reflow feedback. **Effort: ~0.5 day.**
- **✅ Shipped (as-built).** Decision logic extracted to a pure, unit-tested helper `replanToastMessage(payload)` in [client/src/lib/replan.ts](../client/src/lib/replan.ts) — returns the message (`"Re-planned: N block(s) moved"`, singular/plural; generic `"Re-planned"` when only add/remove) or `null` when nothing changed. A second `on('schedule:done', …)` in [stores/index.ts](../client/src/stores/index.ts) calls `showToast(msg, 'default')` only when the helper returns non-null; the pre-existing `on('schedule:done', () => refetchBlocks())` already repaints the day (and `auto:placed`/`flight_plan:updated` from the inner `placeFlightPlan` also refetch), so no extra fetch was added. `ReplanDiff` + `BlockMove` types in [lib/api.ts](../client/src/lib/api.ts). **Robustness:** the helper tolerates a diff-less payload — `schedule:done` was historically also emitted by the (now caller-less) `runScheduler` with a `ScheduleResult` shape — so a missing-array payload counts as "no change" and never throws. Tests: [replan.test.ts](../client/src/lib/replan.test.ts) (8) — singular/plural, generic, unplaced-only, legacy `ScheduleResult`, null/garbage. No diff-list expander (deferred; the count is enough for low-noise). 137 client tests green; client `tsc` clean.

### B4 — Escalation hook: reflow → async LLM re-author (nudge-first)

Deterministic reflow handles *placement* perfectly but can't *re-triage* — when the day overflows it just defers by position; it can't decide "drop X to tomorrow because it matters less now you're crunched." That judgment is the LLM's. But the answer is **not** "LLM in reflow" (latency, non-determinism, failure surface in a hot path) — it's: reflow stays deterministic and instant, and on **big disruption** it *escalates* by surfacing a nudge; only on explicit user accept does the LLM re-author run. Two clocks: **LLM = slow, async, authoring + triage; deterministic = fast, sync, reactive defense.**

- **Goals.**
  1. Keep B1–B3 instant, reproducible, LLM-free.
  2. When a reflow can't cleanly absorb a disruption, **don't silently re-plan and don't call the LLM in the hot path.**
  3. Detect "big disruption," surface **one actionable nudge**, run the LLM authoring pass **only on explicit user accept** (nudge-first is a hard rule).
  4. **Zero new LLM code path** — accept reuses §0/A authoring (`authorPlanOrder(owner, date, scope='dirty')` → `placeFlightPlan`), inheriting §A0's loop, rubric, log, and escape hatch. The rerun is **targeted**: only untagged / likely-mistagged tasks change; clean tasks keep their `daily_plan.position` (minimal churn).

- **Non-goals.** No LLM in the reflow path (B1 rule holds); no automatic/silent re-author; no new notifications table (reuse SSE + actionable toast + Web Push + the MissedReview banner pattern); no new migration (outstanding-suggestion state is in-memory, like B2's debounce map).

- **Acceptance criteria.**
  - `isBigDisruption(result, diff)` fires when **any**: `diff.removed` contains a task with `priority <= 2`; `result.unplaced > 0`; deferred count rose by `≥ DEFER_NUDGE_THRESHOLD`; or the displacement cap (`MAX_MOVES_PER_RUN`) was saturated.
  - Reflow **still applies its bounded deterministic moves** (day never left broken); *on top of that*, on big disruption with no suggestion already outstanding for `(owner, date)`, it records outstanding (in-memory `Map<ownerId, {date, reason}>`), `broadcast(ownerId, 'replan:suggested', {date, reason, summary})`, and best-effort `sendPush`.
  - Accept: `POST /api/plan/reauthor { date }` → re-entrancy-guarded → `authorPlanOrder(owner, date, scope='dirty')` (targeted: re-tag + re-rank **only** the untagged/mistagged set, leaving clean `daily_plan.position` fixed) → `placeFlightPlan` (deterministic) → clear outstanding → `writeAudit`; refresh via existing `auto:placed`/`schedule:done`. Ollama-down ⇒ falls back to deterministic order ⇒ never throws.
  - Dismiss: `POST /api/plan/reauthor/dismiss { date }` clears outstanding (no re-nudge until the next big disruption).
  - Client `on('replan:suggested')` ⇒ actionable toast ("Re-plan with AI?" → `api.plan.reauthor(date)`, 8s like the reminder toast) **and** a persistent Today banner (MissedReview-style) surviving reload until accept/dismiss.
  - Anti-spam: one outstanding suggestion per `(owner, day)`, cleared on accept/dismiss/day-roll; the re-author runs under B2's re-entrancy flag so it **never emits `replan:suggested` itself**.

- **File state.** Reflow (B1) returns `AutoResult` + `diff`; `authorPlanOrder` from §0/A1; nudge primitives all exist: `broadcast(ownerId, event, data)` ([routes/sse.ts]), `showToast(msg, kind, durationMs, action?)` ([stores/index.ts:191](../client/src/stores/index.ts)) — proven actionable by the `reminder:fire` → "Snooze 10m" handler ([stores/index.ts:199](../client/src/stores/index.ts)); `sendPush` ([lib/push.ts]); persistent banner pattern = [MissedReview.tsx](../client/src/components/MissedReview.tsx). No `notifications` table; no `replan:suggested` event yet.

- **Files that will change.**

| File | Change |
|---|---|
| `server/src/engine/auto-defense.ts` | `isBigDisruption`, `suggestReauthor`, outstanding `Map`, `clearSuggestion`; call at end of `reflow()` |
| `server/src/routes/plan.ts` *(new, shared with A4)* | `POST /api/plan/reauthor`, `POST /api/plan/reauthor/dismiss` |
| `server/src/agents/plan.ts` | reuse `authorPlanOrder` (no B4-specific change) |
| `server/src/lib/push.ts` | reuse `sendPush` (content helper for the nudge) |
| `client/src/lib/sse.ts` / `client/src/lib/api.ts` | `replan:suggested` event type; `api.plan.reauthor` / `.dismiss` |
| `client/src/stores/index.ts` | `on('replan:suggested')` → toast + `replanSuggestion` signal |
| `client/src/components/ReplanBanner.tsx` *(new)* | Today banner (MissedReview pattern) |
| `client/src/views/Today.tsx` | mount `ReplanBanner` |
| *(optional)* migration 0065 | only if outstanding suggestions must survive a server restart (a `replan_suggestions` row). Default: skip (in-memory). |

- **Tests** (`auto-defense.test.ts` additions + new `reauthor.test.ts`, injected `now`, `TZ=UTC`).
  - Big disruption (high-prio in `diff.removed`, or `unplaced>0`) → exactly **one** `replan:suggested`; reflow still applied its deterministic moves.
  - Small disruption (within cap, nothing dropped) → **no** suggestion.
  - De-dup: two big-disruption reflows same day → one outstanding, one nudge.
  - Accept → `authorPlanOrder(scope='dirty')` + `placeFlightPlan` invoked; **only dirty-set tasks change position**, clean tasks fixed; outstanding cleared; refresh emitted.
  - Ollama-down on accept → deterministic fallback, no throw; client "kept current plan" toast.
  - Dismiss → outstanding cleared; no re-nudge until next big disruption.
  - Loop-safety: the re-author does **not** itself emit `replan:suggested` (re-entrancy flag).
  - **Nudge-first invariant (load-bearing):** `authorPlanOrder`/LLM is **never** invoked during `reflow()`; the only LLM call is via `POST /api/plan/reauthor`.
  - Client: `replan:suggested` → toast + banner; accept calls API and clears banner; dismiss clears it.
  - Standing suites green (no overlaps / no lost minutes; B1–B3 idempotency unaffected).

- **Definition of done.** Reflow stays deterministic and LLM-free; the only added LLM invocation sits behind explicit user accept; a big disruption surfaces a single actionable nudge (toast + durable Today banner); the day is never silently re-authored; accept re-authors via the existing authoring path; dismiss suppresses re-nudge; degrades cleanly when Ollama is down; all new + standing tests pass under `TZ=UTC`; `tsc --noEmit` clean; docs describe the two-clock model. **Effort: S–M, ~1.5–2 days** (assumes B1 diff + §0/A1 authoring in place).
- **✅ Shipped (as-built).**
  - **Suggestion lives in `fireReplan`, not `reflow()`** — `reflow()` stays a pure, LLM-free, side-effect-light placement engine. The accept route calls `reflow()` *directly* (not via `fireReplan`), so an accepted re-author can never raise another nudge. This achieves the "re-author never emits `replan:suggested`" invariant *by construction* rather than via a flag.
  - **`isBigDisruption(diff)` = a high-priority (P≤2) task is at risk** — dropped (`removed`) or unplaceable (`unplaced`), via a DB priority lookup (`highPriorityAtRisk`). The spec's `deferred`-rose and `MAX_MOVES_PER_RUN`-saturated signals are **N/A** — the B1 reflow tracks neither. I also tightened the spec's bare `unplaced>0` to *high-priority* unplaced, so a routine over-full day of low-priority backlog doesn't nag.
  - **Accept does a FULL force re-author**, not `scope='dirty'`: `authorPlanOrder(owner, date, { force: true })` deletes the day's `daily_plan` rows (re-opening the author-once guard) → re-authors (LLM if smart+Ollama up, else deterministic; never throws) → `reflow()` re-places → broadcast `schedule:done`. The targeted dirty-set rerun is **deferred** (it overlaps the A-workstream's re-tagging machinery, which isn't built); a full re-author is the honest available behavior.
  - **In-memory state** (`Map<ownerId, {date,reason,summary}>`, one per owner; new day overwrites) — no migration, as planned. `subsFor` was exported from [reminders.ts](../server/src/engine/reminders.js) so the push nudge reuses the same query.
  - **Reload-durable nudge:** `GET /api/plan/suggestion` returns the owner's outstanding suggestion (or null); `ReplanBanner` hydrates from it `onMount` (without clobbering a fresher live signal), because the `replan:suggested` SSE event fires once and isn't replayed on reconnect. State is still in-memory, so a *server* restart clears it — acceptable for the single-user/`launchd` deploy.
  - Files: [auto-defense.ts](../server/src/engine/auto-defense.js) (`isBigDisruption`, `outstandingSuggestion`, `clearSuggestion`, `maybeSuggestReauthor`, `pushReplanNudge`, hooked in `fireReplan`); new [routes/plan.ts](../server/src/routes/plan.js); [agents/plan.ts](../server/src/agents/plan.js) (`force` opt); client [api.ts](../client/src/lib/api.js) (`api.plan`), [stores/index.ts](../client/src/stores/index.js) (`replanSuggestion` signal + `on('replan:suggested')` toast + `on('replan:dismissed')`), new [ReplanBanner.tsx](../client/src/components/ReplanBanner.js), mounted in [Today.tsx](../client/src/views/Today.js).
  - Tests: [reauthor.test.ts](../server/test/reauthor.test.ts) (9) — predicate (high vs low priority, empty), one-nudge-per-day de-dup, **nudge-first invariant** (reflow leaves `daily_plan` untouched while surfacing a nudge), no-nudge on low-priority-only, accept force-re-author + Ollama-down deterministic fallback + clear + refresh, dismiss clears + broadcasts. 80 server files / 690 passed; 14 client files / 137 passed; both `tsc` clean.

**Workstream B effort: ~3–4 days (B1–B3, M) + ~1.5–2 days (B4).**

---

## Workstream C — Back the stubbed claims (#3)

### C1 — `overrun` status
- **Goal.** Set `time_blocks.status='overrun'` when actual work exceeds the planned block span.
- **Acceptance.** On timer stop, if the entry has a `block_id` and **this session's elapsed** (`ended_at − started_at`) exceeds the block's planned span (minus a small tolerance), the block flips to `overrun` and broadcasts `block:updated`; non-overrun stops unchanged; no `block_id` ⇒ no-op. Also a natural `requestReplan('overrun')` trigger (B2).
- **File state.** Nothing sets `overrun` (enum-comment only, [schema.ts:104](../server/src/db/schema.ts)). The stop path is **`stopRunning(owner)` in `services/timer.ts`** (called by `stopTimer`, [tasks.ts:480](../server/src/routes/tasks.ts)); it has `running.block_id`, `started_at`, computed `ended_at`. ⚠️ Note `actualMinutes` it returns is the **task-wide SUM** across all entries, *not* this session — so overrun must compute the session span from `ended_at − started_at` (or the block span vs this entry), not from `actualMinutes`.
- **Files changing.** `services/timer.ts` (`stopRunning` sets overrun on the linked block + returns an `overran` flag), `routes/tasks.ts` (broadcast `block:updated`). No migration. Optional client styling for overrun blocks.
- **Tests.** Session over span → `overrun`; under/at span → unchanged; no `block_id` → no-op; tolerance honored; task-total SUM does not falsely trip overrun across multiple short sessions.
- **DoD.** Overrun is set, broadcast, and honestly reflects reality. **Effort: ~0.5 day.**

### C2 — `day_theme` in placement
- **Goal.** Read `scheduling_prefs.day_theme` (`{"mon":"deep-work",...}`) and bias authoring so theme-matching tags sort first on that weekday (ARCHITECTURE §4.1 "day theming").
- **Acceptance.** On a themed weekday, theme-tag-matching tasks rank ahead in `daily_plan.position`; unthemed days unchanged; deterministic; composes with A2 batching and hard priority rules; weekday boundary correct under the owner's tz.
- **File state.** Field exists + unread ([schema.ts:154](../server/src/db/schema.ts)); weekday derivation via `lib/tz.ts`; tag names via `taskTagNames`.
- **Files changing.** `agents/plan.ts` / `engine/autoplan.ts` authoring (theme bias in the ordering comparator), `routes/prefs.ts` + Settings UI to edit the map.
- **Tests.** Themed weekday biases matching tags; non-matching unaffected; empty/missing theme = no change; weekday boundary correct under tz.
- **DoD.** `day_theme` demonstrably affects ordering; the claim becomes true. **Effort: ~1 day.**
- **Shipped decisions (accepted, not bugs).**
  - **Theme is the primary sort key — it outranks both deadline and priority.** `deterministicIndices` orders `theme → due → priority → id` (or `theme → priority → due → id` under `fill_order='priority'`), so on a themed weekday every theme-tagged task leads the day, ahead of even an overdue unthemed task. This is a deliberate "today is deep-work day" override. `checkOrder` is theme-aware: a themed task leading a higher-priority / earlier-due *unthemed* task is **not** flagged as an inversion, so A2 batching and the LLM rubric still operate on themed days. Within a theme band, deadline (default) or priority (`fill_order`) orders as usual.
  - **Weekday derives from the server tz.** `todayThemeTag` reads the weekday from the `date` string at UTC-noon (boundary-safe for the *string*), but the date itself is `localISODate()` (server tz) — the same single-user/`launchd` assumption the rest of the scheduler makes. A non-server-tz owner near midnight could see the prior/next day's theme. Revisit when multi-tz (Phase L multi-device) lands; until then it's documented, not fixed.

### C3 — `sqlite-vec` for dedupe
- **Goal.** Replace the O(n²) cosine loop with a `vec0` KNN query; keep cosine as fallback.
- **Acceptance.** At DB init, attempt to load `sqlite-vec` on the raw handle; on success `CREATE VIRTUAL TABLE IF NOT EXISTS … vec0(embedding float[D])` with `D` derived from the embed model; dedupe uses KNN; on load failure log once and **fall back to the existing cosine path** ([groom.ts:101](../server/src/agents/groom.ts)) with identical results.
- **File state.** `sqlite-vec` not a dependency ([server/package.json](../server/package.json)); raw handle created in [db/index.ts:9](../server/src/db/index.ts) (the load point); embed model via `resolveEmbedModel` ([mcp/ollama.ts:103](../server/src/mcp/ollama.ts)).
- **Files changing.** `package.json` (+`sqlite-vec`), `db/index.ts` (guarded `loadExtension` + virtual table at init — *not* a numbered migration, since it depends on the extension being loadable), `agents/groom.ts` (KNN path + fallback), config for the dimension.
- **Tests.** With extension: KNN dedupe matches cosine on a fixture; without: clean fallback, no throw; dimension mismatch handled.
- **⚠️ Risk.** Dev is **Windows**, deploy is **Mac/`launchd`** — prebuilt binaries must cover both arches or the load silently falls back. CI usually lacks the extension, so **assert the fallback path in CI**. Build **last**, behind the fallback.
- **DoD.** KNN dedupe when available; identical-result cosine fallback otherwise; CI green on the fallback. **Effort: ~2–3 days.**

---

## Cross-cutting — docs honesty + sequencing

### Docs follow code (DoD: repo never overstates)
As each item lands, correct:
- [ARCHITECTURE.md](../ARCHITECTURE.md) §2.1 ("✅ local-LLM auto-block" → "AI orders the plan; placement deterministic"), §4.1 (day-theming), §4.3 (reactivity → describe Phase K + the two-clock model), §6 (`sqlite-vec`).
- [README.md:179](../README.md) ("reflows when you change the day").
- **Until B/C ship, soften those exact lines to "planned"** so the repo isn't overstating mid-build (recommend interim softening over a single end-sweep).
- Fix the **stale K-doc line** ("auto_schedule cron calls runScheduler") and its wrapping target (`placeFlightPlan`) in [K-auto-defense.md](archive/K-auto-defense.md).

### Test-harness budget (from prior CI experience)
Shared sequential DB; migration-on-import; snapshot pollution from resurrected tables; time-bomb date tests — reproduce CI fails with `TZ=UTC`. Migrations **0062 / 0063 / 0064** (the last adds the `daily_plan` table) and the `vec0` virtual table touch the **baseline characterization snapshot** — regenerate it deliberately and run new suites under `TZ=UTC`.

### AI-in-the-loop risks (local + Ollama)
- **Weak local judges.** A 0.5b model is a noisy evaluator — judge with the `medium` tier, sample 3× and take the median (§A0), and prefer deterministic checks for anything mechanically verifiable.
- **Latency/cost compounding.** Cost ≈ fan-out × iterations × stages. Keep fan-out 2–3 early; reserve deep loops for late/high-value stages (rationale, not ordering); enforce a global per-run call budget that trips the escape hatch.
- **Eval tests can't assert exact model output.** Rubric tests assert the *harness* (separation, deterministic-gate, median, cap, escape hatch, log) — not specific generations; gate on Ollama availability like [plan.test.ts](../server/test/plan.test.ts) already does.

### Migrations & new endpoints summary
> **As-built note.** Migration numbers drifted from the original plan because the §0/A1/A2/C2 batch and an audit fix landed first. Actual head sequence: **0062** `daily_plan` (§0/A1/A3) · **0063** rename `planning_mode` values (basic/smart) · **0064** `time_blocks.last_moved_at` (B1) · **0065** flip `fill_order` default → `'overdue'` (deadline-first) · **0066** `scheduling_prefs.auto_defense_enabled` (B2, default on).

| # | Change | Workstream | Status |
|---|---|---|---|
| 0062 | `daily_plan` table (durable day plan: order, rationale, source, block_id) | §0 / A1 / A3 | ✅ shipped |
| 0063 | rename `planning_mode` values `ritual→basic`, `auto→smart` | A5 follow-up | ✅ shipped |
| 0064 | `time_blocks.last_moved_at` | B1 | ✅ shipped |
| 0065 | `fill_order` default → `'overdue'` (deadline-first; maps onto authoring) | §0 follow-up | ✅ shipped |
| 0066 | `scheduling_prefs.auto_defense_enabled` (default on) | B2 | ✅ shipped |
| — (init) | `vec0` virtual table (guarded, not numbered) | C3 | pending |
| — | none — revision log reuses `audit_log`; `overrun` enum / `day_theme` / `planning_mode` already exist | §A0 / C1 / C2 / A5 | ✅ shipped |

New endpoints: `POST /api/plan/instruct` (A4, pending); `GET /api/plan/suggestion` + `POST /api/plan/reauthor` + `POST /api/plan/reauthor/dismiss` (B4, ✅ — new `routes/plan.ts`); `POST /api/schedule/run` re-pointed to drive reflow (B1, ✅).

### Recommended sequence
1. **§0 seam + `daily_plan`** — add the durable day table; relocate the LLM hook to author into it; confirm Option A.
2. **C1 overrun + C2 day_theme** — small, self-contained; make two doc claims true immediately.
3. **B1 → B2 → B3 → B4** — reflow (re-staging from `daily_plan`) + the targeted re-author escalation hook.
4. **§A0 harness → A1 → A2 → A3 → A5** — build the generate/evaluate loop first, then real LLM authoring (author-once + targeted rerun) on top (safe now that placement/reflow are LLM-free); A4 stretch.
5. **C3 sqlite-vec** — last (platform risk, behind fallback).
6. **Docs sweep** — as each merges.

**Total: ~3–3.5 weeks across ~10 PRs** (v2: `daily_plan` folds into §0; the `plan_revisions` PR is dropped in favour of `audit_log`).

---

## Open decisions
1. **Confirm Option A** (LLM authors the durable `daily_plan`; placement + reflow read it) vs Option B (route everything through `runScheduler`). Ripples through §0, A1, B1. **Recommend A.**
2. **`auto_defense_enabled` default** — recommend **on** (reflow is bounded + nudge-gated), or ship off and opt-in.
3. **`runScheduler` fate** — align it to read the `daily_plan` order or retire `/api/schedule/run` once reflow drives placement.

## Known issues (not fixed by this plan)
These survive the v2 revision and should be decided while building, not discovered later:
1. **No whole-feature eval / ROI.** Nothing yet shows LLM ordering beats the deterministic priority/due sort. Add a cheap **offline A/B** (LLM order vs deterministic, scored or measured against actual completion) *before* committing the full §A0 loop — otherwise weeks of local-inference cost may buy indistinguishable plans.
2. ~~**CI can't exercise the AI path** (no Ollama) — the loop/judge/reviser run only their fallback in CI.~~ **Resolved:** `loop.test.ts` mocks the harness contract and `authoring-llm.test.ts` mocks `mcp/ollama.js` (branching on generate tier) to drive `authorPlanOrder`'s LLM path — `source='llm'` permutation, Ollama-down fallback, and `safeOrder` append-missing are all exercised in CI.
3. **In-memory B2/B4 state** (debounce + outstanding-nudge maps) is lost on a laptop restart — for this local/`launchd` deployment the "optional" persistence migration is closer to required.
4. **Four overlapping reschedulers** (once-a-day authoring, deterministic reflow, nightly `review_day`, manual Fill/Place) — v2 improves the mental model ("AI plans when you ask; the system defends deterministically"), but the composition still needs a single user-facing explanation.
