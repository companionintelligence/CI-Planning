import { createMemo, createSignal, For, Show } from 'solid-js';
import { Smile, Meh, Frown, X } from 'lucide-solid';
import { api, DECLINED_SCORE, type Block, type Score, type Task } from '../lib/api.js';
import { blocks, refetchTasks, showToast } from '../stores/index.js';
import { defaultDuration, pickBlock } from '../lib/close-ritual-duration.js';
import { FACE_KEYS, scoreOf, toggleFace, type FaceKey } from '../lib/close-ritual-score.js';

/**
 * The close ritual — a small sheet offered right AFTER a task is ticked off: how did it
 * feel, why, and how long did it really take.
 *
 * Design rules this encodes:
 *  - Entirely SKIPPABLE. The task is already complete before this opens (the checkbox did
 *    that). There is no "cancel the completion" here.
 *  - Faces, not a numeric input. People answer a face instantly and honestly; typing a
 *    number invites deliberation. 0161 keeps the faces and gets a 1-5 scale out of them by
 *    allowing a SECOND pick — so the input stays a tap while the stored value becomes an
 *    ordered score that can be averaged and trended (the old four moods could not be:
 *    "frustrated" and "stressed" are both bad in different directions).
 *  - The duration field is pre-filled from the block the work was allocated, so the common
 *    case is "confirm", not "compute".
 *
 * `reaction_at` is stamped server-side at submit — deliberately NOT `completed_at`. The
 * gap between them is real signal: a reflection written now reads the work more accurately
 * than one reconstructed days later, and the metrics surface the median lag.
 */

/** Icons and colours for the three faces. The ORDER and the encoding live in
 *  lib/close-ritual-score.ts — pure, and unit-tested without a DOM. */
const FACE_META: Record<FaceKey, { label: string; icon: typeof Frown; color: string }> = {
  frown: { label: 'Bad',  icon: Frown, color: '#f97316' },
  flat:  { label: 'Fine', icon: Meh,   color: '#94a3b8' },
  smile: { label: 'Good', icon: Smile, color: '#58ebbf' },
};

const FACES = FACE_KEYS.map((key) => ({ key, ...FACE_META[key] }));

