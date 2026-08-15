import { store } from '../db/store.js';
import { splitTagString, entityCategoryNames } from './tags.js';
import { PLACED_TIMEBLOCK_SQL } from '../engine/mobility.js';

/**
 * Auto-nest (Focus × Time Blocks, Phase 5) — a task block created inside a matching
 * Time Block's span becomes a MEMBER of it.
 *
 * "Created inside" has to mean every creation path — the Focus add box, Planner
 * click-to-create, the Element wizard, quick-add, agents — so the rule lives here and
 * is called from `createBlock`, not from any one UI.
 *
 * The owner's rule (plan decision 4): a task nests when BOTH coordinates match — the
 * direction (WORK / HOME / COMMUNITY) *and* the life-balance category (Career,
 * Health, Leisure, …). "Priority" in the owner's phrasing means the life-balance
 * category, NOT P1–P3.
 *
 * SCHEMA NOTE — the plan describes the category match as `block.category_id`'s name ∈
 * `task.categories`. That column is retired from the write path (migration 0135):
 * categories now live in `entity_categories`, 1–3 per entity, position-ordered, and a
 * block's EFFECTIVE set is its own rows else (task-backed) its task's. The rule here
 * is the same intent expressed against the live schema — the container's effective
 * categories intersect the subject's — which also generalizes cleanly now that a
 * container can carry up to three.
 */

/** The two coordinates a block is matched on. Names are compared case-insensitively. */
export interface NestCoords {
  /** Direction tag names (a container's `tag` can be a comma-joined union). */
  directions: string[];
  /** Life-balance category names (effective: own rows, else the linked task's). */
  categories: string[];
}

/** A Time Block that could receive the new task block. */
export interface NestCandidate extends NestCoords {
  id: string;
  startMs: number;
  endMs: number;
}

/** The task block being created. */
export interface NestSubject extends NestCoords {
  startMs: number;
  endMs: number;
}

const lower = (xs: string[]) => new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean));
const intersects = (a: Set<string>, b: Set<string>) => {
  for (const x of a) if (b.has(x)) return true;
  return false;
};

/**
 * Do a subject and a container agree on BOTH coordinates (plan decision 4)?
 *
 *  - the container's directions intersect the subject's. A container with no
 *    direction tag carries no coordinate to match on and never claims a task;
 *  - its categories intersect the subject's — unless the container has none, which
 *    the owner's rule lets match on direction alone.
 *
 * Says nothing about time. Split out because the autoscheduler asks the same
 * question with the spans reversed: it knows the container and is choosing where to
 * put the task, so it cannot use the containment test `chooseContainer` applies.
 */
export function coordsMatch(subject: NestCoords, candidate: NestCoords): boolean {
  const dirs = lower(candidate.directions);
  if (dirs.size === 0 || !intersects(dirs, lower(subject.directions))) return false;
  const cats = lower(candidate.categories);
  return cats.size === 0 || intersects(cats, lower(subject.categories));
}

const span = (c: NestCandidate) => c.endMs - c.startMs;

/**
 * The containers that may claim `subject`, most specific FIRST — or none at all.
 *
 * Ambiguity (nested or overlapping Time Blocks both qualifying) resolves to the
 * TIGHTEST span: the most specific claim wins. A genuine tie for tightest returns
 * NOTHING rather than guessing — a wrong parent is worse than none, because
 * containment changes how reflow and the L01 window rules treat the task (L02
 * overrides L01), and there is no basis to prefer one over the other.
 *
 * Callers filter by time first: `chooseContainer` passes only containers that
 * CONTAIN the subject; the autoscheduler passes the day's containers and then
 * places into the first one with room.
 *
 * Pure — no DB, no clock.
 */
export function preferredContainers(subject: NestCoords, candidates: NestCandidate[]): NestCandidate[] {
  const matches = candidates
    .filter((c) => coordsMatch(subject, c))
    // Ties broken by id so a run is deterministic — the tie RULE below still refuses
    // to choose, but ordering must not depend on row order for the non-tied ranks.
    .sort((a, b) => span(a) - span(b) || a.id.localeCompare(b.id));
  if (matches.length > 1 && span(matches[1]) === span(matches[0])) return [];
  return matches;
}

/**
 * Pick the Time Block a new task block should nest into, or null to leave it loose.
 *
 * A candidate qualifies when it CONTAINS the subject's span (a partial overlap is not
 * containment — the task would hang outside the box it claims to be in) and both
 * coordinates match. `preferredContainers` resolves the rest.
 */
export function chooseContainer(subject: NestSubject, candidates: NestCandidate[]): string | null {
  const containing = candidates.filter((c) => c.startMs <= subject.startMs && c.endMs >= subject.endMs);
  return preferredContainers(subject, containing)[0]?.id ?? null;
}

/** The subject's fields as `createBlock` knows them, before the row exists. */
export interface AutoNestSubjectInput {
  startAt: string;
  endAt: string;
  taskId: string | null | undefined;
  /** The block's own denormalized tag string, if the caller set one. */
  tag: string | null | undefined;
  /** Category NAMES the caller passed explicitly, if any. */
  categories: string[] | undefined;
}

/**
 * Which rows can receive a member at all, independent of time: a Time Block actually
 * placed on the timeline. `PLACED_TIMEBLOCK_SQL` (engine/mobility.ts) is that fact, and
 * the obstacle queries read the same constant to decide which containers hold their
 * slot — you can only nest into something that occupies time, so it is one set.
 *
 * This file used to carry its own copy with the same four conditions in a different
 * clause order, which is precisely the shape a grep for the other one does not find.
 *
 * Note what it does NOT say: `block_type = 'scheduled'`. That value is written only by
 * the Element wizard, and a container created anywhere else carries NULL and is still a
 * real Time Block — the assumption that kept such containers invisible to the
 * autoscheduler's Plan passes (see `placeIntoContainers` in engine/autoplan.ts) and,
 * until #559, to the obstacle set as well.
 */
