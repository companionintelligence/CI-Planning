<script>
  import { onMount } from 'svelte';
  import { store } from '../lib/store.svelte.js';

  let weeks = $state(3);
  let workdayMinutes = $state(480);
  let selectedDay = $state(null);

  let syncing = $state(false);

  onMount(async () => {
    await store.loadLookahead(weeks, workdayMinutes);
    await store.loadCalendarStatus();
  });

  async function refresh() {
    await store.loadLookahead(weeks, workdayMinutes);
    selectedDay = null;
  }

  async function syncCalendar() {
    syncing = true;
    try {
      const r = await fetch('/api/calendar/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weeks }),
      });
      const d = await r.json();
      if (d.ok) {
        store.showToast(`Synced ${d.new_events} new, ${d.updated_events} updated`, 'success');
        await refresh();
      } else {
        store.showToast(d.error || 'Sync failed', 'error');
      }
    } catch (e) {
      store.showToast(e.message, 'error');
    } finally {
      syncing = false;
    }
  }

  function barColor(pct) {
    if (pct >= 95) return 'red';
    if (pct >= 70) return 'amber';
    if (pct === 0) return 'empty';
    return 'green';
  }

  function fmtDay(date) {
    const d = new Date(date + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function isToday(date) {
    return date === store.todayStr();
  }

  // Group days into rolling weeks for the week summary
  const weekSummary = $derived.by(() => {
    if (!store.lookahead.days.length) return [];
    const out = [];
    let current = null;
    for (const d of store.lookahead.days) {
      const day = new Date(d.date + 'T00:00:00');
      const weekNum = Math.floor((day.getTime() - new Date(2026, 0, 1).getTime()) / (7 * 86400000)) + 1;
      if (!current || current.week !== weekNum) {
        current = { week: weekNum, committed: 0, totalDays: 0, tasksDue: 0 };
        out.push(current);
      }
      current.committed += d.committed_minutes;
      current.tasksDue += d.tasks_due;
      current.totalDays++;
    }
    return out.map(w => ({
      ...w,
      pct: Math.round((w.committed / (w.totalDays * workdayMinutes)) * 100),
    }));
  });

  const overCapacityCount = $derived(store.lookahead.days.filter(d => d.over_capacity).length);
  const totalDue = $derived(store.lookahead.days.reduce((s, d) => s + d.tasks_due, 0));
  const totalUnscheduled = $derived(store.lookahead.days.reduce((s, d) => s + d.tasks_unscheduled, 0));
</script>

<div class="max-w-2xl mx-auto">
  <div class="flex items-end justify-between mb-1">
    <h1 class="text-2xl font-bold">Capacity</h1>
    <div class="flex items-center gap-2">
      {#if store.calendar?.available}
        <button onclick={syncCalendar} disabled={syncing}
                class="text-xs text-indigo-300 hover:text-white bg-indigo-500/15 border border-indigo-700/50 rounded-lg px-2.5 py-1 disabled:opacity-50"
                title="Pull calendar events ({store.calendar.provider})">
          {syncing ? 'Syncing…' : '📅 Sync calendar'}
        </button>
      {/if}
      <button onclick={refresh}
              class="text-xs text-neutral-400 hover:text-white bg-neutral-900 border border-neutral-800 rounded-lg px-2.5 py-1">
        ↻ Refresh
      </button>
    </div>
  </div>
  <p class="text-neutral-500 text-sm mb-4">
    Next {weeks} week{weeks === 1 ? '' : 's'} ·
    {#if overCapacityCount > 0}
      <span class="text-rose-400 font-semibold">{overCapacityCount} day{overCapacityCount === 1 ? '' : 's'} over capacity</span> ·
    {/if}
    {totalDue} due · {totalUnscheduled} unscheduled
  </p>

  <!-- Weeks toggle -->
  <div class="flex gap-2 mb-4 items-center">
    <div class="flex gap-px bg-neutral-900 p-0.5 rounded-lg">
      {#each [1, 3, 6] as n}
        <button onclick={async () => { weeks = n; await store.loadLookahead(n, workdayMinutes); selectedDay = null; }}
                class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors
                       {weeks === n ? 'bg-neutral-800 text-white shadow-sm' : 'text-neutral-400 hover:text-neutral-200'}">
          {n} week{n === 1 ? '' : 's'}
        </button>
      {/each}
    </div>
    <div class="text-xs text-neutral-500 ml-auto">
      Workday: <input type="number" min="60" max="720" step="30"
                     bind:value={workdayMinutes}
                     onchange={refresh}
                     class="w-16 bg-neutral-900 border border-neutral-800 rounded px-1.5 py-0.5 text-white text-xs"/> min
    </div>
  </div>

  <!-- Day rows -->
  <div class="space-y-1.5">
    {#each store.lookahead.days as d (d.date)}
      <button
        onclick={() => selectedDay = (selectedDay === d.date ? null : d.date)}
        class="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-left border transition-colors
               {isToday(d.date) ? 'bg-blue-500/[0.05] border-blue-500/40' : 'bg-neutral-900 border-neutral-800 hover:bg-neutral-800/50'}
               {selectedDay === d.date ? 'ring-1 ring-blue-500/50' : ''}">
        <div class="w-20 flex-shrink-0">
          <div class="text-xs font-semibold text-neutral-100">{fmtDay(d.date)}</div>
          {#if isToday(d.date)}<div class="text-[10px] text-blue-400">today</div>{/if}
        </div>
        <div class="flex-1 h-[22px] bg-neutral-950 rounded-md overflow-hidden relative">
          {#if d.capacity_pct > 0}
            {@const c = barColor(d.capacity_pct)}
            <div class="h-full rounded-md transition-all
                        {c === 'green' ? 'bg-gradient-to-r from-green-600 to-green-500' : ''}
                        {c === 'amber' ? 'bg-gradient-to-r from-amber-600 to-amber-500' : ''}
                        {c === 'red'   ? 'bg-gradient-to-r from-red-600 to-red-500' : ''}"
                 style="width: {Math.min(d.capacity_pct, 110)}%;"></div>
          {/if}
        </div>
        <div class="w-24 text-right text-[11px] text-neutral-400 leading-tight">
          {#if d.capacity_pct > 0}
            <div><b class="text-white text-xs">{Math.round(d.committed_minutes / 60 * 10) / 10}h</b>
              · <span class="font-semibold
                         {d.capacity_pct >= 95 ? 'text-rose-400' : d.capacity_pct >= 70 ? 'text-amber-400' : 'text-green-400'}">
                {d.capacity_pct}%
              </span></div>
            <div>{d.tasks_due} due · {d.tasks_unscheduled} unsched</div>
          {:else}
            <div class="text-neutral-600">free</div>
            <div>{d.tasks_due} due</div>
          {/if}
        </div>
      </button>

      {#if selectedDay === d.date}
        <div class="bg-neutral-900 border border-neutral-800 rounded-xl p-4 mb-1.5 ml-3">
          <div class="text-xs font-semibold text-neutral-300 mb-2">{fmtDay(d.date)} — Detail</div>
          <div class="text-xs text-neutral-400 mb-3">
            {Math.round(d.committed_minutes)}m committed of {d.workday_minutes}m workday
            ({d.capacity_pct}% full) · est. work: {d.estimated_minutes}m
          </div>
          <div class="space-y-1.5">
            <div class="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold">
              {d.event_count} calendar event{d.event_count === 1 ? '' : 's'} · {d.tasks_due} task{d.tasks_due === 1 ? '' : 's'} due
            </div>
            {#if d.tasks_unscheduled > 0}
              <div class="bg-amber-500/[0.08] border-l-2 border-amber-500 rounded p-2 text-xs">
                <span class="font-semibold text-amber-400">⚠ {d.tasks_unscheduled} unscheduled task{d.tasks_unscheduled === 1 ? '' : 's'}</span>
                — open Todos tab and use "Schedule this" to block time
              </div>
            {/if}
          </div>
        </div>
      {/if}
    {/each}
  </div>

  <!-- Week summary chart -->
  {#if weekSummary.length > 1}
    <div class="mt-6">
      <div class="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold mb-2 px-1">
        Week-by-week load
      </div>
      <div class="flex items-end gap-2 h-[140px] p-3 bg-neutral-900 rounded-xl border border-neutral-800">
        {#each weekSummary as w (w.week)}
          {@const c = barColor(w.pct)}
          <div class="flex-1 flex flex-col items-center gap-1.5">
            <div class="w-full flex-1 bg-neutral-950 rounded relative flex items-end">
              <div class="w-full rounded
                          {c === 'green' ? 'bg-green-500' : ''}
                          {c === 'amber' ? 'bg-amber-500' : ''}
                          {c === 'red'   ? 'bg-red-500' : ''}
                          {c === 'empty' ? 'bg-neutral-800' : ''}"
                   style="height: {Math.min(w.pct, 110)}%;"></div>
            </div>
            <div class="text-[10px] text-neutral-400 font-semibold">W{w.week}</div>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if store.lookahead.days.length === 0}
    <div class="text-center py-8 text-neutral-500 text-sm">
      No data yet. Click Refresh to load capacity.
    </div>
  {/if}
</div>
