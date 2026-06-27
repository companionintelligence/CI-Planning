/**
 * Phase M §0 / A1 — AI-in-the-loop day-plan authoring.
 * §A2 — same-tag batching post-pass.
 * §C2 — day_theme bias.
 *
 * `authorPlanOrder` is the single entry point for day authoring. It:
 *  - Is called ONCE per (owner, date) — the author-once guard makes every
 *    subsequent call a no-op until the next day's first placement.
 *  - Runs the §A0 generate→evaluate→iterate loop (via `runLoop`) when
 *    planning_mode = 'smart' AND Ollama is reachable.
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
import { broadcast } from '../routes/sse.js';
import { writeAudit } from '../lib/audit.js';
import { serverTimezone, zonedWallTimeToUTC } from '../lib/tz.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type Task = InferSelectModel<typeof tasks>;
type Prefs = InferSelectModel<typeof schedulingPrefs>;

/** A staged task as seen by the authoring loop. Exported for tests. */
export interface PlanTask {
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
  /** §C2 — day-of-week → theme tag map. Null/undefined = no theming. */
  day_theme?: Record<string, string> | null;
  /**
   * Controls the deterministic authoring sort (and the no-daily_plan workday fill):
   *   'overdue'  → deadline-first (due_at → priority). The Phase-M default.
   *   'priority' → priority-first (priority → due_at). Legacy opt-in.
   */
  fill_order?: string;
}

// ─── DB helpers ─────────────────────────────────────────────────────────────

function loadPlanningPrefs(owner: string): PlanningPrefs {
  const row = sqlite
    .prepare(`SELECT planning_mode, workday_start, workday_end, day_theme, fill_order FROM scheduling_prefs WHERE owner_id = ?`)
    .get(owner) as (PlanningPrefs & { day_theme: string | null; fill_order: string | null }) | undefined;
  if (!row) return { planning_mode: 'basic', workday_start: '09:00', workday_end: '18:00', fill_order: 'overdue' };
  let day_theme: Record<string, string> | null = null;
  if (row.day_theme) {
    try { day_theme = JSON.parse(row.day_theme) as Record<string, string>; } catch { /* ignore malformed */ }
  }
  return {
    planning_mode: row.planning_mode,
    workday_start: row.workday_start,
    workday_end: row.workday_end,
    day_theme,
    fill_order: row.fill_order ?? 'overdue',
  };
}

function dailyPlanAuthored(owner: string, date: string): boolean {
  return !!(sqlite.prepare(`SELECT 1 FROM daily_plan WHERE owner_id = ? AND date = ? LIMIT 1`).get(owner, date));
}

