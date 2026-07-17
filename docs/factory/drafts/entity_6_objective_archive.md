> **Type:** feature · **Phase:** ENTITY · **Branch:** `feat/objective-archive-purge` · **Commit style:** `feat(objectives): archive instead of delete, with a 48h purge window` · **Design:** owner request 2026-07-15 · **Dependencies:** none

## Goal

1. **Objectives go to an archive instead of being destroyed.** Previously `DELETE /api/objectives/:id` hard-deleted the row (see `server/src/routes/objectives.ts` / `server/src/services/objectives.ts`).
2. **The archive gets a "Delete permanently" action, reversible for 48 hours.** The row stays fully intact for the window; one click restores it; a job reaps it after the deadline.

### Owner decisions (2026-07-15) — locked

| Decision | Ruling |
|---|---|
| What starts the 48h clock | **Two clocks.** Archiving keeps the objective **indefinitely** (like tasks). Only an explicit **"Delete permanently"** stamps `purge_after = now + 48h`. |
| Scope | **Objectives only.** The task archive is untouched; tasks are a deliberate follow-up. |
| Archiving a node with children | **Cascade** the subtree, stamped with `archive_root_id`, restored together. |

## ⚠️ The finding that dictates the design — read this first

**`status = 'archived'` is silently broken.** `server/src/sync/apply.ts:85-87`:
```ts
if (field === 'status' && row['status'] === 'done' && value !== 'done') return 'done';
```
`applyMonotonic` keys on **field name only** — no entity scoping (`:84`) — and runs for **every** entity (`:137`). So archiving a **completed** objective through sync is silently clamped back to `'done'`. Archiving a finished objective is the common case. Online PATCH bypasses `applyMonotonic` entirely (raw UPDATE), so **REST and sync would disagree** — works in dev, corrupts on reconnect. The inverse is test-pinned at `server/test/sync-apply.test.ts:58`.

Independently: `status` is single-valued, so `'archived'` would erase whether the objective was `done` or `dropped`, making restore lossy.

**⇒ The archive is a separate `archived_at` column, orthogonal to `status`.**

## Non-goals

- **Tasks are out of scope** (owner ruling). No change to `AllTasks.tsx`'s archive, `ARCHIVED` (`:36`), or `deleteTask`.
- **Do not** make `dropSourceObjective` / `unpromoteIfEmpty` soft (`services/task-promotion.ts:116,:128`). `isPristine` (`:95-100`) guarantees they only remove auto-generated, top-level, childless rows the user never organized — archiving them would fill the archive with machine noise. **Add a comment at both sites** tying them to `isPristine`.
- **Do not** generify `ArchiveSection` (`AllTasks.tsx:424`) — it is hard-typed `items: Task[]` with a hardcoded `<TaskCard>` and serves 5 call sites, 3 of them non-archive. Separate refactor.
- **Do not** add an `applyMonotonic` pin for `archived_at` — a pin would make archiving irreversible through sync and defeat the requested reversal.
- **Do not** make the 48h window configurable. One named constant.
- No new `status` values. No `CHECK` constraints (this repo enforces enums in code).

## Pinned conventions

Verified against `origin/main` / this worktree. **`objectives` is raw-SQL only — it is absent from `server/src/db/schema.ts`** (grep: 0 hits; 38 drizzle tables, none of them objectives). So there is **no `schema.ts` mirror to add**, and **the compiler will not catch a missed read path** — the read-path audit must be done by grep.

