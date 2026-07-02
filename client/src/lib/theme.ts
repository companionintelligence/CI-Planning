import { createSignal } from 'solid-js';

/**
 * Light/dark theme, driven by the `.dark` / `.light` class on <html> (which
 * flips the CI-Hub design tokens in index.css: :root = light, .dark = dark).
 * The initial class is set by a tiny inline script in index.html to avoid a
 * flash; this module owns runtime toggling and persistence.
 *
 * The stored preference is `light | dark | system`. `system` resolves live via
 * `matchMedia('(prefers-color-scheme: dark)')`. Dark-first default preserves the
 * app's established look when nothing is persisted.
 */
export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

// Canonical CI storage key (matches the shadcn/vite-ui ThemeProvider convention
// used across the CI frontends). Previously 'ci-theme'.
const KEY = 'vite-ui-theme';

const media = () =>
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;

/** Resolve a stored preference to a concrete light/dark value. */
function resolve(t: Theme): ResolvedTheme {
  if (t === 'system') return media()?.matches ? 'dark' : 'light';
  return t;
}

function initial(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark' || t === 'system') return t;
  } catch {
    /* localStorage unavailable (private mode / SSR) */
  }
  return 'dark';
}

const [theme, setThemeSignal] = createSignal<Theme>(initial());
export { theme };

// Effective light/dark, tracking both the stored preference and (when it is
// 'system') the OS colour-scheme. Consumers that need the concrete appearance
// (icon, label, class checks) should read this, not `theme()`.
const [resolvedTheme, setResolvedSignal] = createSignal<ResolvedTheme>(resolve(theme()));
export { resolvedTheme };

/** Apply a preference to <html> (adds `.dark`/`.light`, the tokens key off `.dark`). */
export function applyTheme(t: Theme): void {
  const r = resolve(t);
  const el = document.documentElement;
  el.classList.toggle('dark', r === 'dark');
  el.classList.toggle('light', r === 'light');
  setResolvedSignal(r);
}

/** Set, persist, and apply a preference. */
export function setTheme(t: Theme): void {
  setThemeSignal(t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore persistence failure */
  }
  applyTheme(t);
}

/** Cycle the visible appearance: flip between light and dark. */
export function toggleTheme(): void {
  setTheme(resolvedTheme() === 'dark' ? 'light' : 'dark');
}

// When the preference is 'system', re-apply on OS colour-scheme changes so the
// UI tracks light/dark live. Guarded for SSR / no-matchMedia environments.
media()?.addEventListener?.('change', () => {
  if (theme() === 'system') applyTheme('system');
});
