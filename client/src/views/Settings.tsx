import { createSignal, createEffect, Show, createResource, For } from 'solid-js';
import { Save, Cpu, Globe, CheckCircle2, XCircle, Brain, Link2, Unlink, RefreshCw, Star, Pentagon, Shapes, Plus, Trash2, Tags } from 'lucide-solid';
import { prefs, refetchPrefs, showToast } from '../stores/index.js';
import { api } from '../lib/api.js';
import { PatternTypeSettings } from '../components/PatternTypeSettings.js';
import { DEFAULT_CONCEPT_TAGS, type ConceptTag } from '../lib/pattern-meta.js';

const BROWSER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
})();
const ALL_TIMEZONES: string[] = (() => {
  try { return (Intl as any).supportedValuesOf?.('timeZone') ?? [BROWSER_TZ]; } catch { return [BROWSER_TZ]; }
})();

interface SettingsForm {
  workday_start: string; workday_end: string;
  auto_fill_workday: boolean;
  max_focus_block_minutes: number; min_break_minutes: number;
  max_time_block_minutes: number; min_time_block_minutes: number;
  // Plan/Concept Time-Block config. Plan horizon = planning_horizon_days.
  plan_allday_always: boolean; plan_daylong_for_promoted: boolean; plan_autofill_gaps: boolean;
  concept_default_minutes: number; concept_autosurface: boolean; concept_horizon_days: number;
  concept_tags: ConceptTag[];
  timezone: string; planning_horizon_days: number;
  fast_model: string; quality_model: string; embed_model: string;
  memory_sync_enabled: boolean; memory_sync_completed: boolean;
  memory_sync_habits: boolean; memory_sync_reflections: boolean;
}

/** The boolean fields of the form — for the reusable Toggle. */
type BoolField =
  | 'auto_fill_workday' | 'plan_allday_always' | 'plan_daylong_for_promoted' | 'plan_autofill_gaps' | 'concept_autosurface';

