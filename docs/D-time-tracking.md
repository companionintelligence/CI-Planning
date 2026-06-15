# D — Time tracking & timers (implementation spec)

Companion to [ROADMAP.md](ROADMAP.md). Depends on **B0** (migration runner, `lib/context.ts` owner scoping, owner-scoped `broadcast`). Lands the "actual vs estimate" loop and an integrated start/stop timer with **exactly one running timer per owner**.

## Goal
1. **Measured actuals.** Persist real time spent per task in `time_entries`, aggregated into `tasks.actual_minutes`, so every task carries estimate **and** actual.
2. **Integrated timers.** One click on a TaskCard or BlockCard starts a timer; one click stops it. Live elapsed updates in-app; an estimate-vs-actual badge closes the loop.
3. **One active timer per owner**, enforced server-side: starting a second timer stops the first.
4. **Deterministic estimate suggestion** from each task's own history once ≥5 samples exist — AI-assist only on top, never required.

## Non-goals
- No multi-timer / parallel tracking, no Pomodoro cycles, no idle-detection or auto-pause (Phase H reminders can prompt later).
- No manual time-entry editor UI (add/correct entries by hand) — the API supports `source='manual'` rows, but the editor screen is deferred.
- No cross-task rollups/reports beyond per-task actuals (Phase G weekly review aggregates these).
- No LLM call in the hot path. The estimate suggestion is pure arithmetic; an LLM refinement is out of scope here.

## Current state (what exists today)
- **Schema** (`server/src/db/schema.ts`): `tasks` has `estimatedMinutes` (col `estimated_minutes`) but **no `actual_minutes`**. `timeBlocks` has `startAt`/`endAt`/`status` (`planned | completed | skipped | overrun`) but no link to elapsed work. There is **no `time_entries` table and no timer state.**
- **Routes** (`server/src/routes/tasks.ts`): REST CRUD; `POST/PATCH` call `broadcast('task:created'|'task:updated', …)`. Owner still hardcoded — `ownerId: body.owner_id ?? 1` (one of the 7 literals B0 replaces with `currentOwnerId()`). `server/src/routes/blocks.ts`: block CRUD, `broadcast('block:*', …)`; no timer surface.
- **SSE** (`server/src/routes/sse.ts`): **today** `broadcast(event, data)` writes to a global `Set<PassThrough>` — every client gets every event. **B0 changes the signature to `broadcast(ownerId, event, data)`** and tags each connection; this spec assumes that signature.
- **Client** (`client/src/components/TaskCard.tsx`): renders `estimated_minutes` as a static `{n}m` badge (`est()`); no timer control. `client/src/components/BlockCard.tsx`: computes `durationMins()` from start/end, has Done/Skip; no timer. `client/src/lib/api.ts`: `api.tasks.*` / `api.blocks.*`; `Task` has `estimated_minutes` but no `actual_minutes`; no timer calls; SSE is consumed elsewhere via the events stream.
- **TZ** (`server/src/lib/tz.ts`): `zonedWallTimeToUTC` / `utcDayBounds` are two-pass DST-correct. **Durations are computed from two UTC ISO instants, so they are already DST-correct by construction** — we reuse `tz.ts` only for the suggestion's day-bucketing, not for elapsed math.

## Design

