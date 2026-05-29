<script>
  import { onMount } from 'svelte';
  import { store } from '../lib/store.svelte.js';

  let config = $state(null);
  let stats = $state(null);
  let llm = $state(null);
  let rescanning = $state(false);
  let rescanResult = $state(null);
  let lastSummaries = $state(null);
  let summaryBusy = $state('');

  async function loadSummaries() {
    const r = await fetch('/api/summaries').then(r => r.json()).catch(() => null);
    lastSummaries = r?.last ?? null;
  }

  onMount(async () => {
    const [cfgRes, statsRes, llmRes] = await Promise.all([
      fetch('/api/config').then(r => r.json()),
      fetch('/api/stats').then(r => r.json()),
      fetch('/api/llm/status').then(r => r.json()),
    ]);
    config = cfgRes;
    stats = statsRes;
    llm = llmRes;
    loadSummaries();
  });

  async function rescan() {
    rescanning = true;
    rescanResult = null;
    try {
      const r = await fetch('/api/rescan', { method: 'POST' });
      const data = await r.json();
      rescanResult = data;
      await store.refresh();
    } finally {
      rescanning = false;
    }
  }

  async function runSummary(period) {
    summaryBusy = period;
    try {
      const r = await fetch(`/api/summary/${period}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      const d = await r.json();
      if (d.ok) store.showToast(`${period} summary → ${d.file.split('/').slice(-1)[0]} (${d.counts.completed} done)`, 'success');
      else store.showToast(d.error || 'Summary failed', 'error');
      await loadSummaries();
    } catch (e) {
      store.showToast(e.message, 'error');
    } finally {
      summaryBusy = '';
    }
  }

  async function reconcile() {
    summaryBusy = 'reconcile';
    try {
      const r = await fetch('/api/reconcile', { method: 'POST' });
      const d = await r.json();
      store.showToast(`Closed ${d.events_completed} past blocks · ${d.overdue_now} overdue`, 'success');
    } finally {
      summaryBusy = '';
    }
  }

  function fmtAgo(ms) {
    if (!ms) return 'never';
    const diff = Date.now() - ms;
    const h = Math.floor(diff / 3600000);
    if (h < 1) return 'just now';
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  }
</script>

<div class="space-y-8 max-w-xl">
  <h1 class="text-2xl font-semibold">Settings</h1>

  <!-- App info -->
  <section class="rounded-xl bg-neutral-900 p-5 space-y-3">
    <h2 class="text-sm font-medium text-neutral-400 uppercase tracking-wider">App</h2>
    {#if config}
      <div class="space-y-2 text-sm">
        <div class="flex justify-between">
          <span class="text-neutral-400">Title</span>
          <span>{config.title}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-neutral-400">Port</span>
          <span>{config.port}</span>
        </div>
      </div>
    {:else}
      <p class="text-neutral-500 text-sm">Loading…</p>
    {/if}
  </section>

  <!-- Index stats -->
  <section class="rounded-xl bg-neutral-900 p-5 space-y-3">
    <h2 class="text-sm font-medium text-neutral-400 uppercase tracking-wider">Index</h2>
    {#if stats}
      <div class="grid grid-cols-3 gap-3 text-center">
        <div class="bg-neutral-800 rounded-lg p-3">
          <div class="text-2xl font-bold">{stats.files ?? 0}</div>
          <div class="text-xs text-neutral-400 mt-1">files</div>
        </div>
        <div class="bg-neutral-800 rounded-lg p-3">
          <div class="text-2xl font-bold">{stats.todos_open ?? 0}</div>
          <div class="text-xs text-neutral-400 mt-1">open</div>
        </div>
        <div class="bg-neutral-800 rounded-lg p-3">
          <div class="text-2xl font-bold">{stats.todos_done ?? 0}</div>
          <div class="text-xs text-neutral-400 mt-1">done</div>
        </div>
      </div>
      <button
        onclick={rescan}
        disabled={rescanning}
        class="w-full mt-2 py-2 px-4 rounded-lg bg-neutral-700 hover:bg-neutral-600 text-sm font-medium transition-colors disabled:opacity-50"
      >
        {rescanning ? 'Rescanning…' : 'Rescan files'}
      </button>
      {#if rescanResult}
        <p class="text-xs text-neutral-400 text-center">
          {rescanResult.files} files · {rescanResult.todos} todos in {rescanResult.ms}ms
        </p>
      {/if}
    {:else}
      <p class="text-neutral-500 text-sm">Loading…</p>
    {/if}
  </section>

  <!-- Summaries & routines -->
  <section class="rounded-xl bg-neutral-900 p-5 space-y-3">
    <h2 class="text-sm font-medium text-neutral-400 uppercase tracking-wider">Summaries &amp; routines</h2>
    <p class="text-xs text-neutral-500">
      Generate a review now, or let the scheduled routines run them
      (daily 21:00 · weekly Sun 19:00 · monthly 1st 08:00). Reviews are written to
      <code class="text-neutral-400">Summaries/</code> and reconcile closes past calendar blocks.
    </p>
    <div class="grid grid-cols-3 gap-2">
      {#each ['daily','weekly','monthly'] as p}
        <button onclick={() => runSummary(p)} disabled={summaryBusy === p}
                class="py-2 px-3 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm font-medium capitalize disabled:opacity-50">
          {summaryBusy === p ? '…' : p}
        </button>
      {/each}
    </div>
    {#if lastSummaries}
      <div class="space-y-1 text-xs text-neutral-400">
        {#each ['daily','weekly','monthly'] as p}
          <div class="flex justify-between">
            <span class="capitalize">{p}</span>
            <span class="text-neutral-500">
              {lastSummaries[p] ? `${lastSummaries[p].key} · ${fmtAgo(lastSummaries[p].at)}` : 'never run'}
            </span>
          </div>
        {/each}
      </div>
    {/if}
    <button onclick={reconcile} disabled={summaryBusy === 'reconcile'}
            class="w-full mt-1 py-2 px-4 rounded-lg bg-neutral-800 hover:bg-neutral-700 text-sm font-medium disabled:opacity-50">
      {summaryBusy === 'reconcile' ? 'Reconciling…' : 'Reconcile past calendar blocks'}
    </button>
  </section>

  <!-- LLM status -->
  <section class="rounded-xl bg-neutral-900 p-5 space-y-3">
    <h2 class="text-sm font-medium text-neutral-400 uppercase tracking-wider">Ollama</h2>
    {#if llm}
      <div class="flex items-center gap-2">
        <span class="w-2 h-2 rounded-full {llm.available ? 'bg-green-500' : 'bg-neutral-600'}"></span>
        <span class="text-sm">{llm.available ? 'Available' : 'Unavailable'}</span>
      </div>
      {#if llm.available && llm.models?.length}
        <div class="space-y-1">
          {#each llm.models as model}
            <div class="text-xs text-neutral-400 font-mono bg-neutral-800 rounded px-2 py-1">{model}</div>
          {/each}
        </div>
      {/if}
    {:else}
      <p class="text-neutral-500 text-sm">Checking…</p>
    {/if}
  </section>

  <!-- Watched directories -->
  <section class="rounded-xl bg-neutral-900 p-5 space-y-3">
    <h2 class="text-sm font-medium text-neutral-400 uppercase tracking-wider">Watched directories</h2>
    {#if config?.directories?.length}
      <ul class="space-y-1">
        {#each config.directories as dir}
          <li class="text-xs font-mono text-neutral-300 bg-neutral-800 rounded px-2 py-1 break-all">{dir}</li>
        {/each}
      </ul>
      <p class="text-xs text-neutral-500">Edit config.json to change watched directories, then restart the server.</p>
    {:else}
      <p class="text-neutral-500 text-sm">No directories configured.</p>
    {/if}
  </section>

  <!-- Cache reset -->
  <section class="rounded-xl bg-neutral-900 p-5 space-y-3">
    <h2 class="text-sm font-medium text-neutral-400 uppercase tracking-wider">PWA cache</h2>
    <p class="text-sm text-neutral-400">If the app looks stale after an update, reset the service worker cache.</p>
    <button
      onclick={() => {
        if ('serviceWorker' in navigator) {
          navigator.serviceWorker.getRegistrations().then(regs => {
            regs.forEach(r => r.unregister());
            location.reload();
          });
        }
      }}
      class="py-2 px-4 rounded-lg bg-neutral-700 hover:bg-neutral-600 text-sm font-medium transition-colors"
    >
      Reset cache & reload
    </button>
  </section>
</div>
