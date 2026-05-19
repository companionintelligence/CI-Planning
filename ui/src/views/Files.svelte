<script>
  import { store } from '../lib/store.svelte.js';
  let q = $state('');
  const grouped = $derived.by(() => {
    const m = new Map();
    const needle = q.trim().toLowerCase();
    for (const f of store.files) {
      if (needle && !(`${f.relativePath} ${f.name}`.toLowerCase().includes(needle))) continue;
      const dir = (f.relativePath.includes('/') ? f.relativePath.split('/').slice(0, -1).join('/') : '(root)');
      if (!m.has(dir)) m.set(dir, []);
      m.get(dir).push(f);
    }
    return [...m.entries()].sort((a,b) => a[0].localeCompare(b[0]));
  });
</script>

<input type="text" bind:value={q} placeholder="Filter files…" autocomplete="off"
  class="w-full bg-neutral-900 border border-neutral-800 rounded-xl px-4 py-2.5 mb-4 text-[14px] focus:outline-none focus:border-blue-500" />

{#each grouped as [dir, fs]}
  <div class="mb-3">
    <div class="text-[11px] uppercase tracking-wider text-neutral-500 font-semibold mb-1">{dir}</div>
    <ul class="list-none p-0 m-0">
      {#each fs as f}
        <li class="my-0.5">
          <a class="flex justify-between gap-2 px-2 py-1.5 rounded-md text-[13px] text-neutral-300 hover:bg-neutral-900 hover:text-blue-400 no-underline" href="#file:{f.directory}/{f.relativePath}">
            <span>{f.name}</span>
            <span class="text-[11px] text-neutral-500 tabular-nums">{f.todos.unchecked}/{f.todos.total}</span>
          </a>
        </li>
      {/each}
    </ul>
  </div>
{/each}
