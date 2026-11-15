import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@solidjs/testing-library';
import type { LearningResetResult } from '../../lib/api.js';
import { COMMON, copyProblems } from '../../lib/learning-copy.js';
import type { ResetSpec } from './LearningCard.js';

/**
 * ResetControl: the clear button, its hint, and what happens when it is pressed.
 *
 * A clear removes the learned index now; the logs survive and Monday rebuilds it. So the
 * hint is on screen before any click, Cancel makes no request, the button is locked while
 * the request runs, and neither a refusal (403) nor any other failure is shown as the server's
 * or the browser's own text: a clear that fails says one of two fixed sentences, in the toast
 * and again in an alert beside the button, and the button gets keyboard focus back.
 */

const toast = vi.fn();
vi.mock('../../stores/index.js', () => ({ showToast: (...a: unknown[]) => toast(...a) }));

const { ResetControl } = await import('./ResetControl.js');

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const failure = (status: number, message: string) => Object.assign(new Error(message), { status });

const run = vi.fn(async (): Promise<LearningResetResult> => ({ ok: true, cleared: 0 }));
const spec: ResetSpec = {
  label: 'Clear learned things',
  hint: "Removes the things. Your history is kept, so Monday's pass builds them again.",
  confirmText: 'Clear them? Your history is kept.',
  run: () => run(),
  clearedMessage: (n) => `Cleared ${n} things. They are rebuilt on Monday.`,
  emptyMessage: 'Nothing to clear. No things are stored.',
  doneStatus: 'Cleared.',
  nothingToClear: 'Nothing is stored.',
};

const onDone = vi.fn();
const onForbidden = vi.fn();
const confirm = vi.fn((_text?: string) => true);

function mount() {
  return render(() => <ResetControl testId="the-button" hintTestId="the-hint" spec={spec} onDone={onDone} onForbidden={onForbidden} />);
}
const button = () => screen.getByTestId('the-button') as HTMLButtonElement;

beforeEach(() => {
  run.mockReset().mockResolvedValue({ ok: true, cleared: 0 });
  toast.mockReset();
  onDone.mockReset();
  onForbidden.mockReset();
  confirm.mockReset().mockReturnValue(true);
  vi.stubGlobal('confirm', confirm);
});
afterEach(() => vi.unstubAllGlobals());