### 1. Schema — migrations `0010`, `0011` (through the B0 runner)
Add to `db/schema.ts` and ship as **new numbered migrations** (next free index after B0's baseline set; **never edit `setup.ts`**). All timestamps are UTC ISO text.

```ts
// db/schema.ts (additions)
export const tasks = sqliteTable('tasks', {
  /* …existing… */
  actualMinutes: integer('actual_minutes').default(0),   // aggregate of finished entries
});

export const timeEntries = sqliteTable('time_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  taskId: integer('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  ownerId: integer('owner_id').references(() => owners.id).notNull(),
  blockId: integer('block_id').references(() => timeBlocks.id, { onDelete: 'set null' }), // if started from a block
  startedAt: text('started_at').notNull(),               // UTC ISO
  endedAt: text('ended_at'),                              // UTC ISO; NULL = running
  source: text('source').default('timer'),               // timer | manual | block
  createdAt: text('created_at').default(sql`CURRENT_TIMESTAMP`),
});
```

```ts
// db/migrations/0010_actual_minutes.ts
export const id = '0010_actual_minutes';
export function up(db) {
  if (!hasColumn(db, 'tasks', 'actual_minutes'))         // idempotent (B0 addCol pattern)
    db.exec(`ALTER TABLE tasks ADD COLUMN actual_minutes INTEGER NOT NULL DEFAULT 0;`);
}
```

```ts
// db/migrations/0011_time_entries.ts
export const id = '0011_time_entries';
export function up(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS time_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id    INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    owner_id   INTEGER NOT NULL REFERENCES owners(id),
    block_id   INTEGER REFERENCES time_blocks(id) ON DELETE SET NULL,
    started_at TEXT NOT NULL,
    ended_at   TEXT,
    source     TEXT DEFAULT 'timer',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );`);
  // Running-timer state is just the (at most one) row WHERE ended_at IS NULL per owner.
  // A partial unique index makes "one active timer per owner" a DB invariant, not just app logic:
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ux_time_entries_one_running
           ON time_entries(owner_id) WHERE ended_at IS NULL;`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_time_entries_task ON time_entries(task_id);`);
}
```

Register both in `db/migrations/index.ts` (`MIGRATIONS = [ …, m0010, m0011 ]`). **Running-timer state needs no extra table** — it is the single `ended_at IS NULL` row, guarded by the partial unique index.

### 2. Duration: DST-correct by construction
Elapsed minutes = difference of two UTC instants — no wall-clock arithmetic, so a timer spanning a DST boundary is automatically correct (a 23-hour civil day still measures 60 real minutes per hour). We never subtract local times.

```ts
// server/src/lib/duration.ts
export const elapsedMinutes = (startISO: string, endISO: string): number =>
  Math.max(0, Math.round((Date.parse(endISO) - Date.parse(startISO)) / 60_000));
```

`tz.ts` is reused only in §6 to bucket finished entries into local calendar days for the suggestion.

### 3. Service — one timer per owner, aggregate actuals
```ts
// server/src/services/timer.ts
import { currentOwnerId } from '../lib/context.js';   // from B0
import { elapsedMinutes } from '../lib/duration.js';

export function startTimer(taskId: number, blockId?: number) {
  const owner = currentOwnerId();
  return sqlite.transaction(() => {
    const stopped = stopRunning(owner);                // close any existing running entry first
    const now = new Date().toISOString();
    const { lastInsertRowid } = sqlite
      .prepare(`INSERT INTO time_entries (task_id, owner_id, block_id, started_at, source)
                VALUES (?,?,?,?, ?)`)
      .run(taskId, owner, blockId ?? null, now, blockId ? 'block' : 'timer');
    return { entry: getEntry(Number(lastInsertRowid)), stopped };
  })();
}

export function stopTimer() {
  return stopRunning(currentOwnerId());                // returns the closed entry + updated task, or null
}

function stopRunning(owner: number) {
  const running = sqlite.prepare(
    `SELECT * FROM time_entries WHERE owner_id=? AND ended_at IS NULL`).get(owner);
  if (!running) return null;
  const endedAt = new Date().toISOString();
  sqlite.prepare(`UPDATE time_entries SET ended_at=? WHERE id=?`).run(endedAt, running.id);
  // Aggregate from source of truth (sum of finished entries), not by += (keeps actual_minutes exact):
  const { total } = sqlite.prepare(
    `SELECT COALESCE(SUM(
        (julianday(ended_at)-julianday(started_at))*24*60), 0) AS total
       FROM time_entries WHERE task_id=? AND ended_at IS NOT NULL`).get(running.task_id);
  const actual = Math.round(total);
  sqlite.prepare(`UPDATE tasks SET actual_minutes=? WHERE id=?`).run(actual, running.task_id);
  return { entry: { ...running, ended_at: endedAt }, taskId: running.task_id, actualMinutes: actual };
}
```
- Wrapping start in a transaction that stops-then-inserts means the partial unique index can never trip; **the second start atomically supersedes the first.**
- `actual_minutes` is **recomputed as the SUM of all finished entries**, so it stays exact across many entries, restarts, and entry deletion (cascade).

### 4. API — `POST /api/tasks/:id/timer/start|stop`
```ts
// routes/tasks.ts (additions; owner via currentOwnerId from B0)
router.post('/api/tasks/:id/timer/start', async (ctx) => {
  const taskId = Number(ctx.params.id);
  const blockId = (ctx.request.body as { block_id?: number })?.block_id;
  const { entry, stopped } = startTimer(taskId, blockId);
  const owner = currentOwnerId();
  if (stopped) broadcast(owner, 'timer:stopped', toApi(stopped.entry));   // the superseded one
  broadcast(owner, 'timer:started', toApi(entry));
  ctx.status = 201;
  ctx.body = { entry: toApi(entry) };
});

