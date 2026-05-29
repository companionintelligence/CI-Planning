<script>
  import { onMount } from 'svelte';
  import { store } from './lib/store.svelte.js';
  import Topbar from './components/Topbar.svelte';
  import Today from './views/Today.svelte';
  import Todos from './views/Todos.svelte';
  import Files from './views/Files.svelte';
  import Search from './views/Search.svelte';
  import Settings from './views/Settings.svelte';
  import Capacity from './views/Capacity.svelte';
  import Review from './views/Review.svelte';
  import Toast from './components/Toast.svelte';
  import BriefingModal from './components/BriefingModal.svelte';
  import TriageModal from './components/TriageModal.svelte';
  import CommandPalette from './components/CommandPalette.svelte';
  import TodoEditor from './components/TodoEditor.svelte';

  let showBriefing = $state(false);
  let showPalette = $state(false);
  let triageFile = $state(null);

  onMount(() => {
    store.refresh();
    store.loadLookahead(3, 480);
    store.loadCalendarStatus();

    // Live reload via SSE
    if (window.EventSource) {
      const es = new EventSource('/api/events');
      const debounced = debounce(() => store.refresh(), 300);
      es.addEventListener('fileChange', debounced);
      es.addEventListener('fileAdd', debounced);
      es.addEventListener('fileRemove', debounced);
    }

    // Hash navigation
    const setFromHash = () => {
      const h = location.hash.slice(1);
      if (['today', 'todos', 'files', 'search', 'settings', 'capacity', 'review'].includes(h)) store.view = h;
    };
    window.addEventListener('hashchange', setFromHash);
    setFromHash();

    // Global keyboard shortcuts
    window.addEventListener('keydown', (e) => {
      const typing = ['INPUT','TEXTAREA','SELECT'].includes(e.target?.tagName);
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        showPalette = !showPalette;
      }
      // "n" opens a new-todo editor (when not typing and no modal open)
      if (e.key === 'n' && !typing && !store.editor.open && !showPalette && !showBriefing) {
        e.preventDefault();
        store.openEditor('create');
      }
      if (e.key === 'Escape') {
        showPalette = false;
        showBriefing = false;
        triageFile = null;
      }
    });
  });

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
</script>

<div class="h-full grid grid-rows-[auto_1fr] bg-neutral-950 text-neutral-100">
  <Topbar
    onBriefing={() => showBriefing = true}
    onPalette={() => showPalette = !showPalette}
  />

  <main class="overflow-y-auto p-6 max-w-5xl mx-auto w-full"
        style="padding-bottom: max(24px, env(safe-area-inset-bottom));">
    {#if store.view === 'today'}
      <Today />
    {:else if store.view === 'todos'}
      <Todos />
    {:else if store.view === 'files'}
      <Files onTriage={(path) => { triageFile = path; }} />
    {:else if store.view === 'search'}
      <Search />
    {:else if store.view === 'capacity'}
      <Capacity />
    {:else if store.view === 'review'}
      <Review />
    {:else if store.view === 'settings'}
      <Settings />
    {/if}
  </main>

  <Toast />

  <!-- Floating new-todo button -->
  <button onclick={() => store.openEditor('create')}
          class="fixed bottom-6 right-6 z-30 w-14 h-14 rounded-full bg-indigo-600 hover:bg-indigo-500 text-white text-2xl shadow-lg shadow-indigo-900/40 flex items-center justify-center transition-transform hover:scale-105"
          style="bottom: max(24px, env(safe-area-inset-bottom));"
          title="New todo (n)" aria-label="New todo">+</button>
</div>

{#if store.editor.open}
  <TodoEditor mode={store.editor.mode} todo={store.editor.todo} onclose={() => store.closeEditor()} />
{/if}

{#if showBriefing}
  <BriefingModal onclose={() => showBriefing = false} />
{/if}

{#if triageFile !== null}
  <TriageModal file={triageFile} onclose={() => triageFile = null} />
{/if}

{#if showPalette}
  <CommandPalette onclose={() => showPalette = false} />
{/if}
