<script>
  import { store } from '../lib/store.svelte.js';
  let { todo } = $props();
  function today() { return new Date().toISOString().slice(0,10); }
  function dueCls(d) {
    if (!d) return '';
    const t = today();
    if (d < t) return 'border-rose-500/40 text-rose-400 bg-rose-500/[0.08]';
    if (d === t) return 'border-amber-500/40 text-amber-400 bg-amber-500/[0.08]';
    return '';
  }
  function fname(p) { return p.split('/').slice(-1)[0]; }
</script>

<li class="flex flex-wrap items-start gap-2.5 px-3.5 py-3 mb-1.5 bg-neutral-900 border border-neutral-800 rounded-xl text-[14px] transition-all duration-100
           hover:border-neutral-700 hover:-translate-y-px hover:shadow-sm
           { todo.checked ? 'opacity-60' : '' }">
  <input type="checkbox" class="mt-0.5 w-4 h-4 accent-emerald-400 cursor-pointer flex-shrink-0"
         checked={todo.checked}
         onchange={(e) => store.toggle(todo, e.currentTarget.checked)} />
  <span class="flex-1 min-w-[200px] leading-snug { todo.checked ? 'line-through text-neutral-500' : '' }">{todo.plain_text}</span>
  {#each todo.tags || [] as g}
    <span class="text-[11px] text-blue-200 bg-blue-950/60 border border-blue-900 px-2 py-0.5 rounded-full">#{g}</span>
  {/each}
  {#if todo.due_date}
    <span class={'text-[11px] tabular-nums bg-neutral-800 border border-neutral-700 px-2 py-0.5 rounded-full ' + dueCls(todo.due_date)}>{todo.due_date}</span>
  {/if}
  <span class="text-[11px] text-neutral-500 ml-auto">{fname(todo.file_path)}</span>
</li>
