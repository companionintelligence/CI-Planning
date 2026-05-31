import { createSignal, Show, For } from 'solid-js';
import { tags, refetchTags, setTaskFilter } from '../stores/index.js';
import { api } from '../lib/api.js';
import { useNavigate } from '@solidjs/router';

export function Tags() {
  const navigate = useNavigate();
  const [newTag, setNewTag] = createSignal('');

  async function addTag(e: Event) {
    e.preventDefault();
    if (!newTag().trim()) return;
    await api.tags.create(newTag().trim());
    refetchTags();
    setNewTag('');
  }

  const maxCount = () => Math.max(...(tags() ?? []).map((t) => t.count), 1);
  const fontSize = (count: number) => {
    const ratio = count / maxCount();
    return 0.7 + ratio * 1.1; // 0.7rem – 1.8rem
  };

  function filterByTag(name: string) {
    setTaskFilter((f) => ({ ...f, tag: name }));
    navigate('/tasks');
  }

  return (
    <div class="flex-1 overflow-auto p-6 max-w-3xl mx-auto w-full">
      <h1 class="text-2xl font-semibold text-slate-100 mb-6">Tags</h1>

      {/* Add tag */}
      <form onSubmit={addTag} class="flex gap-2 mb-8">
        <input class="input flex-1" placeholder="New tag name…" value={newTag()}
          onInput={(e) => setNewTag(e.currentTarget.value)} />
        <button type="submit" class="btn-primary">Add</button>
      </form>

      {/* Tag cloud */}
      <Show when={(tags() ?? []).length > 0} fallback={
        <div class="card text-center text-slate-500 py-12">No tags yet.</div>
      }>
        <div class="flex flex-wrap gap-3 items-center leading-loose">
          <For each={tags()}>
            {(tag) => (
              <button
                onClick={() => filterByTag(tag.name)}
                class="text-accent-400 hover:text-accent-300 transition-colors"
                style={{ 'font-size': `${fontSize(tag.count)}rem` }}
                title={`${tag.count} task${tag.count !== 1 ? 's' : ''}`}
              >
                #{tag.name}
              </button>
            )}
          </For>
        </div>
        <div class="mt-8 flex flex-col gap-1">
          <For each={tags()}>
            {(tag) => (
              <div class="flex items-center gap-3 text-sm">
                <button
                  onClick={() => filterByTag(tag.name)}
                  class="text-accent-400 hover:underline font-mono w-40 text-left truncate"
                >
                  #{tag.name}
                </button>
                <div class="flex-1 bg-surface-800 rounded-full h-1.5">
                  <div
                    class="bg-accent-600 h-1.5 rounded-full"
                    style={{ width: `${(tag.count / maxCount()) * 100}%` }}
                  />
                </div>
                <span class="text-slate-500 text-xs w-8 text-right">{tag.count}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
