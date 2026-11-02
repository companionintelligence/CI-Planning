import { createMemo, createSignal, type JSX } from 'solid-js';
import { clearedMemory } from '../../lib/learning-cleared.js';
import { aiAvailable, integrations, prefs } from '../../stores/index.js';
import { ClassificationTile } from './ClassificationTile.js';
import { DismissalTile } from './DismissalTile.js';
import type { LearningContext } from './LearningCard.js';
import { PlacementTile } from './PlacementTile.js';
import { PlanLoopTile } from './PlanLoopTile.js';

/**
 * Settings → Learning: the tab body.
 *
 * The app takes four weekly readings of its own guesses and plans. This panel only composes
 * the four cards, in a fixed order, and hands every one the same LearningContext. It fetches
 * nothing itself: each tile reads its own endpoint, so one failing card never blanks the
 * others, and the four GETs fire only when an owner opens the tab. Settings mounts the panel
 * inside a <Show>, so every reopen of the tab is a fresh mount and a fresh read; nothing is
 * cached that could show an old reading as current.
 *
 * What a reopen cannot know is that the owner cleared something: a clear changes the live
 * index but writes no row. So the panel reads this browser session's remembered clears
 * (lib/learning-cleared.ts) and hands them to the tiles in the context, which let a clear
 * override the Monday count until a newer reading arrives.
 *
 * A refused clear (403: a read-only credential) is different: that is a fact about the account,
 * and it is remembered for the browser session in the same record (lib/learning-cleared.ts,
 * keyed by owner), so leaving the tab and coming back does not offer the buttons again for the
 * next click to be refused again.
 *
 * Settings renders it AFTER the closing </form>, on purpose. Its buttons act at once and
 * nothing here feeds Save Settings; a stray untyped button inside the form would PATCH the
 * preferences. Every button is type="button" regardless (the tests guard that too).
 */

export const LEARNING_HEADING = 'What the app has measured';

// Two sentences, so the first card is not pushed down the screen by the intro. Plan loop is the
// odd one out and the intro says so: its rate is a model scoring the app's own plans, so it is not
// a result of anything the owner corrected or chose.
export const LEARNING_INTRO =
  "The app takes four weekly readings of its own guesses and plans, recalculated early on Monday (server time): the first three come from your corrections and choices, and the fourth is the app's own plans scored by a model, not anything you did. Every figure shows how many cases are behind it, a week with nothing measured is never shown as zero, and each card says what its number does not show, because a reading is evidence, not proof.";

export interface LearningPanelProps {
  /**
   * May the viewer clear learned data? Omitted means yes. null means "not known yet" (the
   * account is still loading): the cards then show neither a clear button nor the read-only
   * note. The server stays the authority: a viewer's clear is answered 403.
   */
  canReset?: boolean | null;
  /**
   * Who is looking, for the memory of clears. A clear remembered for one account is never
   * shown to another in the same tab. Omitted or null (no sign-in, or not known yet) is one
   * shared key, which is right for a deployment with a single owner.
   */
  owner?: string | null;
  /** Test override, merged over the context the panel derives. */
  context?: Partial<LearningContext>;
}

/** A createResource value counts as "known" once it has resolved at least once. */
const hasLoaded = (state: string): boolean => state === 'ready' || state === 'refreshing';

export function LearningPanel(props: LearningPanelProps): JSX.Element {
  // A reopen of the tab remounts the panel, so this is "when the owner looked".
  const now = new Date();

  // Set when any clear is answered 403. From then on no card offers a clear this browser session:
  // the signal makes this mount react, the memory makes the next mount start the same way.
  const [forbidden, setForbidden] = createSignal(false);

  const context = createMemo<LearningContext>(() => {
    // aiAvailable() is fail-closed false while integrations load, and reading a resource
    // that errored throws. Neither may be shown as "your local model is not reachable", so
    // anything short of a loaded answer is null (unknown), which the tiles treat as silence.
    const ai = hasLoaded(integrations.state) ? aiAvailable() : null;
    const smart = hasLoaded(prefs.state) ? prefs()?.planning_mode === 'smart' : null;

    // `omitted` is not `null`: ?? would turn the unknown (null) into true.
    const canReset = props.canReset === undefined ? true : props.canReset;

    // Bind first, then read: the memory is keyed by who is looking. Not tracked: a clear made
    // while the panel is open is shown by the card itself, and the next open reads it here.
    clearedMemory.bind(props.owner ?? '');

    const merged: LearningContext = {
      aiAvailable: ai,
      smartMode: smart,
      now,
      canReset,
      clearedOn: clearedMemory.recall(),
      ...props.context,
    };
    const override = props.context?.onResetForbidden;
    return {
      ...merged,
      canReset: forbidden() || clearedMemory.isForbidden() ? false : merged.canReset,
      onResetForbidden: () => {
        clearedMemory.markForbidden();
        setForbidden(true);
        override?.();
      },
    };
  });

  return (
    <div data-testid="learning-panel" class="flex flex-col gap-5">
      <section class="card">
        <h2 class="section-label">{LEARNING_HEADING}</h2>
        <p class="text-xs text-muted-foreground">{LEARNING_INTRO}</p>
      </section>
      <ClassificationTile context={context()} />
      <DismissalTile context={context()} />
      <PlacementTile context={context()} />
      <PlanLoopTile context={context()} />
    </div>
  );
}
