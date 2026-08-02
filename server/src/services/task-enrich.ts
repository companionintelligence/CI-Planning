import { store } from '../db/store.js';
import { generateJson } from '../mcp/ollama.js';
import { graphSearch, memoryMode, type MemoryNode } from '../connectors/memory.js';
import { directionGuide, isMotivation, MOTIVATION_RUBRIC } from '../agents/rubric.js';
import { applyMachineMotivation } from './motivation.js';
import {
  resolveTagId, taskHasLevel1Direction,
  entityCategoryIds, categoryIdsForOwner, setEntityCategories, suggestibleVocabulary,
} from './tags.js';
import { logger } from '../lib/logger.js';

/**
 * Memory-backed task enrichment (handoff D4/§4.5): pull what Companion Intelligence
 * already knows that relates to a task, and use it to write a short DESCRIPTION and — only
 * when the task still has none — pick its Work/Home/Community direction and its 1–3
 * Balance categories (the §4.5 "direction/category call"; entity_categories, never
 * entity_tags).
 *
 * Deliberately NOT on the interactive quick-add path. Memory means a CI-Server round-trip,
 * and quick-add has to stay instant, so this runs from two entry points that share this
 * one implementation:
 *   - on demand, per task (POST /api/tasks/:id/enrich)
 *   - the nightly `enrich_tasks` cron sweep
 *
 * Degradation is silent and total. Memory off/unreachable, Ollama down, no related nodes,
 * unparseable answer → `{ enriched: false }` and the task is left exactly as it was. The
 * caller reports honestly; nothing here throws and nothing here guesses. A description
 * invented from an empty graph would be a fabrication attached to the user's own data,
 * which is worse than leaving the field blank.
 *
 * NON-DESTRUCTIVE: it only ever fills blanks. An existing description is never rewritten
 * and an existing level-1 direction is never replaced — those are the user's.
 */

/** How many graph nodes to feed the model. Enough for context, short enough to stay fast. */
const GRAPH_LIMIT = 8;

export interface EnrichTaskResult {
  enriched: boolean;
  /** Why not, when `enriched` is false — surfaced verbatim so a no-op is never mysterious. */
  reason?: string;
  description?: string;
  direction?: string;
  /** Category names written (1–3, best fit first) — only when the task had none. */
  categories?: string[];
  /** Motivation written (0141, §3b) — only when the task was unlabeled. */
  motivation?: 'me' | 'us' | 'them';
  /** Names of the memory items the description was drawn from (provenance for the UI). */
  sources?: string[];
}

/**
 * Constrain a model's category answer to the owner's real vocabulary: canonical casing
 * from the vocab, unknown names dropped, deduped, capped at 3 (the entity_categories
 * limit). Exported for its unit tests — the same never-invent rule as every classifier.
 */
export function constrainCategories(raw: unknown, vocabulary: string[]): string[] {
  if (!Array.isArray(raw)) return [];
  const byLower = new Map(vocabulary.map((c) => [c.toLowerCase(), c]));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (out.length >= 3) break;
    if (typeof v !== 'string') continue;
    const canonical = byLower.get(v.trim().toLowerCase());
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  }
  return out;
}

// SQL at module level, prepared inside the functions — a module-level store() call
// would throw when this module loads before db/index installs the backend (§5.5).
const SELECT_TASK =
  `SELECT id, title, notes, motivation FROM tasks WHERE id = ? AND owner_id = ?`;
const UPDATE_NOTES =
  `UPDATE tasks SET notes = ? WHERE id = ? AND owner_id = ? AND (notes IS NULL OR notes = '')`;
const INSERT_DIRECTION =
  `INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`;
// Directions/categories come from the shared `suggestibleVocabulary` (services/tags.ts) —
// same muted rule as every other suggester, in one place rather than re-stated here.

// Words too common to identify anything — not worth a search round-trip each.
const STOPWORDS = new Set([
  'the', 'for', 'and', 'with', 'about', 'from', 'into', 'that', 'this', 'prep',
  'prepare', 'plan', 'call', 'email', 'send', 'review', 'meeting', 'task', 'todo',
]);

/**
 * Search memory for a task title. A whole-title query alone is nearly useless: search
 * implementations match the query as a unit (the fixture is a literal substring match),
 * and a task title ("Prep for the quarterly planning review") is almost never a unit that
 * appears verbatim in a memory item's name. So: try the full title first (it wins when it
 * does match), then fall back to the title's distinctive words, unioning results. Bounded
 * at 3 keyword queries so a long title cannot fan out a request storm.
 */
