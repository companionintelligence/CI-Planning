/**
 * Shell state for the drawer layout: the collapsible left navigation rail and the
 * docked, resizable details drawer on the right.
 *
 * Deliberately NOT a second selection store. What the details drawer describes is
 * `activeTask` / `activeBlock` from `selection.ts` — the "expanded entity" concept the
 * Planner already had. This module owns only the chrome around it (open/closed,
 * collapsed, width, which drawer tab), so there is one answer to "what is selected?"
 * rather than two that can disagree.
 *
 * All four values persist to localStorage: a rail you collapsed and a width you
 * dragged are preferences, and losing them on every reload makes the controls feel
 * broken. Reads are defensive — private mode throws on access, and a stored width
 * from an older build must not be able to wedge the drawer off-screen. The one
 * exception is whether the drawer is open on a phone, which is not a preference
 * (see "Right details drawer").
 */
import { createSignal } from 'solid-js';

const KEY = {
  nav: 'ci-planner.nav-collapsed',
  open: 'ci-planner.details-open',
  width: 'ci-planner.details-width',
} as const;

/** Width bounds for the details drawer, in px. Also clamps anything restored. */
export const DETAILS_MIN_W = 300;
export const DETAILS_MAX_W = 720;
export const DETAILS_DEFAULT_W = 400;

/** The layout breakpoint index.css turns the drawer into a bottom sheet at (Tailwind's `md`, 768px, from below). */
const PHONE_QUERY = '(max-width: 767px)';

/** Is the page laid out as a phone? Read when asked, not cached: the answer is only used for what to do now. */
function isPhone(): boolean {
  try {
    return typeof window !== 'undefined' && window.matchMedia?.(PHONE_QUERY).matches === true;
  } catch {
    return false;
  }
}

function readBool(key: string, fallback: boolean): boolean {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : raw === 'true';
  } catch {
    return fallback;
  }
}

function readWidth(): number {
  try {
    const n = Number(localStorage.getItem(KEY.width));
    if (!Number.isFinite(n) || n <= 0) return DETAILS_DEFAULT_W;
    return Math.min(DETAILS_MAX_W, Math.max(DETAILS_MIN_W, Math.round(n)));
  } catch {
    return DETAILS_DEFAULT_W;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode — the preference just does not persist */
  }
}

// ── Left navigation rail ──────────────────────────────────────────────────
const [navCollapsed, setNavCollapsedSignal] = createSignal(readBool(KEY.nav, false));
export { navCollapsed };

export function setNavCollapsed(next: boolean): void {
  setNavCollapsedSignal(next);
  write(KEY.nav, String(next));
}
export function toggleNav(): void {
  setNavCollapsed(!navCollapsed());
}

// ── Right details drawer ──────────────────────────────────────────────────
/**
 * Open on a desktop, where it is a docked column beside the content, and remembered. On a
 * phone it is a sheet laid over up to 62% of the screen (index.css), so it starts closed:
 * open at launch it covers what the person opened the app to see, and it comes up by itself
 * when they select something (`revealDetails`). It is not remembered there either. "Open" on
 * a phone means "something is selected", not a layout the person chose, so saving it would
 * bring the sheet back on the next launch for no reason they could see.
 */
const [detailsOpen, setDetailsOpenSignal] = createSignal(isPhone() ? false : readBool(KEY.open, true));
export { detailsOpen };

export function setDetailsOpen(next: boolean): void {
  setDetailsOpenSignal(next);
  if (!isPhone()) write(KEY.open, String(next));
}
export function toggleDetails(): void {
  setDetailsOpen(!detailsOpen());
}

const [detailsWidth, setDetailsWidthSignal] = createSignal(readWidth());
export { detailsWidth };

/** Set the drawer width, clamped to the bounds the resize rail advertises. */
export function setDetailsWidth(px: number): number {
  const w = Math.min(DETAILS_MAX_W, Math.max(DETAILS_MIN_W, Math.round(px)));
  setDetailsWidthSignal(w);
  write(KEY.width, String(w));
  return w;
}

// ── Drawer tabs ───────────────────────────────────────────────────────────
/**
 * Which drawer tab is showing. `details` is the selected entity; `flightplan` is
 * the staging list, which moved out of the Today column so it sits beside the
 * Planner grid it schedules into rather than above it.
 */
export type DrawerTab = 'details' | 'flightplan';
const [drawerTab, setDrawerTabSignal] = createSignal<DrawerTab>('details');
export { drawerTab };

export function setDrawerTab(tab: DrawerTab): void {
  setDrawerTabSignal(tab);
}

/**
 * Open the drawer on the Details tab. Call this from anywhere that selects an
 * entity: selecting something while the drawer is closed, or while the Planner tab
 * is showing, would otherwise change state the user cannot see.
 */
export function revealDetails(): void {
  setDrawerTab('details');
  if (!detailsOpen()) setDetailsOpen(true);
}