/** §A4 — the day's persisted NL hints (from `/api/plan/instruct`). Empty when none. */
export function loadPlanHints(owner: string, date: string): PlanHint[] {
  const rows = sqlite
    .prepare(`SELECT kind, tag, time FROM plan_hints WHERE owner_id = ? AND date = ?`)
    .all(owner, date) as { kind: string; tag: string; time: string | null }[];
  return rows.map((r) => ({ kind: r.kind as PlanHint['kind'], tag: r.tag, time: r.time ?? undefined }));
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
  rationales?: Map<string, string>,
): void {
  const ins = sqlite.prepare(
    `INSERT OR IGNORE INTO daily_plan (owner_id, date, task_id, position, rationale, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  sqlite.transaction(() => {
    for (let pos = 0; pos < indices.length; pos++) {
      const taskId = tasks[indices[pos]].task_id;
      ins.run(owner, date, taskId, pos, rationales?.get(taskId) ?? null, source);
    }
  })();
}

// ─── §C2 — day_theme helpers ─────────────────────────────────────────────────

/**
 * §C2 — Return the theme tag for a given YYYY-MM-DD date, or null if none.
 * Weekday is derived under UTC noon to avoid midnight boundary ambiguity.
 * Keys are short weekday names: mon/tue/wed/thu/fri/sat/sun.
 */
export function todayThemeTag(dayTheme: Record<string, string> | null | undefined, date: string): string | null {
  if (!dayTheme) return null;
  const weekday = new Date(date + 'T12:00:00Z')
    .toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })
    .toLowerCase()
    .slice(0, 3);
  return dayTheme[weekday] ?? null;
}

// ─── Ordering helpers ────────────────────────────────────────────────────────

/**
 * Produce a deterministic ordering of tasks as indices.
 *
 * §C2 theme is the **primary** key: on a themed weekday, theme-tagged tasks lead
 * the day outright ("today is deep-work day"), ahead of deadline and priority.
 * After theme, `fillOrder` selects the deadline/priority ordering *within* each
 * theme band (maps the user-facing `fill_order` pref onto authoring):
 *   • 'overdue' (default) → theme → due_at → priority → id
 *   • 'priority'          → theme → priority → due_at → id
 *
 * `checkOrder` is theme-aware so this lead is not flagged as a priority/deadline
 * inversion (a themed task may legitimately precede a higher-priority or
 * earlier-due unthemed one).
 */
export function deterministicIndices(
  tasks: PlanTask[],
  themeTag?: string | null,
  fillOrder?: string,
): number[] {
  const priorityFirst = fillOrder === 'priority';
  const themeCmp = (a: number, b: number): number => {
    if (!themeTag) return 0;
    const themA = tasks[a].tags.includes(themeTag) ? 0 : 1;
    const themB = tasks[b].tags.includes(themeTag) ? 0 : 1;
    return themA - themB;
  };
  const dueCmp = (a: number, b: number): number =>
    (tasks[a].due_at ?? '9999').localeCompare(tasks[b].due_at ?? '9999');
  const priCmp = (a: number, b: number): number => tasks[a].priority - tasks[b].priority;

  return tasks
    .map((_, i) => i)
    .sort((a, b) => {
      const theme = themeCmp(a, b);
      if (theme !== 0) return theme;
      const primary = priorityFirst ? priCmp(a, b) : dueCmp(a, b);
      if (primary !== 0) return primary;
      const secondary = priorityFirst ? dueCmp(a, b) : priCmp(a, b);
      if (secondary !== 0) return secondary;
      return tasks[a].task_id.localeCompare(tasks[b].task_id);
    });
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

// ─── §A2 — Tag-group post-pass ───────────────────────────────────────────────

/**
 * §A2 — Cluster tasks sharing their primary tag contiguously (stable group-by).
 *
 * Algorithm:
 *   1. Assign each task a "group key" = its first tag (or '' for untagged).
 *   2. Walk the current order to find the first position each group appears.
 *   3. Sort indices by (group's first position, position within group).
 *
 * This is a pure deterministic transform that never skips or duplicates indices.
 * Falls back to the original order if the result fails checkOrder.
 */
export function tagGroupPostPass(indices: number[], tasks: PlanTask[]): number[] {
  if (indices.length < 2) return indices;

  const groupKey = (idx: number): string => tasks[idx].tags[0] ?? '';

  // Determine the first-seen position for each group
  const groupFirstPos = new Map<string, number>();
  for (let pos = 0; pos < indices.length; pos++) {
    const key = groupKey(indices[pos]);
    if (!groupFirstPos.has(key)) groupFirstPos.set(key, pos);
  }

  // Assign each task its ordinal within its group (for stable sort)
  const groupMemberIdx = new Map<number, number>();
  const groupCounts = new Map<string, number>();
  for (const idx of indices) {
    const key = groupKey(idx);
    const cnt = groupCounts.get(key) ?? 0;
    groupMemberIdx.set(idx, cnt);
    groupCounts.set(key, cnt + 1);
  }

  return [...indices].sort((a, b) => {
    const gfA = groupFirstPos.get(groupKey(a))!;
    const gfB = groupFirstPos.get(groupKey(b))!;
    if (gfA !== gfB) return gfA - gfB;
    return (groupMemberIdx.get(a) ?? 0) - (groupMemberIdx.get(b) ?? 0);
  });
}

// ─── Deterministic rubric checks (the hard gate) ─────────────────────────────

export function checkOrder(order: number[], tasks: PlanTask[], today: string, themeTag?: string | null): Defect[] {
  const defects: Defect[] = [];
  const todayMs = Date.parse(today + 'T00:00:00Z');
  const themed = (t: PlanTask): boolean => (themeTag ? t.tags.includes(themeTag) : false);

  for (let i = 0; i < order.length && defects.length < 5; i++) {
    const a = tasks[order[i]];
    const aPrio = a.priority;
    const aDue = a.due_at ? Date.parse(a.due_at) : Infinity;
    const aThemed = themed(a);

    for (let j = i + 1; j < order.length && defects.length < 5; j++) {
      const b = tasks[order[j]];
      const bPrio = b.priority;
      const bDue = b.due_at ? Date.parse(b.due_at) : Infinity;

      // §C2: a themed task (earlier) legitimately leads an unthemed one (later) on a
      // themed day — theme is the primary key, so this is not a priority/deadline inversion.
      if (aThemed && !themed(b)) continue;

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

/**
 * §A4 — render the day's hints into one soft constraint line for the generator
 * prompt (PROMPT 1). Empty string when there are no hints. The HARD enforcement of
 * before/after windows is deterministic, in placement (autoplan transient windows);
 * this line only nudges the LLM to order coherently within those windows.
 */
export function constraintLine(hints: PlanHint[]): string {
  if (hints.length === 0) return '';
  const parts = hints.map((h) => {
    if (h.kind === 'tag_before') return `schedule #${h.tag} tasks before ${h.time}`;
    if (h.kind === 'tag_after') return `schedule #${h.tag} tasks after ${h.time}`;
    return `keep #${h.tag} tasks batched together`;
  });
  return `\nConstraints (honor strictly): ${parts.join('; ')}.`;
}

