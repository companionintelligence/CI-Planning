/**
 * Settings → Learning: remembering a clear for the rest of the browser session.
 *
 * The three readouts that can be cleared (classification, dismissal, placement) say how many
 * examples or preferences were stored AS OF THE LAST MONDAY PASS. A clear changes the live
 * index but writes no row, so the wire cannot tell the client that it happened. Without a
 * memory here, an owner who clears, opens Profile and comes back to Learning (a fresh mount,
 * a fresh read) is told again that the model can draw on the old count, and is offered the
 * same button.
 *
 * So each successful clear is remembered as its local date, and the tile builders let it
 * override the Monday figure until a reading dated on or after the clear arrives. Nothing
 * here is trusted for anything but wording: the server stays the authority, and a click that
 * finds nothing left is answered "Nothing to clear".
 *
 * Kept in sessionStorage (wrapped: it can be missing or throw in a private window, a preview
 * or a thumbnail capture), with a module-level copy as the fallback, and tied to the account
 * that looked: a different owner in the same tab sees none of it.
 *
 * The same record also remembers that a clear was REFUSED (403: a read-only credential). The
 * panel turns every clear off when that happens, and without a memory here a reopen of the tab
 * would offer the buttons again and the next click would be refused again. Like the clears, it
 * lasts for the browser session and belongs to the account that looked.
 *
 * Same-day edge, on purpose: a clear dated the same day as a reading counts as AFTER it. The
 * passes run in the small hours of Monday, so an owner who opens the tab on Monday and clears
 * has cleared after the pass. The rare opposite order (a clear before the pass that same
 * night) shows "Cleared" until the next Monday; the sentence says when it was cleared, and
 * the next reading replaces it.
 *
 * Pure of Solid and the DOM, so it runs in the fast node project.
 */

import { daysBetween, dayNumber } from './learning-stats.js';

/** The loops that have a clear button. Plan loop has none, by design. */
export type ClearableLoop = 'classification' | 'dismissal' | 'placement';

/** Loop to the local date (YYYY-MM-DD) of the owner's last successful clear. */
export type ClearedOn = Partial<Record<ClearableLoop, string>>;

/** The slice of Storage this module needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface ClearedMemory {
  /** Who is looking. Records written for another owner are ignored, never shown. */
  bind(owner: string): void;
  remember(loop: ClearableLoop, date: string): void;
  recall(): ClearedOn;
  /** A clear was answered 403. From now on this account is offered no clear this session. */
  markForbidden(): void;
  isForbidden(): boolean;
  /** Drop everything (used by tests, and available to a sign-out). */
  forget(): void;
}

const KEY = 'planning.learning.cleared.v1';
const LOOPS: readonly ClearableLoop[] = ['classification', 'dismissal', 'placement'];

interface Saved {
  owner: string;
  loops: ClearedOn;
  forbidden: boolean;
}

/** Only well-formed entries survive a read, so a hand-edited value cannot reach the copy. */
function clean(loops: unknown): ClearedOn {
  const out: ClearedOn = {};
  if (!loops || typeof loops !== 'object') return out;
  for (const loop of LOOPS) {
    const v = (loops as Record<string, unknown>)[loop];
    if (typeof v === 'string' && dayNumber(v) !== null) out[loop] = v;
  }
  return out;
}

export function createClearedMemory(getStorage: () => StorageLike | null): ClearedMemory {
  let owner = '';
  // Used when storage is missing or throws, so the memory still lasts until a reload.
  let fallback: Saved | null = null;

  const storage = (): StorageLike | null => {
    try {
      return getStorage();
    } catch {
      return null;
    }
  };

  function read(): Saved | null {
    const s = storage();
    if (s) {
      try {
        const raw = s.getItem(KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as { owner?: unknown; loops?: unknown; forbidden?: unknown };
          if (typeof parsed.owner === 'string') {
            return { owner: parsed.owner, loops: clean(parsed.loops), forbidden: parsed.forbidden === true };
          }
        }
      } catch {
        // Fall through to the module copy.
      }
    }
    return fallback;
  }

  function write(rec: Saved): void {
    fallback = rec;
    const s = storage();
    if (!s) return;
    try {
      s.setItem(KEY, JSON.stringify(rec));
    } catch {
      // Quota or a blocked store: the module copy above still holds it.
    }
  }

  return {
    bind(next) {
      owner = next;
    },
    remember(loop, date) {
      if (dayNumber(date) === null) return;
      const rec = read();
      const mine = rec && rec.owner === owner ? rec : null;
      write({ owner, loops: { ...(mine?.loops ?? {}), [loop]: date }, forbidden: mine?.forbidden ?? false });
    },
    recall() {
      const rec = read();
      return rec && rec.owner === owner ? { ...rec.loops } : {};
    },
    markForbidden() {
      const rec = read();
      const mine = rec && rec.owner === owner ? rec : null;
      write({ owner, loops: mine?.loops ?? {}, forbidden: true });
    },
    isForbidden() {
      const rec = read();
      return rec !== null && rec.owner === owner && rec.forbidden;
    },
    forget() {
      fallback = null;
      const s = storage();
      if (!s) return;
      try {
        s.setItem(KEY, JSON.stringify({ owner, loops: {}, forbidden: false }));
      } catch {
        // Nothing more to do.
      }
    },
  };
}

function browserStorage(): StorageLike | null {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage;
}

/** The one instance the panel and the card frame share. */
export const clearedMemory: ClearedMemory = createClearedMemory(browserStorage);

/**
 * Was the clear on or after the reading? True means the reading's stored count is out of
 * date. False for no clear, or a clear older than the reading (a newer reading already
 * reflects it), or a date that cannot be read.
 */
export function clearedSince(clearedOn: string | undefined, readingDate: string): boolean {
  if (!clearedOn) return false;
  const gap = daysBetween(readingDate, clearedOn);
  return Number.isFinite(gap) && gap >= 0;
}
