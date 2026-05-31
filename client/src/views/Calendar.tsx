import { createSignal, Show, For } from 'solid-js';
import { blocks, blockRange, setBlockRange, refetchBlocks } from '../stores/index.js';
import { BlockCard } from '../components/BlockCard.js';
import { api } from '../lib/api.js';

function isoDate(d: Date) {
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr: string, n: number) {
  const d = new Date(dateStr + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return isoDate(d);
}

export function Calendar() {
  const [selectedDate, setSelectedDate] = createSignal(isoDate(new Date()));
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
    } finally {
      setRunningSchedule(false);
    }
  }

  // Build a 7-day week starting from current week's Monday
  const weekDays = () => {
    const today = isoDate(new Date());
    const d = new Date(today + 'T12:00:00Z');
    const dow = d.getUTCDay(); // 0=Sun
    const monday = addDays(today, -(dow === 0 ? 6 : dow - 1));
    return Array.from({ length: 7 }, (_, i) => addDays(monday, i));
  };

  return (
    <div class="flex-1 overflow-auto p-6 max-w-3xl mx-auto w-full">
      <div class="flex items-center justify-between mb-6">
        <h1 class="text-2xl font-semibold text-slate-100">Calendar</h1>
        <button onClick={runSchedule} disabled={runningSchedule()} class="btn-primary">
          {runningSchedule() ? 'Scheduling…' : '⚡ Schedule Day'}
        </button>
      </div>

      {/* Week strip */}
      <div class="flex gap-1 mb-6 bg-surface-800 rounded-lg p-1">
        <For each={weekDays()}>
          {(d) => {
            const label = new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'short', day: 'numeric' });
            const isToday = d === isoDate(new Date());
            const isSelected = () => d === selectedDate();
            return (
              <button
                onClick={() => selectDate(d)}
                class={`flex-1 py-2 px-1 rounded-md text-xs text-center transition-colors
                  ${isSelected() ? 'bg-accent-600 text-white' : 'text-slate-400 hover:text-slate-200 hover:bg-surface-700'}
                  ${isToday && !isSelected() ? 'text-accent-400 font-semibold' : ''}`}
              >
                {label}
              </button>
            );
          }}
        </For>
      </div>

      {/* Blocks for selected day */}
      <Show when={(dayBlocks().length) > 0} fallback={
        <div class="card text-center text-slate-500 py-12">
          No blocks on {new Date(selectedDate() + 'T12:00:00Z').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })}.
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
