import type { InferSelectModel } from 'drizzle-orm';
import { tasks, schedulingPrefs } from '../db/schema.js';
import { generateJson, isAvailable } from '../mcp/ollama.js';
import { logger } from '../lib/logger.js';

type Task = InferSelectModel<typeof tasks>;
type Prefs = InferSelectModel<typeof schedulingPrefs>;

/**
 * When planning_mode is 'auto' and a local model is available, let the LLM
 * reorder today's candidate tasks (most important first). This is the only place
 * AI touches scheduling — *placement* stays deterministic, so the plan is still
 * reproducible. Any failure (model down, bad JSON, partial list) falls back to
 * the deterministic ranking it was handed.
 */
export async function orderForToday(ranked: Task[], prefs: Prefs): Promise<Task[]> {
  if (prefs.planningMode !== 'auto' || ranked.length < 2) return ranked;
  if (!(await isAvailable())) return ranked;

  try {
    const lines = ranked
      .map(
        (t, i) =>
          `${i}: [P${t.priority ?? 3}] ${t.title}` +
          `${t.dueAt ? ` (due ${t.dueAt.slice(0, 10)})` : ''} ~${t.estimatedMinutes ?? 30}m`
      )
      .join('\n');

    const prompt =
      `You are planning today's work. Order these tasks from most to least important ` +
      `to do today, weighing deadlines, priority (P1 is highest), and momentum. ` +
      `Reply with ONLY a JSON array of the item numbers in your chosen order, e.g. [3,0,1,2].\n\n${lines}`;

    const idx = await generateJson<number[]>(prompt, { tier: 'small', temperature: 0.2, timeoutMs: 20_000 });
    if (!Array.isArray(idx)) return ranked;

    const seen = new Set<number>();
    const out: Task[] = [];
    for (const i of idx) {
      if (Number.isInteger(i) && i >= 0 && i < ranked.length && !seen.has(i)) {
        seen.add(i);
        out.push(ranked[i]);
      }
    }
    // Append anything the model dropped so no task silently disappears.
    for (let i = 0; i < ranked.length; i++) if (!seen.has(i)) out.push(ranked[i]);

    return out.length === ranked.length ? out : ranked;
  } catch (err) {
    logger.warn('plan.orderForToday: falling back to deterministic order', { err: (err as Error).message });
    return ranked;
  }
}
