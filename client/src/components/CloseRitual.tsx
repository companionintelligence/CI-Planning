import { createSignal, For, Show } from 'solid-js';
import { Laugh, Meh, Frown, Zap, X } from 'lucide-solid';
import { api, type Mood, type Task } from '../lib/api.js';
import { refetchTasks, showToast } from '../stores/index.js';

/**
 * The close ritual — a small sheet offered right AFTER a task is ticked off: how did it
 * feel, why, and how long did it really take.
 *
 * Design rules this encodes:
 *  - Entirely SKIPPABLE. The task is already complete before this opens (the checkbox did
 *    that). Dismissing writes nothing; there is no "cancel the completion" here.
 *  - Faces, not a 1-5 score. People answer a face instantly and honestly; a numeric
 *    self-rating invites deliberation and means something different to every user.
 *  - The duration field is pre-filled with what the timer actually recorded, so the common
 *    case is "confirm", not "compute".
 *
 * `reaction_at` is stamped server-side at submit — deliberately NOT `completed_at`. The
 * gap between them is real signal: a reflection written now reads the work more accurately
 * than one reconstructed days later, and the metrics surface the median lag.
 */

const FACES: { mood: Mood; label: string; icon: typeof Laugh; color: string }[] = [
  { mood: 'happy',      label: 'Good',       icon: Laugh, color: '#58ebbf' },
  { mood: 'flat',       label: 'Fine',       icon: Meh,   color: '#94a3b8' },
  { mood: 'frustrated', label: 'Frustrated', icon: Frown, color: '#f97316' },
  { mood: 'stressed',   label: 'Stressed',   icon: Zap,   color: '#ef4444' },
];

export function CloseRitual(props: { task: Task; onClose: () => void }) {
  const [mood, setMood] = createSignal<Mood | null>(null);
  const [note, setNote] = createSignal('');
  // Pre-fill from the timer's truth, falling back to the estimate — confirming a number
  // is a far lower bar than producing one.
  const [minutes, setMinutes] = createSignal<number>(
    props.task.actual_minutes || props.task.estimated_minutes || 0,
  );
  const [saving, setSaving] = createSignal(false);

  const dirty = () => mood() !== null || note().trim() !== '' || minutes() !== (props.task.actual_minutes ?? 0);

  async function save() {
    if (!dirty()) { props.onClose(); return; }
    setSaving(true);
    try {
      await api.tasks.close(props.task.id, {
        ...(mood() ? { mood: mood()! } : {}),
        ...(note().trim() ? { note: note().trim() } : {}),
        ...(minutes() >= 0 ? { actual_minutes: minutes() } : {}),
      });
      refetchTasks();
      showToast('Logged', 'success');
      props.onClose();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div class="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" onClick={props.onClose}>
      <div class="card w-full max-w-sm p-0 overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div class="flex items-center gap-2 px-4 py-3 border-b border-border">
          <div class="flex-1 min-w-0">
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground">Nice — done</div>
            <div class="text-sm font-semibold text-foreground truncate">{props.task.title}</div>
          </div>
          {/* Explicitly labelled: dismissing loses only the reflection, never the completion. */}
          <button type="button" class="btn-icon" title="Skip — the task stays done" onClick={props.onClose}>
            <X size={14} />
          </button>
        </div>

        <div class="p-4 flex flex-col gap-4">
          <div>
            <div class="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">How did it go?</div>
            <div class="flex gap-2">
              <For each={FACES}>
                {(f) => {
                  const on = () => mood() === f.mood;
                  return (
                    <button
                      type="button"
                      // A second tap clears the pick — a mis-tap must be undoable without
                      // closing and reopening the sheet.
                      onClick={() => setMood(on() ? null : f.mood)}
                      class="flex-1 flex flex-col items-center gap-1 py-2 rounded-xl border transition-colors"
                      classList={{ 'border-border text-muted-foreground hover:text-foreground': !on() }}
                      style={on() ? { 'border-color': f.color, color: f.color, background: `${f.color}1a` } : {}}
                      title={f.label}
                    >
                      <f.icon size={20} />
                      <span class="text-[10px] font-medium">{f.label}</span>
                    </button>
                  );
                }}
              </For>
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
                value={minutes()}
                onInput={(e) => setMinutes(Math.max(0, Number(e.currentTarget.value) || 0))}
              />
              <span class="text-xs text-muted-foreground">minutes</span>
              <Show when={props.task.estimated_minutes}>
                <span class="text-[10px] text-muted-foreground ml-auto">
                  estimated {props.task.estimated_minutes}m
                </span>
              </Show>
            </div>
          </div>
        </div>

        <div class="flex items-center gap-2 px-4 py-3 border-t border-border">
          <button type="button" class="btn-ghost text-xs flex-1" onClick={props.onClose}>Skip</button>
          <button type="button" class="btn-primary text-xs flex-1" disabled={saving()} onClick={save}>
            {saving() ? 'Saving…' : 'Log it'}
          </button>
        </div>
      </div>
    </div>
  );
}
