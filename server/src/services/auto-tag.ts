import { sqlite } from '../db/index.js';
import { suggestTags } from '../agents/tags.js';
import { resolveTagId } from './tags.js';
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

/** Union LLM + heuristic, constrained to vocabulary, deduped, LLM-first. */
function mergeTags(llm: string[], heuristic: string[], vocabulary: string[]): string[] {
  const allow = new Set(vocabulary);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...llm, ...heuristic]) {
    if (allow.has(t) && !seen.has(t)) { seen.add(t); out.push(t); }
  }
  return out;
}

const selectVocab = sqlite.prepare(
  `SELECT name FROM tags WHERE muted = 0 ORDER BY name`,
);

// Only top-level, non-recurrence, open tasks — mirrors AllTasks.tsx baseList filter.
// NOT EXISTS on entity_tags is the idempotency gate: tasks that already have tags are
// never touched, so re-running never overwrites existing user-applied tags.
const selectUntagged = sqlite.prepare(`
  SELECT t.id, t.title FROM tasks t
  WHERE t.owner_id = ?
    AND t.status NOT IN ('cancelled', 'done')
    AND t.parent_id IS NULL
    AND t.recurrence_parent_id IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM entity_tags e
      WHERE e.entity_kind = 'task' AND e.entity_id = t.id
    )
`);

const insertEntityTag = sqlite.prepare(
  `INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)`,
);

export interface AutoTagResult {
  tagged: number;
  total: number;
  log: string;
}

/**
 * Tag all untagged top-level open tasks for `ownerId`. Shared code path used by
 * both the auto-tag button (via the POST /api/tasks/auto-tag endpoint) and the
 * `tag_tasks` cron job.
 *
 * - Idempotent: the NOT EXISTS gate skips already-tagged tasks; INSERT OR IGNORE
 *   prevents duplicates even if called concurrently.
 * - Deterministic fallback: when Ollama is unavailable, suggestTags() returns []
 *   and tagTitleFallback() supplies heuristic tags so the job never produces zero
 *   output solely due to model unavailability.
 * - Non-destructive: only adds tags to tasks that have none; never removes or
 *   replaces existing user-applied tags.
 */
export async function tagUntaggedTasks(ownerId: string): Promise<AutoTagResult> {
  const vocabulary = (selectVocab.all() as { name: string }[]).map((r) => r.name);
  if (vocabulary.length === 0) {
    return { tagged: 0, total: 0, log: 'No tag vocabulary yet; skipped' };
  }

  const tasks = selectUntagged.all(ownerId) as { id: string; title: string }[];
  if (tasks.length === 0) {
    return { tagged: 0, total: 0, log: 'No untagged tasks to process' };
  }

  let tagged = 0;
  let ollamaHit = false;

  for (const task of tasks) {
    const llm = await suggestTags(task.title, vocabulary); // returns [] on any failure
    if (llm.length > 0) ollamaHit = true;
    const merged = mergeTags(llm, tagTitleFallback(task.title, vocabulary), vocabulary);
    if (merged.length > 0) {
      for (const name of merged) insertEntityTag.run(task.id, resolveTagId(name));
      tagged++;
    }
  }

  const note = ollamaHit ? '' : ' (Ollama unavailable — heuristic fallback used)';
  const log = `Tagged ${tagged} of ${tasks.length} untagged task(s)${note}`;
  logger.info('auto-tag', { tagged, total: tasks.length, ollamaHit });
  return { tagged, total: tasks.length, log };
}
