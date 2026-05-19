<script>
  import { store } from '../lib/store.svelte.js';

  const views = [
    { id: 'today',  label: 'Today' },
    { id: 'todos',  label: 'Todos' },
    { id: 'files',  label: 'Files' },
    { id: 'search', label: 'Search' },
  ];

  function setView(v) {
    store.view = v;
    history.replaceState(null, '', '#' + v);
  }
</script>

<header class="flex flex-wrap items-center gap-3 px-4 py-2.5 border-b border-neutral-800 bg-neutral-950/90 backdrop-blur supports-[backdrop-filter]:bg-neutral-950/70" style="padding-top: max(10px, env(safe-area-inset-top));">
  <a href="#today" onclick={(e) => { e.preventDefault(); setView('today'); }} class="flex items-center gap-2 no-underline text-neutral-100 font-semibold">
    <img src="/icons/icon-192.png" alt="" width="26" height="26" class="rounded-md" />
    <span class="text-[15px]">Companion <i class="font-normal text-neutral-500 not-italic">Planning</i></span>
  </a>

  <nav class="flex gap-0.5 bg-neutral-900 p-0.5 rounded-[10px] border border-neutral-800">
    {#each views as v}
      <button
        class="px-3 py-1.5 rounded-md text-[13px] font-medium transition-colors duration-150
               { store.view === v.id ? 'bg-neutral-800 text-neutral-100 shadow-sm' : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/[0.04]' }"
        onclick={() => setView(v.id)}
      >{v.label}</button>
    {/each}
  </nav>

  <div class="ml-auto flex items-center gap-2">
    <span class="text-[12px] tabular-nums text-neutral-400 bg-neutral-900 border border-neutral-800 rounded-full px-2.5 py-1">
      <b class="text-neutral-100">{store.stats.todos_open}</b>
      <span class="text-neutral-600">·</span>
      <span class={store.stats.overdue ? 'text-rose-400 font-semibold' : ''}>{store.stats.overdue}</span> overdue
      <span class="text-neutral-600">·</span>
      <span class={store.stats.due_today ? 'text-amber-400 font-semibold' : ''}>{store.stats.due_today}</span> today
    </span>

    <button class="h-9 px-2.5 rounded-lg bg-neutral-900 border border-neutral-800 hover:bg-neutral-800 text-[13px]" onclick={() => store.refresh()} title="Refresh">↻</button>
  </div>
</header>
