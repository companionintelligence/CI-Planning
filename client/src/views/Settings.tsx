import { createSignal, createEffect, Show, createResource, For, onMount } from 'solid-js';
import { Save, Cpu, Globe, CheckCircle2, XCircle, Brain, Link2, Unlink, RefreshCw, Star, Pentagon, Shapes, Plus, Trash2, Tags, Hash, Check, X, Pencil, Database, AlertTriangle } from 'lucide-solid';
import { prefs, refetchPrefs, tags, patternPrefs, refetchPatternPrefs, showToast } from '../stores/index.js';
import { api } from '../lib/api.js';
import { DayTypeManager } from '../components/DayTypeManager.js';
import { PatternBlockSettings } from '../components/PatternBlockSettings.js';
import { RoutineTypeSettings } from '../components/RoutineTypeSettings.js';
import { CategorySettings } from '../components/CategorySettings.js';
import { DEFAULT_CONCEPT_TAGS, PATTERN_COLORS, colorVar, type ConceptTag } from '../lib/pattern-meta.js';
import { enablePush, disablePush, pushState } from '../lib/push.js';
import { on } from '../lib/sse.js';

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
  default_time_block_minutes: number;
  // Plan/Concept Time-Block config. Plan horizon = planning_horizon_days.
  plan_allday_always: boolean; plan_daylong_for_promoted: boolean; plan_autofill_gaps: boolean;
  concept_default_minutes: number; concept_autosurface: boolean; concept_horizon_days: number;
  concept_tags: ConceptTag[];
  timezone: string; planning_horizon_days: number; recurrence_horizon_days: number;
  fast_model: string; quality_model: string; embed_model: string;
  memory_sync_enabled: boolean; memory_sync_completed: boolean;
  memory_sync_habits: boolean; memory_sync_reflections: boolean;
  recall_keeps_pattern: boolean; // cockpit-v2 Phase 6
  time_sense_enabled: boolean; // Phase Z master flag
}

/** The boolean fields of the form — for the reusable Toggle. */
type BoolField =
  | 'auto_fill_workday' | 'plan_allday_always' | 'plan_daylong_for_promoted' | 'plan_autofill_gaps' | 'concept_autosurface' | 'recall_keeps_pattern' | 'time_sense_enabled';

const DEFAULTS: SettingsForm = {
  auto_fill_workday: true,
  max_focus_block_minutes: 90, min_break_minutes: 10,
  max_time_block_minutes: 240, min_time_block_minutes: 15,
  default_time_block_minutes: 60,
  plan_allday_always: false, plan_daylong_for_promoted: false, plan_autofill_gaps: true,
  concept_default_minutes: 60, concept_autosurface: true, concept_horizon_days: 30,
  concept_tags: DEFAULT_CONCEPT_TAGS.map((c) => ({ ...c })),
  timezone: BROWSER_TZ, planning_horizon_days: 3, recurrence_horizon_days: 7,
  fast_model: '', quality_model: '', embed_model: '',
  memory_sync_enabled: false, memory_sync_completed: true,
  memory_sync_habits: true, memory_sync_reflections: true,
  recall_keeps_pattern: false,
  time_sense_enabled: false,
};

