import { Show, createSignal } from 'solid-js';
import { Lock, LockOpen } from 'lucide-solid';
import { api, type Block } from '../lib/api.js';
import { refetchBlocks, showToast } from '../stores/index.js';
import { lockAffordance, lockActionLabel, sourceLine } from '../lib/lock.js';

/**
 * The one lock affordance (Phase 1). A padlock the owner can toggle — filled when
 * locked — surfaced anywhere a scheduled item is described: the details drawer's
 * BlockPanel, the Planner's entity card, and the Focus rows once Phases 2–3 build
 * them.
 *
 * A SYNCED event renders no control at all (decision 1): in its place, the source
 * line that explains why it cannot move. See `lib/lock.ts` for that decision — it is
 * pure so every surface answers identically.
 *
 * Locking is not new behaviour for reflow: `auto-defense` already pins a locked
 * block ("a user-pinned block holds its slot AND its task"). This phase only makes
 * the state visible and settable everywhere.
 */
export function LockToggle(props: { block: Block; class?: string }) {
  const b = () => props.block;
  const [busy, setBusy] = createSignal(false);
  const locked = () => !!b().is_locked;
  const action = () => lockActionLabel(locked());

  async function toggle() {
    if (busy()) return;
    setBusy(true);
    const next = !locked();
    try {
      await api.blocks.update(b().id, { is_locked: next });
      refetchBlocks();
      showToast(next ? 'Locked' : 'Unlocked', 'default');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Show
      when={lockAffordance(b()) === 'toggle'}
      fallback={
        // Synced: provenance, not a control. The lock icon still reads as "fixed",
        // and the line says which calendar owns it.
        <span
          class={`inline-flex items-center gap-1 text-xs text-muted-foreground ${props.class ?? ''}`}
          title="Synced events are updated by their calendar — they cannot be unlocked here"
        >
          <Lock size={13} class="flex-shrink-0" />
          {sourceLine(b())}
        </span>
      }
    >
      <button
        type="button"
        onClick={toggle}
        disabled={busy()}
        aria-pressed={locked()}
        title={action().title}
        class={`btn-ghost text-xs px-2 py-1 disabled:opacity-50 ${props.class ?? ''}`}
      >
        <Show when={locked()} fallback={<LockOpen size={13} />}>
          <Lock size={13} />
        </Show>
        {action().label}
      </button>
    </Show>
  );
}
