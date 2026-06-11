import { createSignal, Show, For } from 'solid-js';
import { Hash, Plus } from 'lucide-solid';
import { tags, refetchTags, setTaskFilter } from '../stores/index.js';
import { api } from '../lib/api.js';
import { useNavigate } from '@solidjs/router';
import { showToast } from '../stores/index.js';

export function Tags() {
  const navigate = useNavigate();
  const [newTag, setNewTag] = createSignal('');

  async function addTag(e: Event) {
    e.preventDefault();
    if (!newTag().trim()) return;
    try {
      await api.tags.create(newTag().trim());
      refetchTags();
      setNewTag('');
      showToast('Tag created', 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  const maxCount = () => Math.max(...(tags() ?? []).map(t => t.count), 1);
  const fontSize = (count: number) => 0.75 + (count / maxCount()) * 1.0;

  function filterByTag(name: string) {
    setTaskFilter(f => ({ ...f, tag: name }));
    navigate('/tasks');
  }

  return (
    <div class="flex-1 overflow-auto p-6 page-enter max-w-3xl mx-auto w-full">
      <h1 class="text-2xl font-heading font-bold text-ci-1 tracking-wide mb-5">Tags</h1>

      <form onSubmit={addTag} class="flex gap-2 mb-8">
        <div class="relative flex-1">
          <Hash size={13} class="absolute left-3 top-1/2 -translate-y-1/2 text-ci-1/50 pointer-events-none" />
          <input
            class="input pl-8"
            placeholder="New tag…"
            value={newTag()}
            onInput={(e) => setNewTag(e.currentTarget.value)}
          />
        </div>
        <button type="submit" class="btn-primary"><Plus size={14} /> Add</button>
      </form>

      <Show when={(tags() ?? []).length > 0} fallback={
        <div class="card text-center text-ci-1/60 py-12 text-sm scroll-reveal">No tags yet.</div>
      }>
        {/* Word cloud */}
        <div class="flex flex-wrap gap-3 items-center leading-loose mb-8">
          <For each={tags()}>
            {(tag) => (
              <button
                onClick={() => filterByTag(tag.name)}
                class="text-accent-light hover:text-white transition-colors"
                style={{ 'font-size': `${fontSize(tag.count)}rem` }}
                title={`${tag.count} task${tag.count !== 1 ? 's' : ''}`}
              >
                #{tag.name}
              </button>
            )}
          </For>
        </div>

        {/* Bar list */}
        <div class="card">
          <div class="section-label mb-3">All tags</div>
          <div class="flex flex-col gap-2.5">
            <For each={tags()}>
              {(tag) => (
                <div class="flex items-center gap-3">
                  <button
                    onClick={() => filterByTag(tag.name)}
                    class="text-accent-light hover:underline font-mono text-sm w-40 text-left truncate"
                  >
                    #{tag.name}
                  </button>
                  <div class="flex-1 bg-surface-700 rounded-full h-1.5">
                    <div
                      class="bg-accent h-1.5 rounded-full transition-all duration-300"
                      style={{ width: `${(tag.count / maxCount()) * 100}%` }}
                    />
                  </div>
                  <span class="text-ci-1/50 text-xs font-mono w-6 text-right">{tag.count}</span>
                </div>
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}
