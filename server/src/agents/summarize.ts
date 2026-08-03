import { createHash } from 'node:crypto';
import { store } from '../db/store.js';
import { generate } from '../mcp/ollama.js';
import { renderCopy } from './render-copy.js';
import { timeSenseEnabled } from '../lib/flags.js';
import { logger } from '../lib/logger.js';
import { serverTimezone, utcDayBounds, utcToZonedWallTime, localDateInTZ } from '../lib/tz.js';
import { currentOwnerId } from '../lib/context.js';
import { addDays } from '../lib/dates.js';
import { detectComboSuggestions, scopeLabel, CONFIDENCE_FLOOR, type ComboSuggestion, type ScopeKind } from '../services/calibration.js';
import { graphData, graphContext, nodeStartTime, MemoryUnavailable, type MemoryNode } from '../connectors/memory.js';
import { memoryConnectorAvailable, memoryWindowMs } from '../services/memory.js';

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

async function gather(date: string) {
  // "Today" is the user's local calendar day, not the UTC day — so overdue/
  // due-today/blocks line up with what the scheduler placed.
  // Owner-scoped throughout (multi-tenant): the day summary must reflect only the
  // caller's own tasks + blocks, never every tenant's.
  const owner = currentOwnerId();
  const tzRow = await store()
    .prepare('SELECT timezone FROM scheduling_prefs WHERE owner_id = ?')
    .get<{ timezone: string | null }>(owner);
  const tz = tzRow?.timezone || serverTimezone();
  const { start: dayStart, end: dayEnd } = utcDayBounds(date, tz);

  const overdue = await store()
    .prepare(
      `SELECT id, title, priority, due_at, status, estimated_minutes FROM tasks
       WHERE owner_id = ? AND status IN ('open','scheduled') AND due_at IS NOT NULL AND due_at < ?
       ORDER BY due_at ASC LIMIT 25`
    )
    .all<TaskRow>(owner, dayStart);

  const dueToday = await store()
    .prepare(
      `SELECT id, title, priority, due_at, status, estimated_minutes FROM tasks
       WHERE owner_id = ? AND status IN ('open','scheduled') AND due_at >= ? AND due_at < ?
       ORDER BY priority ASC LIMIT 25`
    )
    .all<TaskRow>(owner, dayStart, dayEnd);

  const open = await store()
    .prepare(
      `SELECT id, title, priority, due_at, status, estimated_minutes FROM tasks
       WHERE owner_id = ? AND status = 'open' ORDER BY priority ASC, created_at ASC LIMIT 25`
    )
    .all<TaskRow>(owner);

  const blocks = await store()
    .prepare(
      `SELECT title, block_kind, start_at, end_at, status FROM time_blocks
       WHERE owner_id = ? AND start_at >= ? AND start_at < ? ORDER BY start_at ASC`
    )
    .all<BlockRow>(owner, dayStart, dayEnd);

  return { overdue, dueToday, open, blocks };
}

function fallbackProse(date: string, g: Awaited<ReturnType<typeof gather>>, memoryExcerpt = ''): string {
  const lines: string[] = [];
  lines.push(`Plan for ${date}:`);
  if (g.overdue.length) lines.push(`• ${g.overdue.length} overdue item(s) — top: "${g.overdue[0].title}".`);
  if (g.dueToday.length) lines.push(`• ${g.dueToday.length} due today, starting with "${g.dueToday[0].title}".`);
  if (g.blocks.length) lines.push(`• ${g.blocks.length} block(s) scheduled.`);
  if (g.open.length) lines.push(`• ${g.open.length} open task(s) in the backlog.`);
  if (lines.length === 1) lines.push('• Nothing pressing — a clear day.');
  // AA2 — memory-derived life context appended AFTER the deterministic body. Empty
  // excerpt (flag off / connector down / error) leaves the prose byte-identical.
  if (memoryExcerpt) lines.push(memoryExcerpt);
  return lines.join('\n');
}