/**
 * Build the generator prompt.
 * §C2: when themeTag is provided, append a theme line after the capacity line.
 * §A4: when `constraint` is non-empty, append the NL-hint constraint line.
 */
export function genPrompt(lines: string[], capacityMin: number, themeTag?: string | null, constraint = ''): string {
  const themeLine = themeTag
    ? `\nToday's theme: ${themeTag} — favour ${themeTag}-tagged tasks earlier.`
    : '';
  return (
    `Order today's tasks from first to last. Weigh, in this order:\n` +
    `1) hard deadlines (sooner due = earlier); 2) priority (P1 highest);\n` +
    `3) momentum — group related work, minimize context switches;\n` +
    `4) front-load demanding work while focus is fresh.\n` +
    `Capacity today: ~${capacityMin} focused minutes.${themeLine}${constraint}\n\n` +
    `Tasks (index: [priority] title (due) ~estimate tags):\n${lines.join('\n')}\n\n` +
    `Reply with ONLY a JSON array containing every index exactly once, in your chosen order. Example: [3,0,1,2]`
  );
}

// ─── §A3 — per-task "why now" rationale (LLM path only) ──────────────────────

function rationaleSystem(): string {
  return (
    'You explain a finished day plan. For each task give ONE short reason (≤120 chars) it sits where it does — ' +
    'cite its deadline, priority, theme, or grouping. Invent nothing; if unsure, state the priority. Reply with JSON only.'
  );
}

function rationalePrompt(lines: string[], themeTag?: string | null): string {
  const theme = themeTag ? `\nToday's theme: ${themeTag}.` : '';
  return (
    `Tasks in their planned order (number: [priority] title (due) ~estimate tags):\n${lines.join('\n')}${theme}\n\n` +
    `Return ONLY a JSON object mapping each task number to a concise one-line reason. Example: {"0":"Due today — most urgent","1":"High priority, batched with #email"}`
  );
}

/** Sanitize one rationale: single line, trimmed, ≤140 chars, or null if unusable. */
function sanitizeRationale(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const oneLine = v.replace(/\s+/g, ' ').trim();
  if (!oneLine) return null;
  return oneLine.length > 140 ? `${oneLine.slice(0, 139)}…` : oneLine;
}

/**
 * §A3 — generate one "why now" line per task for an LLM-authored order. ONE batch
 * call (small tier), keyed by the task's position. Best-effort: any failure (Ollama
 * down, bad JSON) yields an empty map → those tasks keep a null rationale, so the UI
 * degrades silently. Never throws.
 */
