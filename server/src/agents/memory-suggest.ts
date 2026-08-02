import { store } from '../db/store.js';
import { currentOwnerId } from '../lib/context.js';
import { serverTimezone, localDateInTZ, utcToZonedWallTime } from '../lib/tz.js';
import { logger } from '../lib/logger.js';
import { generateJson, OllamaUnavailable } from '../mcp/ollama.js';
import {
  graphData,
  nodeStartTime,
  MemoryUnavailable,
  type MemoryGraph,
  type MemoryNode,
} from '../connectors/memory.js';
import { memoryConnectorAvailable, memoryWindowMs } from '../services/memory.js';
import { CONFIDENCE_FLOOR } from '../services/calibration.js';
import { upsertPossible } from './ingest.js';
import { promoteAllPending } from '../services/possibles.js';
import type { ExtractedTask } from './extract.js';

/**
 * Phase AA · AA1 — memory suggestion agent. Pulls the owner's upcoming CI-Server
 * memory graph (events + participants) over `scheduling_prefs.memory_window_days`
 * (0147; default 2 = the 48h this agent used to hardcode) and stages candidate tasks
 * as possible_tasks
 * via the existing `upsertPossible()` seam. AF-3: at the end of each run the batch is
 * auto-promoted (`promoteAllPending`) — every staged suggestion becomes a real task
 * immediately; possible_tasks remains as the dedup/audit trail.
 *
 * Phase AB · AB2 — suggestions MIRROR the event: title = the event name, start
 * intent (proposed_scheduled_for/task_time) = the event start in the owner's
 * timezone, estimate = the event duration (end−start when known, else 30m), and
 * due_at = the event start as a deadline only. On promote the intent lands on the
 * task and AB1 places its block at the event's exact time on its day.
 *
 * Drafting is deterministic templates first; an optional Ollama polish pass refines
 * titles/summaries but NEVER blocks: any polish failure (Ollama down, bad JSON)
 * degrades to the templates (the OllamaUnavailable contract).
 *
 * Guards: gated on scheduling_prefs.memory_pull_enabled AND connector availability;
 * a source_ref whose possible was dismissed is TERMINAL (never re-staged); at most
 * MEMORY_PENDING_CAP pending memory possibles per owner; idempotent re-runs
 * (upsertPossible keys on (proposed_owner_id, source_kind, source_ref) — owner-scoped,
 * 0114: in fixture mode all owners share graph.json, so refs collide across owners).
 */

/** Max PENDING possibles with source_kind='memory' per owner — new staging stops here. */
export const MEMORY_PENDING_CAP = 5;

export const MEMORY_SOURCE_KIND = 'memory';

export interface MemorySuggestResult {
  status: 'ran' | 'flag_off' | 'unavailable';
  /** Event candidates found in the window. */
  pulled: number;
  created: number;
  updated: number;
  skippedDismissed: number;
  skippedCap: number;
  /** AF-3: pending possibles auto-promoted into tasks at the end of this run. */
  promoted: number;
  /** AF-CU1: possibles the batch's inline semantic dedupe marked 'duplicate' — count
   *  parity with IngestResult so `created > promoted` runs are explainable. */
  duplicates: number;
  /** AF-CU1: possibles whose promote threw (poison isolation) — left pending for the
   *  nightly sweeper / manual triage. */
  failed: number;
}

interface EventCandidate {
  node: MemoryNode;
  start: string; // ISO
  end: string | null; // ISO — drives the mirrored duration estimate (AB2)
  people: string[];
}

/** A polish pass over the drafted tasks. Injectable for tests; default = Ollama. */
export type PolishFn = (
  candidates: EventCandidate[],
  drafts: Map<string, ExtractedTask>,
) => Promise<Map<string, Partial<ExtractedTask>>>;

function skipped(status: 'flag_off' | 'unavailable'): MemorySuggestResult {
  return { status, pulled: 0, created: 0, updated: 0, skippedDismissed: 0, skippedCap: 0, promoted: 0, duplicates: 0, failed: 0 };
}

