import { createSignal, Show, For, createResource, createMemo, onMount, onCleanup } from 'solid-js';
import { ChevronLeft, ChevronRight, Zap, Search, Plus, Filter, Trash2, CheckCircle, SkipForward, Clock, Lock, ShieldAlert, RefreshCw } from 'lucide-solid';
import { blocks, blockRange, setBlockRange, refetchBlocks, tasks, refetchTasks, showToast, setTaskModal, tags, prefs } from '../stores/index.js';
import { api } from '../lib/api.js';
import { TaskCard } from '../components/TaskCard.js';

function isoDate(d: Date) { return d.toISOString().slice(0, 10); }
function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

const blockStyles: Record<string, { border: string; bg: string; text: string; accent: string }> = {
  task:    { border: 'border-teal-500/40', bg: 'bg-teal-950/30 backdrop-blur-md', text: 'text-teal-200', accent: 'bg-teal-400' },
  meeting: { border: 'border-blue-500/40', bg: 'bg-blue-950/30 backdrop-blur-md', text: 'text-blue-200', accent: 'bg-blue-400' },
  focus:   { border: 'border-purple-500/40', bg: 'bg-purple-950/30 backdrop-blur-md', text: 'text-purple-200', accent: 'bg-purple-400' },
  habit:   { border: 'border-emerald-500/40', bg: 'bg-emerald-950/30 backdrop-blur-md', text: 'text-emerald-200', accent: 'bg-emerald-400' },
  break:   { border: 'border-surface-600/40', bg: 'bg-surface-850/40 backdrop-blur-md', text: 'text-ci-1/80', accent: 'bg-surface-500' },
  buffer:  { border: 'border-surface-700/40', bg: 'bg-surface-900/40 backdrop-blur-md', text: 'text-ci-1/60', accent: 'bg-surface-750' },
};

