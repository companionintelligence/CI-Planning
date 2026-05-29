/**
 * Period summaries (daily / weekly / monthly) + past reconciliation.
 *
 * Design: a summary is generated from the index, written into a markdown file
 * under <root>/Summaries/<Period>/<key>.md, and a one-line index entry is kept.
 * The narrative is LLM-authored when Ollama is up, else a deterministic template
 * — so a scheduled routine never fails just because the model is down.
 *
 * This module owns the data queries + file writes. Schedulers (launchd, hermes,
 * the MCP) only need to call generateSummary() / reconcilePast().
 */
import type Database from 'better-sqlite3';
import { join } from 'path';
import { existsSync, readFileSync, mkdirSync } from 'fs';
import { atomicWrite } from './util.js';
import { setMeta } from './db.js';
import { generateWithFallback } from './llm.js';

export type Period = 'daily' | 'weekly' | 'monthly';

export interface PeriodWindow {
  period: Period;
  key: string;        // e.g. 2026-05-29, 2026-W22, 2026-05
  start: string;      // YYYY-MM-DD inclusive
  end: string;        // YYYY-MM-DD inclusive
  label: string;      // human label
}

export interface SummaryData {
  window: PeriodWindow;
  completed: Array<{ text: string; file: string; doneDate: string | null }>;
  dueInWindow: Array<{ text: string; file: string; due: string | null; checked: boolean }>;
  overdue: Array<{ text: string; file: string; due: string | null }>;
  upcoming: Array<{ text: string; file: string; due: string | null }>;
  events: Array<{ title: string; start: number; end: number }>;
  counts: { completed: number; dueInWindow: number; overdue: number; upcoming: number; events: number };
}

export interface SummaryResult {
  window: PeriodWindow;
  text: string;
  model: string | null;     // null = deterministic template
  filePath: string;
  data: SummaryData;
}

// ---- window math ----

function pad(n: number): string { return String(n).padStart(2, '0'); }
function ymd(d: Date): string { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }

function isoWeek(d: Date): { year: number; week: number } {
  // ISO 8601 week number
  const date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date.getTime() - firstThursday.getTime()) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return { year: date.getUTCFullYear(), week };
}

export function windowFor(period: Period, anchorYmd: string): PeriodWindow {
  const anchor = new Date(anchorYmd + 'T12:00:00');
  if (period === 'daily') {
    return { period, key: anchorYmd, start: anchorYmd, end: anchorYmd, label: anchor.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) };
  }
  if (period === 'weekly') {
    // Monday → Sunday containing the anchor
    const dow = (anchor.getDay() + 6) % 7; // 0 = Monday
    const start = new Date(anchor); start.setDate(anchor.getDate() - dow);
    const end = new Date(start); end.setDate(start.getDate() + 6);
    const { year, week } = isoWeek(anchor);
    return { period, key: `${year}-W${pad(week)}`, start: ymd(start), end: ymd(end), label: `Week ${week}, ${year} (${ymd(start)} – ${ymd(end)})` };
  }
  // monthly
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
  return { period, key: `${anchor.getFullYear()}-${pad(anchor.getMonth() + 1)}`, start: ymd(start), end: ymd(end), label: anchor.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) };
}

// ---- data collection ----

