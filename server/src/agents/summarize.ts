import { createHash } from 'node:crypto';
import { sqlite } from '../db/index.js';
import { generate } from '../mcp/ollama.js';
import { logger } from '../lib/logger.js';
import { serverTimezone, utcDayBounds } from '../lib/tz.js';
import { currentOwnerId } from '../lib/context.js';
import { detectComboSuggestions, CONFIDENCE_FLOOR, type ComboSuggestion } from '../services/calibration.js';

interface TaskRow {
  id: string;
  title: string;
  priority: number;
  due_at: string | null;
  status: string;
  estimated_minutes: number | null;
}

interface BlockRow {
  title: string;
  block_kind: string;
  start_at: string;
  end_at: string;
  status: string;
}

/** A concrete, clickable thing to act on — the briefing made actionable. */
export interface FocusItem {
  taskId: string;
  title: string;
  reason: string;
}

export interface Capacity {
  scheduled_minutes: number;
  focus_minutes: number;
  workday_minutes: number;
}

export interface DaySummary {
  date: string;
  prose: string;
  stats: {
    overdue: number;
    dueToday: number;
    open: number;
    blocks: number;
  };
  /** Up to three concrete things to act on, most urgent first. */
  focus: FocusItem[];
  /** Total scheduled block time vs workday budget. */
  capacity: Capacity;
  /** True when the prose came from the LLM; false when it's the deterministic fallback. */
  llm: boolean;
  /** True when served from the daily_recap cache (no regeneration this call). */
  cached?: boolean;
}

function gather(date: string) {
  // "Today" is the user's local calendar day, not the UTC day — so overdue/
  // due-today/blocks line up with what the scheduler placed.
  // Owner-scoped throughout (multi-tenant): the day summary must reflect only the
  // caller's own tasks + blocks, never every tenant's.
  const owner = currentOwnerId();
  const tzRow = sqlite
    .prepare('SELECT timezone FROM scheduling_prefs WHERE owner_id = ?')
    .get(owner) as { timezone: string | null } | undefined;
  const tz = tzRow?.timezone || serverTimezone();
  const { start: dayStart, end: dayEnd } = utcDayBounds(date, tz);

  const overdue = sqlite
    .prepare(
      `SELECT id, title, priority, due_at, status, estimated_minutes FROM tasks
       WHERE owner_id = ? AND status IN ('open','scheduled') AND due_at IS NOT NULL AND due_at < ?
       ORDER BY due_at ASC LIMIT 25`
    )
    .all(owner, dayStart) as TaskRow[];

  const dueToday = sqlite
    .prepare(
      `SELECT id, title, priority, due_at, status, estimated_minutes FROM tasks
       WHERE owner_id = ? AND status IN ('open','scheduled') AND due_at >= ? AND due_at < ?
       ORDER BY priority ASC LIMIT 25`
    )
    .all(owner, dayStart, dayEnd) as TaskRow[];

  const open = sqlite
    .prepare(
      `SELECT id, title, priority, due_at, status, estimated_minutes FROM tasks
       WHERE owner_id = ? AND status = 'open' ORDER BY priority ASC, created_at ASC LIMIT 25`
    )
    .all(owner) as TaskRow[];

  const blocks = sqlite
    .prepare(
      `SELECT title, block_kind, start_at, end_at, status FROM time_blocks
       WHERE owner_id = ? AND start_at >= ? AND start_at < ? ORDER BY start_at ASC`
    )
    .all(owner, dayStart, dayEnd) as BlockRow[];

  return { overdue, dueToday, open, blocks };
}

function fallbackProse(date: string, g: ReturnType<typeof gather>): string {
  const lines: string[] = [];
  lines.push(`Plan for ${date}:`);
  if (g.overdue.length) lines.push(`• ${g.overdue.length} overdue item(s) — top: "${g.overdue[0].title}".`);
  if (g.dueToday.length) lines.push(`• ${g.dueToday.length} due today, starting with "${g.dueToday[0].title}".`);
  if (g.blocks.length) lines.push(`• ${g.blocks.length} block(s) scheduled.`);
  if (g.open.length) lines.push(`• ${g.open.length} open task(s) in the backlog.`);
  if (lines.length === 1) lines.push('• Nothing pressing — a clear day.');
  return lines.join('\n');
}

