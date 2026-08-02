import { store } from '../db/store.js';
import { suggestTags } from '../agents/tags.js';
import { resolveTagId, suggestibleVocabulary } from './tags.js';
import { logger } from '../lib/logger.js';

/**
 * Server-side port of client/src/lib/tag-suggest.ts `suggestTagsFromTitle`.
 * Word-boundary matching: single-word tags match whole words only; hyphenated /
 * space-separated tags match as a phrase. Kept in lockstep with the client copy.
 */
export function tagTitleFallback(title: string, vocabulary: string[]): string[] {
  const lower = title.toLowerCase();
  const words = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  const out: string[] = [];
  for (const tag of vocabulary) {
    const n = tag.trim().replace(/^#+/, '').toLowerCase();
    if (!n) continue;
    const multi = n.includes('-') || n.includes(' ');
    if (multi) {
      if (lower.includes(n) || lower.includes(n.replace(/-/g, ' '))) out.push(tag);
    } else if (words.has(n)) {
      out.push(tag);
    }
  }
  return out;
}

/**
 * Union LLM + heuristic, constrained to vocabulary, deduped, LLM-first. Exported for
 * its unit tests only (same reason as `tagTitleFallback`) — callers use
 * `tagUntaggedTasks`. Moved here from the client when the Tasks Auto-tag button stopped
 * doing its own merging, so this and the cron job share one implementation.
 */
export function mergeTags(llm: string[], heuristic: string[], vocabulary: string[]): string[] {
  const allow = new Set(vocabulary);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...llm, ...heuristic]) {
    if (allow.has(t) && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

// Vocabulary now comes from the shared `suggestibleVocabulary` (services/tags.ts), which
// owns the muted rule for every suggester. Category-kind tags are dropped HERE rather
// than there: a category is an orthogonal axis stored in entity_categories, never in
// entity_tags, so a category suggestion could only ever be discarded — and offering one
// to the model just spends tokens on an answer we can't use.

// Only top-level, non-recurrence, open tasks — mirrors AllTasks.tsx baseList filter.
// NOT EXISTS on entity_tags is the idempotency gate: tasks that already have tags are
// never touched, so re-running never overwrites existing user-applied tags. It spans ALL
// levels on purpose — a task carrying only level-2 intentions still counts as tagged, so
// the sweep can't quietly re-level a set the user chose by hand.
// SQL at module level, prepared inside the function — a module-level store() call
// would throw when this module loads before db/index installs the backend (§5.5).
const SELECT_UNTAGGED = `
  SELECT t.id, t.title FROM tasks t
  WHERE t.owner_id = ?
    AND t.status NOT IN ('cancelled', 'done')
    AND t.parent_id IS NULL
    AND t.recurrence_parent_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM entity_tags e
      WHERE e.entity_kind = 'task' AND e.entity_id = t.id
    )
`;

const INSERT_ENTITY_TAG =
  `INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, ?)`;

/**
 * AF-11 task tag model — level the merged names BY KIND. The first direction becomes the
 * single level-1 primary (a task has ONE direction, so later directions are dropped);
 * every intention lands at level 2. This is the same split the New Task wizard applies,
 * so a task tagged by this sweep is indistinguishable from a hand-tagged one.
 */
function levelByKind(
  names: string[],
  kindOf: Map<string, string>,
): { primary: string | null; intentions: string[] } {
  let primary: string | null = null;
  const intentions: string[] = [];
  for (const name of names) {
    if (kindOf.get(name) === 'direction') primary ??= name;
    else intentions.push(name);
  }
  return { primary, intentions };
}

export interface AutoTagResult {
  tagged: number;
  total: number;
  log: string;
  /** The tasks actually written — the REST route broadcasts one task:updated per id. */
  taggedIds: string[];
}

/**
 * Tag untagged top-level open tasks for `ownerId`. The ONE code path behind both the
 * Tasks view's Auto-tag button (POST /api/tasks/auto-tag) and the `tag_tasks` cron job,
 * so the two cannot drift on vocabulary, leveling, or the idempotency gate.
 *
 * - `taskIds` narrows the sweep to a caller-supplied set — the button passes what's on
 *   screen, so a filtered view tags only what the user can actually see. Omit it for the
 *   cron's owner-wide pass.
 * - Idempotent: the NOT EXISTS gate skips already-tagged tasks; INSERT OR IGNORE
 *   prevents duplicates even if called concurrently.
 * - Deterministic fallback: when Ollama is unavailable, suggestTags() returns []
 *   and tagTitleFallback() supplies heuristic tags so the job never produces zero
 *   output solely due to model unavailability.
 * - Non-destructive: only adds tags to tasks that have none; never removes or
 *   replaces existing user-applied tags.
 */
export async function tagUntaggedTasks(ownerId: string, taskIds?: string[]): Promise<AutoTagResult> {
  const vocab = suggestibleVocabulary(ownerId);
  // `directions` doubles as the prompt's semantic grounding (see agents/tags.ts) and as
  // the level-1 key below; `others` are the intentions that land at level 2.
  const directions = vocab.directions;
  const names = [...directions, ...vocab.others];
  if (names.length === 0) {
    return { tagged: 0, total: 0, taggedIds: [], log: 'No tag vocabulary yet; skipped' };
  }
  const kindOf = new Map<string, string>([
    ...directions.map((n) => [n, 'direction'] as const),
    ...vocab.others.map((n) => [n, 'intention'] as const),
  ]);

  // The scope filter runs in JS rather than as an IN-list: the id set comes from a client
  // view of unbounded size, and binding it would blow SQLite's bound-parameter cap.
  const scope = taskIds ? new Set(taskIds) : null;
  const candidates = (await store().prepare(SELECT_UNTAGGED).all<{ id: string; title: string }>(ownerId))
    .filter((t) => !scope || scope.has(t.id));
  if (candidates.length === 0) {
    return { tagged: 0, total: 0, taggedIds: [], log: 'No untagged tasks to process' };
  }

  const taggedIds: string[] = [];
  let ollamaHit = false;

  for (const task of candidates) {
    const llm = await suggestTags(task.title, names, directions); // returns [] on any failure
    if (llm.length > 0) ollamaHit = true;
    const { primary, intentions } = levelByKind(
      mergeTags(llm, tagTitleFallback(task.title, names), names),
      kindOf,
    );
    if (!primary && intentions.length === 0) continue;
    if (primary) await store().prepare(INSERT_ENTITY_TAG).run(task.id, resolveTagId(primary, ownerId), 1);
    for (const name of intentions) await store().prepare(INSERT_ENTITY_TAG).run(task.id, resolveTagId(name, ownerId), 2);
    taggedIds.push(task.id);
  }

  const note = ollamaHit ? '' : ' (Ollama unavailable — heuristic fallback used)';
  const log = `Tagged ${taggedIds.length} of ${candidates.length} untagged task(s)${note}`;
  logger.info('auto-tag', { tagged: taggedIds.length, total: candidates.length, ollamaHit });
  return { tagged: taggedIds.length, total: candidates.length, taggedIds, log };
}
