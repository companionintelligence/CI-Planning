import { store } from '../db/store.js';
import { splitTagString, entityCategoryNames } from './tags.js';

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
 * Pick the Time Block a new task block should nest into, or null to leave it loose.
 *
 * A candidate qualifies when:
 *  1. it CONTAINS the subject's span (a partial overlap is not containment — the task
 *     would hang outside the box it claims to be in);
 *  2. its directions intersect the subject's. A container with no direction tag
 *     carries no coordinate to match on and never claims a task;
 *  3. its categories intersect the subject's — unless the container has none, which
 *     the owner's rule lets match on direction alone.
 *
 * Ambiguity (nested or overlapping Time Blocks both qualifying) resolves to the
 * TIGHTEST span — the most specific claim wins. A genuine tie leaves the block loose
 * rather than guessing: a wrong parent is worse than none, because containment
 * changes how reflow and the L01 window rules treat the task (L02 overrides L01).
 *
 * Pure — no DB, no clock. `resolveAutoNestParent` below feeds it.
 */
export function chooseContainer(subject: NestSubject, candidates: NestCandidate[]): string | null {
  const subjDirs = lower(subject.directions);
  const subjCats = lower(subject.categories);

  const matches = candidates.filter((c) => {
    if (!(c.startMs <= subject.startMs && c.endMs >= subject.endMs)) return false;
    const dirs = lower(c.directions);
    if (dirs.size === 0 || !intersects(dirs, subjDirs)) return false;
    const cats = lower(c.categories);
    return cats.size === 0 || intersects(cats, subjCats);
  });

  if (matches.length === 0) return null;
  const span = (c: NestCandidate) => c.endMs - c.startMs;
  const tightest = matches.reduce((best, c) => (span(c) < span(best) ? c : best));
  // Two equally tight containers both claim it → no basis to choose. Leave it loose.
  if (matches.filter((c) => span(c) === span(tightest)).length > 1) return null;
  return tightest.id;
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

const CANDIDATES_SQL = `
  SELECT id, start_at, end_at, tag, task_id
    FROM time_blocks
   WHERE owner_id = ?
     AND block_kind = 'timeblock'
     AND COALESCE(all_day, 0) = 0
     AND COALESCE(block_type, '') != 'someday'
     AND (recurrence_rule IS NULL OR recurrence_parent_id IS NOT NULL)
     AND start_at <= ?
     AND end_at >= ?`;

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
    .all(ownerId, input.startAt, input.endAt)) as {
      id: string; start_at: string; end_at: string; tag: string | null; task_id: string | null;
    }[];
  if (rows.length === 0) return null;

  const subject: NestSubject = {
    startMs,
    endMs,
    directions: await subjectDirections(ownerId, input),
    categories: await subjectCategories(input),
  };
  // Nothing to match on → nothing to nest into. Skips the per-candidate category reads.
  if (subject.directions.length === 0) return null;

  const candidates: NestCandidate[] = [];
  for (const r of rows) {
    candidates.push({
      id: r.id,
      startMs: Date.parse(r.start_at),
      endMs: Date.parse(r.end_at),
      directions: splitTagString(r.tag),
      categories: await containerCategories(r.id, r.task_id),
    });
  }
  return chooseContainer(subject, candidates.filter((c) => Number.isFinite(c.startMs) && Number.isFinite(c.endMs)));
}

/** The block's own tag wins; otherwise the linked task's level-1 direction tags. */
async function subjectDirections(ownerId: string, input: AutoNestSubjectInput): Promise<string[]> {
  const own = splitTagString(input.tag);
  if (own.length || !input.taskId) return own;
  const rows = (await store()
    .prepare(
      `SELECT tg.name FROM entity_tags et
         JOIN tags tg ON tg.id = et.tag_id
        WHERE et.entity_kind = 'task' AND et.entity_id = ? AND et.level = 1
          AND tg.kind = 'direction' AND tg.owner_id = ?`,
    )
    .all(input.taskId, ownerId)) as { name: string }[];
  return rows.map((r) => r.name);
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
