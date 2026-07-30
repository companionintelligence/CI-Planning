import type { Database } from 'better-sqlite3';

export const id = '0141_task_motivation';

/**
 * Motivation axis (docs/triality-design.md §3b): who the work is for.
 *
 *  - motivation: 'me' (the owner's own legacy) | 'us' (genuinely shared) |
 *    'them' (other people) | NULL (unlabeled). NULL ≠ 'us' is the axis's core
 *    correctness rule — "shared benefit" is a positive claim, "never asked" is
 *    the absence of one, and the metrics must be able to tell them apart even
 *    though SCORING collapses both to 0 (a shared task is neutral on the axis,
 *    exactly like an unsensed one).
 *
 *  - motivation_source: 'user' (wizard/API — wins permanently, never re-tagged)
 *    | 'llm' (machine-attributed: the local model, or the conservative keyword
 *    fallback when Ollama is down). NULL exactly when motivation is NULL.
 *
 * Values enforced in code, not CHECK constraints (repo convention).
 * Idempotent via the B0 addColumn-if-missing pattern.
 */
export function up(db: Database): void {
  const cols = db.prepare(`PRAGMA table_info(tasks)`).all() as { name: string }[];
  const has = (c: string) => cols.some((x) => x.name === c);
  if (!has('motivation')) db.exec(`ALTER TABLE tasks ADD COLUMN motivation TEXT`);
  if (!has('motivation_source')) db.exec(`ALTER TABLE tasks ADD COLUMN motivation_source TEXT`);
}
