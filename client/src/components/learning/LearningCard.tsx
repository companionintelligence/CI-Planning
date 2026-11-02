import { createEffect, createMemo, createSignal, For, Index, Match, on, Show, Switch } from 'solid-js';
import type { LearningResetResult } from '../../lib/api.js';
import { localISODate } from '../../lib/dates.js';
import type { ChartPoint } from '../../lib/learning-chart.js';
import { clearedMemory, type ClearedOn } from '../../lib/learning-cleared.js';
import { COMMON } from '../../lib/learning-copy.js';
import { ResetControl } from './ResetControl.js';
import { TrendChart } from './TrendChart.js';

/**
 * Settings → Learning: the one card frame, and the types every tile codes against.
 *
 * Each of the four tiles turns its response into a TileView with a pure builder and hands it
 * here. This file is the only place that renders, so the rules that must hold on every card
 * hold in one place:
 *
 *   - the always-visible caveat comes first and does not depend on data, so it is there
 *     while loading and after a failure too. What the card counts and changes sits in a
 *     disclosure under the data (open when nothing is measured yet), so on a phone the number
 *     is not pushed below the first screen by prose;
 *   - a failed read shows ONLY its fixed message and Try again. It never shows a series, an
 *     empty-state sentence or "No readings yet", so a failure cannot pass for emptiness;
 *   - what a series says comes pre-built (strings), so no number is formatted here and a
 *     "not measured" reading cannot turn into a 0 on the way to the screen;
 *   - every plotted reading also has its counts in a "Show the readings" table, which is the
 *     chart's text alternative;
 *   - clearing is offered only when the account may, only when something is stored, and
 *     never refetches; the frame holds that session-local state, the tiles hold none;
 *   - the card keeps keyboard focus and says what happened. A button that clears (or Try
 *     again) is removed from the page when it is pressed, which would drop focus to the top of
 *     the page, so focus moves to the sentence that replaced it. Every result is also said to a
 *     screen reader through one always-mounted polite live region (the toast alone is silent).
 *
 * Every <button> is type="button". Settings renders this tab outside its <form>, but a
 * stray untyped button would still submit one if the panel were ever moved inside it.
 */

// ── Contract (shared with the tiles) ─────────────────────────────────────────

export interface LearningContext {
  /** true/false once integrations have loaded; null while loading or failed. aiAvailable()
   *  is fail-closed false while loading, so the panel must not pass that through as false. */
  aiAvailable: boolean | null;
  /** prefs().planning_mode === 'smart'; null while prefs are unresolved. */
  smartMode: boolean | null;
  /** Injected so tests are deterministic. A reopen of the tab takes a new one. */
  now: Date;
  /** true = may clear; false = viewer or forbidden (the frame shows the read-only note);
   *  null = not known yet (the frame shows neither a button nor the note). */
  canReset: boolean | null;
  /** Called by the frame when a clear is answered 403; the panel then turns every clear off
   *  for the session. */
  onResetForbidden?: () => void;
  /** The local date of this browser session's last successful clear, per loop. A builder
   *  uses it to stop presenting the Monday count of stored examples as current. */
  clearedOn?: ClearedOn;
}

export interface SeriesView {
  /** 'category' | 'motivation' | 'rate' | 'survival' | a stage name. Used in test ids. */
  key: string;
  /** Sub-heading when a card has several series; null for single-series cards. */
  label: string | null;
  /** The state of the NEWEST reading. none = no rows at all for this series. */
  state: 'none' | 'not-measured' | 'measured';
  /** null iff state is none. */
  headline: string | null;
  detail: string | null;
  /** Extra lines, for example 'Last measured: 3 of 4 on Oct 19.' */
  notes: string[];
  comparison: string | null;
  /** Non-null iff state is none. */
  empty: string | null;
  /** null iff state is none. */
  chart: {
    points: ChartPoint[];
    cadenceDays: number;
    marker: { date: string; text: string } | null;
    caption: string;
  } | null;
  /** Newest first; every cell is already a string. null iff state is none. */
  readings: { columns: string[]; rows: { key: string; cells: string[] }[] } | null;
}

export interface TileView {
  series: SeriesView[];
  /** Small always-visible lines: model not reachable, AI day ordering off, stale reading. */
  contextLines: string[];
  status: string | null;
  /** True when no series is measured: opens the "More about this number" block. */
  startOpen: boolean;
  /** Is there something stored that a clear could remove? */
  resetAvailable: boolean;
}