function buildPrompt(date: string, g: ReturnType<typeof gather>): string {
  const fmt = (rows: TaskRow[]) =>
    rows.map((r) => `- [P${r.priority}] ${r.title}${r.due_at ? ` (due ${r.due_at.slice(0, 10)})` : ''}`).join('\n') || '(none)';
  const fmtBlocks = (rows: BlockRow[]) =>
    rows.map((b) => `- ${b.start_at.slice(11, 16)}–${b.end_at.slice(11, 16)} ${b.title} [${b.block_kind}]`).join('\n') || '(none)';

  return `Write a short, warm, focused morning briefing (3-5 sentences, no bullet lists, no preamble) for ${date}.
Mention what's overdue, what's due today, and the shape of the scheduled day. Be concrete and encouraging.

Overdue:
${fmt(g.overdue)}

Due today:
${fmt(g.dueToday)}

Scheduled blocks:
${fmtBlocks(g.blocks)}

Open backlog (top items):
${fmt(g.open)}`;
}

/** Up to three concrete things to act on, most urgent first (deterministic). */
function buildFocus(g: ReturnType<typeof gather>): FocusItem[] {
  const out: FocusItem[] = [];
  const seen = new Set<string>();
  const add = (t: TaskRow, reason: string) => {
    if (out.length >= 3 || seen.has(t.id)) return;
    seen.add(t.id);
    out.push({ taskId: t.id, title: t.title, reason });
  };
  for (const t of g.overdue) add(t, t.due_at ? `Overdue since ${t.due_at.slice(0, 10)}` : 'Overdue');
  for (const t of g.dueToday) add(t, 'Due today');
  for (const t of g.open) add(t, `Priority P${t.priority}`);
  return out;
}

function buildCapacity(g: ReturnType<typeof gather>, focus: FocusItem[]): Capacity {
  const scheduled_minutes = g.blocks.reduce((sum, b) => {
    const ms = new Date(b.end_at).getTime() - new Date(b.start_at).getTime();
    return sum + Math.max(0, Math.round(ms / 60_000));
  }, 0);

  // Sum estimated_minutes only for tasks that made it into focus[].
  // Deduplicate by id — a task can appear in multiple arrays (e.g. overdue AND open).
  const focusIds = new Set(focus.map((f) => f.taskId));
  const seenIds = new Set<string>();
  let focus_minutes = 0;
  for (const t of [...g.overdue, ...g.dueToday, ...g.open]) {
    if (focusIds.has(t.id) && !seenIds.has(t.id) && t.estimated_minutes != null) {
      focus_minutes += t.estimated_minutes;
      seenIds.add(t.id);
    }
  }

  const prefRow = sqlite
    .prepare(`SELECT workday_start, workday_end FROM scheduling_prefs WHERE owner_id = ?`)
    .get(currentOwnerId()) as { workday_start: string | null; workday_end: string | null } | undefined;

  const [sh, sm] = (prefRow?.workday_start ?? '09:00').split(':').map(Number);
  const [eh, em] = (prefRow?.workday_end ?? '18:00').split(':').map(Number);
  const workday_minutes = Math.max(0, (eh * 60 + em) - (sh * 60 + sm));

  return { scheduled_minutes, focus_minutes, workday_minutes };
}

/** Fingerprint of the inputs that feed a briefing; changes invalidate the cache. */
function inputsHash(date: string, g: ReturnType<typeof gather>): string {
  return createHash('sha256').update(JSON.stringify({ date, g })).digest('hex');
}

