import { For } from 'solid-js';
import { PATTERN_COLORS, colorVar } from '../lib/pattern-meta.js';

/**
 * ItemColorPicker (#391) — the shared swatch grid for per-item colours
 * (routines/habits/objectives) and per-type colours in the type manager.
 * Extracted from the PatternBlockSettings edit-row idiom so every picker renders
 * identically. Tokens only (CI-Hub keys, never hex); `null` = the "inherit" chip,
 * shown first: a hollow swatch that clears the item's own colour so it falls back
 * (type colour for patterns, the accent hash for objectives).
 */
export function ItemColorPicker(props: {
  value: string | null | undefined;
  onChange: (token: string | null) => void;
  /** Tooltip for the inherit (clear) chip — say what the fallback IS. */
  inheritLabel?: string;
}) {
  return (
    <div class="flex flex-wrap gap-1.5">
      <button
        type="button"
        onClick={() => props.onChange(null)}
        title={props.inheritLabel ?? 'Inherit'}
        class="w-5 h-5 rounded-full border-2 transition-all bg-transparent"
        classList={{
          'border-foreground scale-110': props.value == null,
          'border-border hover:scale-105': props.value != null,
        }}
      >
        <span class="sr-only">Inherit</span>
      </button>
      <For each={PATTERN_COLORS}>
        {(c) => (
          <button
            type="button"
            onClick={() => props.onChange(c.token)}
            title={c.label}
            class="w-5 h-5 rounded-full border-2 transition-all"
            classList={{
              'border-foreground scale-110': props.value === c.token,
              'border-transparent hover:scale-105': props.value !== c.token,
            }}
            style={{ 'background-color': colorVar(c.token) }}
          />
        )}
      </For>
    </div>
  );
}