async function generateRationales(tasks: PlanTask[], order: number[], themeTag?: string | null): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  try {
    const lines = order.map((idx, pos) => `${pos}: ${taskLine(tasks[idx], idx).replace(/^\d+:\s*/, '')}`);
    const raw = await generateJson<Record<string, unknown>>(rationalePrompt(lines, themeTag), {
      tier: 'small',
      system: rationaleSystem(),
      temperature: 0.3,
      timeoutMs: 25_000,
    });
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (let pos = 0; pos < order.length; pos++) {
        const r = sanitizeRationale((raw as Record<string, unknown>)[String(pos)]);
        if (r) out.set(tasks[order[pos]].task_id, r);
      }
    }
  } catch {
    // best-effort — a missing rationale just renders nothing on the block.
  }
  return out;
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
 * - Runs the §A0 generate→evaluate→iterate loop when planning_mode='smart'
 *   and Ollama is up; otherwise writes a deterministic priority/deadline order.
 * - §A2: applies tagGroupPostPass after obtaining the candidate order (LLM or
 *   deterministic). Falls back to pre-post-pass order if checkOrder detects defects.
 * - §C2: reads day_theme from prefs and injects a theme bias into deterministic
 *   ordering and into the LLM prompt.
 * - Author-once: a second call for the same (owner, date) is a no-op.
 * - Never throws: Ollama failures always fall back to the deterministic order.
 * - Does NOT place blocks. Placement reads `daily_plan.position` independently.
 */