export function collectSummaryData(db: Database.Database, window: PeriodWindow): SummaryData {
  const completed = db.prepare(
    `SELECT plain_text AS text, file_path AS file, done_date AS doneDate
     FROM todos WHERE done_date IS NOT NULL AND done_date BETWEEN ? AND ?
     ORDER BY done_date DESC, file_path LIMIT 200`,
  ).all(window.start, window.end) as SummaryData['completed'];

  const dueInWindow = db.prepare(
    `SELECT plain_text AS text, file_path AS file, due_date AS due, checked
     FROM todos WHERE due_date BETWEEN ? AND ?
     ORDER BY due_date, file_path LIMIT 200`,
  ).all(window.start, window.end).map((r) => {
    const row = r as { text: string; file: string; due: string | null; checked: number };
    return { text: row.text, file: row.file, due: row.due, checked: !!row.checked };
  });

  const overdue = db.prepare(
    `SELECT plain_text AS text, file_path AS file, due_date AS due
     FROM todos WHERE checked=0 AND due_date IS NOT NULL AND due_date < ?
     ORDER BY due_date LIMIT 100`,
  ).all(window.start) as SummaryData['overdue'];

  const upcomingStart = new Date(window.end + 'T12:00:00'); upcomingStart.setDate(upcomingStart.getDate() + 1);
  const upcomingEnd = new Date(upcomingStart); upcomingEnd.setDate(upcomingEnd.getDate() + 7);
  const upcoming = db.prepare(
    `SELECT plain_text AS text, file_path AS file, due_date AS due
     FROM todos WHERE checked=0 AND due_date BETWEEN ? AND ?
     ORDER BY due_date LIMIT 100`,
  ).all(ymd(upcomingStart), ymd(upcomingEnd)) as SummaryData['upcoming'];

  const startMs = new Date(window.start + 'T00:00:00').getTime();
  const endMs = new Date(window.end + 'T23:59:59').getTime();
  const events = db.prepare(
    `SELECT event_title AS title, start_at AS start, end_at AS end
     FROM calendar_links WHERE status='active' AND start_at BETWEEN ? AND ?
     ORDER BY start_at LIMIT 200`,
  ).all(startMs, endMs) as SummaryData['events'];

  return {
    window,
    completed,
    dueInWindow,
    overdue,
    upcoming,
    events,
    counts: {
      completed: completed.length,
      dueInWindow: dueInWindow.length,
      overdue: overdue.length,
      upcoming: upcoming.length,
      events: events.length,
    },
  };
}

// ---- narrative ----

function deterministicNarrative(d: SummaryData): string {
  const w = d.window;
  const lines: string[] = [];
  lines.push(`**${w.label}** — ${d.counts.completed} completed, ${d.counts.overdue} overdue, ${d.counts.upcoming} coming up.`);
  lines.push('');
  if (d.completed.length) {
    lines.push(`### ✅ Completed (${d.completed.length})`);
    for (const t of d.completed.slice(0, 30)) lines.push(`- ${t.text}`);
    lines.push('');
  }
  if (d.overdue.length) {
    lines.push(`### 🔴 Still overdue (${d.overdue.length})`);
    for (const t of d.overdue.slice(0, 20)) lines.push(`- ${t.text} _(was due ${t.due})_`);
    lines.push('');
  }
  if (d.upcoming.length) {
    lines.push(`### 📅 Next 7 days (${d.upcoming.length})`);
    for (const t of d.upcoming.slice(0, 20)) lines.push(`- ${t.text} _(due ${t.due})_`);
    lines.push('');
  }
  if (d.events.length) {
    lines.push(`### 🗓 Calendar (${d.events.length} events)`);
  }
  return lines.join('\n');
}

const SUMMARY_SYSTEM = `You write a concise, motivating period review for one person looking at their own todos and calendar.
Plain prose, 2-4 short paragraphs. Lead with what got DONE, then what's slipping, then what to focus on next.
Be specific — name concrete items. Do not invent items not in the data. No JSON, no preamble, just the review.`;

function summaryPrompt(d: SummaryData): string {
  const list = (arr: Array<{ text: string; due?: string | null }>, n = 40) =>
    arr.slice(0, n).map(t => `- ${t.text}${t.due ? ` (due ${t.due})` : ''}`).join('\n') || '(none)';
  return `Period: ${d.window.label}

COMPLETED THIS PERIOD (${d.counts.completed}):
${list(d.completed)}

DUE THIS PERIOD (${d.counts.dueInWindow}):
${list(d.dueInWindow)}

STILL OVERDUE (${d.counts.overdue}):
${list(d.overdue)}

COMING UP NEXT 7 DAYS (${d.counts.upcoming}):
${list(d.upcoming)}

CALENDAR EVENTS THIS PERIOD: ${d.counts.events}

Write the ${d.window.period} review.`;
}

