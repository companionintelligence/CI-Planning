import { sqlite, vecAvailable } from '../db/index.js';
import { embed } from '../mcp/ollama.js';
import { logger } from '../lib/logger.js';
import { currentOwnerId } from '../lib/context.js';
import { promotePossible } from '../services/possibles.js';

export interface PromoteResult {
  promoted: number;
  /** Rows whose promote threw (e.g. a UNIQUE collision) — left pending for triage. */
  failed: number;
}

/**
 * Promote ALL pending possible_tasks into real tasks.
 *
 * AF-3: promotion is UNCONDITIONAL — no trust-mode gate, no confidence threshold. The
 * ingestion producers auto-promote at batch end (services/possibles.ts
 * `promoteAllPending`), so this function is the nightly SWEEPER for stragglers only
 * (rows created outside the producer paths, or left over from a mid-batch crash).
 * trust_mode now governs auto-BLOCKING only (resolveTrustPolicy → autoBlock).
 *
 * Each row goes through the ONE shared promotion core, `promotePossible`
 * (services/possibles.ts) — same column copy, same tag leveling (direction → level 1,
 * content → level 2), same audit row — so the sweeper can never drift from the manual
 * route / batch path again. Per-item poison isolation (no wrapping transaction): a row
 * whose promote throws (e.g. the 0027 partial UNIQUE(source_kind, source_ref) on tasks)
 * is logged and left pending; the rest of the sweep proceeds.
 */
export async function promotePossibles(): Promise<PromoteResult> {
  const pending = sqlite
    .prepare("SELECT id, proposed_owner_id FROM possible_tasks WHERE status = 'pending'")
    .all() as { id: string; proposed_owner_id: string | null }[];

  let promoted = 0;
  let failed = 0;

  for (const p of pending) {
    // Legacy/hand-inserted rows may lack an owner; promotePossible is owner-scoped
    // (matches by proposed_owner_id), so backfill to the current owner first — the
    // same fallback the old inline INSERT applied at task-creation time.
    let owner = p.proposed_owner_id;
    if (!owner) {
      owner = currentOwnerId();
      sqlite.prepare(`UPDATE possible_tasks SET proposed_owner_id = ? WHERE id = ?`).run(owner, p.id);
    }
    try {
      const res = await promotePossible(owner, p.id);
      if (res.ok) promoted++;
    } catch (err) {
      failed++;
      logger.error('promotePossibles: promote failed for possible — leaving pending', {
        possibleId: p.id,
        err: (err as Error).message,
      });
    }
  }

  logger.info('promotePossibles done', { promoted, failed });
  return { promoted, failed };
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
 *
 * AF-3: `opts.owner` scopes the pass to one owner's pending rows (by
 * `proposed_owner_id`, the table's owner key) — the inline post-ingest dedupe uses it
 * so one owner's batch never compares against (or marks) another owner's rows. The
 * nightly grooming call stays unscoped (its historical whole-table sweep).
 */
export async function dedupePossibles(
  opts: { threshold?: number; embedFn?: (text: string) => Promise<number[]>; owner?: string } = {},
): Promise<DedupeResult> {
  const threshold = opts.threshold ?? 0.92;
  const embedFn = opts.embedFn ?? embed; // injectable for tests (avoids cross-file module mocks)
  const pending = (
    opts.owner
      ? sqlite
          .prepare("SELECT id, raw_title FROM possible_tasks WHERE status = 'pending' AND proposed_owner_id = ? ORDER BY id ASC")
          .all(opts.owner)
      : sqlite.prepare("SELECT id, raw_title FROM possible_tasks WHERE status = 'pending' ORDER BY id ASC").all()
  ) as { id: string; raw_title: string }[];

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