const DEFAULTS: SettingsForm = {
  workday_start: '09:00', workday_end: '18:00',
  auto_fill_workday: true,
  max_focus_block_minutes: 90, min_break_minutes: 10,
  max_time_block_minutes: 240, min_time_block_minutes: 15,
  plan_allday_always: false, plan_daylong_for_promoted: false, plan_autofill_gaps: true,
  concept_default_minutes: 60, concept_autosurface: true, concept_horizon_days: 30,
  concept_tags: DEFAULT_CONCEPT_TAGS.map((c) => ({ ...c })),
  timezone: BROWSER_TZ, planning_horizon_days: 3,
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
      auto_fill_workday:       p.auto_fill_workday ?? true,
      max_focus_block_minutes: p.max_focus_block_minutes ?? 90,
      min_break_minutes:       p.min_break_minutes ?? 10,
      max_time_block_minutes:  p.max_time_block_minutes ?? 240,
      min_time_block_minutes:  p.min_time_block_minutes ?? 15,
      plan_allday_always:        p.plan_allday_always ?? false,
      plan_daylong_for_promoted: p.plan_daylong_for_promoted ?? false,
      plan_autofill_gaps:        p.plan_autofill_gaps ?? true,
      concept_default_minutes:   p.concept_default_minutes ?? 60,
      concept_autosurface:       p.concept_autosurface ?? true,
      concept_horizon_days:      p.concept_horizon_days ?? 30,
      concept_tags:              p.concept_tags?.length ? p.concept_tags.map((c) => ({ ...c })) : DEFAULT_CONCEPT_TAGS.map((c) => ({ ...c })),
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

  // A small switch bound to a boolean form field.
  const Toggle = (props: { field: BoolField; label: string; hint?: string }) => (
    <label class="flex items-start gap-2 cursor-pointer select-none">
      <button type="button" role="switch" aria-checked={form()[props.field]}
        onClick={() => setField(props.field, !form()[props.field])}
        class="relative w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5"
        classList={{ 'bg-primary': form()[props.field], 'bg-muted border border-border': !form()[props.field] }}>
        <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-card transition-transform"
          classList={{ 'translate-x-4': form()[props.field] }} />
      </button>
      <div>
        <div class="text-sm text-foreground leading-tight">{props.label}</div>
        <Show when={props.hint}><div class="text-[11px] text-muted-foreground">{props.hint}</div></Show>
      </div>
    </label>
  );

  // Concept default duration is stored as total minutes; entered as Days/Hours/Minutes.
  const cdm = () => form().concept_default_minutes;
  const setCdm = (d: number, h: number, m: number) => setField('concept_default_minutes', d * 1440 + h * 60 + m);
  const cDays = () => Math.floor(cdm() / 1440);
  const cHrs = () => Math.floor((cdm() % 1440) / 60);
  const cMin = () => cdm() % 60;

  // Canonical concept-tag list editor (the Block Wizard starts from this).
  function updateCT(i: number, patch: Partial<ConceptTag>) {
    setForm((f) => ({ ...f, concept_tags: f.concept_tags.map((c, idx) => (idx === i ? { ...c, ...patch } : c)) }));
  }
  function removeCT(i: number) {
    setForm((f) => ({ ...f, concept_tags: f.concept_tags.filter((_, idx) => idx !== i) }));
  }
  function addCT() {
    setForm((f) => ({ ...f, concept_tags: [...f.concept_tags, { name: 'New', minutes: 60 }] }));
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
          <div class="mt-4">
            <Toggle field="auto_fill_workday" label="Fill the workday with leftovers"
              hint="Auto fills your tagged Plans first. With this on, tasks that match no Plan also fill open work hours. Off → Auto only fills the Plans you drew." />
          </div>
          <label class="flex flex-col gap-1.5 mt-4">
            <span class="text-xs text-slate-500">Timezone — work hours are wall-clock here</span>
            <select class="input" value={form().timezone}
              onChange={e => setField('timezone', e.currentTarget.value)}>
              <For each={ALL_TIMEZONES}>{(tz) => <option value={tz}>{tz}</option>}</For>
            </select>
          </label>
        </section>

        {/* Time-Block settings — Plan | Concept */}
        <section class="card">
          <div class="section-label mb-3">Time-Block Settings</div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">

            {/* ── PLAN ── scheduled (set time + duration) */}
            <div class="rounded-xl border border-border p-3 flex flex-col gap-3">
              <div class="flex items-center justify-between">
                <span class="text-sm font-semibold text-foreground">Plan</span>
                <Star size={15} class="text-primary" />
              </div>
              <div class="border-t-[3px] border-primary" />
              <p class="text-[11px] text-muted-foreground -mt-1.5">Scheduled — set time + duration.</p>

              <div class="flex gap-3">
                <label class="flex flex-col gap-1 flex-1">
                  <span class="text-[11px] text-muted-foreground">Max (min)</span>
                  <input type="number" class="input py-1 text-sm" min={15} max={1440} step={15}
                    value={form().max_time_block_minutes} onInput={e => setField('max_time_block_minutes', Number(e.currentTarget.value))} />
                </label>
                <label class="flex flex-col gap-1 flex-1">
                  <span class="text-[11px] text-muted-foreground">Min (min)</span>
                  <input type="number" class="input py-1 text-sm" min={5} max={240} step={5}
                    value={form().min_time_block_minutes} onInput={e => setField('min_time_block_minutes', Number(e.currentTarget.value))} />
                </label>
              </div>

              <Toggle field="plan_allday_always" label="All-day Plans" hint="Always allow creating all-day Plans." />
              <Toggle field="plan_daylong_for_promoted" label="Day-long when promoted" hint="A promoted Concept becomes a day-long Plan." />

              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-muted-foreground">Planning horizon (days)</span>
                <input type="number" class="input py-1 text-sm" min={1} max={60} step={1}
                  value={form().planning_horizon_days} onInput={e => setField('planning_horizon_days', Number(e.currentTarget.value))} />
              </label>

              <div class="pt-2 border-t border-border mt-auto">
                <div class="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Autoscheduling</div>
                <Toggle field="plan_autofill_gaps" label="Auto-fill free gaps" hint="Let Auto place Plans into open time." />
                <div class="flex gap-3 mt-2">
                  <label class="flex flex-col gap-1 flex-1">
                    <span class="text-[11px] text-muted-foreground">Max focus (min)</span>
                    <input type="number" class="input py-1 text-sm" min={15} max={240} step={15}
                      value={form().max_focus_block_minutes} onInput={e => setField('max_focus_block_minutes', Number(e.currentTarget.value))} />
                  </label>
                  <label class="flex flex-col gap-1 flex-1">
                    <span class="text-[11px] text-muted-foreground">Min break (min)</span>
                    <input type="number" class="input py-1 text-sm" min={0} max={60} step={5}
                      value={form().min_break_minutes} onInput={e => setField('min_break_minutes', Number(e.currentTarget.value))} />
                  </label>
                </div>
              </div>
            </div>

            {/* ── CONCEPT ── unscheduled goal (start day + duration) */}
            <div class="rounded-xl border border-border p-3 flex flex-col gap-3">
              <div class="flex items-center justify-between">
                <span class="text-sm font-semibold text-foreground">Concept</span>
                <Pentagon size={15} class="text-muted-foreground" />
              </div>
              <div class="border-t-2 border-dashed border-muted-foreground" />
              <p class="text-[11px] text-muted-foreground -mt-1.5">A goal — start day + duration, no set time.</p>

              <div>
                <span class="text-[11px] text-muted-foreground">Default duration</span>
                <div class="flex gap-2 mt-1">
                  <label class="flex flex-col gap-0.5 flex-1">
                    <input type="number" class="input py-1 text-sm" min={0} max={60} value={cDays()} onInput={e => setCdm(Number(e.currentTarget.value) || 0, cHrs(), cMin())} />
                    <span class="text-[10px] text-muted-foreground text-center">days</span>
                  </label>
                  <label class="flex flex-col gap-0.5 flex-1">
                    <input type="number" class="input py-1 text-sm" min={0} max={23} value={cHrs()} onInput={e => setCdm(cDays(), Number(e.currentTarget.value) || 0, cMin())} />
                    <span class="text-[10px] text-muted-foreground text-center">hrs</span>
                  </label>
                  <label class="flex flex-col gap-0.5 flex-1">
                    <input type="number" class="input py-1 text-sm" min={0} max={55} step={5} value={cMin()} onInput={e => setCdm(cDays(), cHrs(), Number(e.currentTarget.value) || 0)} />
                    <span class="text-[10px] text-muted-foreground text-center">min</span>
                  </label>
                </div>
              </div>

              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-muted-foreground">Planning horizon (days)</span>
                <input type="number" class="input py-1 text-sm" min={1} max={365} step={1}
                  value={form().concept_horizon_days} onInput={e => setField('concept_horizon_days', Number(e.currentTarget.value))} />
              </label>

              <div class="pt-2 border-t border-border mt-auto">
                <div class="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Autoscheduling</div>
                <Toggle field="concept_autosurface" label="Surface on goal day" hint="Show the Concept on its goal start day." />
              </div>
            </div>

          </div>
        </section>

        {/* Concept Tags — the canonical Block-Wizard list */}
        <section class="card">
          <div class="section-label mb-3 flex items-center gap-1.5"><Tags size={12} /> Concept Tags</div>
          <p class="text-xs text-muted-foreground mb-3">The canonical list the Block Wizard starts from — each is a title/tag with a default estimate. Saved with the rest of Settings.</p>
          <div class="flex flex-col gap-2">
            <For each={form().concept_tags}>
              {(ct, i) => (
                <div class="flex items-center gap-2">
                  <input class="input py-1 text-sm flex-1" value={ct.name} onInput={(e) => updateCT(i(), { name: e.currentTarget.value })} />
                  <input type="number" min="5" step="5" class="input py-1 text-sm w-20" value={ct.minutes} onInput={(e) => updateCT(i(), { minutes: Number(e.currentTarget.value) || 0 })} />
                  <span class="text-[11px] text-muted-foreground">min</span>
                  <button type="button" onClick={() => removeCT(i())} class="btn-icon hover:text-destructive" title="Remove"><Trash2 size={13} /></button>
                </div>
              )}
            </For>
          </div>
          <button type="button" onClick={addCT} class="btn-secondary text-xs px-2.5 py-1 mt-2"><Plus size={12} /> Add tag</button>
        </section>

        {/* Pattern settings */}
        <section class="card">
          <div class="section-label mb-3 flex items-center gap-1.5"><Shapes size={12} /> Pattern Settings</div>
          <p class="text-xs text-muted-foreground mb-3">Each category's default shape, colour, estimate, and reminders. Colours come from the shared theme palette; reminders fire in a later phase.</p>
          <PatternTypeSettings />
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