async function buildNarrative(d: SummaryData, model?: string): Promise<{ text: string; model: string | null }> {
  try {
    const gen: Parameters<typeof generateWithFallback>[0] = {
      system: SUMMARY_SYSTEM, prompt: summaryPrompt(d), timeoutMs: 120_000,
    };
    if (model) gen.preferModel = model;
    const { response, model: used } = await generateWithFallback(gen);
    const prose = response.trim();
    // Prose first, then the structured lists for reference.
    return { text: `${prose}\n\n---\n\n${deterministicNarrative(d)}`, model: used };
  } catch {
    // Ollama down or every model failed → deterministic template.
    return { text: deterministicNarrative(d), model: null };
  }
}

// ---- write ----

function periodDir(root: string, period: Period): string {
  const sub = period === 'daily' ? 'Daily' : period === 'weekly' ? 'Weekly' : 'Monthly';
  return join(root, 'Summaries', sub);
}

export async function generateSummary(
  db: Database.Database,
  root: string,
  period: Period,
  anchorYmd: string,
  opts: { model?: string } = {},
): Promise<SummaryResult> {
  const window = windowFor(period, anchorYmd);
  const data = collectSummaryData(db, window);
  const { text, model } = await buildNarrative(data, opts.model);

  const dir = periodDir(root, period);
  mkdirSync(dir, { recursive: true });
  const filePath = join(dir, `${window.key}.md`);

  const frontmatter = [
    '---',
    `period: ${period}`,
    `key: ${window.key}`,
    `range: ${window.start}..${window.end}`,
    `generated: ${anchorYmd}`,
    model ? `model: ${model}` : 'model: template',
    `tags: [summary, ${period}]`,
    '---',
    '',
  ].join('\n');

  const body = `# ${period[0]!.toUpperCase()}${period.slice(1)} Review — ${window.label}\n\n${text}\n`;
  atomicWrite(filePath, frontmatter + body);

  setMeta(db, `last_summary_${period}`, JSON.stringify({ key: window.key, at: Date.now(), file: filePath }));
  return { window, text, model, filePath, data };
}

// ---- reconcile past calendar events with completed todos ----

export interface ReconcileResult {
  events_completed: number;   // calendar links closed because their todo is done
  events_stale: number;       // past active events with no done linkage (left as-is, just counted)
  overdue_now: number;
}

export function reconcilePast(db: Database.Database, nowMs = Date.now()): ReconcileResult {
  // Past, still-active calendar links whose linked todo is checked → mark completed
  const pastActive = db.prepare(
    `SELECT cl.id, cl.todo_hash, t.checked
     FROM calendar_links cl
     LEFT JOIN todos t ON t.hash = cl.todo_hash
     WHERE cl.status='active' AND cl.end_at < ?`,
  ).all(nowMs) as Array<{ id: number; todo_hash: string; checked: number | null }>;

  let completed = 0;
  let stale = 0;
  const markDone = db.prepare(`UPDATE calendar_links SET status='completed' WHERE id=?`);
  const tx = db.transaction(() => {
    for (const row of pastActive) {
      if (row.checked === 1) { markDone.run(row.id); completed++; }
      else stale++;
    }
  });
  tx();

  const today = ymd(new Date(nowMs));
  const overdue = db.prepare(
    `SELECT COUNT(*) AS n FROM todos WHERE checked=0 AND due_date IS NOT NULL AND due_date < ?`,
  ).get(today) as { n: number };

  return { events_completed: completed, events_stale: stale, overdue_now: overdue.n };
}

// ---- read last summary index ----

export function lastSummaries(db: Database.Database): Record<Period, { key: string; at: number; file: string } | null> {
  const out = {} as Record<Period, { key: string; at: number; file: string } | null>;
  for (const p of ['daily', 'weekly', 'monthly'] as Period[]) {
    const raw = db.prepare(`SELECT value FROM meta WHERE key=?`).get(`last_summary_${p}`) as { value: string } | undefined;
    out[p] = raw ? JSON.parse(raw.value) : null;
  }
  return out;
}

export function readSummaryFile(filePath: string): string | null {
  return existsSync(filePath) ? readFileSync(filePath, 'utf-8') : null;
}
