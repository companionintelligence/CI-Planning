<script>
  import { store } from '../lib/store.svelte.js';
  let { todo } = $props();
  let showSlots = $state(false);
  let slots = $state([]);
  let slotsLoading = $state(false);

  function today() { return new Date().toLocaleDateString('en-CA'); }
  function dueCls(d) {
    if (!d) return '';
    const t = today();
    if (d < t) return 'border-rose-500/40 text-rose-400 bg-rose-500/[0.08]';
    if (d === t) return 'border-amber-500/40 text-amber-400 bg-amber-500/[0.08]';
    return '';
  }
  function fname(p) { return p.split('/').slice(-1)[0]; }

  async function setEstimate() {
    const v = prompt('Estimated minutes for this task?', todo.estimated_minutes ?? 30);
    if (!v) return;
    const minutes = Number(v);
    if (!minutes || minutes <= 0) return;
    try { await store.setEstimate(todo.hash, minutes); } catch (e) { store.showToast(e.message, 'error'); }
  }

  async function findSlots() {
    if (showSlots) { showSlots = false; return; }
    if (!todo.estimated_minutes) {
      store.showToast('Set an estimate first', 'info');
      return;
    }
    slotsLoading = true;
    try {
      slots = await store.findSlots(todo.estimated_minutes);
      showSlots = true;
    } finally { slotsLoading = false; }
  }

  async function scheduleAt(slot) {
    try {
      const date = slot.date;
      const start = new Date(slot.start_at);
      const hh = String(start.getHours()).padStart(2, '0');
      const mm = String(start.getMinutes()).padStart(2, '0');
      await store.scheduleTask(todo.hash, date, `${hh}:${mm}`, todo.estimated_minutes, todo.plain_text);
      showSlots = false;
      store.reloadTodos();
    } catch (e) { store.showToast(e.message, 'error'); }
  }

  function fmtSlot(s) {
    const d = new Date(s.start_at);
    return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
</script>

<li class="px-3.5 py-3 mb-1.5 bg-neutral-900 border border-neutral-800 rounded-xl text-[14px] transition-all duration-100
           hover:border-neutral-700
           { todo.checked ? 'opacity-60' : '' }">
  <div class="flex flex-wrap items-start gap-2.5">
    <input type="checkbox" class="mt-0.5 w-4 h-4 accent-emerald-400 cursor-pointer flex-shrink-0"
           checked={todo.checked}
           onchange={(e) => store.toggle(todo, e.currentTarget.checked)} />
    <span class="flex-1 min-w-[200px] leading-snug { todo.checked ? 'line-through text-neutral-500' : '' }">{todo.plain_text}</span>

    {#each todo.tags || [] as g}
      <span class="text-[11px] text-blue-200 bg-blue-950/60 border border-blue-900 px-2 py-0.5 rounded-full">#{g}</span>
    {/each}

    {#if todo.due_date}
      <span class={'text-[11px] tabular-nums bg-neutral-800 border border-neutral-700 px-2 py-0.5 rounded-full ' + dueCls(todo.due_date)}>{todo.due_date}</span>
    {/if}

    <!-- Estimate chip -->
    {#if todo.estimated_minutes}
      <button onclick={setEstimate}
              class="text-[11px] bg-indigo-500/15 text-indigo-300 border border-indigo-700/50 px-2 py-0.5 rounded-full hover:bg-indigo-500/25"
              title="Set estimate">⏱ {todo.estimated_minutes}m</button>
    {:else}
      <button onclick={setEstimate}
              class="text-[11px] bg-neutral-800 text-neutral-400 border border-dashed border-neutral-600 px-2 py-0.5 rounded-full hover:text-indigo-300 hover:border-indigo-500"
              title="Set estimate">⏱ set</button>
    {/if}

    <!-- Calendar link badge -->
    {#if todo.calendar_event_id}
      <span class="text-[11px] bg-green-500/15 text-green-300 border border-green-700/50 px-2 py-0.5 rounded-full">📅 scheduled</span>
    {/if}

    <!-- Schedule button (open) -->
    {#if !todo.checked && !todo.calendar_event_id}
      <button onclick={findSlots} disabled={slotsLoading}
              class="text-[11px] bg-neutral-800 text-neutral-300 border border-neutral-700 px-2 py-0.5 rounded-full hover:bg-indigo-500/20 hover:text-indigo-300 disabled:opacity-50">
        {slotsLoading ? '…' : '📅 schedule'}
      </button>
    {/if}

    <span class="text-[11px] text-neutral-500 ml-auto">{fname(todo.file_path)}</span>
  </div>

  {#if showSlots}
    <div class="mt-2 pl-7 space-y-1">
      <div class="text-[10px] text-neutral-500 uppercase tracking-wider font-semibold">Suggested slots</div>
      {#if slots.length === 0}
        <div class="text-xs text-neutral-500">No open {todo.estimated_minutes}m slots in the next week.</div>
      {/if}
      {#each slots.slice(0, 5) as s}
        <button onclick={() => scheduleAt(s)}
                class="block w-full text-left text-xs px-2.5 py-1.5 bg-neutral-800/50 hover:bg-indigo-500/15 border border-neutral-700 hover:border-indigo-500 rounded-md text-neutral-200">
          {fmtSlot(s)} <span class="text-neutral-500">·</span> <span class="text-neutral-400">{s.duration_minutes}m</span>
        </button>
      {/each}
    </div>
  {/if}
</li>
