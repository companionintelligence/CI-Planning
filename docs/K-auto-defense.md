# K — Auto-defense (continuous re-plan) (implementation spec)

Companion to [ROADMAP.md](ROADMAP.md). Depends on **A** (the deterministic scheduler), **F** (locked/meeting/completed blocks the reflow must respect), and **J** (inbound calendar sync, the main trigger). Re-plans the day automatically when reality shifts — **deterministically, reusing the Phase-A scheduler, with anti-thrash as the core feature.**

## Goal
1. **React, don't wait for the cron.** When a meeting lands (J), a block is missed, or a task changes, re-plan *now* instead of at the next `auto_schedule` tick.
2. **Reflow only auto/unlocked blocks** by reusing `runScheduler(date)` — the same deterministic packer, no second scheduling code path, **no LLM**.
3. **Never thrash.** Don't move the block the user is currently in, don't touch locked/meeting/completed work, bound how much moves per run, hold a stability window before re-moving the same block, and debounce on top.
4. **Tell the user what moved.** Emit `schedule:done` with a "what moved" diff; the client shows a "re-planned" toast listing the changes. A prefs toggle gates the whole feature.

## Non-goals
- **No new scheduling algorithm.** K is a *trigger + guardrail* layer around A; the packing logic in `engine/scheduler.ts` is untouched except where anti-thrash hooks in.
- **No AI / LLM** anywhere in the reflow path. Determinism is a hard rule.
- **No cross-day re-plan.** K re-plans the *current local day* only (same scope as `auto_schedule`).
- **No conflict UI / undo.** The toast is informational; manual edits already win because they lock or complete blocks.
- **No multi-device convergence** — that's L.

## Current state (what exists today)
- `server/src/engine/scheduler.ts` → `runScheduler(date)`: the deterministic Phase-A scheduler. It (1) `DELETE`s `time_blocks WHERE … is_auto = 1 AND is_locked = 0 AND status NOT IN ('completed','skipped')` across the local day (idempotent re-run), (2) keeps fixed events (`is_locked = 1 OR block_kind = 'meeting'`), pins appointments, packs flexible work into gaps, then (3) `broadcast('schedule:done', result)`. **It rebuilds the whole day from scratch every run** — it has no notion of "don't move this one block."
- `server/src/jobs/index.ts` → `auto_schedule` cron calls `runScheduler(localISODate())`. Triggering today is purely time-based.
- `server/src/routes/schedule.ts` → `POST /api/schedule/run { date? }` calls `runScheduler` directly.
- `server/src/routes/sse.ts` → global `broadcast(event, data)` over a `Set<PassThrough>` (B0 makes this owner-scoped: `broadcast(ownerId, event, data)`).
- `client/src/stores/index.ts` → `on('schedule:done', () => refetchBlocks())`; `showToast(message, kind)` helper already exists.
- `server/src/db/schema.ts` → `time_blocks` has `block_kind` (task | meeting | …), `is_locked`, `is_auto`, `status` (**planned | completed | skipped | overrun** — note: there is **no `in_progress` status on blocks**; "in-progress" must be derived from the clock). `scheduling_prefs` holds workday/horizon prefs (add the K toggle here).
- Time is UTC ISO text; wall-clock conversions go through `server/src/lib/tz.ts` (`utcDayBounds`, `zonedWallTimeToUTC`, `serverTimezone`); local day via `lib/dates.ts` `localISODate()`. Owner scoping via `lib/context.ts` `currentOwnerId()` (B0).

## Design

### 1. Triggers — one entry point, three callers
A single `requestReplan(reason)` in a new `server/src/engine/auto-defense.ts` is the only thing that fires reflows. Callers:
- **Inbound sync (J):** after `ingestEvents()` writes/updates/deletes a `meeting` block for *today*, call `requestReplan('meeting-sync')`.
- **Missed-block detection:** a lightweight sweep (run from the `auto_schedule` cron body and on `requestReplan`) marks `planned` blocks whose `end_at < now` as `skipped`, re-opening their task so the packer re-queues it; if any were missed, `requestReplan('missed-block')`.
- **Task changes:** in `routes/tasks.ts` create/update/delete handlers, if the task is in today's set, call `requestReplan('task-change')`.

```ts
// engine/auto-defense.ts
export type ReplanReason = 'meeting-sync' | 'missed-block' | 'task-change' | 'manual';
export function requestReplan(reason: ReplanReason, ownerId = currentOwnerId()): void {
  if (!autoDefenseEnabled(ownerId)) return;     // prefs gate — degrade to no-op
  scheduleDebounced(ownerId, reason);           // §4
}
```

### 2. The reflow algorithm — reuse Phase-A, snapshot → run → diff
We do **not** fork the scheduler. We wrap it: snapshot the auto/unlocked blocks before, run `runScheduler`, snapshot after, and apply anti-thrash by **re-pinning protected blocks as fixed** so the packer is forced to route around them.

