import { createSignal } from 'solid-js';

/**
 * Light/dark theme, driven by the `.dark` class on <html> (which flips the
 * CI-Hub design tokens in index.css). The initial class is set by a tiny inline
 * script in index.html to avoid a flash; this module owns runtime toggling and
 * persistence. Dark-first default preserves the app's established look.
 */
export type Theme = 'light' | 'dark';

const KEY = 'ci-theme';

function initial(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'light' || t === 'dark') return t;
  } catch {
    /* localStorage unavailable (private mode / SSR) */
  }
  return 'dark';
}

const [theme, setThemeSignal] = createSignal<Theme>(initial());
export { theme };

/** Apply a theme to <html> (adds/removes the `.dark` class the tokens key off). */
export function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle('dark', t === 'dark');
}

/** Set, persist, and apply a theme. */
export function setTheme(t: Theme): void {
  setThemeSignal(t);
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore persistence failure */
  }
  applyTheme(t);
}

export function toggleTheme(): void {
  setTheme(theme() === 'dark' ? 'light' : 'dark');
}
