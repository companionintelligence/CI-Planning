import { Show } from 'solid-js';
import { prefs } from '../stores/index.js';
import { RoutinesPanel } from '../components/RoutinesPanel.js';
import { TimeBlocksPanel } from '../components/TimeBlocksPanel.js';

/**
 * The Routines view. As of the Tasks/Nav overhaul (T-TASKS-1/6 + T-NAV-1) its
 * content lives in the reusable `RoutinesPanel` / `TimeBlocksPanel`, now also mounted
 * as Tasks-screen tabs; `/patterns` redirects to `/tasks` so this view is reached only
 * by stale deep-links. Kept as a thin composition so those links still render.
 */
export function Patterns() {
  return (
    <div class="flex-1 overflow-auto p-4 md:p-6 page-enter max-w-3xl mx-auto w-full pb-24">
      <h1 class="text-2xl font-bold text-foreground mb-1">Routines</h1>
      <p class="text-sm text-muted-foreground mb-6">
        Routines bundle habits · Habits repeat
        <Show when={prefs()?.enable_rituals}> · Rituals assemble a day's prep</Show>.
      </p>

      <RoutinesPanel />
      <TimeBlocksPanel />
    </div>
  );
}
