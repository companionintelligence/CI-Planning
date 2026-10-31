import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * stores/ui.ts reads its starting state once, at import, so each case stubs the page first
 * and then imports a fresh copy. What is pinned: the details drawer starts open on a
 * desktop and closed on a phone, a desktop remembers what it was left at, and a phone
 * neither obeys nor writes that memory.
 */

const KEY = 'ci-planner.details-open';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  } as Storage;
}

/** A page `width` px wide: answers the one media query the store asks. */
function pageOf(width: number) {
  vi.stubGlobal('window', {
    matchMedia: (query: string) => ({ matches: query === '(max-width: 767px)' && width <= 767 }),
  });
}

async function loadUi() {
  vi.resetModules();
  return import('./ui.js');
}

beforeEach(() => {
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('details drawer, on a desktop', () => {
  beforeEach(() => pageOf(1280));

  it('starts open', async () => {
    const { detailsOpen } = await loadUi();
    expect(detailsOpen()).toBe(true);
  });

  it('starts as it was left, and remembers a change', async () => {
    localStorage.setItem(KEY, 'false');
    const ui = await loadUi();
    expect(ui.detailsOpen()).toBe(false);

    ui.setDetailsOpen(true);
    expect(localStorage.getItem(KEY)).toBe('true');
  });

  it('is open at exactly the first desktop width, closed one pixel below it', async () => {
    pageOf(768);
    expect((await loadUi()).detailsOpen()).toBe(true);
    pageOf(767);
    expect((await loadUi()).detailsOpen()).toBe(false);
  });
});

describe('details drawer, on a phone', () => {
  beforeEach(() => pageOf(390));

  it('starts closed', async () => {
    const { detailsOpen } = await loadUi();
    expect(detailsOpen()).toBe(false);
  });

  it('starts closed even if a desktop session left it open', async () => {
    localStorage.setItem(KEY, 'true');
    const { detailsOpen } = await loadUi();
    expect(detailsOpen()).toBe(false);
  });

  it('opens when something is selected, and does not save that', async () => {
    const ui = await loadUi();
    ui.revealDetails();
    expect(ui.detailsOpen()).toBe(true);
    expect(localStorage.getItem(KEY)).toBeNull();

    ui.setDetailsOpen(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('leaves what a desktop saved alone', async () => {
    localStorage.setItem(KEY, 'false');
    const ui = await loadUi();
    ui.setDetailsOpen(true);
    expect(localStorage.getItem(KEY)).toBe('false');
  });
});

describe('details drawer, without a window to ask', () => {
  it('falls back to the desktop default', async () => {
    vi.stubGlobal('window', undefined);
    expect((await loadUi()).detailsOpen()).toBe(true);
  });

  it('survives a matchMedia that throws', async () => {
    vi.stubGlobal('window', { matchMedia: () => { throw new Error('nope'); } });
    expect((await loadUi()).detailsOpen()).toBe(true);
  });
});