export interface ResetSpec {
  label: string;
  /** Always visible next to the button. */
  hint: string;
  confirmText: string;
  run: () => Promise<LearningResetResult>;
  clearedMessage: (n: number) => string;
  emptyMessage: string;
  /** Replaces the tile's status line after a successful clear. */
  doneStatus: string;
  /** Shown instead of the button when nothing is stored, and after any clear. */
  nothingToClear: string | null;
}

export interface LearningCardProps {
  loopKey: 'classification' | 'dismissal' | 'placement' | 'planloop';
  title: string;
  meaning: string;
  changes: string | null;
  /** ALWAYS visible, above the data. */
  primaryCaveat: string;
  /** Inside the "More about this number" block. */
  moreCaveats: readonly string[];
  howToStart: string;
  status: 'loading' | 'ready' | 'error';
  error?: { kind: 'offline' | 'unsupported' | 'failed'; message: string };
  onRetry: () => void;
  view: TileView | null;
  canReset: boolean | null;
  onResetForbidden?: () => void;
  /** Absent for plan loop, which has no reset. */
  reset?: ResetSpec;
  /** Plan loop: 'Nothing to clear. ...' */
  noResetNote?: string;
}

// A visible ring for keyboard users on the disclosures and on the lines that take focus
// (the buttons carry their own).
const FOCUS =
  'rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

type Outcome = 'cleared' | 'empty';

