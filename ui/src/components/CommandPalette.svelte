<script>
  import { store } from '../lib/store.svelte.js';

  let { onclose } = $props();
  let q = $state('');
  let idx = $state(0);

  function focusInput(node) { Promise.resolve().then(() => node.focus()); return {}; }

  // Suggestions: static commands + live file/todo matches
  const commands = $derived.by(() => {
    const t = q.trim().toLowerCase();
    const cmds = [
      { label: 'Go to Today',   action: () => goto('today') },
      { label: 'Go to Todos',   action: () => goto('todos') },
      { label: 'Go to Files',   action: () => goto('files') },
      { label: 'Go to Search',  action: () => goto('search') },
      { label: 'Refresh data',  action: () => { store.refresh(); onclose(); } },
    ].filter(c => !t || c.label.toLowerCase().includes(t));

    const files = !t ? [] : store.files
      .filter(f => f.relativePath.toLowerCase().includes(t) || f.name.toLowerCase().includes(t))
      .slice(0, 8)
      .map(f => ({ label: f.name, sub: f.relativePath, action: () => openFile(f) }));

    const todos = !t ? [] : store.todos
      .filter(td => !td.checked && td.plain_text.toLowerCase().includes(t))
      .slice(0, 5)
      .map(td => ({ label: td.plain_text, sub: td.file_path.split('/').slice(-1)[0], action: () => { onclose(); } }));

    return [...cmds, ...files, ...todos];
  });

  $effect(() => { idx = 0; });

  function goto(view) { store.view = view; history.replaceState(null, '', '#' + view); onclose(); }
  function openFile(f) { store.openFile(f.path); store.view = 'files'; history.replaceState(null, '', '#files'); onclose(); }

  function onkeydown(e) {
    if (e.key === 'ArrowDown') { idx = Math.min(idx + 1, commands.length - 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { idx = Math.max(idx - 1, 0); e.preventDefault(); }
    else if (e.key === 'Enter' && commands[idx]) { commands[idx].action(); }
    else if (e.key === 'Escape') onclose();
  }
</script>

<!-- backdrop -->
<div class="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-start justify-center pt-[10vh]"
     onclick={onclose} role="presentation">
  <div class="w-full max-w-lg mx-4 bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl overflow-hidden"
       onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Command palette">
    <input bind:value={q} onkeydown={onkeydown}
           use:focusInput
           placeholder="Type a command, file, or todo…"
           class="w-full bg-transparent px-5 py-4 text-base focus:outline-none border-b border-neutral-800" />
    <ul class="max-h-80 overflow-y-auto py-1" role="listbox">
      {#each commands as c, i}
        <li role="option" aria-selected={i === idx}
            class="flex flex-col px-4 py-2.5 cursor-pointer text-[13.5px]
                   { i === idx ? 'bg-blue-600/30 text-blue-200' : 'text-neutral-300 hover:bg-white/[0.04]' }"
            onclick={c.action} onmouseenter={() => idx = i}>
          <span>{c.label}</span>
          {#if c.sub}<span class="text-[11px] text-neutral-500 mt-0.5">{c.sub}</span>{/if}
        </li>
      {/each}
      {#if commands.length === 0}
        <li class="px-4 py-3 text-neutral-500 text-sm">No results.</li>
      {/if}
    </ul>
    <footer class="flex gap-4 px-4 py-2 border-t border-neutral-800 text-[11px] text-neutral-600">
      <span><kbd class="bg-neutral-800 px-1 rounded">↑↓</kbd> navigate</span>
      <span><kbd class="bg-neutral-800 px-1 rounded">↵</kbd> select</span>
      <span><kbd class="bg-neutral-800 px-1 rounded">esc</kbd> close</span>
    </footer>
  </div>
</div>

