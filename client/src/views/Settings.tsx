import { createSignal, createEffect, Show, createResource, For } from 'solid-js';
import { Save, Cpu, Globe, CheckCircle2, XCircle, Trash2, Plus } from 'lucide-solid';
import { prefs, refetchPrefs, showToast, habits, refetchHabits } from '../stores/index.js';
import { api } from '../lib/api.js';

export function Settings() {
  const [form, setForm] = createSignal({
    workday_start: '09:00', workday_end: '18:00',
    max_focus_block_minutes: 90, min_break_minutes: 10,
    planning_mode: 'ritual',
    google_sync_enabled: false,
    google_calendar_id: 'primary',
  });

  const [newHabit, setNewHabit] = createSignal({
    title: '',
    duration_minutes: 30,
    start_time_earliest: '11:30',
    start_time_latest: '13:30',
    days_of_week: '1,2,3,4,5',
  });

  createEffect(() => {
    const p = prefs();
    if (!p) return;
    setForm({
      workday_start:           p.workday_start ?? '09:00',
      workday_end:             p.workday_end ?? '18:00',
      max_focus_block_minutes: p.max_focus_block_minutes ?? 90,
      min_break_minutes:       p.min_break_minutes ?? 10,
      planning_mode:           p.planning_mode ?? 'ritual',
      google_sync_enabled:     !!p.google_sync_enabled,
      google_calendar_id:      p.google_calendar_id ?? 'primary',
    });
  });

  function setField(key: string, val: string | number | boolean) {
    setForm(f => ({ ...f, [key]: val }));
  }

  async function save(e: Event) {
    e.preventDefault();
    try {
      await api.prefs.update(form());
      refetchPrefs();
      showToast('Settings saved', 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function addHabit(e: Event) {
    e.preventDefault();
    const h = newHabit();
    if (!h.title.trim()) return;

    try {
      await api.habits.create({
        title: h.title.trim(),
        duration_minutes: Number(h.duration_minutes),
        start_time_earliest: h.start_time_earliest,
        start_time_latest: h.start_time_latest,
        days_of_week: h.days_of_week,
      });
      showToast('Habit added', 'success');
      setNewHabit({
        title: '',
        duration_minutes: 30,
        start_time_earliest: '11:30',
        start_time_latest: '13:30',
        days_of_week: '1,2,3,4,5',
      });
      refetchHabits();
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  async function toggleHabit(id: number, currentEnabled: boolean) {
    try {
      await api.habits.update(id, { enabled: !currentEnabled });
      refetchHabits();
      showToast('Habit updated', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  async function removeHabit(id: number) {
    try {
      await api.habits.delete(id);
      refetchHabits();
      showToast('Habit deleted', 'default');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  const [integrations] = createResource(() => api.llm.integrations());

  return (
    <div class="flex-1 overflow-auto p-6 page-enter max-w-2xl mx-auto w-full">
      <h1 class="text-2xl font-heading font-bold text-ci-1 tracking-wide mb-6">Settings</h1>

      <form onSubmit={save} class="flex flex-col gap-5">
        {/* Planning mode */}
        <section class="card">
          <div class="section-label mb-3">Planning Mode</div>
          <div class="flex gap-3">
            {(['auto', 'ritual'] as const).map((mode) => (
              <label
                class={`flex-1 flex flex-col items-center gap-2 p-4 rounded-xl border cursor-pointer transition-all duration-150
                  ${form().planning_mode === mode
                    ? 'border-accent bg-accent/10 shadow-glow-accent'
                    : 'border-surface-600 hover:border-surface-500'}`}
              >
                <input
                  type="radio" class="sr-only" value={mode}
                  checked={form().planning_mode === mode}
                  onChange={() => setField('planning_mode', mode)}
                />
                <span class="text-2xl">{mode === 'auto' ? '⚡' : '🌅'}</span>
                <span class="text-sm font-semibold text-ci-1 capitalize">{mode}</span>
                <span class="text-xs text-ci-1/60 text-center leading-snug">
                  {mode === 'auto' ? 'AI plans your day automatically' : 'Guided morning ritual'}
                </span>
              </label>
            ))}
          </div>
        </section>

        {/* Work hours */}
        <section class="card">
          <div class="section-label mb-3">Work Hours</div>
          <div class="flex gap-4">
            <label class="flex flex-col gap-1.5 flex-1">
              <span class="text-xs text-ci-1/60">Start</span>
              <input type="time" class="input" value={form().workday_start}
                onInput={e => setField('workday_start', e.currentTarget.value)} />
            </label>
            <label class="flex flex-col gap-1.5 flex-1">
              <span class="text-xs text-ci-1/60">End</span>
              <input type="time" class="input" value={form().workday_end}
                onInput={e => setField('workday_end', e.currentTarget.value)} />
            </label>
          </div>
        </section>

        {/* Block settings */}
        <section class="card">
          <div class="section-label mb-3">Block Settings</div>
          <div class="flex gap-4">
            <label class="flex flex-col gap-1.5 flex-1">
              <span class="text-xs text-ci-1/60">Max focus block (minutes)</span>
              <input type="number" class="input" min={15} max={240} step={15}
                value={form().max_focus_block_minutes}
                onInput={e => setField('max_focus_block_minutes', Number(e.currentTarget.value))} />
            </label>
            <label class="flex flex-col gap-1.5 flex-1">
              <span class="text-xs text-ci-1/60">Min break (minutes)</span>
              <input type="number" class="input" min={0} max={60} step={5}
                value={form().min_break_minutes}
                onInput={e => setField('min_break_minutes', Number(e.currentTarget.value))} />
            </label>
          </div>
        </section>

        {/* Integrations */}
        <section class="card">
          <div class="section-label mb-3">Integrations</div>
          <Show when={integrations()} fallback={<div class="text-xs text-ci-1/60 animate-pulse2">Checking…</div>}>
            {(i) => (
              <div class="flex flex-col gap-3">
                <div class="flex items-center gap-3">
                  <Cpu size={16} class={i().ollama.available ? 'text-green-400' : 'text-red-400'} />
                  <div class="flex-1">
                    <div class="text-sm text-ci-1 font-medium flex items-center gap-2">
                      Ollama
                      {i().ollama.available
                        ? <CheckCircle2 size={13} class="text-green-400" />
                        : <XCircle size={13} class="text-red-400" />}
                    </div>
                    <div class="text-xs text-ci-1/60 mt-0.5">
                      {i().ollama.available
                        ? `${i().ollama.models.length} models · small: ${i().ollama.smallModel} · medium: ${i().ollama.mediumModel}`
                        : 'Unavailable — start Ollama on localhost:11434'}
                    </div>
                  </div>
                </div>
                <div class="flex flex-col gap-3">
                  <div class="flex items-center gap-3">
                    <Globe size={16} class="text-blue-400" />
                    <div class="flex-1">
                      <div class="text-sm text-ci-1 font-medium">Google MCP</div>
                      <div class="text-xs text-ci-1/60 mt-0.5 capitalize">
                        Mode: {i().google.mode} · Gmail + Google Calendar
                      </div>
                    </div>
                  </div>
                  <div class="pl-7 border-l border-surface-700/60 flex flex-col gap-3">
                    <label class="flex items-center gap-3 cursor-pointer">
                      <input
                        type="checkbox"
                        class="checkbox"
                        checked={form().google_sync_enabled}
                        onChange={(e) => setField('google_sync_enabled', e.currentTarget.checked)}
                      />
                      <div class="select-none">
                        <div class="text-xs font-semibold text-ci-1">Enable 2-Way Google Calendar Sync</div>
                        <div class="text-[10px] text-ci-1/50">Writes calendar changes back to your Google account</div>
                      </div>
                    </label>

                    <Show when={form().google_sync_enabled}>
                      <label class="flex flex-col gap-1.5 max-w-xs animate-slide-down">
                        <span class="text-[10px] font-mono text-ci-1/60">Google Calendar ID</span>
                        <input
                          type="text"
                          class="input py-1 text-xs"
                          value={form().google_calendar_id}
                          onInput={(e) => setField('google_calendar_id', e.currentTarget.value)}
                          placeholder="e.g. primary or email@gmail.com"
                        />
                      </label>
                    </Show>
                  </div>
                </div>
              </div>
            )}
          </Show>
        </section>

        {/* Flexible Habits & Routines */}
        <section class="card">
          <div class="section-label mb-3">Flexible Habits & Routines</div>
          <p class="text-xs text-ci-1/60 mb-4 select-none">
            Routines like lunch or exercise are scheduled automatically within these flexible windows, only locking when calendar boundaries are reached.
          </p>

          {/* List current habits */}
          <div class="flex flex-col gap-2 mb-5">
            <Show when={(habits() ?? []).length > 0} fallback={
              <div class="text-center py-4 text-xs text-ci-1/40 italic select-none">No habits configured yet</div>
            }>
              <For each={habits()}>
                {(h) => (
                  <div class="flex items-center justify-between p-3 rounded-lg bg-surface-950/40 border border-surface-750/50">
                    <div>
                      <div class="text-xs font-semibold text-ci-1 flex items-center gap-2">
                        {h.title}
                        <span class="text-[10px] font-mono opacity-50 font-normal">({h.duration_minutes} mins)</span>
                      </div>
                      <div class="text-[11px] text-ci-1/50 mt-1 font-mono select-none">
                        Window: {h.start_time_earliest} – {h.start_time_latest} · Days: {h.days_of_week === '1,2,3,4,5' ? 'Weekdays' : h.days_of_week === '0,6' ? 'Weekends' : 'All days'}
                      </div>
                    </div>
                    
                    <div class="flex items-center gap-3">
                      <label class="flex items-center gap-1.5 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={h.enabled}
                          onChange={() => toggleHabit(h.id, h.enabled)}
                          class="checkbox"
                        />
                        <span class="text-xs text-ci-1/60 select-none">Enabled</span>
                      </label>
                      <button
                        type="button"
                        onClick={() => removeHabit(h.id)}
                        class="p-1 text-ci-1/40 hover:text-red-400 rounded transition-colors"
                        title="Delete Habit"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                )}
              </For>
            </Show>
          </div>

          {/* Form to create new habit */}
          <div class="p-4 rounded-lg bg-surface-900 border border-surface-700/50 flex flex-col gap-3">
            <div class="text-xs font-heading font-bold text-ci-1 tracking-wider uppercase select-none">Add Routine Block</div>
            <div class="grid grid-cols-2 gap-3">
              <label class="flex flex-col gap-1.5 col-span-2">
                <span class="text-[10px] font-mono text-ci-1/50 select-none">Title</span>
                <input
                  type="text"
                  placeholder="e.g. Lunch, Gym, Reading"
                  class="input text-xs"
                  value={newHabit().title}
                  onInput={(e) => setNewHabit(prev => ({ ...prev, title: e.currentTarget.value }))}
                />
              </label>

              <label class="flex flex-col gap-1.5">
                <span class="text-[10px] font-mono text-ci-1/50 select-none">Duration (mins)</span>
                <input
                  type="number"
                  class="input text-xs"
                  min={15}
                  step={15}
                  value={newHabit().duration_minutes}
                  onInput={(e) => setNewHabit(prev => ({ ...prev, duration_minutes: Number(e.currentTarget.value) }))}
                />
              </label>

              <label class="flex flex-col gap-1.5">
                <span class="text-[10px] font-mono text-ci-1/50 select-none">Days</span>
                <select
                  class="select text-xs"
                  value={newHabit().days_of_week}
                  onChange={(e) => setNewHabit(prev => ({ ...prev, days_of_week: e.currentTarget.value }))}
                >
                  <option value="1,2,3,4,5">Weekdays</option>
                  <option value="0,6">Weekends</option>
                  <option value="0,1,2,3,4,5,6">Every Day</option>
                </select>
              </label>

              <label class="flex flex-col gap-1.5">
                <span class="text-[10px] font-mono text-ci-1/50 select-none">Earliest start</span>
                <input
                  type="time"
                  class="input text-xs"
                  value={newHabit().start_time_earliest}
                  onInput={(e) => setNewHabit(prev => ({ ...prev, start_time_earliest: e.currentTarget.value }))}
                />
              </label>

              <label class="flex flex-col gap-1.5">
                <span class="text-[10px] font-mono text-ci-1/50 select-none">Latest start</span>
                <input
                  type="time"
                  class="input text-xs"
                  value={newHabit().start_time_latest}
                  onInput={(e) => setNewHabit(prev => ({ ...prev, start_time_latest: e.currentTarget.value }))}
                />
              </label>
            </div>

            <button
              type="button"
              onClick={addHabit}
              disabled={!newHabit().title.trim()}
              class="btn-primary self-start text-xs py-1.5 px-3 mt-1"
            >
              <Plus size={12} /> Add Habit
            </button>
          </div>
        </section>

        <button type="submit" class="btn-primary self-start px-5 mt-2">
          <Save size={14} /> Save Settings
        </button>
      </form>
    </div>
  );
}