export function LearningCard(props: LearningCardProps) {
  const loop = () => props.loopKey;
  const id = (what: string) => `learning-${what}-${props.loopKey}`;

  // What this mount has done about clearing. The frame owns it so a tile holds no state.
  const [outcome, setOutcome] = createSignal<Outcome | null>(null);
  // True once THIS card's own clear was answered 403 (the panel then turns every card read-only).
  const [refused, setRefused] = createSignal(false);
  // True between pressing Try again and the retry settling.
  const [retried, setRetried] = createSignal(false);
  // What the always-mounted live region says. Set only by something the owner did.
  const [announcement, setAnnouncement] = createSignal('');

  // The lines that take focus when the control that had it goes away.
  let titleEl: HTMLHeadingElement | undefined;
  let statusEl: HTMLParagraphElement | undefined;
  let nothingEl: HTMLParagraphElement | undefined;
  let readonlyEl: HTMLParagraphElement | undefined;
  const focusFirst = (...els: (HTMLElement | undefined)[]): void => {
    els.find((el) => el?.isConnected)?.focus();
  };

  // A memo, so the block is not rewritten (and a block the owner opened is not closed) when
  // the view is rebuilt with the same answer.
  const startOpen = createMemo(() => props.view?.startOpen ?? false);

  function onResetDone(done: Outcome, message: string): void {
    setOutcome(done);
    setAnnouncement(message);
    // Only a real clear changes what the next visit should say. Plan loop has no reset, so
    // it never gets here.
    if (done === 'cleared' && props.loopKey !== 'planloop') {
      clearedMemory.remember(props.loopKey, localISODate(new Date()));
    }
  }

  function onForbidden(): void {
    setRefused(true);
    setAnnouncement(COMMON.forbiddenToast);
    props.onResetForbidden?.();
  }

  function retry(): void {
    setRetried(true);
    setAnnouncement('');
    // The error block, with this button in it, is replaced by the loading line as soon as the
    // read restarts. Keep focus on the card instead of letting it fall to the page.
    titleEl?.focus();
    props.onRetry();
  }

  // After a clear the button is gone: focus goes to the sentence that took its place. These
  // effects run after the DOM has been updated, so that sentence exists.
  createEffect(
    on(
      outcome,
      (done) => {
        if (done === 'cleared') focusFirst(statusEl, nothingEl, titleEl);
        else if (done === 'empty') focusFirst(nothingEl, statusEl, titleEl);
      },
      { defer: true },
    ),
  );
  // A 403 on this card's own clear turned every card read-only; its button is gone too.
  createEffect(
    on(
      () => props.canReset,
      (now, before) => {
        if (refused() && now === false && before !== false) focusFirst(readonlyEl, titleEl);
      },
      { defer: true },
    ),
  );
  // A Try again that has finished: say so, since the loading line just disappeared.
  createEffect(
    on(
      () => props.status,
      (now, before) => {
        if (!retried()) return;
        if (now === 'ready' && before === 'loading') setAnnouncement(COMMON.loaded);
        if (now !== 'loading') setRetried(false);
      },
      { defer: true },
    ),
  );

  const statusLine = createMemo(() => {
    if (outcome() === 'cleared' && props.reset) return props.reset.doneStatus;
    return props.view?.status ?? null;
  });

  return (
    <section class="card flex flex-col gap-3" data-testid={id('card')} aria-labelledby={id('title')}>
      <div>
        <h3 class={`section-label !mb-1 ${FOCUS}`} id={id('title')} tabindex="-1" ref={titleEl}>
          {props.title}
        </h3>
        {/* The one thing this number does not show. Always visible, and it does not wait for data. */}
        <p class="text-xs text-foreground" data-testid={id('primary-caveat')}>
          {props.primaryCaveat}
        </p>
      </div>

      {/* Always mounted, so a change in it is announced. Only what the owner just did is said here
          (a clear, a refused clear, a finished Try again): the first load is not announced four times. */}
      <div role="status" aria-live="polite" aria-atomic="true" class="sr-only" data-testid={id('announce')}>
        {announcement()}
      </div>

      <Show when={props.status === 'loading'}>
        <p class="text-xs text-muted-foreground" role="status">
          {COMMON.loading}
        </p>
      </Show>

      <Show when={props.status === 'error'}>
        <div class="flex flex-col items-start gap-2" data-testid={id('error')} role="alert">
          <p class="text-xs text-foreground">{props.error?.message ?? COMMON.errorFailed}</p>
          <button type="button" class="btn-secondary text-xs" data-testid={id('retry')} onClick={retry}>
            {COMMON.tryAgain}
          </button>
        </div>
      </Show>

      <Show when={props.status === 'ready' ? props.view : null}>
        {(view) => (
          <>
            <For each={view().contextLines}>
              {(line) => (
                <p class="text-[11px] text-muted-foreground" data-testid={id('context')}>
                  {line}
                </p>
              )}
            </For>

            {/* Index, not For: when the view is rebuilt (a context change) the blocks keep their
                DOM, so a "Show the readings" table the owner opened stays open. */}
            <Index each={view().series}>
              {(s) => (
                <div class="flex flex-col gap-1.5 rounded-lg bg-muted/30 px-3 py-2">
                  <Show when={s().label}>
                    <h4 class="text-xs font-semibold text-foreground">{s().label}</h4>
                  </Show>

                  <Show when={s().headline}>
                    <p
                      class="text-sm text-foreground"
                      data-testid={`learning-headline-${loop()}-${s().key}`}
                      data-state={s().state}
                    >
                      {s().headline}
                    </p>
                  </Show>
                  <Show when={s().detail}>
                    <p class="text-[11px] text-muted-foreground" data-testid={`learning-detail-${loop()}-${s().key}`}>
                      {s().detail}
                    </p>
                  </Show>
                  <For each={s().notes}>{(note) => <p class="text-[11px] text-muted-foreground">{note}</p>}</For>

                  <Show when={s().chart}>
                    {(c) => (
                      <div class="mt-1 flex flex-col gap-1">
                        <TrendChart
                          title={s().label ?? props.title}
                          points={c().points}
                          cadenceDays={c().cadenceDays}
                          marker={c().marker}
                          testId={`learning-chart-${loop()}-${s().key}`}
                        />
                        <p class="text-[10px] text-muted-foreground">{c().caption}</p>
                      </div>
                    )}
                  </Show>

                  <Show when={s().comparison}>
                    <p class="text-xs text-foreground" data-testid={`learning-comparison-${loop()}-${s().key}`}>
                      {s().comparison}
                    </p>
                  </Show>

                  <Show when={s().empty}>
                    <p class="text-xs text-muted-foreground" data-testid={`learning-empty-${loop()}-${s().key}`}>
                      {s().empty}
                    </p>
                  </Show>

                  <Show when={s().readings}>
                    {(r) => (
                      <details class="text-xs" data-testid={`learning-readings-${loop()}-${s().key}`}>
                        <summary class={`cursor-pointer text-muted-foreground hover:text-foreground ${FOCUS}`}>
                          {COMMON.showReadings}
                        </summary>
                        {/* A wide table scrolls inside its own box, never the page. The box takes focus so a
                            keyboard user can scroll it, and says so. */}
                        <div
                          class={`mt-1 overflow-x-auto ${FOCUS}`}
                          tabindex="0"
                          role="region"
                          aria-label={`${s().label ?? props.title}: readings table, scrolls sideways`}
                        >
                          <table class="w-full text-left text-[11px] tabular-nums">
                            <caption class="sr-only">
                              {`${s().label ?? props.title}: every weekly reading, newest first`}
                            </caption>
                            <thead class="text-muted-foreground">
                              <tr>
                                <For each={r().columns}>
                                  {(col) => (
                                    <th scope="col" class="py-1 pr-3 align-bottom font-medium">
                                      {col}
                                    </th>
                                  )}
                                </For>
                              </tr>
                            </thead>
                            <tbody>
                              <For each={r().rows}>
                                {(row) => (
                                  <tr class="border-t border-border">
                                    <For each={row.cells}>
                                      {(cell, i) =>
                                        i() === 0 ? (
                                          <th scope="row" class="py-1 pr-3 font-normal whitespace-nowrap">
                                            {cell}
                                          </th>
                                        ) : (
                                          <td class="py-1 pr-3 whitespace-nowrap">{cell}</td>
                                        )
                                      }
                                    </For>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                        </div>
                      </details>
                    )}
                  </Show>
                </div>
              )}
            </Index>

            <Show when={statusLine()}>
              <p class={`text-xs text-foreground ${FOCUS}`} tabindex="-1" ref={statusEl} data-testid={id('status')}>
                {statusLine()}
              </p>
            </Show>

            {/* The reset area. Plan loop has no reset by design, so it says so instead. */}
            <Show
              when={props.reset}
              fallback={
                <Show when={props.noResetNote}>
                  <p class="text-xs text-muted-foreground" data-testid={id('no-reset')}>
                    {props.noResetNote}
                  </p>
                </Show>
              }
            >
              {(spec) => (
                <Switch>
                  <Match when={props.canReset === false}>
                    <p
                      class={`text-xs text-muted-foreground ${FOCUS}`}
                      tabindex="-1"
                      ref={readonlyEl}
                      data-testid={id('readonly')}
                    >
                      {COMMON.readOnlyNote}
                    </p>
                  </Match>
                  <Match when={props.canReset === true && (outcome() !== null || !view().resetAvailable)}>
                    <Show when={spec().nothingToClear}>
                      <p
                        class={`text-xs text-muted-foreground ${FOCUS}`}
                        tabindex="-1"
                        ref={nothingEl}
                        data-testid={id('nothing-to-clear')}
                      >
                        {spec().nothingToClear}
                      </p>
                    </Show>
                  </Match>
                  <Match when={props.canReset === true}>
                    <ResetControl
                      testId={id('reset')}
                      hintTestId={id('reset-hint')}
                      spec={spec()}
                      onDone={onResetDone}
                      onForbidden={onForbidden}
                    />
                  </Match>
                </Switch>
              )}
            </Show>
          </>
        )}
      </Show>

      {/* What the card counts and what it changes. Open when nothing is measured yet (then there is
          no number to read first); closed once there is one, so the number is not buried in prose. */}
      <details open={startOpen()} class="text-xs" data-testid={id('about')}>
        <summary class={`cursor-pointer text-muted-foreground hover:text-foreground ${FOCUS}`}>
          {COMMON.whatItCounts}
        </summary>
        <div class="mt-2 flex flex-col gap-2 text-muted-foreground">
          <p>{props.meaning}</p>
          <Show when={props.changes}>
            <p>{props.changes}</p>
          </Show>
        </div>
      </details>

      <Show when={props.status === 'ready' && props.view}>
        <details open={startOpen()} class="text-xs" data-testid={id('more')}>
          <summary class={`cursor-pointer text-muted-foreground hover:text-foreground ${FOCUS}`}>
            {COMMON.moreAbout}
          </summary>
          <div class="mt-2 flex flex-col gap-2 text-muted-foreground">
            <ul class="list-disc pl-4 flex flex-col gap-1">
              <For each={props.moreCaveats}>{(c) => <li>{c}</li>}</For>
            </ul>
            <div>
              <h4 class="font-semibold text-foreground">{COMMON.howItStarts}</h4>
              <p>{props.howToStart}</p>
            </div>
          </div>
        </details>
      </Show>
    </section>
  );
}
