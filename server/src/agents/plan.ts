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
import { store } from '../db/store.js';
import { generateJson, isReady, llmOrNull } from '../mcp/ollama.js';
import { entityTagLevels } from '../services/tags.js';
import { runLoop, type Defect, type JudgeScore } from './loop.js';
import { logger } from '../lib/logger.js';
import { broadcast } from '../routes/sse.js';
import { writeAudit } from '../lib/audit.js';
import { serverTimezone, zonedWallTimeToUTC, utcDayBounds, localDateInTZ, todayInTZ } from '../lib/tz.js';
import { graphData, MemoryUnavailable, type MemoryGraph } from '../connectors/memory.js';
import { memoryConnectorAvailable } from '../services/memory.js';

// ─── Types ──────────────────────────────────────────────────────────────────

/** A staged task as seen by the authoring loop. Exported for tests.
 *
 * AF-11 (D1): `tags` is the MATCH set — level 1 ∪ level 2 — so theme matching,
 * memory relatedness, and the LLM prompt's #tag rendering keep seeing intention
 * tags after 0121 moved them to level 2 (this is exactly the pre-split flat set).
 * `primary_tags` is the level-1-only list (the direction) for `tags[0]`-style
 * PRIMARY reads (clustering) — optional so test literals that only set `tags`
 * keep working. It is set ONLY when level 1 is non-empty: absent (direction-less
 * task / pre-split literal), primary reads fall back to `tags`, so clustering
 * still keys on the first intention rather than collapsing into one '' group. */
export interface PlanTask {
  task_id: string;
  title: string;
  priority: number;
  due_at: string | null;
  estimated_minutes: number | null;
  /** UTC ISO — read only to build the `fill_order='new_today'` band. */
  created_at?: string | null;
  tags: string[];
  primary_tags?: string[];
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

async function loadPlanningPrefs(owner: string): Promise<PlanningPrefs> {
  const row = await store()
    .prepare(`SELECT planning_mode, trust_mode, workday_start, workday_end, day_theme, fill_order FROM scheduling_prefs WHERE owner_id = ?`)
    .get<PlanningPrefs & { trust_mode: string | null; day_theme: string | null; fill_order: string | null }>(owner);
  if (!row) return { planning_mode: 'basic', workday_start: '09:00', workday_end: '18:00', fill_order: 'overdue' };
  let day_theme: Record<string, string> | null = null;
  if (row.day_theme) {
    try { day_theme = JSON.parse(row.day_theme) as Record<string, string>; } catch { /* ignore malformed */ }
  }
  // Hands-off trust dial implies smart planning: the user has opted into full AI autonomy.
  const planning_mode = row.trust_mode === 'hands_off' ? 'smart' : row.planning_mode;
  return {
    planning_mode,
    workday_start: row.workday_start,
    workday_end: row.workday_end,
    day_theme,
    fill_order: row.fill_order ?? 'overdue',
  };
}

async function dailyPlanAuthored(owner: string, date: string): Promise<boolean> {
  return !!(await store().prepare(`SELECT 1 FROM daily_plan WHERE owner_id = ? AND date = ? LIMIT 1`).get(owner, date));
}

/** §A4 — the day's persisted NL hints (from `/api/plan/instruct`). Empty when none. */
export async function loadPlanHints(owner: string, date: string): Promise<PlanHint[]> {
  const rows = await store()
    .prepare(`SELECT kind, tag, time FROM plan_hints WHERE owner_id = ? AND date = ?`)
    .all<{ kind: string; tag: string; time: string | null }>(owner, date);
  return rows.map((r) => ({ kind: r.kind as PlanHint['kind'], tag: r.tag, time: r.time ?? undefined }));
}

// ─── AA3a — memory-aware ordering (see docs/AA3-smarter-autoplan.md) ─────────────
//
// Rank tasks that RELATE to today's memory context (the people/events on the owner's
// CI-Server graph for the authoring day) earlier — applied to BOTH the deterministic
// sort and the smart prompt, so it works with AI off. Gated by memory_pull_enabled +
// connector availability; flag-off / MemoryUnavailable / no terms ⇒ empty set ⇒ every
// downstream branch is inert and the authored order is byte-identical to today.

interface MemoryTerms { tokens: Set<string>; phrases: string[]; tags: Set<string> }

/** Significant lowercased tokens (len ≥ 4) of a name — SHORT words are dropped so
 *  relatedness stays conservative (a noisy matcher reordering the whole day is worse).
 *  Unicode-aware split (`\p{L}\p{N}`, u-flag): diacritic / non-Latin names tokenize on
 *  real word boundaries instead of shattering into empty ASCII fragments. */
function nameTokens(name: string): string[] {
  return name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4);
}

