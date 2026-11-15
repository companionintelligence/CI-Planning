/**
 * Objective accent for the Planner day grid — spike #361 step 1 (option (c), #386).
 *
 * Pure: maps blocks to the most specific objective their linked task serves, so a member
 * chip can carry its objective's colour with ZERO added geometry. No band, no
 * rail, no span — the spike measured a derived min→max span at 25-29% density,
 * swallowing rival objectives' blocks and interleaving so spans cannot nest
 * (docs/objectives-in-planner.md §3). Identity is the part of "like a Time
 * Block" the data supports; the box is not.
 *
 * Pure and DOM-free on purpose (mirrors lib/group-move.ts's rule) — unit-tested
 * in isolation in objective-accent.test.ts.
 */

/** The structural slice of the objectives tree this module needs. The real
 * `Objective` (lib/api.ts) satisfies it; tests build fixtures against it. */
export interface AccentSource {
  id: string;
  title: string;
  /** Linked tasks may be attached to any node in the objective tree. */
  tasks: { id: string }[];
  children: AccentSource[];
  /** #391 (forward seam): user-chosen colour token; absent/null → hash. */
  color_token?: string | null;
}

export interface ObjectiveAccent {
  id: string;
  title: string;
  colorIndex: number;
  color_token?: string | null;
}

/**
 * Accent palette cycle. Deliberately does NOT lead with chart-1: its dark-mode
 * value (#58ebbf mint) already means "P3" on chips and the TaskCard footer —
 * cycling from chart-2 keeps the first objective a user ever creates from
 * colliding with that meaning (chart-1 still appears, just last).
 */
export const ACCENT_TOKENS = ['chart-2', 'chart-3', 'chart-4', 'chart-5', 'chart-1'] as const;

/** Stable id → palette index: FNV-1a over the id string. Same id ⇒ same index,
 * across calls and independent of tree order. */
export function accentIndex(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h % ACCENT_TOKENS.length;
}

/**
 * The ONE colour-resolution seam (#386 addendum): every consumer takes the
 * accent colour from here. #391 landed `objectives.color_token`, so the planned
 * upgrade is now live — a user-chosen token wins; the stable id-hash is the
 * permanent fallback for objectives with no colour set.
 */
export function accentColor(obj: { id: string; color_token?: string | null }): string {
  if (obj.color_token) return `var(--${obj.color_token})`;
  return `var(--${ACCENT_TOKENS[accentIndex(obj.id)]})`;
}

/**
 * Walk the live tree and map task id → owning objective. If a task is linked to
 * multiple nodes, prefer the deepest node, then the lexically smallest id. This
 * lets a task linked only to a parent use that parent's accent while retaining a
 * more specific child accent when the same task is linked in both places.
 *
 * A task serving multiple objectives (legal — objective_tasks is M:N) resolves
 * to the deepest node, then lowest objective id: deterministic, independent of tree order.
 * (The spike's prototype used first-match, a latent order-dependence bug.)
 */
export function objectiveByTask(objectives: AccentSource[]): Map<string, AccentSource> {
  const byTask = new Map<string, AccentSource>();
  const depthByTask = new Map<string, number>();
  const walk = (nodes: AccentSource[], depth: number) => {
    for (const node of nodes) {
      for (const t of node.tasks) {
        const existing = byTask.get(t.id);
        const existingDepth = depthByTask.get(t.id) ?? -1;
        if (!existing || depth > existingDepth || (depth === existingDepth && node.id < existing.id)) {
          byTask.set(t.id, node);
          depthByTask.set(t.id, depth);
        }
      }
      walk(node.children, depth + 1);
    }
  };
  walk(objectives, 0);
  return byTask;
}

/** @deprecated Use objectiveByTask; retained for existing imports. */
export const leafObjectiveByTask = objectiveByTask;

/**
 * blockId → the accent of the most specific objective its task serves. Blocks with no
 * `task_id` (breaks, buffers, containers) and tasks with no objective simply
 * have no entry — the chip renders unchanged.
 */
export function objectiveOfBlock(
  objectives: AccentSource[],
  blocks: { id: string; task_id?: string | null }[],
): Map<string, ObjectiveAccent> {
  const byTask = objectiveByTask(objectives);
  const out = new Map<string, ObjectiveAccent>();
  for (const b of blocks) {
    if (b.task_id == null) continue;
    const obj = byTask.get(b.task_id);
    if (!obj) continue;
    out.set(b.id, { id: obj.id, title: obj.title, colorIndex: accentIndex(obj.id), color_token: obj.color_token });
  }
  return out;
}
