import { createHash } from 'node:crypto';
import { sqlite } from '../db/index.js';
import { generate } from '../mcp/ollama.js';
import { logger } from '../lib/logger.js';
import { serverTimezone, utcDayBounds } from '../lib/tz.js';
import { currentOwnerId } from '../lib/context.js';

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
