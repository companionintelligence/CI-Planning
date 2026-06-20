import { createSignal, createEffect, Show, createResource, For } from 'solid-js';
import { Save, Cpu, Globe, CheckCircle2, XCircle, Brain, Link2, Unlink, RefreshCw } from 'lucide-solid';
import { prefs, refetchPrefs, showToast } from '../stores/index.js';
import { api } from '../lib/api.js';

const BROWSER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
})();
const ALL_TIMEZONES: string[] = (() => {
  try { return (Intl as any).supportedValuesOf?.('timeZone') ?? [BROWSER_TZ]; } catch { return [BROWSER_TZ]; }
})();

interface SettingsForm {
  workday_start: string; workday_end: string;
  max_focus_block_minutes: number; min_break_minutes: number;
  planning_mode: string; timezone: string; planning_horizon_days: number;
  fast_model: string; quality_model: string; embed_model: string;
  memory_sync_enabled: boolean; memory_sync_completed: boolean;
  memory_sync_habits: boolean; memory_sync_reflections: boolean;
}

const DEFAULTS: SettingsForm = {
  workday_start: '09:00', workday_end: '18:00',
  max_focus_block_minutes: 90, min_break_minutes: 10,
  planning_mode: 'ritual', timezone: BROWSER_TZ, planning_horizon_days: 3,
  fast_model: '', quality_model: '', embed_model: '',
  memory_sync_enabled: false, memory_sync_completed: true,
  memory_sync_habits: true, memory_sync_reflections: true,
};

