<script>
  import { store } from '../lib/store.svelte.js';

  // mode: 'create' | 'edit'. todo is the existing row when editing.
  let { mode = 'create', todo = null, onclose } = $props();

  // Form state
  let text = $state(todo?.plain_text ?? '');
  let filePath = $state(todo?.file_path ?? store.activeFilePath ?? (store.files[0]?.path ?? ''));
  let heading = $state(todo?.heading ?? 'Inbox');
  let due = $state(todo?.due_date ?? '');
  let dueTime = $state(''); // optional time-of-day, used only for calendar scheduling
  let tagsInput = $state((todo?.tags ?? []).join(', '));
  let priority = $state(todo?.priority ?? 0);
  let estimate = $state(todo?.estimated_minutes ?? '');
  let saving = $state(false);
  let scheduleAfterSave = $state(false);

  // Heading suggestions from the active file
  let headingOptions = $state([]);
  $effect(() => {
    if (!filePath) { headingOptions = []; return; }
    fetch(`/api/file?path=${encodeURIComponent(filePath)}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { headingOptions = d?.headings?.map(h => h.text) ?? []; })
      .catch(() => { headingOptions = []; });
  });

  const fileOptions = $derived(store.files.map(f => ({ path: f.path, label: f.relativePath || f.name || f.path })));

  function parseTags(s) {
    return s.split(/[,\s]+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean);
  }

  // Quick due-date presets
  function setDuePreset(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    due = d.toLocaleDateString('en-CA');
  }
  function clearDue() { due = ''; dueTime = ''; }

  async function save() {
    if (!text.trim()) { store.showToast('Text required', 'error'); return; }
    saving = true;
    try {
      const tags = parseTags(tagsInput);
      const est = estimate ? Number(estimate) : null;
      const pri = priority ? Number(priority) : null;
      let resultHash;
      if (mode === 'create') {
        if (!filePath) { store.showToast('Pick a file', 'error'); saving = false; return; }
        const r = await store.createTodo({
          path: filePath, heading, text: text.trim(),
          due: due || null, tags, priority: pri, estimate_minutes: est,
        });
        resultHash = r?.hash;
      } else {
        const r = await store.editTodo(todo.hash, {
          text: text.trim(), due: due || null, tags, priority: pri, estimate_minutes: est,
        });
        resultHash = r?.hash;
      }
      // Optionally jump straight to scheduling
      if (scheduleAfterSave && resultHash && due) {
        const time = dueTime || '09:00';
        try {
          await store.scheduleTask(resultHash, due, time, est || 30, text.trim());
        } catch (e) { store.showToast('Saved, but schedule failed: ' + e.message, 'error'); }
      }
      onclose?.();
    } catch (e) {
      store.showToast(e.message, 'error');
    } finally {
      saving = false;
    }
  }

  function onKeydown(e) {
    if (e.key === 'Escape') onclose?.();
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') save();
  }
</script>

<svelte:window onkeydown={onKeydown} />

<div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center p-4 pt-[8vh]"
     onclick={onclose} role="presentation">
  <div class="w-full max-w-lg bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl overflow-hidden"
       onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Todo editor">

    <div class="flex items-center justify-between px-5 py-3.5 border-b border-neutral-800">
      <h2 class="text-base font-semibold">{mode === 'create' ? 'New todo' : 'Edit todo'}</h2>
      <button onclick={onclose} aria-label="Close"
              class="w-7 h-7 rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-white">✕</button>
    </div>

    <div class="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
      <!-- Text -->
      <div>
        <label for="td-text" class="block text-[11px] uppercase tracking-wider text-neutral-500 font-semibold mb-1.5">Task</label>
        <textarea id="td-text" bind:value={text} rows="2" autofocus
                  placeholder="What needs doing?"
                  class="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-3 py-2 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none resize-none"></textarea>
      </div>

      <!-- File + heading (create only; edit keeps location) -->
      {#if mode === 'create'}
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label for="td-file" class="block text-[11px] uppercase tracking-wider text-neutral-500 font-semibold mb-1.5">File</label>
            <select id="td-file" bind:value={filePath}
                    class="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-2.5 py-2 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none">
              {#each fileOptions as f}<option value={f.path}>{f.label}</option>{/each}
            </select>
          </div>
          <div>
            <label for="td-heading" class="block text-[11px] uppercase tracking-wider text-neutral-500 font-semibold mb-1.5">Section</label>
            <input id="td-heading" list="heading-opts" bind:value={heading} placeholder="Inbox"
                   class="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-2.5 py-2 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none" />
            <datalist id="heading-opts">
              {#each headingOptions as h}<option value={h}></option>{/each}
            </datalist>
          </div>
        </div>
      {/if}

      <!-- Due date + time -->
      <div>
        <label for="td-due" class="block text-[11px] uppercase tracking-wider text-neutral-500 font-semibold mb-1.5">Due date</label>
        <div class="flex items-center gap-2">
          <input id="td-due" type="date" bind:value={due}
                 class="bg-neutral-950 border border-neutral-700 rounded-lg px-2.5 py-2 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none" />
          <input type="time" bind:value={dueTime} step="900" title="Time (for calendar block)"
                 class="bg-neutral-950 border border-neutral-700 rounded-lg px-2.5 py-2 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none" />
          {#if due}
            <button onclick={clearDue} class="text-xs text-neutral-500 hover:text-rose-400">clear</button>
          {/if}
        </div>
        <div class="flex gap-1.5 mt-2">
          {#each [['Today',0],['Tomorrow',1],['+3d',3],['Next week',7]] as [label, days]}
            <button onclick={() => setDuePreset(days)}
                    class="text-[11px] px-2 py-0.5 rounded-full bg-neutral-800 border border-neutral-700 text-neutral-300 hover:bg-indigo-500/20 hover:text-indigo-300">
              {label}
            </button>
          {/each}
        </div>
      </div>

      <!-- Tags + priority + estimate -->
      <div class="grid grid-cols-3 gap-3">
        <div class="col-span-1">
          <label for="td-pri" class="block text-[11px] uppercase tracking-wider text-neutral-500 font-semibold mb-1.5">Priority</label>
          <select id="td-pri" bind:value={priority}
                  class="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-2 py-2 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none">
            <option value={0}>None</option>
            <option value={1}>!!! High</option>
            <option value={2}>!! Med</option>
            <option value={3}>! Low</option>
          </select>
        </div>
        <div class="col-span-1">
          <label for="td-est" class="block text-[11px] uppercase tracking-wider text-neutral-500 font-semibold mb-1.5">Est. min</label>
          <input id="td-est" type="number" min="0" step="15" bind:value={estimate} placeholder="30"
                 class="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-2.5 py-2 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none" />
        </div>
        <div class="col-span-1">
          <label for="td-tags" class="block text-[11px] uppercase tracking-wider text-neutral-500 font-semibold mb-1.5">Tags</label>
          <input id="td-tags" bind:value={tagsInput} placeholder="work, urgent"
                 class="w-full bg-neutral-950 border border-neutral-700 rounded-lg px-2.5 py-2 text-sm text-neutral-100 focus:border-indigo-500 focus:outline-none" />
        </div>
      </div>

      <!-- Schedule after save -->
      {#if store.calendar?.available}
        <label class="flex items-center gap-2 text-xs text-neutral-400 cursor-pointer">
          <input type="checkbox" bind:checked={scheduleAfterSave} class="accent-indigo-500" />
          Schedule a calendar block after saving {#if due}<span class="text-neutral-500">({due} {dueTime || '09:00'})</span>{/if}
        </label>
      {/if}
    </div>

    <div class="flex items-center justify-between px-5 py-3.5 border-t border-neutral-800 bg-neutral-900/50">
      <span class="text-[11px] text-neutral-600">⌘↵ to save · Esc to cancel</span>
      <div class="flex gap-2">
        <button onclick={onclose}
                class="px-3.5 py-1.5 rounded-lg text-sm text-neutral-300 hover:bg-neutral-800">Cancel</button>
        <button onclick={save} disabled={saving}
                class="px-4 py-1.5 rounded-lg text-sm font-medium bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50">
          {saving ? 'Saving…' : mode === 'create' ? 'Create' : 'Save'}
        </button>
      </div>
    </div>
  </div>
</div>
