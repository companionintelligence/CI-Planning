import { For, Show, createSignal, createMemo, createResource, onMount, onCleanup } from 'solid-js';
import { Plus, Triangle, ListPlus, Boxes, Search, ChevronDown, ChevronRight, Star, Pentagon, StickyNote, RotateCcw } from 'lucide-solid';
import { A } from '@solidjs/router';
import { api, type BlockTemplate, type Pattern } from '../lib/api.js';
import {
  tasks, flightPlan, patterns, patternTypes, prefs, refetchTasks, refetchFlightPlan, refetchBlocks, refetchConcepts, showToast,
} from '../stores/index.js';
import { localISODate } from '../lib/dates.js';
import { ShapeIcon } from './ShapeIcon.js';
import { DEFAULT_CONCEPT_TAGS, type ConceptTag } from '../lib/pattern-meta.js';

/**
 * The lower drawer (Phase G, G5). Floats above the cockpit and **never closes** —
 * its bar (`[+ Block] [+ Routine] [+ Open Task]`) is always present; the panel
 * above it expands/contracts. Each action stages onto the flight-plan (tasks,
 * patterns) or drops a Time-Block container onto the PLANNER.
 */

type Tab = 'block' | 'pattern' | 'task' | null;

/** ISO instant for HH:MM on today's local date. */
function isoAtToday(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date();
  d.setHours(h || 0, m || 0, 0, 0);
  return d.toISOString();
}

