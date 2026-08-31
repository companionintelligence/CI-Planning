import { Show, For, Switch, Match, createSignal, createEffect, createResource, on, onCleanup } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { FlightPlan } from './FlightPlan.js';
import { X, PanelRight, Inbox, Pencil, Sparkles, Check, ChevronDown, ChevronRight, Rocket } from 'lucide-solid';
import {
  detailsOpen, detailsWidth, setDetailsOpen, setDetailsWidth,
  drawerTab, setDrawerTab, DETAILS_MIN_W, DETAILS_MAX_W, DETAILS_DEFAULT_W,
} from '../stores/ui.js';
import { activeTask, activeBlock, activeEntity, clearActiveEntity, setActiveTask, setActiveBlock, setActiveEntity, type ActiveEntity } from '../stores/selection.js';
import {
  blocks, tasks, taskOf, tags, objectives, suggestions, refetchSuggestions,
  isSuggestionBusy, setSuggestionBusy, connections, showToast, refetchTasks, setElementModal,
} from '../stores/index.js';
import { api, type Task, type Block, type Tag, type Person, type PossibleTask, type Objective } from '../lib/api.js';
import { displayTag } from '../lib/tag-tax.js';
import { LockToggle } from './LockToggle.js';
import { lockAffordance } from '../lib/lock.js';
import { PriorityToggle, DateField } from './TaskCard.js';
import { flattenObjectives } from '../lib/objectives.js';
import { describeRule } from '../lib/recurrence.js';
import { rangeUTC } from '../lib/dates.js';
import {
  windowFor, inWindow, targetForWindow, groupByTitle, minutesBetween, hoursLabel,
  type RollupPeriod, type TitleGroup,
} from '../lib/dimension-rollup.js';

const PRIORITY_NAME: Record<number, string> = { 1: 'High', 2: 'Medium', 3: 'Low' };

function fmtClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * One label/value row, shown only when `when` is truthy — so an absent estimate
 * drops the row instead of rendering a bare unit.
 *
 * `when` is required rather than defaulting to the children: JSX children are always
 * a truthy array, so `props.when ?? props.children` silently renders every optional
 * field. Rows that should always appear pass `when={true}` and supply their own
 * "Unscheduled" / "No due date" fallback.
 */
function Field(props: { label: string; children?: any; when: unknown }) {
  return (
    <Show when={props.when}>
      <dt class="drawer-dt">{props.label}</dt>
      <dd class="drawer-dd">{props.children}</dd>
    </Show>
  );
}

function Group(props: { label: string; children?: any }) {
  return (
    <div>
      <div class="drawer-group">{props.label}</div>
      {props.children}
    </div>
  );
}

