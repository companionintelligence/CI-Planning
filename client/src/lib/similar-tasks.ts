import type { Task } from './api.js';

/**
 * Duplicate-guard for the wizard's quick line (owner request 2026-07-20): before
 * a new task is created, surface the owner's EXISTING tasks whose title is close,
 * so a tap opens that task instead of creating a near-duplicate. Pure +
 * framework-free so it unit-tests in node.
 *
 * Matching (title-only, normalized): case-fold, strip punctuation, collapse
 * whitespace, tokenize. A candidate matches when it's an exact normalized match,
 * one title contains the other, or their token sets overlap by Jaccard ≥ 0.5.
 * Terminal tasks (done/completed/cancelled/skipped) and the currently-edited
 * task are excluded — a done task isn't a live duplicate. Ranked by score,
 * capped.
 */

const TERMINAL = new Set(['done', 'completed', 'cancelled', 'skipped']);

export function normalizeTitle(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function tokens(norm: string): Set<string> {
  return new Set(norm ? norm.split(' ') : []);
}

/** 0..1 similarity of two RAW titles. 1 = exact (normalized); 0.85 = containment. */
export function titleScore(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.length >= 3 && nb.length >= 3 && (na.includes(nb) || nb.includes(na))) return 0.85;
  const ta = tokens(na);
  const tb = tokens(nb);
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union; // Jaccard
}

export interface SimilarTask {
  id: string;
  title: string;
  status: string;
  score: number;
}

export function findSimilarTasks(
  title: string,
  tasks: Task[],
  opts: { excludeId?: string; limit?: number; threshold?: number } = {},
): SimilarTask[] {
  const norm = normalizeTitle(title);
  if (norm.length < 3) return []; // too short to match meaningfully while typing
  const threshold = opts.threshold ?? 0.5;
  const scored: SimilarTask[] = [];
  for (const t of tasks) {
    if (t.id === opts.excludeId) continue;
    if (t.parent_id) continue;          // subtasks are noise here
    if (TERMINAL.has(t.status)) continue;
    const score = titleScore(title, t.title);
    if (score >= threshold) scored.push({ id: t.id, title: t.title, status: t.status, score });
  }
  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return scored.slice(0, opts.limit ?? 5);
}