/** Terms drawn from a memory graph: person/event name tokens, full event-name phrases,
 *  and event tags. Person nodes are undated (a day-window graphData still returns them),
 *  so person-token relatedness is date-stable; event terms are the day-specific signal. */
export function memoryTerms(graph: MemoryGraph): MemoryTerms {
  const tokens = new Set<string>();
  const phrases: string[] = [];
  const tags = new Set<string>();
  for (const n of graph.nodes) {
    const type = n.entityType.toLowerCase();
    if (type !== 'person' && type !== 'event') continue;
    for (const t of nameTokens(n.name)) tokens.add(t);
    if (type === 'event') {
      const phrase = n.name.toLowerCase().trim();
      if (phrase) phrases.push(phrase);
      const tag = n.properties.tag;
      if (typeof tag === 'string' && tag.trim()) tags.add(tag.toLowerCase());
    }
  }
  return { tokens, phrases, tags };
}

/** The staged tasks that relate to the memory terms (pure). A task relates iff a tag
 *  equals a term, its title shares a significant token, or its title contains a full
 *  event-name phrase. Empty terms ⇒ empty set (the identical-when-unavailable invariant). */
export function memoryRelatedTasks(tasks: PlanTask[], terms: MemoryTerms): Set<string> {
  const related = new Set<string>();
  if (terms.tokens.size === 0 && terms.phrases.length === 0 && terms.tags.size === 0) return related;
  for (const t of tasks) {
    const title = t.title.toLowerCase();
    const tagSet = t.tags.map((x) => x.toLowerCase());
    const titleTokens = nameTokens(t.title);
    const hit =
      tagSet.some((tg) => terms.tags.has(tg) || terms.tokens.has(tg)) ||
      titleTokens.some((w) => terms.tokens.has(w)) ||
      terms.phrases.some((p) => title.includes(p));
    if (hit) related.add(t.task_id);
  }
  return related;
}

/**
 * The staged tasks created on the owner's local today — the same set the Tasks tab shows
 * as "New Today" (pure). Only consulted for `fill_order='new_today'`; every other value
 * passes an empty set, which makes the band inert.
 *
 * `created_at` is converted to the OWNER's local day rather than compared as raw UTC, so
 * a task created late in the evening stays in its own day for owners east/west of UTC —
 * the same rule the client's partition uses. Returns an empty set when nothing qualifies.
 */
export function newTodayTasks(tasks: PlanTask[], tz: string, todayISO: string): Set<string> {
  const fresh = new Set<string>();
  for (const t of tasks) {
    if (t.created_at && localDateInTZ(t.created_at, tz) === todayISO) fresh.add(t.task_id);
  }
  return fresh;
}

