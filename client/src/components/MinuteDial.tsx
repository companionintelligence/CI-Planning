import { createSignal, For } from 'solid-js';
import { Minus, Plus } from 'lucide-solid';

/**
 * The minute dial (Step 3). A fast task's estimate is predicted, then nudged with
 * up/down arrows that step by a selectable increment — **1 · 3 · 15** minutes (the
 * "dial"). Controlled: the caller owns `value` and persists in `onChange`.
 */
const STEPS = [1, 3, 15] as const;

export function MinuteDial(props: { value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  const [step, setStep] = createSignal<number>(1);
  const clamp = (v: number) => Math.min(props.max ?? 24 * 60, Math.max(props.min ?? 0, v));
  const bump = (dir: number) => props.onChange(clamp(props.value + dir * step()));

  return (
    <div class="inline-flex items-center gap-1.5">
      <div class="inline-flex items-center rounded-md border border-border overflow-hidden">
        <button type="button" onClick={() => bump(-1)} title={`−${step()} min`}
          class="px-1.5 py-1 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent">
          <Minus size={12} />
        </button>
        <span class="px-2 text-xs tabular-nums text-foreground min-w-[3rem] text-center">{props.value}m</span>
        <button type="button" onClick={() => bump(1)} title={`+${step()} min`}
          class="px-1.5 py-1 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent">
          <Plus size={12} />
        </button>
      </div>
      {/* The dial — pick the step increment. */}
      <div class="inline-flex rounded-md border border-border overflow-hidden text-[10px]" title="Step size (minutes)">
        <For each={STEPS}>
          {(s) => (
            <button type="button" onClick={() => setStep(s)}
              class="px-1.5 py-1 tabular-nums"
              classList={{ 'bg-primary/15 text-primary': step() === s, 'text-muted-foreground hover:text-foreground': step() !== s }}>
              {s}
            </button>
          )}
        </For>
      </div>
    </div>
  );
}