function buildPrompt(date: string, g: Awaited<ReturnType<typeof gather>>, memoryExcerpt = ''): string {
  const fmt = (rows: TaskRow[]) =>
    rows.map((r) => `- [P${r.priority}] ${r.title}${r.due_at ? ` (due ${r.due_at.slice(0, 10)})` : ''}`).join('\n') || '(none)';
  const fmtBlocks = (rows: BlockRow[]) =>
    rows.map((b) => `- ${b.start_at.slice(11, 16)}–${b.end_at.slice(11, 16)} ${b.title} [${b.block_kind}]`).join('\n') || '(none)';

  // AA2 — a short excerpt of the CI-Server memory graph (upcoming dated events +
  // participants) folded into the model facts so the narrative can say "today you have
  // dinner with Maya at 7pm". Appended so the block is empty-string-safe: no excerpt →
  // the prompt is byte-for-byte what it was before AA2.
  const life = memoryExcerpt ? `\n\nFrom your life context (mention naturally if relevant):\n${memoryExcerpt}` : '';

  return `Write a short, warm, focused morning briefing (3-5 sentences, no bullet lists, no preamble) for ${date}.
Mention what's overdue, what's due today, and the shape of the scheduled day. Be concrete and encouraging.

Overdue:
${fmt(g.overdue)}

Due today:
${fmt(g.dueToday)}

Scheduled blocks:
${fmtBlocks(g.blocks)}

Open backlog (top items):
${fmt(g.open)}${life}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase AA · AA2 — memory-informed brief. Fold a short excerpt of the CI-Server
// memory graph (upcoming dated events + their participants) into the morning Brief
// and EOD Alignment so the narrative can name real life context. STRICT discipline:
// flag off, connector unavailable, or ANY error → returns '' and every caller stays
// byte-identical to pre-AA2. Ollama-only invariant is untouched — the memory
// connector (connectors/memory.ts) is the sole new dependency and already routes
// through the CI-Server read API; no cloud LLM is introduced.
// ─────────────────────────────────────────────────────────────────────────────

/** Length ceiling for the whole excerpt handed to the brief (a few short lines). */
const MEMORY_EXCERPT_MAX = 200;
/** How many dated event lines to surface at most. */
const MEMORY_EXCERPT_LINES = 3;

async function pullEnabled(owner: string): Promise<boolean> {
  const row = await store()
    .prepare(`SELECT memory_pull_enabled FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ memory_pull_enabled?: number }>(owner);
  return !!row?.memory_pull_enabled;
}

/**
 * Person names linked to an event node, deduped (mirror of memory-suggest.ts's
 * participant walk). The connector normalizes a missing id to '' (mapNode), so a
 * blank node id — or a blank link endpoint — must never anchor a match: `'' === ''`
 * would otherwise pull every ill-formed link's other end in as a "participant".
 */
function eventParticipants(node: MemoryNode, byId: Map<string, MemoryNode>, links: { source: string; target: string }[]): string[] {
  if (!node.id.trim()) return []; // never match on a blank event id
  const names = new Set<string>();
  for (const l of links) {
    const otherId = l.source === node.id ? l.target : l.target === node.id ? l.source : null;
    if (!otherId || !otherId.trim()) continue; // skip missing / blank endpoints
    const other = byId.get(otherId);
    if (other && other.entityType.toLowerCase() === 'person' && other.name) names.add(other.name);
  }
  return [...names];
}

/**
 * Human label for `date` (YYYY-MM-DD) relative to the current day in the owner's
 * timezone: `Today` / `Tomorrow`, else a short `Mon, Jul 7`. Owner-tz "today" keeps
 * this consistent with how memoryBriefExcerpt derives its window (utcDayBounds, owner
 * tz) — a server-zone `localISODate` could disagree by a day near the tz boundary.
 * Matters because the excerpt is also built for the EOD Alignment with TOMORROW's date,
 * where a hardcoded `Today:` would misdate evening events.
 */
