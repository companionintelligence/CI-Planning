import { createSignal, createMemo, createEffect, createResource, onCleanup, For, Show } from 'solid-js';
import { ChevronLeft, ChevronRight, Zap, Filter, X, Download, ClipboardList } from 'lucide-solid';
import { useNavigate } from '@solidjs/router';
import {
  visibleBlocks,
  setCalendarRange,
  tags,
  overlayAxes,
  toggleAxisTag,
  resetOverlayAxes,
  overlayAxesCount,
  overlayPrio,
  setOverlayPrio,
  setElementModal,
  setSelectedDay,
} from '../stores/index.js';
import { sortDirections, sortCategories, displayTag } from '../lib/tag-tax.js';
import { TAG_AXES } from '../lib/overlay.js';
import type { TagAxis } from '../lib/overlay.js';
import { api } from '../lib/api.js';
import { showToast } from '../stores/index.js';
import { localISODate, rangeUTC, addDays, weekDaysOf, monthGridOf } from '../lib/dates.js';
import { minutesIntoDay } from '../lib/grid.js';
import { CalendarGrid } from '../components/CalendarGrid.js';
import { DayTypeControl } from '../components/DayTypeControl.js';
import { WeeklyReview } from '../components/WeeklyReview.js';
import type { Block, DayStar } from '../lib/api.js';

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
  const navigate = useNavigate();
  const [view, setView] = createSignal<ViewMode>(defaultView());
  const [anchor, setAnchor] = createSignal(localISODate());
  const [runningSchedule, setRunningSchedule] = createSignal(false);

  // Wave-3 item 5: any date in week/month view is selectable; selecting it shows the
  // day-type picker for THAT date. Day view has one unambiguous date (the anchor) and
  // keeps its always-on control, so this signal only drives week/month. Per-session,
  // default none.
  const [selectedDate, setSelectedDate] = createSignal<string | null>(null);
  // The date the day-type picker targets: the anchor in day view, else the selection.
  const dayTypeDate = createMemo(() => (view() === 'day' ? anchor() : selectedDate()));

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

  // Phase O · O1 — dates in the visible range that have a day note (calendar dots).
  const [notedDates] = createResource(visibleDays, async (days) => {
    if (!days.length) return new Set<string>();
    try {
      const r = await api.reflections.notedDays(days[0], days[days.length - 1]);
      return new Set(r.dates);
    } catch {
      return new Set<string>();
    }
  });
  const notedDays = () => notedDates() ?? new Set<string>();

  // Phase O · O3 — the five-star heatmap. One range call backs the whole visible
  // month; the grid renders per-date pips (or a perfect-day single star). Only the
  // month view uses it — day/week don't show the heatmap.
  const [starRows] = createResource(
    () => (view() === 'month' ? visibleDays() : null),
    async (days) => {
      if (!days?.length) return {} as Record<string, DayStar>;
      try {
        const rows = await api.stars.range(days[0], days[days.length - 1]);
        return Object.fromEntries(rows.map((r) => [r.date, r]));
      } catch {
        return {} as Record<string, DayStar>;
      }
    },
  );
  const starsByDay = () => starRows() ?? {};

  function openNote(day: string) {
    setSelectedDay(day);
    navigate('/');
  }

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

  // ── Weekly review toggle (week view only) ───────────────────────────────────
  const [showReview, setShowReview] = createSignal(false);
  const reviewEnabled = () => view() === 'week' && showReview();
  const [weekReview] = createResource(
    () => (reviewEnabled() ? anchor() : null),
    (a) => api.review.week(a),
  );
  // Calibration is owner-wide; fetch once when the review panel opens, then cache.
  const [calibration] = createResource(
    () => reviewEnabled() || null,
    () => api.review.calibration(),
  );

  // ── Overlay filter (three tag axes AND priority, combinable) ──────────────────
  // Each axis groups the tags of one kind (direction / intention / category); every
  // chip starts ON (nothing hidden). Deselecting a chip hides matching entities: OR
  // within an axis, AND across axes + priority. See stores/index.ts + lib/overlay.ts.
  const [showFilters, setShowFilters] = createSignal(false);
  const activeFilters = createMemo(() => overlayAxesCount(overlayAxes()) + overlayPrio().length);

  const AXIS_LABEL: Record<TagAxis, string> = {
    direction: 'Direction',
    intention: 'Intention',
    category: 'Category',
  };

  /** Tags per axis, ordered per the Tags-page convention (brand first, then A–Z).
   *  Memoized so the filter/sort runs only when the tag list changes — not on every
   *  chip toggle or unrelated re-render (the chip rows read this twice per axis). */
  const axisTagsByAxis = createMemo(() => {
    const all = tags() ?? [];
    const build = (axis: TagAxis) => {
      const of = all.filter((t) => t.kind === axis);
      if (axis === 'direction') return sortDirections(of);
      if (axis === 'category') return sortCategories(of);
      return [...of].sort((a, b) => a.name.localeCompare(b.name));
    };
    return { direction: build('direction'), intention: build('intention'), category: build('category') };
  });
  const axisTags = (axis: TagAxis) => axisTagsByAxis()[axis];

  /** A chip is ON unless its name is in that axis's deselected set. */
  function chipOn(axis: TagAxis, name: string) {
    return !overlayAxes()[axis].has(name);
  }

  function togglePrio(p: number) {
    setOverlayPrio((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );
  }
  function clearOverlay() {
    resetOverlayAxes();
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
          <Show when={view() === 'week'}>
            <button
              onClick={() => setShowReview((s) => !s)}
              class="btn-ghost text-xs gap-1"
              classList={{ 'text-primary': showReview() }}
              title="Toggle weekly review panel"
            >
              <ClipboardList size={13} /> Review
            </button>
          </Show>
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

      {/* Overlay filter panel: three tag-axis chip rows + 1–5 priority row, AND-combined.
          Chips start ON; deselecting hides matching entities (OR within a row, AND across). */}
      <Show when={showFilters()}>
        <div class="mb-4 p-3 rounded-lg border border-surface-700/60 bg-surface-800 flex flex-col gap-3">
          <For each={TAG_AXES}>
            {(axis) => (
              <Show when={axisTags(axis).length}>
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="text-[10px] uppercase tracking-wide text-slate-500 w-14">{AXIS_LABEL[axis]}</span>
                  <For each={axisTags(axis)}>
                    {(t) => (
                      <button
                        type="button"
                        aria-pressed={chipOn(axis, t.name)}
                        onClick={() => toggleAxisTag(axis, t.name)}
                        class="px-2 py-0.5 rounded-full text-xs border transition-colors"
                        classList={{
                          'bg-accent text-white border-accent': chipOn(axis, t.name),
                          'border-surface-700 text-slate-400 hover:text-slate-200': !chipOn(axis, t.name),
                        }}
                      >
                        {displayTag(t.name)}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            )}
          </For>
          <Show when={!(tags() ?? []).length}>
            <span class="text-xs text-slate-600">No tags yet</span>
          </Show>
          <div class="flex items-center gap-2 flex-wrap">
            <span class="text-[10px] uppercase tracking-wide text-slate-500 w-14">Priority</span>
            <For each={[1, 2, 3, 4, 5]}>
              {(p) => (
                <button
                  type="button"
                  aria-pressed={overlayPrio().includes(p)}
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

      {/* Day-type assignment. Day view targets its single unambiguous date (the anchor).
          Week/month views show the same control once a date is selected (click a week
          day-header or a month cell's date number). */}
      <Show when={view() === 'day'}>
        <div class="mb-3 p-3 rounded-lg border border-surface-700/60 bg-surface-800">
          <DayTypeControl date={anchor()} />
        </div>
      </Show>
      <Show when={view() !== 'day'}>
        <div class="mb-3 p-3 rounded-lg border border-surface-700/60 bg-surface-800">
          <Show
            when={dayTypeDate()}
            fallback={
              <p class="text-xs text-slate-500">
                Select a date {view() === 'week' ? '(click a day header)' : "(click a cell's date)"} to set its day type.
              </p>
            }
          >
            {(d) => (
              <>
                <div class="mb-2 text-[11px] uppercase tracking-wide text-slate-500">
                  {new Date(d() + 'T12:00:00Z').toLocaleDateString('en-US', {
                    weekday: 'long', month: 'long', day: 'numeric',
                  })}
                </div>
                <DayTypeControl date={d()} />
              </>
            )}
          </Show>
        </div>
      </Show>

      {/* Phase N3/N4: weekly review panel — visible only in week view when toggled. */}
      <Show when={view() === 'week' && showReview()}>
        <WeeklyReview data={weekReview()} calibration={calibration()} />
      </Show>

      <div class="flex-1 overflow-hidden min-h-0">
        <CalendarGrid
          view={view()}
          days={visibleDays()}
          blocksByDay={blocksByDay}
          notedDays={notedDays}
          starsByDay={starsByDay}
          onOpenNote={openNote}
          // Wave-3 item 5: select any date (week header / month cell number) to set its
          // day type. The picker renders above, keyed off the selection.
          selectedDate={selectedDate}
          onSelectDate={setSelectedDate}
          // Wave-3 item 10: clicking an empty slot adds a TASK auto-scheduled at that
          // time. Defaulting to `kind: 'task'` (not the type chooser) + threading the
          // clicked day/time into the task's own schedule fields (see ElementWizard's
          // prefill seeding) means Save creates a scheduled placement at that instant.
          // In month view the grid supplies a placeholder '09:00'; skip `start` there so
          // the modal doesn't pin an arbitrary time on month-cell clicks.
          onCreateAt={(day, hhmm) => {
            const prefill = view() === 'month' ? { day } : { day, start: hhmm };
            setElementModal({ open: true, mode: 'add', kind: 'task', prefill });
          }}
        />
      </div>
    </div>
  );
}
