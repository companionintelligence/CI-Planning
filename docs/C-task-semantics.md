# C — Rich task semantics (implementation spec)

Companion to [ROADMAP.md](ROADMAP.md). Depends on **B0** (migration runner + `lib/context.ts` owner scoping); all new tables/columns ship as numbered migrations through that runner.

## Goal
1. **Scheduled-date ≠ deadline.** A task carries `scheduled_for` (the *date you intend to work it*) distinct from `due_at` (a *hard deadline*), plus `defer_until` (don't surface before this instant).
2. **Dependencies.** A `task_dependencies(task_id, depends_on_id)` edge set; a task is never scheduled before every blocker is `done`. Cycles are rejected at write time with a clear error.
3. **Scheduler honors all three** — extends the Phase-A today-set selection in `scheduler.ts` (deps gate, defer gate, due-as-hard-deadline) without changing the deterministic packer.
4. **NL quick-add.** `POST /api/tasks/quick` parses free text deterministically via **`chrono-node`**; Ollama enrichment is optional and always falls back to the deterministic parse.

## Non-goals
- **Recurrence** (`recurrence_rule`, habits) — that is **E**, which depends on this phase.
- **Time tracking / actuals** — **D**.
- **AI task *ordering***. C keeps the Phase-A priority/due ordering; the LLM-ordering pass is **G** (needs D/E signal). The only AI here is *quick-add field extraction*, and it is strictly additive over the deterministic parse.
- Soft-delete of dependency edges, multi-owner dependency graphs, transitive auto-completion. Edges are owner-local and hard-deleted.

## Current state (what exists today)
- **Schema** (`server/src/db/schema.ts`): `tasks` has `dueAt` (`due_at`, ISO datetime), `taskTime` (`task_time`, `HH:MM`), `estimatedMinutes`, `priority`, `status` (`open | scheduled | in_progress | done | cancelled | deferred`), `parentId`, `ownerId`. There is **no** `scheduled_for`, **no** `defer_until`, and **no** dependency table. `status='deferred'` is an enum value with no mechanism behind it.
- **Scheduler** (`server/src/engine/scheduler.ts`): the today-set query at lines ~89–93 selects `status='open'` tasks that are undated **or** `dueAt < horizonEndISO`, ordered by `priority, dueAt, id`. Pinned appointments use `taskTime`+`dueAt` on the local day. The packer (`buildGaps`/`pickGap`) is deterministic and stays untouched.
- **Routes** (`server/src/routes/tasks.ts`): `POST /api/tasks` accepts `title, description, notes, due_at, task_time, estimated_minutes, priority, owner_id, parent_id, tags`; hardcodes `ownerId: body.owner_id ?? 1` (a B0 grep-gate site). `attachTags()` normalizes tag names. There is **no** quick-add route.
- **Client** (`client/src/components/TaskForm.tsx`): signals for `title/notes/dueAt/taskTime/estimatedMinutes/priority/tagsInput`; no defer, no dependency, no quick-add. `client/src/lib/api.ts` defines `Task`/`TaskInput` (no `scheduled_for`/`defer_until`/`depends_on`) and `api.tasks.{list,create,update,delete,subtasks}` — no `quick`.
- **AI** (`server/src/mcp/ollama.ts`): `generateJson<T>()` + `OllamaUnavailable`; `status()`/`isAvailable()` never throw. The established degrade-gracefully pattern.
- **No `chrono-node` dependency** in `server/package.json`. No `server/src/db/migrations/` directory yet — it arrives with B0.
- **tz** (`server/src/lib/tz.ts`): `zonedWallTimeToUTC`, `utcDayBounds`, `serverTimezone`. All timestamps are UTC ISO text.

## Design

### 1. Schema migrations (via the B0 runner — never edit `setup.ts`)
Two new numbered TS migrations appended to `server/src/db/migrations/index.ts`'s `MIGRATIONS` array. Both idempotent (B0 contract). `scheduled_for` is a **date** (`YYYY-MM-DD`, local calendar day — like a Phase-A day key); `due_at`/`defer_until` are **UTC ISO datetimes**.

```ts
// server/src/db/migrations/0003_task_scheduling_columns.ts
import type { Database } from 'better-sqlite3';
export const id = '0003_task_scheduling_columns';
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  const has = (c: string) => cols.some((x) => x.name === c);
  if (!has('scheduled_for')) db.exec(`ALTER TABLE tasks ADD COLUMN scheduled_for TEXT`); // local YYYY-MM-DD
  if (!has('defer_until'))   db.exec(`ALTER TABLE tasks ADD COLUMN defer_until  TEXT`); // UTC ISO instant
  // due_at already exists and keeps its meaning, now narrowed to "hard deadline".
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tasks_owner_status_sched
           ON tasks(owner_id, status, scheduled_for)`); // today-set scan path
}
```

```ts
// server/src/db/migrations/0004_task_dependencies.ts
import type { Database } from 'better-sqlite3';
export const id = '0004_task_dependencies';
export function up(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_dependencies (
      task_id       INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      depends_on_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      created_at    TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (task_id, depends_on_id),
      CHECK (task_id <> depends_on_id)               -- no self-edge
    );
    CREATE INDEX IF NOT EXISTS idx_taskdeps_depends_on ON task_dependencies(depends_on_id);
  `);
}
```

Drizzle additions in `schema.ts` (types only — the runner owns DDL):

```ts
// tasks: add to the existing table definition
scheduledFor: text('scheduled_for'),   // local YYYY-MM-DD; intent, not a deadline
deferUntil:   text('defer_until'),     // UTC ISO; hidden from today-set until then

export const taskDependencies = sqliteTable('task_dependencies', {
  taskId:      integer('task_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  dependsOnId: integer('depends_on_id').references(() => tasks.id, { onDelete: 'cascade' }).notNull(),
  createdAt:   text('created_at').default(sql`CURRENT_TIMESTAMP`),
}, (t) => ({ pk: primaryKey({ columns: [t.taskId, t.dependsOnId] }) }));
```

### 2. Dependency writes + cycle rejection
A small graph helper kept server-side and deterministic. Inserting `A→B` is rejected if `B` already reaches `A` (would close a cycle). DFS over the existing edge set is enough at this scale; owner-scoped via `currentOwnerId()`.

```ts
// server/src/engine/deps.ts
import { sqlite } from '../db/index.js';
export class DependencyCycleError extends Error {
  constructor(taskId: number, dependsOnId: number) {
    super(`Adding dependency ${taskId}→${dependsOnId} would create a cycle`);
    this.name = 'DependencyCycleError';
  }
}
/** Does `from` already reach `to` through depends_on edges? (cycle probe) */
function reaches(from: number, to: number): boolean {
  const seen = new Set<number>(); const stack = [from];
  const q = sqlite.prepare('SELECT depends_on_id AS d FROM task_dependencies WHERE task_id = ?');
  while (stack.length) {
    const n = stack.pop()!;
    if (n === to) return true;
    if (seen.has(n)) continue; seen.add(n);
    for (const r of q.all(n) as { d: number }[]) stack.push(r.d);
  }
  return false;
}
export function addDependency(taskId: number, dependsOnId: number): void {
  if (taskId === dependsOnId) throw new DependencyCycleError(taskId, dependsOnId);
  if (reaches(dependsOnId, taskId)) throw new DependencyCycleError(taskId, dependsOnId);
  sqlite.prepare(
    'INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)'
  ).run(taskId, dependsOnId);
}
```

API surface (in `routes/tasks.ts`): `POST /api/tasks` and `PATCH /api/tasks/:id` accept `depends_on?: number[]` (full replace on PATCH); `scheduled_for` and `defer_until` join the field-copy blocks alongside `due_at`. A `DependencyCycleError` maps to **`409`** with `{ error: 'dependency cycle', detail }` — distinct from the existing `400 title is required`. `GET /api/tasks/:id` (and list rows) gain `depends_on: number[]` and a derived `blocked: boolean` (any blocker not `done`).

### 3. Scheduler: deps + defer + due-as-deadline
Extends the today-set selection in `scheduler.ts` only; `buildGaps`/`pickGap`/`splitIntoSessions` are unchanged. Three gates layered onto the existing candidate query:

- **Defer gate:** drop tasks whose `defer_until` is in the future relative to the day being scheduled (compare against the day's UTC upper bound, reusing `utcDayBounds`).
- **Dependency gate:** drop tasks with any incomplete blocker. Precompute the set of "blocked" task ids in one query so the per-task check is O(1).
- **Due-as-hard-deadline + scheduled_for intent:** a task is pulled into *today* if it is undated, **overdue/at deadline** (`due_at < horizonEndISO`), **or** explicitly `scheduled_for === date`. Ordering adds `scheduled_for` so an intended-today task sorts ahead of a far-future-deadline one.

```ts
// inside runScheduler, replacing the candidate query (~lines 89–93)
const blockedIds = new Set(
  (sqlite.prepare(`
    SELECT DISTINCT d.task_id AS id
    FROM task_dependencies d JOIN tasks b ON b.id = d.depends_on_id
    WHERE b.status <> 'done'
  `).all() as { id: number }[]).map((r) => r.id)
);
const dayHiISO = utcDayBounds(date, tz).end; // already computed above as dayHiISO/dayLoISO

const rows = await db.select().from(tasks).where(
  and(
    eq(tasks.status, 'open'),
    or(isNull(tasks.dueAt), lt(tasks.dueAt, horizonEndISO), eq(tasks.scheduledFor, date)),
  ),
).orderBy(asc(tasks.priority), asc(tasks.scheduledFor), asc(tasks.dueAt), asc(tasks.id));

const candidates = rows.filter((t) =>
  !blockedIds.has(t.id) &&                                   // dependency gate
  !(t.deferUntil && t.deferUntil >= dayHiISO)                // defer gate
);
```

A deferred-but-overdue task still surfaces once `defer_until` passes; a blocked task simply never enters the candidate set, so it is neither scheduled nor counted as `unscheduled` (it isn't ready). `eq(schedulingPrefs.ownerId, 1)` and the cleared-blocks query stay as B0 leaves them — owner via `currentOwnerId()`.

### 4. `POST /api/tasks/quick` — deterministic NL parse, optional enrichment
`chrono-node` does the date/time math (no hand-rolled parsing — same rationale as `rrule.js` in E). The deterministic core extracts **title, due/scheduled date+time, `#tag`s, and `~Nm` estimate**; enrichment is a *best-effort overlay* that never blocks task creation.

Add dependency: `pnpm --filter server add chrono-node`.

```ts
// server/src/engine/quickadd.ts
import * as chrono from 'chrono-node';
export interface ParsedQuick {
  title: string; dueAt?: string; scheduledFor?: string;
  taskTime?: string; tags: string[]; estimatedMinutes?: number;
}
export function parseQuick(input: string, refNow = new Date()): ParsedQuick {
  const tags = [...input.matchAll(/#([\w-]+)/g)].map((m) => m[1].toLowerCase());
  const est = input.match(/~\s*(\d+)\s*m(?:in)?\b/i);
  const results = chrono.parse(input, refNow, { forwardDate: true });
  const r = results[0];
  let dueAt: string | undefined, scheduledFor: string | undefined, taskTime: string | undefined;
  if (r) {
    const d = r.start.date();
    if (r.start.isCertain('hour')) { dueAt = d.toISOString(); taskTime = d.toISOString().slice(11, 16); }
    else scheduledFor = d.toISOString().slice(0, 10);     // date-only ⇒ intent, not a deadline
  }
  const title = input
    .replace(r?.text ?? '', '').replace(/#[\w-]+/g, '').replace(est?.[0] ?? '', '')
    .replace(/\s{2,}/g, ' ').trim() || input.trim();      // never empty
  return { title, dueAt, scheduledFor, taskTime, tags,
           estimatedMinutes: est ? Number(est[1]) : undefined };
}
```

Route — deterministic result is authoritative; Ollama only fills *gaps* it left:

```ts
// routes/tasks.ts — POST /api/tasks/quick
router.post('/api/tasks/quick', async (ctx) => {
  const text = (ctx.request.body as { text?: string })?.text?.trim();
  if (!text) { ctx.status = 400; ctx.body = { error: 'text is required' }; return; }
  const parsed = parseQuick(text);                          // deterministic, always succeeds
  let enriched = parsed, llm = false;
  try { enriched = await enrichQuick(text, parsed); llm = true; } // Ollama overlay
  catch { /* OllamaUnavailable or parse miss → keep deterministic result */ }
  const [task] = await db.insert(tasks).values({
    title: enriched.title, dueAt: enriched.dueAt, scheduledFor: enriched.scheduledFor,
    taskTime: enriched.taskTime, estimatedMinutes: enriched.estimatedMinutes,
    priority: 3, ownerId: currentOwnerId(),
  }).returning();
  if (enriched.tags.length) await attachTags(task.id, enriched.tags);
  const out = { ...toApi(task), tags: enriched.tags, llm };
  broadcast(currentOwnerId(), 'task:created', out);          // B0 owner-scoped signature
  ctx.status = 201; ctx.body = { task: out, parsed: enriched, llm };
});
```

`enrichQuick` calls `ollama.generateJson` (`tier:'small'`, short `timeoutMs`) to *only* supply a missing estimate, infer priority, or clean a noisy title — it must **never overwrite** a field `chrono-node` set with certainty, and any throw is swallowed (`llm:false`). This keeps the AI strictly on top of a deterministic floor.

### 5. Client: quick-add bar + TaskForm fields
- **`TaskInput`/`Task`** (`client/src/lib/api.ts`): add `scheduled_for?: string`, `defer_until?: string`, `depends_on?: number[]`, `blocked?: boolean`. Add `api.tasks.quick: (text: string) => request<{ task: Task; parsed: ParsedQuick; llm: boolean }>('POST', '/tasks/quick', { text })`.
- **Quick-add bar** — a one-line input above the task list; `Enter` calls `api.tasks.quick`, then `refetchTasks()`. Optimistic, with a small "AI-assisted" dot when `llm` is true.

```tsx
// client/src/components/QuickAdd.tsx
const [text, setText] = createSignal('');
async function add() {
  const v = text().trim(); if (!v) return;
  try { await api.tasks.quick(v); setText(''); refetchTasks(); showToast('Task added', 'success'); }
  catch (e) { showToast((e as Error).message, 'error'); }
}
return <input class="input-lg" placeholder="Add a task… e.g. 'pay invoice fri 3pm #finance ~20m'"
  value={text()} onInput={(e) => setText(e.currentTarget.value)}
  onKeyDown={(e) => e.key === 'Enter' && add()} />;
```

- **`TaskForm.tsx`** — inside the existing `expanded` block, add (a) a **Defer until** date input bound to a `deferUntil` signal, and (b) a **Depends on** multi-select of open tasks (excluding self) populating `dependsOn: number[]`. Both flow into the `TaskInput` body in `submit()` as `defer_until` / `depends_on`. A `409` cycle response surfaces via the existing `showToast((err).message, 'error')` path — `request()` already throws `err.error`.

## Tests
- **Phase-A scheduler suite stays green** — undated/overdue tasks with no deps/defer schedule exactly as before (no behavioral drift for the existing fixtures).
- **Dependency gate:** a task whose blocker is `open` is never placed; once the blocker flips to `done`, a re-run schedules it. Blocked task is **not** counted as `unscheduled`.
- **Defer gate:** a task with `defer_until` after the day's upper bound is absent; scheduling a day on/after that instant includes it.
- **Due as deadline vs scheduled_for:** a task with a far-future `due_at` but `scheduled_for === date` is pulled into today; a task with `scheduled_for` in the future but no near `due_at` is not.
- **Cycle rejection:** `addDependency` throws `DependencyCycleError` for a self-edge and for any edge closing an existing chain (A→B→C, then C→A); route returns **409**. `ON DELETE CASCADE` removes edges when a task is hard-deleted.
- **NL parse table (≥20 phrases)** for `parseQuick`: relative ("tomorrow 9am", "next fri"), date-only ⇒ `scheduled_for` not `due_at`, time ⇒ `due_at`+`task_time`, `#tag`, `~30m`, multi-tag, no-date ⇒ title only, junk ⇒ whole string as title. **Parser-down fallback:** with Ollama stubbed to throw, `/api/tasks/quick` still 201s using the deterministic parse (`llm:false`). DST-boundary phrase resolves to the correct UTC instant via `chrono` + a fixed `refNow`.
- **tz:** time-bearing quick-add stores a UTC ISO `due_at`; `task_time` is the local `HH:MM`.

## Acceptance criteria
1. `scheduled_for` (date) and `due_at` (hard deadline) are independently settable and queryable; the scheduler treats them distinctly.
2. A blocked task is never scheduled before every blocker is `done`; a deferred task is absent until `defer_until` passes.
3. Cyclic dependencies (including self-edges) are rejected with a clear **409** error; no cycle can be persisted.
4. `POST /api/tasks/quick` extracts title + date/time + `#tag` + `~Nm` estimate deterministically; **unparseable input still creates a task** (title = raw text), and Ollama being down never fails the request.
5. All new tables/columns arrived via numbered migrations through the B0 runner; `setup.ts` is untouched; owner reads/writes go through `currentOwnerId()`.
6. Phase-A scheduler tests remain green.

## Risks / notes
- **`chrono-node` is non-deterministic without a fixed reference.** Always pass an explicit `refNow`; tests pin it. It is the *only* date parser — no hand-rolled fallback that could disagree with it.
- **AI must stay strictly additive.** `enrichQuick` may fill blanks but must never override a `chrono`-certain field; every failure path keeps the deterministic result. A regression here would make quick-add non-reproducible.
- **Cycle check is O(V+E) per insert.** Fine at single-owner scale; if the graph grows, add the `owner+status+due` index already noted in the roadmap's scale budget and cache the reachability set per request.
- **`defer_until` vs `status='deferred'`.** We drive deferral off the timestamp, not the legacy enum value, to avoid two sources of truth. Leave the enum value in place but unused by C; G may reconcile it.
- **`scheduled_for` is a local date, not UTC** — compared as a `YYYY-MM-DD` string against the scheduler's `date` key, consistent with Phase A's day handling. Do not store an instant there.
- **Migration ordering** depends on B0 landing `0001`/`0002`; if B0 numbering shifts, renumber `0003`/`0004` to stay contiguous in the explicit `MIGRATIONS` array.

## Effort
**M** — roughly 3–4 days. The schema + scheduler gates are small and well-bounded; most of the effort is the quick-add parse table, the cycle-rejection edge cases, and the TaskForm dependency UI. No table rebuilds (all additive columns), so no `rebuildTable` dance.

## Suggested PR breakdown
1. **Schema + scheduler gates** (`0003`/`0004` migrations, `engine/deps.ts`, today-set deps/defer/`scheduled_for` extension, route fields, 409 on cycle). Ships with scheduler + dependency + cycle tests. No client.
2. **Quick-add** (`chrono-node` dep, `engine/quickadd.ts`, `POST /api/tasks/quick`, optional `enrichQuick`). Ships with the ≥20-phrase parse table + parser-down fallback test.
3. **Client** (`QuickAdd.tsx`, `TaskForm` defer + depends-on fields, `api.ts` types + `tasks.quick`). Ships with a SolidJS component test for the quick-add bar.

Splitting keeps the deterministic engine change reviewable on its own before any AI or UI lands on top.