/**
 * Produce a prose day briefing. Uses Ollama when available; otherwise returns a
 * deterministic fallback so the endpoint never hard-fails.
 *
 * Result is cached per (owner, date) keyed by an inputs fingerprint, so repeated
 * loads don't pay the ~12s LLM cost. The cache is bypassed with `refresh: true`
 * and self-invalidates when the day's tasks/blocks change.
 */
export async function summarizeDay(date: string, opts: { refresh?: boolean } = {}): Promise<DaySummary> {
  const g = gather(date);
  const stats = {
    overdue: g.overdue.length,
    dueToday: g.dueToday.length,
    open: g.open.length,
    blocks: g.blocks.length,
  };
  const focus = buildFocus(g);
  const capacity = buildCapacity(g, focus);
  const hash = inputsHash(date, g);

  if (!opts.refresh) {
    const row = sqlite
      .prepare('SELECT prose, stats, focus, llm, inputs_hash FROM daily_recap WHERE owner_id = ? AND date = ?')
      .get(currentOwnerId(), date) as
      | { prose: string; stats: string; focus: string; llm: number; inputs_hash: string }
      | undefined;
    if (row && row.inputs_hash === hash) {
      return {
        date,
        prose: row.prose,
        stats: JSON.parse(row.stats),
        focus: JSON.parse(row.focus),
        capacity,
        llm: !!row.llm,
        cached: true,
      };
    }
  }

  let prose: string;
  let llm: boolean;
  try {
    const out = await generate(buildPrompt(date, g), { tier: 'medium', temperature: 0.4, timeoutMs: 60_000 });
    prose = out.trim();
    if (!prose) throw new Error('empty summary');
    llm = true;
  } catch (err) {
    logger.warn('summarizeDay fell back to deterministic prose', { date, err: (err as Error).message });
    prose = fallbackProse(date, g);
    llm = false;
  }

  sqlite
    .prepare(
      // Partial upsert of ONLY the summary columns — never touches the star
      // group, so refreshing a briefing can't disturb a frozen day_recap row.
      `INSERT INTO daily_recap (owner_id, date, prose, stats, focus, llm, inputs_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(owner_id, date) DO UPDATE SET
         prose = excluded.prose, stats = excluded.stats, focus = excluded.focus,
         llm = excluded.llm, inputs_hash = excluded.inputs_hash, updated_at = CURRENT_TIMESTAMP`
    )
    .run(currentOwnerId(), date, prose, JSON.stringify(stats), JSON.stringify(focus), llm ? 1 : 0, hash);

  return { date, prose, stats, focus, capacity, llm, cached: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase Z · Z1 (Time-Sense) — EOD Alignment: the evening mirror of summarizeDay.
// The deterministic payload is recomputed on every read (regenerable — 0095
// dropped the plan_outcomes rollup for exactly this reason); the narrative is
// generated once when the user opens the evening modal and persisted by the
// route into reflections(kind='evening') — modal-only authorship, owner
// decision 2026-07-01. No daily_recap column is touched.
// ─────────────────────────────────────────────────────────────────────────────

export interface EstimateDelta {
  task_id: string;
  title: string;
  estimated_minutes: number;
  actual_minutes: number;
  delta_minutes: number;
}

export interface EveningPayload {
  date: string;
  /** Non-meeting task blocks scheduled on the day (the old aggregate_plan_outcomes math, on demand). */
  planned: number;
  /** Of those, how many tasks completed that day. */
  completed: number;
  /** Write-once outcome stamps review.ts left on daily_plan rows. */
  outcomes: { deferred: number; missed: number };
  estimate_deltas: EstimateDelta[];
  carry_forward: { task_id: string; title: string; status: string }[];
  /** Current calibration picture: scopes at/above the confidence floor, biggest samples first. */
  calibration: { scope_kind: string; scope_ref: string; label: string; bias_ratio: number | null; sample_count: number }[];
  /** Unpinned tag combos worth tracking separately (§2.3 hybrid) — suggestions only. */
  combo_suggestions: ComboSuggestion[];
}

export function gatherEvening(date: string): EveningPayload {
  const owner = currentOwnerId();
  const tzRow = sqlite
    .prepare('SELECT timezone FROM scheduling_prefs WHERE owner_id = ?')
    .get(owner) as { timezone: string | null } | undefined;
  const tz = tzRow?.timezone || serverTimezone();
  const { start: dayStart, end: dayEnd } = utcDayBounds(date, tz);

  const planned = (sqlite
    .prepare(
      `SELECT COUNT(*) AS n FROM time_blocks b
        WHERE b.owner_id = ? AND b.task_id IS NOT NULL AND b.block_kind != 'meeting'
          AND b.start_at >= ? AND b.start_at < ?`,
    )
    .get(owner, dayStart, dayEnd) as { n: number }).n;

  const completed = (sqlite
    .prepare(
      `SELECT COUNT(DISTINCT b.task_id) AS n FROM time_blocks b
         JOIN tasks t ON t.id = b.task_id
        WHERE b.owner_id = ? AND b.block_kind != 'meeting'
          AND b.start_at >= ? AND b.start_at < ?
          AND t.status = 'done' AND t.completed_at >= ? AND t.completed_at < ?`,
    )
    .get(owner, dayStart, dayEnd, dayStart, dayEnd) as { n: number }).n;

  const outcomeRows = sqlite
    .prepare(
      `SELECT outcome, COUNT(*) AS n FROM daily_plan
        WHERE owner_id = ? AND date = ? AND outcome IS NOT NULL GROUP BY outcome`,
    )
    .all(owner, date) as { outcome: string; n: number }[];
  const outcomes = { deferred: 0, missed: 0 };
  for (const r of outcomeRows) {
    if (r.outcome === 'deferred') outcomes.deferred = r.n;
    else if (r.outcome === 'missed') outcomes.missed = r.n;
  }

  const estimate_deltas = (sqlite
    .prepare(
      `SELECT id AS task_id, title, estimated_minutes, actual_minutes,
              (actual_minutes - estimated_minutes) AS delta_minutes
         FROM tasks
        WHERE owner_id = ? AND status = 'done'
          AND completed_at >= ? AND completed_at < ?
          AND estimated_minutes > 0 AND actual_minutes > 0
        ORDER BY ABS(actual_minutes - estimated_minutes) DESC LIMIT 10`,
    )
    .all(owner, dayStart, dayEnd)) as EstimateDelta[];

  const carry_forward = sqlite
    .prepare(
      `SELECT DISTINCT t.id AS task_id, t.title, t.status FROM time_blocks b
         JOIN tasks t ON t.id = b.task_id
        WHERE b.owner_id = ? AND b.block_kind != 'meeting'
          AND b.start_at >= ? AND b.start_at < ?
          AND t.status IN ('open', 'scheduled', 'in_progress')
        ORDER BY t.title LIMIT 10`,
    )
    .all(owner, dayStart, dayEnd) as { task_id: string; title: string; status: string }[];

  // Label the scope refs so the modal never shows raw ids. tag_combo refs are
  // '+'-joined tag-id tuples; unknown ids (deleted tags) fall back to the ref.
  const tagName = sqlite.prepare(`SELECT name FROM tags WHERE id = ? AND owner_id = ?`);
  const label = (kind: string, ref: string): string => {
    if (kind === 'global') return 'overall';
    if (kind === 'subtype') return ref;
    if (kind === 'tag' || kind === 'category') {
      return (tagName.get(ref, owner) as { name: string } | undefined)?.name ?? ref;
    }
    if (kind === 'tag_combo') {
      return ref
        .split('+')
        .map((id) => (tagName.get(id, owner) as { name: string } | undefined)?.name ?? id)
        .join(' + ');
    }
    if (kind === 'objective') {
      const row = sqlite.prepare(`SELECT title FROM objectives WHERE id = ? AND owner_id = ?`).get(ref, owner) as
        | { title: string }
        | undefined;
      return row?.title ?? ref;
    }
    return ref;
  };

  const calibration = (sqlite
    .prepare(
      `SELECT scope_kind, scope_ref, bias_ratio, sample_count FROM estimate_calibration
        WHERE owner_id = ? AND sample_count >= ?
        ORDER BY sample_count DESC, scope_kind, scope_ref LIMIT 5`,
    )
    .all(owner, CONFIDENCE_FLOOR) as { scope_kind: string; scope_ref: string; bias_ratio: number | null; sample_count: number }[])
    .map((r) => ({ ...r, label: label(r.scope_kind, r.scope_ref) }));

  return {
    date,
    planned,
    completed,
    outcomes,
    estimate_deltas,
    carry_forward,
    calibration,
    combo_suggestions: detectComboSuggestions(owner),
  };
}

export function fallbackEveningProse(p: EveningPayload): string {
  const lines: string[] = [];
  lines.push(`${p.date} in review:`);
  if (p.planned) lines.push(`• ${p.completed} of ${p.planned} planned block(s) completed.`);
  else lines.push(`• No task blocks were planned.`);
  if (p.outcomes.deferred || p.outcomes.missed) {
    lines.push(`• ${p.outcomes.deferred} deferred, ${p.outcomes.missed} missed.`);
  }
  if (p.estimate_deltas.length) {
    const d = p.estimate_deltas[0];
    const dir = d.delta_minutes >= 0 ? 'over' : 'under';
    lines.push(`• Biggest estimate miss: "${d.title}" ran ${Math.abs(d.delta_minutes)}m ${dir}.`);
  }
  if (p.carry_forward.length) lines.push(`• ${p.carry_forward.length} task(s) carry forward to tomorrow.`);
  return lines.join('\n');
}

function buildEveningPrompt(p: EveningPayload): string {
  const deltas =
    p.estimate_deltas
      .map((d) => `- "${d.title}": estimated ${d.estimated_minutes}m, took ${d.actual_minutes}m`)
      .join('\n') || '(none)';
  const carries = p.carry_forward.map((c) => `- ${c.title}`).join('\n') || '(none)';
  const cal =
    p.calibration
      .map((c) => `- ${c.label}: bias ${c.bias_ratio?.toFixed(2)} over ${c.sample_count} samples`)
      .join('\n') || '(none)';

  return `Write a short, calm evening reflection (3-5 sentences, no bullet lists, no preamble, no praise-words) on this day.
State what got done vs planned, name the biggest estimate miss if there is one, and end with one plain sentence about what carries into tomorrow.

Date: ${p.date}
Planned task blocks: ${p.planned}; completed: ${p.completed}; deferred: ${p.outcomes.deferred}; missed: ${p.outcomes.missed}

Estimate deltas today:
${deltas}

Carrying forward:
${carries}

Current estimate bias by scope:
${cal}`;
}

export interface EveningSummary {
  date: string;
  prose: string;
  llm: boolean;
  payload: EveningPayload;
}

/**
 * Compose the EOD Alignment narrative. Mirrors summarizeDay's degradation
 * contract: Ollama down / empty output → deterministic fallback, never a throw.
 * Persistence is the CALLER's job (the reflections route writes the row on
 * modal open) — this function is pure compute.
 */
export async function summarizeEvening(date: string): Promise<EveningSummary> {
  const payload = gatherEvening(date);
  let prose: string;
  let llm: boolean;
  try {
    const out = await generate(buildEveningPrompt(payload), { tier: 'medium', temperature: 0.4, timeoutMs: 60_000 });
    prose = out.trim();
    if (!prose) throw new Error('empty evening summary');
    llm = true;
  } catch (err) {
    logger.warn('summarizeEvening fell back to deterministic prose', { date, err: (err as Error).message });
    prose = fallbackEveningProse(payload);
    llm = false;
  }
  return { date, prose, llm, payload };
}
