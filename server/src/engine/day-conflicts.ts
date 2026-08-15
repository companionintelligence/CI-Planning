/**
 * Day-type change: stranded tasks, and the reflow the owner confirms (Phase 7).
 *
 * L01 says a directed task is only AUTOSCHEDULED inside its direction's windows.
 * Changing a day's type swaps those windows, so tasks placed under the old ones can
 * end up outside their direction's hours. The app never fixes that silently: it
 * marks them, offers a reflow, shows exactly what would happen, and waits.
 *
 * Detection lives here rather than in the client because the server already owns day
 * types and windows, and duplicating window arithmetic across two packages (there is
 * no shared one) is precisely the drift Phase 6 existed to remove. The client renders
 * what this returns.
 *
 * Exemptions are not special-casing, they are the layer model:
 *  - **L00** synced events answer to no window — the source calendar owns their time.
 *  - **L02 members** answer to their container, not the day's windows: L02 overrides
 *    L01, so a `#work` Time Block at 7pm legitimately holds work past home hours and
 *    its members inherit that exception.
 *  - An **undirected** task has no direction whose windows could strand it.
 *
 * A LOCKED block is NOT exempt from detection — decision 6 says a hand-placed block
 * lands where the owner put it and renders red when out-of-window. It is exempt from
 * being MOVED: the proposal never touches one.
 */

import { store } from '../db/store.js';
import { utcDayBounds } from '../lib/tz.js';
import { ownerTimezone } from './recurrence-generate.js';
import { resolveDayType } from '../services/day-types.js';
import { getPatternBlocks } from '../services/pattern-blocks.js';
import { splitTagString } from '../services/tags.js';

/** Minutes since midnight, local to the owner's day. */
export type Minutes = number;

export interface WindowRange {
  startMin: Minutes;
  endMin: Minutes;
}

/** What conflict detection needs to know about one scheduled block. */
export interface ConflictCandidate {
  id: string;
  startMin: Minutes;
  endMin: Minutes;
  /** Direction names this block answers to. Empty = undirected. */
  directions: string[];
  /** Member of a Time Block drawn on this day (L02 overrides L01). */
  nested: boolean;
  /** Mirrored from a connected calendar (L00). */
  external: boolean;
}

/** Windows for the day, keyed by direction NAME (lowercased by the caller). */
export type WindowsByDirection = Record<string, WindowRange[]>;

const lower = (s: string) => s.trim().toLowerCase();

/** Is [start, end) fully inside at least one of these windows? */
function containedByAny(startMin: Minutes, endMin: Minutes, windows: WindowRange[]): boolean {
  return windows.some((w) => startMin >= w.startMin && endMin <= w.endMin);
}

/**
 * The blocks now sitting outside their direction's windows.
 *
 * Containment, not overlap: a task half inside work hours is still scheduled partly
 * outside them, which is the thing the owner is being asked about. A direction with
 * NO windows on this day type strands every block carrying it — that is the whole
 * Workday→Light-day case, not an edge case.
 *
 * A block carrying several directions needs only ONE of them to accommodate it;
 * requiring all would strand every multi-direction block the moment any one
 * direction's windows shrank.
 */
export function strandedBlocks(
  candidates: ConflictCandidate[],
  windows: WindowsByDirection,
): string[] {
  const byDirection = new Map<string, WindowRange[]>();
  for (const [name, ranges] of Object.entries(windows)) byDirection.set(lower(name), ranges);

  // L01 UNCONFIGURED: not one direction has a window on this day type. That is not a
  // day with no room — it is an owner who has never set windows up, and treating it as
  // stranding would greet a fresh install by declaring every task on the day
  // misplaced. A rule nobody has configured cannot be violated. Note this is NOT the
  // Light-day case: a day type with SOME windows but none for `work` still strands
  // work, which is the whole point of the feature.
  const configured = [...byDirection.values()].some((ranges) => ranges.length > 0);
  if (!configured) return [];

  const out: string[] = [];
  for (const c of candidates) {
    if (c.external || c.nested) continue;
    const dirs = c.directions.map(lower).filter(Boolean);
    if (dirs.length === 0) continue;
    const fits = dirs.some((d) => containedByAny(c.startMin, c.endMin, byDirection.get(d) ?? []));
    if (!fits) out.push(c.id);
  }
  return out;
}