function relativeDayLabel(date: string, tz: string): string {
  const today = localDateInTZ(new Date().toISOString(), tz);
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  // Short, unambiguous fallback ("Mon, Jul 7"). Noon-UTC pivot avoids a tz/DST flip of
  // the weekday for a date-only value; the label is a coarse day marker, not a clock.
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

/** Format a dated event into a brief line, e.g. `"Dinner with Maya (7:00 PM)"`. */
function eventLine(node: MemoryNode, startISO: string, people: string[], tz: string): string {
  const wall = utcToZonedWallTime(startISO, tz); // "HH:MM" 24h, DST-correct
  const [hh, mm] = wall.split(':').map(Number);
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  const clock = `${h12}:${String(mm).padStart(2, '0')} ${ampm}`;
  const who = people.length ? ` with ${people.join(', ')}` : '';
  return `${node.name}${who} (${clock})`;
}

/**
 * A short, human-readable excerpt of the owner's memory graph for `date`, or '' when
 * the pull flag is off, the connector is unavailable, or anything throws. Prefers
 * 1–3 dated event lines from the day forward (windowed start-of-day → +memory_window_days
 * so a late-evening event just over the local-midnight boundary still surfaces); falls
 * back to a trimmed graphContext when there are no dated nodes. Never throws.
 */
export async function memoryBriefExcerpt(owner: string, date: string): Promise<string> {
  if (!(await pullEnabled(owner)) || !(await memoryConnectorAvailable(owner))) return '';
  try {
    const tzRow = await store()
      .prepare('SELECT timezone FROM scheduling_prefs WHERE owner_id = ?')
      .get<{ timezone: string | null }>(owner);
    const tz = tzRow?.timezone || serverTimezone();
    // Prefix is relative to the ACTUAL current day (owner tz), not the brief's `date`:
    // the EOD path passes tomorrow, so its events must read "Tomorrow:", not "Today:".
    const dayLabel = relativeDayLabel(date, tz);
    const { start } = utcDayBounds(date, tz);
    // Window: the day's start through +memory_window_days (0147; default 2 = the 48h
    // this used to hardcode), so a late-evening event that rolls just over the local-
    // midnight boundary is still caught for the day's brief. Shares the setting with the
    // suggest agent — one knob moves every memory pull surface together.
    const to = new Date(Date.parse(start) + (await memoryWindowMs(owner))).toISOString();
    const graph = await graphData(owner, { from: start, to });

    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    const events = graph.nodes
      .filter((n) => n.entityType.toLowerCase() === 'event')
      .map((n) => ({ node: n, start: nodeStartTime(n) }))
      .filter((e): e is { node: MemoryNode; start: string } => !!e.start && e.start >= start && e.start <= to)
      .sort((a, b) => a.start.localeCompare(b.start));

    if (events.length) {
      const lines: string[] = [];
      for (const e of events.slice(0, MEMORY_EXCERPT_LINES)) {
        const line = `${dayLabel}: ${eventLine(e.node, e.start, eventParticipants(e.node, byId, graph.links), tz)}`;
        // Keep the whole excerpt inside the char budget; stop before overflowing.
        if (lines.join('\n').length + line.length + 1 > MEMORY_EXCERPT_MAX) break;
        lines.push(line);
      }
      if (lines.length) return lines.join('\n');
    }

    // No dated events in-window → a trimmed context snapshot as the softer fallback.
    // NOT day-labeled: graphContext is undated entity context (people/places), so a
    // "Today:"/"Tomorrow:" prefix would assert a date it doesn't actually carry — the
    // misdating bug only exists for dated event lines, which are handled above.
    const ctx = (await graphContext(owner)).trim();
    if (ctx) {
      const firstLine = ctx.split('\n')[0].trim();
      return firstLine.slice(0, MEMORY_EXCERPT_MAX);
    }
    return '';
  } catch (err) {
    if (!(err instanceof MemoryUnavailable)) {
      logger.warn('memoryBriefExcerpt: unexpected error, degrading to no memory context', {
        owner,
        date,
        err: (err as Error).message,
      });
    }
    return '';
  }
}

/** Up to three concrete things to act on, most urgent first (deterministic). */
function buildFocus(g: Awaited<ReturnType<typeof gather>>): FocusItem[] {
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

async function buildCapacity(g: Awaited<ReturnType<typeof gather>>, focus: FocusItem[]): Promise<Capacity> {
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

  const prefRow = await store()
    .prepare(`SELECT workday_start, workday_end FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ workday_start: string | null; workday_end: string | null }>(currentOwnerId());

  const [sh, sm] = (prefRow?.workday_start ?? '09:00').split(':').map(Number);
  const [eh, em] = (prefRow?.workday_end ?? '18:00').split(':').map(Number);
  const workday_minutes = Math.max(0, (eh * 60 + em) - (sh * 60 + sm));

  return { scheduled_minutes, focus_minutes, workday_minutes };
}

/** Fingerprint of the inputs that feed a briefing; changes invalidate the cache. */
function inputsHash(date: string, g: Awaited<ReturnType<typeof gather>>, memoryExcerpt = ''): string {
  // AA2 — fold the memory excerpt into the fingerprint ONLY when non-empty, so a
  // flag-off / connector-down brief hashes byte-identically to pre-AA2 (no cache churn),
  // while a changing excerpt (or toggling memory on) correctly invalidates a cached recap.
  const inputs = memoryExcerpt ? { date, g, memoryExcerpt } : { date, g };
  return createHash('sha256').update(JSON.stringify(inputs)).digest('hex');
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
  const g = await gather(date);
  const stats = {
    overdue: g.overdue.length,
    dueToday: g.dueToday.length,
    open: g.open.length,
    blocks: g.blocks.length,
  };
  const focus = buildFocus(g);
  const capacity = await buildCapacity(g, focus);
  // AA2 — computed once and threaded into the hash + both generation paths. '' when the
  // flag is off / connector is down, keeping the hash + prose byte-identical to pre-AA2.
  const memoryExcerpt = await memoryBriefExcerpt(currentOwnerId(), date);
  const hash = inputsHash(date, g, memoryExcerpt);

  if (!opts.refresh) {
    const row = await store()
      .prepare('SELECT prose, stats, focus, llm, inputs_hash FROM daily_recap WHERE owner_id = ? AND date = ?')
      .get<{ prose: string; stats: string; focus: string; llm: number; inputs_hash: string }>(currentOwnerId(), date);
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
  if (await timeSenseEnabled(currentOwnerId())) {
    // Phase Z · Z7 — route the brief through the Voice loop so it's voice-gated and
    // never repeats a recent day's phrasing. Only on a cache MISS (here): a cache hit
    // returns the stored prose above without re-rendering, so copy_history records
    // exactly one signature per genuine (re)generation. renderCopy is Ollama-down-safe
    // and falls back to fallbackProse (passed as `fallback`), so this never throws.
    const copy = await renderCopy('daily_brief', {
      facts: buildPrompt(date, g, memoryExcerpt),
      fallback: fallbackProse(date, g, memoryExcerpt),
    });
    prose = copy.text;
    llm = copy.source === 'model';
  } else {
    // Flag OFF → byte-identical Phase N/O: the brief is core, not a Time-Sense surface.
    try {
      const out = await generate(buildPrompt(date, g, memoryExcerpt), { tier: 'medium', temperature: 0.4, timeoutMs: 60_000 });
      prose = out.trim();
      if (!prose) throw new Error('empty summary');
      llm = true;
    } catch (err) {
      logger.warn('summarizeDay fell back to deterministic prose', { date, err: (err as Error).message });
      prose = fallbackProse(date, g, memoryExcerpt);
      llm = false;
    }
  }

  await store()
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

export async function gatherEvening(date: string): Promise<EveningPayload> {
  const owner = currentOwnerId();
  const tzRow = await store()
    .prepare('SELECT timezone FROM scheduling_prefs WHERE owner_id = ?')
    .get<{ timezone: string | null }>(owner);
  const tz = tzRow?.timezone || serverTimezone();
  const { start: dayStart, end: dayEnd } = utcDayBounds(date, tz);

  const planned = ((await store()
    .prepare(
      `SELECT COUNT(*) AS n FROM time_blocks b
        WHERE b.owner_id = ? AND b.task_id IS NOT NULL AND b.block_kind != 'meeting'
          AND b.start_at >= ? AND b.start_at < ?`,
    )
    .get<{ n: number }>(owner, dayStart, dayEnd)))!.n;

  const completed = ((await store()
    .prepare(
      `SELECT COUNT(DISTINCT b.task_id) AS n FROM time_blocks b
         JOIN tasks t ON t.id = b.task_id
        WHERE b.owner_id = ? AND b.block_kind != 'meeting'
          AND b.start_at >= ? AND b.start_at < ?
          AND t.status = 'done' AND t.completed_at >= ? AND t.completed_at < ?`,
    )
    .get<{ n: number }>(owner, dayStart, dayEnd, dayStart, dayEnd)))!.n;

  const outcomeRows = await store()
    .prepare(
      `SELECT outcome, COUNT(*) AS n FROM daily_plan
        WHERE owner_id = ? AND date = ? AND outcome IS NOT NULL GROUP BY outcome`,
    )
    .all<{ outcome: string; n: number }>(owner, date);
  const outcomes = { deferred: 0, missed: 0 };
  for (const r of outcomeRows) {
    if (r.outcome === 'deferred') outcomes.deferred = r.n;
    else if (r.outcome === 'missed') outcomes.missed = r.n;
  }

  const estimate_deltas = (await store()
    .prepare(
      `SELECT id AS task_id, title, estimated_minutes, actual_minutes,
              (actual_minutes - estimated_minutes) AS delta_minutes
         FROM tasks
        WHERE owner_id = ? AND status = 'done'
          AND completed_at >= ? AND completed_at < ?
          AND estimated_minutes > 0 AND actual_minutes > 0
        ORDER BY ABS(actual_minutes - estimated_minutes) DESC LIMIT 10`,
    )
    .all<EstimateDelta>(owner, dayStart, dayEnd));

  const carry_forward = await store()
    .prepare(
      `SELECT DISTINCT t.id AS task_id, t.title, t.status FROM time_blocks b
         JOIN tasks t ON t.id = b.task_id
        WHERE b.owner_id = ? AND b.block_kind != 'meeting'
          AND b.start_at >= ? AND b.start_at < ?
          AND t.status IN ('open', 'scheduled', 'in_progress')
        ORDER BY t.title LIMIT 10`,
    )
    .all<{ task_id: string; title: string; status: string }>(owner, dayStart, dayEnd);

  // Label the scope refs so the modal never shows raw ids (shared with the Z6 chip).
  const calibrationRows = await store()
    .prepare(
      `SELECT scope_kind, scope_ref, bias_ratio, sample_count FROM estimate_calibration
        WHERE owner_id = ? AND sample_count >= ?
        ORDER BY sample_count DESC, scope_kind, scope_ref LIMIT 5`,
    )
    .all<{ scope_kind: string; scope_ref: string; bias_ratio: number | null; sample_count: number }>(owner, CONFIDENCE_FLOOR);
  // An explicit loop rather than `.map`: scopeLabel is async now, so mapping would put
  // a Promise in `label` where the payload type promises a string. Bounded at 5 rows.
  const calibration: (typeof calibrationRows[number] & { label: string })[] = [];
  for (const r of calibrationRows) {
    calibration.push({ ...r, label: await scopeLabel(owner, r.scope_kind as ScopeKind, r.scope_ref) });
  }

  return {
    date,
    planned,
    completed,
    outcomes,
    estimate_deltas,
    carry_forward,
    calibration,
    combo_suggestions: await detectComboSuggestions(owner),
  };
}

export function fallbackEveningProse(p: EveningPayload, memoryExcerpt = ''): string {
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
  // AA2 — tomorrow's life context, empty-string-safe (see fallbackProse).
  if (memoryExcerpt) lines.push(memoryExcerpt);
  return lines.join('\n');
}

function buildEveningPrompt(p: EveningPayload, memoryExcerpt = ''): string {
  const deltas =
    p.estimate_deltas
      .map((d) => `- "${d.title}": estimated ${d.estimated_minutes}m, took ${d.actual_minutes}m`)
      .join('\n') || '(none)';
  const carries = p.carry_forward.map((c) => `- ${c.title}`).join('\n') || '(none)';
  const cal =
    p.calibration
      .map((c) => `- ${c.label}: bias ${c.bias_ratio?.toFixed(2)} over ${c.sample_count} samples`)
      .join('\n') || '(none)';

  // AA2 — life context appended empty-string-safe (see buildPrompt).
  const life = memoryExcerpt ? `\n\nFrom your life context (mention naturally if relevant):\n${memoryExcerpt}` : '';

  return `Write a short, calm evening reflection (3-5 sentences, no bullet lists, no preamble, no praise-words) on this day.
State what got done vs planned, name the biggest estimate miss if there is one, and end with one plain sentence about what carries into tomorrow.

Date: ${p.date}
Planned task blocks: ${p.planned}; completed: ${p.completed}; deferred: ${p.outcomes.deferred}; missed: ${p.outcomes.missed}

Estimate deltas today:
${deltas}

Carrying forward:
${carries}

Current estimate bias by scope:
${cal}${life}`;
}

export interface EveningSummary {
  date: string;
  prose: string;
  llm: boolean;
  payload: EveningPayload;
}

export interface MorningCarryover {
  /** Yesterday's date (the EOD Alignment folded into this morning's Brief). */
  date: string;
  /** Yesterday's evening narrative if the user opened the modal; null → degrade to carry_forward only. */
  prose: string | null;
  /** Yesterday's incomplete tasks (§2.7 "fill incomplete-first") — always available. */
  carry_forward: { task_id: string; title: string; status: string }[];
}

/**
 * Phase Z · Z2 — the morning Daily Brief's fold-in of last night's EOD Alignment.
 * Computed OUTSIDE summarizeDay's cache (which is keyed on today's inputs only),
 * so it's always fresh and never couples the cached prose to yesterday's state.
 * Degrades gracefully: no evening row (modal never opened) → prose null, but the
 * deterministic carry_forward still surfaces (§2.6/§2.7 — the Brief never blocks
 * on an Alignment having been written).
 */
export async function morningCarryover(date: string): Promise<MorningCarryover> {
  const yesterday = addDays(date, -1);
  const row = await store()
    .prepare(
      `SELECT body FROM reflections WHERE owner_id = ? AND kind = 'evening' AND period_key = ? AND position = 0`,
    )
    .get<{ body: string }>(currentOwnerId(), yesterday);
  return {
    date: yesterday,
    prose: row?.body ?? null,
    carry_forward: (await gatherEvening(yesterday)).carry_forward,
  };
}

/**
 * Compose the EOD Alignment narrative. Mirrors summarizeDay's degradation
 * contract: Ollama down / empty output → deterministic fallback, never a throw.
 * Persistence is the CALLER's job (the reflections route writes the row on
 * modal open) — this function is pure compute.
 */
export async function summarizeEvening(date: string): Promise<EveningSummary> {
  const payload = await gatherEvening(date);
  // AA2 — the EOD reflection ends on "what carries into tomorrow", so the useful memory
  // context is TOMORROW's events. '' when the flag is off / connector is down, keeping
  // the evening facts + fallback byte-identical to pre-AA2.
  const memoryExcerpt = await memoryBriefExcerpt(currentOwnerId(), addDays(date, 1));
  // Phase Z · Z7 — the EOD narrative goes through the Voice loop too (one voice, no
  // repeats). summarizeEvening is Time-Sense-only code, reached solely via the
  // flag-gated POST /evening/open (an authoring action, so recording a copy_history
  // signature here doesn't touch the pure-read GET path). Ollama-down-safe: the
  // deterministic fallbackEveningProse is passed as `fallback`.
  const copy = await renderCopy('eod_alignment', {
    facts: buildEveningPrompt(payload, memoryExcerpt),
    fallback: fallbackEveningProse(payload, memoryExcerpt),
  });
  return { date, prose: copy.text, llm: copy.source === 'model', payload };
}
