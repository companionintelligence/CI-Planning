<script>
  let { onclose } = $props();
  let text = $state('');
  let loading = $state(true);
  let error = $state('');

  async function load() {
    loading = true; error = ''; text = '';
    try {
      const r = await fetch('/api/llm/summary', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      if (r.status === 503) { error = 'Ollama is not running. Start it with `ollama serve`.'; return; }
      const d = await r.json();
      text = d.text ?? JSON.stringify(d);
    } catch (e) {
      error = String(e);
    } finally {
      loading = false;
    }
  }

  load();
</script>

<div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4"
     onclick={onclose} role="presentation">
  <div class="w-full max-w-lg bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl overflow-hidden"
       onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="briefing-title">
    <header class="flex items-center justify-between px-5 py-3.5 border-b border-neutral-800">
      <b id="briefing-title" class="text-[15px]">Daily briefing</b>
      <button onclick={onclose} class="text-neutral-500 hover:text-neutral-200 text-lg leading-none">✕</button>
    </header>
    <div class="px-5 py-4 max-h-[60vh] overflow-y-auto text-[14px] leading-relaxed text-neutral-300">
      {#if loading}
        <p class="text-neutral-500 animate-pulse">Generating briefing…</p>
      {:else if error}
        <p class="text-rose-400">{error}</p>
      {:else}
        {#each text.split('\n').filter(l => l.trim()) as para}
          <p class="mb-3">{para}</p>
        {/each}
      {/if}
    </div>
    <footer class="flex justify-end px-5 py-3 border-t border-neutral-800">
      <button onclick={onclose} class="px-4 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-[13px]">Close</button>
    </footer>
  </div>
</div>
