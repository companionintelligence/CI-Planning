import { sqlite, vecAvailable } from '../db/index.js';
import { embed } from '../mcp/ollama.js';
import { logger } from '../lib/logger.js';
import { currentOwnerId } from '../lib/context.js';
import { resolveTrustPolicy } from '../engine/autoplan.js';

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
  const policy = resolveTrustPolicy(currentOwnerId());
  const pending = sqlite
    .prepare("SELECT * FROM possible_tasks WHERE status = 'pending'")
    .all() as PossibleRow[];

  // TM-5: Cautious trust mode never auto-promotes — everything waits in the Inbox for a
  // manual promote. (An explicit `threshold` override, used by tests, still promotes.)
  if (opts.threshold === undefined && !policy.autoPromote) {
    logger.info('promotePossibles skipped (cautious)', { keptPending: pending.length });
    return { promoted: 0, keptPending: pending.length };
  }
  const threshold = opts.threshold ?? policy.promoteThreshold;

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

      // Carry tags across: possible_task_tags → entity_tags (level 1). entity_tags is
      // the sole task-tag store (CON-3 / migration 0041).
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

// Phase M C3: test override for the sqlite-vec path. null = use the real `vecAvailable`.
let vecOverride: boolean | null = null;
/** Test-only: force the vec0 KNN path (true), the cosine fallback (false), or auto (null). */
export function _setVecForTest(v: boolean | null): void { vecOverride = v; }

/**
 * Phase M C3 — the greedy dedupe via a transient `vec0` KNN index. Reproduces the
 * cosine loop's semantics EXACTLY: tasks are processed id-ASC, a task is a duplicate
 * iff it is ≥ threshold (by the SAME `cosine()`) to an earlier *kept* task. vec0 only
 * accelerates "find the nearest kept vector"; the keep/drop decision still uses
 * `cosine()`, so results are identical to the fallback. Throws on any vec error (the
 * caller then falls back to cosine); always drops its temp table.
 */
function dedupeIdsViaVec(vectors: { id: string; vec: number[] }[], threshold: number): { dupIds: string[]; compared: number } {
  const D = vectors[0].vec.length;
  sqlite.exec(`DROP TABLE IF EXISTS vec_dedupe_tmp`);
  sqlite.exec(`CREATE VIRTUAL TABLE vec_dedupe_tmp USING vec0(embedding float[${D}] distance_metric=cosine)`);
  try {
    const ins = sqlite.prepare(`INSERT INTO vec_dedupe_tmp(rowid, embedding) VALUES (?, ?)`);
    const knn = sqlite.prepare(`SELECT rowid FROM vec_dedupe_tmp WHERE embedding MATCH ? ORDER BY distance LIMIT 1`);
    const dupIds: string[] = [];
    let compared = 0;
    let kept = 0;
    for (let i = 0; i < vectors.length; i++) {
      const v = vectors[i];
      if (v.vec.length !== D) throw new Error('embedding dimension mismatch'); // bail → cosine fallback
      const f = new Float32Array(v.vec);
      if (kept > 0) {
        const near = knn.get(f) as { rowid: number | bigint } | undefined;
        if (near) {
          compared++;
          const otherIdx = Number(near.rowid); // rowid is the kept vector's index
          if (cosine(v.vec, vectors[otherIdx].vec) >= threshold) { dupIds.push(v.id); continue; }
        }
      }
      ins.run(BigInt(i), f); // keep: rowid = this vector's index
      kept++;
    }
    return { dupIds, compared };
  } finally {
    sqlite.exec(`DROP TABLE IF EXISTS vec_dedupe_tmp`);
  }
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
export async function dedupePossibles(
  opts: { threshold?: number; embedFn?: (text: string) => Promise<number[]> } = {},
): Promise<DedupeResult> {
  const threshold = opts.threshold ?? 0.92;
  const embedFn = opts.embedFn ?? embed; // injectable for tests (avoids cross-file module mocks)
  const pending = sqlite
    .prepare("SELECT id, raw_title FROM possible_tasks WHERE status = 'pending' ORDER BY id ASC")
    .all() as { id: string; raw_title: string }[];

  if (pending.length < 2) return { compared: 0, duplicates: 0, available: true };

  let vectors: { id: string; vec: number[] }[];
  try {
    vectors = [];
    for (const p of pending) vectors.push({ id: p.id, vec: await embedFn(p.raw_title) });
  } catch (err) {
    logger.warn('dedupePossibles: embeddings unavailable, skipping', { err: (err as Error).message });
    return { compared: 0, duplicates: 0, available: false };
  }

  const markDup = sqlite.prepare("UPDATE possible_tasks SET status = 'duplicate' WHERE id = ?");

  // C3: fast path — vec0 KNN when the extension is loaded. Identical decisions to the
  // cosine loop (the keep/drop still uses cosine()); any vec error falls through below.
  if ((vecOverride ?? vecAvailable) && vectors.length >= 2) {
    try {
      const { dupIds, compared } = dedupeIdsViaVec(vectors, threshold);
      for (const id of dupIds) markDup.run(id);
      logger.info('dedupePossibles done (vec0 KNN)', { compared, duplicates: dupIds.length });
      return { compared, duplicates: dupIds.length, available: true };
    } catch (err) {
      logger.warn('dedupePossibles: vec0 path failed, using cosine fallback', { err: (err as Error).message });
      // fall through to the deterministic cosine loop
    }
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
        markDup.run(v.id);
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