```ts
// engine/auto-defense.ts
export async function reflow(date: string, reason: ReplanReason): Promise<ReplanDiff> {
  const before = snapshotAutoBlocks(date);          // id,title,taskId,startAt,endAt
  const protectedIds = computeProtected(date, before); // §3 — never-move set
  freezeAsLocked(protectedIds);                     // set is_locked=1 so runScheduler keeps them
  try {
    await runScheduler(date);                        // unchanged Phase-A packer
  } finally {
    unfreeze(protectedIds);                          // restore is_locked=0 (these stay auto)
  }
  const after = snapshotAutoBlocks(date);
  const diff = diffBlocks(before, after, reason);   // §5
  return diff;
}
```

`freezeAsLocked` is the trick that lets us reuse A verbatim: a temporarily-locked block survives the scheduler's `DELETE` and is treated as a fixed event in `buildGaps`, so the rest of the day packs around it. Wrapped so a crash restores the flag (the blocks must not stay locked).

### 3. THE ANTI-THRASH RULES (`computeProtected`)
These rules decide the **never-move set** for a run. This is the heart of K.

```ts
function computeProtected(date: string, before: Snapshot[]): Set<number> {
  const now = Date.now();
  const keep = new Set<number>();
  // (a) IN-PROGRESS — the block the user is *currently in*. Derived from the clock,
  //     not a status (blocks have no 'in_progress'): start_at <= now < end_at.
  for (const b of before)
    if (Date.parse(b.startAt) <= now && now < Date.parse(b.endAt)) keep.add(b.id);
  // (b) STABILITY WINDOW — don't re-move a block that moved within the last
  //     STABILITY_MS. Requires a `last_moved_at` column on time_blocks (set by §2).
  for (const b of before)
    if (b.lastMovedAt && now - Date.parse(b.lastMovedAt) < STABILITY_MS) keep.add(b.id);
  // (c) DISPLACEMENT CAP — protect the longest-settled blocks until at most
  //     MAX_MOVES_PER_RUN remain movable. Bounds churn even when many could move.
  const movable = before.filter((b) => !keep.has(b.id))
    .sort((a, z) => settledMs(z) - settledMs(a));     // most-settled first
  for (const b of movable.slice(MAX_MOVES_PER_RUN)) keep.add(b.id);
  return keep;
}
const STABILITY_MS = 10 * 60_000;   // a block can't be re-moved < 10 min after last move
const MAX_MOVES_PER_RUN = 4;        // at most N auto-blocks relocate per reflow
```
Locked/meeting/completed/skipped blocks are **already** protected by the scheduler's own `DELETE` filter (`is_auto=1 AND is_locked=0 AND status NOT IN ('completed','skipped')`) — they never enter `before`, so no extra rule is needed for them. The rules above add: in-progress, recently-moved, and over-cap.

### 4. Debounce — collapse storms into one run
A burst of triggers (a sync writing 5 meetings, a bulk task import) must produce **one** reflow, not five.

```ts
const pending = new Map<number, NodeJS.Timeout>();   // ownerId -> timer
function scheduleDebounced(ownerId: number, reason: ReplanReason) {
  clearTimeout(pending.get(ownerId));
  pending.set(ownerId, setTimeout(() => {
    pending.delete(ownerId);
    runWithOwner(ownerId, () => reflow(localISODate(), reason)
      .then(emitDiff).catch((e) => logger.error('reflow failed', { e })));
  }, DEBOUNCE_MS));                                   // trailing edge
}
const DEBOUNCE_MS = 1_500;
```
Per-owner timer (owner-scoped, B0). One reflow at a time per owner — if a trigger lands mid-reflow, the trailing timer re-fires after it settles. `reflow` runs inside `runWithOwner` so DB reads and `broadcast` target the right owner.

### 5. The "what moved" diff
`diffBlocks` joins `before`/`after` on `taskId` (the stable identity across a rebuild; block `id`s are new each run) and classifies each into `moved | added | removed | unchanged`. Identical input ⇒ empty `moved/added/removed` ⇒ **no-op** (idempotent — the scheduler already produces byte-identical blocks for identical input).

