import { createSignal, createEffect, Show, createResource, For } from 'solid-js';
import { Save, Cpu, Globe, CheckCircle2, XCircle, Brain, Link2, Unlink, RefreshCw, Star, Pentagon, Shapes, Plus, Trash2, Tags, X, ChevronUp, ChevronDown, Database, AlertTriangle } from 'lucide-solid';
import { prefs, refetchPrefs, tags, patternBlocks, patternPrefs, refetchPatternPrefs, showToast } from '../stores/index.js';
import { api } from '../lib/api.js';
import { PatternBlockSettings } from '../components/PatternBlockSettings.js';
import { RoutineTypeSettings } from '../components/RoutineTypeSettings.js';
import { ShapeIcon } from '../components/ShapeIcon.js';
import { DEFAULT_CONCEPT_TAGS, PATTERN_COLORS, colorVar, type ConceptTag } from '../lib/pattern-meta.js';
import { enablePush, disablePush, pushState } from '../lib/push.js';

const BROWSER_TZ = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
})();
const ALL_TIMEZONES: string[] = (() => {
  try { return (Intl as any).supportedValuesOf?.('timeZone') ?? [BROWSER_TZ]; } catch { return [BROWSER_TZ]; }
})();

interface SettingsForm {
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
  recall_keeps_pattern: boolean; // cockpit-v2 Phase 6
}

/** The boolean fields of the form — for the reusable Toggle. */
type BoolField =
  | 'auto_fill_workday' | 'plan_allday_always' | 'plan_daylong_for_promoted' | 'plan_autofill_gaps' | 'concept_autosurface' | 'recall_keeps_pattern';

const DEFAULTS: SettingsForm = {
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
  recall_keeps_pattern: false,
};

