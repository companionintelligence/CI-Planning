import { sqlite } from '../db/index.js';
import { generate } from '../mcp/ollama.js';
import { logger } from '../lib/logger.js';

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
}

function gather(date: string) {
  const dayEnd = `${date}T23:59:59.999Z`;

  const dayStart = `${date}T00:00:00.000Z`;

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
       WHERE status IN ('open','scheduled') AND due_at >= ? AND due_at <= ?
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
       WHERE start_at >= ? AND start_at <= ? ORDER BY start_at ASC`
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

/**
 * Produce a prose day briefing. Uses Ollama when available; otherwise returns a
 * deterministic fallback so the endpoint never hard-fails.
 */
export async function summarizeDay(date: string): Promise<DaySummary> {
  const g = gather(date);
  const stats = {
    overdue: g.overdue.length,
    dueToday: g.dueToday.length,
    open: g.open.length,
    blocks: g.blocks.length,
  };

  try {
    const prose = await generate(buildPrompt(date, g), { tier: 'medium', temperature: 0.4, timeoutMs: 60_000 });
    const trimmed = prose.trim();
    if (!trimmed) throw new Error('empty summary');
    return { date, prose: trimmed, stats, llm: true };
  } catch (err) {
    logger.warn('summarizeDay fell back to deterministic prose', { date, err: (err as Error).message });
    return { date, prose: fallbackProse(date, g), stats, llm: false };
  }
}
