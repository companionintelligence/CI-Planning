# CON-1 — UUIDv7 identity (design)

> **Status:** ✅ **shipped** — CON-1 landed (PRs #74/#76, migration `0030_uuidv7_identity`, 2026-06-21). *Archived; kept for the design rationale.* First PR of the consolidation
> pass ([consolidation-plan.md](consolidation-plan.md)). The riskiest single
> change in the plan; it gets its own PR and is proven by the behavior baseline
> ([server/test/baseline.characterization.test.ts](../server/test/baseline.characterization.test.ts)).

## Goal

Move every entity primary key from `INTEGER AUTOINCREMENT` to **time-ordered
UUIDv7** (`TEXT`), and every foreign key to `TEXT`. One id regime, **client-
mintable**, globally unique.

**Why now / why v7:**
- **Unblocks recall=clone** (#71 Phase 6): minting a new id is `uuidv7()`, no
  sequence coordination.
- **Multi-device (Phase L)** drops the negative-temp-id + id-rewrite machinery —
  ids are unique from birth.
- **Export/import/restore (Phase R)** becomes *merge-safe*, not restore-into-wiped.
- **Unifies with auth** (Phase I already specs UUIDv7 + `lib/ids.ts`).
- **v7, not v4:** time-ordered, so b-tree/index locality matches today's
  autoincrement — no random-insert write amplification.

## Scope

**All 18 tables.** PKs become `TEXT`; all FK columns become `TEXT`. The FK graph
(~25 edges) that must be remapped in lockstep:

- **`tasks`** ← self (`parent_id`, `recurrence_parent_id`), `owner_id`
- **`time_blocks`** ← `task_id`, **self (`parent_block_id`)**, `owner_id`
- **`task_dependencies`** (composite PK) ← `task_id`, `depends_on_id`
- **`pattern_tasks`** (composite PK) ← `pattern_id`, `task_id`
- **`flight_plan`** (composite PK `(owner_id, task_id)`) ← `owner_id`, `task_id`, `source_pattern_id`
- **`patterns`** ← `owner_id`, `type_id`
- **`pattern_types`**, **`block_templates`**, **`scheduling_prefs`**, **`time_entries`** (← `task_id`, `owner_id`, `block_id`), **`possible_tasks`** (← `proposed_owner_id`, `promoted_task_id`), **`task_tags`** / **`possible_task_tags`** (← *_id, `tag_id`), **`tags`**, **`owners`**, **`scheduled_jobs`**, **`job_runs`** (← `job_id`), **`daily_summaries`**.

**Out of scope:** wire/label changes (CON-2), tag store (CON-3). The API shape is
unchanged *except* ids serialize as strings instead of numbers — which the
baseline already proves is invisible (ids are normalized to referent tokens).

## The id helper — `server/src/lib/ids.ts`
```ts
import { uuidv7 } from 'uuidv7'; // or a vetted inline impl; the dep Phase I also needs
export function newId(): string { return uuidv7(); }
```
Drizzle: `integer('id').primaryKey({ autoIncrement: true })` → `text('id').primaryKey().$defaultFn(newId)`; every FK `integer(...)` → `text(...)` (the `.references()` stays). Client [api.ts](../client/src/lib/api.ts): `id: number` → `id: string` across `Task`, `Block`, `Pattern`, `FlightPlanItem`, `BlockTemplate`, etc. (ids are already treated as opaque — no arithmetic on them; verify no `id` math or numeric coercion remains).

## Migration `0030_uuidv7_identity` — the SQLite table rebuild

SQLite cannot `ALTER` a PK's type in place, so each table is **rebuilt**. Because
we also need FK columns to point at the *new* ids, we do an explicit
create→copy→swap with an in-memory id remap. Algorithm:

1. **`PRAGMA defer_foreign_keys = ON;`** — `PRAGMA foreign_keys` *cannot* change
   inside a transaction, but `defer_foreign_keys` can; it defers all FK checks to
   COMMIT, so intermediate states with mixed int/text refs are allowed. The whole
   migration runs in the runner's single transaction.
2. **Idempotency guard:** if `PRAGMA table_info(tasks)` already reports `id` as
   `TEXT`, no-op (the migration already ran). Forward-only; not expand/contract
   (an id can't be two types at once — this is a one-shot rebuild).
3. **Build id-maps.** For every table, `SELECT id` and assign `newId()` →
   `Map<oldInt, newUuid>`. Self-referential and cross-table FKs all resolve
   through these maps (e.g. `time_blocks.parent_block_id` via the time_blocks map;
   `recurrence_parent_id` via the tasks map).
4. **Per table, in any order (FK checks are deferred):**
   - `CREATE TABLE <t>__new (…)` with `TEXT` id + `TEXT` FK columns, **same column
     order/names/NOT-NULL/DEFAULT/UNIQUE** as today (the schema-shape baseline
     guards this).
   - Copy rows, translating `id` and every FK column through the maps.
   - `DROP TABLE <t>; ALTER TABLE <t>__new RENAME TO <t>;`
   - **Recreate every index/trigger** the old table had — a rebuild drops them.
     This includes `ux_task_occurrence` (0008), `ix_time_blocks_parent` (0023),
     `ix_time_blocks_pattern_source` (0025), `ux_{tasks,time_blocks}_ingest_source`
     (0027), and the owner/status indexes. Enumerate from `sqlite_master` before
     drop and re-issue after rename, or keep an explicit list in the migration.
5. **Composite-key tables** (`task_dependencies`, `pattern_tasks`, `flight_plan`,
   `*_tags`) have no surrogate `id`; only their FK columns are remapped + retyped.
6. Commit → deferred FK checks run. If any fail, the migration aborts atomically.

## Testing (the gate)

1. **Behavior baseline stays green, unchanged** — the proof of a pure refactor.
   [baseline.characterization.test.ts](../server/test/baseline.characterization.test.ts)
   normalizes ids to referent tokens, so int→uuid is invisible; any drift in the
   API/engine output trips the snapshot. (The schema-shape snapshot proves no
   table/column was lost in the rebuild.)
2. **`PRAGMA foreign_key_check`** returns empty post-migrate (no dangling refs).
3. **Row-count parity** per table pre/post (no rows dropped by the copy).
4. **Id format** assertion: every `id` matches the UUID shape and parses as v7
   (version nibble = 7), and is unique.
5. **Round-trip:** export → wipe-owner → import reproduces the baseline snapshots
   (proves ids are portable and self-consistent).
6. Full server suite (**250 + 3 baseline = 253**) + client suite green; both
   packages typecheck. Migration applies on a fixture 0.x DB (`migrate.test.ts`).

## Risks & mitigations

| Risk | Mitigation |
|------|------------|
| **Dropped index/trigger** on rebuild → silent perf/dedupe loss | Enumerate from `sqlite_master` and recreate; assert index list pre/post |
| **FK enforcement mid-rebuild** | `PRAGMA defer_foreign_keys=ON` (works inside the txn); checks run at COMMIT |
| **Wrong FK remap** (self-ref / cross-table) → orphans or cycles | `foreign_key_check` + row-count parity + the baseline relationships (`depends_on`/`parent_id` tokens) catch it |
| **Client numeric-id assumptions** | grep for id arithmetic/`Number(id)`/`> 0`; ids are opaque strings after this |
| **One-way migration** (no down) | Forward-only per project rule; safety is a DB backup before apply (Phase R) + run-on-a-copy in review |
| **Bigger keys** (16B vs 8B) | v7 is time-ordered → index locality preserved; negligible at this scale |

## Sequencing

Lands as **the first consolidation PR**, server + client in lockstep (id type
`string`). Everything downstream (CON-2 subtype, CON-3 `entity_tags.entity_id`,
CON-5 drag payloads, and #71 recall) is built against `TEXT` ids from the start,
so no code is written twice.
