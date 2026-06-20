import { createSignal, createMemo, createResource, For, Show, onCleanup } from 'solid-js';
import { Plus, Trash2, X, ChevronDown, ChevronRight, Repeat, Pencil } from 'lucide-solid';
import { patterns, patternTypes, refetchPatterns, showToast, setTaskModal } from '../stores/index.js';
import { api, type Pattern, type PatternType, type Task } from '../lib/api.js';
import { on } from '../lib/sse.js';
import { ShapeIcon } from '../components/ShapeIcon.js';
import { colorVar } from '../lib/pattern-meta.js';

/**
 * The Patterns view (Settings expansion, Step 1). Browse and manage the three
 * pattern categories: **Habits** (recurring single-action *tasks*), **Routines**
 * (collections of habit tasks), and **Rituals** (habits + tasks for a specific
 * occasion). Habit is a task-level designation — not a collection — so its section
 * lists `is_habit` tasks; Routines/Rituals list `patterns` of that type.
 */
export function Patterns() {
  // Own unfiltered task fetch so the view is correct regardless of the global
  // task filter; refreshed on task SSE + after our own mutations.
  const [allTasks, { refetch: refetchAll }] = createResource(() => api.tasks.list({}).then((r) => r.tasks));
  const offCreated = on('task:created', () => refetchAll());
  const offUpdated = on('task:updated', () => refetchAll());
  onCleanup(() => { offCreated(); offUpdated(); });

  const typeByName = createMemo(() => {
    const m = new Map<string, PatternType>();
    for (const t of patternTypes() ?? []) m.set(t.name, t);
    return m;
  });
  const taskById = createMemo(() => {
    const m = new Map<number, Task>();
    for (const t of allTasks() ?? []) m.set(t.id, t);
    return m;
  });

  const habitTasks = () => (allTasks() ?? []).filter((t) => t.is_habit && !t.recurrence_parent_id);
  const patternsOfType = (name: string) => {
    const ty = typeByName().get(name);
    return ty ? (patterns() ?? []).filter((p) => p.type_id === ty.id) : [];
  };

  // ── Pattern create + membership ops (closure over refetch) ────────────────────
  async function createPattern(typeName: string, name: string, tag: string) {
    const ty = typeByName().get(typeName);
    try {
      await api.patterns.create({ type_id: ty?.id ?? null, name: name.trim(), tag: tag.trim().replace(/^#/, '') || null });
      refetchPatterns();
      showToast(`${typeName} "${name.trim()}" created`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function deletePattern(p: Pattern) {
    try { await api.patterns.delete(p.id); refetchPatterns(); showToast(`Deleted "${p.name}"`, 'default'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function addMember(p: Pattern, taskId: number) {
    try { await api.patterns.addTask(p.id, taskId); refetchPatterns(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function removeMember(p: Pattern, taskId: number) {
    try { await api.patterns.removeTask(p.id, taskId); refetchPatterns(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  // ── Inline pattern card (members + add/remove + delete) ───────────────────────
  function PatternCard(props: { pattern: Pattern; shape: string; color: string }) {
    const [open, setOpen] = createSignal(false);
    const [picking, setPicking] = createSignal(false);
    const members = () => props.pattern.task_ids.map((id) => taskById().get(id)).filter(Boolean) as Task[];
    const candidates = () => {
      const have = new Set(props.pattern.task_ids);
      return (allTasks() ?? []).filter((t) => t.status === 'open' && !t.parent_id && !have.has(t.id)).slice(0, 30);
    };
    return (
      <div class="rounded-lg border border-border bg-card">
        <div class="flex items-center gap-2 px-3 py-2">
          <button onClick={() => setOpen((v) => !v)} class="text-muted-foreground hover:text-foreground">
            <Show when={open()} fallback={<ChevronRight size={14} />}><ChevronDown size={14} /></Show>
          </button>
          <span class="flex-1 text-sm font-medium text-foreground truncate">{props.pattern.name}</span>
          <Show when={props.pattern.tag}>{(t) => <span class="text-primary text-xs">#{t()}</span>}</Show>
          <span class="text-[11px] text-muted-foreground">{props.pattern.task_ids.length} task{props.pattern.task_ids.length === 1 ? '' : 's'}</span>
          <button onClick={() => deletePattern(props.pattern)} class="btn-icon hover:text-destructive" title="Delete pattern"><Trash2 size={13} /></button>
        </div>
        <Show when={open()}>
          <div class="px-3 pb-2.5 border-t border-border pt-2">
            <Show when={members().length > 0} fallback={<p class="text-xs text-muted-foreground italic mb-2">No tasks yet.</p>}>
              <ul class="flex flex-col gap-1 mb-2">
                <For each={members()}>
                  {(t) => (
                    <li class="flex items-center gap-2 text-sm">
                      <Show when={t.is_habit}><Repeat size={11} class="text-primary flex-shrink-0" /></Show>
                      <span class="flex-1 text-foreground truncate">{t.title}</span>
                      <button onClick={() => removeMember(props.pattern, t.id)} class="btn-icon" title="Remove from pattern"><X size={12} /></button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <Show when={picking()} fallback={
              <button onClick={() => setPicking(true)} class="btn-secondary text-xs px-2.5 py-1"><Plus size={12} /> Add task</button>
            }>
              <div class="rounded-md border border-border bg-popover max-h-44 overflow-y-auto">
                <Show when={candidates().length > 0} fallback={<p class="p-3 text-xs text-muted-foreground text-center">No open tasks to add.</p>}>
                  <For each={candidates()}>
                    {(t) => (
                      <button onClick={() => { addMember(props.pattern, t.id); setPicking(false); }}
                        class="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-sidebar-accent">
                        <Plus size={12} class="text-primary flex-shrink-0" />
                        <span class="flex-1 truncate text-foreground">{t.title}</span>
                      </button>
                    )}
                  </For>
                </Show>
              </div>
              <button onClick={() => setPicking(false)} class="btn-ghost text-xs px-2 py-1 mt-1">Done</button>
            </Show>
          </div>
        </Show>
      </div>
    );
  }

  // ── A section per pattern category ───────────────────────────────────────────
  function Section(props: { typeName: string; title: string; subtitle: string; children?: any }) {
    const ty = () => typeByName().get(props.typeName);
    const [creating, setCreating] = createSignal(false);
    const [name, setName] = createSignal('');
    const [tag, setTag] = createSignal('');
    const isHabit = () => props.typeName === 'Habit';
    return (
      <section class="mb-6">
        <div class="flex items-center gap-2 mb-2.5">
          <span style={{ color: colorVar(ty()?.color_token) }}>
            <ShapeIcon shape={ty()?.icon_shape ?? 'square'} size={16} />
          </span>
          <div class="flex-1">
            <h2 class="text-sm font-semibold text-foreground">{props.title}</h2>
            <p class="text-[11px] text-muted-foreground">{props.subtitle}</p>
          </div>
          <Show when={isHabit()} fallback={
            <button onClick={() => setCreating((v) => !v)} class="btn-secondary text-xs px-2.5 py-1"><Plus size={12} /> New {props.typeName}</button>
          }>
            <button onClick={() => setTaskModal({ open: true })} class="btn-secondary text-xs px-2.5 py-1" title="Habits are recurring tasks"><Plus size={12} /> New Habit</button>
          </Show>
        </div>

        {/* Inline create form (Routine / Ritual) */}
        <Show when={creating()}>
          <div class="flex items-center gap-2 mb-2 rounded-lg border border-border bg-card p-2">
            <input class="input py-1 text-sm" placeholder={`${props.typeName} name`} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
            <input class="input py-1 text-sm w-28" placeholder="#tag" value={tag()} onInput={(e) => setTag(e.currentTarget.value)} />
            <button
              class="btn-primary text-xs px-3 py-1.5"
              disabled={!name().trim()}
              onClick={() => { createPattern(props.typeName, name(), tag()); setName(''); setTag(''); setCreating(false); }}
            >Create</button>
            <button class="btn-ghost text-xs px-2 py-1" onClick={() => setCreating(false)}>Cancel</button>
          </div>
        </Show>

        {props.children}
      </section>
    );
  }

  return (
    <div class="flex-1 overflow-auto p-4 md:p-6 page-enter max-w-3xl mx-auto w-full pb-24">
      <h1 class="text-2xl font-bold text-foreground mb-1">Patterns</h1>
      <p class="text-sm text-muted-foreground mb-6">Habits repeat · Routines bundle habits · Rituals assemble a day's prep.</p>

      <Section typeName="Habit" title="Habits" subtitle="Repeating single actions with a known duration">
        <Show when={habitTasks().length > 0} fallback={<EmptyHint>No habits yet — “New Habit” creates a recurring task.</EmptyHint>}>
          <div class="flex flex-col gap-1.5">
            <For each={habitTasks()}>
              {(t) => (
                <div class="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
                  <Repeat size={12} class="text-primary flex-shrink-0" />
                  <span class="flex-1 text-sm text-foreground truncate">{t.title}</span>
                  <Show when={t.tags?.length}><span class="text-primary text-xs">#{t.tags[0]}</span></Show>
                  <Show when={t.estimated_minutes}><span class="text-[11px] font-mono text-muted-foreground">{t.estimated_minutes}m</span></Show>
                  <button onClick={() => setTaskModal({ open: true, editTask: t })} class="btn-icon" title="Edit habit"><Pencil size={13} /></button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </Section>

      <Section typeName="Routine" title="Routines" subtitle="A bundle of habits that go together (e.g. Prep for work)">
        <PatternList typeName="Routine" />
      </Section>

      <Section typeName="Ritual" title="Rituals" subtitle="Habits + one-off tasks for an occasion (e.g. Board-meeting prep)">
        <PatternList typeName="Ritual" />
      </Section>
    </div>
  );

  // Helper sub-components that need the closures above.
  function PatternList(props: { typeName: string }) {
    const ty = () => typeByName().get(props.typeName);
    return (
      <Show when={patternsOfType(props.typeName).length > 0} fallback={<EmptyHint>No {props.typeName.toLowerCase()}s yet.</EmptyHint>}>
        <div class="flex flex-col gap-1.5">
          <For each={patternsOfType(props.typeName)}>
            {(p) => <PatternCard pattern={p} shape={ty()?.icon_shape ?? 'square'} color={colorVar(ty()?.color_token)} />}
          </For>
        </div>
      </Show>
    );
  }
}

function EmptyHint(props: { children: any }) {
  return <p class="text-sm text-muted-foreground rounded-lg border border-dashed border-border px-3 py-4 text-center">{props.children}</p>;
}