export async function authorPlanOrder(owner: string, date: string, opts: { force?: boolean; deterministic?: boolean } = {}): Promise<void> {
  // B4 accept (`force`): drop the prior authored order so the author-once guard
  // re-opens and the day is freshly re-authored (LLM if smart+Ollama up, else
  // deterministic). The only reactive path that re-runs authoring, behind explicit
  // user accept — reflow itself never calls this.
  // `deterministic`: force the deterministic sort even in smart mode — used by the
  // Schedule-mode N-day horizon (T-SCHED-2) for future days so a multi-day plan
  // doesn't fire one LLM call per day (day 0 still authors normally).
  if (opts.force) sqlite.prepare(`DELETE FROM daily_plan WHERE owner_id = ? AND date = ?`).run(owner, date);
  if (dailyPlanAuthored(owner, date)) return;

  const prefs = loadPlanningPrefs(owner);
  const staged = getStagedTasks(owner);

  if (staged.length < 2) {
    if (staged.length === 1) persistOrder(owner, date, staged, [0], 'deterministic');
    return;
  }

  // §C2: resolve today's theme tag (null = no theming today)
  const themeTag = todayThemeTag(prefs.day_theme, date);
  // fill_order maps onto the deterministic authoring sort (default deadline-first).
  const fillOrder = prefs.fill_order ?? 'overdue';

  // Deterministic authoring — basic mode, AI off, Ollama unreachable at the pre-flight
  // check, OR (via the catch below) an LLM call that fails MID-loop. Centralised here so
  // the "never throws / always lands a valid order" invariant holds for every caller.
  const persistDeterministic = () => {
    const detIndices = deterministicIndices(staged, themeTag, fillOrder);
    const postPassed = tagGroupPostPass(detIndices, staged);
    const defects = checkOrder(postPassed, staged, date, themeTag);
    const final = defects.length === 0 ? postPassed : detIndices;
    persistOrder(owner, date, staged, final, 'deterministic');
  };

  const aiEnabled = !opts.deterministic && prefs.planning_mode === 'smart';
  if (!aiEnabled || !(await isAvailable())) {
    persistDeterministic();
    return;
  }

  const lines = staged.map(taskLine);
  const capacityMin = workdayMinutes(prefs.workday_start, prefs.workday_end);
  // §A4: fold any persisted NL hints into a soft constraint line for the generator.
  const constraint = constraintLine(loadPlanHints(owner, date));

  // B4 invariant (docs/M-ai-scheduler.md:270,303): an LLM failure MID-loop — Ollama dies
  // AFTER the pre-flight isAvailable() check (timeout, OOM, dropped connection) — must
  // degrade to the deterministic order, never throw. `runLoop` re-throws a genuine
  // generator/judge error (loop.ts) and `generateRationales` also calls the model, so the
  // whole LLM tail is guarded. (The sibling A4 parseInstruction already wraps its call;
  // authoring was the omission this restores.)
  try {
    const result = await runLoop<number[]>(
      {
        stage: 'order',
        ownerId: owner,

        generate: async () => {
          // §C2: pass theme tag to prompt; §A4: pass the NL-hint constraint line
          const raw = await generateJson<unknown>(genPrompt(lines, capacityMin, themeTag, constraint), {
            tier: 'small',
            system: genSystem(),
            temperature: 0.2,
            timeoutMs: 25_000,
          });
          return safeOrder(raw, staged);
        },

        check: (order) => {
          // §A2: apply post-pass before checking
          const postPassed = tagGroupPostPass(order, staged);
          return checkOrder(postPassed, staged, date, themeTag);
        },

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

        baseline: () => deterministicIndices(staged, themeTag, fillOrder),
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

    // §A2: apply post-pass to the final LLM result
    const finalCandidate = tagGroupPostPass(result.candidate, staged);
    const finalDefects = checkOrder(finalCandidate, staged, date, themeTag);
    const finalIndices = finalDefects.length === 0 ? finalCandidate : result.candidate;

    // §A3: only an LLM-authored order carries per-task rationales; an escape-hatch
    // fallback (source='deterministic') leaves them null, like the basic-mode path.
    const source = result.passed ? 'llm' : 'deterministic';
    const rationales = source === 'llm' ? await generateRationales(staged, finalIndices, themeTag) : undefined;
    persistOrder(owner, date, staged, finalIndices, source, rationales);

    // §A0 clause 6 (docs/M-ai-scheduler.md:71,76): a STALLED loop must not silently revert.
    // The day still lands a valid deterministic order (above), AND we raise a "plan needs
    // review" signal — a persisted audit row + a live SSE event — so the escalation is
    // visible, not just a server log. (Client surfacing of plan:needs_review is a follow-up;
    // the audit row is the §A0 inspectability sink and is queryable today.)
    if (result.escaped) signalPlanNeedsReview(owner, date, result.score);
  } catch (err) {
    logger.warn('authorPlanOrder: LLM authoring failed mid-call, falling back to deterministic order', {
      owner,
      date,
      err: String(err),
    });
    persistDeterministic();
  }
}

/** §A0/B4 — raise a visible "plan needs review" signal when the authoring loop stalls. */
function signalPlanNeedsReview(owner: string, date: string, score: number): void {
  writeAudit({ ownerId: owner, actor: 'system', action: 'plan_needs_review', entity: `plan:${date}` });
  broadcast(owner, 'plan:needs_review', { date, score });
}

// ─── §A4 — NL planning constraints (pins-first MVP) ──────────────────────────
//
// `POST /api/plan/instruct` → parse free text into a TYPED, validated constraint
// set the deterministic placer consumes. The rubric is pure schema validation (no
// LLM judge): malformed/unknown/contradictory ⇒ `invalid` (the route returns 422,
// never a partial apply); Ollama down ⇒ `unavailable` (503). Time PINS are applied
// as locked obstacle blocks; tag/ordering HINTS are parsed + returned but not yet
// wired into placement (deferred — see the doc's A4 "as-built").

export interface PlanPin { title: string; start_at: string; end_at: string }
export interface PlanHint { kind: 'tag_before' | 'tag_after' | 'batch'; tag: string; time?: string }
export interface InstructResult { pins: PlanPin[]; hints: PlanHint[] }

export class InstructError extends Error {
  constructor(public code: 'unavailable' | 'invalid', message: string) {
    super(message);
    this.name = 'InstructError';
  }
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const HINT_KINDS = new Set(['tag_before', 'tag_after', 'batch']);

function ownerTimezone(owner: string): string {
  const row = sqlite.prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get(owner) as { timezone: string | null } | undefined;
  return row?.timezone || serverTimezone();
}
function allTagNames(): Set<string> {
  return new Set((sqlite.prepare(`SELECT name FROM tags`).all() as { name: string }[]).map((r) => r.name));
}

function instructSystem(): string {
  return (
    'You convert ONE scheduling instruction into structured JSON for a deterministic planner. ' +
    'Output ONLY {"pins":[{"title","start","end"}],"hints":[{"kind","tag","time"}]}. ' +
    'A pin is a fixed appointment; start/end are "HH:MM" (24h). A hint constrains tasks by tag: ' +
    'kind is "tag_before" or "tag_after" (with "time" "HH:MM"), or "batch" (no time). ' +
    'Use ONLY tags from the provided list. Invent nothing; omit anything uncertain. Reply with JSON only.'
  );
}
function instructPrompt(text: string, date: string, ws: string, we: string, tags: string[]): string {
  return (
    `Date: ${date}. Workday: ${ws}–${we}. Available tags: ${tags.length ? tags.join(', ') : '(none)'}.\n` +
    `Instruction: "${text}"\n\nReturn ONLY the JSON object.`
  );
}

/** Validate the raw LLM output into a typed InstructResult (pins converted to UTC ISO). Throws InstructError('invalid'). */
export function validateInstruction(raw: unknown, date: string, tz: string, tagSet: Set<string>): InstructResult {
  if (!raw || typeof raw !== 'object') throw new InstructError('invalid', 'Could not understand the instruction');
  const r = raw as { pins?: unknown; hints?: unknown };
  const pinsRaw = Array.isArray(r.pins) ? r.pins : [];
  const hintsRaw = Array.isArray(r.hints) ? r.hints : [];

  const pins: PlanPin[] = [];
  for (const p of pinsRaw) {
    const o = (p ?? {}) as { title?: unknown; start?: unknown; end?: unknown };
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const start = typeof o.start === 'string' ? o.start : '';
    const end = typeof o.end === 'string' ? o.end : '';
    if (!title) throw new InstructError('invalid', 'A pinned appointment is missing a title');
    if (!HHMM.test(start) || !HHMM.test(end)) throw new InstructError('invalid', `"${title}" has an invalid time`);
    if (start >= end) throw new InstructError('invalid', `"${title}" ends before it starts`);
    pins.push({ title, start_at: zonedWallTimeToUTC(date, start, tz), end_at: zonedWallTimeToUTC(date, end, tz) });
  }
  // "No contradictory pins": no two pinned appointments may overlap.
  const sorted = [...pins].sort((a, b) => a.start_at.localeCompare(b.start_at));
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].start_at < sorted[i - 1].end_at) throw new InstructError('invalid', 'Two pinned appointments overlap');
  }

  const hints: PlanHint[] = [];
  for (const h of hintsRaw) {
    const o = (h ?? {}) as { kind?: unknown; tag?: unknown; time?: unknown };
    const kind = typeof o.kind === 'string' ? o.kind : '';
    const tag = typeof o.tag === 'string' ? o.tag : '';
    if (!HINT_KINDS.has(kind)) throw new InstructError('invalid', `Unknown hint kind "${kind}"`);
    if (!tagSet.has(tag)) throw new InstructError('invalid', `Unknown tag "#${tag}"`);
    let time: string | undefined;
    if (kind === 'tag_before' || kind === 'tag_after') {
      time = typeof o.time === 'string' ? o.time : '';
      if (!HHMM.test(time)) throw new InstructError('invalid', `The hint for #${tag} needs a valid time`);
    }
    hints.push({ kind: kind as PlanHint['kind'], tag, time });
  }

  if (pins.length === 0 && hints.length === 0) throw new InstructError('invalid', 'No actionable constraints found');
  return { pins, hints };
}

