<script>
  let { file = null, onclose } = $props();
  let actions = $state([]);
  let model = $state('');
  let loading = $state(true);
  let error = $state('');

  const CATEGORY_STYLE = {
    keep:      'text-emerald-400 border-emerald-900 bg-emerald-950/40',
    archive:   'text-neutral-400 border-neutral-700 bg-neutral-800/40',
    duplicate: 'text-amber-400 border-amber-900 bg-amber-950/40',
    rewrite:   'text-blue-400 border-blue-900 bg-blue-950/40',
    move:      'text-purple-400 border-purple-900 bg-purple-950/40',
  };

  async function load() {
    loading = true; error = '';
    try {
      const body = { limit: 60 };
      if (file) body.path = file;
      const r = await fetch('/api/llm/triage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (r.status === 503) { error = 'Ollama is not running. Start it with `ollama serve`.'; return; }
      const d = await r.json();
      actions = d.actions ?? [];
      model = d.model ?? '';
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
  <div class="w-full max-w-2xl bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl overflow-hidden"
       onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="triage-title">
    <header class="flex items-center justify-between px-5 py-3.5 border-b border-neutral-800">
      <div>
        <b id="triage-title" class="text-[15px]">Triage</b>
        {#if file}<span class="text-neutral-500 text-[12px] ml-2">{file.split('/').slice(-1)[0]}</span>{/if}
        {#if model}<span class="text-neutral-600 text-[11px] ml-2">via {model}</span>{/if}
      </div>
      <button onclick={onclose} class="text-neutral-500 hover:text-neutral-200 text-lg leading-none">✕</button>
    </header>

    <div class="max-h-[65vh] overflow-y-auto">
      {#if loading}
        <p class="text-neutral-500 animate-pulse px-5 py-6">Running triage…</p>
      {:else if error}
        <p class="text-rose-400 px-5 py-6">{error}</p>
      {:else if actions.length === 0}
        <p class="text-neutral-500 px-5 py-6">No suggestions generated.</p>
      {:else}
        <ul class="divide-y divide-neutral-800">
          {#each actions as a}
            <li class="px-5 py-3.5 flex flex-col gap-1">
              <div class="flex items-center gap-2.5">
                <span class={'text-[11px] font-semibold uppercase tracking-wide border rounded-full px-2 py-0.5 ' + (CATEGORY_STYLE[a.category] ?? 'text-neutral-400 border-neutral-700')}>
                  {a.category}
                </span>
                <span class="text-[13px] text-neutral-200 leading-snug flex-1">
                  {a.suggested_text ?? a.reason}
                </span>
              </div>
              {#if a.reason && a.suggested_text}
                <span class="text-[12px] text-neutral-500 ml-14">{a.reason}</span>
              {/if}
              {#if a.suggested_heading}
                <span class="text-[11px] text-purple-400 ml-14">→ {a.suggested_heading}</span>
              {/if}
              <span class="text-[10px] text-neutral-700 ml-14 font-mono">{a.hash}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <footer class="flex justify-between items-center px-5 py-3 border-t border-neutral-800 text-[12px] text-neutral-500">
      <span>{actions.length} suggestion{actions.length !== 1 ? 's' : ''} — review-only, no auto-apply</span>
      <div class="flex gap-2">
        <button onclick={load} class="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-[12px] text-neutral-300">Re-run</button>
        <button onclick={onclose} class="px-3 py-1.5 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-[12px]">Close</button>
      </div>
    </footer>
  </div>
</div>
