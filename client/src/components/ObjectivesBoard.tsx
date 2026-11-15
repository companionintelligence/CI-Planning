import { createEffect, createResource, createSignal, For, onCleanup, Show } from 'solid-js';
import { on } from '../lib/sse.js';
import { api, type Objective, type ObjectiveBoardCard, type ObjectiveBoardColumn } from '../lib/api.js';
import { elementModal, openCloseRitual, refetchTasks, setElementModal, showToast, taskOf } from '../stores/index.js';
import { Plus, Search, Trash2, X } from 'lucide-solid';

type FlatObjective = { id: string; title: string; level: Objective['level']; depth: number; ancestors: string[] };

function flattenObjectives(tree: Objective[], depth = 0, ancestors: string[] = []): FlatObjective[] {
  return tree.flatMap((obj) => [
    { id: obj.id, title: obj.title, level: obj.level, depth, ancestors },
    ...flattenObjectives(obj.children ?? [], depth + 1, [...ancestors, obj.id]),
  ]);
}

function durationLabel(minutes: number | null): string | null {
  if (minutes == null || minutes <= 0) return null;
  return minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10}h` : `${minutes}m`;
}

export function ObjectivesBoard(props: {
  objectives: Objective[];
  objectivesLoading: boolean;
  onNewObjective: () => void;
}) {
  const [board, { refetch }] = createResource(() => api.objectives.board.list());
  const [objectiveId, setObjectiveId] = createSignal('');
  const [mobileColumnId, setMobileColumnId] = createSignal('');
  const [search, setSearch] = createSignal('');
  const [addingColumn, setAddingColumn] = createSignal(false);
  const [columnName, setColumnName] = createSignal('');
  const [addingTask, setAddingTask] = createSignal(false);
  const [taskTitle, setTaskTitle] = createSignal('');
  const [taskObjectiveId, setTaskObjectiveId] = createSignal('');
  const [busy, setBusy] = createSignal(false);
  const [draggedId, setDraggedId] = createSignal<string | null>(null);
  const [dropColumnId, setDropColumnId] = createSignal<string | null>(null);

  const flatObjectives = () => flattenObjectives(props.objectives);
  const objectiveNames = () => new Map(flatObjectives().map((o) => [o.id, o.title]));
  const columns = () => board()?.columns ?? [];
  const cards = () => board()?.cards ?? [];
  const visibleCards = () => {
    const terms = normalizeSearch(search()).split(/\s+/).filter(Boolean);
    return cards().filter((card) => {
      const objectiveMatches = !objectiveId() || card.objective_ids.some((id) =>
        id === objectiveId() || flatObjectives().some((o) => o.id === id && o.ancestors.includes(objectiveId())),
      );
      // Search task content only. Objective names are already handled by the separate
      // objective filter; matching the objective label made unrelated task titles show up.
      const content = normalizeSearch([card.title, card.search_text ?? ''].join(' '));
      const searchMatches = terms.length === 0 || terms.every((term) => content.includes(term));
      return objectiveMatches && searchMatches;
    });
  };
  const cardsIn = (columnId: string) => visibleCards()
    .filter((card) => card.column_id === columnId)
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));

  createEffect(() => {
    const ids = columns().map((column) => column.id);
    if (!ids.includes(mobileColumnId())) setMobileColumnId(ids[0] ?? '');
    if (objectiveId() && !flatObjectives().some((obj) => obj.id === objectiveId())) setObjectiveId('');
    if (taskObjectiveId() && !flatObjectives().some((obj) => obj.id === taskObjectiveId())) setTaskObjectiveId('');
  });

  // Refresh the board after task edits and from another open client.
  createEffect<boolean>((wasOpen) => {
    const open = elementModal().open;
    if (wasOpen && !open) void refetch();
    return open;
  }, elementModal().open);
  const stopBoardEvents = on('objective_board:updated', () => { void refetch(); });
  const stopTaskEvents = on('objective_task:updated', () => { void refetch(); });
  const stopTaskUpdates = on('task:updated', () => { void refetch(); });
  const stopTaskCreates = on('task:created', () => { void refetch(); });
  onCleanup(() => { stopBoardEvents(); stopTaskEvents(); stopTaskUpdates(); stopTaskCreates(); });

  function openTask(card: ObjectiveBoardCard) {
    setElementModal({ open: true, mode: 'edit', kind: 'task', editTarget: { kind: 'task', id: card.id } });
  }

  async function moveCard(cardId: string, column: ObjectiveBoardColumn, beforeTaskId?: string) {
    if (busy()) return;
    const card = cards().find((item) => item.id === cardId);
    if (!card) return;
    setBusy(true);
    try {
      const wasDone = card.status === 'done';
      const shouldBeDone = column.system_key === 'done';
      if (shouldBeDone && !wasDone) {
        await api.tasks.update(card.id, { completed: true });
        openCloseRitual(taskOf(card.id));
      } else if (!shouldBeDone && wasDone) {
        await api.tasks.update(card.id, { status: 'open', completed_at: null });
      }
      await api.objectives.board.moveTask(card.id, column.id, beforeTaskId);
      await Promise.all([refetch(), refetchTasks()]);
    } catch (err) {
      showToast((err as Error).message, 'error');
      void refetch();
      refetchTasks();
    } finally {
      setBusy(false);
      setDraggedId(null);
      setDropColumnId(null);
    }
  }

  async function addBoardColumn() {
    if (busy()) return;
    setBusy(true);
    try {
      const { column } = await api.objectives.board.addColumn(columnName());
      setColumnName('');
      setAddingColumn(false);
      await refetch();
      setMobileColumnId(column.id);
      showToast('Column added', 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }

  async function deleteBoardColumn(column: ObjectiveBoardColumn) {
    if (column.system_key || busy()) return;
    if (!confirm(`Remove “${column.name}”? Its tasks will move to Open.`)) return;
    setBusy(true);
    try {
      await api.objectives.board.removeColumn(column.id);
      await refetch();
      showToast('Column removed', 'default');
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }

  async function createObjectiveTask() {
    const title = taskTitle().trim();
    const objective = taskObjectiveId();
    if (!title || !objective || busy()) return;
    setBusy(true);
    try {
      const { task } = await api.objectives.createTask(objective, title);
      setTaskTitle('');
      setAddingTask(false);
      await Promise.all([refetch(), refetchTasks()]);
      // A quick-added board card is still a full task. Open its normal details modal
      // immediately so the user can fill in dates, priority, tags, and notes.
      setElementModal({ open: true, mode: 'edit', kind: 'task', editTarget: { kind: 'task', id: task.id } });
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setBusy(false); }
  }

  function startDrag(card: ObjectiveBoardCard, ev: DragEvent) {
    if (!ev.dataTransfer) return;
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('application/x-ci-objective-board-card', card.id);
    setDraggedId(card.id);
  }

  function allowDrop(ev: DragEvent, columnId: string) {
    if (!draggedId()) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move';
    setDropColumnId(columnId);
  }

  function leaveDropTarget(columnId: string, ev: DragEvent) {
    if (!ev.currentTarget.contains(ev.relatedTarget as Node | null) && dropColumnId() === columnId) {
      setDropColumnId(null);
    }
  }

  function dropOnColumn(column: ObjectiveBoardColumn, ev: DragEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    const cardId = draggedId() ?? ev.dataTransfer?.getData('application/x-ci-objective-board-card');
    if (cardId) void moveCard(cardId, column);
    else setDropColumnId(null);
  }

  function dropBefore(card: ObjectiveBoardCard, ev: DragEvent) {
    ev.preventDefault();
    ev.stopPropagation();
    const cardId = draggedId() ?? ev.dataTransfer?.getData('application/x-ci-objective-board-card');
    const column = columns().find((item) => item.id === card.column_id);
    if (cardId && column) void moveCard(cardId, column, card.id);
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <label class="sr-only" for="objective-board-filter">Choose objectives</label>
        <select
          id="objective-board-filter"
          class="input w-auto min-w-44 max-w-full"
          value={objectiveId()}
          onChange={(ev) => setObjectiveId(ev.currentTarget.value)}
        >
          <option value="">All objectives</option>
          <For each={flatObjectives()}>
            {(obj) => <option value={obj.id}>{'　'.repeat(Math.min(obj.depth, 4))}{obj.title}</option>}
          </For>
        </select>
        <div class="relative min-w-40 flex-1 max-w-sm">
          <Search size={13} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            class="input w-full pl-8 pr-8"
            type="text"
            role="searchbox"
            aria-label="Search board tasks"
            autocomplete="off"
            placeholder="Search tasks…"
            value={search()}
            onInput={(ev) => setSearch(ev.currentTarget.value)}
          />
          <Show when={search()}>
            <button type="button" class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground" onClick={() => setSearch('')} title="Clear search" aria-label="Clear search"><X size={13} /></button>
          </Show>
        </div>
        <div class="flex items-center gap-2 sm:ml-auto">
          <button class="btn-secondary text-xs px-3 py-1.5" onClick={() => { setTaskObjectiveId(objectiveId()); setAddingTask((v) => !v); setAddingColumn(false); }}>
            <Plus size={13} /> New task
          </button>
          <button class="btn-secondary text-xs px-3 py-1.5" onClick={() => { setAddingColumn((v) => !v); setAddingTask(false); }}>
            <Plus size={13} /> Add column
          </button>
        </div>
      </div>

      <Show when={addingTask()}>
        <form class="rounded-xl border border-border bg-card/60 p-3 flex flex-col sm:flex-row gap-2" onSubmit={(ev) => { ev.preventDefault(); void createObjectiveTask(); }}>
          <label class="sr-only" for="board-task-objective">Objective</label>
          <select id="board-task-objective" class="input sm:w-56" value={taskObjectiveId()} onChange={(ev) => setTaskObjectiveId(ev.currentTarget.value)} required>
            <option value="">Choose an objective</option>
            <For each={flatObjectives()}>{(obj) => <option value={obj.id}>{'　'.repeat(Math.min(obj.depth, 4))}{obj.title}</option>}</For>
          </select>
          <label class="sr-only" for="board-task-title">Task name</label>
          <input id="board-task-title" class="input flex-1" placeholder="What needs to be done?" value={taskTitle()} onInput={(ev) => setTaskTitle(ev.currentTarget.value)} maxLength={240} required />
          <button class="btn-primary text-xs px-3 py-1.5" type="submit" disabled={busy() || !taskTitle().trim() || !taskObjectiveId()}>
            <Plus size={13} /> Add task
          </button>
          <button class="btn-ghost text-xs px-2" type="button" onClick={() => { setAddingTask(false); setTaskTitle(''); }} title="Cancel"><X size={14} /></button>
        </form>
      </Show>

      <Show when={addingColumn()}>
        <form class="rounded-xl border border-border bg-card/60 p-3 flex flex-col sm:flex-row gap-2" onSubmit={(ev) => { ev.preventDefault(); void addBoardColumn(); }}>
          <label class="sr-only" for="board-column-title">Column name</label>
          <input id="board-column-title" class="input flex-1" placeholder="Column name" value={columnName()} onInput={(ev) => setColumnName(ev.currentTarget.value)} maxLength={32} required />
          <button class="btn-primary text-xs px-3 py-1.5" type="submit" disabled={busy() || !columnName().trim()}><Plus size={13} /> Add column</button>
          <button class="btn-ghost text-xs px-2" type="button" onClick={() => { setAddingColumn(false); setColumnName(''); }} title="Cancel"><X size={14} /></button>
        </form>
      </Show>

      <Show when={columns().length > 0} fallback={
        <div class="card text-center text-sm text-muted-foreground py-8">
          <Show when={board.error} fallback="Loading the objective board…">
            <span>The objective board could not load.</span>
            <button class="btn-secondary ml-2 text-xs" onClick={() => void refetch()}>Try again</button>
          </Show>
        </div>
      }>
        <div class="flex gap-1 overflow-x-auto pb-1 md:hidden" role="tablist" aria-label="Board columns">
          <For each={columns()}>
            {(column) => (
              <button
                role="tab"
                aria-selected={mobileColumnId() === column.id}
                class="view-tab whitespace-nowrap"
                classList={{
                  'text-primary border-primary': mobileColumnId() === column.id,
                  'border-primary bg-primary/10': dropColumnId() === column.id,
                }}
                onClick={() => setMobileColumnId(column.id)}
                onDragOver={(ev) => allowDrop(ev, column.id)}
                onDrop={(ev) => dropOnColumn(column, ev)}
                onDragLeave={(ev) => leaveDropTarget(column.id, ev)}
                title={`Drop a task here to move it to ${column.name}`}
              >
                {column.name} <span class="text-[10px] text-muted-foreground">{cardsIn(column.id).length}</span>
              </button>
            )}
          </For>
        </div>

        <div class="overflow-x-auto pb-2">
          <div
            class="grid gap-3 objective-kanban-grid"
            style={{ 'grid-template-columns': `repeat(${columns().length}, minmax(15rem, 1fr))` }}
          >
            <For each={columns()}>
              {(column) => (
                <section
                  class="objective-kanban-column flex flex-col rounded-xl border border-border bg-card/40 min-h-64"
                  classList={{
                    'objective-kanban-column-active border-primary/70 bg-primary/5': mobileColumnId() === column.id,
                    'border-primary/70 bg-primary/5': dropColumnId() === column.id,
                  }}
                  onDragOver={(ev) => allowDrop(ev, column.id)}
                  onDrop={(ev) => dropOnColumn(column, ev)}
                  onDragLeave={(ev) => leaveDropTarget(column.id, ev)}
                >
                  <header class="flex items-center gap-2 border-b border-border/70 px-3 py-2.5">
                    <h3 class="font-semibold text-sm flex-1 min-w-0 truncate">{column.name}</h3>
                    <span class="text-[10px] rounded-full bg-background px-1.5 py-0.5 text-muted-foreground">{cardsIn(column.id).length}</span>
                    <Show when={!column.system_key}>
                      <button class="btn-icon h-6 w-6 text-muted-foreground hover:text-destructive" title={`Remove ${column.name} column`} onClick={() => void deleteBoardColumn(column)}>
                        <Trash2 size={12} />
                      </button>
                    </Show>
                  </header>
                  <div class="flex flex-col gap-2 p-2 flex-1 min-h-28">
                    <For each={cardsIn(column.id)}>
                      {(card) => (
                        <article
                          draggable={!busy()}
                          onDragStart={(ev) => startDrag(card, ev)}
                          onDragEnd={() => { setDraggedId(null); setDropColumnId(null); }}
                          onDragOver={(ev) => allowDrop(ev, column.id)}
                          onDrop={(ev) => dropBefore(card, ev)}
                          class="group rounded-lg border border-border bg-background/70 p-2.5 cursor-grab active:cursor-grabbing transition-colors"
                          classList={{
                            'opacity-40': draggedId() === card.id,
                            'border-dotted bg-warning/5': !!card.auto_generated && !card.human_approved_at,
                          }}
                          style={!!card.auto_generated && !card.human_approved_at ? { 'border-color': 'var(--auto-generated-outline)' } : undefined}
                          title="Drag to move between columns; select the title for task details"
                        >
                          <div class="flex items-start gap-2">
                            <span class="mt-1 text-muted-foreground/60 select-none" aria-hidden="true">⠿</span>
                            <div class="min-w-0 flex-1">
                              <button class="block w-full text-left text-sm font-medium text-foreground hover:text-primary leading-snug" onClick={() => openTask(card)}>
                                {card.title}
                              </button>
                              <div class="flex flex-wrap items-center gap-1.5 mt-2">
                                <For each={card.objective_ids.slice(0, 2)}>
                                  {(id) => <span class="rounded-md bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary truncate max-w-32">{objectiveNames().get(id) ?? 'Objective'}</span>}
                                </For>
                                <Show when={card.objective_ids.length > 2}><span class="text-[10px] text-muted-foreground">+{card.objective_ids.length - 2}</span></Show>
                              </div>
                              <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-2 text-[10px] text-muted-foreground">
                                <Show when={card.priority != null}><span classList={{ 'text-destructive': card.priority === 1 }}>P{card.priority}</span></Show>
                                <Show when={durationLabel(card.estimated_minutes)}><span>{durationLabel(card.estimated_minutes)}</span></Show>
                                <Show when={card.due_at}><span>Due {card.due_at!.slice(0, 10)}</span></Show>
                              </div>
                            </div>
                          </div>
                          <label class="sr-only" for={`move-${card.id}`}>Move {card.title}</label>
                          <select
                            id={`move-${card.id}`}
                            class="input mt-2 w-full py-1 text-[11px] md:hidden"
                            value={card.column_id}
                            onChange={(ev) => {
                              const target = columns().find((item) => item.id === ev.currentTarget.value);
                              if (target) void moveCard(card.id, target);
                            }}
                          >
                            <For each={columns()}>{(item) => <option value={item.id}>{item.name}</option>}</For>
                          </select>
                        </article>
                      )}
                    </For>
                    <Show when={cardsIn(column.id).length === 0}>
                      <div class="flex-1 rounded-lg border border-dashed border-border/70 px-3 py-6 text-center text-xs text-muted-foreground">
                        Drop a task here
                      </div>
                    </Show>
                  </div>
                </section>
              )}
            </For>
          </div>
        </div>
      </Show>

      <Show when={!board.loading && !props.objectivesLoading && props.objectives.length === 0}>
        <div class="rounded-xl border border-dashed border-border bg-card/40 p-6 text-center">
          <p class="text-sm text-muted-foreground mb-3">Create an objective before adding tasks.</p>
          <button class="btn-primary text-xs px-3 py-1.5" onClick={props.onNewObjective}><Plus size={13} /> New objective</button>
        </div>
      </Show>
    </div>
  );
}

function normalizeSearch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase();
}
