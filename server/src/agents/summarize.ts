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

export interface DaySummary {
  date: string;
  prose: string;
  stats: {
    overdue: number;
    dueToday: number;
    open: number;
    blocks: number;
  };
  /** True when the prose came from the LLM; false when it's the deterministic fallback. */
  llm: boolean;
  /** True when served from the daily_summaries cache (no regeneration this call). */
  cached?: boolean;
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
  const hash = inputsHash(date, g);

  if (!opts.refresh) {
    const row = sqlite
      .prepare('SELECT prose, stats, llm, inputs_hash FROM daily_summaries WHERE owner_id = 1 AND date = ?')
      .get(date) as { prose: string; stats: string; llm: number; inputs_hash: string } | undefined;
    if (row && row.inputs_hash === hash) {
      return { date, prose: row.prose, stats: JSON.parse(row.stats), llm: !!row.llm, cached: true };
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
      `INSERT INTO daily_summaries (owner_id, date, prose, stats, llm, inputs_hash, updated_at)
       VALUES (1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(owner_id, date) DO UPDATE SET
         prose = excluded.prose, stats = excluded.stats, llm = excluded.llm,
         inputs_hash = excluded.inputs_hash, updated_at = CURRENT_TIMESTAMP`
    )
    .run(date, prose, JSON.stringify(stats), llm ? 1 : 0, hash);

  return { date, prose, stats, llm, cached: false };
}
