<script>
  let q = $state('');
  let results = $state([]);
  let loading = $state(false);
  let timer;
  function runSearch() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (q.trim().length < 2) { results = []; return; }
      loading = true;
      try {
        const r = await fetch('/api/search?q=' + encodeURIComponent(q));
        const d = await r.json();
        results = d.results;
      } finally {
        loading = false;
      }
    }, 200);
  }
</script>

<div class="max-w-3xl mx-auto">
  <input type="search" bind:value={q} oninput={runSearch} placeholder="Search every note…" autocomplete="off"
    class="w-full bg-neutral-900 border border-neutral-800 rounded-2xl px-5 py-3.5 text-base focus:outline-none focus:border-blue-500" />

  {#if loading}
    <p class="text-neutral-500 mt-4 text-sm">Searching…</p>
  {:else if results.length === 0 && q.trim().length >= 2}
    <p class="text-neutral-500 mt-4 text-sm">No hits.</p>
  {/if}

  {#each results as h}
    <div class="my-3 p-3.5 bg-neutral-900 border border-neutral-800 rounded-xl hover:border-neutral-700">
      <a class="font-semibold text-blue-400 no-underline" href="#file:{h.path.split('/').slice(-1)[0]}">{h.path.split('/').slice(-1)[0]}</a>
      <div class="text-neutral-400 text-[13px] mt-1.5">{@html h.snippet}</div>
    </div>
  {/each}
</div>

<style>
  /* allow <mark> highlights from server */
  :global(.text-neutral-400 mark) { background: rgba(122,162,247,0.25); color: #e6e7ec; padding: 0 2px; border-radius: 3px; }
</style>
