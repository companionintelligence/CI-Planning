import { and, eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { possibleTasks, tasks } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';

/**
 * Possible-task inbox CRUD (Phase W · W9) — extracted from routes/possibles.ts so
 * REST + GraphQL share ONE owner-scoped implementation (Decision 3). Possible tasks
 * are produced by ingest (agents/ingest.ts), never by the API, so the surface is
 * read + promote + dismiss only — no create/update.
 *
 * OWNER-SCOPING: `possible_tasks` has no `owner_id`; its established owner key is
 * `proposed_owner_id` — the *proposed*, not-yet-confirmed owner of an inbox item (T4,
 * an intentional design; documented on the schema). ingest ALWAYS sets it to
 * currentOwnerId() on insert, routes/backup.ts scopes by it, and migration 0092 adds
 * ix_possible_tasks_proposed_owner. So every read/write here filters by
 * `proposed_owner_id = owner`. This CLOSES a latent cross-tenant read-leak/IDOR in the
 * pre-extraction route (which filtered GET by status only and looked promote/dismiss up
 * by id alone) — byte-equivalent for the real owner (ingest set their id), only changing
 * behavior in multi-tenant, in the safe direction (cf. W3.1a, tasks.ts owner-scoping).
 *
 * `writeAudit` fires INSIDE promote/dismiss so REST + GraphQL behave identically. SSE
 * `broadcast` stays transport-side (route + resolver each fire it), matching the
 * block-template/flight-plan precedent. The best-effort TM-5 auto-schedule call
 * (`autoScheduleOnIngest`) also stays transport-side, called by each caller AFTER its
 * own broadcast — the pre-extraction route always broadcast `possible:promoted` BEFORE
 * running it, and `autoScheduleOnIngest` can itself synchronously broadcast
 * `auto:placed`/`flight_plan:updated`; since `broadcast()` assigns a monotonic
 * `sync_events.seq`, firing it from inside this service (after `writeAudit`, before
 * returning) would flip that relative ordering for any SSE/sync_events-replay consumer.
 * Keeping it in the caller preserves the original ordering exactly.
 *
 * The insert/update statements keep their drizzle form (identical SQL + camelCase row
 * shape for `taskToApi`), so the writers are async; better-sqlite3 executes them
 * synchronously underneath.
 */

/** A full drizzle `possible_tasks` row (camelCase) — the shape `toApi`/`toApiList` serialize. */
export type PossibleTaskRow = typeof possibleTasks.$inferSelect;

/**
 * Linchpin (auto-scheduling finding 2): copy a possible-task's suggested tags onto the
 * promoted task's entity_tags, or the direction tag the Auto engine matches on vanishes
 * exactly when an item becomes schedulable. Level by kind — the direction (pattern) tag
 * lands at level 1 (the placement-relevant read, taskTagNames), content (intention) tags
 * at level 2 (secondary). Idempotent inserts onto a fresh task. Moved in from
 * routes/possibles.ts so REST + GraphQL carry tags identically.
 */
const selectPossibleTags = sqlite.prepare(
  `SELECT pt.tag_id AS id, tg.kind AS kind FROM possible_task_tags pt
     JOIN tags tg ON tg.id = pt.tag_id
    WHERE pt.possible_task_id = ?`,
);
const insertTaskTag = sqlite.prepare(
  `INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, ?)`,
);
function carryPossibleTags(possibleId: string, taskId: string): void {
  for (const r of selectPossibleTags.all(possibleId) as { id: string; kind: string }[]) {
    insertTaskTag.run(taskId, r.id, r.kind === 'direction' ? 1 : 2);
  }
}

// ── reads (owner-scoped by proposed_owner_id) ─────────────────────────────────

/** The owner's possible tasks in a given status (default 'pending'). */
export async function listPossibles(owner: string, status = 'pending'): Promise<PossibleTaskRow[]> {
  return db
    .select()
    .from(possibleTasks)
    .where(and(eq(possibleTasks.proposedOwnerId, owner), eq(possibleTasks.status, status)));
}

/** One of the owner's possible tasks by id, or undefined (a cross-owner id is invisible). */
export async function getPossible(owner: string, id: string): Promise<PossibleTaskRow | undefined> {
  const [row] = await db
    .select()
    .from(possibleTasks)
    .where(and(eq(possibleTasks.id, id), eq(possibleTasks.proposedOwnerId, owner)));
  return row;
}

// ── mutations (owner-scoped) ──────────────────────────────────────────────────

/** Client-supplied overrides for a promote (both the REST snake_case + GraphQL forms map here). */
export type PromoteOverrides = { title?: string; due_at?: string; priority?: number };

export type PromoteResult =
  | { ok: true; task: typeof tasks.$inferSelect; taskId: string }
  | { ok: false; error: 'not_found' };

/**
 * Promote a possible task to a real task: owner-scoped lookup (a cross-owner/unknown id
 * → not_found), create the task with the same columns/fallbacks the route always used
 * (override||raw title, rawSummary description, override||proposed due/priority, the
 * proposed owner [== the scope owner], agent source_kind fallback), carry the suggested
 * tags, flip the possible → promoted with its promoted_task_id, and audit. Returns the
 * inserted drizzle row (camelCase) for `taskToApi`. The caller is responsible for
 * broadcasting `possible:promoted` and then running the best-effort TM-5 auto-schedule
 * (see the module docstring for why that stays transport-side and ordered after).
 */
export async function promotePossible(
  owner: string,
  id: string,
  overrides: PromoteOverrides = {},
): Promise<PromoteResult> {
  const possible = await getPossible(owner, id);
  if (!possible) return { ok: false, error: 'not_found' };

  const [task] = await db
    .insert(tasks)
    .values({
      title: overrides.title ?? possible.rawTitle,
      description: possible.rawSummary ?? undefined,
      dueAt: overrides.due_at ?? possible.proposedDueAt ?? undefined,
      priority: overrides.priority ?? possible.proposedPriority ?? 3,
      // proposedOwnerId equals `owner` here (getPossible scoped by it), but keep the
      // COALESCE-to-owner fallback the route had for defence in depth.
      ownerId: possible.proposedOwnerId ?? owner,
      sourceKind: possible.sourceKind ?? 'agent',
      sourceRef: possible.sourceRef ?? undefined,
    })
    .returning();

  carryPossibleTags(id, task.id);

  await db
    .update(possibleTasks)
    .set({ status: 'promoted', promotedTaskId: task.id })
    .where(and(eq(possibleTasks.id, id), eq(possibleTasks.proposedOwnerId, owner)));

  writeAudit({ ownerId: owner, actor: 'owner', action: 'promote', entity: `possible:${id}` });

  return { ok: true, task, taskId: task.id };
}

export type DismissResult = { ok: true; row: PossibleTaskRow } | { ok: false; error: 'not_found' };

/**
 * Dismiss a possible task (status → 'dismissed'). Owner-scoped: an unknown/cross-owner
 * id matches no row → not_found (the route 404'd). Audits inside.
 */
export async function dismissPossible(owner: string, id: string): Promise<DismissResult> {
  const [row] = await db
    .update(possibleTasks)
    .set({ status: 'dismissed' })
    .where(and(eq(possibleTasks.id, id), eq(possibleTasks.proposedOwnerId, owner)))
    .returning();
  if (!row) return { ok: false, error: 'not_found' };
  writeAudit({ ownerId: owner, actor: 'owner', action: 'dismiss', entity: `possible:${id}` });
  return { ok: true, row };
}