### Migration
- Head is **`0128_sleep_hours`**. **`0009` and `0119` are permanent holes** (`migrations/index.ts:119-121` documents 0119 as intentionally burned). **Next free id is `0129`. Never renumber into the holes.**
- `export const id = '...'` **must equal the filename stem** (invariant across all 126 files).
- **Copy the local `hasColumn` helper verbatim from `0128_sleep_hours.ts:12-14`** — there is no shared helper; copy-paste is the convention. Do **not** copy `0086_objective_source_task.ts:17`'s bare unguarded ALTER: `server/test/schema-indexes.test.ts` calls `up()` a **second time** (`:44`, `:88`) to enforce idempotency, and a bare ALTER throws duplicate-column.
- SQLite has no `ADD COLUMN IF NOT EXISTS`; guard with `PRAGMA table_info` (precedent: `0087_objective_sync_versioning.ts:28-38`).
- **No FK on `archive_root_id`** — SQLite cannot ALTER-ADD a foreign key (`0086:14-15`); adding one forces a full table rebuild. Scope by owner in the service, same tradeoff `source_task_id` made.
- All columns **nullable, no DEFAULT** — SQLite forbids a non-constant DEFAULT on ADD COLUMN (`0110_entity_tags_created_at.ts:14-15`), so `NOT NULL DEFAULT CURRENT_TIMESTAMP` would force a rebuild.
- Index prefix `ix_` (dominant, 52 uses).
- **Registration is TWO edits per migration, and forgetting either fails SILENTLY**: an `import * as m0129 from './0129_objective_archive.js';` (**`.js` extension despite the `.ts` file** — NodeNext ESM) after m0128 (`index.ts:130`), **and** an append to the `MIGRATIONS` array (`:143`).
- Do **not** set `manual` — additive DDL needs no FK pragma toggle.

### Timestamps
Write `new Date().toISOString()` **from code** (existing idiom: `objectives.ts:283`, `:408`). **Never `CURRENT_TIMESTAMP`** — it yields `2026-07-16 03:29:59` (space, no `T`/`Z`, second precision) vs the codebase's `2026-07-16T03:29:59.954Z`. Mixing breaks the string comparison the purge job depends on.

### Sync — a new column silently no-ops unless threaded through BOTH of these
1. `OBJECTIVE_FIELDS` (`apply.ts:42-45`) — else `continue` at `:135` **silently drops** the field from every op.
2. `OBJECTIVE_CAMEL_TO_SNAKE` (`apply.ts:184-191`) — else `stampRow`'s `.filter(Boolean)` (`:224`) skips it and **returns early at `:225`, stamping nothing**.

Add **`archived_at` + `archive_root_id`** to both. Keep **`purge_after` OUT** — it is a server-owned deadline, the same category as `level`/`progress_cache`, which `apply.ts:40-41` excludes as *"server-DERIVED … a client can't author them, so they never sync"*.

**Stamp on every flag flip.** Mirror `unlinkTaskFromObjective` (`objectives.ts:96-99`) which flips **then** stamps — **not** `deleteTask` (`tasks.ts:515-528`), which flips status via Drizzle and **never calls `stampRow`**. That omission is a live latent bug: `field_ts['status']` keeps its old stamp, so a queued offline op carrying `status='open'` can **resurrect a cancelled task** (`apply.ts:136`). Do not inherit it.

### Cron
- **The cron registry IS the `scheduled_jobs` table**, not a code call: `startCronJobs()` (`jobs/index.ts:431-442`) SELECTs enabled rows at boot. **Adding a job = a migration seeding the row** (precedent `0116_reset_routines_job.ts:13-16`, `INSERT OR IGNORE` with an explicit `newId()`) **+ a `case` in `execute()` (`:69`)**.
- `scheduled_jobs.id` must be supplied explicitly (TEXT UUIDv7 — `import { newId } from '../../lib/ids.js'`); `name` is UNIQUE (`schema.ts:497-506`).
- **GLOBAL, not owner-scoped** — do **not** add to `OWNER_SCOPED_KINDS` (`:376-391`). `purge_after` is an absolute deadline with no tz dependency. `prune_sync_events` (`:275-286`) is the exact precedent, and its comment records that owner-scoping this kind of retention **was a bug**: *"the old owner-scoped predicate would have left every non-first owner's rows to grow unbounded"*.
- Report deletions in **`itemsUpdated`**, not `itemsCreated` (`:285` precedent).
- **Never throw on a zero-row no-op** — `runJob` catches and marks the run `status='error'` (`:346-350`), surfacing a red row in the admin UI.
- **No `writeAudit`/`broadcast` in the body** — `runJob` does both centrally (`:336`, `:345`, `:362`).
- Registers **only on server RESTART** (`boot.ts:32`).
- Cron slots taken: `00:00` reset_routines, `00:20` freeze_stars, `02:00` push_memory, `03:00` prune_sync_events. **Use `'0 * * * *'` (hourly)** so a countdown UI stays honest (48–49h); nightly would make "48 hours" wrong by up to a day.