/**
 * Reflow drop order (decision 5): what gets unscheduled first when not everything
 * fits. Lowest task priority goes first — Later/P3 before P2, P1 last — tie-broken by
 * no-due-date first, then shortest estimate.
 *
 * Sorting ASCENDING by this key puts the first thing to drop at index 0.
 */
export interface DropOrderInput {
  /** 1 = P1 … 3 = P3; higher number = dropped sooner. `null`/absent sorts as lowest. */
  priority?: number | null;
  dueAt?: string | null;
  estimatedMinutes?: number | null;
}

export function dropOrderKey(t: DropOrderInput): [number, number, number] {
  // Missing priority is treated as the LOWEST (dropped first): an unprioritised task
  // is not evidence of importance, and keeping it over an explicit P3 would invert
  // the owner's only stated signal.
  const priority = t.priority ?? 99;
  return [-priority, t.dueAt ? 1 : 0, t.estimatedMinutes ?? 0];
}

/** Compare two tasks by drop order — first argument dropped sooner returns < 0. */
export function compareDropOrder(a: DropOrderInput, b: DropOrderInput): number {
  const ka = dropOrderKey(a);
  const kb = dropOrderKey(b);
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return ka[i] - kb[i];
  }
  return 0;
}

// ─── Reading the day ─────────────────────────────────────────────────────────

/** One stranded block, as the banner and the confirm dialog need it. */
export interface DayConflict {
  block_id: string;
  task_id: string | null;
  title: string;
  start_at: string;
  end_at: string;
  directions: string[];
  /** Locked blocks are shown but never moved (decision 6). */
  is_locked: boolean;
}

export interface DayConflictReport {
  date: string;
  day_type: string;
  conflicts: DayConflict[];
}

interface DayBlockRow {
  id: string; task_id: string | null; title: string;
  start_at: string; end_at: string; tag: string | null;
  block_kind: string; is_locked: number; parent_block_id: string | null;
}

/** `"09:30"` → 570. NaN for anything unparseable, so callers can drop it explicitly. */
export function hhmmToMin(v: string): Minutes {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(v).trim());
  if (!m) return Number.NaN;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return Number.NaN;
  return h * 60 + min;
}

/** The day's TIMED, live blocks — the universe conflict detection looks at. */
async function dayBlocks(owner: string, date: string, tz: string): Promise<DayBlockRow[]> {
  const { start, end } = utcDayBounds(date, tz);
  return await store()
    .prepare(
      `SELECT id, task_id, title, start_at, end_at, tag, block_kind, is_locked, parent_block_id
         FROM time_blocks
        WHERE owner_id = ? AND COALESCE(all_day, 0) = 0
          AND COALESCE(block_type, '') != 'someday'
          AND start_at < ? AND end_at > ?
          AND status NOT IN ('completed', 'skipped', 'cancelled', 'missed')`,
    )
    .all<DayBlockRow>(owner, end, start);
}

/** Batched task → level-1 direction names (no N+1 over the day). */
async function directionsByTask(owner: string, taskIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (taskIds.length === 0) return out;
  const rows = await store()
    .prepare(
      `SELECT et.entity_id AS task_id, tg.name
         FROM entity_tags et JOIN tags tg ON tg.id = et.tag_id
        WHERE et.entity_kind = 'task' AND et.level = 1 AND tg.kind = 'direction'
          AND tg.owner_id = ? AND et.entity_id IN (${taskIds.map(() => '?').join(',')})`,
    )
    .all<{ task_id: string; name: string }>(owner, ...taskIds);
  for (const r of rows) out.set(r.task_id, [...(out.get(r.task_id) ?? []), r.name]);
  return out;
}

/** Block ids mirrored in from a connected calendar (L00). */
async function externalBlockIds(owner: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await store()
    .prepare(
      `SELECT block_id FROM external_events
        WHERE owner_id = ? AND direction = 'inbound' AND block_id IN (${ids.map(() => '?').join(',')})`,
    )
    .all<{ block_id: string }>(owner, ...ids);
  return new Set(rows.map((r) => r.block_id));
}

