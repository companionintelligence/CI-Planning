import { sqlite } from '../db/index.js';
import { embed } from '../mcp/ollama.js';
import { logger } from '../lib/logger.js';
import { currentOwnerId } from '../lib/context.js';

export interface PromoteResult {
  promoted: number;
  keptPending: number;
}

interface PossibleRow {
  id: string;
  raw_title: string;
  raw_summary: string | null;
  proposed_due_at: string | null;
  proposed_priority: number | null;
  proposed_owner_id: string | null;
  source_kind: string | null;
  source_ref: string | null;
  confidence: number | null;
}

/**
 * Promote pending possible_tasks whose confidence meets the threshold into real tasks.
 * Copies suggested tags over to the new task. Lower-confidence items stay in the queue
 * for manual review.
 */
export function promotePossibles(opts: { threshold?: number } = {}): PromoteResult {
  const threshold = opts.threshold ?? 0.7;
  const pending = sqlite
    .prepare("SELECT * FROM possible_tasks WHERE status = 'pending'")
    .all() as PossibleRow[];

  let promoted = 0;
  let keptPending = 0;

  const tx = sqlite.transaction((rows: PossibleRow[]) => {
    for (const p of rows) {
      if ((p.confidence ?? 0) < threshold) {
        keptPending++;
        continue;
      }
      const task = sqlite
        .prepare(
          `INSERT INTO tasks (id, title, description, due_at, priority, owner_id, source_kind, source_ref, status)
           VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, 'open') RETURNING id`
        )
        .get(
          p.raw_title,
          p.raw_summary,
          p.proposed_due_at,
          p.proposed_priority ?? 3,
          p.proposed_owner_id ?? currentOwnerId(),
          p.source_kind ?? 'agent',
          p.source_ref
        ) as { id: string };

      // Carry tags across: possible_task_tags → task_tags
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO task_tags (task_id, tag_id)
           SELECT ?, tag_id FROM possible_task_tags WHERE possible_task_id = ?`
        )
        .run(task.id, p.id);
      // CON-3: mirror into the normalized store (level 1) so a promoted task is
      // tagged in entity_tags too — keeps the two stores in parity. (Matches the
      // recall clone + 0033 backfill pattern.)
      sqlite
        .prepare(
          `INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level)
           SELECT 'task', ?, tag_id, 1 FROM possible_task_tags WHERE possible_task_id = ?`
        )
        .run(task.id, p.id);

      sqlite
        .prepare("UPDATE possible_tasks SET status = 'promoted', promoted_task_id = ? WHERE id = ?")
        .run(task.id, p.id);
      promoted++;
    }
  });
  tx(pending);

  logger.info('promotePossibles done', { promoted, keptPending, threshold });
  return { promoted, keptPending };
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export interface DedupeResult {
  compared: number;
  duplicates: number;
  available: boolean;
}

/**
 * Mark near-duplicate pending possibles using embeddings (best-effort).
 * If Ollama embeddings are unavailable, returns { available: false } without throwing.
 */
export async function dedupePossibles(opts: { threshold?: number } = {}): Promise<DedupeResult> {
  const threshold = opts.threshold ?? 0.92;
  const pending = sqlite
    .prepare("SELECT id, raw_title FROM possible_tasks WHERE status = 'pending' ORDER BY id ASC")
    .all() as { id: string; raw_title: string }[];

  if (pending.length < 2) return { compared: 0, duplicates: 0, available: true };

  let vectors: { id: string; vec: number[] }[];
  try {
    vectors = [];
    for (const p of pending) vectors.push({ id: p.id, vec: await embed(p.raw_title) });
  } catch (err) {
    logger.warn('dedupePossibles: embeddings unavailable, skipping', { err: (err as Error).message });
    return { compared: 0, duplicates: 0, available: false };
  }

  let duplicates = 0;
  let compared = 0;
  const kept: string[] = [];
  for (const v of vectors) {
    let isDup = false;
    for (const k of kept) {
      compared++;
      const other = vectors.find((x) => x.id === k)!;
      if (cosine(v.vec, other.vec) >= threshold) {
        sqlite.prepare("UPDATE possible_tasks SET status = 'duplicate' WHERE id = ?").run(v.id);
        duplicates++;
        isDup = true;
        break;
      }
    }
    if (!isDup) kept.push(v.id);
  }

  logger.info('dedupePossibles done', { compared, duplicates });
  return { compared, duplicates, available: true };
}

/** Bump priority of overdue open tasks so they surface. Returns count updated. */
export function surfaceOverdue(asOf = new Date().toISOString()): number {
  const res = sqlite
    .prepare(
      `UPDATE tasks SET priority = MAX(1, priority - 1)
       WHERE status = 'open' AND due_at IS NOT NULL AND due_at < ? AND priority > 1`
    )
    .run(asOf);
  return res.changes;
}
