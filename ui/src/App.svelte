<script>
  import { onMount } from 'svelte';
  import { store } from './lib/store.svelte.js';
  import Topbar from './components/Topbar.svelte';
  import Today from './views/Today.svelte';
  import Todos from './views/Todos.svelte';
  import Files from './views/Files.svelte';
  import Search from './views/Search.svelte';
  import Toast from './components/Toast.svelte';

  onMount(() => {
    store.refresh();
    // Live reload via SSE
    if (window.EventSource) {
      const es = new EventSource('/api/events');
      const debounced = debounce(() => store.refresh(), 300);
      es.addEventListener('fileChange', debounced);
      es.addEventListener('fileAdd', debounced);
      es.addEventListener('fileRemove', debounced);
    }
    // Sync view ↔ hash
    const setFromHash = () => {
      const h = location.hash.slice(1);
      if (['today','todos','files','search'].includes(h)) store.view = h;
    };
    window.addEventListener('hashchange', setFromHash);
    setFromHash();
  });

  function debounce(fn, ms) {
    let t;
    return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
  }
</script>

<div class="h-full grid grid-rows-[auto_1fr] bg-neutral-950 text-neutral-100">
  <Topbar />

  <main class="overflow-y-auto p-6 max-w-5xl mx-auto w-full" style="padding-bottom: max(24px, env(safe-area-inset-bottom));">
    {#if store.view === 'today'}
      <Today />
    {:else if store.view === 'todos'}
      <Todos />
    {:else if store.view === 'files'}
      <Files />
    {:else if store.view === 'search'}
      <Search />
    {/if}
  </main>

  <Toast />
</div>
