import { Show, For, createSignal, onCleanup } from 'solid-js';
import { useLocation } from '@solidjs/router';
import { Planner } from './Planner.js';
import { X, PanelRight, Inbox } from 'lucide-solid';
import {
  detailsOpen, detailsWidth, setDetailsOpen, setDetailsWidth,
  drawerTab, setDrawerTab, DETAILS_MIN_W, DETAILS_MAX_W, DETAILS_DEFAULT_W,
} from '../stores/ui.js';
import { activeTask, activeBlock, clearActiveEntity } from '../stores/selection.js';
import { blocks, tasks, taskOf } from '../stores/index.js';
import type { Block, Task } from '../lib/api.js';

const PRIORITY_NAME: Record<number, string> = { 1: 'High', 2: 'Medium', 3: 'Low' };

function fmtClock(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? '—'
    : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
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

function TaskPanel(props: { task: Task }) {
  const t = () => props.task;
  const blocked = () => t().status === 'blocked' || !!t().blocked;
  const tagList = () => [
    ...((t().tags ?? []) as string[]).map((n) => ({ name: n, secondary: false })),
    ...((t().secondary_tags ?? []) as string[]).map((n) => ({ name: n, secondary: true })),
  ];

  return (
    <>
      <div class="drawer-body">
        <div class="flex gap-1.5 flex-wrap">
          <span class="drawer-pill" data-status={blocked() ? 'blocked' : t().status}>
            {blocked() ? 'Blocked' : t().status}
          </span>
          <Show when={t().subtype === 'habit' || t().is_habit}><span class="drawer-pill">Habit</span></Show>
          <Show when={t().is_fast_task}><span class="drawer-pill">Fast task</span></Show>
        </div>

        <Group label="Planning">
          <dl class="drawer-grid">
            <Field label="Priority" when={t().priority}>
              {PRIORITY_NAME[t().priority] ?? '—'}
              <span class="text-muted-foreground"> · P{t().priority}</span>
            </Field>
            <Field label="Estimate" when={t().estimated_minutes}>
              {t().estimated_minutes}m
              <Show when={t().actual_minutes}>
                <span class="text-muted-foreground"> · {t().actual_minutes}m logged</span>
              </Show>
            </Field>
            <Field label="Scheduled" when={true}>{t().scheduled_for ?? <span class="text-muted-foreground">Unscheduled</span>}</Field>
            <Field label="Due" when={true}>{t().due_at ?? <span class="text-muted-foreground">No due date</span>}</Field>
            <Field label="Deferred to" when={t().defer_until}>{t().defer_until}</Field>
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

        <Show when={t().description || t().notes}>
          <Group label="Notes">
            <p class="drawer-note">{t().notes ?? t().description}</p>
          </Group>
        </Show>

        <Show when={t().motivation || t().source_kind}>
          <Group label="Context">
            <dl class="drawer-grid">
              <Field label="Motivation" when={t().motivation}>{t().motivation}</Field>
              <Field label="Source" when={t().source_kind}>{t().source_kind}</Field>
            </dl>
          </Group>
        </Show>
      </div>
    </>
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
            <span class="drawer-note">{task().title}</span>
          </Group>
        )}
      </Show>
    </div>
  );
}

function EmptyPanel() {
  return (
    <div class="drawer-empty">
      <Inbox size={26} class="opacity-50" />
      <p>Select a task or a scheduled block to see its details here.</p>
    </div>
  );
}

/**
 * The docked details drawer: describes whatever entity is expanded (`activeTask` /
 * `activeBlock`), and hosts the day Planner on its own tab.
 *
 * Docked rather than overlaid on purpose — a details panel for a *selected* item has
 * to be readable against the list the selection came from, and an overlay hides
 * exactly that context. Below `md` it becomes a bottom sheet, where a 400px side
 * panel would be the whole screen.
 */
export function DetailsDrawer() {
  const location = useLocation();
  /** Today is the only route with a day grid to host, so it is the only one with tabs. */
  const hasPlannerTab = () => location.pathname === '/';
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

  const title = () => task()?.title ?? block()?.title ?? 'Nothing selected';
  const kind = () => (task() ? 'Task' : block() ? 'Scheduled block' : 'Details');

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
            tasks must not silently drop you out of the Planner tab. */}
        <Show when={hasPlannerTab()}>
          <div class="drawer-tabs" role="tablist">
            <button
              type="button" role="tab" class="drawer-tab"
              aria-selected={drawerTab() === 'details'}
              onClick={() => setDrawerTab('details')}
            >Details</button>
            <button
              type="button" role="tab" class="drawer-tab"
              aria-selected={drawerTab() === 'planner'}
              onClick={() => setDrawerTab('planner')}
            >Planner</button>
          </div>
        </Show>

        <Show
          when={!(hasPlannerTab() && drawerTab() === 'planner')}
          fallback={<div class="drawer-body drawer-body-flush"><Planner /></div>}
        >
          <Show when={task()} fallback={
            <Show when={block()} fallback={<EmptyPanel />}>
              {(b) => <BlockPanel block={b()} />}
            </Show>
          }>
            {(t) => <TaskPanel task={t()} />}
          </Show>
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
