<script>
  import { onMount } from 'svelte';
  import { store } from '../lib/store.svelte.js';

  let filter = $state('all'); // all | suggested | maybe_done | duplicate

  onMount(() => {
    store.loadSuggestions();
  });

  const filtered = $derived.by(() => {
    if (filter === 'all') return store.suggestions;
    return store.suggestions.filter(s => s.kind === filter);
  });

  const counts = $derived({
    all: store.suggestions.length,
    suggested: store.suggestions.filter(s => s.kind === 'suggested').length,
    maybe_done: store.suggestions.filter(s => s.kind === 'maybe_done').length,
    duplicate: store.suggestions.filter(s => s.kind === 'duplicate').length,
  });

  function kindLabel(kind) {
    if (kind === 'maybe_done') return 'Maybe done';
    if (kind === 'duplicate') return 'Duplicate';
    return 'Suggested';
  }

  function fileBasename(p) {
    return p?.split('/').slice(-1)[0] ?? '';
  }
</script>

<div class="max-w-2xl mx-auto">
  <h1 class="text-2xl font-bold mb-1">Review</h1>
  <p class="text-neutral-500 text-sm mb-4">
    {counts.all} pending · {counts.maybe_done} maybe-done · {counts.duplicate} duplicates
  </p>

  <div class="flex gap-px bg-neutral-900 p-0.5 rounded-lg mb-4 w-fit">
    {#each [['all','All'], ['suggested','Suggested'], ['maybe_done','Maybe done'], ['duplicate','Duplicates']] as [k, label]}
      <button onclick={() => filter = k}
              class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                     {filter === k ? 'bg-neutral-800 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'}">
        {label} ({counts[k] ?? 0})
      </button>
    {/each}
  </div>

  {#if filtered.length === 0}
    <div class="text-center py-10 text-neutral-500 text-sm">
      {#if store.suggestions.length === 0}
        Nothing in the Review queue. Open a file and click "Extract tasks" to populate.
      {:else}
        No {filter} items.
      {/if}
    </div>
  {/if}

  <div class="space-y-2">
    {#each filtered as s (s.id)}
      <div class="bg-neutral-900 border border-neutral-800 rounded-xl p-4
                  {s.kind === 'maybe_done' ? 'border-l-2 border-l-green-500' : ''}
                  {s.kind === 'suggested'  ? 'border-l-2 border-l-indigo-500' : ''}
                  {s.kind === 'duplicate'  ? 'border-l-2 border-l-amber-500' : ''}">

        <div class="flex items-center justify-between mb-2">
          <span class="text-[10px] font-bold tracking-wider uppercase px-1.5 py-0.5 rounded
                       {s.kind === 'maybe_done' ? 'bg-green-500/15 text-green-300' : ''}
                       {s.kind === 'suggested'  ? 'bg-indigo-500/15 text-indigo-300' : ''}
                       {s.kind === 'duplicate'  ? 'bg-amber-500/15 text-amber-300' : ''}">
            {kindLabel(s.kind)}
          </span>
          <span class="text-[10px] text-neutral-500 font-mono">{fileBasename(s.file_path)}</span>
        </div>

        <p class="text-sm text-neutral-100 leading-snug mb-2">{s.text}</p>

        {#if s.source_quote}
          <p class="text-[11px] text-neutral-400 italic mb-3 p-2 bg-neutral-950 rounded border-l-2 border-neutral-700">
            "{s.source_quote}"
          </p>
        {/if}

        <div class="flex gap-1.5">
          <button onclick={() => store.acceptSuggestion(s.id)}
                  class="flex-1 py-1.5 text-xs font-medium rounded-md
                         bg-green-500/10 border border-green-700 text-green-400 hover:bg-green-500/20">
            ✓ {s.kind === 'maybe_done' ? 'Mark done' : s.kind === 'duplicate' ? 'Merge' : 'Accept'}
          </button>
          <button onclick={() => store.dismissSuggestion(s.id)}
                  class="flex-1 py-1.5 text-xs font-medium rounded-md
                         bg-neutral-800 border border-neutral-700 text-neutral-400 hover:bg-neutral-700 hover:text-white">
            Dismiss
          </button>
        </div>
      </div>
    {/each}
  </div>
</div>