function TaskPanel(props: { task: () => Task }) {
  const t = () => props.task();
  const blocked = () => t().status === 'blocked' || !!t().blocked;
  const tagList = () => [
    ...((t().tags ?? []) as string[]).map((n) => ({ name: n, secondary: false })),
    ...((t().secondary_tags ?? []) as string[]).map((n) => ({ name: n, secondary: true })),
  ];

  // D4 — same on-demand memory enrichment as TaskCard/PlannerEntityCard; only fills
  // blanks server-side, never rewrites a description or direction the user already chose.
  const [enriching, setEnriching] = createSignal(false);
  async function enrich() {
    setEnriching(true);
    try {
      const r = await api.tasks.enrich(t().id);
      if (r.enriched) {
        const bits = [
          r.description && 'description',
          r.direction && `direction (${r.direction})`,
          r.categories?.length && `categories (${r.categories.join(', ')})`,
        ].filter(Boolean);
        showToast(`Filled in ${bits.join(' + ')}`, 'success');
        refetchTasks();
      } else {
        showToast(r.reason ?? 'Nothing to add', 'default');
      }
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setEnriching(false); }
  }
  function edit() {
    setElementModal({ open: true, mode: 'edit', kind: t().is_habit ? 'habit' : 'task', editTarget: { kind: t().is_habit ? 'habit' : 'task', id: t().id } });
  }

  // Scalar fields (title/priority/dates/estimate/notes) edit inline, right here.
  // Anything relational — tags/direction, people, categories, recurrence, routine
  // membership — still routes through Edit → the wizard, which already has the
  // pickers for those; duplicating them here would be a second place to keep in sync.
  async function patch(body: Parameters<typeof api.tasks.update>[1]) {
    try { await api.tasks.update(t().id, body); refetchTasks(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  const [editingTitle, setEditingTitle] = createSignal(false);
  const [titleDraft, setTitleDraft] = createSignal('');
  function startTitle() { setTitleDraft(t().title); setEditingTitle(true); }
  function commitTitle() {
    setEditingTitle(false);
    const v = titleDraft().trim();
    if (v && v !== t().title) patch({ title: v });
  }

  const [editingEstimate, setEditingEstimate] = createSignal(false);
  const [estimateDraft, setEstimateDraft] = createSignal('');
  function startEstimate() { setEstimateDraft(String(t().estimated_minutes ?? '')); setEditingEstimate(true); }
  function commitEstimate() {
    setEditingEstimate(false);
    const n = Math.round(Number(estimateDraft()));
    if (Number.isFinite(n) && n > 0 && n !== t().estimated_minutes) patch({ estimated_minutes: n });
  }

  const [editingNotes, setEditingNotes] = createSignal(false);
  const [notesDraft, setNotesDraft] = createSignal('');
  function startNotes() { setNotesDraft(t().notes ?? t().description ?? ''); setEditingNotes(true); }
  function commitNotes() {
    setEditingNotes(false);
    const v = notesDraft().trim();
    // Matches the wizard's own note field: omitting on empty (rather than sending an
    // explicit clear) means an emptied note doesn't erase an existing one server-side —
    // same partial-PATCH contract saveElement already relies on.
    if (v !== (t().notes ?? t().description ?? '')) patch({ notes: v || undefined });
  }

  // Priority / dates: confirm-then-write, matching TaskCard's inline edits (T-TASKS-2).
  function setPriority(v: number) {
    if (v === t().priority) return;
    if (!confirm(`Change priority to ${PRIORITY_NAME[v] ?? `P${v}`}?`)) return;
    patch({ priority: v });
  }
  function setDue(v: string) {
    if (!confirm(v ? `Set the due date to ${v}?` : 'Clear the due date?')) return;
    patch({ due_at: v || null });
  }
  function setScheduled(v: string) {
    if (!confirm(v ? `Set the start date to ${v}?` : 'Clear the start date? This unschedules the task.')) return;
    patch({ scheduled_for: v || null });
  }
  function setDefer(v: string) {
    if (!confirm(v ? `Defer this task until ${v}?` : 'Clear the deferred-until date?')) return;
    // defer_until stores a full ISO instant (unlike due_at/scheduled_for) — same
    // midnight-local conversion saveElement uses for it.
    patch({ defer_until: v ? new Date(v + 'T00:00:00').toISOString() : null });
  }

  // Read-only relational facts, resolved from stores already loaded app-wide.
  const objectiveNames = () => {
    const ids = t().objective_ids?.length ? t().objective_ids! : t().objective_id ? [t().objective_id!] : [];
    if (!ids.length) return [];
    const flat = flattenObjectives(objectives() ?? []);
    return ids.map((id) => flat.find((o) => o.id === id)?.title).filter((x): x is string => !!x);
  };
  const dependsOnTasks = () => (t().depends_on ?? []).map((id) => taskOf(id)).filter((x): x is Task => !!x);
  const parentTask = () => (t().parent_id ? taskOf(t().parent_id) : undefined);
  const recurringParent = () => (t().recurrence_parent_id ? taskOf(t().recurrence_parent_id) : undefined);

  return (
    <>
      <div class="drawer-body">
        <div class="flex items-center justify-between gap-2">
          <div class="flex gap-1.5 flex-wrap">
            <span class="drawer-pill" data-status={blocked() ? 'blocked' : t().status}>
              {blocked() ? 'Blocked' : t().status}
            </span>
            <Show when={t().subtype === 'habit' || t().is_habit}><span class="drawer-pill">Habit</span></Show>
            <Show when={t().is_fast_task}><span class="drawer-pill">Fast task</span></Show>
          </div>
          <div class="flex gap-1 flex-shrink-0">
            <button onClick={enrich} disabled={enriching()} class="btn-icon" title="Fill in details from memory">
              <Sparkles size={13} classList={{ 'animate-pulse': enriching() }} />
            </button>
            <button onClick={edit} class="btn-icon" title="Edit tags, people, recurrence & more"><Pencil size={13} /></button>
          </div>
        </div>

        {/* Title — the header above still shows it read-only for orientation while the
            drawer is scrolled past this row. */}
        <Show
          when={editingTitle()}
          fallback={
            <button type="button" class="text-left text-sm font-medium text-foreground hover:text-primary transition-colors" onClick={startTitle} title="Edit title">
              {t().title}
            </button>
          }
        >
          <input
            class="w-full bg-transparent border border-border rounded px-1.5 py-1 text-sm outline-none focus:border-primary"
            value={titleDraft()}
            autofocus
            onInput={(e) => setTitleDraft(e.currentTarget.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => { if (e.key === 'Enter') commitTitle(); if (e.key === 'Escape') setEditingTitle(false); }}
          />
        </Show>

        <Group label="Planning">
          <dl class="drawer-grid">
            <Field label="Priority" when={true}>
              <PriorityToggle value={t().priority} onPick={setPriority} />
            </Field>
            <Field label="Estimate" when={true}>
              <Show
                when={editingEstimate()}
                fallback={
                  <button type="button" class="hover:text-primary transition-colors" onClick={startEstimate}>
                    {t().estimated_minutes ? `${t().estimated_minutes}m` : <span class="text-muted-foreground">Not estimated</span>}
                    <Show when={t().actual_minutes}>
                      <span class="text-muted-foreground"> · {t().actual_minutes}m logged</span>
                    </Show>
                  </button>
                }
              >
                <input
                  type="number" min="1" step="5"
                  class="w-16 bg-transparent border border-border rounded px-1.5 py-0.5 text-sm outline-none focus:border-primary"
                  value={estimateDraft()}
                  autofocus
                  onInput={(e) => setEstimateDraft(e.currentTarget.value)}
                  onBlur={commitEstimate}
                  onKeyDown={(e) => { if (e.key === 'Enter') commitEstimate(); if (e.key === 'Escape') setEditingEstimate(false); }}
                /> m
              </Show>
            </Field>
            <Field label="Dates" when={true}>
              <div class="flex flex-wrap gap-1.5">
                <DateField label="Due" value={t().due_at} onSet={setDue} />
                <DateField label="Start" value={t().scheduled_for} onSet={setScheduled} />
                <DateField label="Defer" value={t().defer_until} onSet={setDefer} />
              </div>
              <Show when={t().task_time}>
                <div class="text-muted-foreground mt-1">at {t().task_time}</div>
              </Show>
            </Field>
          </dl>
        </Group>

        <Group label="Tags">
          <Show
            when={tagList().length > 0}
            fallback={<span class="text-xs text-muted-foreground">No tags</span>}
          >
            <div class="flex flex-wrap gap-1.5">
              <For each={tagList()}>
                {(tag) => <span class="drawer-tag" classList={{ 'drawer-tag-secondary': tag.secondary }}>{tag.name}</span>}
              </For>
            </div>
          </Show>
        </Group>

        <Show when={(t().categories ?? []).length > 0}>
          <Group label="Categories">
            <div class="flex flex-wrap gap-1.5">
              <For each={t().categories}>{(c) => <span class="drawer-tag">{c}</span>}</For>
            </div>
          </Group>
        </Show>

        <Group label="Notes">
          <Show
            when={editingNotes()}
            fallback={
              <button type="button" class="text-left w-full" onClick={startNotes} title="Edit notes">
                <Show when={t().notes || t().description} fallback={<span class="text-xs text-muted-foreground">No notes — click to add</span>}>
                  <p class="drawer-note hover:text-primary transition-colors">{t().notes ?? t().description}</p>
                </Show>
              </button>
            }
          >
            <textarea
              class="w-full bg-transparent border border-border rounded px-1.5 py-1 text-sm outline-none focus:border-primary resize-y min-h-[4.5rem]"
              value={notesDraft()}
              autofocus
              onInput={(e) => setNotesDraft(e.currentTarget.value)}
              onBlur={commitNotes}
              onKeyDown={(e) => { if (e.key === 'Escape') setEditingNotes(false); }}
            />
          </Show>
        </Group>

        {/* People on work (0151) — read-only here; the wizard is where they are edited.
            Rendered ABOVE Context because "who" is a first-class fact about the task,
            not provenance metadata. `motivation` stays in Context: it is now DERIVED
            from the beneficiary set, so showing both is showing the working. */}
        <Show when={(t().responsible ?? []).length > 0 || (t().beneficiaries ?? []).length > 0}>
          <Group label="People">
            <div class="flex flex-col gap-1.5">
              <PeopleRow label="Responsible" people={t().responsible ?? []} />
              <PeopleRow label="Beneficiaries" people={t().beneficiaries ?? []} />
            </div>
          </Group>
        </Show>

        <Show when={dependsOnTasks().length > 0}>
          <Group label="Depends on">
            <div class="flex flex-col gap-1 items-start">
              <For each={dependsOnTasks()}>
                {(dep) => (
                  <button type="button" class="drawer-tag text-left cursor-pointer hover:border-ring" onClick={() => setActiveTask(dep.id)}>
                    {dep.title}
                  </button>
                )}
              </For>
            </div>
          </Group>
        </Show>

        <Show when={parentTask() || recurringParent() || t().recurrence_rule}>
          <Group label="Relationships">
            <dl class="drawer-grid">
              <Field label="Subtask of" when={parentTask()}>
                <button type="button" class="drawer-tag text-left cursor-pointer hover:border-ring" onClick={() => setActiveTask(parentTask()!.id)}>
                  {parentTask()!.title}
                </button>
              </Field>
              <Field label="Recurring" when={t().recurrence_rule}>{describeRule(t().recurrence_rule!)}</Field>
              <Field label="Instance of" when={recurringParent()}>
                <button type="button" class="drawer-tag text-left cursor-pointer hover:border-ring" onClick={() => setActiveTask(recurringParent()!.id)}>
                  {recurringParent()!.title}
                </button>
                <Show when={t().occurrence_date}><span class="text-muted-foreground"> · {t().occurrence_date}</span></Show>
              </Field>
            </dl>
          </Group>
        </Show>

        <Show when={objectiveNames().length > 0}>
          <Group label="Objective">
            <div class="flex flex-wrap gap-1.5">
              <For each={objectiveNames()}>{(name) => <span class="drawer-tag">{name}</span>}</For>
            </div>
          </Group>
        </Show>

        {/* A DECLINED (0) is not a reflection — it records that the sheet was dismissed,
            so it must not render as "0 out of 5". Only a real 1-5 rating shows. */}
        <Show when={(t().completion_score ?? 0) > 0 || t().completion_note}>
          <Group label="Reflection">
            <dl class="drawer-grid">
              <Field label="Rating" when={(t().completion_score ?? 0) > 0}>{t().completion_score} / 5</Field>
              <Field label="Note" when={t().completion_note}>{t().completion_note}</Field>
            </dl>
          </Group>
        </Show>

        <Show when={t().motivation || t().source_kind}>
          <Group label="Context">
            <dl class="drawer-grid">
              <Field label="Motivation" when={t().motivation}>
                {t().motivation}
                <Show when={t().motivation_source === 'llm'}><span class="text-muted-foreground"> · detected</span></Show>
              </Field>
              <Field label="Source" when={t().source_kind}>{t().source_kind}</Field>
              <Field label="Created" when={t().created_at}>{fmtDate(t().created_at)}</Field>
              <Field label="Completed" when={t().completed_at}>{fmtDate(t().completed_at!)}</Field>
            </dl>
          </Group>
        </Show>
      </div>
    </>
  );
}

/** One people set as chips. Renders nothing when empty, so an item with only one of
 *  the two sets doesn't show a stray empty label. */
function PeopleRow(props: { label: string; people: Person[] }) {
  return (
    <Show when={props.people.length > 0}>
      <div class="flex items-baseline gap-2">
        <span class="text-[10px] uppercase tracking-wider text-muted-foreground flex-shrink-0">{props.label}</span>
        <div class="flex flex-wrap gap-1">
          <For each={props.people}>
            {(p) => <span class="drawer-tag">{p.display_name}</span>}
          </For>
        </div>
      </div>
    </Show>
  );
}

function BlockPanel(props: { block: Block }) {
  const b = () => props.block;
  const linked = () => (b().task_id ? taskOf(b().task_id!) : undefined);
  const minutes = () => {
    const s = new Date(b().start_at).getTime();
    const e = new Date(b().end_at).getTime();
    return Number.isFinite(s) && Number.isFinite(e) ? Math.round((e - s) / 60000) : 0;
  };

  return (
    <div class="drawer-body">
      <div><span class="drawer-pill" data-status="scheduled">Scheduled</span></div>
      <Group label="When">
        <dl class="drawer-grid">
          <Field label="Start" when={true}>{fmtClock(b().start_at)}</Field>
          <Field label="End" when={true}>{fmtClock(b().end_at)}</Field>
          <Field label="Duration" when={true}>{minutes()}m</Field>
        </dl>
      </Group>
      <Show when={linked()}>
        {(task) => (
          <Group label="Linked task">
            <button
              type="button"
              class="drawer-tag text-left cursor-pointer hover:border-ring"
              onClick={() => setActiveTask(task().id)}
            >{task().title}</button>
          </Group>
        )}
      </Show>
      {/* People on work (0151). A meeting block with attendees is the headline case for
          the whole feature, so omitting it here left the only view of a block's people
          inside the wizard. The sets shown are the EFFECTIVE ones — the block's own,
          else inherited from its task. */}
      <Show when={(b().responsible ?? []).length > 0 || (b().beneficiaries ?? []).length > 0}>
        <Group label="People">
          <div class="flex flex-col gap-1.5">
            <PeopleRow label="Responsible" people={b().responsible ?? []} />
            <PeopleRow label="Beneficiaries" people={b().beneficiaries ?? []} />
          </div>
        </Group>
      </Show>
      {/* Phase 1 — lock state is universal: every scheduled item shows it here, and
          the owner's own blocks toggle it. A synced event shows its source instead
          of a control (decision 1). */}
      <Group label={lockAffordance(b()) === 'source' ? 'Source' : 'Mobility'}>
        <LockToggle block={b()} />
      </Group>
    </div>
  );
}


function TagPanel(props: { tag: Tag }) {
  const t = () => props.tag;
  const tagged = () => (tasks() ?? []).filter(
    (x) => (x.tags ?? []).includes(t().name) || (x.secondary_tags ?? []).includes(t().name),
  );
  return (
    <div class="drawer-body">
      <div class="flex gap-1.5 flex-wrap">
        <span class="drawer-pill">{t().kind}</span>
        <Show when={t().muted}><span class="drawer-pill">Muted</span></Show>
        <Show when={t().is_base}><span class="drawer-pill">Base</span></Show>
      </div>
      <Group label="Usage">
        <dl class="drawer-grid">
          <Field label="Tasks" when={true}>{t().count}</Field>
          <Field label="Directions" when={true}>
            {t().directions.length ? t().directions.map(displayTag).join(' · ') : <span class="text-muted-foreground">Unsorted</span>}
          </Field>
          <Field label="Deletable" when={true}>{t().used ? 'No — in use' : 'Yes'}</Field>
        </dl>
      </Group>
      <Show when={tagged().length > 0}>
        <Group label="Tagged here">
          <div class="flex flex-col gap-1">
            <For each={tagged().slice(0, 8)}>
              {(x) => (
                <button type="button" class="drawer-tag text-left cursor-pointer hover:border-ring" onClick={() => setActiveTask(x.id)}>
                  {x.title}
                </button>
              )}
            </For>
          </div>
        </Group>
      </Show>
    </div>
  );
}

/** Direction and Time-Block-Category groups share one shape: name + member tags. */
function GroupPanel(props: { tag: Tag }) {
  const g = () => props.tag;
  const members = () => (tags() ?? []).filter((x) =>
    x.kind === 'intention' &&
    (g().kind === 'direction' ? x.directions.includes(g().name) : (x.categories ?? []).includes(g().name)),
  );
  return (
    <div class="drawer-body">
      <div class="flex gap-1.5 flex-wrap">
        <span class="drawer-pill">{g().is_base ? 'Base' : 'Custom'}</span>
        <Show when={g().kind === 'category' && (g().direction_optouts ?? []).length > 0}>
          <span class="drawer-pill">{(g().direction_optouts ?? []).length} direction(s) off</span>
        </Show>
      </div>
      <Group label={g().kind === 'direction' ? 'Tags in this direction' : 'Tags in this category'}>
        <Show when={members().length > 0} fallback={<span class="text-xs text-muted-foreground">No member tags.</span>}>
          <div class="flex flex-wrap gap-1.5">
            <For each={members()}>
              {(x) => (
                <button type="button" class="drawer-tag cursor-pointer hover:border-ring" onClick={() => setActiveEntity('tag', x.id)}>
                  {displayTag(x.name)}
                </button>
              )}
            </For>
          </div>
        </Show>
      </Group>
    </div>
  );
}

function DayPanel(props: { date: string }) {
  const [resolved] = createResource(() => props.date, (d) => api.dayTypes.resolve(d).catch(() => null));
  const [windows] = createResource(
    () => resolved()?.key ?? null,
    (key) => api.patternBlocks.forDay(key).then((r) => r.windows).catch(() => ({})),
  );
  const directionName = (tagId: string) =>
    (tags() ?? []).find((t) => t.id === tagId)?.name ?? 'unknown';
  const rows = () => Object.entries(windows() ?? {}).map(([tagId, ranges]) => ({
    name: displayTag(directionName(tagId)),
    n: (ranges as unknown[]).length,
  }));
  return (
    <div class="drawer-body">
      <div><span class="drawer-pill" data-status="open">{resolved()?.key ?? '…'}</span></div>
      <Group label="Day type">
        <dl class="drawer-grid">
          <Field label="Type" when={true}>{resolved()?.key ?? '…'}</Field>
          <Field label="Source" when={resolved()?.source}>{resolved()?.source}</Field>
        </dl>
      </Group>
      <Group label="Windows">
        <Show when={rows().length > 0} fallback={<span class="text-xs text-muted-foreground">No placement windows configured.</span>}>
          <dl class="drawer-grid">
            <For each={rows()}>
              {(r) => <Field label={r.name} when={true}>{r.n} window{r.n === 1 ? '' : 's'}</Field>}
            </For>
          </dl>
        </Show>
      </Group>
    </div>
  );
}

function JobPanel(props: { id: string }) {
  const [jobsRes, { refetch }] = createResource(() => api.jobs.list().then((r) => r.jobs).catch(() => []));
  const job = () => (jobsRes() ?? []).find((j: { id: string }) => j.id === props.id) as
    | { id: string; name: string; cron: string; enabled: boolean; last_status?: string | null; last_started?: string | null; items_created?: number; items_updated?: number }
    | undefined;
  const [running, setRunning] = createSignal(false);
  async function runNow() {
    const j = job(); if (!j || running()) return;
    setRunning(true);
    try { await api.jobs.run(j.id); showToast(`Triggered ${j.name}`, 'success'); setTimeout(refetch, 1500); }
    catch (err) { showToast((err as Error).message, 'error'); }
    finally { setRunning(false); }
  }
  return (
    <Show when={job()} fallback={<div class="drawer-body"><span class="text-xs text-muted-foreground">Job not found (operator account required).</span></div>}>
      {(j) => (
        <div class="drawer-body">
          <div class="flex gap-1.5 flex-wrap">
            <span class="drawer-pill" data-status={j().enabled ? 'open' : undefined}>{j().enabled ? 'Active' : 'Disabled'}</span>
            <Show when={j().last_status}><span class="drawer-pill">{j().last_status}</span></Show>
          </div>
          <Group label="Schedule">
            <dl class="drawer-grid">
              <Field label="Name" when={true}>{j().name}</Field>
              <Field label="Cron" when={true}><span class="font-mono text-[11px]">{j().cron}</span></Field>
              <Field label="Last run" when={true}>{j().last_started ?? '—'}</Field>
              <Field label="Created" when={j().items_created}>{j().items_created}</Field>
              <Field label="Updated" when={j().items_updated}>{j().items_updated}</Field>
            </dl>
          </Group>
          <button type="button" class="btn-secondary text-xs self-start" disabled={running()} onClick={runNow}>
            {running() ? 'Running…' : 'Run now'}
          </button>
        </div>
      )}
    </Show>
  );
}

/**
 * One list row: a title, an optional repeat count, and an optional right-hand meta.
 *
 * `stage` adds a second, sibling action — a small icon button that stages the row's
 * task into the flight-plan (Open list only, see `DimensionPanel`). A native
 * `<button>` cannot host a nested `<button>`, so a row carrying a stage action
 * renders its root as a `div[role=button]` instead; the stage button stops
 * propagation so tapping it does not also fire the row's own click.
 */
function RollupRow(props: {
  group: TitleGroup<any>;
  meta?: string;
  onClick?: () => void;
  done?: boolean;
  stage?: { onStage: () => void };
}) {
  return (
    <Show
      when={props.stage}
      fallback={
        <button
          type="button"
          class="flex items-center gap-2 w-full text-left py-1 text-xs hover:text-primary group/row"
          onClick={() => props.onClick?.()}
        >
          <span class="truncate group-hover/row:underline" classList={{ 'line-through text-muted-foreground': props.done }}>
            {props.group.title}
          </span>
          {/* The repeat count, as a digit — a recurring task collapses to one row rather
              than N identical ones. Absent at count 1 so a one-off carries no "x1" noise. */}
          <Show when={props.group.count > 1}>
            <span class="flex-shrink-0 text-[10px] font-mono px-1.5 rounded-full bg-muted text-muted-foreground border border-border">
              x{props.group.count}
            </span>
          </Show>
          <Show when={props.meta}>
            <span class="ml-auto flex-shrink-0 text-[10px] text-muted-foreground font-mono">{props.meta}</span>
          </Show>
        </button>
      }
    >
      {(stage) => (
        <div
          role="button"
          tabIndex={0}
          class="flex items-center gap-2 w-full text-left py-1 text-xs hover:text-primary group/row cursor-pointer"
          onClick={() => props.onClick?.()}
          onKeyDown={(e) => {
            // Code-review fix: only handle Enter/Space when the ROW ITSELF is the
            // keydown target, not when it bubbled up from the nested Stage button.
            // Without the `e.target === e.currentTarget` guard, preventDefault() here
            // fired on every keydown that bubbles through this div — including one
            // that started on the focused Stage button — which suppresses the
            // browser's native Enter/Space-to-click synthesis for that button, so a
            // keyboard user could never activate Stage at all (Enter/Space on it
            // always opened the task instead).
            if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) {
              e.preventDefault();
              props.onClick?.();
            }
          }}
        >
          <span class="truncate group-hover/row:underline" classList={{ 'line-through text-muted-foreground': props.done }}>
            {props.group.title}
          </span>
          <Show when={props.group.count > 1}>
            <span class="flex-shrink-0 text-[10px] font-mono px-1.5 rounded-full bg-muted text-muted-foreground border border-border">
              x{props.group.count}
            </span>
          </Show>
          <Show when={props.meta}>
            <span class="ml-auto flex-shrink-0 text-[10px] text-muted-foreground font-mono">{props.meta}</span>
          </Show>
          <button
            type="button"
            class="ml-auto flex-shrink-0 text-[11px] text-muted-foreground hover:text-foreground"
            title="Stage this task"
            onClick={(e) => { e.stopPropagation(); stage().onStage(); }}
          >
            <Rocket size={11} />
          </button>
        </div>
      )}
    </Show>
  );
}

function DimensionPanel(props: { dimension: string }) {
  const [prio] = createResource(() => api.priorities.list().then((r) => r.priorities).catch(() => []));
  const row = () => (prio() ?? []).find((x) => x.category === props.dimension);

  // bal-7 (docs/factory/balance-targets-wave/bal-7-history-readout.md): the frozen
  // balance_week_log readout, "met target N of last M weeks". catch(() => null) +
  // render-guarded below — an endpoint failure, or a pre-history install with no rows
  // yet, both just leave this line absent; the rest of the drawer is unaffected.
  const [history] = createResource(() => api.priorities.history().catch(() => null));
  const dimHistory = () => history()?.dimensions.find((d) => d.category === props.dimension);

  // Week/month scopes the time-bound lists (Scheduled, Completed). Open tasks are not
  // time-bound — filtering a backlog by a window would just hide work.
  const [period, setPeriod] = createSignal<RollupPeriod>('week');
  const [showDone, setShowDone] = createSignal(false);
  const win = () => windowFor(period());
  const inDim = (cats: string[] | undefined) => (cats ?? []).includes(props.dimension);

  // Scheduled comes from BLOCKS, not tasks: a block is the thing that actually occupies
  // time, so it is the only honest basis for "how much is allocated".
  //
  // Fetched here rather than read off the shared `blocks` resource: that one is keyed to
  // the range the PLANNER is currently showing (usually a single day), so reading it made
  // a week/month rollup silently report only today's blocks — 1h scheduled against a 14h
  // target when three more sessions were already on the calendar.
  const [windowBlocks] = createResource(
    () => { const w = win(); return rangeUTC(w.from, w.to); },
    (r) => api.blocks.list(r.from, r.to).then((res) => res.blocks).catch(() => [] as Block[]),
  );
  const scheduled = () =>
    (windowBlocks() ?? [])
      .filter((b) => inDim(b.categories) && inWindow(b.start_at, win()))
      .sort((a, b) => a.start_at.localeCompare(b.start_at));
  const blockMinutes = (b: Block) => minutesBetween(b.start_at, b.end_at);
  const scheduledMinutes = () => scheduled().reduce((sum, b) => sum + blockMinutes(b), 0);
  const scheduledGroups = () => groupByTitle(scheduled(), (b) => b.title, blockMinutes);

  const targetMinutes = () => Math.round(targetForWindow(row()?.target_hours_per_week ?? 0, win()) * 60);
  const unallocated = () => targetMinutes() - scheduledMinutes();

  // A task already on the calendar this window is NOT repeated under Open — the same
  // task appearing in two sections is exactly the duplication this panel avoids.
  const scheduledTaskIds = () => new Set(scheduled().map((b) => b.task_id).filter(Boolean) as string[]);
  const openTasks = () =>
    (tasks() ?? []).filter(
      (t) => inDim(t.categories)
        && ['open', 'scheduled', 'in_progress'].includes(t.status ?? '')
        && !scheduledTaskIds().has(t.id),
    );
  // Candidate-fill order (engine/autoplan.ts:780): priority, then due date (undated
  // sorts last), then id as a stable tiebreaker. openTasks() itself is not sorted —
  // ordering it here, right before grouping, is what makes the list an owner already
  // sees also consistently ordered.
  const openGroups = () =>
    groupByTitle(
      openTasks().sort((a, b) =>
        a.priority - b.priority
        || (a.due_at ?? '9999-12-31').localeCompare(b.due_at ?? '9999-12-31')
        || a.id.localeCompare(b.id)),
      (t) => t.title,
      (t) => t.estimated_minutes ?? 0,
    );

  // Stage a task straight from the Open list — the human tap is the only write; on
  // success the panel refetches `tasks()` (same resource every other mutation in this
  // file refreshes through) so the list reflects the change immediately.
  async function stageTask(id: string) {
    try {
      await api.flightPlan.addTask(id);
      refetchTasks();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  const doneTasks = () =>
    (tasks() ?? [])
      .filter((t) => inDim(t.categories) && inWindow(t.completed_at, win()))
      .sort((a, b) => (b.completed_at ?? '').localeCompare(a.completed_at ?? ''));
  const doneGroups = () => groupByTitle(doneTasks(), (t) => t.title, (t) => t.estimated_minutes ?? 0);

  return (
    <div class="drawer-body">
      <Show when={row()} fallback={<div><span class="drawer-pill">No priorities set</span></div>}>
        {(r) => (
          <Group label="Alignment">
            <dl class="drawer-grid">
              <Field label="Satisfaction" when={true}>{r().satisfaction}</Field>
              <Field label="Importance" when={true}>{r().importance}</Field>
              <Field label="Gap" when={true}>{r().importance - r().satisfaction > 0 ? '+' : ''}{r().importance - r().satisfaction}</Field>
              <Field label="Target" when={true}>{r().target_hours_per_week}h / week</Field>
            </dl>
            {/* bal-7: no advice, no trend arrows — a count and the weeks, nothing else
                (ticket's non-goals). Hidden entirely rather than shown as "0 of 0" when
                there is no history yet. */}
            <Show when={dimHistory() && dimHistory()!.counted_weeks > 0}>
              <p class="text-xs text-muted-foreground mt-1">
                Met target {dimHistory()!.met_weeks} of last {dimHistory()!.counted_weeks} weeks
              </p>
            </Show>
          </Group>
        )}
      </Show>

      {/* Window switch — scopes Scheduled + Completed below. */}
      <div class="flex items-center gap-1 p-0.5 rounded-lg bg-muted/50 border border-border w-fit">
        <For each={['week', 'month'] as RollupPeriod[]}>
          {(k) => (
            <button
              type="button"
              class="text-[11px] px-2.5 py-0.5 rounded-md capitalize transition-colors"
              classList={{
                'bg-card text-foreground font-medium border border-border': period() === k,
                'text-muted-foreground hover:text-foreground': period() !== k,
              }}
              aria-pressed={period() === k}
              onClick={() => setPeriod(k)}
            >
              {k}
            </button>
          )}
        </For>
      </div>

      {/* Unallocated — the headline number: target for this window minus what is
          actually on the calendar. Negative means over-committed, which is a real
          state and is named rather than clamped to zero. */}
      <Show when={row()}>
        <Group label="Allocation">
          <dl class="drawer-grid">
            <Field label={period() === 'week' ? 'Target (week)' : 'Target (month)'} when={true}>
              {hoursLabel(targetMinutes())}
            </Field>
            <Field label="Scheduled" when={true}>{hoursLabel(scheduledMinutes())}</Field>
            <Field label={unallocated() >= 0 ? 'Unallocated' : 'Over target'} when={true}>
              <span classList={{ 'text-amber-500': unallocated() < 0 }}>
                {hoursLabel(Math.abs(unallocated()))}
              </span>
            </Field>
          </dl>
        </Group>
      </Show>

      <Group label={`Scheduled (${scheduledGroups().length})`}>
        <Show
          when={scheduledGroups().length > 0}
          fallback={<span class="text-xs text-muted-foreground">Nothing scheduled this {period()}.</span>}
        >
          <div class="flex flex-col">
            <For each={scheduledGroups()}>
              {(g) => (
                <RollupRow
                  group={g}
                  meta={hoursLabel(g.minutes)}
                  onClick={() => (g.first.task_id ? setActiveTask(g.first.task_id) : setActiveBlock(g.first.id))}
                />
              )}
            </For>
          </div>
        </Show>
      </Group>

      <Group label={`Open (${openGroups().length})`}>
        <Show
          when={openGroups().length > 0}
          fallback={<span class="text-xs text-muted-foreground">Nothing open in this dimension.</span>}
        >
          <div class="flex flex-col">
            <For each={openGroups()}>
              {(g) => (
                <RollupRow
                  group={g}
                  onClick={() => setActiveTask(g.first.id)}
                  stage={unallocated() > 0 ? { onStage: () => stageTask(g.first.id) } : undefined}
                />
              )}
            </For>
          </div>
        </Show>
      </Group>

      {/* Completed is collapsed by default: it is history, and on a busy dimension it
          is the longest of the three lists. */}
      <div>
        <button
          type="button"
          class="drawer-group flex items-center gap-1 w-full hover:text-foreground"
          aria-expanded={showDone()}
          onClick={() => setShowDone((v) => !v)}
        >
          <Show when={showDone()} fallback={<ChevronRight size={11} />}><ChevronDown size={11} /></Show>
          Completed ({doneGroups().length})
        </button>
        <Show when={showDone()}>
          <Show
            when={doneGroups().length > 0}
            fallback={<span class="text-xs text-muted-foreground">Nothing completed this {period()}.</span>}
          >
            <div class="flex flex-col">
              <For each={doneGroups()}>
                {(g) => <RollupRow group={g} done onClick={() => setActiveTask(g.first.id)} />}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}

/** "Name <email>" → "email"; a bare address passes through unchanged. */
function extractEmail(raw: string): string {
  const m = /<([^>]+)>/.exec(raw);
  return (m ? m[1] : raw).trim();
}

/**
 * An unpromoted email suggestion, shown with the same depth as a real task — plus
 * where it came from. "From"/"Subject" come straight off source_payload, which
 * ingest already writes for every gmail-sourced row (agents/ingest.ts) — just not
 * surfaced until now.
 *
 * "Connected account" names whichever Google account is CURRENTLY linked in
 * Settings — not necessarily the mailbox that received THIS message. Ingest never
 * captures a per-message "To" (see EmailMessage in mcp/google.ts), a pending
 * suggestion has no expiry, and disconnecting/reconnecting a different account
 * doesn't touch already-ingested possible_tasks — so an old pending suggestion can
 * outlive the account it actually came from. Worded as "connected", not "received
 * at", so it never claims a per-message guarantee it can't back up.
 */
function SuggestionPanel(props: { possible: PossibleTask }) {
  const p = () => props.possible;
  const busy = () => isSuggestionBusy(p().id);
  const connectedGoogleEmail = () =>
    (connections() ?? []).find((c) => c.provider === 'google' && c.status === 'connected')?.account;
  const responsible = () => (p().detected_people ?? []).filter((d) => d.role === 'responsible');

  // Shared with SuggestionsSection's list row (stores/index.ts) — the same
  // suggestion can be open here AND listed there, and neither promote nor dismiss
  // is idempotent server-side, so an in-flight action on one surface must disable
  // the other rather than risk a duplicate task from a near-simultaneous click.
  async function promote() {
    if (busy()) return;
    setSuggestionBusy(p().id, true);
    try {
      const r = await api.possibles.promote(p().id);
      showToast('Added to your tasks', 'success');
      // Awaited: setActiveTask below hands the drawer to this id immediately, and
      // task()/taskOf() only see it once the tasks() resource has actually
      // refreshed — firing-and-forgetting the refetch flashed an empty drawer.
      await Promise.all([refetchTasks(), refetchSuggestions()]);
      setActiveTask(r.task.id);
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setSuggestionBusy(p().id, false); }
  }
  async function dismiss() {
    if (busy()) return;
    setSuggestionBusy(p().id, true);
    try {
      await api.possibles.dismiss(p().id);
      showToast('Suggestion dismissed', 'default');
      refetchSuggestions();
      clearActiveEntity();
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setSuggestionBusy(p().id, false); }
  }

  return (
    <div class="drawer-body">
      <div class="flex items-center justify-between gap-2">
        <span class="drawer-pill">Pending review</span>
        <div class="flex gap-1 flex-shrink-0">
          <button onClick={promote} disabled={busy()} class="btn-icon" title="Add this as a task">
            <Check size={13} classList={{ 'animate-pulse': busy() }} />
          </button>
          <button onClick={dismiss} disabled={busy()} class="btn-icon hover:text-red-400" title="Dismiss this suggestion">
            <X size={13} classList={{ 'animate-pulse': busy() }} />
          </button>
        </div>
      </div>

      <Group label="Planning">
        <dl class="drawer-grid">
          <Field label="Priority" when={p().proposed_priority}>P{p().proposed_priority}</Field>
          <Field label="Estimate" when={p().proposed_estimated_minutes}>{p().proposed_estimated_minutes}m</Field>
          <Field label="Due" when={p().proposed_due_at}>{new Date(p().proposed_due_at!).toLocaleDateString()}</Field>
          <Field label="Scheduled" when={p().proposed_scheduled_for}>
            {p().proposed_scheduled_for}
            <Show when={p().proposed_task_time}><span class="text-muted-foreground"> at {p().proposed_task_time}</span></Show>
          </Field>
          <Field label="Confidence" when={p().confidence != null}>{Math.round((p().confidence ?? 0) * 100)}%</Field>
        </dl>
      </Group>

      <Show when={p().raw_summary}>
        <Group label="Notes">
          <p class="drawer-note">{p().raw_summary}</p>
        </Group>
      </Show>

      <Show when={responsible().length > 0}>
        <Group label="People">
          <div class="flex flex-wrap gap-1.5">
            <For each={responsible()}>{(d) => <span class="drawer-tag">{d.display_name}</span>}</For>
          </div>
        </Group>
      </Show>

      <Show when={p().source_kind}>
        <Group label="Source">
          <dl class="drawer-grid">
            <Field label="Type" when={true}>{p().source_kind}</Field>
            <Field label="Connected account" when={p().source_kind === 'gmail' && connectedGoogleEmail()}>{connectedGoogleEmail()}</Field>
            <Field label="From" when={p().source_payload?.from}>{extractEmail(p().source_payload!.from!)}</Field>
            <Field label="Subject" when={p().source_payload?.subject}>{p().source_payload!.subject}</Field>
          </dl>
        </Group>
      </Show>
    </div>
  );
}

/** Walk the objective tree for one node by id — the store holds the tree, not a flat map. */
function findObjective(nodes: Objective[], id: string): Objective | undefined {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = n.children?.length ? findObjective(n.children, id) : undefined;
    if (hit) return hit;
  }
  return undefined;
}

const OBJECTIVE_HORIZON: Record<string, string> = {
  none: 'No horizon', week: 'This week', month: 'This month', quarter: 'This quarter', year: 'This year',
};

/**
 * AF-D: an Objective opens HERE rather than in the create/edit form. Clicking a tree
 * row used to jump straight to ObjectiveModal — an edit surface answering "what is
 * this?" with a form, and one that was clipped on a short viewport. The drawer is the
 * app's standing answer to that question for every other entity, so objectives use it
 * too; the pencil in the tree still opens the form for actual editing.
 *
 * Members are rendered as real anchors: a plain click stays in the drawer (no reload),
 * while cmd/ctrl/middle-click keeps the browser's own "open in a new tab" behaviour,
 * which is what makes them hotlinks rather than click handlers wearing a link's paint.
 */
function ObjectivePanel(props: { objective: Objective }) {
  const o = () => props.objective;
  const pct = () => (o().progress_cache != null ? `${Math.round(o().progress_cache! * 100)}%` : null);
  const openTasks = () => (o().tasks ?? []).filter((t) => t.status !== 'done');
  const doneTasks = () => (o().tasks ?? []).filter((t) => t.status === 'done');

  /** Intercept only the plain left click; let every modifier fall through to the href. */
  const inDrawer = (e: MouseEvent, run: () => void) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    run();
  };

  const TaskRow = (p: { t: { id: string; title: string; status: string; due_at: string | null } }) => (
    <a
      href={`/tasks?tab=tasks&task=${p.t.id}`}
      class="flex items-center gap-2 py-1 text-xs hover:text-primary group/row"
      onClick={(e) => inDrawer(e, () => setActiveTask(p.t.id))}
    >
      <Show when={p.t.status === 'done'} fallback={<span class="w-3 flex-shrink-0" />}>
        <Check size={11} class="flex-shrink-0 text-primary" />
      </Show>
      <span class="truncate group-hover/row:underline" classList={{ 'line-through text-muted-foreground': p.t.status === 'done' }}>
        {p.t.title}
      </span>
      <Show when={p.t.due_at}>
        <span class="ml-auto flex-shrink-0 text-[10px] text-muted-foreground">{fmtDate(p.t.due_at!)}</span>
      </Show>
    </a>
  );

  return (
    <div class="drawer-body">
      <div class="flex items-center gap-2">
        <span class="drawer-pill" data-status={o().status === 'done' ? 'done' : 'open'}>{o().status}</span>
        <span class="text-[11px] text-muted-foreground uppercase tracking-wide">{o().level}</span>
      </div>

      <Show when={o().description}>
        <Group label="Description">
          <p class="text-xs text-muted-foreground whitespace-pre-wrap">{o().description}</p>
        </Group>
      </Show>

      <Group label="Planning">
        <dl class="drawer-grid">
          <Field label="Horizon" when={true}>{OBJECTIVE_HORIZON[o().horizon] ?? o().horizon}</Field>
          <Field label="Progress" when={true}>{pct() ?? 'No plan yet'}</Field>
          <Field label="Cadence" when={o().cadence !== 'none'}>{o().cadence}</Field>
          <Field label="Target" when={o().effective_target ?? o().target_date}>
            {fmtDate((o().effective_target ?? o().target_date)!)}
          </Field>
          <Field label="Next action" when={o().next_action?.title}>{o().next_action!.title}</Field>
        </dl>
      </Group>

      {/* Subtasks — the reason this panel exists: the tree row could only ever show a
          count, so "what is actually in this objective?" needed the form to answer it. */}
      <Group label={`Subtasks${(o().tasks ?? []).length ? ` (${openTasks().length} open)` : ''}`}>
        <Show
          when={(o().tasks ?? []).length > 0}
          fallback={
            <span class="text-xs text-muted-foreground">
              {o().children?.length ? 'Tasks live on the sub-objectives below.' : 'No tasks linked yet.'}
            </span>
          }
        >
          <div class="flex flex-col">
            <For each={openTasks()}>{(t) => <TaskRow t={t} />}</For>
            <For each={doneTasks()}>{(t) => <TaskRow t={t} />}</For>
          </div>
        </Show>
      </Group>

      <Show when={o().children?.length}>
        <Group label={`Sub-objectives (${o().children.length})`}>
          <div class="flex flex-col">
            <For each={o().children}>
              {(c) => (
                <a
                  href={`/tasks?tab=objectives&focus=${c.id}`}
                  class="flex items-center gap-2 py-1 text-xs hover:text-primary hover:underline"
                  onClick={(e) => inDrawer(e, () => setActiveEntity('objective', c.id))}
                >
                  <span class="truncate">{c.title}</span>
                  <span class="ml-auto flex-shrink-0 text-[10px] text-muted-foreground">{c.level}</span>
                </a>
              )}
            </For>
          </div>
        </Group>
      </Show>
    </div>
  );
}

function EmptyPanel(props: { where: string }) {
  return (
    <div class="drawer-empty">
      <Inbox size={26} class="opacity-50" />
      <p>Select {props.where} to see its details here.</p>
    </div>
  );
}

/**
 * The docked details drawer: describes whatever entity is expanded (`activeTask` /
 * `activeBlock`), and hosts the Flight Plan staging list on its own tab.
 *
 * Docked rather than overlaid on purpose — a details panel for a *selected* item has
 * to be readable against the list the selection came from, and an overlay hides
 * exactly that context. Below `md` it becomes a bottom sheet, where a 400px side
 * panel would be the whole screen.
 */
export function DetailsDrawer() {
  const location = useLocation();
  /** Today is the only route with a day grid to host, so it is the only one with tabs. */
  const hasSecondTab = () => location.pathname === '/';
  const task = (): Task | undefined => {
    const id = activeTask();
    if (!id) return undefined;
    return taskOf(id) ?? (tasks() ?? []).find((t) => t.id === id);
  };
  const block = (): Block | undefined => {
    const id = activeBlock();
    if (!id) return undefined;
    return (blocks() ?? []).find((b) => b.id === id);
  };

  const entity = (): ActiveEntity | null => activeEntity();
  /** Resolve tag-family entities to their Tag row (by id for tags, by name for groups). */
  const entityTag = (): Tag | undefined => {
    const e = entity();
    if (!e) return undefined;
    if (e.kind === 'tag') return (tags() ?? []).find((t) => t.id === e.id || t.name === e.id);
    if (e.kind === 'direction' || e.kind === 'category') return (tags() ?? []).find((t) => t.name === e.id);
    return undefined;
  };
  const entityObjective = (): Objective | undefined => {
    const e = entity();
    if (e?.kind !== 'objective') return undefined;
    return findObjective(objectives() ?? [], e.id);
  };
  const suggestion = (): PossibleTask | undefined => {
    const e = entity();
    if (e?.kind !== 'suggestion') return undefined;
    return (suggestions() ?? []).find((p) => p.id === e.id);
  };
  // A selected suggestion can vanish out from under the drawer without going
  // through SuggestionPanel's own promote/dismiss — another tab/device acting on
  // it fires the same possible:promoted/possible:dismissed SSE events that
  // refetchSuggestions() everywhere, including here. Without this, the header (kind
  // ()/title() below, driven off entity().kind alone) keeps reading "Suggestion"
  // over a body that's already fallen through to the generic empty state. Reconcile
  // by clearing the stale reference outright, the same "vanished ⇒ deselect" rule
  // the per-view selection-memory effect already applies on route changes.
  createEffect(() => {
    if (entity()?.kind === 'suggestion' && !suggestion()) clearActiveEntity();
  });

  const KIND_LABEL: Record<string, string> = {
    tag: 'Tag', direction: 'Direction', category: 'Category',
    day: 'Day', job: 'Scheduled job', dimension: 'Life dimension', suggestion: 'Suggestion',
    objective: 'Objective',
  };
  const title = () => {
    const t = task(); if (t) return t.title;
    const b = block(); if (b) return b.title;
    const e = entity();
    if (!e) return 'Nothing selected';
    if (e.kind === 'day') {
      const d = new Date(e.id + 'T12:00:00');
      return Number.isNaN(d.getTime()) ? e.id : d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    }
    if (e.kind === 'dimension') return displayTag(e.id);
    if (e.kind === 'suggestion') return suggestion()?.raw_title ?? KIND_LABEL.suggestion;
    if (e.kind === 'objective') return entityObjective()?.title ?? KIND_LABEL.objective;
    const g = entityTag();
    return g ? displayTag(g.name) : KIND_LABEL[e.kind];
  };
  const kind = () => {
    if (task()) return 'Task';
    if (block()) return 'Scheduled block';
    const e = entity();
    if (!e) return 'Details';
    // A goal and a project are both objective rows; show which one rather than the
    // generic kind, matching the level word the tree puts beside the title.
    if (e.kind === 'objective') {
      const lvl = entityObjective()?.level;
      return lvl ? lvl.charAt(0).toUpperCase() + lvl.slice(1) : KIND_LABEL.objective;
    }
    return KIND_LABEL[e.kind];
  };

  /** What the empty state invites you to pick — per view, as in the mockup. */
  const emptyWhere = () => ({
    '/': 'a task or a scheduled block',
    '/focus': 'a task from the list',
    '/calendar': 'a block or a day header',
    '/tasks': 'a task or a suggestion',
    '/balance': 'a life dimension',
    '/tags': 'a tag or a direction',
    '/jobs': 'a scheduled job',
  } as Record<string, string>)[location.pathname] ?? 'an item';

  // On Today, the drawer's default tab follows the selection: nothing selected →
  // the Flight Plan (the staging list is the useful resting surface), something
  // selected → its Details. Keyed on the selection signals only, so a manual tab
  // click is never fought — the tab moves when the SELECTION changes, not on render.
  createEffect(on([activeTask, activeBlock, activeEntity], () => {
    if (!hasSecondTab()) return;
    setDrawerTab(!activeTask() && !activeBlock() && !activeEntity() ? 'flightplan' : 'details');
  }));

  // Per-view selection memory (mockup contract): each route remembers what was
  // selected in it, so Jobs → Today → Jobs restores the job you were reading
  // instead of resetting the drawer to empty.
  const viewMemory = new Map<string, { task: string | null; block: string | null; entity: ActiveEntity | null }>();
  let prevPath = location.pathname;
  createEffect(() => {
    const path = location.pathname;
    if (path === prevPath) return;
    viewMemory.set(prevPath, { task: activeTask(), block: activeBlock(), entity: activeEntity() });
    const saved = viewMemory.get(path);
    if (saved?.task) setActiveTask(saved.task);
    else if (saved?.block) setActiveBlock(saved.block);
    else if (saved?.entity) setActiveEntity(saved.entity.kind, saved.entity.id);
    else clearActiveEntity();
    prevPath = path;
  });

  // ── Resize ──────────────────────────────────────────────────────────────
  const [dragging, setDragging] = createSignal(false);
  let shellEl: HTMLElement | null = null;

  function onPointerDown(e: PointerEvent) {
    shellEl = (e.currentTarget as HTMLElement).closest('[data-app-shell]') as HTMLElement;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
    e.preventDefault();
  }
  function onPointerMove(e: PointerEvent) {
    if (!dragging() || !shellEl) return;
    // Measure from the shell's right edge so the panel tracks the pointer exactly,
    // wherever the shell sits in the viewport.
    setDetailsWidth(shellEl.getBoundingClientRect().right - e.clientX);
  }
  function endDrag(e: PointerEvent) {
    if (!dragging()) return;
    setDragging(false);
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture?.(e.pointerId)) el.releasePointerCapture(e.pointerId);
  }

  // A drag handle that only answers to a pointer is unreachable without one.
  function onRailKey(e: KeyboardEvent) {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') { setDetailsWidth(detailsWidth() + step); e.preventDefault(); }
    else if (e.key === 'ArrowRight') { setDetailsWidth(detailsWidth() - step); e.preventDefault(); }
    else if (e.key === 'Home') { setDetailsWidth(DETAILS_MAX_W); e.preventDefault(); }
    else if (e.key === 'End') { setDetailsWidth(DETAILS_MIN_W); e.preventDefault(); }
  }

  const onEsc = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && detailsOpen()) setDetailsOpen(false);
  };
  window.addEventListener('keydown', onEsc);
  onCleanup(() => window.removeEventListener('keydown', onEsc));

  return (
    <Show when={detailsOpen()}>
      <div
        class="details-rail"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize details drawer"
        aria-valuemin={DETAILS_MIN_W}
        aria-valuemax={DETAILS_MAX_W}
        aria-valuenow={detailsWidth()}
        tabindex="0"
        data-dragging={dragging()}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onDblClick={() => setDetailsWidth(DETAILS_DEFAULT_W)}
        onKeyDown={onRailKey}
      />
      <aside class="details-drawer" style={{ '--details-w': `${detailsWidth()}px` }} aria-label="Details">
        <div class="drawer-head">
          <div class="min-w-0 flex-1">
            <div class="drawer-kind">{kind()}</div>
            <div class="drawer-title">{title()}</div>
          </div>
          <button
            type="button"
            class="btn-icon flex-shrink-0"
            aria-label="Close details"
            onClick={() => { clearActiveEntity(); setDetailsOpen(false); }}
          >
            <X size={14} />
          </button>
        </div>

        {/* Tab strip sits under the header so it survives an entity change — switching
            tasks must not silently drop you out of the Flight Plan tab. */}
        <Show when={hasSecondTab()}>
          <div class="drawer-tabs" role="tablist">
            <button
              type="button" role="tab" class="drawer-tab"
              aria-selected={drawerTab() === 'details'}
              onClick={() => setDrawerTab('details')}
            >Details</button>
            <button
              type="button" role="tab" class="drawer-tab"
              aria-selected={drawerTab() === 'flightplan'}
              onClick={() => setDrawerTab('flightplan')}
            >Flight Plan</button>
          </div>
        </Show>

        <Show
          when={!(hasSecondTab() && drawerTab() === 'flightplan')}
          fallback={<div class="drawer-body"><FlightPlan /></div>}
        >
          <Switch fallback={<EmptyPanel where={emptyWhere()} />}>
            {/* Truthiness-only match, passing the stable `task` accessor rather than a
                snapshotted value: the callback-children form of Match is KEYED — it
                remounts its children on every reference change to `task()`, which
                happens on every tasks() refetch (SSE task:updated, background jobs)
                even when THIS task's data hasn't changed. TaskPanel now holds local
                draft state for inline editing, so a remount there silently discarded
                whatever the user was mid-typing. Reading through a stable accessor
                keeps the component mounted (and its drafts alive) across refetches. */}
            <Match when={!!task()}><TaskPanel task={() => task()!} /></Match>
            <Match when={block()}>{(b) => <BlockPanel block={b()} />}</Match>
            <Match when={entity()?.kind === 'tag' && entityTag()}>{(g) => <TagPanel tag={g()} />}</Match>
            <Match when={(entity()?.kind === 'direction' || entity()?.kind === 'category') && entityTag()}>
              {(g) => <GroupPanel tag={g()} />}
            </Match>
            <Match when={entity()?.kind === 'day' && entity()}>{(e) => <DayPanel date={e().id} />}</Match>
            <Match when={entity()?.kind === 'job' && entity()}>{(e) => <JobPanel id={e().id} />}</Match>
            <Match when={entity()?.kind === 'dimension' && entity()}>{(e) => <DimensionPanel dimension={e().id} />}</Match>
            <Match when={entity()?.kind === 'suggestion' && suggestion()}>{(s) => <SuggestionPanel possible={s()} />}</Match>
            <Match when={entity()?.kind === 'objective' && entityObjective()}>{(o) => <ObjectivePanel objective={o()} />}</Match>
          </Switch>
        </Show>
      </aside>
    </Show>
  );
}

/** Top-bar toggle for the drawer. Lives in the bar so it survives the drawer closing. */
export function DetailsToggle() {
  return (
    <button
      type="button"
      class="btn-icon flex-shrink-0"
      aria-expanded={detailsOpen()}
      aria-label={detailsOpen() ? 'Hide details drawer' : 'Show details drawer'}
      title={detailsOpen() ? 'Hide details drawer' : 'Show details drawer'}
      onClick={() => setDetailsOpen(!detailsOpen())}
    >
      <PanelRight size={13} />
    </button>
  );
}