async function searchMemory(owner: string, title: string): Promise<MemoryNode[]> {
  const seen = new Map<string, MemoryNode>();
  const add = (nodes: MemoryNode[]) => { for (const n of nodes) if (!seen.has(n.id)) seen.set(n.id, n); };

  add((await graphSearch(owner, title, { limit: GRAPH_LIMIT })).nodes);
  if (seen.size < GRAPH_LIMIT) {
    const keywords = title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
      .sort((a, b) => b.length - a.length) // longest first — most distinctive
      .slice(0, 3);
    for (const w of keywords) {
      if (seen.size >= GRAPH_LIMIT) break;
      add((await graphSearch(owner, w, { limit: GRAPH_LIMIT })).nodes);
    }
  }
  return [...seen.values()].slice(0, GRAPH_LIMIT);
}

/** Compact the graph into prompt-sized lines: name, type, and description when present. */
function describeNodes(nodes: MemoryNode[]): string {
  return nodes
    .slice(0, GRAPH_LIMIT)
    .map((n) => {
      const desc = n.description?.trim();
      return `- ${n.name} (${n.entityType})${desc ? `: ${desc.slice(0, 200)}` : ''}`;
    })
    .join('\n');
}

interface EnrichOut {
  description?: unknown;
  direction?: unknown;
  categories?: unknown;
  motivation?: unknown;
}

/**
 * Enrich ONE task from memory. Returns what changed (or why nothing did). Never throws.
 */
export async function enrichTaskFromMemory(owner: string, taskId: string): Promise<EnrichTaskResult> {
  if (memoryMode() === 'off') {
    return { enriched: false, reason: 'Memory is off (set MEMORY_MODE=live or fixture)' };
  }
  const task = await store().prepare(SELECT_TASK)
    .get<{ id: string; title: string; notes: string | null; motivation: string | null }>(taskId, owner);
  if (!task) return { enriched: false, reason: 'Task not found' };

  // Nothing to do when every field this can fill is already set — skip the round-trips
  // entirely rather than asking the model for an answer that would be discarded.
  // Categories count as "needed" only when the owner actually HAS a category vocabulary:
  // with none, an empty entity_categories set is not a blank to fill, and treating it as
  // one would make every task permanently enrichable.
  const vocab = suggestibleVocabulary(owner);
  const categories = vocab.categories;
  const needsDescription = !task.notes?.trim();
  const needsDirection = !taskHasLevel1Direction(taskId, owner);
  const needsCategories = categories.length > 0 && entityCategoryIds('task', taskId).length === 0;
  // Motivation (0141, §3b): a blank to fill only while unlabeled — a user OR earlier
  // machine label stands (the never-re-tag contract; applyMachineMotivation re-guards
  // in SQL against a concurrent write).
  const needsMotivation = task.motivation === null;
  if (!needsDescription && !needsDirection && !needsCategories && !needsMotivation) {
    return { enriched: false, reason: 'Already has a description, direction, categories, and motivation' };
  }

  let nodes: MemoryNode[] = [];
  try {
    nodes = await searchMemory(owner, task.title);
  } catch (err) {
    // Unreachable CI-Server / bad credentials — the honest outcome is "no memory", not an error.
    return { enriched: false, reason: `Memory unavailable: ${(err as Error).message}` };
  }
  if (nodes.length === 0) return { enriched: false, reason: 'No related memory found' };

  const directions = vocab.directions;
  let out: EnrichOut;
  try {
    out = await generateJson<EnrichOut>(
      `Here is a task and related items from the user's own knowledge graph.\n` +
        `Related items:\n${describeNodes(nodes)}\n\n` +
        `Task: "${task.title}"\n\n` +
        `Reply with JSON {"description": <one or two sentences, or null>` +
        (needsDirection && directions.length
          ? `, "direction": <exactly one of ${JSON.stringify(directions)}>`
          : '') +
        (needsCategories
          ? `, "categories": <1-3 life areas from ${JSON.stringify(categories)}, best fit first, or []>`
          : '') +
        (needsMotivation ? `, "motivation": <"me" | "us" | "them" | null>` : '') +
        `}. The description must say what this task is about USING ONLY the related items ` +
        `above — it adds the context the bare title is missing (who and what it concerns). ` +
        `If the related items do not actually pertain to this task, answer null; never ` +
        `invent details.` +
        (needsDirection && directions.length ? directionGuide(directions) : '') +
        (needsCategories
          ? ` Choose categories ONLY from the given list — never invent; [] when none fit.`
          : '') +
        (needsMotivation ? ` For "motivation": ${MOTIVATION_RUBRIC}` : ''),
      { tier: 'small', temperature: 0.2, timeoutMs: 20_000 },
    );
  } catch (err) {
    return { enriched: false, reason: `AI unavailable: ${(err as Error).message}` };
  }

  const result: EnrichTaskResult = { enriched: false };

  if (needsDescription && typeof out.description === 'string' && out.description.trim()) {
    const description = out.description.trim().slice(0, 500);
    // The guarded UPDATE (notes IS NULL OR '') is the real race protection: if the user
    // typed notes between the read above and this write, changes is 0 and theirs stand.
    if ((await store().prepare(UPDATE_NOTES).run(description, taskId, owner)).changes > 0) {
      result.description = description;
      result.enriched = true;
    }
  }

  // Direction: constrained to the owner's real direction tags, canonical casing from the
  // vocabulary — same never-invent rule as every other classifier here.
  if (needsDirection && typeof out.direction === 'string') {
    const canonical = directions.find((d) => d.toLowerCase() === out.direction!.toString().trim().toLowerCase());
    // Re-check the guard: a concurrent edit may have given the task a direction since.
    if (canonical && !taskHasLevel1Direction(taskId, owner)) {
      await store().prepare(INSERT_DIRECTION).run(taskId, resolveTagId(canonical, owner));
      result.direction = canonical;
      result.enriched = true;
    }
  }

  // Categories (§4.5's "category call"): same fill-blanks-only doctrine, on the
  // entity_categories axis (Phase B) — NEVER entity_tags, where a category must not leak.
  if (needsCategories) {
    const picked = constrainCategories(out.categories, categories);
    // Names → the owner's category-tag ids; then re-check the guard — a concurrent edit
    // may have given the task categories since the read above, and setEntityCategories
    // REPLACES the set, so writing over a user's picks would be destructive, not additive.
    if (picked.length > 0 && entityCategoryIds('task', taskId).length === 0) {
      setEntityCategories('task', taskId, categoryIdsForOwner(picked, owner));
      result.categories = picked;
      result.enriched = true;
    }
  }

  // Motivation (0141): the SQL guard in applyMachineMotivation IS the concurrency
  // re-check — a user label written since the read above wins and changes = 0.
  if (needsMotivation && isMotivation(out.motivation)) {
    if (applyMachineMotivation(owner, taskId, out.motivation)) {
      result.motivation = out.motivation;
      result.enriched = true;
    }
  }

  if (!result.enriched) return { enriched: false, reason: 'Memory had nothing to add' };
  result.sources = nodes.slice(0, GRAPH_LIMIT).map((n) => n.name);
  logger.info('task-enrich', {
    taskId, description: !!result.description, direction: result.direction, categories: result.categories,
  });
  return result;
}

