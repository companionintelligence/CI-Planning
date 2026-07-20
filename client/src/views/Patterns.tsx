import { Show } from 'solid-js';
import { prefs } from '../stores/index.js';
import { RoutinesPanel } from '../components/RoutinesPanel.js';
import { TimeBlocksPanel } from '../components/TimeBlocksPanel.js';

/**
 * DEAD VIEW (see #392): neither router imports this file, and BOTH map `/patterns`
 * to an unconditional `<Navigate href="/tasks" />` (App.tsx) — so even a stale
 * deep-link never renders it (the previous claim here was wrong). The content lives
 * in `RoutinesPanel` / `TimeBlocksPanel`, mounted as Tasks-screen tabs. Kept per the
 * owner's document-only ruling; delete-candidates go through #392.
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
