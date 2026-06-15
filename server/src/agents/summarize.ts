import { createHash } from 'node:crypto';
import { sqlite } from '../db/index.js';
import { generate } from '../mcp/ollama.js';
import { logger } from '../lib/logger.js';
import { serverTimezone, utcDayBounds } from '../lib/tz.js';

interface TaskRow {
  id: number;
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

export interface FocusItem {
  taskId: number;
  title: string;
  reason: string;
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
  /** Up to three concrete things to act on — the briefing made clickable. */
  focus: FocusItem[];
  /** True when the prose came from the LLM; false when it's the deterministic fallback. */
  llm: boolean;
}

function gather(date: string) {
  // "Today" is the user's local calendar day, not the UTC day — so overdue/
  // due-today/blocks line up with what the scheduler placed.
  const tzRow = sqlite
    .prepare('SELECT timezone FROM scheduling_prefs WHERE owner_id = 1')
    .get() as { timezone: string | null } | undefined;
  const tz = tzRow?.timezone || serverTimezone();
  const { start: dayStart, end: dayEnd } = utcDayBounds(date, tz);

  const overdue = sqlite
    .prepare(
      `SELECT id, title, priority, due_at, status, estimated_minutes FROM tasks
       WHERE status IN ('open','scheduled') AND due_at IS NOT NULL AND due_at < ?
       ORDER BY due_at ASC LIMIT 25`
    )
    .all(dayStart) as TaskRow[];

  const dueToday = sqlite
    .prepare(
      `SELECT id, title, priority, due_at, status, estimated_minutes FROM tasks
       WHERE status IN ('open','scheduled') AND due_at >= ? AND due_at < ?
       ORDER BY priority ASC LIMIT 25`
    )
    .all(dayStart, dayEnd) as TaskRow[];

  const open = sqlite
    .prepare(
      `SELECT id, title, priority, due_at, status, estimated_minutes FROM tasks
       WHERE status = 'open' ORDER BY priority ASC, created_at ASC LIMIT 25`
    )
    .all() as TaskRow[];

  const blocks = sqlite
    .prepare(
      `SELECT title, block_kind, start_at, end_at, status FROM time_blocks
       WHERE start_at >= ? AND start_at < ? ORDER BY start_at ASC`
    )
    .all(dayStart, dayEnd) as BlockRow[];

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

/** Up to three concrete things to act on, most urgent first. */
function buildFocus(g: ReturnType<typeof gather>): FocusItem[] {
  const out: FocusItem[] = [];
  const seen = new Set<number>();
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

/** Fingerprint of everything the briefing depends on, so the cache self-invalidates. */
function inputsHash(g: ReturnType<typeof gather>): string {
  const payload = JSON.stringify({
    o: g.overdue.map((t) => [t.id, t.status, t.due_at]),
    d: g.dueToday.map((t) => [t.id, t.status, t.due_at, t.priority]),
    p: g.open.map((t) => [t.id, t.priority, t.status]),
    b: g.blocks.map((b) => [b.title, b.start_at, b.end_at, b.status]),
  });
  return createHash('sha1').update(payload).digest('hex');
}

interface CacheRow {
  prose: string;
  stats: string;
  focus: string;
  llm: number;
  inputs_hash: string;
}

/**
 * Produce a prose day briefing with actionable focus items. Uses Ollama when
 * available; otherwise returns a deterministic fallback so the endpoint never
 * hard-fails. Result is cached per day and only regenerated when the day's tasks
 * or blocks change (or `refresh` is set) — the LLM call is ~12s, so this matters.
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
  const hash = inputsHash(g);

  if (!opts.refresh) {
    const cached = sqlite
      .prepare('SELECT prose, stats, focus, llm, inputs_hash FROM daily_summaries WHERE owner_id = 1 AND date = ?')
      .get(date) as CacheRow | undefined;
    if (cached && cached.inputs_hash === hash) {
      return { date, prose: cached.prose, stats: JSON.parse(cached.stats), focus: JSON.parse(cached.focus), llm: !!cached.llm };
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
      `INSERT INTO daily_summaries (owner_id, date, prose, stats, focus, llm, inputs_hash, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(owner_id, date) DO UPDATE SET
         prose = excluded.prose, stats = excluded.stats, focus = excluded.focus,
         llm = excluded.llm, inputs_hash = excluded.inputs_hash, created_at = excluded.created_at`
    )
    .run(date, prose, JSON.stringify(stats), JSON.stringify(focus), llm ? 1 : 0, hash);

  return { date, prose, stats, focus, llm };
}