/**
 * The day's windows keyed by direction NAME rather than tag id.
 *
 * A malformed `start_time`/`end_time` is DROPPED rather than carried through as NaN:
 * a NaN window contains nothing, so leaving it in would silently strand every block
 * of that direction and read as "the day type has no work hours".
 */
export async function windowsForDate(owner: string, date: string): Promise<WindowsByDirection> {
  const dayType = await resolveDayType(owner, date);
  const byId = await getPatternBlocks(owner, dayType);
  const names = new Map(
    (await store()
      .prepare(`SELECT id, name FROM tags WHERE owner_id = ? AND kind = 'direction'`)
      .all<{ id: string; name: string }>(owner)).map((r) => [r.id, r.name]),
  );
  const out: WindowsByDirection = {};
  for (const [dirId, ranges] of Object.entries(byId)) {
    const name = names.get(dirId);
    if (!name) continue;
    out[name.toLowerCase()] = ranges
      .map((r) => ({ startMin: hhmmToMin(r.start_time), endMin: hhmmToMin(r.end_time) }))
      .filter((r) => Number.isFinite(r.startMin) && Number.isFinite(r.endMin) && r.endMin > r.startMin);
  }
  return out;
}

/** Minutes-since-local-midnight for an ISO instant on the day starting at `dayStartMs`. */
function minutesInto(iso: string, dayStartMs: number): Minutes {
  return Math.round((Date.parse(iso) - dayStartMs) / 60_000);
}

/**
 * Which of the day's task blocks now sit outside their direction's windows.
 *
 * A block's direction is its own `tag` when it carries one, else its task's level-1
 * direction tags — the same rule auto-nest uses, so what nests and what strands agree.
 *
 * Only `block_kind='task'` blocks are candidates, per the plan. That already excludes
 * every L00 mirror (they land as `meeting`), but `external` is still resolved from the
 * real `external_events` mapping rather than assumed: a vacuous exemption is one that
 * stops being true without anyone noticing.
 */
export async function detectDayConflicts(owner: string, date: string): Promise<DayConflictReport> {
  const tz = await ownerTimezone(owner);
  const dayType = await resolveDayType(owner, date);
  const rows = await dayBlocks(owner, date, tz);
  const containerIds = new Set(rows.filter((r) => r.block_kind === 'timeblock').map((r) => r.id));
  const taskRows = rows.filter((r) => r.block_kind === 'task');
  if (taskRows.length === 0) return { date, day_type: dayType, conflicts: [] };

  const [dirsByTask, external, windows] = await Promise.all([
    directionsByTask(owner, [...new Set(taskRows.map((r) => r.task_id).filter((t): t is string => !!t))]),
    externalBlockIds(owner, taskRows.map((r) => r.id)),
    windowsForDate(owner, date),
  ]);

  const dayStartMs = Date.parse(utcDayBounds(date, tz).start);
  const candidates: ConflictCandidate[] = taskRows.map((r) => {
    const own = splitTagString(r.tag);
    return {
      id: r.id,
      startMin: minutesInto(r.start_at, dayStartMs),
      endMin: minutesInto(r.end_at, dayStartMs),
      directions: own.length ? own : (r.task_id ? dirsByTask.get(r.task_id) ?? [] : []),
      nested: r.parent_block_id != null && containerIds.has(r.parent_block_id),
      external: external.has(r.id),
    };
  });

  const stranded = new Set(strandedBlocks(candidates, windows));
  const dirOf = new Map(candidates.map((c) => [c.id, c.directions]));
  return {
    date,
    day_type: dayType,
    conflicts: taskRows
      .filter((r) => stranded.has(r.id))
      .map((r) => ({
        block_id: r.id,
        task_id: r.task_id,
        title: r.title,
        start_at: r.start_at,
        end_at: r.end_at,
        directions: dirOf.get(r.id) ?? [],
        is_locked: r.is_locked === 1,
      }))
      .sort((a, b) => a.start_at.localeCompare(b.start_at)),
  };
}
