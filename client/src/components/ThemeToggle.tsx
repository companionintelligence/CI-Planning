import { Show } from 'solid-js';
import { Sun, Moon } from 'lucide-solid';
import { resolvedTheme, toggleTheme } from '../lib/theme.js';

/** Sidebar light/dark switch. Uses the shared .nav-item styling. */
export function ThemeToggle() {
  const targetTheme = () => resolvedTheme() === 'dark' ? 'light' : 'dark';
  return (
    <button
      class="nav-item w-full"
      onClick={toggleTheme}
      aria-label={`Switch to ${targetTheme()} mode`}
      title={`Switch to ${targetTheme()} mode`}
    >
      <Show when={resolvedTheme() === 'dark'} fallback={<Moon size={15} class="flex-shrink-0" />}>
        <Sun size={15} class="flex-shrink-0" />
      </Show>
    </button>
  );
}