async function memoryPullEnabled(owner: string): Promise<boolean> {
  const row = await store()
    .prepare(`SELECT memory_pull_enabled FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ memory_pull_enabled?: number }>(owner);
  return !!row?.memory_pull_enabled;
}

/**
 * Build the memory-related task set for `date`'s owner-local day. Empty when the flag is
 * off, the connector is unavailable, or the graph yields no terms. `deps.graphData` is
 * injectable for tests (defaults to the real connector). NEVER throws — a MemoryUnavailable
 * (or any) failure degrades to an empty set, so authoring is unaffected.
 */
export async function loadMemoryRelated(
  owner: string,
  date: string,
  tasks: PlanTask[],
  deps: { graphData: typeof graphData } = { graphData },
): Promise<Set<string>> {
  if (!(await memoryPullEnabled(owner)) || !(await memoryConnectorAvailable(owner))) return new Set();
  const { start, end } = utcDayBounds(date, await ownerTimezone(owner));
  try {
    const graph = await deps.graphData(owner, { from: start, to: end });
    return memoryRelatedTasks(tasks, memoryTerms(graph));
  } catch (err) {
    if (!(err instanceof MemoryUnavailable)) {
      logger.warn('authorPlanOrder: memory relatedness fetch failed — ignoring', { owner, err: (err as Error).message });
    }
    return new Set();
  }
}

/** The smart-prompt memory line: names the related task indices so the model doesn't
 *  re-derive relatedness. Gives memory the SAME priority as the deterministic `memoryCmp`
 *  band — ahead of the prompt's deadline/priority weighing, below only theme — so smart
 *  and deterministic don't diverge (a "tiebreaker" phrasing would fight the band and churn
 *  the revise loop). Empty when nothing is related (prompt stays byte-identical). */
function memoryOrderLine(tasks: PlanTask[], related: Set<string>): string {
  if (related.size === 0) return '';
  const idxs = tasks.map((t, i) => (related.has(t.task_id) ? i : -1)).filter((i) => i >= 0);
  if (idxs.length === 0) return '';
  return `\nToday's memory context: tasks at indices ${idxs.join(', ')} relate to today's commitments — order them earliest (after any theme), ahead of the deadline and priority weighing above.`;
}

async function getStagedTasks(owner: string): Promise<PlanTask[]> {
  const rows = await store()
    .prepare(
      `SELECT fp.task_id, t.title, t.estimated_minutes, t.priority, t.due_at, t.created_at
         FROM flight_plan fp JOIN tasks t ON t.id = fp.task_id
        WHERE fp.owner_id = ? AND fp.selected = 1
        ORDER BY fp.position, t.priority, fp.task_id`
    )
    .all<Omit<PlanTask, 'tags'>>(owner);
  // AF-11: tags = L1 ∪ L2 (entityTagLevels orders level-then-name, so L1 leads);
  // primary_tags = L1 only. See the PlanTask doc for which consumers read which.
  return await Promise.all(rows.map(async (r) => {
    const levels = await entityTagLevels('task', r.task_id);
    const primary = levels.filter((t) => t.level === 1).map((t) => t.name);
    return {
      ...r,
      priority: r.priority ?? 3,
      tags: levels.map((t) => t.name),
      // OMITTED (not []) when the task has no level-1 tag: tagGroupPostPass reads
      // `(primary_tags ?? tags)[0]`, and only an ABSENT field reaches the `tags`
      // fallback — so a direction-less task clusters by its first intention (the
      // pre-split behavior). An empty array would defeat the ?? and lump every
      // direction-less task into one '' group.
      ...(primary.length ? { primary_tags: primary } : {}),
    };
  }));
}

function persistOrder(
  owner: string,
  date: string,
  tasks: PlanTask[],
  indices: number[],
  source: 'llm' | 'deterministic',
  rationales?: Map<string, string>,
): Promise<void> {
  const ins = store().prepare(
    `INSERT OR IGNORE INTO daily_plan (owner_id, date, task_id, position, rationale, source)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  return store().transaction(async () => {
    for (let pos = 0; pos < indices.length; pos++) {
      const taskId = tasks[indices[pos]].task_id;
      await ins.run(owner, date, taskId, pos, rationales?.get(taskId) ?? null, source);
    }
  });
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
 *   • 'new_today'         → theme → created-today → due_at → priority → id
 *
 * 'new_today' adds a band rather than replacing the sort: today's arrivals lead, and
 * BOTH halves stay deadline-first inside. Authoring has to honor it for the same reason
 * the other two values do — placement skips its own fill_order branch whenever a
 * daily_plan exists for the day, so a value authoring ignored would be silently inert on
 * exactly the days the owner planned deliberately.
 *
 * `checkOrder` is theme-aware so this lead is not flagged as a priority/deadline
 * inversion (a themed task may legitimately precede a higher-priority or
 * earlier-due unthemed one).
 */
export function deterministicIndices(
  tasks: PlanTask[],
  themeTag?: string | null,
  fillOrder?: string,
  memoryRelated?: Set<string>,
  newToday?: Set<string>,
): number[] {
  const priorityFirst = fillOrder === 'priority';
  const themeCmp = (a: number, b: number): number => {
    if (!themeTag) return 0;
    const themA = tasks[a].tags.includes(themeTag) ? 0 : 1;
    const themB = tasks[b].tags.includes(themeTag) ? 0 : 1;
    return themA - themB;
  };
  // AA3a: memory-related tasks lead within their theme band (after theme, before
  // deadline/priority). Inert when the set is absent/empty — byte-identical order.
  const memCmp = (a: number, b: number): number => {
    if (!memoryRelated || memoryRelated.size === 0) return 0;
    const relA = memoryRelated.has(tasks[a].task_id) ? 0 : 1;
    const relB = memoryRelated.has(tasks[b].task_id) ? 0 : 1;
    return relA - relB;
  };
  // fill_order='new_today': today's arrivals lead within their theme band. Inert when
  // the set is absent/empty, so the other two fill orders keep a byte-identical order.
  const newCmp = (a: number, b: number): number => {
    if (!newToday || newToday.size === 0) return 0;
    const newA = newToday.has(tasks[a].task_id) ? 0 : 1;
    const newB = newToday.has(tasks[b].task_id) ? 0 : 1;
    return newA - newB;
  };
  const dueCmp = (a: number, b: number): number =>
    (tasks[a].due_at ?? '9999').localeCompare(tasks[b].due_at ?? '9999');
  const priCmp = (a: number, b: number): number => tasks[a].priority - tasks[b].priority;

  return tasks
    .map((_, i) => i)
    .sort((a, b) => {
      const theme = themeCmp(a, b);
      if (theme !== 0) return theme;
      const mem = memCmp(a, b);
      if (mem !== 0) return mem;
      const fresh = newCmp(a, b);
      if (fresh !== 0) return fresh;
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

  // AF-11: cluster by the PRIMARY (level-1 direction) tag — grouping the day by
  // direction is the desired outcome, so this deliberately ignores the widened
  // L1∪L2 match set. `primary_tags` is ABSENT (never []) for a direction-less
  // task and for callers that don't set it (test literals; pre-split shape) —
  // both fall back to `tags`, so a direction-less task still clusters by its
  // first intention.
  const groupKey = (idx: number): string => (tasks[idx].primary_tags ?? tasks[idx].tags)[0] ?? '';

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

export function checkOrder(
  order: number[],
  tasks: PlanTask[],
  today: string,
  themeTag?: string | null,
  memoryRelated?: Set<string>,
): Defect[] {
  const defects: Defect[] = [];
  const todayMs = Date.parse(today + 'T00:00:00Z');
  const themed = (t: PlanTask): boolean => (themeTag ? t.tags.includes(themeTag) : false);
  const related = (t: PlanTask): boolean => (memoryRelated ? memoryRelated.has(t.task_id) : false);

  for (let i = 0; i < order.length && defects.length < 5; i++) {
    const a = tasks[order[i]];
    const aPrio = a.priority;
    const aDue = a.due_at ? Date.parse(a.due_at) : Infinity;
    const aThemed = themed(a);
    const aRelated = related(a);

    for (let j = i + 1; j < order.length && defects.length < 5; j++) {
      const b = tasks[order[j]];
      const bPrio = b.priority;
      const bDue = b.due_at ? Date.parse(b.due_at) : Infinity;

      // §C2: a themed task (earlier) legitimately leads an unthemed one (later) on a
      // themed day — theme is the primary key, so this is not a priority/deadline inversion.
      if (aThemed && !themed(b)) continue;

      // AA3a: within the SAME theme band, a memory-related task legitimately leads an
      // unrelated one — memory is the next band after theme, so this isn't an inversion.
      if (aThemed === themed(b) && aRelated && !related(b)) continue;

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
export function genPrompt(lines: string[], capacityMin: number, themeTag?: string | null, constraint = '', memoryLine = ''): string {
  const themeLine = themeTag
    ? `\nToday's theme: ${themeTag} — favour ${themeTag}-tagged tasks earlier.`
    : '';
  return (
    `Order today's tasks from first to last. Weigh, in this order:\n` +
    `1) hard deadlines (sooner due = earlier); 2) priority (P1 highest);\n` +
    `3) momentum — group related work, minimize context switches;\n` +
    `4) front-load demanding work while focus is fresh.\n` +
    `Capacity today: ~${capacityMin} focused minutes.${themeLine}${constraint}${memoryLine}\n\n` +
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
 * call (small tier), keyed by the task's position. Best-effort: a degradable failure
 * (Ollama down, bad JSON) yields an empty map → those tasks keep a null rationale, so
 * the UI degrades silently. A genuine bug propagates to `authorPlanOrder`'s own catch,
 * which still lands a valid deterministic order — this is never allowed to throw at a
 * caller.
 */
async function generateRationales(tasks: PlanTask[], order: number[], themeTag?: string | null): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const lines = order.map((idx, pos) => `${pos}: ${taskLine(tasks[idx], idx).replace(/^\d+:\s*/, '')}`);
  // Garnish, NOT a loop stage — so `llmOrNull` is right here and banned in the callbacks
  // handed to `runLoop` below. A missing rationale just renders nothing on the block; the
  // old bare `catch {}` made that degrade invisible, which `llmOrNull`'s one warn fixes.
  const raw = await llmOrNull('generateRationales', () =>
    generateJson<Record<string, unknown>>(rationalePrompt(lines, themeTag), {
      purpose: 'plan_narrate',
      system: rationaleSystem(),
    }),
  );
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (let pos = 0; pos < order.length; pos++) {
      const r = sanitizeRationale((raw as Record<string, unknown>)[String(pos)]);
      if (r) out.set(tasks[order[pos]].task_id, r);
    }
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

/** T9 — what a day was actually authored as, truthfully; never trust `aiAvailable()`
 *  alone, since it only gates the ATTEMPT, not the outcome (Ollama can still drop
 *  mid-loop, or planning_mode may not be 'smart'). Mirrors `daily_plan.source`. */
export type PlanOrderSource = 'llm' | 'deterministic';

/**
 * Author the day's task order into `daily_plan` for `(owner, date)`.
 *
 * - Runs the §A0 generate→evaluate→iterate loop when planning_mode='smart'
 *   and Ollama is up; otherwise writes a deterministic priority/deadline order.
 * - §A2: applies tagGroupPostPass after obtaining the candidate order (LLM or
 *   deterministic). Falls back to pre-post-pass order if checkOrder detects defects.
 * - §C2: reads day_theme from prefs and injects a theme bias into deterministic
 *   ordering and into the LLM prompt.
 * - Author-once: a second call for the same (owner, date) is a no-op that reports the
 *   day's already-persisted source (T9) rather than resolving void.
 * - Never throws: Ollama failures always fall back to the deterministic order.
 * - Does NOT place blocks. Placement reads `daily_plan.position` independently.
 */
export async function authorPlanOrder(owner: string, date: string, opts: { force?: boolean; deterministic?: boolean } = {}): Promise<PlanOrderSource> {
  // B4 accept (`force`): drop the prior authored order so the author-once guard
  // re-opens and the day is freshly re-authored (LLM if smart+Ollama up, else
  // deterministic). The only reactive path that re-runs authoring, behind explicit
  // user accept — reflow itself never calls this.
  // `deterministic`: force the deterministic sort even in smart mode — used by the
  // Schedule-mode N-day horizon (T-SCHED-2) for future days so a multi-day plan
  // doesn't fire one LLM call per day (day 0 still authors normally).
  if (opts.force) await store().prepare(`DELETE FROM daily_plan WHERE owner_id = ? AND date = ?`).run(owner, date);
  if (await dailyPlanAuthored(owner, date)) {
    // T9 — a no-op re-call (no `force`) must still report truthfully what the day was
    // ACTUALLY authored as, not just resolve void; every row for a day shares one source.
    const row = await store()
      .prepare(`SELECT source FROM daily_plan WHERE owner_id = ? AND date = ? LIMIT 1`)
      .get<{ source?: string }>(owner, date);
    return (row?.source as PlanOrderSource) ?? 'deterministic';
  }

  const prefs = await loadPlanningPrefs(owner);
  const staged = await getStagedTasks(owner);

  if (staged.length < 2) {
    if (staged.length === 1) await persistOrder(owner, date, staged, [0], 'deterministic');
    return 'deterministic';
  }

  // §C2: resolve today's theme tag (null = no theming today)
  const themeTag = todayThemeTag(prefs.day_theme, date);
  // fill_order maps onto the deterministic authoring sort (default deadline-first).
  const fillOrder = prefs.fill_order ?? 'overdue';
  // AA3a: the tasks related to today's memory context (empty when the flag is off / the
  // connector is unavailable → every use below is inert, order byte-identical to today).
  const memoryRelated = await loadMemoryRelated(owner, date, staged);
  // fill_order='new_today' only: the staged tasks that arrived on the owner's real today.
  // Keyed on the owner's today rather than `date` for the same reason placement is —
  // authoring tomorrow must still let today's arrivals lead, and nothing is ever created
  // on a future date. Any other fill_order passes an empty set, so the band is inert.
  let newToday = new Set<string>();
  if (fillOrder === 'new_today') {
    const tz = await ownerTimezone(owner);
    newToday = newTodayTasks(staged, tz, todayInTZ(tz));
  }

  // Deterministic authoring — basic mode, AI off, Ollama unreachable at the pre-flight
  // check, OR (via the catch below) an LLM call that fails MID-loop. Centralised here so
  // the "never throws / always lands a valid order" invariant holds for every caller.
  const persistDeterministic = async () => {
    const detIndices = deterministicIndices(staged, themeTag, fillOrder, memoryRelated, newToday);
    const postPassed = tagGroupPostPass(detIndices, staged);
    const defects = checkOrder(postPassed, staged, date, themeTag, memoryRelated);
    const final = defects.length === 0 ? postPassed : detIndices;
    await persistOrder(owner, date, staged, final, 'deterministic');
  };

  const aiEnabled = !opts.deterministic && prefs.planning_mode === 'smart';
  // `ready`, not `available`: "Ollama answered /api/tags" is a green light with nothing
  // behind it. On an install whose fast/quality model isn't pulled, the old predicate let
  // the whole generate→judge→revise loop run against an Ollama that could not serve a
  // single call — burning the loop's budget on failures to land on exactly the
  // deterministic order below.
  if (!aiEnabled || !(await isReady())) {
    await persistDeterministic();
    return 'deterministic';
  }

  const lines = staged.map(taskLine);
  const capacityMin = workdayMinutes(prefs.workday_start, prefs.workday_end);
  // §A4: fold any persisted NL hints into a soft constraint line for the generator.
  const constraint = constraintLine(await loadPlanHints(owner, date));
  // AA3a: the memory-context nudge (empty string when nothing is related).
  const memoryLine = memoryOrderLine(staged, memoryRelated);

  // B4 invariant (docs/M-ai-scheduler.md:270,303): an LLM failure MID-loop — Ollama dies
  // AFTER the pre-flight isReady() check (timeout, OOM, dropped connection) — must
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
          // §C2: theme tag; §A4: NL-hint constraint line; AA3a: memory-context line
          const raw = await generateJson<unknown>(genPrompt(lines, capacityMin, themeTag, constraint, memoryLine), {
            purpose: 'plan_generate',
            system: genSystem(),
          });
          return safeOrder(raw, staged);
        },

        check: (order) => {
          // §A2: apply post-pass before checking
          const postPassed = tagGroupPostPass(order, staged);
          return checkOrder(postPassed, staged, date, themeTag, memoryRelated);
        },

        judge: async (order): Promise<JudgeScore> => {
          // `plan_judge` is the quality tier while `plan_generate` is fast: the loop's
          // generator ≠ evaluator guarantee IS that tier split. Keep them separate.
          const raw = await generateJson<Record<string, unknown>>(judgePrompt(lines, order, staged), {
            purpose: 'plan_judge',
            system: judgeSystem(),
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
            purpose: 'plan_generate',
            system: reviseSystem(),
          });
          return safeOrder(raw, staged);
        },

        baseline: () => deterministicIndices(staged, themeTag, fillOrder, memoryRelated, newToday),
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
    const finalDefects = checkOrder(finalCandidate, staged, date, themeTag, memoryRelated);
    const finalIndices = finalDefects.length === 0 ? finalCandidate : result.candidate;

    // §A3: only an LLM-authored order carries per-task rationales; an escape-hatch
    // fallback (source='deterministic') leaves them null, like the basic-mode path.
    const source = result.passed ? 'llm' : 'deterministic';
    const rationales = source === 'llm' ? await generateRationales(staged, finalIndices, themeTag) : undefined;
    await persistOrder(owner, date, staged, finalIndices, source, rationales);

    // §A0 clause 6 (docs/M-ai-scheduler.md:71,76): a STALLED loop must not silently revert.
    // The day still lands a valid deterministic order (above), AND we raise a "plan needs
    // review" signal — a persisted audit row + a live SSE event — so the escalation is
    // visible, not just a server log. (Client surfacing of plan:needs_review is a follow-up;
    // the audit row is the §A0 inspectability sink and is queryable today.)
    if (result.escaped) signalPlanNeedsReview(owner, date, result.score);
    return source;
  } catch (err) {
    logger.warn('authorPlanOrder: LLM authoring failed mid-call, falling back to deterministic order', {
      owner,
      date,
      err: String(err),
    });
    await persistDeterministic();
    return 'deterministic';
  }
}

/** §A0/B4 — raise a visible "plan needs review" signal when the authoring loop stalls. */
function signalPlanNeedsReview(owner: string, date: string, score: number): void {
  writeAudit({ ownerId: owner, actor: 'system', action: 'plan_needs_review', entity: `plan:${date}` });
  broadcast(owner, 'plan:needs_review', { date, score });
}

// ─── §A4 — NL planning constraints ────────────────────────────────────────────
//
// `POST /api/plan/instruct` → parse free text into a TYPED, validated constraint
// set the deterministic placer consumes. The rubric is pure schema validation (no
// LLM judge): malformed/unknown/contradictory ⇒ `invalid` (the route returns 422,
// never a partial apply); Ollama down ⇒ `unavailable` (503). Time PINS are applied
// as locked obstacle blocks. Tag/ordering HINTS are persisted to `plan_hints` (mig
// 0071) and ENFORCED on the next autoplan run: `placeHintWindows` (engine/autoplan.ts)
// hard-enforces tag_before/tag_after clock windows in placement, and `constraintLine`
// below folds every hint (incl. `batch`; contiguity itself is §A2's post-pass) into
// the smart-mode ordering prompt.
//
// PIN, sense 3 of 3 — a PLAN PIN: a task start time the owner locked in free text
// ("gym at 7"), placed as an immovable obstacle block. Unrelated to the other two:
// an operator env pin (`config.pins`, lib/config.ts) and a calibration combo pin
// (`calibration_combo_pins`, services/calibration.ts). See ARCHITECTURE.md §Glossary.

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

async function ownerTimezone(owner: string): Promise<string> {
  const row = await store().prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get<{ timezone: string | null }>(owner);
  return row?.timezone || serverTimezone();
}
async function allTagNames(owner: string): Promise<Set<string>> {
  return new Set((await store().prepare(`SELECT name FROM tags WHERE owner_id = ?`).all<{ name: string }>(owner)).map((r) => r.name));
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
  // `ready`, not `available`: a reachable-but-unpulled Ollama used to pass this gate and
  // then fail deeper with a confusing model-not-found error. It now 503s cleanly with
  // "AI is unavailable" — the same answer the client's own readiness gate already gives.
  if (!(await isReady())) throw new InstructError('unavailable', 'AI is unavailable');
  const prefs = await loadPlanningPrefs(owner);
  const tz = await ownerTimezone(owner);
  const tagSet = await allTagNames(owner);
  // This surface owes the user a REASON, so it keeps its own branch — but on `llmOrNull`,
  // not a bare catch: a transport failure or unparseable reply is the 503, while a genuine
  // bug propagates instead of being dressed up as "AI is unavailable".
  const raw = await llmOrNull('parseInstruction', () =>
    generateJson(instructPrompt(text, date, prefs.workday_start, prefs.workday_end, [...tagSet]), {
      purpose: 'plan_instruct',
      system: instructSystem(),
    }),
  );
  if (raw === null) throw new InstructError('unavailable', 'AI request failed');
  return validateInstruction(raw, date, tz, tagSet);
}