/** "HH:MM" for the next half-hour boundary from now. */
function nextHalfHour(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Local-midnight ISO for a YYYY-MM-DD date — the placeholder anchor for a Concept. */
function isoAtMidnight(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}

/** ISO instant for HH:MM on a given YYYY-MM-DD local date. */
function isoAt(dateStr: string, hhmm: string): string {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(y, mo - 1, d, h || 0, mi || 0, 0, 0).toISOString();
}

export function PlannerDrawer() {
  const [tab, setTab] = createSignal<Tab>(null);
  const [query, setQuery] = createSignal('');
  const select = (t: Exclude<Tab, null>) => { setQuery(''); setTab((cur) => (cur === t ? null : t)); };

  // Esc closes the drawer (focus-trap nicety, cockpit-v2 Phase 3).
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && tab() !== null) setTab(null); };
  onMount(() => window.addEventListener('keydown', onKey));
  onCleanup(() => window.removeEventListener('keydown', onKey));

  const stagedIds = createMemo(() => new Set((flightPlan() ?? []).map((i) => i.task_id)));

  // Open-Task views (cockpit-v2 Phase 6): filtered slices of the one tasks table.
  const [taskView, setTaskView] = createSignal<'open' | 'tbd' | 'deferred' | 'past'>('open');

  // ── Open Task tab ────────────────────────────────────────────────────────────
  // Four filtered views over the one tasks table (cockpit-v2 Phase 6): Open · TBD ·
  // Deferred · Past (the shelf). Search by name OR tag (strip '#'); empty query = all.
  const viewTasks = () => {
    const q = query().trim().toLowerCase().replace(/^#/, '');
    const v = taskView();
    return (tasks() ?? [])
      .filter((t) => !t.parent_id && !t.is_fast_task)
      .filter((t) => {
        if (v === 'open')     return t.status === 'open' && !stagedIds().has(t.id);
        if (v === 'tbd')      return t.status === 'open' && (t.tags?.length ?? 0) >= 1 && !t.due_at && !t.estimated_minutes && !t.scheduled_for && !(t.notes && t.notes.trim());
        if (v === 'deferred') return t.status === 'deferred';
        return ['done', 'completed', 'deferred'].includes(t.status); // past — the shelf
      })
      .filter((t) => !q || t.title.toLowerCase().includes(q) || (t.tags ?? []).some((tag) => tag.toLowerCase().includes(q)))
      .slice(0, 50);
  };
  async function stageTask(id: string) {
    try { await api.flightPlan.addTask(id); refetchFlightPlan(); showToast('Added to flight-plan', 'default'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  // Recall (cockpit-v2 Phase 6): clone a shelved/Past task to a brand-new open task.
  async function recall(id: string) {
    try { const { task } = await api.tasks.recall(id); refetchTasks(); showToast(`Recalled "${task.title}" as a new task`, 'success'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }
  // Create a brand-new task from the typed text (quick-add parses #tags / times) and
  // stage it straight onto the flight-plan.
  async function createAndStage(text: string) {
    try {
      const { task } = await api.tasks.quick(text.trim());
      await api.flightPlan.addTask(task.id);
      refetchTasks(); refetchFlightPlan();
      setQuery('');
      showToast(`Added "${task.title}" to the flight-plan`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // ── Pattern Wizard (Habits / Routines / Rituals as separate submenus) ─────────
  const typeIdByName = createMemo(() => {
    const m = new Map<string, string>();
    for (const t of patternTypes() ?? []) m.set(t.name, t.id);
    return m;
  });
  const shapeByName = (name: string) => (patternTypes() ?? []).find((t) => t.name === name)?.icon_shape ?? 'square';
  // Habits are is_habit *tasks*; Routines/Rituals are patterns of that type.
  const habitItems = () => {
    const q = query().trim().toLowerCase().replace(/^#/, '');
    return (tasks() ?? []).filter((t) => t.is_habit && !t.recurrence_parent_id && (!q || t.title.toLowerCase().includes(q)));
  };
  const patternsByType = (name: string) => {
    const q = query().trim().toLowerCase().replace(/^#/, '');
    const id = typeIdByName().get(name);
    return (patterns() ?? []).filter((p) => p.type_id === id && (!q || p.name.toLowerCase().includes(q) || (p.tag ?? '').toLowerCase().includes(q)));
  };
  /** Resolve a habit task to its Habit-type Pattern id (always exists once a task
   *  is flagged is_habit — `ensureHabitPattern` runs on promote-habit and on POST
   *  /api/tasks with is_habit=true). One pattern code path for both habits + bundles. */
  function habitPatternIdFor(taskId: string): string | null {
    const habitTypeId = typeIdByName().get('Habit');
    if (habitTypeId == null) return null;
    const p = (patterns() ?? []).find((p) => p.type_id === habitTypeId && p.task_ids.includes(taskId));
    return p?.id ?? null;
  }
  async function placeHabitToday(taskTitle: string, taskId: string) {
    const patternId = habitPatternIdFor(taskId);
    if (patternId == null) {
      showToast('Habit pattern not found yet — try again in a moment', 'error');
      return;
    }
    try {
      const { result } = await api.patterns.placeToday(patternId);
      refetchBlocks();
      if (result.skippedAlreadyPlaced) showToast(`"${taskTitle}" already on today`, 'default');
      else showToast(`Placed "${taskTitle}" (${result.blocksCreated} block${result.blocksCreated === 1 ? '' : 's'})`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function placePatternToday(id: string, name: string) {
    try {
      const { result } = await api.patterns.placeToday(id);
      refetchBlocks();
      if (result.skippedAlreadyPlaced) showToast(`"${name}" already placed today`, 'default');
      else showToast(`Placed ${name} (${result.blocksCreated} block${result.blocksCreated === 1 ? '' : 's'})`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // A pattern row: icon · name · description, expand to see member tasks, add to flight-plan.
  function PatternRow(props: { pattern: Pattern }) {
    const [open, setOpen] = createSignal(false);
    const members = () => props.pattern.task_ids.map((id) => (tasks() ?? []).find((t) => t.id === id)?.title).filter(Boolean) as string[];
    return (
      <div>
        <div class="flex items-center gap-2 px-3 py-1.5 hover:bg-sidebar-accent">
          <div class="flex-1 min-w-0">
            <div class="text-sm text-foreground truncate">{props.pattern.name}</div>
            <Show when={props.pattern.notes}>{(n) => <div class="text-[11px] text-muted-foreground truncate">{n()}</div>}</Show>
          </div>
          <Show when={props.pattern.tag}>{(t) => <span class="text-primary text-xs">#{t()}</span>}</Show>
          <span class="text-[11px] text-muted-foreground">{props.pattern.task_ids.length}t</span>
          <button onClick={() => setOpen((v) => !v)} class="btn-icon" title="Show tasks">
            <Show when={open()} fallback={<ChevronRight size={13} />}><ChevronDown size={13} /></Show>
          </button>
          <button onClick={() => placePatternToday(props.pattern.id, props.pattern.name)} class="btn-icon" title="Add to today's board"><Plus size={14} class="text-primary" /></button>
        </div>
        <Show when={open()}>
          <ul class="pl-8 pr-3 pb-1.5 flex flex-col gap-0.5">
            <For each={members()}>{(n) => <li class="text-[11px] text-muted-foreground truncate">· {n}</li>}</For>
          </ul>
        </Show>
      </div>
    );
  }

  // A collapsible category submenu.
  function PatternCat(props: { typeName: string; title: string; desc: string }) {
    const [open, setOpen] = createSignal(true);
    const count = () => (props.typeName === 'Habit' ? habitItems().length : patternsByType(props.typeName).length);
    return (
      <div class="rounded-md border border-border">
        <button onClick={() => setOpen((v) => !v)} class="w-full flex items-center gap-2 px-3 py-2 text-left">
          <span class="text-primary"><ShapeIcon shape={shapeByName(props.typeName)} size={14} /></span>
          <span class="text-sm font-medium text-foreground">{props.title}</span>
          <span class="text-[11px] text-muted-foreground">· {props.desc} · {count()}</span>
          <span class="ml-auto text-muted-foreground"><Show when={open()} fallback={<ChevronRight size={14} />}><ChevronDown size={14} /></Show></span>
        </button>
        <Show when={open()}>
          <div class="border-t border-border">
            <Show when={count() > 0} fallback={<p class="px-3 py-2 text-xs text-muted-foreground italic">None yet.</p>}>
              <Show when={props.typeName === 'Habit'}>
                <For each={habitItems()}>
                  {(t) => (
                    <div class="flex items-center gap-2 px-3 py-1.5 hover:bg-sidebar-accent">
                      <ShapeIcon shape="circle" size={12} />
                      <span class="flex-1 text-sm text-foreground truncate">{t.title}</span>
                      <Show when={t.estimated_minutes}><span class="text-[11px] text-muted-foreground">{t.estimated_minutes}m</span></Show>
                      <button onClick={() => placeHabitToday(t.title, t.id)} class="btn-icon" title="Add to today's board"><Plus size={14} class="text-primary" /></button>
                    </div>
                  )}
                </For>
              </Show>
              <Show when={props.typeName !== 'Habit'}>
                <For each={patternsByType(props.typeName)}>{(p) => <PatternRow pattern={p} />}</For>
              </Show>
            </Show>
          </div>
        </Show>
      </div>
    );
  }

  // Plan Blocks tile — saved Plan templates the user can drop onto today.
  // Mirrors PatternCat's shape but reads from `templates` (block_templates).
  function PlanBlocksCat() {
    const [open, setOpen] = createSignal(true);
    const items = () => {
      const q = query().trim().toLowerCase().replace(/^#/, '');
      const list = templates() ?? [];
      return q ? list.filter((t) => t.name.toLowerCase().includes(q) || (t.tag ?? '').toLowerCase().includes(q)) : list;
    };
    return (
      <div class="rounded-md border border-border">
        <button onClick={() => setOpen((v) => !v)} class="w-full flex items-center gap-2 px-3 py-2 text-left">
          <Star size={14} class="text-primary fill-primary/30" />
          <span class="text-sm font-medium text-foreground">Time Blocks</span>
          <span class="text-[11px] text-muted-foreground">· saved Time Block shapes · {items().length}</span>
          <span class="ml-auto text-muted-foreground"><Show when={open()} fallback={<ChevronRight size={14} />}><ChevronDown size={14} /></Show></span>
        </button>
        <Show when={open()}>
          <div class="border-t border-border">
            <Show when={items().length > 0} fallback={<p class="px-3 py-2 text-xs text-muted-foreground italic">None yet — save a Time Block from the Planner ★ menu.</p>}>
              <For each={items()}>
                {(t) => (
                  <div class="flex items-center gap-2 px-3 py-1.5 hover:bg-sidebar-accent">
                    <Star size={12} class="text-primary" />
                    <span class="flex-1 text-sm text-foreground truncate">{t.name}</span>
                    <Show when={t.tag}><span class="text-primary text-xs">#{t.tag}</span></Show>
                    <span class="text-[11px] text-muted-foreground">{t.default_minutes}m</span>
                    <button onClick={() => instantiate(t)} class="btn-icon" title="Drop onto today"><Plus size={14} class="text-primary" /></button>
                  </div>
                )}
              </For>
            </Show>
          </div>
        </Show>
      </div>
    );
  }

  // ── Block tab ────────────────────────────────────────────────────────────────
  // Templates feed BOTH the Block tab (instantiate from history) and the Pattern
  // tab's Plan Blocks tile (PR-C+), so the resource fires when either tab opens.
  const [templates, { refetch: refetchTemplates }] = createResource(
    () => (tab() === 'block' || tab() === 'pattern' ? 'on' : null),
    () => api.blockTemplates.list().then((r) => r.block_templates),
  );
  // Block Wizard — every block starts as a Concept (named/tagged from the canonical
  // list), then optionally becomes a scheduled Plan.
  const conceptTags = () => prefs()?.concept_tags ?? DEFAULT_CONCEPT_TAGS;
  const [step, setStep] = createSignal<'concept' | 'plan'>('concept');
  const [bwName, setBwName] = createSignal('');
  const [bwTags, setBwTags] = createSignal('');             // space/comma separated; first is primary
  const [bwGoal, setBwGoal] = createSignal(localISODate());
  const [bwEst, setBwEst] = createSignal(60);               // concept estimate (minutes)
  const [bwStart, setBwStart] = createSignal(nextHalfHour());
  const [pD, setPD] = createSignal(0);
  const [pH, setPH] = createSignal(1);
  const [pM, setPM] = createSignal(0);
  const [noteOn, setNoteOn] = createSignal(false);
  const [note, setNote] = createSignal('');
  const [saveTpl, setSaveTpl] = createSignal(false);

  const tagList = () => bwTags().split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
  function pickConceptTag(ct: ConceptTag) { setBwName(ct.name); setBwTags(ct.name); setBwEst(ct.minutes); }
  function resetWizard() {
    setStep('concept'); setBwName(''); setBwTags(''); setBwGoal(localISODate());
    setBwEst(60); setBwStart(nextHalfHour()); setPD(0); setPH(1); setPM(0); setNoteOn(false); setNote('');
  }
  const noteOrNull = () => (noteOn() && note().trim() ? note().trim() : undefined);

  // A small note toggle shared by the Concept + Plan steps.
  const NoteToggle = () => (
    <div>
      <button type="button" onClick={() => setNoteOn((v) => !v)} class="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <StickyNote size={12} /> {noteOn() ? 'Remove note' : 'Add a note'}
      </button>
      <Show when={noteOn()}>
        <textarea class="textarea mt-1 text-sm" rows="2" placeholder="Saved with the container…" value={note()} onInput={(e) => setNote(e.currentTarget.value)} />
      </Show>
    </div>
  );

  // Track Concept: add the concept to its goal day (off the minute grid).
  async function trackConcept() {
    const tag = tagList()[0];
    const name = bwName().trim() || tag || 'Time Block';
    const durMin = Math.max(bwEst(), 15);
    const goal = bwGoal() || null;
    const start = isoAtMidnight(goal ?? localISODate()); // placeholder; rendered off the grid
    const end = new Date(Date.parse(start) + durMin * 60_000).toISOString();
    try {
      await api.blocks.create({
        title: name, block_kind: 'timeblock', block_type: 'someday', tag: tag || undefined,
        goal_start_date: goal, duration_minutes: durMin, all_day: true, note: noteOrNull(), start_at: start, end_at: end,
      });
      refetchConcepts(); refetchBlocks();
      showToast(`"${name}" saved for someday`, 'success');
      resetWizard();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // Make Plan: carry the concept into the Plan step (estimate → D/H/M, default start).
  function makePlan() {
    const m = Math.max(bwEst(), 15);
    setPD(Math.floor(m / 1440)); setPH(Math.floor((m % 1440) / 60)); setPM(m % 60);
    setBwStart(nextHalfHour());
    setStep('plan');
  }

  // Add Plan: schedule it on the chosen day/time with the D/H/M duration (multi-tag).
  async function addPlan() {
    const tags = tagList();
    const name = bwName().trim() || tags[0] || 'Time Block';
    const durMin = Math.max(pD() * 1440 + pH() * 60 + pM(), 15);
    const start = isoAt(bwGoal() || localISODate(), bwStart());
    const end = new Date(Date.parse(start) + durMin * 60_000).toISOString();
    try {
      await api.blocks.create({
        title: name, block_kind: 'timeblock', block_type: 'scheduled', tag: tags.join(',') || undefined,
        note: noteOrNull(), start_at: start, end_at: end,
      });
      if (saveTpl()) { await api.blockTemplates.create({ name, tag: tags[0], default_minutes: durMin }); refetchTemplates(); }
      refetchBlocks();
      showToast(`Time Block "${name}" added`, 'success');
      resetWizard();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function instantiate(t: BlockTemplate) {
    const start = isoAtToday(nextHalfHour());
    try {
      await api.blockTemplates.instantiate(t.id, start, new Date(Date.parse(start) + (t.default_minutes ?? 60) * 60_000).toISOString());
      refetchBlocks();
      showToast(`"${t.name}" dropped onto today`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  const TabBtn = (props: { t: Exclude<Tab, null>; icon: any; label: string }) => (
    <button
      onClick={() => select(props.t)}
      class="flex-1 inline-flex items-center justify-center gap-1.5 py-2 text-sm font-medium transition-colors"
      classList={{ 'text-primary': tab() === props.t, 'text-muted-foreground hover:text-foreground': tab() !== props.t }}
    >
      <props.icon size={15} /> {props.label}
    </button>
  );

  return (
    <div class="relative" classList={{ 'z-40': tab() !== null }}>
      {/* Dim + freeze the flight-plan above while a tab is open (cockpit-v2 Phase 3). */}
      <Show when={tab()}>
        <div class="absolute inset-x-0 bottom-full h-screen z-30 bg-black/80" onClick={() => setTab(null)} />
      </Show>
      {/* Always-present bar — Block / Routine / Open Task. */}
      <div class="relative z-40 rounded-xl border border-border bg-card overflow-hidden flex items-stretch">
        <TabBtn t="block" icon={Boxes} label="Block" />
        <div class="w-px bg-border" />
        <TabBtn t="pattern" icon={Triangle} label="Routine" />
        <div class="w-px bg-border" />
        <TabBtn t="task" icon={ListPlus} label="Open Task" />
        <Show when={tab()}>
          <div class="w-px bg-border" />
          <button onClick={() => setTab(null)} class="px-3 text-muted-foreground hover:text-foreground" title="Collapse">
            <ChevronDown size={16} />
          </button>
        </Show>
      </div>

      {/* Expanded content — opens UPWARD over the flight-plan, above the dim layer. */}
      <Show when={tab()}>
        <div class="absolute inset-x-0 bottom-full mb-2 z-40 rounded-xl border border-border bg-popover shadow-2xl max-h-[60vh] overflow-y-auto">
            {/* Search (task + pattern tabs) */}
            <Show when={tab() === 'task' || tab() === 'pattern'}>
              <div class="sticky top-0 bg-popover border-b border-border p-2 flex items-center gap-2">
                <Search size={14} class="text-muted-foreground flex-shrink-0" />
                <input
                  class="input py-1 text-sm"
                  placeholder={tab() === 'task' ? 'Search by name or #tag, or type a new task…' : 'Search routines…'}
                  value={query()} onInput={(e) => setQuery(e.currentTarget.value)}
                  onKeyDown={(e) => { if (tab() === 'task' && e.key === 'Enter' && query().trim()) createAndStage(query()); }}
                />
              </div>
            </Show>

            {/* Open-Task views (Open · TBD · Deferred · Past) + a "create" row. */}
            <Show when={tab() === 'task'}>
              <div class="flex items-center gap-1 px-2 py-1.5 border-b border-border text-[11px]">
                <For each={[['open', 'Open'], ['tbd', 'TBD'], ['deferred', 'Deferred'], ['past', 'Past']] as const}>
                  {([v, label]) => (
                    <button
                      onClick={() => setTaskView(v)}
                      class="px-2 py-0.5 rounded-full transition-colors"
                      classList={{ 'bg-primary/10 text-primary font-medium': taskView() === v, 'text-muted-foreground hover:text-foreground': taskView() !== v }}
                    >{label}</button>
                  )}
                </For>
              </div>
              <Show when={query().trim() && taskView() === 'open'}>
                <button onClick={() => createAndStage(query())} class="w-full flex items-center gap-2 px-3 py-2 text-left border-b border-border hover:bg-sidebar-accent transition-colors">
                  <Plus size={13} class="text-primary flex-shrink-0" />
                  <span class="flex-1 text-sm text-foreground truncate">Add new task: <span class="font-medium">“{query().trim()}”</span></span>
                </button>
              </Show>
              <Show when={viewTasks().length > 0} fallback={<p class="p-4 text-center text-sm text-muted-foreground">No {taskView()} tasks.</p>}>
                <ul class="divide-y divide-border">
                  <For each={viewTasks()}>
                    {(t) => (
                      <li class="flex items-center gap-2 px-3 py-2 hover:bg-sidebar-accent transition-colors">
                        <span class="flex-1 text-sm text-foreground truncate">{t.title}</span>
                        <For each={t.tags.slice(0, 2)}>{(tg) => <span class="badge-neutral text-[10px]">#{tg}</span>}</For>
                        <Show
                          when={taskView() === 'past'}
                          fallback={<button onClick={() => stageTask(t.id)} class="btn-icon flex-shrink-0" title="Add to flight-plan"><Plus size={14} class="text-primary" /></button>}
                        >
                          <button onClick={() => recall(t.id)} class="btn-secondary text-xs px-2 py-1 flex-shrink-0" title="Duplicate as a brand-new task"><RotateCcw size={12} /> Recall</button>
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Show>

          {/* Pattern Wizard — Routines first (the bundle), then Habits, then
              Time Blocks (saved Time Block templates from the Planner ★ menu). Rituals
              are hidden behind a feature flag (prefs.enable_rituals, default OFF). */}
          <Show when={tab() === 'pattern'}>
            <div class="p-2 space-y-2">
              <PatternCat typeName="Routine" title="Routines" desc="bundles of habits" />
              <PatternCat typeName="Habit" title="Habits" desc="repeating actions" />
              <PlanBlocksCat />
              <Show when={prefs()?.enable_rituals}>
                <PatternCat typeName="Ritual" title="Rituals" desc="occasion prep" />
              </Show>
              <p class="text-[11px] text-muted-foreground text-center pt-1">
                Create routines in <A href="/patterns" class="text-primary underline" onClick={() => setTab(null)}>Routines</A>.
              </p>
            </div>
          </Show>

          {/* Block Wizard — concept-first; Make Plan carries it into the scheduled step. */}
          <Show when={tab() === 'block'}>
            <div class="p-3 space-y-3">
              {/* Step trail */}
              <div class="flex items-center gap-2 text-[11px]">
                <span class="inline-flex items-center gap-1" classList={{ 'text-primary font-medium': step() === 'concept', 'text-muted-foreground': step() !== 'concept' }}>
                  <Pentagon size={12} /> Someday
                </span>
                <ChevronRight size={12} class="text-muted-foreground" />
                <span class="inline-flex items-center gap-1" classList={{ 'text-primary font-medium': step() === 'plan', 'text-muted-foreground': step() !== 'plan' }}>
                  <Star size={12} /> Scheduled
                </span>
              </div>

              {/* ── CONCEPT step ── */}
              <Show when={step() === 'concept'}>
                <div class="flex flex-wrap gap-1.5">
                  <For each={conceptTags()}>
                    {(ct) => (
                      <button type="button" onClick={() => pickConceptTag(ct)}
                        class="text-xs px-2 py-1 rounded-full border transition-colors"
                        classList={{ 'border-primary text-primary bg-primary/10': bwName() === ct.name, 'border-border text-muted-foreground hover:text-foreground': bwName() !== ct.name }}>
                        {ct.name} <span class="opacity-60">· {ct.minutes}m</span>
                      </button>
                    )}
                  </For>
                </div>

                <div class="grid grid-cols-2 gap-2">
                  <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Title</span>
                    <input class="input py-1 text-sm" value={bwName()} onInput={(e) => setBwName(e.currentTarget.value)} /></label>
                  <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Tag</span>
                    <input class="input py-1 text-sm" placeholder="#tag" value={bwTags()} onInput={(e) => setBwTags(e.currentTarget.value)} /></label>
                </div>

                {/* Goal day + Duration on one line — labels over the inputs. */}
                <div class="grid grid-cols-2 gap-2">
                  <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Goal day</span>
                    <input type="date" class="input py-1 text-sm" value={bwGoal()} onInput={(e) => setBwGoal(e.currentTarget.value)} /></label>
                  <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Est. duration (min)</span>
                    <input type="number" min="5" step="5" class="input py-1 text-sm" value={bwEst()} onInput={(e) => setBwEst(Number(e.currentTarget.value) || 0)} /></label>
                </div>

                <NoteToggle />

                <div class="flex gap-2">
                  <button onClick={trackConcept} class="btn-secondary text-xs px-3 py-1.5 flex-1 justify-center"><Pentagon size={13} /> Save for someday</button>
                  <button onClick={makePlan} class="btn-primary text-xs px-3 py-1.5 flex-1 justify-center"><Star size={13} /> Schedule</button>
                </div>
              </Show>

              {/* ── PLAN step ── prefilled from the concept; set a start time + confirm. */}
              <Show when={step() === 'plan'}>
                <div class="grid grid-cols-2 gap-2">
                  <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Title</span>
                    <input class="input py-1 text-sm" value={bwName()} onInput={(e) => setBwName(e.currentTarget.value)} /></label>
                  <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Tags (space-separated)</span>
                    <input class="input py-1 text-sm" placeholder="#work #focus" value={bwTags()} onInput={(e) => setBwTags(e.currentTarget.value)} /></label>
                </div>
                <div class="grid grid-cols-2 gap-2">
                  <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Day</span>
                    <input type="date" class="input py-1 text-sm" value={bwGoal()} onInput={(e) => setBwGoal(e.currentTarget.value)} /></label>
                  <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Start time</span>
                    <input type="time" class="input py-1 text-sm" value={bwStart()} onInput={(e) => setBwStart(e.currentTarget.value)} /></label>
                </div>
                <div>
                  <span class="text-[11px] text-muted-foreground">Duration</span>
                  <div class="flex gap-2 mt-1">
                    <label class="flex flex-col gap-0.5 flex-1"><input type="number" min="0" max="60" class="input py-1 text-sm" value={pD()} onInput={(e) => setPD(Number(e.currentTarget.value) || 0)} /><span class="text-[10px] text-muted-foreground text-center">days</span></label>
                    <label class="flex flex-col gap-0.5 flex-1"><input type="number" min="0" max="23" class="input py-1 text-sm" value={pH()} onInput={(e) => setPH(Number(e.currentTarget.value) || 0)} /><span class="text-[10px] text-muted-foreground text-center">hrs</span></label>
                    <label class="flex flex-col gap-0.5 flex-1"><input type="number" min="0" max="55" step="5" class="input py-1 text-sm" value={pM()} onInput={(e) => setPM(Number(e.currentTarget.value) || 0)} /><span class="text-[10px] text-muted-foreground text-center">min</span></label>
                  </div>
                </div>

                <NoteToggle />

                <label class="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                  <input type="checkbox" checked={saveTpl()} onChange={(e) => setSaveTpl(e.currentTarget.checked)} /> Save as reusable template
                </label>

                <div class="flex gap-2">
                  <button onClick={() => setStep('concept')} class="btn-ghost text-xs px-2.5 py-1.5"><ChevronRight size={12} class="rotate-180" /> Back</button>
                  <button onClick={resetWizard} class="btn-ghost text-xs px-2.5 py-1.5"><RotateCcw size={12} /> Reset</button>
                  <button onClick={addPlan} class="btn-primary text-xs px-3 py-1.5 flex-1 justify-center"><Plus size={13} /> Add Time Block</button>
                </div>

                <Show when={(templates() ?? []).length > 0}>
                  <div>
                    <div class="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Saved Time Block templates</div>
                    <div class="flex flex-wrap gap-1.5">
                      <For each={templates()}>
                        {(t) => (
                          <button onClick={() => instantiate(t)} class="btn-secondary text-xs px-2.5 py-1" title={`Drop ${t.name} onto today`}>
                            <Boxes size={12} /> {t.name}{t.tag ? ` · #${t.tag}` : ''}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}
