/**
 * Pure view logic for the Flight-plan card's tabs: grouping, row flattening,
 * paging, and search filtering. Extracted from FlightPlan.tsx so the paging
 * math is unit-testable without a DOM.
 *
 * Row model: a collapsed routine group is ONE row (its header); an expanded
 * group is its header row plus one row per member item — so expanding a group
 * can push later rows onto the next page.
 */
import { localISODate } from './dates.js';

export const PAGE_SIZE = 10;

/** Structural slice of FlightPlanItem the grouping logic needs. */
export interface Groupable {
  source_kind: string;
  source_ref: string | null;
}

/** Group staged items by their nominating pattern; everything else is solo. */
export function groupFlightPlan<T extends Groupable>(items: T[]): { groups: [string, T[]][]; solo: T[] } {
  const groups = new Map<string, T[]>();
  const solo: T[] = [];
  for (const it of items) {
    if (it.source_kind === 'pattern' && it.source_ref != null) {
      const arr = groups.get(it.source_ref) ?? [];
      arr.push(it);
      groups.set(it.source_ref, arr);
    } else solo.push(it);
  }
  return { groups: [...groups.entries()], solo };
}

/** One renderable row: a group header (carrying its full member list) or an item. */
export type FpRowModel<T> =
  | { kind: 'group'; patternId: string; items: T[]; open: boolean }
  | { kind: 'item'; item: T; inGroup: boolean };

/**
 * Flatten groups + solo items into the row list the pager slices.
 * A closed group contributes only its header row; an open group contributes
 * its header row followed by one row per member.
 */
export function buildRows<T extends Groupable>(
  grouped: { groups: [string, T[]][]; solo: T[] },
  isOpen: (patternId: string) => boolean,
): FpRowModel<T>[] {
  const rows: FpRowModel<T>[] = [];
  for (const [pid, its] of grouped.groups) {
    const open = isOpen(pid);
    rows.push({ kind: 'group', patternId: pid, items: its, open });
    if (open) for (const it of its) rows.push({ kind: 'item', item: it, inGroup: true });
  }
  for (const it of grouped.solo) rows.push({ kind: 'item', item: it, inGroup: false });
  return rows;
}

export interface PagedSlice<T> {
  rows: T[];
  /** The clamped 0-based page actually shown (a stale page index clamps into range). */
  page: number;
  totalPages: number;
  total: number;
  /** Pager chrome is hidden when everything fits on one page. */
  showPager: boolean;
}

/** Slice `rows` to the requested page, clamping the page index into range. */
export function pageSlice<T>(rows: T[], page: number, pageSize = PAGE_SIZE): PagedSlice<T> {
  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const p = Math.min(Math.max(0, page), totalPages - 1);
  return {
    rows: rows.slice(p * pageSize, (p + 1) * pageSize),
    page: p,
    totalPages,
    total,
    showPager: total > pageSize,
  };
}

/** Case-insensitive substring filter over a name/title accessor. Empty query = all. */
export function filterByName<T>(items: T[], query: string, name: (t: T) => string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((t) => name(t).toLowerCase().includes(q));
}

/** 'HH:MM' (local) for the next quarter-hour strictly after `now`; wraps to '00:00' at end of day. */
export function nextQuarterHourHHMM(now: Date = new Date()): string {
  const mins = now.getHours() * 60 + now.getMinutes();
  const next = (Math.floor(mins / 15) * 15 + 15) % (24 * 60);
  return `${String(Math.floor(next / 60)).padStart(2, '0')}:${String(next % 60).padStart(2, '0')}`;
}

/**
 * Default 'HH:MM' for placing a saved block on `day` (an ISO date). Normally the
 * next quarter-hour after `now`, but when that wraps to '00:00' (now ≥ 23:45) and
 * `day` is today-or-earlier, cap at '23:45' — otherwise the time resolves to the
 * *start* of `day`, which is in the past. On a FUTURE day the wrapped '00:00' is a
 * valid start-of-day default and is kept (that day's next quarter-hour).
 */
export function defaultPlaceTimeHHMM(day: string, now: Date = new Date()): string {
  const hhmm = nextQuarterHourHHMM(now);
  if (hhmm === '00:00' && day <= localISODate(now)) return '23:45';
  return hhmm;
}

export function localDayTimeToISO(day: string, hhmm: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  if (!y || !m || !d || Number.isNaN(h) || Number.isNaN(mi)) throw new Error('Invalid day/time');
  return new Date(y, m - 1, d, h, mi, 0, 0).toISOString();
}
