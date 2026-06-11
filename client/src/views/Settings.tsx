import { createSignal, createEffect, Show, createResource } from 'solid-js';
import { Save, Cpu, Globe, CheckCircle2, XCircle } from 'lucide-solid';
import { prefs, refetchPrefs, showToast } from '../stores/index.js';
import { api } from '../lib/api.js';

export function Settings() {
  const [form, setForm] = createSignal({
    workday_start: '09:00', workday_end: '18:00',
    max_focus_block_minutes: 90, min_break_minutes: 10,
    planning_mode: 'ritual',
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
    });
  });

  function setField(key: string, val: string | number) {
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
                <div class="flex items-center gap-3">
                  <Globe size={16} class="text-blue-400" />
                  <div class="flex-1">
                    <div class="text-sm text-ci-1 font-medium">Google MCP</div>
                    <div class="text-xs text-ci-1/60 mt-0.5 capitalize">
                      Mode: {i().google.mode} · Gmail + Google Calendar
                    </div>
                  </div>
                </div>
              </div>
            )}
          </Show>
        </section>

        <button type="submit" class="btn-primary self-start px-5">
          <Save size={14} /> Save Settings
        </button>
      </form>
    </div>
  );
}
