import { createSignal, Show, For } from 'solid-js';
import { ChevronLeft, ChevronRight, Zap } from 'lucide-solid';
import { blocks, blockRange, setBlockRange, refetchBlocks } from '../stores/index.js';
import { BlockCard } from '../components/BlockCard.js';
import { api } from '../lib/api.js';
import { showToast } from '../stores/index.js';
import { localISODate } from '../lib/dates.js';

// Date-string arithmetic below pivots on noon UTC, which is timezone-safe;
// only "what day is it right now" must use the user's local timezone.
function isoDate(d: Date) { return d.toISOString().slice(0, 10); }
function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

export function Calendar() {
  const [selectedDate, setSelectedDate] = createSignal(localISODate());
  const [runningSchedule, setRunningSchedule] = createSignal(false);

  function selectDate(d: string) {
    setSelectedDate(d);
    setBlockRange({ from: `${d}T00:00:00.000Z`, to: `${d}T23:59:59.000Z` });
  }

  const dayBlocks = () =>
    (blocks() ?? []).sort((a, b) => a.start_at.localeCompare(b.start_at));

  async function runSchedule() {
    setRunningSchedule(true);
    try {
      await api.schedule.run(selectedDate());
      showToast('Day scheduled', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally { setRunningSchedule(false); }
  }

  const weekDays = () => {
    const today = localISODate();
    const d = new Date(today + 'T12:00:00Z');
    const dow = d.getUTCDay();
    const monday = addDays(today, -(dow === 0 ? 6 : dow - 1));
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  };

  function shiftWeek(n: number) {
    const cur = selectedDate();
    selectDate(addDays(cur, n * 7));
  }

  return (
    <div class="flex-1 overflow-auto p-6 page-enter max-w-3xl mx-auto w-full">
      <div class="flex items-center justify-between mb-5">
        <h1 class="text-2xl font-bold text-slate-100">Calendar</h1>
        <button onClick={runSchedule} disabled={runningSchedule()} class="btn-primary">
          <Zap size={14} />
          {runningSchedule() ? 'Scheduling…' : 'Schedule Day'}
        </button>
      </div>

      {/* Week strip */}
      <div class="flex items-center gap-2 mb-5">
        <button onClick={() => shiftWeek(-1)} class="btn-icon"><ChevronLeft size={15} /></button>
        <div class="flex flex-1 gap-1 bg-surface-800 rounded-xl p-1 border border-surface-700/60">
          <For each={weekDays()}>
            {(d) => {
              const label = new Date(d + 'T12:00:00Z')
                .toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
              const isToday = d === isoDate(new Date());
              const isSelected = () => d === selectedDate();
              return (
                <button
                  onClick={() => selectDate(d)}
                  class={`flex-1 py-2 rounded-lg text-xs font-medium transition-all duration-100 text-center
                    ${isSelected()
                      ? 'bg-accent text-white shadow-sm shadow-accent/20'
                      : isToday
                        ? 'text-accent-light font-semibold hover:bg-surface-700'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-surface-700'}`}
                >
                  {label}
                </button>
              );
            }}
          </For>
        </div>
        <button onClick={() => shiftWeek(1)} class="btn-icon"><ChevronRight size={15} /></button>
      </div>

      {/* Block list */}
      <Show when={dayBlocks().length > 0} fallback={
        <div class="card text-center text-slate-500 py-12 text-sm">
          No blocks on {new Date(selectedDate() + 'T12:00:00Z')
            .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.
        </div>
      }>
        <div class="flex flex-col gap-2">
          <For each={dayBlocks()}>
            {(b) => <BlockCard block={b} onUpdated={refetchBlocks} />}
          </For>
        </div>
      </Show>
    </div>
  );
}
