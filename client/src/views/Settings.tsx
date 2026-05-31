import { createSignal, createEffect, Show } from 'solid-js';
import { prefs, refetchPrefs } from '../stores/index.js';
import { api } from '../lib/api.js';

export function Settings() {
  const [form, setForm] = createSignal({
    workday_start: '09:00',
    workday_end: '18:00',
    max_focus_block_minutes: 90,
    min_break_minutes: 10,
    planning_mode: 'ritual',
  });
  const [saved, setSaved] = createSignal(false);

  createEffect(() => {
    const p = prefs();
    if (!p) return;
    setForm({
      workday_start: p.workday_start ?? '09:00',
      workday_end: p.workday_end ?? '18:00',
      max_focus_block_minutes: p.max_focus_block_minutes ?? 90,
      min_break_minutes: p.min_break_minutes ?? 10,
      planning_mode: p.planning_mode ?? 'ritual',
    });
  });

  function setField(key: string, val: string | number) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  async function save(e: Event) {
    e.preventDefault();
    await api.prefs.update(form());
    refetchPrefs();
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div class="flex-1 overflow-auto p-6 max-w-2xl mx-auto w-full">
      <h1 class="text-2xl font-semibold text-slate-100 mb-6">Settings</h1>

      <form onSubmit={save} class="flex flex-col gap-6">
        {/* Planning mode */}
        <section class="card">
          <h2 class="text-sm font-semibold text-slate-300 mb-4">Planning Mode</h2>
          <div class="flex gap-3">
            {(['auto', 'ritual'] as const).map((mode) => (
              <label class={`flex-1 flex flex-col items-center gap-2 p-4 rounded-lg border cursor-pointer transition-colors
                ${form().planning_mode === mode ? 'border-accent-500 bg-accent-600/10' : 'border-surface-600 hover:border-surface-500'}`}>
                <input type="radio" class="sr-only" value={mode} checked={form().planning_mode === mode}
                  onChange={() => setField('planning_mode', mode)} />
                <span class="text-xl">{mode === 'auto' ? '⚡' : '🌅'}</span>
                <span class="text-sm font-medium capitalize text-slate-200">{mode}</span>
                <span class="text-xs text-slate-500 text-center">
                  {mode === 'auto' ? 'AI plans your day automatically' : 'Guided morning ritual'}
                </span>
              </label>
            ))}
          </div>
        </section>

        {/* Work hours */}
        <section class="card">
          <h2 class="text-sm font-semibold text-slate-300 mb-4">Work Hours</h2>
          <div class="flex gap-4">
            <label class="flex flex-col gap-1.5 flex-1">
              <span class="text-xs text-slate-500">Start</span>
              <input type="time" class="input" value={form().workday_start}
                onInput={(e) => setField('workday_start', e.currentTarget.value)} />
            </label>
            <label class="flex flex-col gap-1.5 flex-1">
              <span class="text-xs text-slate-500">End</span>
              <input type="time" class="input" value={form().workday_end}
                onInput={(e) => setField('workday_end', e.currentTarget.value)} />
            </label>
          </div>
        </section>

        {/* Block settings */}
        <section class="card">
          <h2 class="text-sm font-semibold text-slate-300 mb-4">Block Settings</h2>
          <div class="flex gap-4">
            <label class="flex flex-col gap-1.5 flex-1">
              <span class="text-xs text-slate-500">Max focus block (minutes)</span>
              <input type="number" class="input" min={15} max={240} step={15}
                value={form().max_focus_block_minutes}
                onInput={(e) => setField('max_focus_block_minutes', Number(e.currentTarget.value))} />
            </label>
            <label class="flex flex-col gap-1.5 flex-1">
              <span class="text-xs text-slate-500">Min break (minutes)</span>
              <input type="number" class="input" min={0} max={60} step={5}
                value={form().min_break_minutes}
                onInput={(e) => setField('min_break_minutes', Number(e.currentTarget.value))} />
            </label>
          </div>
        </section>

        <div class="flex items-center gap-3">
          <button type="submit" class="btn-primary">Save Settings</button>
          <Show when={saved()}>
            <span class="text-green-400 text-sm">✓ Saved</span>
          </Show>
        </div>
      </form>
    </div>
  );
}
