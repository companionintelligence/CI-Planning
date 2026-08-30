import { and, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { store } from '../db/store.js';
import { possibleTasks, tasks } from '../db/schema.js';
import { writeAudit } from '../lib/audit.js';
import { broadcast } from '../routes/sse.js';
import { taskToApi } from '../lib/serialize.js';
import { logger } from '../lib/logger.js';
import { newId } from '../lib/ids.js';
import { localDateInTZ } from '../lib/tz.js';
import { autoScheduleOnIngest, placeStartAnchoredTask } from '../engine/autoplan.js';
import { ownerTimezone } from '../engine/recurrence-generate.js';
import { dedupePossibles } from '../agents/groom.js';
import { requiresReview } from './review-gate.js';
import { attachMachinePeople, resolveOrCreateByEmail, selfPersonId } from './people.js';

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
 * AF-3 `promoteAllPending` is the one in-module exception: for producer batches THIS
 * function is the transport (there is no route), so it fires the same
 * broadcast-then-place sequence itself, per item, preserving the identical
 * `possible:promoted`-before-placement seq ordering.
 *
 * The insert/update statements keep their drizzle form (identical SQL + camelCase row
 * shape for `taskToApi`), so the writers are async; the store facade executes them
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
// SQL at module scope, prepare at the use site (§5.5).
const SQL_POSSIBLE_TAGS = `SELECT pt.tag_id AS id, tg.kind AS kind FROM possible_task_tags pt
     JOIN tags tg ON tg.id = pt.tag_id
    WHERE pt.possible_task_id = ?`;
const SQL_INSERT_TASK_TAG =
  `INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, ?)`;
async function carryPossibleTags(possibleId: string, taskId: string): Promise<void> {
  const insertTaskTag = store().prepare(SQL_INSERT_TASK_TAG);
  for (const r of await store().prepare(SQL_POSSIBLE_TAGS).all<{ id: string; kind: string }>(possibleId)) {
    await insertTaskTag.run(taskId, r.id, r.kind === 'direction' ? 1 : 2);
  }
}

// 0151: the people twin of carryPossibleTags. Two sources feed it, and the split is the
// whole provisional-people policy:
//   - possible_task_people — addresses ingest RESOLVED against the existing directory;
//   - source_payload.people_hints — addresses it could not, deliberately left as raw
//     strings so no directory row was created for an item nobody accepted.
// Promotion is the moment the owner accepts, so it is where the hints become real
// people (confirmed = 0, reviewable in Settings → People).
const SQL_POSSIBLE_PEOPLE =
  `SELECT person_id, role, source FROM possible_task_people WHERE possible_task_id = ?`;
const SQL_POSSIBLE_PAYLOAD =
  `SELECT source_payload AS payload, source_kind AS kind FROM possible_tasks WHERE id = ?`;

async function carryPossiblePeople(owner: string, possibleId: string, taskId: string): Promise<void> {
  const rows = await store()
    .prepare(SQL_POSSIBLE_PEOPLE)
    .all<{ person_id: string; role: string; source: string | null }>(possibleId);

  const meta = await store()
    .prepare(SQL_POSSIBLE_PAYLOAD)
    .get<{ payload: unknown; kind: string | null }>(possibleId);
  const source = meta?.kind === 'gmail' ? 'email' : 'calendar';

  const responsible = rows.filter((r) => r.role === 'responsible').map((r) => r.person_id);

  // Resolve-or-create the addresses ingest left as hints.
  let payload: { people_hints?: unknown } = {};
  try {
    payload = typeof meta?.payload === 'string' ? JSON.parse(meta.payload) : ((meta?.payload ?? {}) as object);
  } catch {
    payload = {}; // a malformed payload must not block a promote
  }
  if (Array.isArray(payload.people_hints)) {
    for (const hint of payload.people_hints) {
      if (typeof hint !== 'string') continue;
      const personId = await resolveOrCreateByEmail(owner, hint, source);
      if (personId && !responsible.includes(personId)) responsible.push(personId);
    }
  }

  if (responsible.length === 0) return;

  // The owner goes FIRST — position 0, the lead. It is their planner: a task promoted
  // from an invite that listed only the other attendees would leave them off their own
  // work, so "what am I on the hook for" would not match it. Ingest deliberately skips
  // self when recording detections precisely because promotion re-adds them here, in
  // the one place that knows the item is becoming a real task.
  const self = await selfPersonId(owner);
  const ordered = self ? [self, ...responsible.filter((id) => id !== self)] : responsible;

  // attachMachinePeople, not setEntityPeople: this is machine testimony, and on the
  // re-promote path (a straggler sweep re-touching a row) it must not clobber a set the
  // owner has since curated by hand.
  await attachMachinePeople(owner, 'task', taskId, 'responsible', ordered, source);
}

// ── outcome evidence (close-loop wave, ticket 2) ──────────────────────────────
//
// One durable `possible_outcome_log` row per decided suggestion — what was proposed,
// what the owner did with it, and when. This is the corpus ticket 3's calibration
// batch rolls up and ticket 4/5 feed back into the extraction prompt as history
// (never a filter — see README.md "Decisions of record"). Raw SQL, matching the rest
// of the learning path (classification-learning.ts logAssignment); possibles.ts uses
// Drizzle for its own queries, but the log write does not need it. Append-only: a
// repeated dismiss of the same row writes a second row on purpose — ticket 3 collapses
// repeats at read time via ix_possible_outcome_log_possible.
const SQL_INSERT_OUTCOME_LOG = `
  INSERT INTO possible_outcome_log
    (id, owner_id, possible_task_id, source_kind, input_text, outcome, decided_at, local_date)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Append one row of evidence for a decided suggestion. Total try/catch — a logging
 * failure must never surface to the owner as a failed dismiss/promote (Non-goals): the
 * caller's return value is built before this runs and is never touched by a throw here.
 *
 * Owner scope comes from the row's `proposed_owner_id` (T4's owner key on
 * `possible_tasks`), not `owner_id` — that column doesn't exist on this table. Both
 * callers already have the row in hand (dismissPossible via `.returning()`, promotePossible
 * via the `getPossible` lookup it already did), so this never issues a second query.
 */
async function recordPossibleOutcome(row: PossibleTaskRow, outcome: 'dismissed' | 'promoted'): Promise<void> {
  try {
    const owner = row.proposedOwnerId;
    if (!owner) return; // nothing to attribute the evidence to
    const decidedAt = new Date().toISOString();
    const localDate = localDateInTZ(decidedAt, await ownerTimezone(owner));
    const inputText = row.rawSummary && row.rawSummary.trim() ? `${row.rawTitle} ${row.rawSummary}` : row.rawTitle;
    await store()
      .prepare(SQL_INSERT_OUTCOME_LOG)
      .run(newId(), owner, row.id, row.sourceKind ?? null, inputText, outcome, decidedAt, localDate);
  } catch (err) {
    logger.warn('possibles: could not record outcome', { possibleId: row.id, outcome, err: (err as Error).message });
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

/**
 * The people ingest DETECTED on each of these suggestions (0151), batched.
 *
 * Only rows it could RESOLVE against the existing directory appear — an unknown address
 * is a hint on source_payload until promotion, deliberately, so scanning never grows
 * the directory. So this shows "who we recognised", which is exactly the honest thing
 * to put in front of the owner before they approve.
 */
export async function detectedPeopleByPossible(
  possibleIds: string[],
): Promise<Map<string, { id: string; display_name: string; role: string }[]>> {
  const out = new Map<string, { id: string; display_name: string; role: string }[]>();
  if (possibleIds.length === 0) return out;
  const rows = await store()
    .prepare(
      `SELECT ptp.possible_task_id AS pid, ptp.role AS role, p.id AS id, p.display_name AS display_name
         FROM possible_task_people ptp
         JOIN people p ON p.id = ptp.person_id
        WHERE ptp.possible_task_id IN (${possibleIds.map(() => '?').join(',')})
        ORDER BY p.display_name COLLATE NOCASE`,
    )
    .all<{ pid: string; role: string; id: string; display_name: string }>(...possibleIds);
  for (const r of rows) {
    const list = out.get(r.pid);
    const entry = { id: r.id, display_name: r.display_name, role: r.role };
    if (list) list.push(entry);
    else out.set(r.pid, [entry]);
  }
  return out;
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

/**
 * Who drove a promote. Load-bearing for the close-loop wave and nothing else: only an
 * OWNER decision is evidence about what that owner considers noise.
 *
 * Since AF-3 most promotes are NOT owner decisions — `promoteAllPending` (every ingest
 * and memory-suggest batch) and `promotePossibles` (the nightly grooming sweeper)
 * auto-promote every non-review-gated possible by machine. Recording those as
 * `possible_outcome_log` rows would put one machine row per ingested item into the
 * denominator of ticket 6's noise rate (`dismissed / decided`), pinning it near zero
 * however noisy the queue actually is, and would grow an append-only table forever.
 *
 * Defaults to `'owner'` so the two human surfaces (routes/possibles.ts, the GraphQL
 * mutation) need no ceremony; the machine sweepers below pass `'auto'` explicitly.
 * A dismiss needs no such flag — nothing dismisses on the owner's behalf.
 */
export type PromoteActor = 'owner' | 'auto';

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
  opts: { actor?: PromoteActor } = {},
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
      // Carry the ingest-time estimate (0114) — the hands-off auto-schedule the caller
      // runs after promote (requireEstimate) places nothing without it.
      estimatedMinutes: possible.proposedEstimatedMinutes ?? undefined,
      // AB2 (0115): carry the suggestion's START intent so the caller's post-promote
      // placeStartAnchoredTask hook lands the block at the event's time on its day.
      scheduledFor: possible.proposedScheduledFor ?? undefined,
      taskTime: possible.proposedTaskTime ?? undefined,
      // proposedOwnerId equals `owner` here (getPossible scoped by it), but keep the
      // COALESCE-to-owner fallback the route had for defence in depth.
      ownerId: possible.proposedOwnerId ?? owner,
      sourceKind: possible.sourceKind ?? 'agent',
      sourceRef: possible.sourceRef ?? undefined,
    })
    .returning();

  await carryPossibleTags(id, task.id);
  await carryPossiblePeople(owner, id, task.id);

  await db
    .update(possibleTasks)
    .set({ status: 'promoted', promotedTaskId: task.id })
    .where(and(eq(possibleTasks.id, id), eq(possibleTasks.proposedOwnerId, owner)));

  writeAudit({ ownerId: owner, actor: 'owner', action: 'promote', entity: `possible:${id}` });
  // Evidence, unlike the audit row above, is only written for a real owner decision —
  // see PromoteActor. An auto-promote says nothing about what the owner considers noise.
  if (opts.actor !== 'auto') await recordPossibleOutcome(possible, 'promoted');

  return { ok: true, task, taskId: task.id };
}

export interface PromoteAllResult {
  /** Rows the inline semantic dedupe marked 'duplicate' (never promoted). */
  duplicates: number;
  /** Rows promoted into real tasks this pass. */
  promoted: number;
  /** Rows whose promote threw (poison isolation) — left 'pending' for the nightly
   *  sweeper / manual triage. AF-CU1: counted so a poison row is visible in the
   *  batch result (parity with the sweeper's PromoteResult), not just a log line. */
  failed: number;
  /** false = Ollama embeddings unreachable → dedupe skipped gracefully, everything promoted. */
  dedupeAvailable: boolean;
}

/**
 * AF-3 — auto-promote every pending possible for an owner EXCEPT review-gated sources
 * (the server half of "remove the inbox"). Producers (agents/ingest.ts,
 * agents/memory-suggest.ts) call this at the end of each batch, so a suggestion becomes
 * a real task at ingestion with no manual review step. `possible_tasks` remains as the
 * dedup/audit trail (rows flip to 'promoted'/'duplicate'; the REST/GraphQL
 * promote+dismiss surface is untouched).
 *
 * Email is the one exception (services/review-gate.ts): those rows stay `pending` for
 * the owner to approve, because an inbox is other people's agenda and a message that
 * merely mentions a commitment must not silently become one.
 *
 * Order per the module docstring's SSE contract: (1) inline semantic dedupe (the
 * nightly groom step moved up; owner-scoped; embeddings unavailable → skip gracefully
 * and promote everything), then per row (2) promotePossible (tag carry-over + audit
 * inside), (3) broadcast `possible:promoted`, (4) placement — start-anchored tasks are
 * placed at their stated time immediately (AB1, any trust mode); start-less ones get
 * ONE trust-gated `autoScheduleOnIngest` sweep after the loop. An item's
 * `possible:promoted` therefore always carries a lower seq than any placement
 * broadcast it triggers (the tested contract — same ordering the promote route keeps).
 * Placement stays best-effort: a hiccup never fails the batch.
 *
 * `opts.embedFn` is threaded to dedupePossibles for deterministic tests.
 */
export async function promoteAllPending(
  owner: string,
  opts: { embedFn?: (text: string) => Promise<number[]> } = {},
): Promise<PromoteAllResult> {
  // 'auto' scope on BOTH halves: review-gated sources (email) are never auto-promoted,
  // and must not be compared against the auto pool either — see dedupePossibles' docstring.
  const dd = await dedupePossibles({ owner, embedFn: opts.embedFn, scope: 'auto' });
  const pending = (await listPossibles(owner, 'pending')).filter((p) => !requiresReview(p.sourceKind));

  let promoted = 0;
  let failed = 0;
  let needsSweep = false;
  for (const p of pending) {
    let res: PromoteResult;
    try {
      // 'auto': AF-3 promotes on the owner's behalf, so this is not a decision and
      // must not enter the dismissal-learning corpus (see PromoteActor).
      res = await promotePossible(owner, p.id, {}, { actor: 'auto' });
    } catch (err) {
      // Poison isolation (same philosophy as ingest's dead-letter): one bad row —
      // e.g. a UNIQUE(source_kind, source_ref) collision with an existing task —
      // must not wedge the rest of the batch. It stays 'pending' for the nightly
      // sweeper / manual triage.
      failed++;
      logger.error('promoteAllPending: promote failed for possible — skipping', { owner, possibleId: p.id, err: (err as Error).message });
      continue;
    }
    if (!res.ok) continue; // vanished mid-batch — nothing to do
    promoted++;
    broadcast(owner, 'possible:promoted', { id: p.id, task: taskToApi(res.task) });
    if (res.task.scheduledFor) {
      // AB1: a stated START is honored in ANY trust mode (user/suggestion intent).
      try {
        await placeStartAnchoredTask(owner, res.taskId);
      } catch (err) {
        logger.warn('promoteAllPending: start-anchored placement failed', { owner, taskId: res.taskId, err: (err as Error).message });
      }
    } else {
      needsSweep = true;
    }
  }
  if (needsSweep) {
    // TM-5: one hands-off-only, estimate-bearing sweep for the whole batch (a no-op in
    // Cautious/Balanced) — after every possible:promoted broadcast above.
    try {
      await autoScheduleOnIngest(owner, { requireEstimate: true });
    } catch (err) {
      logger.warn('promoteAllPending: post-promote auto-schedule failed', { owner, err: (err as Error).message });
    }
  }

  if (promoted || failed || dd.duplicates) {
    logger.info('promoteAllPending done', { owner, promoted, failed, duplicates: dd.duplicates, dedupeAvailable: dd.available });
  }
  return { duplicates: dd.duplicates, promoted, failed, dedupeAvailable: dd.available };
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
  await recordPossibleOutcome(row, 'dismissed');
  return { ok: true, row };
}