// Candidates for the nightly sweep: recent, open, top-level tasks missing a description,
// a direction, or (when the owner has a category vocabulary) categories. Bounded by
// design — an unbounded sweep would fan out one CI-Server call and one model call per
// task across the entire backlog every night.
//
// The category arm carries its own vocabulary EXISTS guard: without it, an owner with no
// category tags would have every task match "no entity_categories rows" forever — a pool
// of permanent candidates that can never be satisfied, crowding real work out of the
// LIMIT. (Mirrors the `needsCategories` guard in enrichTaskFromMemory.)
const SELECT_SWEEP_CANDIDATES = `
  SELECT t.id FROM tasks t
  WHERE t.owner_id = ?
    AND t.status NOT IN ('cancelled', 'done')
    AND t.parent_id IS NULL
    AND t.recurrence_parent_id IS NULL
    AND (
      t.notes IS NULL OR t.notes = ''
      OR NOT EXISTS (
        SELECT 1 FROM entity_tags e JOIN tags g ON g.id = e.tag_id
        WHERE e.entity_kind = 'task' AND e.entity_id = t.id AND e.level = 1 AND g.kind = 'direction'
      )
      OR (
        NOT EXISTS (
          SELECT 1 FROM entity_categories ec
          WHERE ec.entity_kind = 'task' AND ec.entity_id = t.id
        )
        AND EXISTS (
          SELECT 1 FROM tags c WHERE c.owner_id = t.owner_id AND c.kind = 'category' AND c.muted = 0
        )
      )
    )
  ORDER BY t.created_at DESC
  LIMIT ?
`;

export interface SweepResult {
  enriched: number;
  considered: number;
  log: string;
}

/**
 * Nightly sweep — enrich up to `limit` recent under-described tasks. Stops early and
 * reports honestly when memory is off, so the Jobs page shows why rather than "0 done".
 */
export async function enrichRecentTasks(owner: string, limit = 20): Promise<SweepResult> {
  if (memoryMode() === 'off') {
    return { enriched: 0, considered: 0, log: 'Memory is off; skipped' };
  }
  const ids = (await store().prepare(SELECT_SWEEP_CANDIDATES).all<{ id: string }>(owner, limit)).map((r) => r.id);
  if (ids.length === 0) return { enriched: 0, considered: 0, log: 'No tasks needed enrichment' };

  let enriched = 0;
  for (const id of ids) {
    const r = await enrichTaskFromMemory(owner, id);
    if (r.enriched) enriched++;
  }
  return {
    enriched,
    considered: ids.length,
    log: `Enriched ${enriched} of ${ids.length} task(s) from memory`,
  };
}
