import { createSignal, createMemo, createEffect, onCleanup, onMount, Show, For } from 'solid-js';
import { X, FileText, ListChecks, Tag, Check, RotateCcw, ArrowRight } from 'lucide-solid';
import { api, type Block, type ExtendMove } from '../lib/api.js';
import { colorVar } from '../lib/pattern-meta.js';
import { tasks, taskOf, refetchTasks, refetchBlocks, showToast } from '../stores/index.js';
import { focusState, focusCues, formatRemaining, overrunNote, type Cue } from '../lib/focus.js';

/**
 * Phase Z · Z3b (Time-Sense) — the Focus Ritual screen.
 *
 * A calm full-screen surface over an in-progress Time Block: the task name is the
 * anchor; description/subtasks/tags hide behind icon toggles (progressive
 * disclosure, §1.0). Ambient category color depletes across the block and breathes
 * in the final 3 minutes; haptic pulses mark the transitions (§1.1). At the end a
 * "what's next" modal offers Keep working / Schedule again / Objective complete,
 * wired to the Z3a engines. All timing math lives in lib/focus.ts.
 *
 * Cues are tick-driven (not setTimeout) so a backgrounded tab catches up on
 * refocus; background delivery is handled by the Z4 reminders armed on open.
 */

const CUE_VIBRATE: Record<Cue['kind'], number[]> = {
  start: [200],
  mid: [120],
  warn: [100, 50, 100],
  end: [300, 120, 300],
};

