<script>
  import { store } from '../lib/store.svelte.js';
  const cls = $derived(
    store.toast.kind === 'error' ? 'border-rose-500 text-rose-400'
    : store.toast.kind === 'ok' ? 'border-emerald-500 text-emerald-400'
    : 'border-neutral-700 text-neutral-100'
  );
</script>

<div class="fixed left-1/2 -translate-x-1/2 bg-neutral-900 border rounded-full px-4 py-2 shadow-lg z-[100] text-[13px] font-medium transition-all duration-200
            {cls} {store.toast.visible ? 'opacity-100 translate-y-0' : 'opacity-0 pointer-events-none'} "
     style="bottom: calc(24px + env(safe-area-inset-bottom));">
  {store.toast.msg || ' '}
</div>
