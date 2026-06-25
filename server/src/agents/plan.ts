/**
 * Phase M §0 / A1 — AI-in-the-loop day-plan authoring.
 *
 * `authorPlanOrder` is the single entry point for day authoring. It:
 *  - Is called ONCE per (owner, date) — the author-once guard makes every
 *    subsequent call a no-op until the next day's first placement.
 *  - Runs the §A0 generate→evaluate→iterate loop (via `runLoop`) when
 *    planning_mode = 'auto' AND Ollama is reachable.
 *  - Falls back silently to a deterministic priority/deadline order otherwise,
 *    so the app never throws and the toggle-off path is always tested in CI.
 *  - Persists the frozen order into `daily_plan`; placement and reflow only
 *    ever READ that table — they never call this function.
 *
 * The three prompt roles follow §A0.1 exactly:
 *   ① Generator  — small tier, JSON index array, PROMPT 1
 *   ② Judge      — medium tier, JSON score object, PROMPT 2 (sampled 3×)
 *   ③ Reviser    — small tier, JSON index array, PROMPT 3
 *
 * Deterministic rubric checks (the hard gate the judge can't override):
 *   • No priority inversion (a P1 task should precede a P3 task unless the
 *     P3 task has a strictly earlier deadline).
 *   • No past-due / equal-priority misordering (a past-due task should appear
 *     before a future-due same-priority task).
 */
import type { InferSelectModel } from 'drizzle-orm';
import { tasks, schedulingPrefs } from '../db/schema.js';
import { sqlite } from '../db/index.js';
import { generateJson, isAvailable } from '../mcp/ollama.js';
import { taskTagNames } from '../services/tags.js';
import { runLoop, type Defect, type JudgeScore } from './loop.js';
import { logger } from '../lib/logger.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type Task = InferSelectModel<typeof tasks>;
type Prefs = InferSelectModel<typeof schedulingPrefs>;

interface PlanTask {
  task_id: string;
  title: string;
  priority: number;
  due_at: string | null;
  estimated_minutes: number | null;
  tags: string[];
}