export function Settings() {
  const [activeTab, setActiveTab] = createSignal<'preferences' | 'connections'>('preferences');
  const [form, setForm] = createSignal<SettingsForm>({ ...DEFAULTS });

  // V8 — account (local sign-in only): the backup reset-email. Fetch auth config + the
  // current owner; the row shows only when local username/password login is active
  // (there's a password to reset). `owners.email` is the primary reset destination and
  // is read-only here; `backup_email` is the editable fallback.
  const [authCfg] = createResource(() => api.auth.config());
  const [me, { refetch: refetchMe }] = createResource(() => api.auth.me().catch(() => null));
  const localAuth = () => authCfg()?.mode === 'sso' && authCfg()?.disableOidc === true;
  const [backupEmail, setBackupEmail] = createSignal('');
  const [backupSaving, setBackupSaving] = createSignal(false);
  createEffect(() => { if (me()) setBackupEmail(me()!.backupEmail ?? ''); });
  async function saveBackupEmail() {
    setBackupSaving(true);
    try {
      const v = backupEmail().trim();
      await api.owner.setBackupEmail(v || null);
      await refetchMe();
      showToast('Backup email saved', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setBackupSaving(false);
    }
  }

  // Phase P · P2 — Clear Date Range tool state.
  const [clearStart, setClearStart] = createSignal('');
  const [clearEnd, setClearEnd] = createSignal('');
  const [clearPreview, setClearPreview] = createSignal<import('../lib/api.js').ClearRangeResult | null>(null);
  const [clearBusy, setClearBusy] = createSignal(false);
  async function previewClear() {
    if (!clearStart()) { showToast('Pick a start date first', 'error'); return; }
    setClearBusy(true);
    try {
      setClearPreview(await api.planner.clearRange({ start: clearStart(), end: clearEnd() || undefined, dry_run: true }));
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setClearBusy(false);
    }
  }
  async function applyClear() {
    const p = clearPreview();
    if (!clearStart() || !p) return;
    const scope = p.mode === 'open-ended' ? `from ${clearStart()} onward (stops repeats forever)` : `${clearStart()} → ${clearEnd()}`;
    if (!window.confirm(`Clear ${p.blocksDeleted} block(s) ${scope}? A backup snapshot is taken first.`)) return;
    setClearBusy(true);
    try {
      const r = await api.planner.clearRange({ start: clearStart(), end: clearEnd() || undefined });
      showToast(`Cleared ${r.blocksDeleted} block(s); backup saved`, 'success');
      setClearPreview(null);
      setClearStart(''); setClearEnd('');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setClearBusy(false);
    }
  }

  // Schedule Patterns now live in <DayTypeManager /> (day types + week map + the
  // shared per-day-type window editor). T-SCHED-4 replaced the inline editor here.

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
      auto_fill_workday:          p.auto_fill_workday ?? true,
      max_focus_block_minutes:    p.max_focus_block_minutes ?? 90,
      min_break_minutes:          p.min_break_minutes ?? 10,
      max_time_block_minutes:     p.max_time_block_minutes ?? 240,
      min_time_block_minutes:     p.min_time_block_minutes ?? 15,
      default_time_block_minutes: p.default_time_block_minutes ?? 60,
      plan_allday_always:         p.plan_allday_always ?? false,
      plan_daylong_for_promoted:  p.plan_daylong_for_promoted ?? false,
      plan_autofill_gaps:         p.plan_autofill_gaps ?? true,
      concept_default_minutes:    p.concept_default_minutes ?? 60,
      concept_autosurface:        p.concept_autosurface ?? true,
      concept_horizon_days:       p.concept_horizon_days ?? 30,
      concept_tags:               p.concept_tags?.length ? p.concept_tags.map((c) => ({ ...c })) : DEFAULT_CONCEPT_TAGS.map((c) => ({ ...c })),
      timezone:                   p.timezone ?? BROWSER_TZ,
      planning_horizon_days:      p.planning_horizon_days ?? 3,
      recurrence_horizon_days:    p.recurrence_horizon_days ?? 7,
      fast_model:                 p.fast_model ?? '',
      quality_model:              p.quality_model ?? '',
      embed_model:                p.embed_model ?? '',
      recall_keeps_pattern:       p.recall_keeps_pattern ?? false,
      time_sense_enabled:         p.time_sense_enabled ?? false,
      memory_sync_enabled:        p.memory_sync_enabled ?? false,
      memory_sync_completed:      p.memory_sync_completed ?? true,
      memory_sync_habits:         p.memory_sync_habits ?? true,
      memory_sync_reflections:    p.memory_sync_reflections ?? true,
    });
  });

  function setField<K extends keyof SettingsForm>(key: K, val: SettingsForm[K]) {
    setForm((f) => ({ ...f, [key]: val }));
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
      else if (next === 'unconfigured') showToast("Push notifications aren't set up on the server yet", 'error');
      else if (next === 'unsupported') showToast("Push isn't supported on this device", 'error');
      else showToast('Push notifications disabled');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setPushBusy(false);
    }
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

  // Intention Tags inline-edit state (mirrors CategorySettings UX)
  const [ctEditIdx, setCtEditIdx] = createSignal<number | null>(null);
  const [ctEditForm, setCtEditForm] = createSignal<{ name: string; minutes: number; color_token: string }>({ name: '', minutes: 60, color_token: 'primary' });
  const [ctConfirmDelete, setCtConfirmDelete] = createSignal<number | null>(null);
  const [newCtName, setNewCtName] = createSignal('');
  const [ctSaving, setCtSaving] = createSignal(false);

  function startCtEdit(idx: number) {
    const ct = form().concept_tags[idx];
    setCtEditForm({ name: ct.name, minutes: ct.minutes, color_token: ct.color_token ?? 'primary' });
    setCtEditIdx(idx);
    setCtConfirmDelete(null);
  }
  function cancelCtEdit() { setCtEditIdx(null); setCtConfirmDelete(null); }

  async function saveCtEdit() {
    const idx = ctEditIdx();
    if (idx === null) return;
    const f = ctEditForm();
    if (!f.name.trim()) { showToast('Name is required', 'error'); return; }
    setCtSaving(true);
    try {
      updateCT(idx, { name: f.name.trim(), minutes: f.minutes || 60, color_token: f.color_token });
      await doSave();
      setCtEditIdx(null);
    } finally { setCtSaving(false); }
  }

  async function doCtDelete(idx: number) {
    setCtSaving(true);
    try {
      removeCT(idx);
      setCtConfirmDelete(null);
      await doSave();
    } finally { setCtSaving(false); }
  }

  async function addCtFromInput(e: Event) {
    e.preventDefault();
    if (!newCtName().trim()) return;
    setCtSaving(true);
    try {
      setForm((f) => ({ ...f, concept_tags: [...f.concept_tags, { name: newCtName().trim(), minutes: 60, color_token: 'primary' }] }));
      setNewCtName('');
      await doSave();
    } finally { setCtSaving(false); }
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


  const [integrations, { refetch: refetchIntegrations }] = createResource(() => api.llm.integrations());
  const [memStatus, { refetch: refetchMem }] = createResource(() => api.memory.status());
  const [importBusy, setImportBusy] = createSignal(false);

  // WP7: live-refresh the connection health after a sync_calendar run completes.
  // Registered once at component setup (NOT inside a reactive effect) so we never
  // stack duplicate SSE subscriptions on re-render.
  on('job:run', () => refetchIntegrations());

  // After the OAuth callback redirects back to /settings?google=connected|error,
  // surface a toast once and strip the query param so it doesn't re-fire on refresh.
  onMount(() => {
    const q = new URLSearchParams(window.location.search);
    const g = q.get('google');
    if (g === 'connected') { showToast('Google account connected', 'success'); refetchIntegrations(); }
    else if (g === 'error') { showToast(`Google connect failed${q.get('reason') ? `: ${q.get('reason')}` : ''}`, 'error'); }
    if (g) {
      q.delete('google'); q.delete('reason');
      const qs = q.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
  });

  // WP7: kick off the OAuth flow. GET /api/oauth/google/start returns { url }; we
  // fetch it (credentialed) then navigate the browser to Google. Degrade on non-2xx.
  async function connectGoogle() {
    if (!integrations()?.google.liveEnabled) return;
    try {
      const res = await fetch('/api/oauth/google/start');
      if (!res.ok) { showToast('Google connect is not available yet', 'default'); return; }
      const data = await res.json().catch(() => ({} as { url?: string }));
      if (data.url) { window.location.href = data.url; return; }
      // Some flows redirect directly; if we landed here with a 2xx and no url, refetch.
      refetchIntegrations();
    } catch {
      showToast('Could not start Google connect', 'error');
    }
  }

  // WP7: disconnect one account. Contract (assumed): DELETE /api/oauth/google/accounts/:account.
  async function disconnectGoogle(account: string) {
    try {
      const res = await fetch(`/api/oauth/google/accounts/${encodeURIComponent(account)}`, { method: 'DELETE' });
      if (!res.ok) { showToast('Disconnect is not available yet', 'default'); return; }
      showToast(`Disconnected ${account}`, 'success');
    } catch {
      showToast('Could not disconnect', 'error');
    } finally {
      refetchIntegrations();
    }
  }

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
      <h1 class="text-2xl font-bold text-slate-100 mb-4">Settings</h1>

      {/* Tab bar */}
      <div class="flex gap-1 mb-5 border-b border-border">
        <button
          type="button"
          onClick={() => setActiveTab('preferences')}
          class="px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px"
          classList={{
            'border-primary text-foreground': activeTab() === 'preferences',
            'border-transparent text-muted-foreground hover:text-foreground': activeTab() !== 'preferences',
          }}
        >
          Preferences
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('connections')}
          class="px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px"
          classList={{
            'border-primary text-foreground': activeTab() === 'connections',
            'border-transparent text-muted-foreground hover:text-foreground': activeTab() !== 'connections',
          }}
        >
          Connections
        </button>
      </div>

      <form onSubmit={save} class="flex flex-col gap-5">

        {/* ── PREFERENCES TAB ─────────────────────────────────────────────────── */}
        <Show when={activeTab() === 'preferences'}>

          {/* V8 — Account (local sign-in only): backup password-reset email. */}
          <Show when={localAuth()}>
            <section class="card">
              <div class="section-label mb-1">Account</div>
              <p class="text-xs text-muted-foreground mb-3">
                Your password-reset link is emailed to your account address. Add a backup address as a fallback in case
                the primary is unavailable.
              </p>
              <Show when={me()?.username}>
                <div class="flex items-center justify-between gap-3 mb-2">
                  <span class="text-sm text-foreground">Username</span>
                  <span class="text-sm text-muted-foreground font-mono">{me()!.username}</span>
                </div>
              </Show>
              <div class="flex items-center justify-between gap-3 mb-3">
                <span class="text-sm text-foreground">Account email</span>
                <span class="text-sm text-muted-foreground">{me()?.email ?? 'none set'}</span>
              </div>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-muted-foreground">Backup email</span>
                <div class="flex items-center gap-2">
                  <input
                    type="email"
                    class="input py-1 text-sm flex-1"
                    placeholder="backup@example.com"
                    value={backupEmail()}
                    onInput={(e) => setBackupEmail(e.currentTarget.value)}
                  />
                  <button
                    type="button"
                    class="btn-primary text-sm px-3 py-1.5"
                    onClick={saveBackupEmail}
                    disabled={backupSaving() || backupEmail().trim() === (me()?.backupEmail ?? '')}
                  >
                    {backupSaving() ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </label>
            </section>
          </Show>

          {/* Schedule Patterns — per-direction availability windows */}
          <section class="card">
            <div class="flex items-center justify-between mb-1">
              <div class="section-label">Schedule Patterns</div>
              <button type="button" onClick={doSave} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
            </div>
            <p class="text-xs text-muted-foreground mb-3">
              Define day types, assign them to each weekday, and set per-direction availability windows.
              Auto places direction-tagged tasks only inside these windows. Changes save as you make them.
            </p>
            <DayTypeManager />
            {/* General fallback: fill open workday time for tasks with no direction tag */}
            <div class="mt-4 pt-3 border-t border-border">
              <Toggle
                field="auto_fill_workday"
                label="Fill work hours for undirected tasks"
                hint="Auto Schedule fills open workday time with tasks that have no direction tag. Per-direction fill (above) is independent."
              />
            </div>
            {/* T-SCHED-2: Schedule-mode planning horizon. Reuses planning_horizon_days
                (also the task candidate window — same value as "Planning horizon" below). */}
            <div class="mt-4 pt-3 border-t border-border">
              <label class="flex items-center justify-between gap-3">
                <div>
                  <div class="text-sm text-foreground leading-tight">Schedule mode — plan days ahead</div>
                  <div class="text-[11px] text-muted-foreground">In Schedule mode, Auto plans this many days ahead. Shares the Planning horizon (also the task candidate window).</div>
                </div>
                <input type="number" class="input py-1 text-sm w-20 flex-shrink-0" min={1} max={60} step={1}
                  value={form().planning_horizon_days}
                  onInput={(e) => setField('planning_horizon_days', Number(e.currentTarget.value))}
                  onChange={(e) => {
                    const v = Math.max(1, Math.min(60, Number(e.currentTarget.value) || 1));
                    setField('planning_horizon_days', v);
                    void api.prefs.update({ planning_horizon_days: v }).then(() => refetchPrefs()).catch((err) => showToast((err as Error).message, 'error'));
                  }} />
              </label>
            </div>
            {/* Phase P: recurrence duration — how far ahead repeats (habits/routines/
                recurring time-blocks) are materialized. Lowering it prunes already-placed
                auto-repeats beyond the new window (server auto-prune). */}
            <div class="mt-4 pt-3 border-t border-border">
              <label class="flex items-center justify-between gap-3">
                <div>
                  <div class="text-sm text-foreground leading-tight">Recurrence duration</div>
                  <div class="text-[11px] text-muted-foreground">Generate repeats this many days ahead. Lowering it removes auto-placed repeats beyond the new window.</div>
                </div>
                <select class="input py-1 text-sm w-24 flex-shrink-0"
                  value={form().recurrence_horizon_days}
                  onChange={(e) => {
                    const v = Number(e.currentTarget.value);
                    const prev = form().recurrence_horizon_days;
                    if (v < prev && !window.confirm(`Lowering the recurrence duration removes auto-placed repeats beyond ${v} days. Continue?`)) {
                      e.currentTarget.value = String(prev); // revert the select
                      return;
                    }
                    setField('recurrence_horizon_days', v);
                    void api.prefs
                      .update({ recurrence_horizon_days: v })
                      .then((r) => {
                        refetchPrefs();
                        if (r.pruned) showToast(`Removed ${r.pruned} auto-placed repeat${r.pruned === 1 ? '' : 's'} beyond the new window`, 'success');
                      })
                      .catch((err) => showToast((err as Error).message, 'error'));
                  }}>
                  <For each={[7, 15, 30, 60, 90, 180]}>{(d) => <option value={d}>{d} days</option>}</For>
                </select>
              </label>
            </div>
          </section>

          {/* Phase P · P2 — Clear Date Range: bulk-clear the planner from a date (optionally through a date). */}
          <section class="card">
            <div class="section-label flex items-center gap-1.5 mb-2"><Trash2 size={12} /> Clear Date Range</div>
            <div class="text-[11px] text-muted-foreground mb-3">
              Remove planner blocks from a start date (optionally through an end date) and stop repeats from regenerating.
              Open-ended (no end) stops repeats <b>forever</b> from the start; a range skips <b>just that window</b>.
              A backup snapshot is taken before anything is deleted.
            </div>
            <div class="flex items-end gap-3 flex-wrap">
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-muted-foreground">Start (required)</span>
                <input type="date" class="input py-1 text-sm" value={clearStart()} onInput={(e) => { setClearStart(e.currentTarget.value); setClearPreview(null); }} />
              </label>
              <label class="flex flex-col gap-1">
                <span class="text-[11px] text-muted-foreground">End (optional)</span>
                <input type="date" class="input py-1 text-sm" value={clearEnd()} onInput={(e) => { setClearEnd(e.currentTarget.value); setClearPreview(null); }} />
              </label>
              <button type="button" class="btn-secondary text-sm" disabled={clearBusy() || !clearStart()} onClick={previewClear}>Preview</button>
            </div>
            <Show when={clearPreview()}>
              {(p) => (
                <div class="mt-3 text-sm">
                  <div class="flex items-start gap-1.5 text-muted-foreground">
                    <AlertTriangle size={13} class="mt-0.5 flex-shrink-0" />
                    <span>
                      Will delete <b>{p().blocksDeleted}</b> block(s)
                      {p().dailyPlanDeleted ? <> + <b>{p().dailyPlanDeleted}</b> day-plan row(s)</> : null} and suppress{' '}
                      <b>{p().generators.length}</b> recurring generator(s) —{' '}
                      <b>{p().mode === 'open-ended' ? 'stops repeats forever from the start' : 'skips only this window'}</b>.
                    </span>
                  </div>
                  <button type="button" class="btn-danger text-sm mt-2" disabled={clearBusy()} onClick={applyClear}>Clear now</button>
                </div>
              )}
            </Show>
          </section>

          {/* Pattern Tags — unified: shape, colour, and default minutes per direction tag */}
          <section class="card">
            <div class="flex items-center justify-between mb-3">
              <div class="section-label flex items-center gap-1.5"><Shapes size={12} /> Pattern Tags</div>
              <button type="button" onClick={() => savePatternPrefs()} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
            </div>
            <p class="text-xs text-muted-foreground mb-3">Shape, colour, and default estimate for each direction tag. The default time is used when a task has no intention tag.</p>
            <PatternBlockSettings
              minutes={patternMinutes}
              onMinutesChange={(id, val) => setPatternMinutes((m) => ({ ...m, [id]: val }))}
              onReady={(fn) => { savePatternPrefs = fn; }}
            />
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
                  <label class="flex flex-col gap-1 flex-1">
                    <span class="text-[11px] text-muted-foreground">Default (min)</span>
                    <input type="number" class="input py-1 text-sm" min={5} max={480} step={5}
                      value={form().default_time_block_minutes} onInput={e => setField('default_time_block_minutes', Number(e.currentTarget.value))} />
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

          {/* Time Block Categories — the kind='category' catalog (0069): colour + default block length */}
          <section class="card">
            <div class="section-label flex items-center gap-1.5 mb-1"><Tags size={12} /> Time Block Categories</div>
            <p class="text-xs text-muted-foreground mb-3">Quick "types of time" for time blocks (Family Time, Social Time, Me Time + your own). Pick a colour and a default length; the defaults can be edited but not deleted. Group their intention tags on the <span class="text-primary">Tags → Time Block Categories</span> tab.</p>
            <CategorySettings />
          </section>

          {/* Tag Settings — Intention Tags (editable), mirrors CategorySettings UX */}
          <section class="card">
            <div class="section-label flex items-center gap-1.5 mb-1"><Tags size={12} /> Tag Settings</div>
            <p class="text-xs text-muted-foreground mb-3">Default intention tags for the Block Wizard. Each has a name, default estimate, and colour.</p>

            <div class="flex flex-col gap-2">
              <For each={form().concept_tags}>
                {(ct, localIdx) => (
                  <div class="rounded-lg border border-border bg-card overflow-hidden">
                    {/* Summary row */}
                    <div class="flex items-center gap-2.5 px-3 py-2.5">
                      <span class="w-3.5 h-3.5 rounded-full flex-shrink-0" style={{ 'background-color': colorVar(ct.color_token ?? 'primary') }} />
                      <span class="text-sm font-medium text-foreground flex-1">{ct.name}</span>
                      <span class="text-[11px] text-muted-foreground">{ct.minutes}m</span>
                      <button
                        type="button"
                        title={ctEditIdx() === localIdx() ? 'Cancel edit' : 'Edit'}
                        onClick={() => (ctEditIdx() === localIdx() ? cancelCtEdit() : startCtEdit(localIdx()))}
                        class="p-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                      ><Pencil size={12} /></button>
                      <button
                        type="button"
                        title="Delete"
                        onClick={() => setCtConfirmDelete(ctConfirmDelete() === localIdx() ? null : localIdx())}
                        class="p-1 rounded text-muted-foreground hover:text-destructive transition-colors"
                      ><Trash2 size={12} /></button>
                    </div>

                    {/* Inline delete confirmation */}
                    <Show when={ctConfirmDelete() === localIdx()}>
                      <div class="border-t border-border bg-destructive/5 px-3 py-2 flex items-center justify-between">
                        <span class="text-xs text-destructive">Delete "{ct.name}"?</span>
                        <div class="flex items-center gap-1.5 ml-3 flex-shrink-0">
                          <button type="button" onClick={() => setCtConfirmDelete(null)}
                            class="text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border transition-colors">Cancel</button>
                          <button type="button" onClick={() => doCtDelete(localIdx())} disabled={ctSaving()}
                            class="text-xs text-destructive hover:text-destructive/80 px-2 py-1 rounded border border-destructive/40 disabled:opacity-50 transition-colors">Delete</button>
                        </div>
                      </div>
                    </Show>

                    {/* Inline edit form */}
                    <Show when={ctEditIdx() === localIdx()}>
                      <div class="border-t border-border px-3 py-3 flex flex-col gap-3">
                        <div class="flex items-center gap-2">
                          <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0">Name</span>
                          <input type="text" maxlength="40" class="input text-sm flex-1"
                            value={ctEditForm().name}
                            onInput={(e) => setCtEditForm({ ...ctEditForm(), name: e.currentTarget.value })}
                            placeholder="Tag name" />
                        </div>
                        <div class="flex items-start gap-2">
                          <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0 mt-0.5">Color</span>
                          <div class="flex flex-wrap gap-1.5">
                            <For each={PATTERN_COLORS}>
                              {(col) => (
                                <button type="button" title={col.label}
                                  onClick={() => setCtEditForm({ ...ctEditForm(), color_token: col.token })}
                                  class="w-5 h-5 rounded-full border-2 transition-all"
                                  classList={{
                                    'border-foreground scale-110': ctEditForm().color_token === col.token,
                                    'border-transparent hover:scale-105': ctEditForm().color_token !== col.token,
                                  }}
                                  style={{ 'background-color': colorVar(col.token) }} />
                              )}
                            </For>
                          </div>
                        </div>
                        <div class="flex items-center gap-2">
                          <span class="text-[11px] text-muted-foreground w-14 flex-shrink-0">Default</span>
                          <input type="number" min="5" step="5" class="input text-sm w-20"
                            value={ctEditForm().minutes}
                            onInput={(e) => setCtEditForm({ ...ctEditForm(), minutes: Number(e.currentTarget.value) || 0 })} />
                          <span class="text-[11px] text-muted-foreground">min — default block length</span>
                        </div>
                        <div class="flex items-center justify-end gap-2 pt-1 border-t border-border/50">
                          <button type="button" onClick={cancelCtEdit}
                            class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground px-2 py-1 rounded border border-border transition-colors"><X size={11} /> Cancel</button>
                          <button type="button" onClick={saveCtEdit} disabled={ctSaving()}
                            class="flex items-center gap-1 text-xs text-primary hover:text-primary/80 px-2 py-1 rounded border border-primary/40 disabled:opacity-50 transition-colors"><Check size={11} /> {ctSaving() ? 'Saving…' : 'Save'}</button>
                        </div>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
              <Show when={form().concept_tags.length === 0}>
                <p class="text-sm text-muted-foreground">No intention tags yet.</p>
              </Show>

              {/* Add a tag */}
              <form onSubmit={addCtFromInput} class="flex gap-2 mt-1">
                <div class="relative flex-1">
                  <Hash size={12} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                  <input class="input text-sm pl-7" placeholder="New tag…" value={newCtName()} onInput={(e) => setNewCtName(e.currentTarget.value)} />
                </div>
                <button type="submit" disabled={ctSaving() || !newCtName().trim()} class="btn-secondary text-xs px-2.5 py-1 disabled:opacity-50"><Plus size={12} /> Add</button>
              </form>
            </div>
          </section>

          {/* Routine Settings — recall behaviour + the pattern-type taxonomy */}
          <section class="card">
            <div class="flex items-center justify-between mb-3">
              <div class="section-label">Routine Settings</div>
              <button type="button" onClick={doSave} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
            </div>
            <Toggle field="recall_keeps_pattern" label="Recall keeps Routine membership"
              hint="When recalling a shelved (Past) task, also re-link it to its Routine. Off (default) → recall makes a clean, standalone task." />

            {/* Phase Z master flag — gates the Focus Ritual, tag-scoped estimate
                calibration, and the evening EOD Alignment while the phase ships dark. */}
            <Toggle field="time_sense_enabled" label="Time-Sense"
              hint="Focus Ritual block timers, tag-scoped estimate calibration, and the evening alignment. Experimental; off by default." />

            {/* AI day ordering toggle — saved immediately, not via the Save button */}
            {(() => {
              const smartMode = () => prefs()?.planning_mode === 'smart';
              const togglePlanningMode = async () => {
                const nextValue = smartMode() ? 'basic' : 'smart';
                try {
                  await api.prefs.update({ planning_mode: nextValue });
                  refetchPrefs();
                } catch (err) { showToast((err as Error).message, 'error'); }
              };
              return (
                <label class="flex items-start gap-2 cursor-pointer select-none">
                  <button type="button" role="switch" aria-checked={smartMode()}
                    onClick={togglePlanningMode}
                    class="relative w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5"
                    classList={{ 'bg-primary': smartMode(), 'bg-muted border border-border': !smartMode() }}>
                    <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-card transition-transform"
                      classList={{ 'translate-x-4': smartMode() }} />
                  </button>
                  <div>
                    <div class="text-sm text-foreground leading-tight">AI day ordering</div>
                    <div class="text-[11px] text-muted-foreground">
                      AI orders your plan; placement stays deterministic.
                      <Show when={smartMode() && !ollamaUp()}>
                        {' '}Requires Ollama — falls back to basic order when unavailable.
                      </Show>
                    </div>
                  </div>
                </label>
              );
            })()}

            {/* The Suggest / Schedule toggle lives in the Day Overview header (Today view). */}

            {/* Routine Types — edit the built-in pattern-type taxonomy (creation removed, T-SET-1) */}
            <div class="border-t border-border pt-4 mt-4">
              <div class="text-[10px] uppercase tracking-wide text-muted-foreground mb-2">Routine Types</div>
              <p class="text-xs text-muted-foreground mb-3">The built-in categories your Routines and Habits belong to. You can edit their shape, colour, and defaults — they can't be created or deleted.</p>
              <RoutineTypeSettings />
            </div>
          </section>

          <button type="submit" class="btn-primary self-start px-5">
            <Save size={14} /> Save Settings
          </button>

        </Show>

        {/* ── CONNECTIONS TAB ─────────────────────────────────────────────────── */}
        <Show when={activeTab() === 'connections'}>

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

                  {/* WP7: read-only Google connection health, live-updated on sync. */}
                  <div class="flex flex-col gap-2 pl-7">
                    <div class="flex items-center justify-between gap-2">
                      <span class="section-label">Connections</span>
                      <Show when={i().google.connections.length === 0}>
                        <button
                          type="button"
                          onClick={connectGoogle}
                          disabled={!i().google.liveEnabled}
                          title={i().google.liveEnabled ? 'Connect a Google account' : 'Set GOOGLE_MODE=live to connect a Google account'}
                          class="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <Link2 size={12} /> Connect
                        </button>
                      </Show>
                    </div>

                    <Show
                      when={i().google.connections.length > 0}
                      fallback={<div class="text-xs text-slate-500">No Google accounts connected.</div>}
                    >
                      <For each={i().google.connections}>
                        {(c) => (
                          <div class="flex flex-col gap-1 rounded-md border border-border px-3 py-2">
                            <div class="flex items-center justify-between gap-2">
                              <span class="text-xs text-slate-200 font-medium truncate">{c.account}</span>
                              <div class="flex items-center gap-2 shrink-0">
                                <span
                                  class="text-[10px] px-1.5 py-0.5 rounded-full"
                                  classList={{
                                    'bg-green-500/15 text-green-400': c.status === 'connected',
                                    'bg-amber-500/15 text-amber-400': c.status === 'expired',
                                    'bg-slate-500/15 text-slate-400': c.status === 'inactive',
                                  }}
                                >
                                  {c.status}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => disconnectGoogle(c.account)}
                                  disabled={!i().google.liveEnabled}
                                  title={i().google.liveEnabled ? 'Disconnect this account' : 'Set GOOGLE_MODE=live to manage connections'}
                                  class="btn-ghost text-xs px-2 py-1 disabled:opacity-40 disabled:cursor-not-allowed"
                                >
                                  <Unlink size={12} /> Disconnect
                                </button>
                              </div>
                            </div>
                            <div class="flex items-center gap-3 text-[11px] text-slate-500">
                              <span>{c.lastSyncAt ? `Last sync: ${new Date(c.lastSyncAt).toLocaleString()}` : 'Never synced'}</span>
                              <span>·</span>
                              <span>{c.mappedEventCount} mapped event{c.mappedEventCount === 1 ? '' : 's'}</span>
                            </div>
                            <Show when={c.lastError}>
                              <div class="flex items-center gap-1.5 text-[11px] text-destructive">
                                <AlertTriangle size={11} /> {c.lastError}
                              </div>
                            </Show>
                          </div>
                        )}
                      </For>
                    </Show>
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

        </Show>

      </form>
    </div>
  );
}
