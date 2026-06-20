import { Show } from 'solid-js';
import { Sun, Moon } from 'lucide-solid';
import { theme, toggleTheme } from '../lib/theme.js';

/** Sidebar light/dark switch. Uses the shared .nav-item styling. */
export function ThemeToggle() {
  return (
    <button class="nav-item w-full" onClick={toggleTheme} title="Toggle light / dark theme">
      <Show when={theme() === 'dark'} fallback={<Moon size={15} class="flex-shrink-0" />}>
        <Sun size={15} class="flex-shrink-0" />
      </Show>
      <span class="flex-1 text-left">{theme() === 'dark' ? 'Light mode' : 'Dark mode'}</span>
    </button>
  );
}
