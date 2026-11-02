import { createSignal, Show } from 'solid-js';
import { COMMON } from '../../lib/learning-copy.js';
import { showToast } from '../../stores/index.js';
import type { ResetSpec } from './LearningCard.js';

/**
 * Settings → Learning: one "clear what was learned" button, with the hint that says what it
 * does, always visible next to it.
 *
 * What a clear is, and is not: it removes the learned index NOW. The logs it was built from
 * are kept, so the weekly pass rebuilds it on Monday, and there is no setting that turns the
 * learning off. The label is literal ("Clear learned examples"), not "Reset learning", which
 * would promise a permanence the endpoint cannot give (the same trap TrialityMetricsTiles
 * documents). The hint and the confirm text carry the rest.
 *
 * Flow: click, window.confirm (Cancel makes no request), the request, a toast. The button is
 * disabled while the request runs and a second click is ignored. The outcome is reported to
 * the card frame, which decides what to show next; nothing here refetches, because the
 * readings cannot change before Monday.
 *
 *   cleared above 0   success toast, onDone('cleared', message)
 *   cleared 0         plain toast "Nothing to clear...", onDone('empty', message)
 *   403               onForbidden, and the fixed forbidden toast (the server body is never
 *                     shown); onDone is NOT called
 *   anything else     a FIXED sentence, as an error toast and again in a role="alert" line
 *                     beside the button; onDone is NOT called
 *
 * Why fixed sentences, and why the line beside the button: the server's own text can be empty
 * (a proxy 502 over HTTP/2) and a failed fetch carries the browser's or the native plugin's
 * wording, which can name the request URL. So, like the read errors, a failed clear says one of
 * two things: the server could not be reached (status 0), or it could not clear. The toast
 * alone would be silent to a screen reader, so the same sentence is also an alert next to the
 * button, and the button gets keyboard focus back once the request is over (a button that is
 * disabled while it runs loses focus in a browser).
 *
 * `message` on onDone is the success or "nothing to clear" sentence, so the card can say it to a
 * screen reader too.
 *
 * A 403 is read by duck-typing `.status`, so this file never imports ApiError.
 */

export interface ResetControlProps {
  /** Goes on the button. */
  testId: string;
  /** Goes on the hint that sits beside it. */
  hintTestId: string;
  spec: ResetSpec;
  onDone: (outcome: 'cleared' | 'empty', message: string) => void;
  onForbidden?: () => void;
}

/** One sentence for a clear that failed. Never the server's or the browser's own text. */
function failureMessage(err: unknown): string {
  return (err as { status?: unknown } | null | undefined)?.status === 0 ? COMMON.clearOffline : COMMON.clearFailed;
}

export function ResetControl(props: ResetControlProps) {
  const [busy, setBusy] = createSignal(false);
  const [failure, setFailure] = createSignal<string | null>(null);
  let button: HTMLButtonElement | undefined;

  async function click(): Promise<void> {
    if (busy()) return;
    // Cancel makes no request and changes nothing.
    if (!window.confirm(props.spec.confirmText)) return;
    // The dialog gives focus back to the button; remember it, because disabling the button
    // while the request runs makes a browser drop focus to the page.
    const hadFocus = button !== undefined && document.activeElement === button;
    setFailure(null);
    setBusy(true);
    let failed = false;
    try {
      const res = await props.spec.run();
      const cleared = typeof res?.cleared === 'number' ? res.cleared : 0;
      if (cleared > 0) {
        const message = props.spec.clearedMessage(cleared);
        showToast(message, 'success');
        props.onDone('cleared', message);
      } else {
        showToast(props.spec.emptyMessage, 'default');
        props.onDone('empty', props.spec.emptyMessage);
      }
    } catch (err) {
      failed = true;
      if ((err as { status?: unknown } | null)?.status === 403) {
        showToast(COMMON.forbiddenToast, 'error');
        props.onForbidden?.();
      } else {
        const message = failureMessage(err);
        setFailure(message);
        showToast(message, 'error');
      }
    } finally {
      setBusy(false);
    }
    // Only after a failure, and only if focus fell to the page: after a clear the card has moved
    // focus on purpose, after a 403 the button is gone (isConnected is false), and an owner who
    // tabbed elsewhere while it ran is not pulled back.
    const active = document.activeElement;
    const fell = !active || active === document.body;
    if (failed && hadFocus && fell && button?.isConnected) button.focus();
  }

  return (
    <div class="flex flex-col items-start gap-2">
      <div class="flex flex-col items-start gap-2 sm:flex-row">
        <button
          type="button"
          class="btn-secondary text-xs whitespace-nowrap shrink-0"
          data-testid={props.testId}
          disabled={busy()}
          aria-busy={busy()}
          ref={button}
          onClick={() => void click()}
        >
          {props.spec.label}
        </button>
        <p class="text-[11px] text-muted-foreground" data-testid={props.hintTestId}>
          {props.spec.hint}
        </p>
      </div>
      <Show when={failure()}>
        <p role="alert" class="text-[11px] text-foreground" data-testid={`${props.testId}-error`}>
          {failure()}
        </p>
      </Show>
    </div>
  );
}