### Read paths — archiving is a REMOVAL that must be built
Four sites have **no status/archive predicate** today and will leak archived rows:
- `buildTree` — `objectives.ts:167` `SELECT * FROM objectives WHERE owner_id = ? ORDER BY created_at`
- `listObjectives` — `:358`
- `heightBelow` — `:41-53` (an archived child would keep propping its parent at `project`/`goal`)
- `recomputeProgress` — `:300-302` (an archived child would keep dragging the parent's completion)

## Before implementation

1. `server/src/sync/apply.ts:40-45, 84-96, 103-142, 184-191, 215-239` — the allowlist, the done-pin, applyOp's LWW compare, stampRow.
2. `server/src/services/objectives.ts:41-57` (heightBelow/levelFromHeight), `:167` (buildTree), `:300-322` (recomputeProgress), `:491-500` (deleteObjective).
3. `server/src/services/task-promotion.ts:95-131` — isPristine and the two GC hard-deletes.
4. `server/src/jobs/index.ts:69, 275-286, 329-362, 376-391, 431-442` — execute dispatch, the prune precedent, runJob, owner-scoping, boot.
5. `server/src/db/migrations/0128_sleep_hours.ts` (hasColumn), `0116_reset_routines_job.ts` (job seed), `0087_objective_sync_versioning.ts` (the PRAGMA-guarded ALTER precedent + the tombstone rationale).
6. `server/test/objectives.test.ts:273-286` — **the test that pins the hard-delete and must be rewritten.**

## Files impacted

**New:**
- `server/src/db/migrations/0129_objective_archive.ts`
- `server/src/db/migrations/0130_purge_objectives_job.ts`

**Changed:**
- `server/src/db/migrations/index.ts` — 2 imports + 2 array appends (4 edits).
- `server/src/services/objectives.ts` — `archiveObjective` / `restoreObjective` / `requestPurge` / `cancelPurge`; read-path filters.
- `server/src/routes/objectives.ts` — repoint DELETE; add restore / purge / cancel-purge; `GET ?archived=1`.
- `server/src/graphql/objective-resolvers.ts` — `:89` shares `deleteObjective`; align or the two surfaces disagree about what "delete" means.
- `server/src/sync/apply.ts` — `OBJECTIVE_FIELDS` + `OBJECTIVE_CAMEL_TO_SNAKE`.
- `server/src/jobs/index.ts` — `case 'purge_objectives'`.
- `server/src/services/task-promotion.ts` — comments only, tying `:116`/`:128` to `isPristine`.
- `client/src/lib/api.ts` — widen `api.objectives.list` to take params (`:459`; mirror `api.tasks.list`'s shape at `:91`); add archive/restore/purge methods.
- `client/src/components/ObjectivesPanel.tsx` — its **own** archive toggle + flat archived list + restore / delete-permanently / countdown.
- `server/test/objectives.test.ts` — rewrite `:273-286`.
- `server/test/__snapshots__/baseline.characterization.test.ts.snap` — **pins objectives' column list at `:948-952`**; `0129` adds columns, so the snapshot must be updated.

## Schema required

**Migration `0129_objective_archive`** — three nullable TEXT columns on `objectives` + one index. All PRAGMA-guarded, additive, forward-only, no `manual`.

| Column | Type | Null | Meaning |
|---|---|---|---|
| `archived_at` | TEXT (ISO-8601) | yes | non-null ⇒ in the archive, hidden from the live tree |
| `archive_root_id` | TEXT | yes | the objective whose archiving cascaded to this row; NULL on the root itself. **No FK** (SQLite can't ALTER-ADD one) |
| `purge_after` | TEXT (ISO-8601) | yes | non-null ⇒ permanent-delete requested; restorable until the job passes the deadline |

`CREATE INDEX IF NOT EXISTS ix_objectives_purge_after ON objectives(purge_after);` — the purge job's scan predicate. No index for `archived_at` (buildTree already scans by `owner_id`).

**Migration `0130_purge_objectives_job`** — seed the cron row:
```ts
db.prepare(`INSERT OR IGNORE INTO scheduled_jobs (id, name, kind, cron) VALUES (?, ?, ?, ?)`)
  .run(newId(), 'purge_objectives', 'purge_objectives', '0 * * * *');
```

## Definition of Done

- [ ] `archiveObjective(owner, id)` replaces `deleteObjective`'s body: resolve the subtree with the existing `WITH RECURSIVE down(...)` idiom (`objectives.ts:43-52`); stamp `archived_at = now` on the root and on every descendant whose `archived_at IS NULL`; set `archive_root_id = <root>` on those descendants; `stampRow(sqlite, 'objective', <id>, ['archivedAt', 'archiveRootId'])` for each; `restampLevels(parent_id)` **and `recomputeProgress(parent_id)`** (the latter is a pre-existing omission at `:497`); `writeAudit` action `'archive'`.
- [ ] Already-archived descendants are **skipped**, so restoring the root does not resurrect them.
- [ ] `restoreObjective(owner, id)`: clear `archived_at`, `archive_root_id`, `purge_after` on the root and on every row with `archive_root_id = id`; stamp; restamp levels + recompute progress.
- [ ] `requestPurge(owner, id)`: require `archived_at IS NOT NULL`; set `purge_after = now + PURGE_WINDOW_HOURS` (one named constant, **48**) across `id = ? OR archive_root_id = ?` so the subtree purges atomically.
- [ ] `cancelPurge(owner, id)`: `purge_after = NULL` across the same set. **This is the reversal — the row never left the table.**
- [ ] Read paths filter `AND archived_at IS NULL`: `buildTree` (`:167`), `listObjectives` (`:358`), `heightBelow` (`:41-53`), `recomputeProgress` (`:300-302`).
- [ ] `GET /api/objectives?archived=1` returns a **flat** list (an archived subtree is not a renderable tree).
- [ ] `POST /api/objectives/:id/restore`, `POST /api/objectives/:id/purge`, `DELETE /api/objectives/:id/purge`. DELETE `/api/objectives/:id` now archives; keeps its 404-on-unknown contract.
- [ ] GraphQL's delete path aligned with REST.
- [ ] `apply.ts`: `archived_at` + `archive_root_id` in **both** `OBJECTIVE_FIELDS` and `OBJECTIVE_CAMEL_TO_SNAKE`. **No `applyMonotonic` change.** `purge_after` absent from both.
- [ ] `case 'purge_objectives'` in `execute()`: one `DELETE FROM objectives WHERE purge_after IS NOT NULL AND purge_after < ?` bound with `new Date().toISOString()`; returns `{ itemsCreated: 0, itemsUpdated: changes }`; never throws on zero rows; GLOBAL (absent from `OWNER_SCOPED_KINDS`).
- [ ] **Purge guard:** refuse to purge a node with a **live (non-archived) child** — `parent_id` is `ON DELETE SET NULL` (`0081:22`), so purging an archived parent with live children would silently re-root them 48h later with no user action and no event.
- [ ] ObjectivesPanel gets its own archive toggle + flat list + Restore / Delete permanently / "deletes in ~Nh — Undo". It must **not** reuse `showArchive()` (gated to `isTaskTab()` at `AllTasks.tsx:225`/`:67` and force-cleared at `:72`) or `ArchiveSection`.
- [ ] Comments added at `task-promotion.ts:116` and `:128` tying the hard-deletes to `isPristine`.
- [ ] No new console errors.

## Tests

```bash
pnpm --filter server exec tsc --noEmit
pnpm --filter client exec tsc --noEmit
pnpm --filter client build
pnpm --filter server test
pnpm --filter client test
```

- [ ] **Rewrite `server/test/objectives.test.ts:273-286`** (currently `expect(objCount).toBe(0); expect(linkCount).toBe(0);`) into three: archive leaves the row with `archived_at` set and **absent from `GET /api/objectives`**; requestPurge + job past the deadline ⇒ `objCount === 0`; cancelPurge inside the window ⇒ row intact.
- [ ] **The regression the column design exists to prevent**: archive an objective whose `status = 'done'` **through sync** and assert it archives (mirror the `linked` 1→0 tombstone round-trip at `sync-apply.test.ts:311-323`). With `status='archived'` this would clamp back to `'done'`.
- [ ] Cascade: archiving a Goal archives its Projects with `archive_root_id` set; restore puts the tree back; an independently-archived descendant is not resurrected.
- [ ] Purge job is **GLOBAL**: runCount 1 with 2 owners (per `server/test/jobs-multiowner.test.ts:33-37`). `resetDb()` keeps `scheduled_jobs` (`helpers.ts:26-27`), so the seeded row is present for free.
- [ ] Purge refuses a node with a live child (the SET NULL scatter guard).
- [ ] Migration idempotency: `up()` twice is clean (`schema-indexes.test.ts:44,:88` calls it directly).
- [ ] Owner-scoped: another owner's objective ⇒ 404 on archive/restore/purge.
- [ ] Browser: archive an objective → gone from the tree, present in the archive; restore → back in place; delete permanently → countdown + Undo.

## Acceptance Criteria

- [ ] Objectives archive instead of being destroyed; the archive keeps them indefinitely.
- [ ] "Delete permanently" is reversible for a full 48h; the row never leaves the table during the window.
- [ ] A **done** objective can be archived through sync (the done-pin trap is avoided).
- [ ] Archiving a Goal cascades and restores as a unit; nothing is silently re-rooted at archive **or** purge time.
- [ ] Both suites, both typechecks, client build clean.

## Subtasks

1. `0129_objective_archive.ts` (+ 2 registration edits) — columns + index; update the baseline snapshot.
2. `0130_purge_objectives_job.ts` (+ 2 registration edits) — seed the hourly job.
3. `apply.ts` — both allowlist maps. No monotonic change.
4. `services/objectives.ts` — archive/restore/requestPurge/cancelPurge + the four read-path filters.
5. `routes/objectives.ts` + GraphQL — repoint DELETE, add restore/purge/cancel, `?archived=1`.
6. `jobs/index.ts` — `case 'purge_objectives'`, global, guarded against live children.
7. `task-promotion.ts` — isPristine comments.
8. Client — `api.ts` params + methods; ObjectivesPanel archive surface.
9. Rewrite `objectives.test.ts:273-286`; add sync/cascade/job/idempotency tests.
10. Run both suites; browser-verify.

## Follow-ups (out of scope — file separately)

- **Tasks archive + hard delete** (owner deferred).
- **LIVE BUG — `TaskCard.tsx:258-268`**: `toggleDone`'s else branch sends `{ completed: true }` for a **cancelled** task, so clicking the checkbox on a "Thrown away" card marks it **done** instead of restoring it. There is no un-cancel path anywhere.
- **LIVE BUG — `deleteTask` never calls `stampRow`** (`tasks.ts:515-528`), so a queued offline op carrying `status='open'` can resurrect a cancelled task (`apply.ts:136`).
- `deleteObjective` never called `recomputeProgress` (`:497`) — fixed incidentally here; the same omission may exist elsewhere.