export function FocusRitual(props: { block: Block; next?: Block | null; onClose: () => void }) {
  const startMs = Date.parse(props.block.start_at);
  // The end can grow via "Keep working"; track it as state so the ritual continues.
  const [endMs, setEndMs] = createSignal(Date.parse(props.block.end_at));

  const [now, setNow] = createSignal(Date.now());
  const clock = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(clock));

  const reducedMotion =
    typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const canVibrate = typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';

  const state = createMemo(() => focusState(now(), startMs, endMs()));

  // Fire each cue once, the first tick at/after its instant (so a refocused tab
  // that missed the exact second still fires it). Haptics only — the color owns
  // continuous duration; a screen flash would pull the eyes off the work (§1.2).
  const firedCues = new Set<string>();
  createEffect(() => {
    const t = now();
    for (const c of focusCues(startMs, endMs())) {
      const key = `${c.kind}@${c.at}`;
      if (c.at <= t && !firedCues.has(key)) {
        firedCues.add(key);
        if (canVibrate) { try { navigator.vibrate(CUE_VIBRATE[c.kind]); } catch { /* capability lie — ignore */ } }
      }
    }
  });

  // Background cues (tab-closed): arm on open, clear on any exit.
  onMount(() => { void api.blocks.armFocusReminders(props.block.id).catch(() => {}); });
  function exit(after?: () => void) {
    void api.blocks.clearFocusReminders(props.block.id).catch(() => {});
    after?.();
    props.onClose();
  }

  const task = () => taskOf(props.block.task_id);
  const subtasks = () => (props.block.task_id ? (tasks() ?? []).filter((x) => x.parent_id === props.block.task_id) : []);
  const tagList = () => task()?.tags ?? [];

  const [panel, setPanel] = createSignal<null | 'desc' | 'subs' | 'tags'>(null);
  const togglePanel = (p: 'desc' | 'subs' | 'tags') => setPanel((cur) => (cur === p ? null : p));

  // ── T4 "what's next" ────────────────────────────────────────────────────────
  const ended = () => state().phase === 'ended';
  const [pendingMoves, setPendingMoves] = createSignal<ExtendMove[] | null>(null);
  const [blockedBy, setBlockedBy] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  const overNote = () => {
    const n = props.next;
    if (!n) return null;
    return overrunNote(endMs() + 10 * 60_000, Date.parse(n.start_at), n.title);
  };

  async function keepWorking(confirm = false) {
    setBusy(true);
    try {
      const r = await api.blocks.extend(props.block.id, { minutes: 10, confirm });
      if (!r.fits) { setBlockedBy(r.blockedBy?.title ?? 'a fixed event'); setPendingMoves(null); return; }
      if (r.movedSet.length && !r.committed) { setPendingMoves(r.movedSet); setBlockedBy(null); return; }
      setEndMs(Date.parse(r.newEndAt)); // resume the ritual against the new end
      setPendingMoves(null); setBlockedBy(null);
      void refetchBlocks();
      void api.blocks.armFocusReminders(props.block.id).catch(() => {}); // re-arm for the later end
    } catch (e) { showToast((e as Error).message, 'error'); }
    finally { setBusy(false); }
  }
  async function scheduleAgain() {
    setBusy(true);
    try { await api.blocks.reschedule(props.block.id); void refetchBlocks(); void refetchTasks(); exit(); }
    catch (e) { showToast((e as Error).message, 'error'); setBusy(false); }
  }
  async function objectiveComplete() {
    setBusy(true);
    try {
      if (props.block.task_id) await api.tasks.update(props.block.task_id, { completed: true });
      void refetchTasks(); void refetchBlocks(); exit();
    } catch (e) { showToast((e as Error).message, 'error'); setBusy(false); }
  }

  // Ambient tint fades as the block depletes; the final 3 minutes breathe (unless
  // reduced motion, which keeps a steady tint + the discrete haptic/text cues).
  const tint = () => colorVar(props.block.color_token);
  const ambientOpacity = () => {
    const s = state();
    if (s.phase === 'warning') return reducedMotion ? 0.35 : undefined; // breathing class drives it
    if (s.phase === 'ended') return 0.5;
    return 0.65 - 0.55 * s.depletionFrac; // strong → faint across the block
  };

  return (
    <div class="fixed inset-0 z-[1100] flex flex-col bg-background" role="dialog" aria-label="Focus">
      {/* Ambient category-color layer */}
      <div
        class="pointer-events-none absolute inset-0 transition-opacity duration-1000"
        classList={{ 'focus-breath': state().phase === 'warning' && !reducedMotion }}
        style={{ background: tint(), opacity: ambientOpacity() as number | undefined }}
      />

      {/* Close (exit ritual, keep the block) */}
      <button class="absolute top-4 right-4 z-10 btn-icon opacity-60 hover:opacity-100" onClick={() => exit()} title="Leave focus">
        <X size={18} />
      </button>

      {/* Center: the anchor + disclosure + countdown */}
      <div class="relative z-[1] flex-1 flex flex-col items-center justify-center gap-6 px-6 text-center">
        <div class="max-w-lg w-full flex flex-col items-center gap-4">
          <h1 class="text-3xl md:text-4xl font-semibold text-foreground leading-tight">{props.block.title}</h1>

          {/* Disclosure toggles — one detail at a time, collapsed by default (§1.0). */}
          <div class="flex items-center gap-2">
            <Show when={task()?.description}>
              <DiscButton active={panel() === 'desc'} label="Description" onClick={() => togglePanel('desc')}><FileText size={15} /></DiscButton>
            </Show>
            <Show when={subtasks().length > 0}>
              <DiscButton active={panel() === 'subs'} label="Subtasks" onClick={() => togglePanel('subs')}><ListChecks size={15} /></DiscButton>
            </Show>
            <Show when={tagList().length > 0}>
              <DiscButton active={panel() === 'tags'} label="Tags" onClick={() => togglePanel('tags')}><Tag size={15} /></DiscButton>
            </Show>
          </div>

          <Show when={panel() === 'desc'}>
            <p class="text-sm text-muted-foreground whitespace-pre-line max-w-md">{task()?.description}</p>
          </Show>
          <Show when={panel() === 'subs'}>
            <ul class="text-sm text-left w-full max-w-md flex flex-col gap-1.5">
              <For each={subtasks()}>
                {(s) => (
                  <li class="flex items-center gap-2">
                    <span
                      class="flex-shrink-0 w-4 h-4 rounded-full border flex items-center justify-center"
                      classList={{ 'bg-primary border-primary': s.status === 'done', 'border-border': s.status !== 'done' }}
                    >
                      <Show when={s.status === 'done'}><Check size={10} class="text-primary-foreground" /></Show>
                    </span>
                    <span classList={{ 'line-through text-muted-foreground': s.status === 'done', 'text-foreground': s.status !== 'done' }}>{s.title}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={panel() === 'tags'}>
            <div class="flex flex-wrap gap-1.5 justify-center max-w-md">
              <For each={tagList()}>{(t) => <span class="badge-neutral text-[11px]">#{t}</span>}</For>
            </div>
          </Show>
        </div>

        {/* Countdown — the felt-duration readout, not an anxious ticker. */}
        <div class="tabular-nums text-5xl md:text-6xl font-light text-foreground/90" aria-live="off">
          {formatRemaining(state().remainingMs)}
        </div>
      </div>

      {/* T4 — the "what's next" modal (rendered in place at the end). */}
      <Show when={ended()}>
        <div class="relative z-[2] mx-auto mb-10 w-full max-w-md rounded-xl border border-border bg-card p-4 shadow-lg">
          <div class="text-sm font-semibold text-foreground mb-1">Time's up — what's next?</div>
          <Show when={props.next}>
            <div class="text-xs text-muted-foreground mb-3">
              Next: <span class="text-foreground">{props.next!.title}</span> at {props.next!.start_at.slice(11, 16)}.
            </div>
          </Show>

          <Show when={blockedBy()}>
            <div class="text-xs text-amber-500 mb-2">Runs into {blockedBy()} (fixed). Add less time, or schedule again.</div>
          </Show>
          <Show when={pendingMoves()}>
            <div class="text-xs text-muted-foreground mb-2">
              Moves {pendingMoves()!.length} later block{pendingMoves()!.length === 1 ? '' : 's'}. Confirm?
              <div class="flex gap-2 mt-2">
                <button class="btn-primary text-xs px-3 py-1" disabled={busy()} onClick={() => keepWorking(true)}>Move &amp; continue</button>
                <button class="btn-ghost text-xs px-3 py-1" onClick={() => setPendingMoves(null)}>Cancel</button>
              </div>
            </div>
          </Show>

          <Show when={!pendingMoves()}>
            <div class="flex flex-col gap-2">
              <div class="flex gap-2">
                <button class="btn-ghost flex-1 text-sm py-2" disabled={busy()} onClick={() => keepWorking(false)}>
                  <RotateCcw size={14} /> Keep working
                  <span class="text-[10px] text-muted-foreground ml-1">+10m</span>
                </button>
                <button class="btn-ghost flex-1 text-sm py-2" disabled={busy()} onClick={scheduleAgain}>
                  <ArrowRight size={14} /> Schedule again
                </button>
              </div>
              <button class="btn-primary text-sm py-2" disabled={busy()} onClick={objectiveComplete}>
                <Check size={14} /> Objective complete
              </button>
              <Show when={overNote()}>
                <div class="text-[10px] text-muted-foreground text-center">{overNote()}</div>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function DiscButton(props: { active: boolean; label: string; onClick: () => void; children: any }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      aria-pressed={props.active}
      title={props.label}
      class="btn-icon rounded-full border transition-colors"
      classList={{ 'border-primary text-primary bg-primary/10': props.active, 'border-border text-muted-foreground hover:text-foreground': !props.active }}
    >
      {props.children}
    </button>
  );
}