const CANDIDATES_SQL = `
  SELECT id, start_at, end_at, tag, task_id
    FROM time_blocks
   WHERE owner_id = ?
     AND ${PLACED_TIMEBLOCK_SQL}
     AND start_at <= ?
     AND end_at >= ?`;

/** Same rows, selected by OVERLAP with a range rather than containment of a span. */
const CANDIDATES_IN_RANGE_SQL = `
  SELECT id, start_at, end_at, tag, task_id
    FROM time_blocks
   WHERE owner_id = ?
     AND ${PLACED_TIMEBLOCK_SQL}
     AND start_at < ?
     AND end_at > ?
   ORDER BY start_at, id`;

interface CandidateRow {
  id: string; start_at: string; end_at: string; tag: string | null; task_id: string | null;
}

/** Read each row's two coordinates, dropping rows with unparseable timestamps. */
async function toCandidates(rows: CandidateRow[]): Promise<NestCandidate[]> {
  const out: NestCandidate[] = [];
  for (const r of rows) {
    const startMs = Date.parse(r.start_at);
    const endMs = Date.parse(r.end_at);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) continue;
    out.push({
      id: r.id,
      startMs,
      endMs,
      directions: splitTagString(r.tag),
      categories: await containerCategories(r.id, r.task_id),
    });
  }
  return out;
}

/**
 * Every Time Block overlapping [fromISO, toISO) that could receive a member, with its
 * coordinates read the same way `resolveAutoNestParent` reads them.
 *
 * For the autoscheduler's L02-first pass: it needs the DAY's containers rather than the
 * ones containing a span that does not exist yet. Sharing the query is the point — a
 * container the create path would nest into and the engine would not is the drift this
 * removes.
 */
export async function nestCandidatesInRange(
  ownerId: string,
  fromISO: string,
  toISO: string,
): Promise<NestCandidate[]> {
  const rows = (await store().prepare(CANDIDATES_IN_RANGE_SQL).all(ownerId, toISO, fromISO)) as CandidateRow[];
  return await toCandidates(rows);
}

/** A task's level-1 direction tag names. */
async function taskDirectionNames(ownerId: string, taskId: string): Promise<string[]> {
  const rows = (await store()
    .prepare(
      `SELECT tg.name FROM entity_tags et
         JOIN tags tg ON tg.id = et.tag_id
        WHERE et.entity_kind = 'task' AND et.entity_id = ? AND et.level = 1
          AND tg.kind = 'direction' AND tg.owner_id = ?`,
    )
    .all(taskId, ownerId)) as { name: string }[];
  return rows.map((r) => r.name);
}

/**
 * An existing task's coordinates. The autoscheduler's subject is a task that has not
 * been given a span yet, so it reads the task directly rather than through
 * `AutoNestSubjectInput` (which describes a block about to be inserted).
 */
export async function taskNestCoords(ownerId: string, taskId: string): Promise<NestCoords> {
  return {
    directions: await taskDirectionNames(ownerId, taskId),
    categories: await entityCategoryNames('task', taskId),
  };
}

/**
 * Resolve the parent a new task block should nest into, reading the coordinates the
 * matcher needs. Returns null when nothing qualifies (the common case).
 *
 * The subject's coordinates fall back to its linked task: a block created from a task
 * usually carries no tag or categories of its own, and the task is what the owner
 * actually classified. This mirrors the read-side derive rule (`blockCategoryNames`)
 * so what nests and what renders agree.
 *
 * Candidate containment is filtered in SQL on the ISO timestamps (lexicographic order
 * matches chronological order for this format — the same assumption `fetchBlocksForRange`
 * already makes) and re-checked numerically in the matcher, so a malformed row cannot
 * smuggle a false positive through.
 */
export async function resolveAutoNestParent(
  ownerId: string,
  input: AutoNestSubjectInput,
): Promise<string | null> {
  const startMs = Date.parse(input.startAt);
  const endMs = Date.parse(input.endAt);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;

  const rows = (await store()
    .prepare(CANDIDATES_SQL)
    .all(ownerId, input.startAt, input.endAt)) as CandidateRow[];
  if (rows.length === 0) return null;

  const subject: NestSubject = {
    startMs,
    endMs,
    directions: await subjectDirections(ownerId, input),
    categories: await subjectCategories(input),
  };
  // Nothing to match on → nothing to nest into. Skips the per-candidate category reads.
  if (subject.directions.length === 0) return null;

  return chooseContainer(subject, await toCandidates(rows));
}

/** The block's own tag wins; otherwise the linked task's level-1 direction tags. */
async function subjectDirections(ownerId: string, input: AutoNestSubjectInput): Promise<string[]> {
  const own = splitTagString(input.tag);
  if (own.length || !input.taskId) return own;
  return await taskDirectionNames(ownerId, input.taskId);
}

/** Explicit categories win; otherwise the linked task's. */
async function subjectCategories(input: AutoNestSubjectInput): Promise<string[]> {
  if (input.categories?.length) return input.categories;
  if (input.categories !== undefined || !input.taskId) return [];
  return await entityCategoryNames('task', input.taskId);
}

/** A container's effective categories — its own rows, else its task's (the read rule). */
async function containerCategories(blockId: string, taskId: string | null): Promise<string[]> {
  const own = await entityCategoryNames('time_block', blockId);
  if (own.length || !taskId) return own;
  return await entityCategoryNames('task', taskId);
}
