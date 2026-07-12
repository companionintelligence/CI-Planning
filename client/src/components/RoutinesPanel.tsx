import { createSignal, createMemo, createResource, For, Show, onCleanup } from 'solid-js';
import { Plus, Trash2, X, ChevronDown, ChevronRight, Repeat, Pencil, Zap, ArrowUpRight, Search } from 'lucide-solid';
import { patterns, patternTypes, prefs, refetchPatterns, showToast, setElementModal } from '../stores/index.js';
import { api, type Pattern, type PatternType, type Task } from '../lib/api.js';
import { buildRule, rulePresetForPattern, describeRule, WEEKDAYS, DAY_INITIAL, type RepeatPreset } from '../lib/recurrence.js';
import { useDropZone, dragPayload } from '../lib/draggable.js';
import { on } from '../lib/sse.js';
import { ShapeIcon } from '../components/ShapeIcon.js';
import { MinuteDial } from '../components/MinuteDial.js';
import { colorVar } from '../lib/pattern-meta.js';
import { routineChips } from '../lib/multi-tag.js';

/**
 * Routines (and Rituals, when enabled) — the pattern-collection content extracted
 * verbatim from the Patterns view (T-TASKS-1) so it can mount as the Tasks-screen
 * **Routines** tab. Self-contained: owns its own task fetch + membership ops.
 *
 * Adds two enhancements over the old Patterns section:
 *  - **T-RTN-1**: the New-Routine form can seed the routine with existing Tasks and
 *    new-by-name Tasks (title only — fleshed out later from this tab).
 *  - **T-RTN-2**: each member row has an Edit affordance opening the ElementWizard.
 */