describe('ResetControl: before any click', () => {
  it('shows the label and the hint up front, and has asked and sent nothing', () => {
    mount();
    expect(button().textContent).toBe('Clear learned things');
    expect(screen.getByTestId('the-hint').textContent).toBe(spec.hint);
    expect(confirm).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('is a type="button" that is not disabled, so it can never submit a form around it', () => {
    mount();
    expect(button().getAttribute('type')).toBe('button');
    expect(button().disabled).toBe(false);
  });

  it('does not submit a surrounding form', async () => {
    const submit = vi.fn((e: Event) => e.preventDefault());
    render(() => (
      <form onSubmit={submit}>
        <ResetControl testId="the-button" hintTestId="the-hint" spec={spec} onDone={onDone} />
      </form>
    ));
    run.mockResolvedValue({ ok: true, cleared: 2 });
    fireEvent.click(button());
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(submit).not.toHaveBeenCalled();
  });

  it('the label is literal, not "Reset learning"', () => {
    mount();
    expect(button().textContent).not.toMatch(/reset learning/i);
  });
});

describe('ResetControl: asking first', () => {
  it('shows the confirm text, and Cancel makes no request, no toast and no report', async () => {
    confirm.mockReturnValue(false);
    mount();
    fireEvent.click(button());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith('Clear them? Your history is kept.');
    await Promise.resolve();
    expect(run).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    expect(onDone).not.toHaveBeenCalled();
    expect(button().disabled).toBe(false);
  });
});

describe('ResetControl: the outcomes', () => {
  it('cleared above 0: a success toast with the count, and one report of "cleared"', async () => {
    run.mockResolvedValue({ ok: true, cleared: 7 });
    mount();
    fireEvent.click(button());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Cleared 7 things. They are rebuilt on Monday.', 'success');
    expect(onDone).toHaveBeenCalledWith('cleared', 'Cleared 7 things. They are rebuilt on Monday.');
    expect(onForbidden).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('cleared 0: says there was nothing to clear, as a plain toast, and reports "empty"', async () => {
    run.mockResolvedValue({ ok: true, cleared: 0 });
    mount();
    fireEvent.click(button());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith('Nothing to clear. No things are stored.', 'default');
    expect(onDone).toHaveBeenCalledWith('empty', 'Nothing to clear. No things are stored.');
  });

  it('a response without a usable count is treated as nothing cleared, never as a success', async () => {
    run.mockResolvedValue({ ok: true } as unknown as LearningResetResult);
    mount();
    fireEvent.click(button());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('empty', 'Nothing to clear. No things are stored.'));
    expect(toast).toHaveBeenCalledWith('Nothing to clear. No things are stored.', 'default');
  });

  it('a 403: the fixed message, the panel told, the server text never shown, and no report of a clear', async () => {
    run.mockRejectedValue(failure(403, 'forbidden'));
    mount();
    fireEvent.click(button());
    await waitFor(() => expect(onForbidden).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).toHaveBeenCalledWith(COMMON.forbiddenToast, 'error');
    expect(toast).not.toHaveBeenCalledWith('forbidden', expect.anything());
    expect(onDone).not.toHaveBeenCalled();
    // The card tells the owner about a refusal; this control shows no failure line of its own.
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a 403 with no handler passed still toasts and does not throw', async () => {
    run.mockRejectedValue(failure(403, 'forbidden'));
    render(() => <ResetControl testId="the-button" hintTestId="the-hint" spec={spec} onDone={onDone} />);
    fireEvent.click(button());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(COMMON.forbiddenToast, 'error'));
  });

  it('any other failure: one fixed sentence as an error toast and as an alert by the button, never the server text', async () => {
    run.mockRejectedValue(failure(500, 'database is locked'));
    mount();
    fireEvent.click(button());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(COMMON.clearFailed, 'error'));
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast).not.toHaveBeenCalledWith('database is locked', expect.anything());
    // The toast is silent to a screen reader; the same sentence is an alert next to the button.
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toBe(COMMON.clearFailed);
    expect(alert.textContent).not.toContain('database is locked');
    expect(onDone).not.toHaveBeenCalled();
    expect(onForbidden).not.toHaveBeenCalled();
    await waitFor(() => expect(button().disabled).toBe(false));
  });

  it('a failed fetch (status 0) says the server could not be reached and that nothing was cleared, not the browser text', async () => {
    run.mockRejectedValue(failure(0, 'Failed to fetch'));
    mount();
    fireEvent.click(button());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(COMMON.clearOffline, 'error'));
    expect(screen.getByRole('alert').textContent).toBe(COMMON.clearOffline);
    expect(COMMON.clearOffline).toContain('nothing was cleared');
    expect(toast).not.toHaveBeenCalledWith('Failed to fetch', expect.anything());
  });

  it('a failure with no message says it could not clear, never the sentence about loading readings', async () => {
    run.mockRejectedValue(Object.assign(new Error(''), { status: 500 }));
    mount();
    fireEvent.click(button());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(COMMON.clearFailed, 'error'));
    expect(toast).not.toHaveBeenCalledWith(COMMON.errorFailed, expect.anything());
    expect(screen.getByRole('alert').textContent).toBe(COMMON.clearFailed);
    expect(COMMON.clearFailed).not.toMatch(/load/i);
  });

  it('a rejection that is not an Error at all still gets the fixed sentence', async () => {
    run.mockRejectedValue(undefined);
    mount();
    fireEvent.click(button());
    await waitFor(() => expect(toast).toHaveBeenCalledWith(COMMON.clearFailed, 'error'));
  });

  it('keyboard focus is back on the button after a failure (a browser drops it while the button is disabled)', async () => {
    const d = deferred<LearningResetResult>();
    run.mockReturnValue(d.promise);
    mount();
    button().focus();
    expect(document.activeElement).toBe(button());
    fireEvent.click(button());
    await waitFor(() => expect(button().disabled).toBe(true));
    // jsdom keeps focus on a disabled button and cannot blur one; a browser drops it to the page.
    // Simulate the browser: let go of focus while the button is briefly enabled.
    button().disabled = false;
    button().blur();
    button().disabled = true;
    expect(document.activeElement).toBe(document.body);
    d.reject(failure(500, 'busy'));
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(document.activeElement).toBe(button());
  });

  it('does not take focus back when the owner had moved on', async () => {
    const d = deferred<LearningResetResult>();
    run.mockReturnValue(d.promise);
    render(() => (
      <div>
        <ResetControl testId="the-button" hintTestId="the-hint" spec={spec} onDone={onDone} />
        <input data-testid="elsewhere" />
      </div>
    ));
    button().focus();
    fireEvent.click(button());
    await waitFor(() => expect(button().disabled).toBe(true));
    (screen.getByTestId('elsewhere') as HTMLInputElement).focus();
    d.reject(failure(500, 'busy'));
    await waitFor(() => expect(button().disabled).toBe(false));
    expect(document.activeElement).toBe(screen.getByTestId('elsewhere'));
  });

  it('can be tried again after a failure', async () => {
    run.mockRejectedValueOnce(failure(500, 'busy')).mockResolvedValueOnce({ ok: true, cleared: 3 });
    mount();
    fireEvent.click(button());
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(button().disabled).toBe(false));
    fireEvent.click(button());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith('cleared', 'Cleared 3 things. They are rebuilt on Monday.'));
    expect(run).toHaveBeenCalledTimes(2);
    // The failure line from the first try is gone once the second one starts.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('ResetControl: while the request runs', () => {
  it('disables the button and marks it busy, and two rapid clicks make one request', async () => {
    const d = deferred<LearningResetResult>();
    run.mockReturnValue(d.promise);
    mount();
    fireEvent.click(button());
    await waitFor(() => expect(button().disabled).toBe(true));
    expect(button().getAttribute('aria-busy')).toBe('true');
    fireEvent.click(button());
    button().click();
    expect(run).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledTimes(1);

    d.resolve({ ok: true, cleared: 2 });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('a second click before the first has settled never opens a second confirm', async () => {
    const d = deferred<LearningResetResult>();
    run.mockReturnValue(d.promise);
    mount();
    button().click();
    button().click();
    button().click();
    expect(confirm).toHaveBeenCalledTimes(1);
    d.resolve({ ok: true, cleared: 1 });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });
});

describe('ResetControl: the words', () => {
  it('everything it can say passes the copy sweep', async () => {
    run.mockResolvedValue({ ok: true, cleared: 7 });
    mount();
    fireEvent.click(button());
    await waitFor(() => expect(toast).toHaveBeenCalled());
    const said = [
      button().textContent,
      screen.getByTestId('the-hint').textContent,
      ...confirm.mock.calls.map((c) => String(c[0])),
      ...toast.mock.calls.map((c) => String(c[0])),
      COMMON.forbiddenToast,
      COMMON.readOnlyNote,
      COMMON.clearFailed,
      COMMON.clearOffline,
    ].join('\n');
    expect(copyProblems(said)).toEqual([]);
  });
});