/**
 * §A4 — parse a natural-language instruction into a validated constraint set.
 * Ollama-down ⇒ InstructError('unavailable'); malformed/unknown/contradictory ⇒
 * InstructError('invalid'). Performs NO writes — the caller applies pins only after
 * a clean parse, so there are never partial writes.
 */
export async function parseInstruction(owner: string, date: string, text: string): Promise<InstructResult> {
  if (!(await isAvailable())) throw new InstructError('unavailable', 'AI is unavailable');
  const prefs = loadPlanningPrefs(owner);
  const tz = ownerTimezone(owner);
  const tagSet = allTagNames();
  let raw: unknown;
  try {
    raw = await generateJson(instructPrompt(text, date, prefs.workday_start, prefs.workday_end, [...tagSet]), {
      tier: 'small',
      system: instructSystem(),
      temperature: 0.1,
      timeoutMs: 25_000,
    });
  } catch {
    throw new InstructError('unavailable', 'AI request failed');
  }
  return validateInstruction(raw, date, tz, tagSet);
}

// ─── Legacy (kept for runScheduler / plan.test.ts; do not add new callers) ───

/**
 * @deprecated Wired into the legacy runScheduler engine (not the user-driven
 * placeFlightPlan path). Use authorPlanOrder instead.  Kept so plan.test.ts
 * and any callers on the scheduler.ts path continue to compile without change.
 */
export async function orderForToday(ranked: Task[], prefs: Prefs): Promise<Task[]> {
  if (prefs.planningMode !== 'smart' || ranked.length < 2) return ranked;
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
