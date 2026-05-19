<script>
  import { store } from '../lib/store.svelte.js';
  import TodoItem from '../components/TodoItem.svelte';
  const groups = $derived(store.groupedToday());
  function todayStr() { return new Date().toISOString().slice(0,10); }
</script>

<section class="mb-6">
  <h2 class="text-2xl font-bold tracking-tight">Today <span class="font-medium text-base text-neutral-500">· {todayStr()}</span></h2>
  <p class="text-neutral-400 text-sm">A quick scan of what matters.</p>
</section>

{#if groups.overdue.length}
  <section class="mb-6">
    <h3 class="text-[12px] uppercase tracking-wider font-semibold pl-2 mb-2 border-l-2 border-rose-500 text-rose-400">
      Overdue <span class="bg-neutral-900 text-neutral-400 px-1.5 py-0.5 rounded-full text-[11px] ml-1">{groups.overdue.length}</span>
    </h3>
    <ul class="list-none p-0 m-0">
      {#each groups.overdue as t (t.hash)}<TodoItem todo={t} />{/each}
    </ul>
  </section>
{/if}

{#if groups.today.length}
  <section class="mb-6">
    <h3 class="text-[12px] uppercase tracking-wider font-semibold pl-2 mb-2 border-l-2 border-amber-500 text-amber-400">
      Due today <span class="bg-neutral-900 text-neutral-400 px-1.5 py-0.5 rounded-full text-[11px] ml-1">{groups.today.length}</span>
    </h3>
    <ul class="list-none p-0 m-0">
      {#each groups.today as t (t.hash)}<TodoItem todo={t} />{/each}
    </ul>
  </section>
{/if}

{#if groups.nodue.length}
  <section class="mb-6">
    <h3 class="text-[12px] uppercase tracking-wider font-semibold pl-2 mb-2 border-l-2 border-neutral-700 text-neutral-400">
      Open (no due date) <span class="bg-neutral-900 text-neutral-400 px-1.5 py-0.5 rounded-full text-[11px] ml-1">{groups.nodue.length}</span>
    </h3>
    <ul class="list-none p-0 m-0">
      {#each groups.nodue as t (t.hash)}<TodoItem todo={t} />{/each}
    </ul>
  </section>
{/if}

{#if !groups.overdue.length && !groups.today.length && !groups.nodue.length}
  <div class="text-center py-16">
    <h3 class="text-xl">Inbox zero.</h3>
    <p class="text-neutral-500">Nothing open. Take a walk.</p>
  </div>
{/if}