export function Settings() {
  const [form, setForm] = createSignal<SettingsForm>({ ...DEFAULTS });

  // ── Pattern-blocks local edit state ─────────────────────────────────────────
  const [dayTab, setDayTab] = createSignal<'workday' | 'weekend'>('workday');
  const [localWindows, setLocalWindows] = createSignal<Record<string, { start_time: string; end_time: string }[]>>({});

  let pbInitialized = false;
  createEffect(() => {
    const pb = patternBlocks();
    if (!pb || pbInitialized) return;
    pbInitialized = true;
    const out: Record<string, { start_time: string; end_time: string }[]> = {};
    for (const dt of ['workday', 'weekend'] as const) {
      for (const [dirTagId, ranges] of Object.entries(pb[dt])) {
        out[`${dt}:${dirTagId}`] = ranges.map((r) => ({ start_time: r.start_time, end_time: r.end_time }));
      }
    }
    setLocalWindows(out);
  });

  function pbKey(dirTagId: string) { return `${dayTab()}:${dirTagId}`; }
  function getRanges(dirTagId: string) { return localWindows()[pbKey(dirTagId)] ?? []; }
  function addRange(dirTagId: string) {
    setLocalWindows((w) => ({ ...w, [pbKey(dirTagId)]: [...getRanges(dirTagId), { start_time: '09:00', end_time: '17:00' }] }));
  }
  function removeRange(dirTagId: string, idx: number) {
    setLocalWindows((w) => ({ ...w, [pbKey(dirTagId)]: getRanges(dirTagId).filter((_, i) => i !== idx) }));
  }
  function updateRange(dirTagId: string, idx: number, field: 'start_time' | 'end_time', val: string) {
    setLocalWindows((w) => ({
      ...w,
      [pbKey(dirTagId)]: getRanges(dirTagId).map((r, i) => (i === idx ? { ...r, [field]: val } : r)),
    }));
  }
  async function savePatternWindows(dirTagId: string) {
    try {
      await api.patternBlocks.set(dirTagId, dayTab(), getRanges(dirTagId));
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // ── Pattern-tag default estimate (pattern_prefs.default_minutes) ──────────────
  // The fallback minutes a pattern tag contributes when a task has no intention tag.
  const patternTagsList = () => (tags() ?? []).filter((t) => t.kind === 'pattern');
  const [patternMinutes, setPatternMinutes] = createSignal<Record<string, number>>({});
  let pmInitialized = false;
  createEffect(() => {
    const pp = patternPrefs()?.prefs;
    const ts = tags();
    if (!pp || !ts || pmInitialized) return;
    pmInitialized = true;
    const init: Record<string, number> = {};
    for (const t of ts.filter((x) => x.kind === 'pattern')) init[t.id] = pp[t.id]?.default_minutes ?? 60;
    setPatternMinutes(init);
  });

  createEffect(() => {
    const p = prefs();
    if (!p) return;
    setForm({
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
      recall_keeps_pattern:    p.recall_keeps_pattern ?? false,
      memory_sync_enabled:     p.memory_sync_enabled ?? false,
      memory_sync_completed:   p.memory_sync_completed ?? true,
      memory_sync_habits:      p.memory_sync_habits ?? true,
      memory_sync_reflections: p.memory_sync_reflections ?? true,
    });
  });

  function setField<K extends keyof SettingsForm>(key: K, val: SettingsForm[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  // ── Per-pattern fill toggle (pattern_prefs.auto_fill) ────────────────────────
  const patternFill = (tagId: string) => patternPrefs()?.prefs?.[tagId]?.auto_fill ?? true;
  async function togglePatternFill(tagId: string) {
    try {
      await api.patternPrefs.set(tagId, { auto_fill: !patternFill(tagId) });
      refetchPatternPrefs();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // ── Schedule Patterns save — flush every edited availability window at once ────
  async function saveSchedulePatterns() {
    try {
      await Promise.all(Object.entries(localWindows()).map(([key, ranges]) => {
        const idx = key.indexOf(':');
        return api.patternBlocks.set(key.slice(idx + 1), key.slice(0, idx), ranges);
      }));
      showToast('Schedule patterns saved', 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // ── Reminder Defaults — ONE shared config for all pattern tags (Home/Community/Work).
  // Start-time reminder (offset 0) + an optional advance reminder (offset = minutes).
  // Persisted to every pattern tag's pattern_prefs.reminder_offsets identically.
  const [remStartOn, setRemStartOn] = createSignal(false);
  const [remAdvOn, setRemAdvOn] = createSignal(false);
  const [remAdvMin, setRemAdvMin] = createSignal(15);
  let remInitialized = false;
  createEffect(() => {
    const pp = patternPrefs()?.prefs;
    const ts = tags();
    if (!pp || !ts || remInitialized) return;
    remInitialized = true;
    const first = ts.find((t) => t.kind === 'pattern');
    const offsets = first ? (pp[first.id]?.reminder_offsets ?? []) : [];
    setRemStartOn(offsets.includes(0));
    const adv = offsets.find((o) => o > 0);
    setRemAdvOn(adv != null);
    if (adv != null) setRemAdvMin(adv);
  });
  async function saveReminderDefaults() {
    const offsets = [
      ...(remStartOn() ? [0] : []),
      ...(remAdvOn() && remAdvMin() > 0 ? [remAdvMin()] : []),
    ];
    try {
      await Promise.all(patternTagsList().map((t) => api.patternPrefs.set(t.id, { reminder_offsets: offsets })));
      refetchPatternPrefs();
      showToast('Reminder defaults saved', 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  // ── Push notifications — opt-in browser delivery (Phase H). The toggle drives the
  //    real Notification permission + SW push subscription, not a pref column.
  const [pushOn, setPushOn] = createSignal(false);
  const [pushBusy, setPushBusy] = createSignal(false);
  void pushState().then((s) => setPushOn(s === 'subscribed'));
  async function togglePush() {
    if (pushBusy()) return;
    setPushBusy(true);
    try {
      const next = pushOn() ? await disablePush() : await enablePush();
      setPushOn(next === 'subscribed');
      if (next === 'subscribed') showToast('Push notifications enabled', 'success');
      else if (next === 'denied') showToast('Notifications are blocked in your browser settings', 'error');
      else if (next === 'unconfigured') showToast('Push notifications aren’t set up on the server yet', 'error');
      else if (next === 'unsupported') showToast('Push isn’t supported on this device', 'error');
      else showToast('Push notifications disabled');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setPushBusy(false);
    }
  }

  // Intention Tags scroll (show CT_PAGE_SIZE at a time) ───────────────────────
  const CT_PAGE_SIZE = 4;
  const [ctOffset, setCtOffset] = createSignal(0);
  const maxCtOffset = () => Math.max(0, form().concept_tags.length - CT_PAGE_SIZE);

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
    setCtOffset((o) => Math.min(o, Math.max(0, form().concept_tags.length - CT_PAGE_SIZE)));
  }
  function addCT() {
    setForm((f) => ({ ...f, concept_tags: [...f.concept_tags, { name: 'New', minutes: 60 }] }));
  }

  let savePatternPrefs: () => Promise<void> = async () => {};

  async function doSave() {
    try {
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

  async function save(e: Event) {
    e.preventDefault();
    doSave();
  }

  // Tag Settings save: flush pattern-tag default minutes (pattern_prefs) alongside
  // the scheduling prefs (intention tags, colours) saved by doSave().
  async function savePatternDefaults() {
    const pm = patternMinutes();
    await Promise.all(
      patternTagsList().map((t) => api.patternPrefs.set(t.id, { default_minutes: pm[t.id] ?? 60 })),
    );
    refetchPatternPrefs();
  }
  async function saveTagSettings() {
    try { await savePatternDefaults(); }
    catch (err) { showToast((err as Error).message, 'error'); return; }
    doSave();
  }

  const [integrations] = createResource(() => api.llm.integrations());
  const [memStatus, { refetch: refetchMem }] = createResource(() => api.memory.status());
  const [importBusy, setImportBusy] = createSignal(false);

  async function handleImport(file: File) {
    setImportBusy(true);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as unknown;
      const result = await api.backup.import(parsed);
      const total = Object.values(result.imported).reduce((a, b) => a + b, 0);
      showToast(`Import complete — ${total} rows restored`, 'success');
    } catch (err) {
      showToast(`Import failed: ${(err as Error).message}`, 'error');
    } finally {
      setImportBusy(false);
    }
  }

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
        {/* Schedule Patterns — per-direction availability windows */}
        <section class="card">
          <div class="flex items-center justify-between mb-1">
            <div class="section-label">Schedule Patterns</div>
            <button type="button" onClick={saveSchedulePatterns} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
          </div>
          <p class="text-xs text-muted-foreground mb-3">
            Availability windows per direction. Auto places direction-tagged tasks only inside these windows.
          </p>
          <div class="flex gap-2 mb-4">
            <For each={[['workday', 'Workday'], ['weekend', 'Weekend']] as [string, string][]}>
              {([val, label]) => (
                <button type="button"
                  onClick={() => setDayTab(val as 'workday' | 'weekend')}
                  class="px-3 py-1 text-sm rounded-md transition-colors"
                  classList={{ 'bg-primary text-primary-foreground': dayTab() === val, 'text-muted-foreground hover:text-foreground': dayTab() !== val }}>
                  {label}
                </button>
              )}
            </For>
          </div>
          <div class="flex flex-col gap-5">
            <For each={(tags() ?? []).filter((t) => t.kind === 'pattern')}>
              {(dir) => (
                <div class="flex flex-col gap-2">
                  <div class="text-sm font-medium text-foreground capitalize">{dir.name}</div>
                  <For each={getRanges(dir.id)}>
                    {(r, i) => (
                      <div class="flex items-center gap-2">
                        <input type="time" class="input py-1 text-sm flex-1"
                          value={r.start_time}
                          onInput={(e) => updateRange(dir.id, i(), 'start_time', e.currentTarget.value)}
                          onBlur={() => savePatternWindows(dir.id)} />
                        <span class="text-muted-foreground text-xs">–</span>
                        <input type="time" class="input py-1 text-sm flex-1"
                          value={r.end_time}
                          onInput={(e) => updateRange(dir.id, i(), 'end_time', e.currentTarget.value)}
                          onBlur={() => savePatternWindows(dir.id)} />
                        <button type="button"
                          class="text-muted-foreground hover:text-destructive transition-colors"
                          onClick={() => { removeRange(dir.id, i()); savePatternWindows(dir.id); }}>
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  </For>
                  <button type="button"
                    class="flex items-center gap-1 text-xs text-primary hover:text-primary/80 transition-colors self-start"
                    onClick={() => addRange(dir.id)}>
                    <Plus size={12} /> Add window
                  </button>
                  <label class="flex items-start gap-2 cursor-pointer select-none mt-1">
                    <button type="button" role="switch" aria-checked={patternFill(dir.id)}
                      onClick={() => togglePatternFill(dir.id)}
                      class="relative w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5"
                      classList={{ 'bg-primary': patternFill(dir.id), 'bg-muted border border-border': !patternFill(dir.id) }}>
                      <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-card transition-transform"
                        classList={{ 'translate-x-4': patternFill(dir.id) }} />
                    </button>
                    <div class="text-sm text-foreground leading-tight capitalize">Fill open {dir.name} windows with leftover tasks</div>
                  </label>
                </div>
              )}
            </For>
          </div>
        </section>

        {/* Time-Block settings — Plan | Concept */}
        <section class="card">
          <div class="flex items-center justify-between mb-3">
            <div class="section-label">Time-Block Settings</div>
            <button type="button" onClick={doSave} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
          </div>
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">

            {/* ── PLAN ── scheduled (set time + duration) */}
            <div class="rounded-xl border border-border p-3 flex flex-col gap-3">
              <div class="flex items-center justify-between">
                <span class="text-sm font-semibold text-foreground">Scheduled Block</span>
                <Star size={15} class="text-primary" />
              </div>
              <div class="border-t-[3px] border-primary" />
              <p class="text-[11px] text-muted-foreground -mt-1.5">Fixed time + duration, placed on the calendar.</p>

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
                <span class="text-sm font-semibold text-foreground">Someday Block</span>
                <Pentagon size={15} class="text-muted-foreground" />
              </div>
              <div class="border-t-2 border-dashed border-muted-foreground" />
              <p class="text-[11px] text-muted-foreground -mt-1.5">A goal with a start day + estimate; no set time until Auto places it.</p>

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

          {/* Reminder Defaults — ONE shared config for Home / Community / Work. */}
          <div class="pt-4 mt-4 border-t border-border">
            <div class="flex items-center justify-between mb-1">
              <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Reminder Defaults</div>
              <button type="button" onClick={saveReminderDefaults} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
            </div>
            <p class="text-xs text-muted-foreground mb-3">Shared by Home, Community, and Work. Reminders fire in-app; enable push below for backgrounded delivery.</p>
            <div class="flex flex-col gap-3">
              {/* Push notifications — opt-in browser delivery (Phase H). */}
              <label class="flex items-start gap-2 cursor-pointer select-none">
                <button type="button" role="switch" aria-checked={pushOn()} disabled={pushBusy()} onClick={togglePush}
                  class="relative w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5 disabled:opacity-50"
                  classList={{ 'bg-primary': pushOn(), 'bg-muted border border-border': !pushOn() }}>
                  <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-card transition-transform" classList={{ 'translate-x-4': pushOn() }} />
                </button>
                <div>
                  <div class="text-sm text-foreground leading-tight">Push notifications</div>
                  <div class="text-[11px] text-muted-foreground">Deliver reminders to this device even when the app is closed.</div>
                </div>
              </label>
              {/* Start-time reminder */}
              <label class="flex items-start gap-2 cursor-pointer select-none">
                <button type="button" role="switch" aria-checked={remStartOn()} onClick={() => setRemStartOn((v) => !v)}
                  class="relative w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5"
                  classList={{ 'bg-primary': remStartOn(), 'bg-muted border border-border': !remStartOn() }}>
                  <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-card transition-transform" classList={{ 'translate-x-4': remStartOn() }} />
                </button>
                <div>
                  <div class="text-sm text-foreground leading-tight">Start-time reminder</div>
                  <div class="text-[11px] text-muted-foreground">Notify exactly when the task starts.</div>
                </div>
              </label>
              {/* Advance reminder (advanced timer) */}
              <label class="flex items-start gap-2 cursor-pointer select-none">
                <button type="button" role="switch" aria-checked={remAdvOn()} onClick={() => setRemAdvOn((v) => !v)}
                  class="relative w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5"
                  classList={{ 'bg-primary': remAdvOn(), 'bg-muted border border-border': !remAdvOn() }}>
                  <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-card transition-transform" classList={{ 'translate-x-4': remAdvOn() }} />
                </button>
                <div class="flex-1">
                  <div class="text-sm text-foreground leading-tight">Advance reminder</div>
                  <div class="text-[11px] text-muted-foreground">Notify ahead of the start time.</div>
                  <Show when={remAdvOn()}>
                    <div class="flex items-center gap-1.5 mt-1.5">
                      <input type="number" min="1" step="5" class="input py-1 text-sm w-20"
                        value={remAdvMin()} onInput={(e) => setRemAdvMin(Number(e.currentTarget.value) || 0)} />
                      <span class="text-[11px] text-muted-foreground">minutes before start</span>
                    </div>
                  </Show>
                </div>
              </label>
            </div>
          </div>
        </section>

        {/* Routine Settings */}
        <section class="card">
          <div class="flex items-center justify-between mb-3">
            <div class="section-label">Routine Settings</div>
            <button type="button" onClick={doSave} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
          </div>
          <Toggle field="recall_keeps_pattern" label="Recall keeps Routine membership"
            hint="When recalling a shelved (Past) task, also re-link it to its Routine. Off (default) → recall makes a clean, standalone task." />
        </section>

        {/* Routine Types — create/edit/delete pattern type taxonomy */}
        <section class="card">
          <div class="section-label mb-3">Routine Types</div>
          <p class="text-xs text-muted-foreground mb-3">The categories your Routines, Habits, and custom types belong to. Built-in types can be edited but not deleted.</p>
          <RoutineTypeSettings />
        </section>

        {/* Pattern Block settings — shape + colour per pattern tag; sits directly above Tag Settings */}
        <section class="card">
          <div class="flex items-center justify-between mb-3">
            <div class="section-label flex items-center gap-1.5"><Shapes size={12} /> Pattern Block Settings</div>
            <button type="button" onClick={() => savePatternPrefs()} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
          </div>
          <p class="text-xs text-muted-foreground mb-3">Each pattern tag's display shape and colour. Colours come from the shared theme palette.</p>
          <PatternBlockSettings onReady={(fn) => { savePatternPrefs = fn; }} />
        </section>

        {/* Tag Settings — Pattern Tags (read-only) + Intention Tags (editable) */}
        <section class="card">
          <div class="flex items-center justify-between mb-4">
            <div class="section-label flex items-center gap-1.5"><Tags size={12} /> Tag Settings</div>
            <button type="button" onClick={saveTagSettings} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
          </div>

          {/* Pattern Tags — direction tags; color/shape come from Pattern Block Settings */}
          <div class="mb-5">
            <div class="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Pattern Tags</div>
            <div class="flex flex-col gap-1.5">
              <For each={(tags() ?? []).filter((t) => t.kind === 'pattern')}>
                {(t) => {
                  const pref = () => patternPrefs()?.prefs?.[t.id];
                  return (
                    <div class="flex items-center gap-2.5 rounded-md border border-border/50 bg-muted/20 px-3 py-2">
                      <div style={{ color: colorVar(pref()?.color_token) }} class="flex-shrink-0">
                        <ShapeIcon shape={pref()?.icon_shape ?? 'circle'} size={13} strokeWidth={1.5} />
                      </div>
                      <div class="w-3 h-3 rounded-full flex-shrink-0 border border-border/30"
                        style={{ 'background-color': colorVar(pref()?.color_token) }} />
                      <span class="text-sm text-foreground capitalize flex-1">{t.name}</span>
                      <input type="number" min="5" step="5"
                        class="input py-1 text-sm w-20"
                        title="Default time when a task has no intention tag"
                        value={patternMinutes()[t.id] ?? 60}
                        onInput={(e) => setPatternMinutes((m) => ({ ...m, [t.id]: Number(e.currentTarget.value) || 0 }))} />
                      <span class="text-[11px] text-muted-foreground">min</span>
                      <Show when={t.is_base}>
                        <span class="badge-neutral text-[10px]">base</span>
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
            <p class="text-[11px] text-muted-foreground mt-2">Shape and colour managed in Pattern Block Settings above. The default time is the suggested estimate when a task has no intention tag.</p>
          </div>

          {/* Intention Tags — Block Wizard categories; each has a name, estimate, and colour */}
          <div class="border-t border-border pt-4">
            <div class="flex items-center justify-between mb-3">
              <div class="text-[10px] uppercase tracking-wide text-muted-foreground">Intention Tags</div>
              <div class="flex items-center gap-1">
                <Show when={form().concept_tags.length > CT_PAGE_SIZE}>
                  <span class="text-[10px] text-muted-foreground mr-1.5">
                    {ctOffset() + 1}–{Math.min(ctOffset() + CT_PAGE_SIZE, form().concept_tags.length)} of {form().concept_tags.length}
                  </span>
                </Show>
                <button type="button"
                  onClick={() => setCtOffset((o) => Math.max(0, o - 1))}
                  disabled={ctOffset() === 0}
                  class="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:pointer-events-none transition-colors">
                  <ChevronUp size={14} />
                </button>
                <button type="button"
                  onClick={() => setCtOffset((o) => Math.min(maxCtOffset(), o + 1))}
                  disabled={ctOffset() >= maxCtOffset()}
                  class="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:text-foreground disabled:opacity-30 disabled:pointer-events-none transition-colors">
                  <ChevronDown size={14} />
                </button>
              </div>
            </div>

            <div class="flex flex-col gap-2">
              <For each={form().concept_tags.slice(ctOffset(), ctOffset() + CT_PAGE_SIZE)}>
                {(ct, localIdx) => {
                  const globalIdx = () => ctOffset() + localIdx();
                  return (
                    <div class="rounded-lg border border-border/60 bg-card/30 p-2 flex flex-col gap-1.5">
                      <div class="flex items-center gap-2">
                        <input
                          class="input py-1 text-sm flex-1"
                          value={ct.name}
                          onInput={(e) => updateCT(globalIdx(), { name: e.currentTarget.value })}
                        />
                        <input
                          type="number" min="5" step="5"
                          class="input py-1 text-sm w-20"
                          value={ct.minutes}
                          onInput={(e) => updateCT(globalIdx(), { minutes: Number(e.currentTarget.value) || 0 })}
                        />
                        <span class="text-[11px] text-muted-foreground">min</span>
                        <button type="button"
                          onClick={() => removeCT(globalIdx())}
                          class="btn-icon hover:text-destructive" title="Remove">
                          <Trash2 size={13} />
                        </button>
                      </div>
                      <div class="flex flex-wrap gap-1">
                        <For each={PATTERN_COLORS}>
                          {(c) => (
                            <button
                              type="button"
                              onClick={() => updateCT(globalIdx(), { color_token: c.token })}
                              title={c.label}
                              class="w-4 h-4 rounded-full border-[1.5px] transition-all"
                              classList={{
                                'border-foreground scale-110': ct.color_token === c.token,
                                'border-transparent hover:scale-105': ct.color_token !== c.token,
                              }}
                              style={{ 'background-color': colorVar(c.token) }}
                            />
                          )}
                        </For>
                      </div>
                    </div>
                  );
                }}
              </For>
              <Show when={form().concept_tags.length === 0}>
                <p class="text-sm text-muted-foreground">No intention tags yet.</p>
              </Show>
            </div>

            <button type="button" onClick={addCT} class="btn-secondary text-xs px-2.5 py-1 mt-3">
              <Plus size={12} /> Add tag
            </button>
          </div>
        </section>

        {/* Models */}
        <section class="card">
          <div class="flex items-center justify-between mb-3">
            <div class="section-label flex items-center gap-1.5"><Cpu size={12} /> Models</div>
            <button type="button" onClick={doSave} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
          </div>
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
          <div class="flex items-center justify-between mb-3">
            <div class="section-label flex items-center gap-1.5"><Brain size={12} /> Companion Memory</div>
            <button type="button" onClick={doSave} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
          </div>

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

        {/* Backup / Restore / Export */}
        <section class="card">
          <div class="section-label flex items-center gap-1.5 mb-3"><Database size={12} /> Backup &amp; Export</div>
          <div class="flex flex-col gap-4">
            <div class="flex items-center gap-3 flex-wrap">
              <a
                href="/api/export"
                download="companion-export.json"
                class="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5"
              >
                <Database size={12} /> Export JSON
              </a>
              <label class={`btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5 cursor-pointer ${importBusy() ? 'opacity-50 pointer-events-none' : ''}`}>
                {importBusy() ? 'Importing…' : 'Import JSON'}
                <input
                  type="file"
                  accept=".json"
                  class="sr-only"
                  onChange={(e) => {
                    const f = e.currentTarget.files?.[0];
                    if (f) { e.currentTarget.value = ''; handleImport(f); }
                  }}
                />
              </label>
            </div>
            <div class="flex items-start gap-1.5 text-[11px] text-amber-400/80">
              <AlertTriangle size={11} class="mt-0.5 flex-shrink-0" />
              <span>
                Do not sync the live <code class="font-mono">.db</code> file with Syncthing or rsync — WAL mode writes across multiple files and a partial sync can corrupt the database. Use Export or <code class="font-mono">pnpm snapshot</code> instead.
              </span>
            </div>
          </div>
        </section>

        <button type="submit" class="btn-primary self-start px-5">
          <Save size={14} /> Save Settings
        </button>
      </form>
    </div>
  );
}
