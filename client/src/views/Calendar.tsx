import { createSignal, createMemo, createEffect, onCleanup, For, Show } from 'solid-js';
import { ChevronLeft, ChevronRight, Zap, Filter, X, Download } from 'lucide-solid';
import {
  visibleBlocks,
  setCalendarRange,
  tags,
  overlayTags,
  setOverlayTags,
  overlayPrio,
  setOverlayPrio,
  setElementModal,
} from '../stores/index.js';
import { api } from '../lib/api.js';
import { showToast } from '../stores/index.js';
import { localISODate, rangeUTC, addDays, weekDaysOf, monthGridOf } from '../lib/dates.js';
import { minutesIntoDay } from '../lib/grid.js';
import { CalendarGrid } from '../components/CalendarGrid.js';
import { DayTypeControl } from '../components/DayTypeControl.js';
import type { Block } from '../lib/api.js';

type ViewMode = 'day' | 'week' | 'month';

/** Phones default to the single-day column; wider screens to the week grid. */
function defaultView(): ViewMode {
  try {
    return window.matchMedia('(max-width: 767px)').matches ? 'day' : 'week';
  } catch {
    return 'week';
  }
}

export function Calendar() {
  const [view, setView] = createSignal<ViewMode>(defaultView());
  const [anchor, setAnchor] = createSignal(localISODate());
  const [runningSchedule, setRunningSchedule] = createSignal(false);

  // The local days the current view spans (drives both the grid and the fetch).
  const visibleDays = createMemo<string[]>(() => {
    switch (view()) {
      case 'day':   return [anchor()];
      case 'week':  return weekDaysOf(anchor());
      case 'month': return monthGridOf(anchor());
    }
  });

  // Widen the shared blocks fetch to cover exactly the visible window (tz-correct,
  // owner-scoped server-side) via the `calendarRange` override. The `blocks` resource +
  // SSE refetch in stores/index.ts are reused unchanged; clearing the override on unmount
  // hands the single-day range back to the Planner.
  createEffect(() => {
    const days = visibleDays();
    setCalendarRange(rangeUTC(days[0], days[days.length - 1]));
  });
  onCleanup(() => setCalendarRange(null));

  // Group fetched blocks by the *local* day they start in, so each column shows
  // its own blocks. Uses minutesIntoDay (real elapsed ms) against the anchor day
  // to find the owning local date — no wall-clock string slicing.
  const blocksByDay = createMemo<Record<string, Block[]>>(() => {
    const map: Record<string, Block[]> = {};
    const days = visibleDays();
    if (!days.length) return map;
    const list = visibleBlocks(); // overlay-filtered + optimistic-override applied
    for (const b of list) {
      // Find the visible day whose local midnight..midnight window contains the start.
      // minutesIntoDay against days[0] gives offset from the first column's midnight;
      // dividing by 1440 yields the day index even across DST (real elapsed minutes).
      const offsetMin = minutesIntoDay(b.start_at, days[0]);
      const idx = Math.floor(offsetMin / (24 * 60));
      const day = idx >= 0 && idx < days.length ? days[idx] : null;
      if (day) (map[day] ??= []).push(b);
    }
    return map;
  });

  function shift(n: number) {
    const step = view() === 'day' ? 1 : view() === 'week' ? 7 : 0;
    if (view() === 'month') {
      // Jump to the same day-of-month in the prev/next month via a noon-UTC pivot.
      const [y, m, d] = anchor().split('-').map(Number);
      const nm = m - 1 + n;
      const ny = y + Math.floor(nm / 12);
      const month = ((nm % 12) + 12) % 12;
      setAnchor(`${ny}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    } else {
      setAnchor(addDays(anchor(), n * step));
    }
  }

  function goToday() { setAnchor(localISODate()); }

  async function runSchedule() {
    setRunningSchedule(true);
    try {
      await api.schedule.run(anchor());
      showToast('Day scheduled', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally { setRunningSchedule(false); }
  }

  const rangeLabel = createMemo(() => {
    const days = visibleDays();
    if (view() === 'day') {
      return new Date(days[0] + 'T12:00:00Z').toLocaleDateString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      });
    }
    if (view() === 'month') {
      const mid = days[Math.floor(days.length / 2)];
      return new Date(mid + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    }
    // Week: "Jun 15 – 21, 2026" when within one month, else "Jun 29 – Jul 5, 2026".
    const a = new Date(days[0] + 'T12:00:00Z');
    const b = new Date(days[days.length - 1] + 'T12:00:00Z');
    const year = b.getUTCFullYear();
    const aStr = a.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const sameMonth = a.getUTCMonth() === b.getUTCMonth();
    const bStr = b.toLocaleDateString('en-US', sameMonth
      ? { day: 'numeric' }
      : { month: 'short', day: 'numeric' });
    return `${aStr} – ${bStr}, ${year}`;
  });

  // Export the visible range as an .ics file — a plain download link (no JSON helper).
  const exportHref = createMemo(() => {
    const d = visibleDays();
    const r = rangeUTC(d[0], d[d.length - 1]);
    return `/api/blocks/export.ics?from=${encodeURIComponent(r.from)}&to=${encodeURIComponent(r.to)}`;
  });

  const views: ViewMode[] = ['day', 'week', 'month'];

  // ── Overlay filter (tag AND priority, combinable) ────────────────────────────
  const [showFilters, setShowFilters] = createSignal(false);
  const activeFilters = createMemo(() => overlayTags().length + overlayPrio().length);

  function toggleTag(name: string) {
    setOverlayTags((prev) =>
      prev.includes(name) ? prev.filter((t) => t !== name) : [...prev, name],
    );
  }
  function togglePrio(p: number) {
    setOverlayPrio((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  }
  function clearOverlay() {
    setOverlayTags([]);
    setOverlayPrio([]);
  }

  return (
    <div class="flex-1 overflow-hidden flex flex-col p-3 md:p-6 page-enter w-full">
      <div class="flex items-center justify-between mb-4 gap-3 flex-wrap">
        <h1 class="text-2xl font-bold text-slate-100">Calendar</h1>
        <div class="flex items-center gap-2">
          {/* View switcher */}
          <div class="flex bg-surface-800 rounded-lg p-0.5 border border-surface-700/60">
            <For each={views}>
              {(v) => (
                <button
                  onClick={() => setView(v)}
                  class="px-3 py-1 rounded-md text-xs font-medium capitalize transition-colors"
                  classList={{
                    'bg-accent text-white': view() === v,
                    'text-slate-400 hover:text-slate-200': view() !== v,
                  }}
                >
                  {v}
                </button>
              )}
            </For>
          </div>
          <a
            href={exportHref()}
            download=""
            class="btn-ghost text-xs gap-1"
            title="Download this range as an .ics calendar file"
          >
            <Download size={13} /> Export
          </a>
          <button onClick={runSchedule} disabled={runningSchedule()} class="btn-primary">
            <Zap size={14} />
            {runningSchedule() ? 'Scheduling…' : 'Schedule Day'}
          </button>
        </div>
      </div>

      {/* Range navigation */}
      <div class="flex items-center gap-3 mb-4">
        <button onClick={() => shift(-1)} class="btn-icon"><ChevronLeft size={15} /></button>
        <button onClick={() => shift(1)} class="btn-icon"><ChevronRight size={15} /></button>
        <button onClick={goToday} class="btn-ghost text-xs">Today</button>
        <span class="text-sm font-medium text-slate-300">{rangeLabel()}</span>
        <button
          onClick={() => setShowFilters((s) => !s)}
          class="btn-ghost text-xs gap-1 ml-auto"
          classList={{ 'text-accent-light': activeFilters() > 0 }}
        >
          <Filter size={13} />
          Overlays
          <Show when={activeFilters() > 0}>
            <span class="badge-accent">{activeFilters()}</span>
          </Show>
        </button>
      </div>

      {/* Overlay filter panel: tag chips + 1–5 priority row, AND-combined. */}
      <Show when={showFilters()}>
        <div class="mb-4 p-3 rounded-lg border border-surface-700/60 bg-surface-800 flex flex-col gap-3">
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[10px] uppercase tracking-wide text-slate-500 w-14">Tags</span>
            <For each={tags() ?? []}>
              {(t) => (
                <button
                  onClick={() => toggleTag(t.name)}
                  class="px-2 py-0.5 rounded-full text-xs border transition-colors"
                  classList={{
                    'bg-accent text-white border-accent': overlayTags().includes(t.name),
                    'border-surface-700 text-slate-400 hover:text-slate-200': !overlayTags().includes(t.name),
                  }}
                >
                  {t.name}
                </button>
              )}
            </For>
            <Show when={!(tags() ?? []).length}>
              <span class="text-xs text-slate-600">No tags yet</span>
            </Show>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[10px] uppercase tracking-wide text-slate-500 w-14">Priority</span>
            <For each={[1, 2, 3, 4, 5]}>
              {(p) => (
                <button
                  onClick={() => togglePrio(p)}
                  class="w-7 h-7 rounded-md text-xs font-mono border transition-colors"
                  classList={{
                    'bg-accent text-white border-accent': overlayPrio().includes(p),
                    'border-surface-700 text-slate-400 hover:text-slate-200': !overlayPrio().includes(p),
                  }}
                >
                  P{p}
                </button>
              )}
            </For>
            <Show when={activeFilters() > 0}>
              <button onClick={clearOverlay} class="btn-ghost text-xs gap-1 ml-2">
                <X size={12} /> Clear
              </button>
            </Show>
          </div>
        </div>
      </Show>

      {/* Day-type assignment for the focused date — day view only (unambiguous date). */}
      <Show when={view() === 'day'}>
        <div class="mb-3 p-3 rounded-lg border border-surface-700/60 bg-surface-800">
          <DayTypeControl date={anchor()} />
        </div>
      </Show>

      <div class="flex-1 overflow-hidden min-h-0">
        <CalendarGrid
          view={view()}
          days={visibleDays()}
          blocksByDay={blocksByDay}
          onCreateAt={(day, hhmm) =>
            setElementModal({ open: true, mode: 'add', kind: null, prefill: { day, start: hhmm } })
          }
        />
      </div>
    </div>
  );
}