router.post('/api/tasks/:id/timer/stop', async (ctx) => {
  const res = stopTimer();
  if (!res) { ctx.status = 409; ctx.body = { error: 'no running timer' }; return; }
  const owner = currentOwnerId();
  broadcast(owner, 'timer:stopped', toApi(res.entry));
  broadcast(owner, 'task:updated', { id: res.taskId, actual_minutes: res.actualMinutes });
  ctx.body = { entry: toApi(res.entry), actual_minutes: res.actualMinutes };
});

// GET /api/timer — the current running entry (for reload/restart recovery), or null
router.get('/api/timer', async (ctx) => {
  ctx.body = { entry: getRunning(currentOwnerId()) ?? null };
});
```
- Stop with no running timer → **409** (deterministic, idempotent-safe for a double-click). `:id` is ignored on stop (there's only one).
- `GET /api/timer` lets the client recover the running timer after a reload or server restart — actuals and the live timer survive both.

### 5. SSE events (owner-scoped, from B0)
- `timer:started` — payload: the new `time_entries` row (`task_id`, `started_at`, `block_id`). Clients render a running state and start a local ticker from `started_at`.
- `timer:stopped` — payload: the closed entry (`ended_at` set). Emitted both on explicit stop **and** for the superseded entry when a second timer starts.
- `task:updated` already exists; stop re-broadcasts it carrying the new `actual_minutes` so the estimate-vs-actual badge refreshes without a refetch.

All three go through B0's `broadcast(ownerId, …)` — a second owner's stream never sees this owner's timer.

### 6. Estimate suggestion — deterministic, ≥5 samples
```ts
// server/src/services/estimate.ts
export function suggestEstimate(taskId: number): number | null {
  const owner = currentOwnerId();
  // Per-task history would be sparse; bucket by tag (the task's primary tag) for signal.
  const samples = sqlite.prepare(
    `SELECT t.actual_minutes AS m FROM tasks t
       JOIN task_tags tt ON tt.task_id = t.id
      WHERE t.owner_id=? AND t.actual_minutes > 0
        AND tt.tag_id IN (SELECT tag_id FROM task_tags WHERE task_id=?)
      ORDER BY t.completed_at DESC LIMIT 30`).all(owner, taskId).map(r => r.m);
  if (samples.length < 5) return null;                 // degrade: no suggestion, UI hides badge
  samples.sort((a, b) => a - b);
  return Math.round(samples[Math.floor(samples.length / 2)]);  // median — robust to outliers
}
```
- **Median of the task's tag-cohort actuals**, gated at ≥5 samples; deterministic and reproducible. Below threshold it returns `null` and the UI simply doesn't suggest.
- Surfaced via `GET /api/tasks/:id` (or the suggestion field on the task DTO) — never auto-written; the user accepts it into `estimated_minutes`. AI refinement, if ever added, sits on top of this floor.

### 7. Client — TaskCard + BlockCard start/stop, live elapsed, badge
```tsx
// api.ts additions
export interface Task { /* … */ actual_minutes?: number; }
api.tasks.timerStart = (id: number, blockId?: number) =>
  request('POST', `/tasks/${id}/timer/start`, blockId ? { block_id: blockId } : {});
api.tasks.timerStop  = (id: number) => request('POST', `/tasks/${id}/timer/stop`, {});
api.timer = { current: () => request<{ entry: TimeEntry | null }>('GET', '/timer') };
```
```tsx
// a small store: runningEntry signal, hydrated by GET /api/timer on load,
// updated by timer:started / timer:stopped SSE events.
const isRunning = () => runningEntry()?.task_id === props.task.id;
const liveElapsed = () => isRunning()
  ? Math.floor((now() - Date.parse(runningEntry()!.started_at)) / 60_000)   // now() ticks every 1s
  : null;
