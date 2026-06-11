import { createSignal, createMemo, For, Show, onMount, onCleanup } from 'solid-js';
import { Search, Plus, Calendar, Tag, Clock } from 'lucide-solid';
import { tasks, refetchTasks, showToast, setTaskModal } from '../stores/index.js';
import { api } from '../lib/api.js';

interface Props {
  onClose: () => void;
}

export function CommandBar(props: Props) {
  const [input, setInput] = createSignal('');
  const [activeIndex, setActiveIndex] = createSignal(0);
  let inputRef!: HTMLInputElement;

  onMount(() => {
    inputRef?.focus();
    // Prevent backdrop scrolls
    document.body.style.overflow = 'hidden';
  });

  onCleanup(() => {
    document.body.style.overflow = '';
  });

  // Short hand parser
  const parsedTask = createMemo(() => {
    const text = input().trim();
    if (!text) return null;

    const priorityRegex = /\bp([1-5])\b/i;
    const estRegex = /\best:(\d+)\b/i;
    const tagRegex = /#([\w-]+)/g;

    let priority = 3;
    let estimatedMinutes: number | undefined = undefined;
    const tagsList: string[] = [];

    const pMatch = text.match(priorityRegex);
    if (pMatch) priority = Number(pMatch[1]);

    const estMatch = text.match(estRegex);
    if (estMatch) estimatedMinutes = Number(estMatch[1]);

    let tagMatch;
    while ((tagMatch = tagRegex.exec(text)) !== null) {
      tagsList.push(tagMatch[1].toLowerCase());
    }

    const title = text
      .replace(priorityRegex, '')
      .replace(estRegex, '')
      .replace(tagRegex, '')
      .replace(/\s+/g, ' ')
      .trim();

    return {
      title: title || 'Untitled Task',
      priority,
      estimated_minutes: estimatedMinutes,
      tags: tagsList,
    };
  });

  // Search Results
  const results = createMemo(() => {
    const q = input().toLowerCase().trim();
    const all = tasks() ?? [];
    if (!q) return all.slice(0, 8); // show recent 8 tasks if empty

    // Filter tasks by query matching title or tag
    return all.filter((t) =>
      t.title.toLowerCase().includes(q) ||
      t.tags.some(tag => tag.toLowerCase().includes(q))
    ).slice(0, 8);
  });

  async function handleCreateQuickTask() {
    const p = parsedTask();
    if (!p) return;
    try {
      await api.tasks.create(p);
      showToast(`Created task: "${p.title}"`, 'success');
      refetchTasks();
      props.onClose();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  async function selectItem(index: number) {
    const items = results();
    const hasQuick = !!parsedTask();

    if (hasQuick && index === 0) {
      await handleCreateQuickTask();
      return;
    }

    const taskItem = items[hasQuick ? index - 1 : index];
    if (taskItem) {
      // Edit task or open modal
      setTaskModal({ open: true, editTask: taskItem });
      props.onClose();
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const itemsCount = results().length + (parsedTask() ? 1 : 0);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1) % Math.max(itemsCount, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev - 1 + itemsCount) % Math.max(itemsCount, 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectItem(activeIndex());
    } else if (e.key === 'Escape') {
      e.preventDefault();
      props.onClose();
    }
  }

  return (
    <div
      class="fixed inset-0 bg-surface-950/70 backdrop-blur-sm z-50 flex justify-center pt-24"
      onClick={(e) => e.target === e.currentTarget && props.onClose()}
    >
      <div class="w-full max-w-xl bg-surface-900 border border-surface-700/60 rounded-2xl shadow-2xl h-fit overflow-hidden animate-zoom-in">
        {/* Input area */}
        <div class="flex items-center gap-3 px-4 py-3 border-b border-surface-700/40">
          <Search class="text-ci-1/40 flex-shrink-0" size={18} />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search tasks, or type to create: 'Buy milk #groceries p2 est:15'"
            class="flex-1 bg-transparent border-0 outline-none text-ci-1 text-sm font-medium placeholder-ci-1/30 w-full"
            value={input()}
            onInput={(e) => { setInput(e.currentTarget.value); setActiveIndex(0); }}
            onKeyDown={handleKeyDown}
          />
          <span class="text-[10px] font-mono bg-surface-800 border border-surface-700/40 text-ci-1/50 px-1.5 py-0.5 rounded shadow-sm select-none">ESC</span>
        </div>

        {/* List items */}
        <div class="max-h-80 overflow-y-auto p-2 flex flex-col gap-0.5">
          {/* Quick Create option at the top if input exists */}
          <Show when={parsedTask()}>
            {(p) => {
              const isSelected = activeIndex() === 0;
              return (
                <div
                  onClick={() => selectItem(0)}
                  class={`flex items-center justify-between px-3 py-2.5 rounded-xl cursor-pointer transition-all duration-100 border
                    ${isSelected 
                      ? 'bg-accent/15 border-accent text-accent-light' 
                      : 'bg-transparent border-transparent hover:bg-surface-800/40 text-ci-1'}`}
                >
                  <div class="flex items-center gap-2.5 min-w-0">
                    <Plus size={14} class={isSelected ? 'text-accent' : 'text-ci-1/50'} />
                    <span class="text-xs font-semibold truncate">Create: "{p().title}"</span>
                  </div>

                  <div class="flex items-center gap-1.5 flex-shrink-0">
                    <span class="badge-accent py-0.5 text-[9px]">P{p().priority}</span>
                    <Show when={p().estimated_minutes}>
                      <span class="badge-neutral py-0.5 text-[9px] font-mono flex items-center gap-1">
                        <Clock size={8} /> {p().estimated_minutes}m
                      </span>
                    </Show>
                    <For each={p().tags}>
                      {(t) => <span class="badge-neutral py-0.5 text-[9px]">#{t}</span>}
                    </For>
                    <span class="text-[10px] font-mono opacity-40 ml-2">↵ Enter</span>
                  </div>
                </div>
              );
            }}
          </Show>

          {/* Search/Recent Tasks */}
          <For each={results()}>
            {(t, i) => {
              const adjustedIndex = () => parsedTask() ? i() + 1 : i();
              const isSelected = adjustedIndex() === activeIndex();
              const priorityDot = ['', 'p1', 'p2', 'p3', 'p4', 'p5'] as const;

              return (
                <div
                  onClick={() => selectItem(adjustedIndex())}
                  class={`flex items-center justify-between px-3 py-2 rounded-xl cursor-pointer transition-all duration-100 border
                    ${isSelected 
                      ? 'bg-accent/10 border-accent/35 text-ci-1' 
                      : 'bg-transparent border-transparent hover:bg-surface-800/20 text-ci-1/80'}`}
                >
                  <div class="flex items-center gap-2.5 min-w-0">
                    <span class={`priority-dot ${priorityDot[Math.min(Math.max(t.priority, 1), 5)]}`} />
                    <span class={`text-xs truncate ${t.status === 'done' ? 'line-through opacity-45' : ''}`}>
                      {t.title}
                    </span>
                  </div>

                  <div class="flex items-center gap-1.5 flex-shrink-0 select-none">
                    <Show when={t.status !== 'open'}>
                      <span class="badge-blue text-[9px] capitalize py-0.5">{t.status}</span>
                    </Show>
                    <Show when={t.estimated_minutes}>
                      <span class="text-[10px] font-mono opacity-50">{t.estimated_minutes}m</span>
                    </Show>
                    <For each={t.tags}>
                      {(tag) => <span class="text-[9px] font-mono opacity-40">#{tag}</span>}
                    </For>
                    <span class="text-[9px] font-mono opacity-30 ml-2">↵ Edit</span>
                  </div>
                </div>
              );
            }}
          </For>

          <Show when={results().length === 0 && !parsedTask()}>
            <div class="text-center py-6 text-xs text-ci-1/40 font-mono select-none">
              No matching tasks found.
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
}