export function CloseRitual(props: {
  task: Task;
  /** How many more are waiting behind this one, for the "1 of N" header. */
  remaining: number;
  /** Rated or skipped — drop this one, show the next. */
  onAdvance: () => void;
  /** Skip the rest — empty the backlog. */
  onSkipAll: () => void;
  /** The block the completion came from, when the caller knows it. */
  preferBlockId?: string | null;
  /** Injectable clock — the tests need a fixed `now`, the app never passes it. */
  nowMs?: number;
}) {
  const [picked, setPicked] = createSignal<FaceKey[]>([]);
  const [note, setNote] = createSignal('');
  const [saving, setSaving] = createSignal(false);

  /**
   * The instant the sheet OPENED, frozen — not a live clock.
   *
   * The owner's rule is "the default end time should be when the completion modal
   * launches", so it must not creep. A live `Date.now()` inside the memo below would
   * re-read the clock on every recompute (a blocks refetch is enough), and a sheet left
   * open while you think would quietly inflate the duration it is asking you to confirm.
   * The component is mounted `keyed` per queue entry, so this runs once per task.
   */
  const openedAt = props.nowMs ?? Date.now();

  // The pre-filled duration and the one-line explanation of where it came from. This DOES
  // recompute when `blocks()` refetches — which is wanted: a block arriving late gives a
  // better answer than the estimate fallback. Only the clock is pinned, and `touched()`
  // below means a recompute can never overwrite a number the user has edited.
  const derived = createMemo(() => {
    const list = (blocks() ?? []) as Block[];
    return defaultDuration(props.task, pickBlock(list, props.task.id, openedAt, props.preferBlockId), openedAt);
  });

  const [minutes, setMinutes] = createSignal<number>(derived().minutes);
  const [touched, setTouched] = createSignal(false);
  const shownMinutes = () => (touched() ? minutes() : derived().minutes);

  const score = () => scoreOf(picked());
  const total = () => props.remaining + 1;

  async function send(body: { score?: Score | typeof DECLINED_SCORE; note?: string; actual_minutes?: number }) {
    await api.tasks.close(props.task.id, body);
  }

  /**
   * Log it. Sends a score ONLY when faces were actually picked.
   *
   * Pressing "Log it" with a note but no face is not a decline: the user engaged, they
   * just didn't rate. Sending DECLINED here would conflate "wrote a reflection, skipped
   * the faces" with "dismissed the sheet" and inflate the decline rate — the one number
   * that is supposed to tell you whether the prompt has become a nag. 0 stays what the
   * migration says it is: exclusively a skip artifact. No score at all leaves the column
   * NULL, which already means "no rating given".
   */
  async function save() {
    const s = score();
    setSaving(true);
    try {
      await send({
        ...(s !== null ? { score: s } : {}),
        ...(note().trim() ? { note: note().trim() } : {}),
        actual_minutes: shownMinutes(),
      });
      refetchTasks();
      showToast('Logged', 'success');
      props.onAdvance();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  /**
   * Skip this one. Records DECLINED (0) rather than writing nothing, so "prompted and
   * declined" stays distinguishable from "never prompted" — that difference is how you
   * find out whether the prompt has become a nag. It is not a 3: a dismissal is not a
   * neutral rating, and scoring it as one would drag the metrics mean with data nobody
   * entered. Fire-and-forget — a failed decline must never block the sheet from closing.
   */
  function skip() {
    void send({ score: DECLINED_SCORE }).catch(() => {});
    props.onAdvance();
  }

  function skipAll() {
    void send({ score: DECLINED_SCORE }).catch(() => {});
    props.onSkipAll();
  }

  return (
    <div class="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" onClick={skip}>
      <div class="card w-full max-w-sm p-0 overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <div class="flex-1 min-w-0">
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground">
              Nice — done
              <Show when={props.remaining > 0}>
                <span class="ml-1.5 text-primary">· 1 of {total()}</span>
              </Show>
            </div>
            <div class="text-sm font-semibold text-foreground truncate">{props.task.title}</div>
          </div>
          <button type="button" class="btn-icon" title="Skip — the task stays done" onClick={skip}>
            <X size={14} />
          </button>
        </div>

        <div class="p-4 flex flex-col gap-4">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
              How did it go?
              <span class="ml-1 normal-case tracking-normal">— pick one, or two for in-between</span>
            </div>
            <div class="flex gap-2">
              <For each={FACES}>
                {(f) => {
                  const on = () => picked().includes(f.key);
                  return (
                    <button
                      type="button"
                      onClick={() => setPicked((p) => toggleFace(p, f.key))}
                      class="flex-1 flex flex-col items-center gap-1 py-2 rounded-xl border transition-colors"
                      classList={{ 'border-border text-muted-foreground hover:text-foreground': !on() }}
                      style={on() ? { 'border-color': f.color, color: f.color, background: `${f.color}1a` } : {}}
                      title={f.label}
                      aria-pressed={on()}
                    >
                      <f.icon size={20} />
                      <span class="text-[10px] font-medium">{f.label}</span>
                    </button>
                  );
                }}
              </For>
            </div>
            {/* The derived score, shown back so a two-face pick is not a guess. */}
            <div class="text-[10px] text-muted-foreground mt-1.5 h-3">
              <Show when={score() !== null}>{score()} out of 5</Show>
            </div>
          </div>

          <div>
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
              Anything worth remembering?
            </div>
            <textarea
              class="input text-sm w-full resize-none"
              rows={2}
              placeholder="Optional — what made it easy or hard…"
              value={note()}
              onInput={(e) => setNote(e.currentTarget.value)}
            />
          </div>

          <div>
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">
              How long did it actually take?
            </div>
            <div class="flex items-center gap-2">
              <input
                type="number"
                min="0"
                step="5"
                class="input text-sm w-24"
                value={shownMinutes()}
                onInput={(e) => { setTouched(true); setMinutes(Math.max(0, Number(e.currentTarget.value) || 0)); }}
              />
              <span class="text-xs text-muted-foreground">minutes</span>
              <Show when={props.task.estimated_minutes}>
                <span class="text-[10px] text-muted-foreground ml-auto">
                  estimated {props.task.estimated_minutes}m
                </span>
              </Show>
            </div>
            <Show when={!touched()}>
              <div class="text-[10px] text-muted-foreground mt-1">{derived().explain}</div>
            </Show>
          </div>
        </div>

        <div class="flex items-center gap-2 px-4 py-3 border-t border-border">
          <button type="button" class="btn-ghost text-xs flex-1" onClick={skip}>Skip</button>
          <button type="button" class="btn-primary text-xs flex-1" disabled={saving()} onClick={save}>
            {saving() ? 'Saving…' : 'Log it'}
          </button>
        </div>

        {/* The burst escape hatch: only worth offering when there IS a backlog. */}
        <Show when={props.remaining > 0}>
          <button
            type="button"
            class="w-full text-[11px] text-muted-foreground hover:text-foreground py-2 border-t border-border"
            onClick={skipAll}
          >
            Skip the rest ({props.remaining} more)
          </button>
        </Show>
      </div>
    </div>
  );
}