```
- **TaskCard** (`TaskCard.tsx`): replace the static `est()` with a Play/Stop button + live `m:ss` when running, and an **estimate-vs-actual badge**: `{actual}m / {est}m` colored green when `actual ≤ est`, amber when over. When stopped and `suggestEstimate` returns a value with no estimate set, show a one-tap "≈{n}m?" chip.
- **BlockCard** (`BlockCard.tsx`): when the block has a `task_id`, the Done/Skip row gains a Start/Stop that calls `timerStart(task_id, block.id)`; live elapsed shown next to `durationMins()`.
- A single global ticker (`setInterval(setNow, 1000)`) drives all live displays; only the running card recomputes. No per-card intervals.

## Tests
- **`timer.service.test.ts`**
  - Start → one running entry; **starting a 2nd timer stops the 1st** (the first gets `ended_at`, second is running, partial unique index never violated).
  - Stop computes correct duration; **stop across a DST boundary** (fixture `TZ=America/Los_Angeles`, start 01:30 → end 02:30 spanning spring-forward) measures **60 real minutes**, reusing the UTC-instant math (`lib/tz.ts` for the day bucket).
  - `actual_minutes` **aggregates across multiple entries** (3 sessions → sum), and is recomputed (not `+=`) so deleting an entry corrects it.
  - Stop with no running timer → 409.
- **`estimate.test.ts`:** <5 samples → `null`; ≥5 → median; outlier doesn't skew (median, not mean).
- **SSE isolation (extends B0):** owner A's `timer:started`/`timer:stopped` not received by owner B's stream.
- **Recovery:** running timer + server restart → `GET /api/timer` still returns it; actuals from finished entries unchanged after reload.
- **Client (`@solidjs/testing-library`):** Start button → POST; running card shows live elapsed; badge turns amber when actual > est; suggestion chip appears only at ≥5 samples.
- **Standing suites:** full Vitest + container Playwright green; single-owner context keeps it auth-free.

## Acceptance criteria
1. **Exactly one running timer per owner** — enforced by the partial unique index *and* the stop-then-start transaction; starting a second stops the first, observably via `timer:stopped`.
2. **Actuals survive reload and server restart**, and **aggregate correctly across multiple entries** (recomputed as SUM of finished entries).
3. Durations are **DST-correct** (timer spanning a transition measures real elapsed time).
4. `timer:started` / `timer:stopped` are **owner-scoped** (B0 broadcast); no cross-owner leakage.
5. Start/stop works from **both** TaskCard and BlockCard with live elapsed and an estimate-vs-actual badge.
6. **Deterministic estimate suggestion** appears only at **≥5 samples**, returns `null` below threshold, and is never auto-applied.

## Risks / notes
- **Clock skew / paused process.** Elapsed is wall-clock from `started_at`; a suspended laptop counts the gap. Acceptable for v1 (matches a stopwatch); idle-trim is a Non-goal. Document it.
- **Orphan running entry.** A crash mid-timer leaves `ended_at IS NULL`. `GET /api/timer` surfaces it on reconnect so the user can stop it; the partial unique index still permits exactly one, so no corruption. Optionally auto-close entries older than a configurable cap (e.g. 12h) on boot.
- **Partial-unique-index portability.** `WHERE ended_at IS NULL` partial indexes are supported on better-sqlite3's SQLite; keep the stop-then-start transaction as the primary guard so app logic doesn't *depend* on the index, only benefits from it.
- **Aggregate via `julianday`** is exact to the second here; rounding to whole minutes happens once, at write — never compound rounding across entries.
- **Estimate suggestion is per-tag, not per-task** (per-task history is too sparse). Tasks without tags get no suggestion — acceptable; degrade gracefully rather than guess.
- **Block linkage is soft** (`ON DELETE SET NULL`): deleting a block keeps the time entry and the task's actuals intact.

## Effort
**S–M** — ~2–3 days. The schema, service, two routes, and SSE wiring are small and deterministic; most of the time is the client timer UX (live ticker, badge, suggestion chip) and the DST/aggregate/restart test matrix. No auth, no LLM in the path.

## Suggested PR breakdown
1. **Schema + service + API** (no UI): migrations `0010`/`0011`, `timer.ts`, `duration.ts`, `start`/`stop`/`GET /timer` routes, owner-scoped SSE events, `timer.service.test.ts`. Ships measurable actuals headless.
2. **Client timers + badge:** `api.ts` calls + running-entry store + global ticker, TaskCard/BlockCard start/stop and estimate-vs-actual badge, SSE handling, component tests.
3. **Estimate suggestion:** `estimate.ts`, suggestion field on the task DTO, the one-tap chip, `estimate.test.ts`.

Splitting this way lands the data loop first (1), makes it visible (2), then adds the calibration polish (3) — each diff small and independently testable.