interface PlanningPrefs {
  planning_mode: string;
  workday_start: string;
  workday_end: string;
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

function loadPlanningPrefs(owner: string): PlanningPrefs {
  return (sqlite
    .prepare(`SELECT planning_mode, workday_start, workday_end FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as PlanningPrefs | undefined) ?? { planning_mode: 'ritual', workday_start: '09:00', workday_end: '18:00' };
}

function dailyPlanAuthored(owner: string, date: string): boolean {
  return !!(sqlite.prepare(`SELECT 1 FROM daily_plan WHERE owner_id = ? AND date = ? LIMIT 1`).get(owner, date));
}

function getStagedTasks(owner: string): PlanTask[] {
  const rows = sqlite
    .prepare(
      `SELECT fp.task_id, t.title, t.estimated_minutes, t.priority, t.due_at
         FROM flight_plan fp JOIN tasks t ON t.id = fp.task_id
        WHERE fp.owner_id = ? AND fp.selected = 1
        ORDER BY fp.position, t.priority, fp.task_id`
    )
    .all(owner) as Omit<PlanTask, 'tags'>[];
  return rows.map((r) => ({ ...r, priority: r.priority ?? 3, tags: taskTagNames(r.task_id) }));
}

function persistOrder(
  owner: string,
  date: string,
  tasks: PlanTask[],
  indices: number[],
  source: 'llm' | 'deterministic',
): void {
  const ins = sqlite.prepare(
    `INSERT OR IGNORE INTO daily_plan (owner_id, date, task_id, position, rationale, source)
     VALUES (?, ?, ?, ?, NULL, ?)`,
  );
  sqlite.transaction(() => {
    for (let pos = 0; pos < indices.length; pos++) {
      ins.run(owner, date, tasks[indices[pos]].task_id, pos, source);
    }
  })();
}

// ─── Ordering helpers ────────────────────────────────────────────────────────

function deterministicIndices(tasks: PlanTask[]): number[] {
  return tasks
    .map((_, i) => i)
    .sort(
      (a, b) =>
        tasks[a].priority - tasks[b].priority ||
        (tasks[a].due_at ?? '9999').localeCompare(tasks[b].due_at ?? '9999') ||
        tasks[a].task_id.localeCompare(tasks[b].task_id),
    );
}

/**
 * Normalise a raw LLM index array into a valid permutation of [0..n-1].
 * Valid indices appear in the LLM's order; any it dropped are appended in
 * deterministic priority order so no task ever disappears.
 */
function safeOrder(raw: unknown, tasks: PlanTask[]): number[] {
  const n = tasks.length;
  if (!Array.isArray(raw)) return deterministicIndices(tasks);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const x of raw) {
    if (Number.isInteger(x) && x >= 0 && x < n && !seen.has(x)) {
      seen.add(x);
      out.push(x);
    }
  }
  for (const i of deterministicIndices(tasks)) if (!seen.has(i)) out.push(i);
  return out;
}

/** Workday capacity in minutes (wall-clock end − start). */
function workdayMinutes(start: string, end: string): number {
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  return Math.max(0, eh * 60 + em - (sh * 60 + sm));
}

function taskLine(t: PlanTask, i: number): string {
  const due = t.due_at ? ` (due ${t.due_at.slice(0, 10)})` : '';
  const est = t.estimated_minutes ?? 30;
  const tags = t.tags.length ? ' ' + t.tags.map((tg) => `#${tg}`).join(' ') : '';
  return `${i}: [P${t.priority}] ${t.title}${due} ~${est}m${tags}`;
}

function orderedTitles(indices: number[], tasks: PlanTask[]): string {
  return indices.map((i) => `"${tasks[i].title}"`).join(', ');
}

// ─── Deterministic rubric checks (the hard gate) ─────────────────────────────

function checkOrder(order: number[], tasks: PlanTask[], today: string): Defect[] {
  const defects: Defect[] = [];
  const todayMs = Date.parse(today + 'T00:00:00Z');

  for (let i = 0; i < order.length && defects.length < 5; i++) {
    const a = tasks[order[i]];
    const aPrio = a.priority;
    const aDue = a.due_at ? Date.parse(a.due_at) : Infinity;

    for (let j = i + 1; j < order.length && defects.length < 5; j++) {
      const b = tasks[order[j]];
      const bPrio = b.priority;
      const bDue = b.due_at ? Date.parse(b.due_at) : Infinity;

      // Priority inversion: b (later) has higher priority (lower number) than a (earlier),
      // and a does not have an earlier deadline to justify being placed first.
      if (bPrio < aPrio && aDue >= bDue) {
        defects.push({
          rule: 'priority_inversion',
          detail: `index ${order[j]} (P${bPrio} "${b.title}") should come before index ${order[i]} (P${aPrio} "${a.title}")`,
        });
      }

      // Past-due misordering: same priority; b is past-due but a is not → b should come first.
      if (aPrio === bPrio && bDue < todayMs && aDue >= todayMs) {
        defects.push({
          rule: 'past_due_misordered',
          detail: `index ${order[j]} ("${b.title}" is overdue) should come before index ${order[i]} ("${a.title}" is not yet due)`,
        });
      }
    }
  }
  return defects;
}

// ─── LLM prompt templates (§A0.1) ────────────────────────────────────────────

function genSystem(): string {
  return (
    'You are a day-planning assistant. You order a FIXED set of tasks for one day. ' +
    'You never invent, drop, merge, or reschedule tasks — you choose sequence only. Reply with JSON only.'
  );
}

function genPrompt(lines: string[], capacityMin: number): string {
  return (
    `Order today's tasks from first to last. Weigh, in this order:\n` +
    `1) hard deadlines (sooner due = earlier); 2) priority (P1 highest);\n` +
    `3) momentum — group related work, minimize context switches;\n` +
    `4) front-load demanding work while focus is fresh.\n` +
    `Capacity today: ~${capacityMin} focused minutes.\n\n` +
    `Tasks (index: [priority] title (due) ~estimate tags):\n${lines.join('\n')}\n\n` +
    `Reply with ONLY a JSON array containing every index exactly once, in your chosen order. Example: [3,0,1,2]`
  );
}

function judgeSystem(): string {
  return (
    'You are a strict planning reviewer. You did NOT create this plan. ' +
    'Score ONLY the qualities asked; be skeptical and reserve high scores for genuinely good ordering. Reply with JSON only.'
  );
}

function judgePrompt(lines: string[], order: number[], tasks: PlanTask[]): string {
  return (
    `Judge ONLY these subjective qualities (deadline/priority correctness are verified separately — ignore them):\n` +
    `- momentum: related work grouped, context switches minimized\n` +
    `- focus_fit: demanding / high-stakes work placed while focus is freshest\n` +
    `- coherence: reads like a sensible human day, not an arbitrary list\n\n` +
    `Tasks (index: [priority] title (due) ~estimate tags):\n${lines.join('\n')}\n\n` +
    `Proposed order (first → last): ${orderedTitles(order, tasks)}\n\n` +
    `Reply with ONLY:\n` +
    `{"momentum":0..1,"focus_fit":0..1,"coherence":0..1,"overall":0..1,"critique":"one sentence on the biggest weakness"}`
  );
}

function reviseSystem(): string {
  return (
    'You revise a task ordering to fix specific defects. Keep what works; change only what the ' +
    'feedback calls out. You never add or drop tasks. Reply with JSON only.'
  );
}

function revisePrompt(lines: string[], order: number[], defects: Defect[], critique: string): string {
  const mustFix = defects.map((d) => `- ${d.detail}`).join('\n') || '(none)';
  return (
    `The current order has problems. Produce a better order that fixes them.\n\n` +
    `Tasks (index: [priority] title (due) ~estimate tags):\n${lines.join('\n')}\n\n` +
    `Current order: [${order.join(', ')}]\n\n` +
    `Must-fix (mechanical violations):\n${mustFix}\n` +
    `Reviewer note: ${critique || '(none)'}\n\n` +
    `Reply with ONLY a JSON array containing every index exactly once, in the improved order.`
  );
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Author the day's task order into `daily_plan` for `(owner, date)`.
 *
 * - Runs the §A0 generate→evaluate→iterate loop when planning_mode='auto'
 *   and Ollama is up; otherwise writes a deterministic priority/deadline order.
 * - Author-once: a second call for the same (owner, date) is a no-op.
 * - Never throws: Ollama failures always fall back to the deterministic order.
 * - Does NOT place blocks. Placement reads `daily_plan.position` independently.
 */
export async function authorPlanOrder(owner: string, date: string): Promise<void> {
  if (dailyPlanAuthored(owner, date)) return;

  const prefs = loadPlanningPrefs(owner);
  const staged = getStagedTasks(owner);

  if (staged.length < 2) {
    if (staged.length === 1) persistOrder(owner, date, staged, [0], 'deterministic');
    return;
  }

  const aiEnabled = prefs.planning_mode === 'auto';
  if (!aiEnabled || !(await isAvailable())) {
    persistOrder(owner, date, staged, deterministicIndices(staged), 'deterministic');
    return;
  }

  const lines = staged.map(taskLine);
  const capacityMin = workdayMinutes(prefs.workday_start, prefs.workday_end);

  const result = await runLoop<number[]>(
    {
      stage: 'order',
      ownerId: owner,

      generate: async () => {
        const raw = await generateJson<unknown>(genPrompt(lines, capacityMin), {
          tier: 'small',
          system: genSystem(),
          temperature: 0.2,
          timeoutMs: 25_000,
        });
        return safeOrder(raw, staged);
      },

      check: (order) => checkOrder(order, staged, date),

      judge: async (order): Promise<JudgeScore> => {
        const raw = await generateJson<Record<string, unknown>>(judgePrompt(lines, order, staged), {
          tier: 'medium',
          system: judgeSystem(),
          temperature: 0.1,
          timeoutMs: 30_000,
        });
        return {
          overall: typeof raw.overall === 'number' ? raw.overall : 0,
          critique: typeof raw.critique === 'string' ? raw.critique : '',
          momentum: typeof raw.momentum === 'number' ? raw.momentum : undefined,
          focus_fit: typeof raw.focus_fit === 'number' ? raw.focus_fit : undefined,
          coherence: typeof raw.coherence === 'number' ? raw.coherence : undefined,
        };
      },

      revise: async (order, defects, critique) => {
        const raw = await generateJson<unknown>(revisePrompt(lines, order, defects, critique), {
          tier: 'small',
          system: reviseSystem(),
          temperature: 0.2,
          timeoutMs: 25_000,
        });
        return safeOrder(raw, staged);
      },

      baseline: () => deterministicIndices(staged),
    },
    {
      onEscape: (ownerId, stage, info) => {
        logger.warn('authorPlanOrder: loop stalled, falling back to deterministic order', {
          owner: ownerId,
          stage,
          score: info.score,
          iterations: info.iterations,
          reason: info.reason,
        });
      },
    },
  );

  persistOrder(owner, date, staged, result.candidate, result.passed ? 'llm' : 'deterministic');
}

// ─── Legacy (kept for runScheduler / plan.test.ts; do not add new callers) ───

/**
 * @deprecated Wired into the legacy runScheduler engine (not the user-driven
 * placeFlightPlan path). Use authorPlanOrder instead.  Kept so plan.test.ts
 * and any callers on the scheduler.ts path continue to compile without change.
 */
export async function orderForToday(ranked: Task[], prefs: Prefs): Promise<Task[]> {
  if (prefs.planningMode !== 'auto' || ranked.length < 2) return ranked;
  if (!(await isAvailable())) return ranked;

  try {
    const lines = ranked
      .map(
        (t, i) =>
          `${i}: [P${t.priority ?? 3}] ${t.title}` +
          `${t.dueAt ? ` (due ${t.dueAt.slice(0, 10)})` : ''} ~${t.estimatedMinutes ?? 30}m`,
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
    for (let i = 0; i < ranked.length; i++) if (!seen.has(i)) out.push(ranked[i]);
    return out.length === ranked.length ? out : ranked;
  } catch (err) {
    logger.warn('plan.orderForToday: falling back to deterministic order', { err: (err as Error).message });
    return ranked;
  }
}