export function Settings() {
  const [form, setForm] = createSignal<SettingsForm>({ ...DEFAULTS });

  createEffect(() => {
    const p = prefs();
    if (!p) return;
    setForm({
      workday_start:           p.workday_start ?? '09:00',
      workday_end:             p.workday_end ?? '18:00',
      max_focus_block_minutes: p.max_focus_block_minutes ?? 90,
      min_break_minutes:       p.min_break_minutes ?? 10,
      planning_mode:           p.planning_mode ?? 'ritual',
      timezone:                p.timezone ?? BROWSER_TZ,
      planning_horizon_days:   p.planning_horizon_days ?? 3,
      fast_model:              p.fast_model ?? '',
      quality_model:           p.quality_model ?? '',
      embed_model:             p.embed_model ?? '',
      memory_sync_enabled:     p.memory_sync_enabled ?? false,
      memory_sync_completed:   p.memory_sync_completed ?? true,
      memory_sync_habits:      p.memory_sync_habits ?? true,
      memory_sync_reflections: p.memory_sync_reflections ?? true,
    });
  });

  function setField<K extends keyof SettingsForm>(key: K, val: SettingsForm[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  async function save(e: Event) {
    e.preventDefault();
    try {
      // Empty model selection ⇒ null (use env default).
      const body = {
        ...form(),
        fast_model: form().fast_model || null,
        quality_model: form().quality_model || null,
        embed_model: form().embed_model || null,
      };
      await api.prefs.update(body);
      refetchPrefs();
      showToast('Settings saved', 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  const [integrations] = createResource(() => api.llm.integrations());
  const [memStatus, { refetch: refetchMem }] = createResource(() => api.memory.status());

  const ollamaModels = () => integrations()?.ollama.models ?? [];
  const ollamaUp = () => integrations()?.ollama.available ?? false;

  async function connectMemory() {
    if (!memStatus()?.available) {
      showToast('Companion Memory connection arrives with the auth phase (Phase I)', 'default');
      return;
    }
    // (Phase I) hand off to CI-Server sign-in here.
  }
  async function disconnectMemory() {
    try {
      await api.prefs.update({ memory_account: null });
      refetchPrefs(); refetchMem();
      showToast('Disconnected from Companion Memory', 'default');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function syncNow() {
    try {
      await api.memory.sync();
      refetchMem();
      showToast('Synced to Companion Memory', 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  const ModelSelect = (props: { label: string; hint: string; field: 'fast_model' | 'quality_model' | 'embed_model'; fallback?: string }) => (
    <label class="flex flex-col gap-1.5">
      <span class="text-xs text-muted-foreground">
        {props.label} <span class="opacity-70">· {props.hint}</span>
      </span>
      <select class="input" value={form()[props.field]} onChange={(e) => setField(props.field, e.currentTarget.value)}>
        <option value="">Default{props.fallback ? ` (${props.fallback})` : ''}</option>
        <For each={ollamaModels()}>{(m) => <option value={m}>{m}</option>}</For>
      </select>
    </label>
  );

  const ScopeCheck = (props: { label: string; field: 'memory_sync_completed' | 'memory_sync_habits' | 'memory_sync_reflections' }) => (
    <label class="flex items-center gap-2 text-sm cursor-pointer select-none"
      classList={{ 'opacity-40 pointer-events-none': !form().memory_sync_enabled }}>
      <input type="checkbox" class="accent-primary w-4 h-4"
        checked={form()[props.field]} onChange={(e) => setField(props.field, e.currentTarget.checked)} />
      <span class="text-foreground">{props.label}</span>
    </label>
  );

  return (
    <div class="flex-1 overflow-auto p-6 page-enter max-w-2xl mx-auto w-full">
      <h1 class="text-2xl font-bold text-slate-100 mb-6">Settings</h1>

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
                <span class="text-sm font-semibold text-slate-200 capitalize">{mode}</span>
                <span class="text-xs text-slate-500 text-center leading-snug">
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
              <span class="text-xs text-slate-500">Start</span>
              <input type="time" class="input" value={form().workday_start}
                onInput={e => setField('workday_start', e.currentTarget.value)} />
            </label>
            <label class="flex flex-col gap-1.5 flex-1">
              <span class="text-xs text-slate-500">End</span>
              <input type="time" class="input" value={form().workday_end}
                onInput={e => setField('workday_end', e.currentTarget.value)} />
            </label>
          </div>
          <label class="flex flex-col gap-1.5 mt-4">
            <span class="text-xs text-slate-500">Timezone — work hours are wall-clock here</span>
            <select class="input" value={form().timezone}
              onChange={e => setField('timezone', e.currentTarget.value)}>
              <For each={ALL_TIMEZONES}>{(tz) => <option value={tz}>{tz}</option>}</For>
            </select>
          </label>
        </section>

        {/* Block settings */}
        <section class="card">
          <div class="section-label mb-3">Block Settings</div>
          <div class="flex gap-4">
            <label class="flex flex-col gap-1.5 flex-1">
              <span class="text-xs text-slate-500">Max focus block (minutes)</span>
              <input type="number" class="input" min={15} max={240} step={15}
                value={form().max_focus_block_minutes}
                onInput={e => setField('max_focus_block_minutes', Number(e.currentTarget.value))} />
            </label>
            <label class="flex flex-col gap-1.5 flex-1">
              <span class="text-xs text-slate-500">Min break (minutes)</span>
              <input type="number" class="input" min={0} max={60} step={5}
                value={form().min_break_minutes}
                onInput={e => setField('min_break_minutes', Number(e.currentTarget.value))} />
            </label>
          </div>
          <label class="flex flex-col gap-1.5 mt-4">
            <span class="text-xs text-slate-500">Planning horizon (days) — how far ahead a dated task can be pulled into today</span>
            <input type="number" class="input" min={1} max={30} step={1}
              value={form().planning_horizon_days}
              onInput={e => setField('planning_horizon_days', Number(e.currentTarget.value))} />
          </label>
        </section>

        {/* Models */}
        <section class="card">
          <div class="section-label mb-3 flex items-center gap-1.5"><Cpu size={12} /> Models</div>
          <Show when={integrations()} fallback={<div class="text-xs text-muted-foreground animate-pulse2">Checking Ollama…</div>}>
            <Show
              when={ollamaUp()}
              fallback={
                <div class="flex items-center gap-2 text-xs text-destructive">
                  <XCircle size={13} /> Ollama unavailable — start it on localhost:11434 to choose models.
                </div>
              }
            >
              <div class="flex flex-col gap-4">
                <ModelSelect label="Fast model" hint="extraction & triage" field="fast_model" fallback={integrations()!.ollama.smallModel} />
                <ModelSelect label="Quality model" hint="briefings" field="quality_model" fallback={integrations()!.ollama.mediumModel} />
                <ModelSelect label="Embedding model" hint="dedupe" field="embed_model" fallback={integrations()!.ollama.embedModel} />
                <p class="text-[11px] text-muted-foreground">{ollamaModels().length} models installed · changes apply on Save.</p>
              </div>
            </Show>
          </Show>
        </section>

        {/* Companion Memory */}
        <section class="card">
          <div class="section-label mb-3 flex items-center gap-1.5"><Brain size={12} /> Companion Memory</div>

          {/* Master toggle */}
          <label class="flex items-start gap-3 cursor-pointer select-none">
            <button
              type="button"
              role="switch"
              aria-checked={form().memory_sync_enabled}
              onClick={() => setField('memory_sync_enabled', !form().memory_sync_enabled)}
              class="relative w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5"
              classList={{ 'bg-primary': form().memory_sync_enabled, 'bg-muted border border-border': !form().memory_sync_enabled }}
            >
              <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-card transition-transform"
                classList={{ 'translate-x-4': form().memory_sync_enabled }} />
            </button>
            <div class="flex-1">
              <div class="text-sm font-medium text-foreground">Sync with Companion Memory</div>
              <div class="text-xs text-muted-foreground mt-0.5">
                Your plan stays on this device. Turn this on to back it up and enrich it with your Companion Memory. One-way push.
              </div>
            </div>
          </label>

          {/* Connection + scopes (only meaningful when enabled) */}
          <Show when={form().memory_sync_enabled}>
            <div class="flex flex-col gap-3 mt-4 pt-4 border-t border-border">
              {/* Connection row */}
              <Show
                when={memStatus()?.connected}
                fallback={
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-xs text-muted-foreground">Not connected</span>
                    <button type="button" onClick={connectMemory} class="btn-secondary text-xs px-3 py-1.5">
                      <Link2 size={12} /> Connect
                    </button>
                  </div>
                }
              >
                <div class="flex items-center justify-between gap-3">
                  <span class="flex items-center gap-1.5 text-xs text-foreground">
                    <CheckCircle2 size={13} class="text-primary" /> Connected as {memStatus()!.account}
                  </span>
                  <button type="button" onClick={disconnectMemory} class="btn-ghost text-xs px-2 py-1">
                    <Unlink size={12} /> Disconnect
                  </button>
                </div>
              </Show>

              {/* What syncs */}
              <div class="flex flex-col gap-2">
                <span class="text-xs text-muted-foreground">What syncs</span>
                <ScopeCheck label="Completed tasks & time actuals" field="memory_sync_completed" />
                <ScopeCheck label="Habits & streaks" field="memory_sync_habits" />
                <ScopeCheck label="Daily reflections & briefings" field="memory_sync_reflections" />
              </div>

              {/* Status footer */}
              <div class="flex items-center justify-between gap-3 pt-1">
                <span class="text-[11px] text-muted-foreground">
                  <Show when={memStatus()?.lastSyncedAt} fallback="Never synced">
                    Last synced {new Date(memStatus()!.lastSyncedAt!).toLocaleString()}
                  </Show>
                  <Show when={!memStatus()?.available}> · connector arrives with the auth phase</Show>
                </span>
                <button type="button" onClick={syncNow} class="btn-secondary text-xs px-3 py-1.5"
                  disabled={!memStatus()?.connected}>
                  <RefreshCw size={12} /> Sync now
                </button>
              </div>
            </div>
          </Show>
        </section>

        {/* Integrations */}
        <section class="card">
          <div class="section-label mb-3">Integrations</div>
          <Show when={integrations()} fallback={<div class="text-xs text-slate-500 animate-pulse2">Checking…</div>}>
            {(i) => (
              <div class="flex flex-col gap-3">
                <div class="flex items-center gap-3">
                  <Cpu size={16} class={i().ollama.available ? 'text-green-400' : 'text-red-400'} />
                  <div class="flex-1">
                    <div class="text-sm text-slate-200 font-medium flex items-center gap-2">
                      Ollama
                      {i().ollama.available
                        ? <CheckCircle2 size={13} class="text-green-400" />
                        : <XCircle size={13} class="text-red-400" />}
                    </div>
                    <div class="text-xs text-slate-500 mt-0.5">
                      {i().ollama.available
                        ? `${i().ollama.models.length} models · small: ${i().ollama.smallModel} · medium: ${i().ollama.mediumModel}`
                        : 'Unavailable — start Ollama on localhost:11434'}
                    </div>
                  </div>
                </div>
                <div class="flex items-center gap-3">
                  <Globe size={16} class="text-blue-400" />
                  <div class="flex-1">
                    <div class="text-sm text-slate-200 font-medium">Google MCP</div>
                    <div class="text-xs text-slate-500 mt-0.5 capitalize">
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
