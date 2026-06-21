# CON-3 — `entity_tags` normalized tag store (handoff brief)

> **Self-contained brief for a fresh session.** Build CON-3: the canonical
> polymorphic tag store that gates **#77 Phase 5** (tag levels + dilution).
> **Behavior-preserving + additive.** Canon: [GLOSSARY.md](GLOSSARY.md),
> [consolidation-plan.md](consolidation-plan.md) (CON-3 section),
> [cockpit-v2-plan.md](cockpit-v2-plan.md) (Phase 5 consumes this).

## Where things stand
- `main` = #76 (`7edf0ce`): CON-1 (UUIDv7) + CON-5 (drag) + CON-2 (a/b/c) all merged.
- **#77** (`claude/cockpit-v2-replan`): cockpit-v2 **Phases 1–4 + 6 done + pushed**
  (`d76d1a1` day-nav · `b56f4fa` pills/⚡/4·8·16 · `26d1092` two-col/drawer/someday ·
  `ffaf82e` task-views/recall, on plan `56af249`). **Phase 5 is the only piece left
  and is BLOCKED on this (CON-3).**
- **Branch: `claude/con-3-entity-tags`** (off `main`, ready, no code yet). Build here; PR to `main`.
- Server tests need **Node 26.3.0**: `export PATH="$HOME/.nvm/versions/node/v26.3.0/bin:$PATH"; unset PORT`.
- **Migration number = `0033`.** Taken: `0030` CON-1, `0031` CON-2a, `0032` CON-2c,
  `0035` Phase-6 recall_keeps_pattern. `0033`/`0034` are free → CON-3 = `0033`
  (CON-4 reserves `0034`). Insert `m0033` before `m0035` in `db/migrations/index.ts`.

## Locked design (from consolidation-plan): polymorphic `entity_tags`, NO dilution yet
- One store for **Task · Time Block · Routine**: `entity_tags(entity_kind, entity_id,
  tag_id, level DEFAULT 1)`, PK `(entity_kind, entity_id, tag_id)`, FK `tag_id → tags(id)
  ON DELETE CASCADE`, **NO FK on `entity_id`** (spans tables) — integrity is **app-enforced**.
- Keep `time_blocks.tag` (+ `patterns.tag`) as denormalized top-level **mirrors**; existing
  reads stay on them. `entity_tags` is populated in parallel and consumed by Phase 5.
- `level` defaults 1 (top-level). **No weighting/dilution in CON-3** — that's #77 Phase 5.

## Scope (one cohesive PR)
1. **`schema.ts`**: add `entityTags` sqliteTable after `taskTags` (~line 230). Columns
   above; `primaryKey({ columns: [entityKind, entityId, tagId] })`. `tagId` references
   `tags.id` cascade; `entityId` plain text (no FK).
2. **Migration `0033_entity_tags.ts`** (additive + idempotent): `CREATE TABLE IF NOT
   EXISTS entity_tags(...)` + index on `(tag_id)`. Backfill:
   - tasks: `INSERT OR IGNORE INTO entity_tags SELECT 'task', task_id, tag_id, 1 FROM task_tags`.
   - time blocks: for each `time_blocks` row with non-empty `tag`, split on `,`, normalize
     (trim, strip leading `#`, lowercase), resolve-or-create the tag (`uuid7()`), `INSERT
     OR IGNORE ('time_block', block_id, tag_id, 1)`.
   - routines: same split for `patterns.tag` → `('routine', pattern_id, …)`.
   - fold concept-tag names: for each `scheduling_prefs.concept_tags` (JSON `[{name,minutes}]`),
     ensure each `name` exists in `tags` (create if missing). No `entity_tags` row — these
     are tag *definitions*, not associations.
   Register in `db/migrations/index.ts`.
3. **Tag-repo layer — NEW `server/src/services/tags.ts`** (better-sqlite3, sync):
   - `resolveTagId(name)` → find by normalized name or create (`uuid7()`).
   - `syncEntityTags(kind, entityId, tagNames[], level=1)` → DELETE that entity's rows,
     then INSERT OR IGNORE each. (Replace semantics.)
   - `removeEntityTags(kind, entityId)` → DELETE rows for that entity (the cascade primitive).
   - (optional) `entityTagNames(kind, entityId)` → `string[]`.
4. **Write-sync** (keep `entity_tags` current; DON'T change existing reads):
   - `routes/tasks.ts` `attachTags(taskId, names)` → after writing `task_tags`, call
     `syncEntityTags('task', taskId, names)`. (PATCH tags path re-runs attachTags, so it re-syncs.)
   - `routes/blocks.ts` create + update: when `tag` is set, `syncEntityTags('time_block',
     blockId, split(tag))`; keep writing `time_blocks.tag` (mirror).
   - `routes/patterns.ts` create/update tag → `syncEntityTags('routine', patternId, …)` (completeness).
5. **Cascade — INTEGRITY-CRITICAL** (every HARD delete must `removeEntityTags`, or rows orphan):
   - `routes/blocks.ts` `DELETE /api/blocks/:id` (~line 192) → `removeEntityTags('time_block', id)`;
     with `?children=delete`, also for each removed member block.
   - `routes/patterns.ts` pattern DELETE → `removeEntityTags('routine', id)`; its fast-tasks are
     hard-deleted there → `removeEntityTags('task', fastTaskId)` for each.
   - `routes/patterns.ts` fast-task DELETE (~line 390, `DELETE FROM tasks WHERE is_fast_task=1…`)
     → `removeEntityTags('task', taskId)`.
   - **Regular tasks are SOFT-deleted** (`status='cancelled'` in `routes/tasks.ts` DELETE) — no
     row removal, so no orphan. Only HARD deletes need the cascade.

## Gate (behavior-preserving)
- **Per-entity reads UNCHANGED** (`/api/tasks` task_tags join · `/api/blocks` time_blocks.tag
  string · `/api/patterns`) — those baseline snaps stay **byte-identical**; `entity_tags` is not read yet.
- **INTENTIONAL baseline diffs** (review, then `-u`): (a) the **schema-shape** snapshot gains the
  `entity_tags` table; (b) **`/api/tags`** gains backfilled names not previously in `tags` — the
  baseline fixture's routine is tagged `morning`, so `morning` becomes a real tag. **Confirm these
  are the ONLY snaps that move; do NOT `-u` blindly.**
- **New tests** (`server/test`): backfill yields the expected `entity_tags` rows (task + block +
  routine); after deleting a block / pattern / fast-task, **zero orphan** `entity_tags` rows; a
  task's/block's read tags are identical pre/post. Run without `-u` first to inspect.
- `pnpm -C server exec tsc --noEmit` clean + suite green; client unaffected.

## Deliverable
- Commit on `claude/con-3-entity-tags`; open a PR to `main` (behavior-preserving → its own PR).
  End commits with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- **After CON-3 merges to `main`:** rebase **#77** (`claude/cockpit-v2-replan`) onto `main`, then
  build **Phase 5** on #77 using `entity_tags` + the tag-repo: a `level` control in the Block
  Wizard / `BlockEditModal`, and `weight = top-level ? 1 : 1/#tags` applied in
  `server/src/engine/autoplan.ts` (orderForPlan) + task search/recall ranking; re-verify
  `auto-placement.test.ts`.

## Risk (consolidation-plan)
CON-3 trades DB-enforced referential integrity for **app-enforced** — the tag-repo MUST own every
entity-delete path or tags orphan (the orphan-free tests are the gate). It's the plan's **single
riskiest change → dedicated PR, heavy tests, no other work in it.**