export function Calendar() {
  const [selectedDate, setSelectedDate] = createSignal(isoDate(new Date()));
  const [runningSchedule, setRunningSchedule] = createSignal(false);
  const [syncingGCal, setSyncingGCal] = createSignal(false);
  const [clearingBlocks, setClearingBlocks] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal('');
  const [selectedTag, setSelectedTag] = createSignal('');
  const [selectedPriority, setSelectedPriority] = createSignal<number | null>(null);

  async function syncGCal() {
    setSyncingGCal(true);
    try {
      const { jobs } = await api.jobs.list();
      const gcalJob = jobs.find(j => j.kind === 'ingest_gcal');
      if (gcalJob) {
        const res = await api.jobs.run(gcalJob.id);
        showToast(res.message, 'default');
        refetchBlocks();
      } else {
        showToast('Google Calendar Ingestion job not found', 'error');
      }
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setSyncingGCal(false);
    }
  }

  async function clearSchedule() {
    if (!confirm('Clear all temporary blocks scheduled for this day? Locked blocks will remain.')) return;
    setClearingBlocks(true);
    try {
      const res = await api.schedule.clear(selectedDate());
      showToast(`Cleared ${res.cleared} blocks`, 'success');
      refetchBlocks();
      refetchTasks();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setClearingBlocks(false);
    }
  }

  // Dragging and resizing local overrides
  const [dragBlock, setDragBlock] = createSignal<{ id: number; startY: number; startTop: number; startHeight: number; type: 'move' | 'resize' } | null>(null);
  const [dragOverrides, setDragOverrides] = createSignal<Record<number, { top: number; height: number }>>({});
  let hasMoved = false;

  // Sync date selection with store range
  function selectDate(d: string) {
    setSelectedDate(d);
    setBlockRange({ from: `${d}T00:00:00.000Z`, to: `${d}T23:59:59.000Z` });
  }

  // Workday bounds calculation
  const startHour = () => {
    const defaultStart = Number(prefs()?.workday_start?.split(':')[0] ?? 8);
    const blockTimes = (blocks() ?? []).map(b => new Date(b.start_at).getUTCHours());
    return Math.min(defaultStart, ...blockTimes, 8);
  };

  const endHour = () => {
    const defaultEnd = Number(prefs()?.workday_end?.split(':')[0] ?? 20);
    const blockTimes = (blocks() ?? []).map(b => new Date(b.end_at).getUTCHours());
    return Math.max(defaultEnd, ...blockTimes, 20);
  };

  const hourRows = () => {
    const s = startHour();
    const e = endHour();
    const rows = [];
    for (let h = s; h <= e; h++) {
      rows.push(h);
    }
    return rows;
  };

  // Backlog Filtering Memo
  const backlogTasks = createMemo(() => {
    let list = tasks() ?? [];
    list = list.filter((t) => t.status === 'open' && !t.parent_id);

    if (searchQuery().trim()) {
      const q = searchQuery().toLowerCase().trim();
      list = list.filter((t) => t.title.toLowerCase().includes(q));
    }

    if (selectedTag()) {
      list = list.filter((t) => t.tags.includes(selectedTag()));
    }

    if (selectedPriority() !== null) {
      list = list.filter((t) => t.priority === selectedPriority());
    }

    return list;
  });

  // Positioned Blocks for Absolute Render with Side-by-Side Column Overlap
  const positionedBlocks = createMemo(() => {
    const sorted = [...(blocks() ?? [])].sort((a, b) => a.start_at.localeCompare(b.start_at));
    const columns: { end: number; blockId: number }[][] = [];
    const blockPositions = new Map<number, { col: number; maxCols: number }>();

    for (const b of sorted) {
      const start = new Date(b.start_at).getTime();
      const end = new Date(b.end_at).getTime();
      let assignedCol = -1;

      for (let i = 0; i < columns.length; i++) {
        const lastInCol = columns[i][columns[i].length - 1];
        if (lastInCol.end <= start) {
          assignedCol = i;
          columns[i].push({ end, blockId: b.id });
          break;
        }
      }

      if (assignedCol === -1) {
        assignedCol = columns.length;
        columns.push([{ end, blockId: b.id }]);
      }

      blockPositions.set(b.id, { col: assignedCol, maxCols: 1 });
    }

    return sorted.map((b) => {
      const pos = blockPositions.get(b.id) || { col: 0, maxCols: 1 };
      const colWidth = 90 / Math.max(columns.length, 1);
      const leftOffset = 10 + pos.col * colWidth;

      const sHour = startHour();
      const start = new Date(b.start_at);
      const end = new Date(b.end_at);
      
      const override = dragOverrides()[b.id];
      const hourHeight = 72;

      const startFraction = override ? (sHour + override.top / hourHeight) : (start.getUTCHours() + start.getUTCMinutes() / 60);
      const endFraction = override ? (sHour + (override.top + override.height) / hourHeight) : (end.getUTCHours() + end.getUTCMinutes() / 60);

      const top = override ? override.top : Math.max(0, (startFraction - sHour) * hourHeight);
      const height = override ? override.height : Math.max(28, (endFraction - startFraction) * hourHeight);

      return {
        block: b,
        style: {
          position: 'absolute',
          top: `${top}px`,
          height: `${height}px`,
          left: `${leftOffset}%`,
          width: `${colWidth - 2}%`,
          'z-index': 10,
        } as any
      };
    });
  });

  // Actions
  async function runSchedule() {
    setRunningSchedule(true);
    try {
      await api.schedule.run(selectedDate());
      showToast('Day scheduled successfully', 'success');
      refetchBlocks();
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally { setRunningSchedule(false); }
  }

  async function updateBlockStatus(id: number, s: string) {
    try {
      await api.blocks.update(id, { status: s });
      refetchBlocks();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function deleteBlock(id: number) {
    try {
      await api.blocks.delete(id);
      refetchBlocks();
      refetchTasks();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // Edit blocks
  const onBlockClick = async (block: any) => {
    if (block.task_id) {
      try {
        const res = await api.tasks.list();
        const task = res.tasks.find(t => t.id === block.task_id);
        if (task) {
          setTaskModal({ open: true, editTask: task });
        }
      } catch (err) {
        showToast((err as Error).message, 'error');
      }
    } else {
      const newTitle = prompt('Edit block title:', block.title);
      if (newTitle !== null && newTitle.trim()) {
        try {
          await api.blocks.update(block.id, { title: newTitle.trim() });
          refetchBlocks();
          showToast('Block updated', 'success');
        } catch (err) {
          showToast((err as Error).message, 'error');
        }
      }
    }
  };

  // Week stripper calculations
  const weekDays = () => {
    const today = isoDate(new Date());
    const d = new Date(today + 'T12:00:00Z');
    const dow = d.getUTCDay();
    const monday = addDays(today, -(dow === 0 ? 6 : dow - 1));
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  };

  function shiftWeek(n: number) {
    selectDate(addDays(selectedDate(), n * 7));
  }

  // Drag and drop handlers
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
  };

  const onDrop = async (e: DragEvent, hour: number) => {
    e.preventDefault();
    try {
      const raw = e.dataTransfer?.getData('text/plain');
      if (!raw) return;
      const { taskId, title, estimatedMinutes } = JSON.parse(raw);

      const dateStr = selectedDate();
      const pad = (num: number) => String(num).padStart(2, '0');

      const startIso = `${dateStr}T${pad(hour)}:00:00.000Z`;
      
      const endHourFraction = hour + (estimatedMinutes || 30) / 60;
      const endHourInt = Math.floor(endHourFraction);
      const endMinInt = Math.round((endHourFraction - endHourInt) * 60);
      const endIso = `${dateStr}T${pad(endHourInt)}:${pad(endMinInt)}:00.000Z`;

      await api.blocks.create({
        task_id: taskId,
        title: title,
        block_kind: 'task',
        start_at: startIso,
        end_at: endIso,
        is_locked: true,
      });

      await api.tasks.update(taskId, { status: 'scheduled' });

      showToast(`Scheduled "${title}" at ${pad(hour)}:00`, 'success');
      refetchBlocks();
      refetchTasks();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  };

  const onSlotClick = (hour: number) => {
    const pad = (num: number) => String(num).padStart(2, '0');
    setTaskModal({
      open: true,
      defaultDueAt: selectedDate(),
      defaultTaskTime: `${pad(hour)}:00`,
    });
  };

  function fmtTime(iso: string) {
    return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
  }

  // Setup Global mouse listeners for moving and resizing
  onMount(() => {
    const handleMouseMove = (e: MouseEvent) => {
      const drag = dragBlock();
      if (!drag) return;
      hasMoved = true;

      const deltaY = e.clientY - drag.startY;
      if (drag.type === 'resize') {
        const newHeight = Math.max(18, drag.startHeight + deltaY);
        setDragOverrides((prev) => ({
          ...prev,
          [drag.id]: { top: drag.startTop, height: newHeight },
        }));
      } else {
        const newTop = Math.max(0, drag.startTop + deltaY);
        setDragOverrides((prev) => ({
          ...prev,
          [drag.id]: { top: newTop, height: drag.startHeight },
        }));
      }
    };

    const handleMouseUp = async () => {
      const drag = dragBlock();
      if (!drag) return;

      const moved = hasMoved;
      hasMoved = false;

      const override = dragOverrides()[drag.id];
      setDragBlock(null);
      setDragOverrides({});

      if (moved && override) {
        const hourHeight = 72;
        const sHour = startHour();

        const startFraction = sHour + override.top / hourHeight;
        const endFraction = startFraction + override.height / hourHeight;

        const dateStr = selectedDate();
        const pad = (num: number) => String(num).padStart(2, '0');

        const fractionToIso = (fraction: number) => {
          const h = Math.floor(fraction);
          const m = Math.round((fraction - h) * 60);
          return `${dateStr}T${pad(Math.min(23, Math.max(0, h)))}:${pad(Math.min(59, Math.max(0, m)))}:00.000Z`;
        };

        const startIso = fractionToIso(startFraction);
        const endIso = fractionToIso(endFraction);

        try {
          await api.blocks.update(drag.id, {
            start_at: startIso,
            end_at: endIso,
            is_locked: true,
          });
          showToast('Time block rescheduled', 'success');
          refetchBlocks();
        } catch (err) {
          showToast((err as Error).message, 'error');
        }
      } else if (!moved) {
        const blk = (blocks() ?? []).find(b => b.id === drag.id);
        if (blk) onBlockClick(blk);
      }
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);

    onCleanup(() => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    });
  });

  return (
    <div class="h-full flex overflow-hidden page-enter">
      {/* ── Left Backlog Column ── */}
      <div class="w-80 border-r border-surface-700/40 bg-surface-900/10 flex flex-col h-full flex-shrink-0">
        <div class="p-4 border-b border-surface-700/40 flex flex-col gap-3">
          <div class="flex items-center justify-between">
            <h2 class="text-sm font-heading font-bold text-ci-1 tracking-wider uppercase select-none">Task Backlog</h2>
            <button
              onClick={() => setTaskModal({ open: true, defaultDueAt: selectedDate() })}
              class="p-1 rounded hover:bg-surface-700/50 text-accent-light"
              title="Add to backlog"
            >
              <Plus size={16} />
            </button>
          </div>

          {/* Search bar */}
          <div class="relative">
            <Search class="absolute left-2.5 top-2.5 text-ci-1/40" size={13} />
            <input
              type="text"
              placeholder="Search backlog…"
              class="input pl-8 py-1.5 text-xs w-full font-mono bg-surface-950/40 border-surface-750"
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
            />
          </div>

          {/* Tag & Priority filters */}
          <div class="flex gap-2">
            <select
              class="select py-1 px-2 text-[11px] font-mono flex-1 bg-surface-950/40 border-surface-750"
              value={selectedTag()}
              onChange={(e) => setSelectedTag(e.currentTarget.value)}
            >
              <option value="">All Tags</option>
              <For each={tags()}>
                {(t) => <option value={t.name}>#{t.name}</option>}
              </For>
            </select>

            <select
              class="select py-1 px-2 text-[11px] font-mono flex-1 bg-surface-950/40 border-surface-750"
              value={selectedPriority() ?? ''}
              onChange={(e) => {
                const val = e.currentTarget.value;
                setSelectedPriority(val ? Number(val) : null);
              }}
            >
              <option value="">All Priorities</option>
              <option value="1">P1 - Urgent</option>
              <option value="2">P2 - High</option>
              <option value="3">P3 - Normal</option>
              <option value="4">P4 - Low</option>
              <option value="5">P5 - Someday</option>
            </select>
          </div>
        </div>

        {/* Backlog List */}
        <div class="flex-1 overflow-y-auto p-3 flex flex-col gap-1">
          <Show when={backlogTasks().length > 0} fallback={
            <div class="text-center py-12 text-xs text-ci-1/40 font-mono select-none">
              No tasks found.
            </div>
          }>
            <For each={backlogTasks()}>
              {(t) => <TaskCard task={t} scheduleDate={selectedDate()} />}
            </For>
          </Show>
        </div>

        {/* Day Actions */}
        <div class="p-3 border-t border-surface-700/40 bg-surface-900/30 flex flex-col gap-2">
          <div class="text-[10px] font-mono font-bold text-ci-1/40 uppercase tracking-widest select-none">Calendar Schedule</div>
          <div class="flex flex-col gap-1.5">
            <button
              onClick={runSchedule}
              disabled={runningSchedule()}
              class="btn-primary py-1.5 text-xs w-full justify-center"
            >
              <Zap size={12} class="animate-pulse2" />
              {runningSchedule() ? 'Scheduling…' : 'Auto-Schedule Day'}
            </button>
            <div class="flex gap-2">
              <button
                onClick={clearSchedule}
                disabled={clearingBlocks()}
                class="btn-secondary py-1.5 text-[11px] flex-1 justify-center"
              >
                <Show when={clearingBlocks()} fallback={<Trash2 size={12} />}>
                  <RefreshCw size={12} class="animate-spin" />
                </Show>
                {clearingBlocks() ? 'Clearing…' : 'Clear Blocks'}
              </button>
              <button
                onClick={syncGCal}
                disabled={syncingGCal()}
                class="btn-secondary py-1.5 text-[11px] flex-1 justify-center"
              >
                <Show when={syncingGCal()} fallback={<RefreshCw size={12} />}>
                  <RefreshCw size={12} class="animate-spin" />
                </Show>
                {syncingGCal() ? 'Syncing…' : 'Sync GCal'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* ── Right Day Planner Grid ── */}
      <div class="flex-1 flex flex-col h-full bg-surface-950/20 overflow-hidden">
        {/* Day Navigation strip */}
        <div class="p-4 border-b border-surface-700/40 flex items-center justify-between flex-shrink-0 bg-surface-900/10">
          <div class="flex items-center gap-1.5">
            <button onClick={() => shiftWeek(-1)} class="btn-icon"><ChevronLeft size={14} /></button>
            <div class="flex bg-surface-850 rounded-xl p-0.5 border border-surface-750/50">
              <For each={weekDays()}>
                {(d) => {
                  const dateObj = new Date(d + 'T12:00:00Z');
                  const label = dateObj.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
                  const isToday = d === isoDate(new Date());
                  const isSelected = () => d === selectedDate();
                  return (
                    <button
                      onClick={() => selectDate(d)}
                      class={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-all duration-100
                        ${isSelected()
                          ? 'bg-accent text-white shadow-sm shadow-accent/20 font-bold'
                          : isToday
                            ? 'text-accent-light font-semibold hover:bg-surface-700'
                            : 'text-ci-1/60 hover:text-ci-1 hover:bg-surface-700'}`}
                    >
                      {label}
                    </button>
                  );
                }}
              </For>
            </div>
            <button onClick={() => shiftWeek(1)} class="btn-icon"><ChevronRight size={14} /></button>
          </div>

          <button onClick={runSchedule} disabled={runningSchedule()} class="btn-primary py-1.5 text-xs">
            <Zap size={12} class="animate-pulse2" />
            {runningSchedule() ? 'Scheduling…' : 'Schedule Day'}
          </button>
        </div>

        {/* Hourly calendar scroll list */}
        <div class="flex-1 overflow-y-auto relative p-4" style={{ height: 'calc(100% - 70px)' }}>
          {/* Hour grid lines */}
          <div class="relative" style={{ height: `${hourRows().length * 72}px` }}>
            <For each={hourRows()}>
              {(hour) => {
                const displayHour = hour === 12 ? '12 PM' : hour > 12 ? `${hour - 12} PM` : `${hour} AM`;
                return (
                  <div
                    class="absolute left-0 right-0 flex border-t border-surface-800/30 select-none group"
                    style={{
                      top: `${(hour - startHour()) * 72}px`,
                      height: '72px'
                    }}
                  >
                    {/* Hour Label */}
                    <div class="w-16 flex-shrink-0 text-[10px] font-mono text-ci-1/40 pr-3 text-right pt-1 select-none">
                      {displayHour}
                    </div>

                    {/* Slot drop area */}
                    <div
                      onDragOver={onDragOver}
                      onDrop={(e) => onDrop(e, hour)}
                      onClick={() => onSlotClick(hour)}
                      class="flex-1 h-full hover:bg-surface-900/10 cursor-pointer transition-colors duration-100 relative"
                      title="Click to schedule"
                    >
                      <div class="absolute inset-0 border-t border-dashed border-surface-800/10 pointer-events-none group-hover:border-accent/10" />
                    </div>
                  </div>
                );
              }}
            </For>

            {/* Positioned Time Blocks overlay */}
            <For each={positionedBlocks()}>
              {({ block, style }) => {
                const sColor = () => blockStyles[block.block_kind] ?? blockStyles.task;
                const isDone = () => ['completed', 'skipped'].includes(block.status);
                const duration = Math.round((new Date(block.end_at).getTime() - new Date(block.start_at).getTime()) / 60_000);

                return (
                  <div
                    style={style}
                    onMouseDown={(e) => {
                      if ((e.target as HTMLElement).closest('button')) return;
                      e.stopPropagation();
                      e.preventDefault();
                      setDragBlock({
                        id: block.id,
                        startY: e.clientY,
                        startTop: style.top ? parseFloat(style.top) : 0,
                        startHeight: style.height ? parseFloat(style.height) : 28,
                        type: 'move'
                      });
                    }}
                    class={`group border rounded-lg overflow-hidden flex flex-col p-2 text-left shadow-sm transition-all duration-150 hover:shadow-md cursor-grab active:cursor-grabbing select-none
                      ${sColor().bg} ${sColor().border} ${sColor().text}
                      ${isDone() ? 'opacity-30 line-through' : ''}`}
                  >
                    {/* Colored indicator bar */}
                    <div class={`absolute left-0 top-0 bottom-0 w-1 ${sColor().accent}`} />
                    
                    <div class="pl-1.5 flex flex-col h-full justify-between">
                      <div class="min-w-0">
                        <div class="flex items-center gap-1.5 justify-between">
                          <span class="text-[10px] font-mono opacity-60">
                            {fmtTime(block.start_at)}–{fmtTime(block.end_at)}
                          </span>
                          <span class="text-[9px] font-mono opacity-50">{duration}m</span>
                        </div>
                        <div class="text-xs font-semibold leading-snug truncate mt-0.5" title={block.title}>
                          {block.title}
                        </div>
                      </div>

                      {/* Floating actions on hover */}
                      <Show when={!isDone()}>
                        <div class="opacity-0 group-hover:opacity-100 flex items-center justify-end gap-1 transition-opacity duration-100 mt-1 select-none">
                          <button
                            onClick={(e) => { e.stopPropagation(); updateBlockStatus(block.id, 'completed'); }}
                            class="p-0.5 rounded bg-surface-950/60 hover:bg-green-950 hover:text-green-400 text-ci-1/70"
                            title="Complete"
                          >
                            <CheckCircle size={12} />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); updateBlockStatus(block.id, 'skipped'); }}
                            class="p-0.5 rounded bg-surface-950/60 hover:bg-surface-700 text-ci-1/70"
                            title="Skip"
                          >
                            <SkipForward size={12} />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); deleteBlock(block.id); }}
                            class="p-0.5 rounded bg-surface-950/60 hover:bg-red-950 hover:text-red-400 text-ci-1/70"
                            title="Delete block"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      </Show>
                    </div>

                    {/* Resizing handle at the bottom edge */}
                    <Show when={!isDone()}>
                      <div
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          e.preventDefault();
                          setDragBlock({
                            id: block.id,
                            startY: e.clientY,
                            startTop: style.top ? parseFloat(style.top) : 0,
                            startHeight: style.height ? parseFloat(style.height) : 28,
                            type: 'resize'
                          });
                        }}
                        class="absolute bottom-0 left-0 right-0 h-2 cursor-ns-resize hover:bg-accent/40 z-20"
                      />
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </div>
      </div>
    </div>
  );
}
