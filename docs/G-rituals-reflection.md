# G — Rituals & reflection (implementation spec)

Companion to [ROADMAP.md](ROADMAP.md). Depends on **C** (rich task semantics), **D** (time tracking / actuals), and **E** (recurring & habits). This is where the **AI-ordering pass deferred from Phase A** finally lands — by now D gives per-task actuals and E gives habit history, so the model has real signal to order on.

## Goal
1. Make the **dead `planning_mode` column behaviorally real** — `auto` and `ritual` must observably diverge, not just store a different string.
2. `ritual` = guided **daily-plan** + evening **shutdown** flows (human in the loop).
3. `auto` = silent auto-schedule **plus an AI-ordering pass** over the today-set: the LLM orders candidates, **placement stays deterministic**, and it falls back to the deterministic ranking whenever Ollama is unavailable or returns junk.
4. A **weekly review** that aggregates planned-vs-done, estimate-vs-actual (from D), and habit streaks (from E) — numbers that reconcile exactly with source rows.

## Non-goals
- No new scheduling algorithm. The packer (`buildGaps`/`pickGap`/`splitIntoSessions` in `engine/scheduler.ts`) is untouched; G only changes the **order** candidates are fed to it in `auto` mode.
- The LLM never **places** a block, never picks a time, never invents or drops a task. It re-orders a fixed candidate list, full stop.
- No notifications/reminders (that's **H**) — shutdown/daily-plan are in-app flows triggered by the user or the existing cron, not push.
- No multi-owner anything; single-owner via `lib/context.ts` (B0) as everywhere else.

## Current state (what exists today)
- **`scheduling_prefs.planningMode`** — `server/src/db/schema.ts:68`: `text('planning_mode').default('ritual')` with comment `// auto | ritual`. **Stored, never read by any logic.** Grep `planning_mode`/`planningMode` across `server/src` hits only schema + the prefs router serialize path; `engine/scheduler.ts` ignores it entirely.
- **Scheduler** — `server/src/engine/scheduler.ts`: fully deterministic. Builds the today-set (`candidates`, lines 89–93) via `ORDER BY priority ASC, due_at ASC, id ASC`, pins fixed-time tasks, then packs the rest into gaps. `runScheduler(date)` is the only entry point; called by `POST /api/schedule/run` (`routes/schedule.ts`) and the cron.
- **Summarizer** — `server/src/agents/summarize.ts`: the established "LLM with deterministic fallback" pattern. `summarizeDay()` calls `generate(...)` inside try/catch, falls back to `fallbackProse()`, caches per `(owner, date)` in `daily_summaries` keyed on an `inputsHash`. **Copy this shape for the AI-ordering pass and the weekly review.**
- **Ollama client** — `server/src/mcp/ollama.ts`: exports `generate`, `generateJson<T>` (tolerant JSON parse via `parseJsonLoose`), and `isAvailable()` (never throws). `generateJson` throws `OllamaUnavailable` on transport failure and a plain `Error` if no JSON parses — both must be caught and treated as "degrade".
- **Settings UI** — `client/src/views/Settings.tsx:54–77`: the planning-mode radio (`auto` ⚡ / `ritual` 🌅) already writes `planning_mode` via `api.prefs.update`. The toggle works; nothing downstream reacts to it.
- **Today UI** — `client/src/views/Today.tsx`: unconditional "Auto-schedule" button + AI briefing card. No ritual entry point, no shutdown, no review.
- **tz** — `server/src/lib/tz.ts` exports `serverTimezone`, `zonedWallTimeToUTC`, `utcDayBounds`. All day-boundary math goes through these; no hand-rolled `Z` wall-clock.

## Design

### 1. Making `planning_mode` behavioral
Read the column once, branch on it. Resolve mode at the scheduler entry and at the route layer:

```ts
// engine/scheduler.ts — inside runScheduler, after loading prefs
const mode = (prefs.planningMode === 'auto' ? 'auto' : 'ritual') as 'auto' | 'ritual';
```

- **`auto`**: `runScheduler` runs end-to-end as today, but the candidate list is reordered by the AI pass (§2) before pinning/packing. The morning cron fires the schedule only when `mode === 'auto'`.
- **`ritual`**: the morning cron does **not** silently place blocks; it produces a **draft plan** the user confirms via the daily-plan flow (§3). Same deterministic packer, but the divergence is *who commits it* (cron vs. human) — in `ritual`, no auto blocks appear until the user finishes the daily plan. That is the observable difference the Roadmap requires.

A thin resolver keeps route and cron in agreement:

```ts
// engine/planning.ts (new)
import { db } from '../db/index.js';
import { schedulingPrefs } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { currentOwnerId } from '../lib/context.js'; // B0
export async function planningMode(): Promise<'auto' | 'ritual'> {
  const [p] = await db.select().from(schedulingPrefs).where(eq(schedulingPrefs.ownerId, currentOwnerId()));
  return p?.planningMode === 'auto' ? 'auto' : 'ritual';
}
```

### 2. The AI-ordering pass (deferred from Phase A)
A pure **re-ranking** step over the already-computed today-set. Deterministic core, AI on top.

```ts
// engine/aiOrder.ts (new)
import { generateJson, isAvailable } from '../mcp/ollama.js';
import { logger } from '../lib/logger.js';

interface Candidate { id: number; title: string; priority: number; dueAt: string | null;
  estimatedMinutes: number | null; actualAvgMinutes?: number | null; /* from D */ }

/** Returns the SAME tasks, reordered. On any failure returns `det` unchanged. */
export async function aiOrder<T extends Candidate>(det: T[]): Promise<{ order: T[]; usedLlm: boolean }> {
  if (det.length < 2 || !(await isAvailable())) return { order: det, usedLlm: false };
  try {
    const prompt = buildOrderPrompt(det);                    // asks for a JSON array of ids
    const out = await generateJson<{ order: number[] }>(prompt, { tier: 'small', temperature: 0.1, timeoutMs: 20_000 });
    const ranked = reconcile(det, out.order);                // see guard below
    if (!ranked) return { order: det, usedLlm: false };
    return { order: ranked, usedLlm: true };
  } catch (err) {
    logger.warn('aiOrder fell back to deterministic ranking', { err: (err as Error).message });
    return { order: det, usedLlm: false };
  }
}
```

**`reconcile` is the safety gate** — junk-tolerant, never trusts the model with set membership:
- Build `byId` from `det`. Walk `out.order`, emit each id seen **exactly once** that exists in `byId`.
- **Append any `det` id the model omitted**, in original deterministic order (so a truncated/partial response can't drop a task).
- If the result isn't a permutation of `det` (length mismatch after dedupe/append), **return `null`** → caller uses `det`.
- This guarantees: same set, no dupes, no drops, no hallucinated ids — the LLM only permutes.

Wire into the scheduler **before** pinning, replacing the static sort as the input order:

```ts
// engine/scheduler.ts, after the `candidates` query
let ordered = candidates;
if (mode === 'auto') {
  const { order, usedLlm } = await aiOrder(candidates);
  ordered = order;
  logger.info('scheduler.aiOrder', { usedLlm, n: candidates.length });
}
// ...then use `ordered` everywhere `candidates` was used (pinned filter + packing loop)
```

Pinned tasks (fixed time-of-day) keep their clock time regardless of AI order — ordering only affects which flexible tasks win contested gaps first. The prompt feeds priority, due date, estimate, and D's `actualAvgMinutes` so the model can reason about effort fit; it returns **only** `{ "order": [ids...] }`.

### 3. Daily-plan + shutdown ritual flows
Two stateless endpoints over existing data; no new heavy machinery.

**Daily plan** (morning, `ritual` mode):
- `GET /api/ritual/daily-plan?date=YYYY-MM-DD` → returns the **proposed** plan: run the deterministic packer in-memory (or read the draft blocks) + the today-set, *including unfinished items carried forward via the Phase-A rollover/today-set* (overdue + undated tasks already fall into `candidates` by the existing `isNull(dueAt) OR dueAt < horizonEnd` clause — no new carry-forward logic needed).
- `POST /api/ritual/daily-plan/commit { date }` → runs `runScheduler(date)` for real (committing the auto/unlocked blocks) and stamps a `ritual_log` row (`kind='daily_plan'`). This is the human "commit" that `ritual` mode requires.

**Shutdown** (evening, both modes):
- `GET /api/ritual/shutdown?date=YYYY-MM-DD` → today's blocks with their `status` (planned/completed/skipped/overrun) + tasks touched, so the user can tick off / reflect.
- `POST /api/ritual/shutdown/commit { date, notes? }` → writes a `ritual_log` row (`kind='shutdown'`, freeform `notes`), and **rolls unfinished open work forward** by leaving it open (the today-set re-pulls it next day — we don't mutate due dates). Optionally marks the day "closed".

```ts
// routes/ritual.ts (new) — register in routes/index.ts alongside scheduleRouter()
router.get('/api/ritual/daily-plan', async (ctx) => {
  const date = (ctx.query.date as string) ?? localISODate();
  ctx.body = await buildDailyPlan(date);           // { date, proposed: Block[], carriedForward: Task[], mode }
});
router.post('/api/ritual/daily-plan/commit', async (ctx) => {
  const { date } = ctx.request.body as { date?: string };
  const d = date ?? localISODate();
  const result = await runScheduler(d);
  logRitual('daily_plan', d);
  ctx.body = { committed: true, ...result };
});
```

New table (via a **numbered B0-runner migration** — owner-scoped, UTC ISO text):

```ts
// db/migrations/00NN_ritual_log.ts
export const id = '00NN_ritual_log';
export function up(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ritual_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id   INTEGER NOT NULL REFERENCES owners(id),
    date       TEXT NOT NULL,                 -- local calendar day YYYY-MM-DD
    kind       TEXT NOT NULL,                 -- daily_plan | shutdown
    notes      TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ritual_owner_date ON ritual_log(owner_id, date);`);
}
```

**Client** (`Today.tsx`): branch the header on `prefs().planning_mode`. In `ritual`, replace the bare "Auto-schedule" button with a **"Plan my day"** entry that opens a daily-plan panel (proposed blocks + carried-forward list, a Confirm button hitting `/commit`); add an evening **"Shut down"** entry → shutdown panel. In `auto`, keep today's button (it already commits silently).

```tsx
<Show when={prefs()?.planning_mode === 'ritual'} fallback={<AutoScheduleButton />}>
  <button class="btn-primary" onClick={() => setRitual('daily-plan')}>
    <Sunrise size={14} /> Plan my day
  </button>
</Show>
```

### 4. Weekly-review aggregation
Read-only rollup over a 7-day window; **all numbers derived from raw rows so they reconcile exactly.** UTC bounds via `utcDayBounds(start)` … `utcDayBounds(end)` from `lib/tz.ts`.

- `GET /api/review/weekly?week=YYYY-MM-DD` (any date in the week; server snaps to the local week start).
- Aggregates, owner-scoped (`currentOwnerId()`):
  - **planned-vs-done**: `time_blocks` in range grouped by `status` (`planned`/`completed`/`skipped`/`overrun`).
  - **estimate-vs-actual** (D): join task `estimated_minutes` against summed `time_entries` actuals (D's table) per task; report total estimated, total actual, and per-task variance.
  - **habit streaks** (E): current/longest streak per `habit` flag from E's recurrence-instance completion history.
- Prose summary reuses the summarizer pattern: deterministic table always computed; an **optional** LLM narrative via `generate(...)` in try/catch, `usedLlm` flag in the response, deterministic sentence fallback. Cache per `(owner, week)` keyed on an inputs hash, mirroring `daily_summaries`.

```ts
// agents/weeklyReview.ts (new)
export interface WeeklyReview {
  weekStart: string; weekEnd: string;
  planned: { completed: number; skipped: number; overrun: number; planned: number };
  estimateVsActual: { taskId: number; title: string; estimated: number; actual: number }[];
  habits: { habit: string; current: number; longest: number }[];
  prose: string; llm: boolean;
}
```

**Client**: a new `Review.tsx` view (route in the existing router) — a scorecard: planned/done donut, an estimate-vs-actual table with variance badges, habit-streak chips. No new design system; reuse `card`/`section-label`.

## Tests
- **`aiOrder.test.ts`** (the core safety net):
  - **Permutation invariant**: for any model `order`, output is a permutation of input (same id multiset) — property test over random id lists incl. dupes, missing ids, extra/hallucinated ids, empty, reversed.
  - **Ollama down** (`isAvailable()` false / `generateJson` throws `OllamaUnavailable`) → returns `det` unchanged, `usedLlm:false`.
  - **Junk JSON** (non-array, wrong key, ids not in set) → `reconcile` rejects → `det` unchanged.
  - **Partial order** (model returns first 3 of 10) → omitted 7 appended in deterministic order.
- **Scheduler divergence**: with a fixed candidate set and a stubbed `aiOrder` returning a known permutation, `auto` produces a different block ordering than `ritual`'s deterministic order — `auto` vs `ritual` **observably diverge** (Roadmap acceptance). With Ollama stubbed unavailable, `auto` === deterministic (graceful degrade), proving placement stayed deterministic.
- **Ritual flow**: `ritual` mode → morning cron creates **no** committed auto blocks until `/daily-plan/commit`; after commit, blocks exist and a `ritual_log(kind='daily_plan')` row is written. Shutdown writes `kind='shutdown'`; unfinished tasks remain open and reappear in the next day's today-set (carry-forward via Phase-A rollover, no due-date mutation).
- **Weekly review reconciliation**: seed known blocks/`time_entries`/habit completions → every review number equals a hand-summed expectation **exactly** (Roadmap: "reconcile exactly with raw entries/completions"). DST week included via `lib/tz.ts` bounds.
- **Migration**: `ritual_log` migration is idempotent on re-run (B0 runner); fresh + upgrade both apply.
- **Standing suites**: Vitest + container Playwright green; scheduler property tests (no overlaps, no lost minutes) still pass under `auto` ordering.

## Acceptance criteria
1. **`planning_mode` is no longer dead**: `auto` and `ritual` produce observably different behavior (silent commit vs. human-confirmed daily plan), proven by test.
2. `auto` runs the AI-ordering pass; **placement stays byte-for-byte deterministic** and identical to the no-LLM path whenever Ollama is unavailable or returns junk.
3. The LLM only re-orders the today-set — never places, invents, or drops a task (permutation invariant enforced by `reconcile` + property tests).
4. Daily-plan carries unfinished items forward via the Phase-A rollover/today-set; shutdown records reflection without losing open work.
5. Weekly review's planned-vs-done, estimate-vs-actual (D), and habit-streak (E) numbers reconcile **exactly** with source rows.
6. Whole existing suite green; no auth surface added; all new schema via numbered B0 migrations.

## Risks / notes
- **The AI pass is the only place an LLM touches scheduling — keep it caged.** `reconcile` is load-bearing: if it ever lets a non-permutation through, the deterministic-core principle breaks. Test it adversarially.
- **Don't let `auto` block on Ollama.** `isAvailable()` gates the call; `timeoutMs` is 20s (shorter than the summarizer's 60s — the morning cron is latency-sensitive). A slow model must degrade, not stall the schedule.
- **Reconciliation depends on D and E.** Estimate-vs-actual needs D's `time_entries`; streaks need E's history. If a dependency table is absent, degrade that section to "—" (feature-detect), don't crash.
- **Ritual-mode cron change is behavioral.** The morning cron goes from unconditional commit to mode-conditional; it must read mode via the §1 resolver so cron and route never disagree.
- **No reversibility / no due-date mutation.** `ritual_log` is append-only, forward-only per B0. Shutdown carry-forward is "leave it open," nothing more — mutating due dates would corrupt the deterministic today-set.
- **Cache invalidation.** Weekly-review caches on an inputs hash like `summarize.ts`; hash over the raw aggregates (not just the date) so a late time-entry edit invalidates it.

## Effort
**M** — roughly 4–6 days. The AI-ordering pass + `reconcile` guard and its property tests are ~1.5 days; the ritual route/flow + `ritual_log` migration + Today.tsx branching ~2 days; weekly-review aggregation + `Review.tsx` ~1.5 days. Most of the risk is concentrated in the `reconcile` invariant and the mode-conditional cron.

## Suggested PR breakdown
1. **AI-ordering pass** (no UI): `engine/aiOrder.ts` + `reconcile`, wire into `scheduler.ts` behind `mode==='auto'`, `engine/planning.ts` resolver. Ship with `aiOrder.test.ts` (property tests) + the scheduler divergence/degrade tests. Pure server, fully testable, no schema.
2. **Ritual flows**: `ritual_log` migration, `routes/ritual.ts` (daily-plan + shutdown), mode-conditional morning cron, `Today.tsx` daily-plan/shutdown panels. Makes `planning_mode` observably live.
3. **Weekly review**: `agents/weeklyReview.ts` (cached, LLM-optional), `GET /api/review/weekly`, `Review.tsx` scorecard + route. Reconciliation tests.

Sequencing 1→2→3 keeps each diff small: ordering is invisible until UI exists, rituals don't need review, and review is read-only over data the first two PRs (and D/E) already produce.