export function RoutinesPanel() {
  // Own unfiltered task fetch so the view is correct regardless of the global task
  // filter; refreshed on task SSE + after our own mutations. include_fast so a
  // ritual's hidden fast tasks resolve here (they're excluded elsewhere).
  const [allTasks, { refetch: refetchAll }] = createResource(() => api.tasks.list({ include_fast: '1' }).then((r) => r.tasks));
  const offCreated = on('task:created', () => refetchAll());
  const offUpdated = on('task:updated', () => refetchAll());
  onCleanup(() => { offCreated(); offUpdated(); });

  const typeByName = createMemo(() => {
    const m = new Map<string, PatternType>();
    for (const t of patternTypes() ?? []) m.set(t.name, t);
    return m;
  });
  const taskById = createMemo(() => {
    const m = new Map<string, Task>();
    for (const t of allTasks() ?? []) m.set(t.id, t);
    return m;
  });

  const patternsOfType = (name: string) => {
    const ty = typeByName().get(name);
    return ty ? (patterns() ?? []).filter((p) => p.type_id === ty.id) : [];
  };

  // Routines section is a drop zone (Phase E): a Habit task or Plan Block dropped
  // in promotes into a new Routine (server picks the right promote-from-* route).
  async function onRoutineDrop(p: { kind: string; id: string }) {
    try {
      if (p.kind === 'habit') {
        const task = (allTasks() ?? []).find((t) => t.id === p.id);
        if (!task) return;
        await api.patterns.promoteFromTasks([p.id], `${task.title} routine`);
        showToast(`Created Routine from "${task.title}"`, 'success');
      } else if (p.kind === 'time-block') {
        await api.patterns.promoteFromPlanTemplate(p.id, 'New routine');
        showToast('Created Routine from Time Block', 'success');
      }
      refetchPatterns();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }
  const routineDrop = useDropZone(onRoutineDrop);

  // ── Pattern create + membership ops (closure over refetch) ────────────────────
  async function deletePattern(p: Pattern) {
    try { await api.patterns.delete(p.id); refetchPatterns(); showToast(`Deleted "${p.name}"`, 'default'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function addMember(p: Pattern, taskId: string) {
    try { await api.patterns.addTask(p.id, taskId); refetchPatterns(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function removeMember(p: Pattern, taskId: string) {
    try { await api.patterns.removeTask(p.id, taskId); refetchPatterns(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  // Promote a (regular or fast) task to a habit — it joins the Habits group, the
  // ritual keeps it, and a fast task loses its hidden/local status.
  async function promoteHabit(t: Task) {
    try { await api.tasks.promoteHabit(t.id); refetchAll(); refetchPatterns(); showToast(`"${t.title}" is now a habit`, 'success'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function addFast(p: Pattern, title: string) {
    try { await api.patterns.addFastTask(p.id, { title: title.trim() }); refetchPatterns(); refetchAll(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function removeFast(p: Pattern, taskId: string) {
    try { await api.patterns.removeFastTask(p.id, taskId); refetchPatterns(); refetchAll(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function saveEst(taskId: string, v: number) {
    try { await api.tasks.update(taskId, { estimated_minutes: v }); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function savePatternRule(p: Pattern, rule: string | null) {
    try { await api.patterns.update(p.id, { recurrence_rule: rule }); refetchPatterns(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  // T-RTN: a free-text note on a routine (patterns.notes already exists server-side).
  async function saveNote(p: Pattern, notes: string) {
    if ((notes || '') === (p.notes ?? '')) return;
    try { await api.patterns.update(p.id, { notes: notes.trim() || null }); refetchPatterns(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  /** Total estimated minutes across a routine's member tasks → "2h 15m" / "45m". */
  const fmtMin = (n: number) => (n >= 60 ? `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}m` : ''}` : `${n}m`);
  async function placePattern(p: Pattern) {
    try {
      const { result } = await api.patterns.placeToday(p.id);
      if (result.skippedAlreadyPlaced) showToast(`"${p.name}" already placed today`, 'default');
      else showToast(`Placed "${p.name}" — ${result.blocksCreated} block${result.blocksCreated === 1 ? '' : 's'}`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  /**
   * T-RTN-1 — create a Routine, then seed it with the chosen existing Tasks and any
   * new-by-name Tasks (created title-only), preserving order via `position`. No
   * auto-scheduling; new-by-name Tasks carry only a title (fleshed out later).
   * AF-11: no authored tag — the routine's tags derive from its member tasks.
   */
  async function createRoutineWithTasks(typeName: string, name: string, attached: AttachItem[]) {
    const ty = typeByName().get(typeName);
    try {
      const { pattern } = await api.patterns.create({
        type_id: ty?.id ?? null,
        name: name.trim(),
      });
      let position = 0;
      for (const item of attached) {
        const taskId = item.kind === 'existing'
          ? item.id
          : (await api.tasks.create({ title: item.title })).task.id;
        await api.patterns.addTask(pattern.id, taskId, position++);
      }
      refetchPatterns();
      refetchAll();
      showToast(`${typeName} "${name.trim()}" created`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // A member row — fast tasks get the minute dial + delete; regular members can be
  // promoted to a habit. `allowFast` (rituals) gates the fast-task affordances.
  // T-RTN-2: a pencil opens the ElementWizard so a name-only member can be completed.
  function MemberRow(props: { pattern: Pattern; task: Task; allowFast: boolean }) {
    const [est, setEst] = createSignal(props.task.estimated_minutes ?? 15);
    const onDial = (v: number) => { setEst(v); saveEst(props.task.id, v); };
    return (
      <li class="flex items-center gap-2 text-sm">
        <Show when={props.task.is_fast_task} fallback={<Show when={props.task.is_habit}><Repeat size={11} class="text-primary flex-shrink-0" /></Show>}>
          <Zap size={11} class="text-chart-1 flex-shrink-0" />
        </Show>
        <span class="flex-1 text-foreground truncate">{props.task.title}</span>
        <Show when={props.task.is_fast_task}>
          <MinuteDial value={est()} onChange={onDial} min={0} max={480} />
        </Show>
        <Show when={props.allowFast && !props.task.is_habit}>
          <button onClick={() => promoteHabit(props.task)} class="btn-icon" title="Promote to habit"><ArrowUpRight size={13} /></button>
        </Show>
        <Show when={!props.task.is_fast_task}>
          <button
            onClick={() => setElementModal({
              open: true, mode: 'edit',
              kind: props.task.is_habit ? 'habit' : 'task',
              editTarget: { kind: props.task.is_habit ? 'habit' : 'task', id: props.task.id },
            })}
            class="btn-icon" title="Edit task"
          ><Pencil size={12} /></button>
        </Show>
        <button
          onClick={() => (props.task.is_fast_task ? removeFast(props.pattern, props.task.id) : removeMember(props.pattern, props.task.id))}
          class="btn-icon hover:text-destructive" title={props.task.is_fast_task ? 'Delete fast task' : 'Remove from pattern'}
        ><X size={12} /></button>
      </li>
    );
  }

  // ── Inline pattern card (members + add/remove + delete; rituals add fast tasks) ─
  function PatternCard(props: { pattern: Pattern; shape: string; color: string; allowFast: boolean }) {
    const [open, setOpen] = createSignal(false);
    const [picking, setPicking] = createSignal(false);
    const [fast, setFast] = createSignal('');
    const members = () => props.pattern.task_ids.map((id) => taskById().get(id)).filter(Boolean) as Task[];
    const totalMin = () => members().reduce((s, t) => s + (t.estimated_minutes ?? 0), 0);
    const [note, setNote] = createSignal(props.pattern.notes ?? '');
    // Habits (recurring tasks) CAN be added to a routine, so include them even though
    // a habit template's status isn't 'open'. Routines are never addable here.
    const candidates = () => {
      const have = new Set(props.pattern.task_ids);
      return (allTasks() ?? []).filter((t) => (t.status === 'open' || t.is_habit) && !t.parent_id && !t.is_fast_task && !have.has(t.id)).slice(0, 30);
    };
    const submitFast = () => { if (fast().trim()) { addFast(props.pattern, fast()); setFast(''); } };

    // Pattern-level recurrence editor (PR-C+, Phase D). Routines and Habits only;
    // Rituals are flagged off (server returns 422 if asked to set a rule on one).
    const parsed = createMemo(() => rulePresetForPattern(props.pattern.recurrence_rule));
    const [preset, setPreset] = createSignal<RepeatPreset>(parsed().preset);
    const [days, setDays] = createSignal<string[]>(parsed().weekdays);
    const ruleNow = () => buildRule(preset(), days(), '');
    const describe = () => {
      const r = ruleNow();
      return r ? describeRule(r) : 'Doesn’t repeat';
    };
    function onPreset(p: RepeatPreset) {
      setPreset(p);
      if (p !== 'specific-days') setDays([]);
      void savePatternRule(props.pattern, buildRule(p, days(), ''));
    }
    function toggleDay(d: string) {
      const next = days().includes(d) ? days().filter((x) => x !== d) : [...days(), d];
      setDays(next);
      if (preset() === 'specific-days') void savePatternRule(props.pattern, buildRule('specific-days', next, ''));
    }
    const canRecur = props.shape !== 'triangle'; // not a Ritual

    return (
      <div class="rounded-lg border border-border bg-card">
        <div class="flex items-center gap-2 px-3 py-2">
          <button onClick={() => setOpen((v) => !v)} class="text-muted-foreground hover:text-foreground">
            <Show when={open()} fallback={<ChevronRight size={14} />}><ChevronDown size={14} /></Show>
          </button>
          <span class="flex-1 text-sm font-medium text-foreground truncate">{props.pattern.name}</span>
          {/* AF-11: the derived member-tag union — directions solid, intentions ghost
              (TaskCard's solid/ghost idiom). Multiple directions are expected. */}
          <For each={routineChips(props.pattern).directions}>
            {(d) => <span class="badge-neutral text-[11px] flex-shrink-0">#{d}</span>}
          </For>
          <For each={routineChips(props.pattern).ghosts}>
            {(t) => (
              <span class="text-[10px] px-1.5 py-0.5 rounded-full border border-border/60 text-muted-foreground/80 flex-shrink-0" title="from member tasks">
                {t}
              </span>
            )}
          </For>
          <Show when={props.pattern.recurrence_rule}>
            <span class="text-[10px] text-muted-foreground" title={describe()}>{describe()}</span>
          </Show>
          <span class="text-[11px] text-muted-foreground">{props.pattern.task_ids.length} task{props.pattern.task_ids.length === 1 ? '' : 's'}</span>
          <Show when={totalMin() > 0}><span class="text-[11px] text-muted-foreground" title="Total estimated time of attached tasks">· {fmtMin(totalMin())}</span></Show>
          <button onClick={() => placePattern(props.pattern)} class="btn-icon" title="Add to today's board"><Plus size={15} class="text-primary" /></button>
          <button onClick={() => deletePattern(props.pattern)} class="btn-icon hover:text-destructive" title="Delete pattern"><Trash2 size={13} /></button>
        </div>
        <Show when={open()}>
          <div class="px-3 pb-2.5 border-t border-border pt-2">
            <Show when={canRecur}>
              <div class="mb-3 rounded-md border border-border/60 bg-background/40 p-2">
                <div class="flex items-center gap-1.5 mb-1.5">
                  <Repeat size={11} class="text-muted-foreground" />
                  <span class="text-[10px] uppercase tracking-wide text-muted-foreground">Repeat</span>
                  <span class="ml-auto text-[10px] text-muted-foreground">{describe()}</span>
                </div>
                <div class="flex flex-wrap gap-1">
                  <For each={['none','daily','specific-days','weekly','monthly','yearly'] as RepeatPreset[]}>
                    {(p) => (
                      <button onClick={() => onPreset(p)}
                        class="text-[11px] px-2 py-0.5 rounded border"
                        classList={{
                          'border-primary text-primary bg-primary/10': preset() === p,
                          'border-border text-muted-foreground hover:text-foreground': preset() !== p,
                        }}>
                        {p === 'none' ? 'Never' : p === 'specific-days' ? 'Days' : (p[0].toUpperCase() + p.slice(1))}
                      </button>
                    )}
                  </For>
                </div>
                <Show when={preset() === 'specific-days'}>
                  <div class="flex gap-1 mt-1.5">
                    <For each={WEEKDAYS}>
                      {(d) => (
                        <button onClick={() => toggleDay(d)}
                          class="text-[10px] w-6 h-6 rounded border"
                          classList={{
                            'border-primary text-primary bg-primary/10': days().includes(d),
                            'border-border text-muted-foreground hover:text-foreground': !days().includes(d),
                          }}>
                          {DAY_INITIAL[d]}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>
            </Show>
            {/* Free-text note on the routine (persists to patterns.notes on blur). */}
            <textarea
              class="input w-full text-sm py-1.5 resize-none mb-3"
              rows={2}
              placeholder="Add a note…"
              value={note()}
              onInput={(e) => setNote(e.currentTarget.value)}
              onBlur={() => saveNote(props.pattern, note())}
            />
            <Show when={members().length > 0} fallback={<p class="text-xs text-muted-foreground italic mb-2">No tasks yet.</p>}>
              <ul class="flex flex-col gap-1 mb-2">
                <For each={members()}>
                  {(t) => <MemberRow pattern={props.pattern} task={t} allowFast={props.allowFast} />}
                </For>
              </ul>
            </Show>

            <div class="flex flex-wrap items-center gap-1.5">
              <Show when={picking()} fallback={
                <button onClick={() => setPicking(true)} class="btn-secondary text-xs px-2.5 py-1"><Plus size={12} /> Add task</button>
              }>
                <div class="w-full rounded-md border border-border bg-popover max-h-44 overflow-y-auto">
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
                  <button onClick={() => setPicking(false)} class="btn-ghost text-xs px-2 py-1 m-1">Done</button>
                </div>
              </Show>

              {/* Rituals: a fast task — title only; the estimate is predicted, then dialed. */}
              <Show when={props.allowFast && !picking()}>
                <div class="inline-flex items-center gap-1">
                  <Zap size={12} class="text-chart-1" />
                  <input
                    class="input py-1 text-sm w-44" placeholder="Fast task (e.g. blow-out hair)"
                    value={fast()} onInput={(e) => setFast(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === 'Enter' && submitFast()}
                  />
                  <button onClick={submitFast} disabled={!fast().trim()} class="btn-secondary text-xs px-2 py-1"><Plus size={12} /> Fast</button>
                </div>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    );
  }

  // ── T-RTN-1: task-attach area for the New-Routine create form ─────────────────
  function TaskAttach(props: { items: AttachItem[]; onChange: (items: AttachItem[]) => void }) {
    const [query, setQuery] = createSignal('');
    const [newName, setNewName] = createSignal('');
    const have = () => new Set(props.items.filter((i) => i.kind === 'existing').map((i) => (i as ExistingItem).id));
    const candidates = () => {
      const q = query().trim().toLowerCase();
      const taken = have();
      return (allTasks() ?? [])
        .filter((t) => (t.status === 'open' || t.is_habit) && !t.parent_id && !t.is_fast_task && !taken.has(t.id))
        .filter((t) => (q ? t.title.toLowerCase().includes(q) : true))
        .slice(0, 6);
    };
    const addExisting = (t: Task) => { props.onChange([...props.items, { kind: 'existing', id: t.id, title: t.title }]); setQuery(''); };
    const addNew = () => {
      const title = newName().trim();
      if (!title) return;
      props.onChange([...props.items, { kind: 'new', title }]);
      setNewName('');
    };
    const removeAt = (idx: number) => props.onChange(props.items.filter((_, i) => i !== idx));

    return (
      <div class="mt-2 rounded-md border border-border/60 bg-background/40 p-2">
        <p class="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">Tasks (optional)</p>

        <Show when={props.items.length > 0}>
          <div class="flex flex-wrap gap-1 mb-2">
            <For each={props.items}>
              {(item, i) => (
                <span class="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-xs text-foreground">
                  <Show when={item.kind === 'new'}><Plus size={10} class="text-primary" /></Show>
                  <span class="truncate max-w-40">{item.title}</span>
                  <button onClick={() => removeAt(i())} class="text-muted-foreground hover:text-destructive"><X size={11} /></button>
                </span>
              )}
            </For>
          </div>
        </Show>

        <div class="flex items-center gap-1.5 flex-wrap">
          <div class="relative flex-1 min-w-40">
            <Search size={12} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none" />
            <input
              class="input py-1 text-sm pl-7" placeholder="Search existing tasks…"
              value={query()} onInput={(e) => setQuery(e.currentTarget.value)}
            />
            <Show when={query().trim() && candidates().length > 0}>
              <div class="absolute z-10 left-0 right-0 mt-1 rounded-md border border-border bg-popover max-h-44 overflow-y-auto shadow-lg">
                <For each={candidates()}>
                  {(t) => (
                    <button onClick={() => addExisting(t)}
                      class="w-full flex items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-sidebar-accent">
                      <Plus size={12} class="text-primary flex-shrink-0" />
                      <span class="flex-1 truncate text-foreground">{t.title}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>
          </div>
          <input
            class="input py-1 text-sm w-40" placeholder="+ New task by name"
            value={newName()} onInput={(e) => setNewName(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addNew())}
          />
          <button onClick={addNew} disabled={!newName().trim()} class="btn-secondary text-xs px-2 py-1"><Plus size={12} /> Add</button>
        </div>
        <p class="text-[10px] text-muted-foreground mt-1.5">New tasks are created with a title only — edit details later from this tab.</p>
      </div>
    );
  }

  // ── A section per pattern category ───────────────────────────────────────────
  function Section(props: { typeName: string; title: string; subtitle: string; children?: any }) {
    const ty = () => typeByName().get(props.typeName);
    const [creating, setCreating] = createSignal(false);
    const [name, setName] = createSignal('');
    const [attached, setAttached] = createSignal<AttachItem[]>([]);
    const canAttach = props.typeName === 'Routine'; // T-RTN-1 is scoped to Routine creation
    const reset = () => { setName(''); setAttached([]); setCreating(false); };
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
          {/* Routine creation now happens from a task (Tasks → add-to-routine → + New
              routine); the standalone "New Routine" button is removed. Rituals keep theirs. */}
          <Show when={props.typeName !== 'Routine'}>
            <button onClick={() => setCreating((v) => !v)} class="btn-secondary text-xs px-2.5 py-1"><Plus size={12} /> New {props.typeName}</button>
          </Show>
        </div>

        {/* Inline create form (Routine / Ritual) */}
        <Show when={creating()}>
          <div class="mb-2 rounded-lg border border-border bg-card p-2">
            <div class="flex items-center gap-2">
              <input class="input py-1 text-sm" placeholder={`${props.typeName} name`} value={name()} onInput={(e) => setName(e.currentTarget.value)} />
              <button
                class="btn-primary text-xs px-3 py-1.5"
                disabled={!name().trim()}
                onClick={() => { createRoutineWithTasks(props.typeName, name(), attached()); reset(); }}
              >Create</button>
              <button class="btn-ghost text-xs px-2 py-1" onClick={reset}>Cancel</button>
            </div>
            <Show when={canAttach}>
              <TaskAttach items={attached()} onChange={setAttached} />
            </Show>
          </div>
        </Show>

        {props.children}
      </section>
    );
  }

  function PatternList(props: { typeName: string }) {
    const ty = () => typeByName().get(props.typeName);
    return (
      <Show when={patternsOfType(props.typeName).length > 0} fallback={<EmptyHint>No {props.typeName.toLowerCase()}s yet.</EmptyHint>}>
        <div class="flex flex-col gap-1.5">
          <For each={patternsOfType(props.typeName)}>
            {(p) => <PatternCard pattern={p} shape={ty()?.icon_shape ?? 'square'} color={colorVar(ty()?.color_token)} allowFast={props.typeName === 'Ritual'} />}
          </For>
        </div>
      </Show>
    );
  }

  return (
    <div
      onPointerUp={routineDrop.handlers.onPointerUp}
      class="rounded-xl transition-colors"
      classList={{
        'ring-2 ring-primary/40 bg-primary/[0.04]': routineDrop.isOver(),
        '-mx-1 px-1': routineDrop.isOver(),
      }}
    >
      <Section typeName="Routine" title="Routines" subtitle="A bundle of habits that go together (e.g. Prep for work). Drop a Habit or Time Block to make one.">
        <Show when={dragPayload()}>
          <p class="text-[11px] text-primary text-center -mt-2 mb-2">Drop here to create a Routine →</p>
        </Show>
        <PatternList typeName="Routine" />
      </Section>

      <Show when={prefs()?.enable_rituals}>
        <Section typeName="Ritual" title="Rituals" subtitle="Habits + one-off tasks for an occasion (e.g. Board-meeting prep)">
          <PatternList typeName="Ritual" />
        </Section>
      </Show>
    </div>
  );
}

type ExistingItem = { kind: 'existing'; id: string; title: string };
type AttachItem = ExistingItem | { kind: 'new'; title: string };

function EmptyHint(props: { children: any }) {
  return <p class="text-sm text-muted-foreground rounded-lg border border-dashed border-border px-3 py-4 text-center">{props.children}</p>;
}