```ts
export interface ReplanDiff {
  reason: ReplanReason;
  moved:   { taskId: number; title: string; from: string; to: string }[];
  added:   { taskId: number; title: string; at: string }[];
  removed: { taskId: number; title: string }[];
}
```
`emitDiff` attaches the diff to the existing `schedule:done` payload (extend `ScheduleResult`, don't add a new event), and stamps `last_moved_at = now` on every block in `moved`/`added` so §3(b) can hold it next run.

### 6. Client toast + diff
`client/src/stores/index.ts` already does `on('schedule:done', () => refetchBlocks())`. Extend the handler: if the payload carries a non-empty diff, show a toast.

```ts
on('schedule:done', (d: ScheduleResult & { diff?: ReplanDiff }) => {
  refetchBlocks();
  const n = (d.diff?.moved.length ?? 0) + (d.diff?.added.length ?? 0);
  if (n > 0) showToast(`Re-planned: ${n} block${n > 1 ? 's' : ''} moved`, 'default');
});
```
The diff also feeds an optional expandable "what changed" list; keep the toast itself one line per the owner's brevity preference. Cron-driven runs with no real change emit an empty diff ⇒ no toast (no noise).

## Tests
- **`auto-defense.test.ts`** (Vitest, deterministic via injected `now`):
  - **New meeting reflows overlapping auto-blocks**, never moves locked/meeting/completed.
  - **In-progress never displaced:** a block with `start_at <= now < end_at` is in `protected`; identical `start_at` before/after even when a conflicting meeting lands on it.
  - **Missed block re-queues its task:** a `planned` block with `end_at < now` → `skipped`, task re-opened, re-packed later in the day (not lost).
  - **Identical input is a no-op:** two reflows, no input change ⇒ empty diff, no `last_moved_at` churn.
  - **Reflow idempotent:** `reflow` then `reflow` again ⇒ second diff empty.
  - **Displacement cap:** 10 movable blocks + conflict ⇒ at most `MAX_MOVES_PER_RUN` change.
  - **Stability window:** a block moved at T can't be re-moved before T + `STABILITY_MS`.
  - **`freezeAsLocked` always restores** `is_locked` even when `runScheduler` throws.
- **Debounce test:** 5 `requestReplan` calls within `DEBOUNCE_MS` ⇒ exactly **one** `reflow`.
- **Prefs gate:** toggle off ⇒ `requestReplan` is a no-op (no reflow, no broadcast).
- **SSE:** `schedule:done` carries the diff; client handler shows a toast only when `moved+added > 0`.
- **Standing suites** (server Vitest + scheduler property tests + container Playwright) stay green — A's invariants (no overlaps, no lost minutes) must hold after every reflow.

## Acceptance criteria
1. A conflicting meeting (from J) triggers a **bounded** reflow within `DEBOUNCE_MS`; nothing locked/active/completed moves.
2. The block the user is **currently in is never displaced**, ever, regardless of trigger.
3. Missed work is **rescheduled, not lost** (re-queued onto the same day if room remains).
4. **No reflow storms:** a burst of triggers collapses to one run; per-run displacement is capped; a just-moved block holds for the stability window.
5. **Identical input ⇒ no-op** (empty diff, no toast, no `last_moved_at` churn) — idempotent.
6. Deterministic: **no LLM** in the reflow path; same inputs ⇒ same blocks.
7. Prefs toggle gates the feature; off ⇒ behaviour identical to today (cron-only).

## Risks / notes
- **Block identity across a rebuild.** `runScheduler` DELETEs and re-INSERTs, so block `id`s churn. Diff and `last_moved_at` must key on `task_id` (+ session index for split blocks), not block `id`. The new `last_moved_at` must be carried over by `taskId` on rebuild, or the stability window resets every run and anti-thrash silently dies.
- **"Now" is the load-bearing input.** In-progress detection is clock-derived (blocks have no `in_progress` status). Tests must inject `now`; production reads one `Date.now()` per reflow to avoid mid-run drift.
- **`freezeAsLocked` is a mutation across a reuse boundary** — wrap in try/finally; a leaked lock turns an auto-block permanent. Consider a transaction so freeze+run+unfreeze is atomic on crash.
- **Trigger feedback loop:** the reflow writes blocks, which could re-trigger task/block listeners. Guard with a re-entrancy flag (or the single-in-flight rule) so a reflow never schedules another reflow.
- **Cron + event-driven coexist:** keep the `auto_schedule` cron as the safety net; K only adds *earlier* reflows. The missed-block sweep belongs to both paths.
- **Degrade gracefully:** if J/sync is offline or prefs is unreadable, `requestReplan` no-ops; the cron still runs. No trigger path may throw into a request handler.

## Effort
**M** — roughly 3–4 days. The packer is reused as-is; the work is the anti-thrash rules (§3), the freeze/diff plumbing (§2, §5), debounce, the `last_moved_at` migration, and the trigger wiring across J/tasks. Most of the risk is in identity-across-rebuild and getting "now"/in-progress exactly right.

## Suggested PR breakdown
1. **Reflow core + anti-thrash** (no triggers yet): `engine/auto-defense.ts` (`reflow`, `computeProtected`, `freezeAsLocked`, `diffBlocks`), `last_moved_at` migration, extend `ScheduleResult` with the diff, `auto-defense.test.ts`. Exercised via `POST /api/schedule/run` only.
2. **Triggers + debounce:** `requestReplan` + `scheduleDebounced`, wire into J (`ingestEvents`), `routes/tasks.ts`, and the missed-block sweep; prefs toggle (`auto_defense_enabled` on `scheduling_prefs`) + gate; debounce/gate tests.
3. **Client toast + diff:** extend the `schedule:done` handler in `stores/index.ts`, optional "what changed" list, owner-brevity copy.

Splitting keeps PR 1 (the deterministic, heavily-tested core) reviewable in isolation before any production code path can fire it.
