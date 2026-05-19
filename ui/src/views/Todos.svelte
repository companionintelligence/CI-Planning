<script>
  import { store } from '../lib/store.svelte.js';
  import TodoItem from '../components/TodoItem.svelte';

  const grouped = $derived.by(() => {
    const m = new Map();
    for (const t of store.todos) {
      const k = t.heading_path || t.file_path.split('/').slice(-1)[0];
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(t);
    }
    return [...m.entries()];
  });

  function setFilter(k, v) {
    store.filters = { ...store.filters, [k]: v };
    store.reloadTodos();
  }
</script>

<header class="flex flex-wrap items-center gap-3 mb-4">
  <span class="text-sm"><b>{store.todos.length}</b> shown</span>

  <div class="flex bg-neutral-900 border border-neutral-800 rounded-lg p-0.5 ml-auto">
    {#each [['open','Open'],['done','Done'],['all','All']] as [v,l]}
      <button class="px-3 py-1 rounded-md text-[12.5px] font-medium
                    { store.filters.status === v ? 'bg-blue-500 text-white' : 'text-neutral-400 hover:text-neutral-200' }"
              onclick={() => setFilter('status', v)}>{l}</button>
    {/each}
  </div>

  <div class="flex flex-wrap gap-1.5">
    {#each [['overdue','Overdue'],['today','Today'],['this_week','This week']] as [v,l]}
      <button class="text-[12px] border rounded-full px-2.5 py-1 transition-colors
                    { store.filters.due === v ? 'bg-blue-500 text-white border-blue-500' : 'bg-neutral-900 text-neutral-400 border-neutral-800 hover:text-neutral-200' }"
              onclick={() => setFilter('due', store.filters.due === v ? '' : v)}>{l}</button>
    {/each}
  </div>
</header>

{#each grouped as [heading, list]}
  <section class="mb-6">
    <h3 class="text-[12px] uppercase tracking-wider font-semibold pl-2 mb-2 border-l-2 border-neutral-700 text-neutral-400">
      {heading} <span class="bg-neutral-900 text-neutral-400 px-1.5 py-0.5 rounded-full text-[11px] ml-1">{list.length}</span>
    </h3>
    <ul class="list-none p-0 m-0">
      {#each list as t (t.hash)}<TodoItem todo={t} />{/each}
    </ul>
  </section>
{:else}
  <div class="text-center py-16">
    <h3 class="text-xl">No matches.</h3>
    <p class="text-neutral-500">Loosen the filters above.</p>
  </div>
{/each}
