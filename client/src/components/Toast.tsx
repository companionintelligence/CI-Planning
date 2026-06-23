import { For, Show } from 'solid-js';
import { CheckCircle, XCircle, Info } from 'lucide-solid';
import { toasts } from '../stores/index.js';

export function ToastContainer() {
  return (
    <div class="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
      <For each={toasts()}>
        {(t) => (
          <div
            class={
              t.kind === 'success' ? 'toast-success' :
              t.kind === 'error'   ? 'toast-error'   : 'toast'
            }
          >
            {t.kind === 'success' ? <CheckCircle size={15} class="text-green-400 flex-shrink-0" /> :
             t.kind === 'error'   ? <XCircle     size={15} class="text-red-400 flex-shrink-0"   /> :
                                    <Info        size={15} class="text-slate-400 flex-shrink-0" />}
            <span>{t.message}</span>
            <Show when={t.action}>
              <button type="button" class="ml-2 underline underline-offset-2 hover:no-underline pointer-events-auto"
                onClick={() => t.action!.run()}>{t.action!.label}</button>
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}
