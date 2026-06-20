import { For, Show, createSignal, createMemo, createResource } from 'solid-js';
import { Plus, Triangle, ListPlus, Boxes, Search, ChevronDown, Clock, Star, Pentagon, CalendarClock } from 'lucide-solid';
import { A } from '@solidjs/router';
import { api, type BlockTemplate } from '../lib/api.js';
import {
  tasks, flightPlan, patterns, patternTypes, refetchTasks, refetchFlightPlan, refetchBlocks, refetchConcepts, showToast,
} from '../stores/index.js';
import { localISODate } from '../lib/dates.js';
import { ShapeIcon } from './ShapeIcon.js';

/**
 * The lower drawer (Phase G, G5). Floats above the cockpit and **never closes** —
 * its bar (`[+ Block] [+ Pattern] [+ Open Task]`) is always present; the panel
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

export function PlannerDrawer() {
  const [tab, setTab] = createSignal<Tab>(null);
  const [query, setQuery] = createSignal('');
  const select = (t: Exclude<Tab, null>) => { setQuery(''); setTab((cur) => (cur === t ? null : t)); };

  const stagedIds = createMemo(() => new Set((flightPlan() ?? []).map((i) => i.task_id)));

  // ── Open Task tab ────────────────────────────────────────────────────────────
  // Search open tasks by name OR tag (strip a leading '#'); empty query = all.
  const openTasks = () => {
    const q = query().trim().toLowerCase().replace(/^#/, '');
    return (tasks() ?? [])
      .filter((t) => t.status === 'open' && !t.parent_id && !t.is_fast_task && !stagedIds().has(t.id))
      .filter((t) => !q || t.title.toLowerCase().includes(q) || (t.tags ?? []).some((tag) => tag.toLowerCase().includes(q)))
      .slice(0, 50);
  };
  async function stageTask(id: number) {
    try { await api.flightPlan.addTask(id); refetchFlightPlan(); showToast('Added to flight-plan', 'default'); }
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

  // ── Pattern tab ──────────────────────────────────────────────────────────────
  const typeOf = createMemo(() => {
    const m = new Map<number, string>();
    for (const t of patternTypes() ?? []) m.set(t.id, t.icon_shape);
    return m;
  });
  const shownPatterns = () => {
    const q = query().toLowerCase();
    return (patterns() ?? []).filter((p) => !q || p.name.toLowerCase().includes(q) || (p.tag ?? '').toLowerCase().includes(q));
  };
  async function stagePattern(id: number, name: string) {
    try {
      const r = await api.flightPlan.addPattern(id);
      refetchFlightPlan();
      showToast(`Staged ${r.added} task${r.added === 1 ? '' : 's'} from ${name}`, 'default');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // ── Block tab ────────────────────────────────────────────────────────────────
  const [templates, { refetch: refetchTemplates }] = createResource(
    () => (tab() === 'block' ? 'block' : null),
    () => api.blockTemplates.list().then((r) => r.block_templates),
  );
  const [blockMode, setBlockMode] = createSignal<'plan' | 'concept'>('plan');
  const [blkName, setBlkName] = createSignal('');
  const [blkTag, setBlkTag] = createSignal('');
  const [blkStart, setBlkStart] = createSignal(nextHalfHour());
  const [blkMin, setBlkMin] = createSignal(60);
  const [saveTpl, setSaveTpl] = createSignal(false);
  // Concept form: a goal day (optional) + a Days/Hours/Minutes duration.
  const [cGoal, setCGoal] = createSignal(localISODate());
  const [cDays, setCDays] = createSignal(0);
  const [cHrs, setCHrs] = createSignal(1);
  const [cMins, setCMins] = createSignal(0);

  function resetBlockForm() { setBlkName(''); setBlkTag(''); }

  // Create a scheduled Plan container on the timed grid.
  async function createBlock() {
    const tag = blkTag().trim().replace(/^#/, '');
    const name = blkName().trim() || tag || 'Time-Block';
    const start = isoAtToday(blkStart());
    const end = new Date(Date.parse(start) + blkMin() * 60_000).toISOString();
    try {
      await api.blocks.create({ title: name, block_kind: 'timeblock', block_type: 'plan', tag: tag || undefined, start_at: start, end_at: end });
      if (saveTpl()) { await api.blockTemplates.create({ name, tag: tag || undefined, default_minutes: blkMin() }); refetchTemplates(); }
      refetchBlocks();
      showToast(`Plan "${name}" added`, 'success');
      resetBlockForm();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // Create an unscheduled Concept (off-grid: goal day + duration, stored all-day).
  async function createConcept() {
    const tag = blkTag().trim().replace(/^#/, '');
    const name = blkName().trim() || tag || 'Concept';
    const durMin = Math.max(cDays() * 1440 + cHrs() * 60 + cMins(), 15);
    const goal = cGoal() || null;
    const start = isoAtMidnight(goal ?? localISODate()); // placeholder; the client renders off the grid
    const end = new Date(Date.parse(start) + durMin * 60_000).toISOString();
    try {
      await api.blocks.create({
        title: name, block_kind: 'timeblock', block_type: 'concept', tag: tag || undefined,
        goal_start_date: goal, duration_minutes: durMin, all_day: true, start_at: start, end_at: end,
      });
      refetchConcepts(); refetchBlocks();
      showToast(`Concept "${name}" added`, 'success');
      resetBlockForm();
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
    <>
      {/* Darkened backdrop — focus mode when a tab is open; click to dismiss. */}
      <Show when={tab()}>
        <div class="fixed inset-0 z-30 bg-black/50 backdrop-blur-sm" onClick={() => setTab(null)} />
      </Show>

      {/* The drawer: fixed flush above the bottom nav, clearing the desktop rail. */}
      <div class="fixed inset-x-0 bottom-14 md:bottom-0 md:left-52 z-40" style={{ 'padding-bottom': 'env(safe-area-inset-bottom)' }}>
        {/* Expanding sheet (above the always-present bar) */}
        <Show when={tab()}>
          <div class="rounded-t-xl border border-b-0 border-border bg-popover shadow-2xl max-h-[70vh] overflow-y-auto">
            {/* Search (task + pattern tabs) */}
            <Show when={tab() === 'task' || tab() === 'pattern'}>
              <div class="sticky top-0 bg-popover border-b border-border p-2 flex items-center gap-2">
                <Search size={14} class="text-muted-foreground flex-shrink-0" />
                <input
                  class="input py-1 text-sm"
                  placeholder={tab() === 'task' ? 'Search by name or #tag, or type a new task…' : 'Search patterns…'}
                  value={query()} onInput={(e) => setQuery(e.currentTarget.value)}
                  onKeyDown={(e) => { if (tab() === 'task' && e.key === 'Enter' && query().trim()) createAndStage(query()); }}
                />
              </div>
            </Show>

            {/* Open Task list — plus a "create new task" row from the typed text. */}
            <Show when={tab() === 'task'}>
              <Show when={query().trim()}>
                <button onClick={() => createAndStage(query())} class="w-full flex items-center gap-2 px-3 py-2 text-left border-b border-border hover:bg-sidebar-accent transition-colors">
                  <Plus size={13} class="text-primary flex-shrink-0" />
                  <span class="flex-1 text-sm text-foreground truncate">Add new task: <span class="font-medium">“{query().trim()}”</span></span>
                </button>
              </Show>
              <Show when={openTasks().length > 0} fallback={<Show when={!query().trim()}><p class="p-4 text-center text-sm text-muted-foreground">No open tasks to stage.</p></Show>}>
                <ul class="divide-y divide-border">
                  <For each={openTasks()}>
                    {(t) => (
                      <li>
                        <button onClick={() => stageTask(t.id)} class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-sidebar-accent transition-colors">
                          <Plus size={13} class="text-primary flex-shrink-0" />
                          <span class="flex-1 text-sm text-foreground truncate">{t.title}</span>
                          <For each={t.tags.slice(0, 2)}>{(tg) => <span class="badge-neutral text-[10px]">#{tg}</span>}</For>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>
            </Show>

          {/* Pattern list */}
          <Show when={tab() === 'pattern'}>
            <Show when={shownPatterns().length > 0} fallback={
              <div class="p-4 text-center text-sm text-muted-foreground">
                No patterns yet. <A href="/settings" class="text-primary underline" onClick={() => setTab(null)}>Create one in Settings</A>.
              </div>
            }>
              <ul class="divide-y divide-border">
                <For each={shownPatterns()}>
                  {(p) => (
                    <li>
                      <button onClick={() => stagePattern(p.id, p.name)} class="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-sidebar-accent transition-colors">
                        <ShapeIcon shape={p.type_id != null ? (typeOf().get(p.type_id) ?? 'square') : 'square'} />
                        <span class="flex-1 text-sm text-foreground truncate">{p.name}</span>
                        <Show when={p.tag}>{(t) => <span class="text-primary text-xs">#{t()}</span>}</Show>
                        <span class="text-[11px] text-muted-foreground">{p.task_ids.length} task{p.task_ids.length === 1 ? '' : 's'}</span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </Show>

          {/* Block creator — Plan (scheduled) | Concept (goal) */}
          <Show when={tab() === 'block'}>
            <div class="p-3 space-y-3">
              {/* Plan | Concept mode */}
              <div class="flex rounded-md border border-border overflow-hidden text-xs">
                <button onClick={() => setBlockMode('plan')} class="flex-1 inline-flex items-center justify-center gap-1 py-1.5"
                  classList={{ 'bg-primary/15 text-primary': blockMode() === 'plan', 'text-muted-foreground': blockMode() !== 'plan' }}>
                  <Star size={12} /> Plan
                </button>
                <button onClick={() => setBlockMode('concept')} class="flex-1 inline-flex items-center justify-center gap-1 py-1.5 border-l border-border"
                  classList={{ 'bg-primary/15 text-primary': blockMode() === 'concept', 'text-muted-foreground': blockMode() !== 'concept' }}>
                  <Pentagon size={12} /> Concept
                </button>
              </div>

              {/* Shared name + tag */}
              <div class="grid grid-cols-2 gap-2">
                <input class="input py-1 text-sm" placeholder="Name (defaults to tag)" value={blkName()} onInput={(e) => setBlkName(e.currentTarget.value)} />
                <input class="input py-1 text-sm" placeholder="#tag" value={blkTag()} onInput={(e) => setBlkTag(e.currentTarget.value)} />
              </div>

              {/* Plan: time + duration + reusable templates */}
              <Show when={blockMode() === 'plan'}>
                <div class="grid grid-cols-2 gap-2">
                  <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Clock size={13} /> Start
                    <input type="time" class="input py-1 text-sm" value={blkStart()} onInput={(e) => setBlkStart(e.currentTarget.value)} />
                  </label>
                  <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
                    Mins
                    <input type="number" min="15" step="15" class="input py-1 text-sm" value={blkMin()} onInput={(e) => setBlkMin(Number(e.currentTarget.value) || 60)} />
                  </label>
                </div>
                <div class="flex items-center justify-between">
                  <label class="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer">
                    <input type="checkbox" checked={saveTpl()} onChange={(e) => setSaveTpl(e.currentTarget.checked)} /> Save as reusable template
                  </label>
                  <button onClick={createBlock} class="btn-primary text-xs px-3 py-1.5"><Plus size={13} /> Add Plan</button>
                </div>
                <Show when={(templates() ?? []).length > 0}>
                  <div>
                    <div class="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Reusable blocks</div>
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

              {/* Concept: optional goal day + D/H/M duration (no fixed time) */}
              <Show when={blockMode() === 'concept'}>
                <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <CalendarClock size={13} /> Goal day
                  <input type="date" class="input py-1 text-sm" value={cGoal()} onInput={(e) => setCGoal(e.currentTarget.value)} />
                  <button type="button" class="btn-ghost text-[11px] px-1.5 py-0.5" onClick={() => setCGoal('')} title="Someday (no date)">clear</button>
                </label>
                <div>
                  <span class="text-[11px] text-muted-foreground">Duration</span>
                  <div class="flex gap-2 mt-1">
                    <label class="flex flex-col gap-0.5 flex-1">
                      <input type="number" min="0" max="60" class="input py-1 text-sm" value={cDays()} onInput={(e) => setCDays(Number(e.currentTarget.value) || 0)} />
                      <span class="text-[10px] text-muted-foreground text-center">days</span>
                    </label>
                    <label class="flex flex-col gap-0.5 flex-1">
                      <input type="number" min="0" max="23" class="input py-1 text-sm" value={cHrs()} onInput={(e) => setCHrs(Number(e.currentTarget.value) || 0)} />
                      <span class="text-[10px] text-muted-foreground text-center">hrs</span>
                    </label>
                    <label class="flex flex-col gap-0.5 flex-1">
                      <input type="number" min="0" max="55" step="5" class="input py-1 text-sm" value={cMins()} onInput={(e) => setCMins(Number(e.currentTarget.value) || 0)} />
                      <span class="text-[10px] text-muted-foreground text-center">min</span>
                    </label>
                  </div>
                </div>
                <button onClick={createConcept} class="btn-primary text-xs px-3 py-1.5 w-full justify-center"><Plus size={13} /> Add Concept</button>
              </Show>
            </div>
          </Show>
        </div>
      </Show>

      {/* The always-present bar (never closes) */}
      <div class="border border-border bg-card shadow-lg flex items-stretch"
        classList={{ 'rounded-xl': !tab(), 'rounded-b-xl': !!tab() }}>
        <TabBtn t="block" icon={Boxes} label="Block" />
        <div class="w-px bg-border" />
        <TabBtn t="pattern" icon={Triangle} label="Pattern" />
        <div class="w-px bg-border" />
        <TabBtn t="task" icon={ListPlus} label="Open Task" />
        <Show when={tab()}>
          <div class="w-px bg-border" />
          <button onClick={() => setTab(null)} class="px-3 text-muted-foreground hover:text-foreground" title="Collapse drawer">
            <ChevronDown size={16} />
          </button>
        </Show>
      </div>
      </div>
    </>
  );
}