async function pullEnabled(owner: string): Promise<boolean> {
  const row = await store()
    .prepare(`SELECT memory_pull_enabled FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ memory_pull_enabled?: number }>(owner);
  return !!row?.memory_pull_enabled;
}

/** First parseable event END timestamp on a node, or null (mirror of nodeStartTime). */
function nodeEndTime(node: MemoryNode): string | null {
  for (const k of ['end_time', 'endTime', 'end']) {
    const v = node.properties[k];
    if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  }
  return null;
}

/** Upcoming event nodes in [from,to] with their linked person names. */
function eventCandidates(graph: MemoryGraph, from: string, to: string): EventCandidate[] {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: EventCandidate[] = [];
  const blankIdNames: string[] = [];
  for (const node of graph.nodes) {
    if (node.entityType.toLowerCase() !== 'event') continue;
    // A malformed node maps to id '' (connector fallback) → source_ref 'ci:' — the
    // SAME ref for every such node AND every owner. Skip it; never stage on a blank id.
    if (!node.id.trim()) {
      blankIdNames.push(node.name || '(unnamed)');
      continue;
    }
    const start = nodeStartTime(node);
    if (!start || start < from || start > to) continue;
    const people: string[] = [];
    for (const l of graph.links) {
      const otherId = l.source === node.id ? l.target : l.target === node.id ? l.source : null;
      if (!otherId) continue;
      const other = byId.get(otherId);
      if (other && other.entityType.toLowerCase() === 'person' && other.name) people.push(other.name);
    }
    out.push({ node, start, end: nodeEndTime(node), people });
  }
  if (blankIdNames.length) {
    logger.warn('memory suggest: skipped event node(s) with a blank id', { names: blankIdNames });
  }
  // Soonest first — when the cap bites, the nearest events win the pending slots.
  return out.sort((a, b) => a.start.localeCompare(b.start));
}

/** The last-resort estimate when an event has no duration and there's no usable history. */
const DEFAULT_ESTIMATE_MIN = 30;

/** Median (index-quantile, matching calibration.ts's `quantile`) of a numeric list. */
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const idx = Math.min(Math.max(0, Math.round(0.5 * (s.length - 1))), s.length - 1);
  return s[idx];
}

/**
 * AA3b — a better default estimate (minutes) for a memory-drafted task when the event
 * carries no scheduled duration (the common case: CI-Server rarely records an end).
 *
 * Uses the owner's TYPICAL ACTUAL task length — not calibration's ratios (which capture
 * estimate BIAS, not absolute duration, and so can't answer "how long is this task"):
 *   1. median actual_minutes over the owner's DONE memory-sourced tasks ("your meetings
 *      run ~50m") — the closest population; memory drafts are untagged, so tag/subtype
 *      scopes don't apply,
 *   2. else the global median over ALL their done tasks,
 * each gated by CONFIDENCE_FLOOR samples so a couple of outliers can't set the prior,
 *   3. else the historical DEFAULT_ESTIMATE_MIN.
 * Reads actual_minutes (timer truth) only; suggest-only — this seeds a possible's
 * proposed estimate the user still reviews, exactly as the flat default did.
 */
export async function memoryFallbackEstimate(owner: string): Promise<number> {
  const actuals = async (memoryOnly: boolean): Promise<number[]> =>
    (await store()
      .prepare(
        `SELECT actual_minutes AS m FROM tasks
          WHERE owner_id = ? AND status = 'done' AND actual_minutes > 0`
          + (memoryOnly ? ` AND source_kind = ?` : ``),
      )
      .all<{ m: number }>(...(memoryOnly ? [owner, MEMORY_SOURCE_KIND] : [owner]))).map((r) => r.m);

  const mem = await actuals(true);
  if (mem.length >= CONFIDENCE_FLOOR) return Math.round(median(mem));
  const glob = await actuals(false);
  if (glob.length >= CONFIDENCE_FLOOR) return Math.round(median(glob));
  return DEFAULT_ESTIMATE_MIN;
}

/**
 * Deterministic template draft — always produced, with or without Ollama.
 *
 * AB2 mirror framing: the suggestion IS the event (title = event name, start intent =
 * the event's start in the owner's timezone, estimate = the event's duration), not a
 * "Prep for X" satellite task. due_at = the event start too, but as a DEADLINE only —
 * scheduled_for/task_time are what pick the block's day/time (AB1).
 *
 * AA3b: `fallbackMin` (the owner's typical actual duration) is used ONLY when the event
 * has no scheduled duration — a real end−start is the event's own truth and always wins.
 */
function templateTask(c: EventCandidate, tz: string, fallbackMin: number): ExtractedTask {
  const parts = [
    c.node.description ?? '',
    c.people.length ? `With ${c.people.join(', ')}` : '',
    `Starts ${c.start}`,
  ].filter(Boolean);
  const durationMin = c.end ? Math.round((Date.parse(c.end) - Date.parse(c.start)) / 60_000) : 0;
  return {
    title: c.node.name.slice(0, 200),
    summary: parts.join(' · ').slice(0, 500) || undefined,
    priority: 3,
    dueAt: c.start,
    scheduledFor: localDateInTZ(c.start, tz),
    taskTime: utcToZonedWallTime(c.start, tz),
    // Event duration when the end is known; else the AA3b history-based fallback. Without
    // an estimate, promote leaves the task estimate-less and the hands-off auto-schedule
    // (requireEstimate) can never place a start-less item (TM-5).
    estimatedMinutes: durationMin > 0 ? durationMin : fallbackMin,
    tags: [],
    confidence: 0.6,
  };
}

/**
 * Default polish: one small-tier Ollama call over the whole batch refining
 * title/summary/priority/confidence. Throws (OllamaUnavailable or parse error);
 * the caller degrades to templates.
 */
async function ollamaPolish(
  candidates: EventCandidate[],
  drafts: Map<string, ExtractedTask>,
): Promise<Map<string, Partial<ExtractedTask>>> {
  const items = candidates.map((c) => ({
    ref: c.node.id,
    event: c.node.name,
    description: c.node.description ?? '',
    start: c.start,
    people: c.people,
    draftTitle: drafts.get(c.node.id)?.title ?? '',
  }));
  const prompt = `You refine draft tasks that MIRROR upcoming calendar events in a personal planner.
Each task represents attending the event itself (scheduled at the event's time), so the title must stay
recognizably the event's name (you may lightly clarify it, but do NOT reframe it as a preparation task).
For each item, write a one-sentence summary. priority: 1=urgent .. 5=someday (default 3). confidence: 0..1.

Items:
${JSON.stringify(items)}

Respond ONLY with JSON in exactly this shape:
{"tasks":[{"ref":"...","title":"...","summary":"...","priority":3,"confidence":0.7}]}`;
  const raw = await generateJson<{ tasks?: { ref?: string; title?: string; summary?: string; priority?: number; confidence?: number }[] }>(
    prompt,
    { tier: 'small', timeoutMs: 30_000 },
  );
  const out = new Map<string, Partial<ExtractedTask>>();
  for (const t of raw.tasks ?? []) {
    if (!t.ref || typeof t.title !== 'string' || !t.title.trim()) continue;
    out.set(t.ref, {
      title: t.title.trim().slice(0, 200),
      summary: typeof t.summary === 'string' ? t.summary.trim().slice(0, 500) : undefined,
      priority:
        typeof t.priority === 'number' && Number.isFinite(t.priority)
          ? Math.min(5, Math.max(1, Math.round(t.priority)))
          : undefined,
      confidence: typeof t.confidence === 'number' ? Math.min(1, Math.max(0, t.confidence)) : undefined,
    });
  }
  return out;
}

/**
 * Run one suggestion pass for the current owner. Returns 'flag_off' / 'unavailable'
 * without touching the DB when gated; otherwise stages possibles and auto-promotes
 * the batch (AF-3), reporting counts. `opts.polish`: false disables the LLM pass
 * (deterministic tests); a function injects a custom polisher. `opts.embedFn` is
 * threaded to the inline dedupe inside promoteAllPending (same injectable-for-tests
 * idiom as dedupePossibles — avoids cross-file module mocks).
 */
export async function suggestFromMemory(
  opts: { polish?: PolishFn | false; embedFn?: (text: string) => Promise<number[]> } = {},
): Promise<MemorySuggestResult> {
  const owner = currentOwnerId();
  if (!(await pullEnabled(owner))) return skipped('flag_off');
  if (!memoryConnectorAvailable(owner)) return skipped('unavailable');

  const from = new Date().toISOString();
  const to = new Date(Date.now() + memoryWindowMs(owner)).toISOString();
  let graph: MemoryGraph;
  try {
    graph = await graphData(owner, { from, to });
  } catch (err) {
    if (err instanceof MemoryUnavailable) {
      logger.warn('memory suggest: CI-Server unavailable — skipping', { err: err.message });
      return skipped('unavailable');
    }
    throw err;
  }

  const candidates = eventCandidates(graph, from, to);
  const result: MemorySuggestResult = {
    status: 'ran',
    pulled: candidates.length,
    created: 0,
    updated: 0,
    skippedDismissed: 0,
    skippedCap: 0,
    promoted: 0,
    duplicates: 0,
    failed: 0,
  };
  if (candidates.length === 0) return result;

  // Owner timezone: the mirrored scheduled_for/task_time are the event start's
  // wall-clock in the OWNER's zone (blocks store UTC; intent columns store local).
  const tz =
    (await store().prepare(`SELECT timezone FROM scheduling_prefs WHERE owner_id = ?`).get<{ timezone: string | null }>(owner))
      ?.timezone || serverTimezone();

  // AA3b: the owner's typical actual duration — computed ONCE per run (owner-scoped, same
  // for every candidate), used only for events that carry no scheduled duration.
  const fallbackMin = await memoryFallbackEstimate(owner);
  const drafts = new Map(candidates.map((c) => [c.node.id, templateTask(c, tz, fallbackMin)]));

  // Optional polish — best-effort by contract. OllamaUnavailable is the expected
  // degrade; a parse/shape failure is equally non-fatal for a cosmetic pass.
  if (opts.polish !== false) {
    const polish = opts.polish ?? ollamaPolish;
    try {
      const refined = await polish(candidates, drafts);
      for (const [ref, patch] of refined) {
        const base = drafts.get(ref);
        if (base) drafts.set(ref, { ...base, ...patch });
      }
    } catch (err) {
      const level = err instanceof OllamaUnavailable ? 'warn' : 'error';
      logger[level]('memory suggest: polish failed — using templates', { err: (err as Error).message });
    }
  }

  let pending = (
    (await store()
      .prepare(
        `SELECT COUNT(*) AS n FROM possible_tasks
          WHERE proposed_owner_id = ? AND source_kind = ? AND status = 'pending'`,
      )
      .get<{ n: number }>(owner, MEMORY_SOURCE_KIND))!
  ).n;

  for (const c of candidates) {
    const ref = `ci:${c.node.id}`;
    // Owner-scoped (0114): another owner's dismissed/pending row on the same fixture
    // ref must neither suppress this owner's suggestion nor be overwritten by it.
    const existing = await store()
      .prepare(`SELECT status FROM possible_tasks WHERE proposed_owner_id = ? AND source_kind = ? AND source_ref = ?`)
      .get<{ status: string }>(owner, MEMORY_SOURCE_KIND, ref);
    if (existing && existing.status !== 'pending') {
      // dismissed is TERMINAL for a source_ref; promoted/other settled possibles are
      // never rewritten either — the suggestion already ran its course.
      if (existing.status === 'dismissed') result.skippedDismissed++;
      continue;
    }
    if (!existing && pending >= MEMORY_PENDING_CAP) {
      result.skippedCap++;
      continue;
    }
    const task = drafts.get(c.node.id) ?? templateTask(c, tz, fallbackMin);
    const outcome = await upsertPossible(task, MEMORY_SOURCE_KIND, ref, {
      node: c.node,
      participants: c.people,
      start: c.start,
    });
    if (outcome === 'created') {
      result.created++;
      pending++;
    } else {
      result.updated++;
    }
  }

  // AF-3: auto-promote the batch (dedupe → promote ALL of this owner's pending
  // possibles) — the accepted suggestion becomes a real task with no Inbox stop; the
  // start intent places its block at the event time via the AB1 hook inside.
  const batch = await promoteAllPending(owner, { embedFn: opts.embedFn });
  result.promoted = batch.promoted;
  result.duplicates = batch.duplicates;
  result.failed = batch.failed;

  logger.info('memory suggest done', { ...result });
  return result;
}
