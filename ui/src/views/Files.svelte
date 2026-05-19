<script>
  import { store } from '../lib/store.svelte.js';

  let { onTriage = null } = $props();
  let q = $state('');

  const grouped = $derived.by(() => {
    const m = new Map();
    const needle = q.trim().toLowerCase();
    for (const f of store.files) {
      if (needle && !(`${f.relativePath} ${f.name}`.toLowerCase().includes(needle))) continue;
      const dir = f.relativePath.includes('/') ? f.relativePath.split('/').slice(0, -1).join('/') : '(root)';
      if (!m.has(dir)) m.set(dir, []);
      m.get(dir).push(f);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  });
</script>

<div class="flex items-center gap-2 mb-4">
  <input type="text" bind:value={q} placeholder="Filter files…" autocomplete="off"
    class="flex-1 bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-2.5 text-[14px] focus:outline-none focus:border-blue-500" />
  {#if onTriage}
    <button onclick={() => onTriage(null)}
            class="h-10 px-3 rounded-xl bg-neutral-900 border border-neutral-800 hover:bg-neutral-800 text-[13px] text-neutral-400"
            title="Triage all open todos with LLM">🧹 Triage</button>
  {/if}
</div>

{#each grouped as [dir, fs]}
  <div class="mb-3">
    <div class="text-[11px] uppercase tracking-wider text-neutral-500 font-semibold mb-1">{dir}</div>
    <ul class="list-none p-0 m-0">
      {#each fs as f}
        <li class="my-0.5 flex items-center group">
          <a class="flex-1 flex justify-between gap-2 px-2 py-1.5 rounded-md text-[13px] text-neutral-300 hover:bg-neutral-900 hover:text-blue-400 no-underline" href="#file:{f.directory}/{f.relativePath}">
            <span>{f.name}</span>
            <span class="text-[11px] text-neutral-500 tabular-nums">{f.todos.unchecked}/{f.todos.total}</span>
          </a>
          {#if onTriage}
            <button onclick={() => onTriage(f.path)}
                    class="opacity-0 group-hover:opacity-100 ml-1 px-2 py-1.5 text-[11px] text-neutral-500 hover:text-amber-400 rounded transition-opacity"
                    title="Triage this file">🧹</button>
          {/if}
        </li>
      {/each}
    </ul>
  </div>
{:else}
  <p class="text-neutral-500 text-sm">No files match.</p>
{/each}
