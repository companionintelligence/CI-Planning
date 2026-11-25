import { Repeat, X } from 'lucide-solid';
import { recurringScopeAsk, answerRecurringScope } from '../stores/index.js';
import { ModalSheet } from '../ui/index.js';

/**
 * "Just this one, or this and everything after it?" — asked before changing or deleting
 * a single occurrence of a repeating item.
 *
 * Mounted once at the app root and driven by the `recurringScopeAsk` signal, so any call
 * site can `await askRecurringScope(...)` inline instead of restructuring itself around
 * modal callbacks.
 *
 * The destructive option is NOT the default and is styled as the dangerous one: "this and
 * following" can remove occurrences the user never looked at, and that must never be the
 * thing a stray Enter keypress does.
 */
export function RecurringScopeDialog() {
  const ask = () => recurringScopeAsk();
  const isDelete = () => ask().verb === 'delete';
  const title = () => isDelete() ? 'Delete repeating item' : 'Change repeating item';

  return (
    <ModalSheet
      open={ask().open}
      title={title()}
      ariaLabel={`${title()}: ${ask().title}`}
      onClose={() => answerRecurringScope(null)}
      class="max-w-sm"
      header={
        <header class="flex flex-shrink-0 items-start justify-between gap-2 border-b border-border px-4 py-3">
          <div class="flex min-w-0 items-start gap-2">
            <Repeat size={15} class="text-muted-foreground mt-0.5 flex-shrink-0" />
            <div class="min-w-0">
              <h2 class="text-sm font-semibold text-foreground">{title()}</h2>
              <div class="text-xs text-muted-foreground truncate">{ask().title}</div>
            </div>
          </div>
          <button type="button" class="btn-icon flex-shrink-0" aria-label="Close dialog" onClick={() => answerRecurringScope(null)}><X size={15} /></button>
        </header>
      }
    >
        <div class="px-4 pb-4 flex flex-col gap-3">

          <p class="text-xs text-muted-foreground">
            This repeats. {isDelete() ? 'Delete' : 'Apply the change to'} only this one, or this
            one and every later repeat? Earlier ones are never affected.
          </p>

          <div class="flex flex-col gap-2">
            <button
              type="button"
              autofocus
              class="btn-primary text-sm justify-center"
              onClick={() => answerRecurringScope('instance')}
            >
              {isDelete() ? 'Delete this one only' : 'Only this one'}
            </button>
            <button
              type="button"
              class="btn-secondary text-sm justify-center border-destructive/50 text-destructive hover:bg-destructive/10"
              onClick={() => answerRecurringScope('following')}
            >
              {isDelete() ? 'Delete this and all following' : 'This and all following'}
            </button>
            <button
              type="button"
              class="btn-ghost text-xs justify-center"
              onClick={() => answerRecurringScope(null)}
            >
              Cancel
            </button>
          </div>
        </div>
    </ModalSheet>
  );
}
