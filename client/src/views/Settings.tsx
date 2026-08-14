import { createSignal, createEffect, Show, createResource, For, onMount } from 'solid-js';
import { BellRing, Save, Cpu, Globe, CheckCircle2, XCircle, Brain, Link2, Unlink, RefreshCw, Star, Pentagon, Shapes, Plus, Trash2, Tags, X, Database, AlertTriangle, Users, KeyRound, ScrollText, Eye, FileJson, FileText, Mail } from 'lucide-solid';
import { prefs, refetchPrefs, tags, patternPrefs, refetchPatternPrefs, showToast, texturesEnabled, setTexturesEnabled, plannerAxisState, setPlannerCollapseBounds, integrations, refetchIntegrations, aiAvailable, connections, refetchConnections } from '../stores/index.js';
import { api, type PlanningSession } from '../lib/api.js';
import { sessionToMarkdown, sessionToJson, exportFilename } from '../lib/plan-week-export.js';
import { FTUE_RESUME_KEY } from '../lib/onboarding.js';
import { topCollapseEnd, bottomCollapseStart } from '../lib/day-axis.js';
import { DayTypeManager } from '../components/DayTypeManager.js';
import { CalibrationPins } from '../components/CalibrationPins.js';
import { PatternBlockSettings } from '../components/PatternBlockSettings.js';
import { CategorySettings } from '../components/CategorySettings.js';
import { enablePush, disablePush, pushState } from '../lib/push.js';
import { on } from '../lib/sse.js';
import { GOOGLE_CONNECT_ENABLED } from '../lib/flags.js';
import { ConnectionAppearance } from '../components/ConnectionAppearance.js';

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
  timezone: string; planning_horizon_days: number; recurrence_horizon_days: number;
  fast_model: string; quality_model: string; embed_model: string;
  memory_sync_enabled: boolean; memory_sync_completed: boolean;
  memory_sync_habits: boolean; memory_sync_reflections: boolean;
  memory_pull_enabled: boolean; // Phase AA — pull memory graph into suggestions
  // Ingestion windows (0147). memory looks FORWARD (upcoming events), email looks BACK.
  memory_window_days: number; email_lookback_days: number;
  recall_keeps_pattern: boolean; // cockpit-v2 Phase 6
  time_sense_enabled: boolean; // Phase Z master flag
  focus_ritual_enabled: boolean; haptic_cues_enabled: boolean; // Phase Z · Z5 per-cue matrix
  ambient_color_enabled: boolean; calibration_loop_enabled: boolean;
  triality_enabled: boolean; // Triality master flag (0139) — ships dark
}

/** The boolean fields of the form — for the reusable Toggle. */
type BoolField =
  | 'auto_fill_workday' | 'plan_allday_always' | 'plan_daylong_for_promoted' | 'plan_autofill_gaps' | 'concept_autosurface' | 'recall_keeps_pattern' | 'time_sense_enabled'
  | 'focus_ritual_enabled' | 'haptic_cues_enabled' | 'ambient_color_enabled' | 'calibration_loop_enabled' | 'triality_enabled';

const DEFAULTS: SettingsForm = {
  auto_fill_workday: true,
  max_focus_block_minutes: 90, min_break_minutes: 10,
  max_time_block_minutes: 240, min_time_block_minutes: 15,
  default_time_block_minutes: 60,
  plan_allday_always: false, plan_daylong_for_promoted: false, plan_autofill_gaps: true,
  concept_default_minutes: 60, concept_autosurface: true, concept_horizon_days: 30,
  timezone: BROWSER_TZ, planning_horizon_days: 3, recurrence_horizon_days: 7,
  fast_model: '', quality_model: '', embed_model: '',
  memory_sync_enabled: false, memory_sync_completed: true,
  memory_sync_habits: true, memory_sync_reflections: true,
  memory_pull_enabled: false,
  memory_window_days: 2, email_lookback_days: 7,
  recall_keeps_pattern: false,
  time_sense_enabled: false,
  focus_ritual_enabled: true, haptic_cues_enabled: true,
  ambient_color_enabled: true, calibration_loop_enabled: true,
  triality_enabled: false,
};

export function Settings() {
  const [activeTab, setActiveTab] = createSignal<'profile' | 'preferences' | 'connections' | 'logs'>('profile');
  const [form, setForm] = createSignal<SettingsForm>({ ...DEFAULTS });

  // V8 — account (local sign-in only): the backup reset-email. Fetch auth config + the
  // current owner; the row shows only when local username/password login is active
  // (there's a password to reset). `owners.email` is the primary reset destination and
  // is read-only here; `backup_email` is the editable fallback.
  const [authCfg] = createResource(() => api.auth.config());
  const [me, { refetch: refetchMe }] = createResource(() => api.auth.me().catch(() => null));
  const localAuth = () => authCfg()?.mode === 'sso' && authCfg()?.disableOidc === true;
  // AA0b — the CI-Portal "sign in" button only makes sense in SSO mode (mode='sso'
  // with OIDC enabled); local-login / standalone deployments use the URL+key form.
  const ssoAvailable = () => authCfg()?.mode === 'sso' && authCfg()?.disableOidc === false;
  const [backupEmail, setBackupEmail] = createSignal('');
  const [backupSaving, setBackupSaving] = createSignal(false);
  createEffect(() => { if (me()) setBackupEmail(me()!.backupEmail ?? ''); });
  // Profile (all auth modes): display name + primary email. Without this editor a
  // self-hosted owner is stuck as the seeded 'System' identity forever.
  const [profileName, setProfileName] = createSignal('');
  const [profileEmail, setProfileEmail] = createSignal('');
  // The local-login handle. Separate from `name` on purpose: it is UNIQUE (partial index
  // ux_owners_username) and case-sensitive, whereas the display name is neither — forcing
  // them equal would make two people called "Liam" impossible. Null for SSO owners, who
  // have no local handle at all, so the field is hidden for them.
  const [profileUsername, setProfileUsername] = createSignal('');
  const [profileSaving, setProfileSaving] = createSignal(false);
  createEffect(() => {
    if (me()) {
      setProfileName(me()!.name ?? '');
      setProfileEmail(me()!.email ?? '');
      setProfileUsername(me()!.username ?? '');
    }
  });
  const hasUsername = () => me()?.username != null;
  const profileDirty = () =>
    profileName().trim() !== (me()?.name ?? '')
    || profileEmail().trim() !== (me()?.email ?? '')
    || (hasUsername() && profileUsername().trim() !== (me()?.username ?? ''));
  async function saveProfile() {
    setProfileSaving(true);
    try {
      // Only send `username` when this owner actually has one AND it changed — an SSO
      // owner has none, and resending an unchanged handle would pointlessly re-run the
      // uniqueness check.
      const changedUsername = hasUsername() && profileUsername().trim() !== (me()?.username ?? '');
      await api.owner.updateProfile({
        name: profileName().trim(),
        email: profileEmail().trim() || null,
        ...(changedUsername ? { username: profileUsername().trim() } : {}),
      });
      await refetchMe();
      showToast('Profile saved', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
      // A rejected rename (409) must not leave the field showing a handle that isn't
      // stored — snap back to the server's truth.
      setProfileUsername(me()?.username ?? '');
    } finally {
      setProfileSaving(false);
    }
  }
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

  // Pattern-tag visual config + default estimate now live entirely inside
  // <PatternBlockSettings /> (per-row expandable edit, own Save).
  const patternTagsList = () => (tags() ?? []).filter((t) => t.kind === 'direction');

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
      timezone:                   p.timezone ?? BROWSER_TZ,
      planning_horizon_days:      p.planning_horizon_days ?? 3,
      recurrence_horizon_days:    p.recurrence_horizon_days ?? 7,
      fast_model:                 p.fast_model ?? '',
      quality_model:              p.quality_model ?? '',
      embed_model:                p.embed_model ?? '',
      recall_keeps_pattern:       p.recall_keeps_pattern ?? false,
      time_sense_enabled:         p.time_sense_enabled ?? false,
      focus_ritual_enabled:       p.focus_ritual_enabled ?? true,
      haptic_cues_enabled:        p.haptic_cues_enabled ?? true,
      ambient_color_enabled:      p.ambient_color_enabled ?? true,
      calibration_loop_enabled:   p.calibration_loop_enabled ?? true,
      memory_sync_enabled:        p.memory_sync_enabled ?? false,
      memory_sync_completed:      p.memory_sync_completed ?? true,
      memory_sync_habits:         p.memory_sync_habits ?? true,
      memory_sync_reflections:    p.memory_sync_reflections ?? true,
      memory_pull_enabled:        p.memory_pull_enabled ?? false,
      memory_window_days:         p.memory_window_days ?? 2,
      email_lookback_days:        p.email_lookback_days ?? 7,
      triality_enabled:           p.triality_enabled ?? false,
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
    const first = ts.find((t) => t.kind === 'direction');
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


  // `integrations` / `refetchIntegrations` / `aiAvailable` come from the shared store
  // (single source of truth for AI availability — see stores/index.ts). This view drives
  // the "Re-check" button and the model/memory gating off the same signal every AI
  // surface uses, so there's one fetch and one truth.

  // In-app Google connection setup (admin-gated — a 403 resolves to null and the
  // config form simply doesn't render for non-admin credentials).
  const [gcfg, { refetch: refetchGcfg }] = createResource(() => api.googleConfig.get().catch(() => null));
  const [gClientId, setGClientId] = createSignal('');
  const [gClientSecret, setGClientSecret] = createSignal('');
  const [gSaving, setGSaving] = createSignal(false);
  createEffect(() => { const c = gcfg(); if (c) setGClientId(c.clientId ?? ''); });
  async function saveGoogleConfig(enabled: boolean) {
    setGSaving(true);
    try {
      const secret = gClientSecret().trim();
      await api.googleConfig.save({
        client_id: gClientId().trim(),
        // Blank input = keep the stored secret; the field is write-only by design.
        ...(secret ? { client_secret: secret } : {}),
        enabled,
      });
      setGClientSecret('');
      await Promise.all([refetchGcfg(), refetchIntegrations()]);
      showToast(enabled ? 'Google connection enabled — you can now connect an account' : 'Google connection disabled', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setGSaving(false);
    }
  }
  // Phase AG — operator account management. The card is gated on /auth/me's
  // isOperator (no probe needed); the list fetch still degrades to null on a 403
  // so a race with a mid-session demotion can't crash the view.
  const [accounts, { refetch: refetchAccounts }] = createResource(() =>
    api.accounts.list().then((r) => r.accounts).catch(() => null),
  );

  // T6 — Logs tab: the owner's plan-week (T1) sessions. `list()` is already
  // newest-first (server: `ORDER BY started_at DESC`); no client sort needed.
  const [sessions, { refetch: refetchSessions }] = createResource(() =>
    api.planWeek.session.list().then((r) => r.sessions).catch(() => null),
  );
  const [reviewing, setReviewing] = createSignal<PlanningSession | null>(null);
  const [clearingAll, setClearingAll] = createSignal(false);

  // T10 — session selection for "Consolidate (summarize)". T6 shipped no multi-select
  // (each row is Review/Export/Delete only), so this signal + the row checkboxes below
  // are new; there was no existing selection UI to reuse.
  const [selectedSessionIds, setSelectedSessionIds] = createSignal<Set<string>>(new Set());
  const [consolidating, setConsolidating] = createSignal(false);
  const [consolidateResult, setConsolidateResult] = createSignal<{ summary: string; source: 'model' | 'fallback' } | null>(null);

  // Adversarial review caught this: neither a single-row Delete nor "Clear all" ever
  // touched `selectedSessionIds`, so the Consolidate button's count/enabled-state could
  // reference ids that no longer exist — a guaranteed-422 click after Clear all, or a
  // silently-smaller-than-implied consolidate after deleting just one of several
  // selected rows. Reconcile against the current list on every change instead of
  // special-casing each deletion path.
  createEffect(() => {
    const list = sessions();
    if (!list) return;
    const liveIds = new Set(list.map((s) => s.id));
    setSelectedSessionIds((prev) => {
      const pruned = new Set([...prev].filter((id) => liveIds.has(id)));
      return pruned.size === prev.size ? prev : pruned;
    });
  });

  function toggleSessionSelected(id: string) {
    setSelectedSessionIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function consolidateSelectedSessions() {
    const ids = [...selectedSessionIds()];
    if (!ids.length) return;
    setConsolidating(true);
    try {
      const res = await api.planWeek.consolidateSessions(ids);
      setConsolidateResult(res);
      setSelectedSessionIds(new Set<string>());
      await refetchSessions(); // the newest selected session's summary just changed
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setConsolidating(false);
    }
  }

  async function reviewSession(id: string) {
    try {
      const { session } = await api.planWeek.session.get(id);
      setReviewing(session);
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  function downloadSession(session: PlanningSession, format: 'json' | 'md') {
    const content = format === 'json' ? sessionToJson(session) : sessionToMarkdown(session);
    const mime = format === 'json' ? 'application/json' : 'text/markdown';
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = exportFilename(session, format);
    a.click();
    URL.revokeObjectURL(url);
  }

  async function deleteSession(session: PlanningSession) {
    if (!window.confirm(`Delete this ${session.entry_branch} session from ${session.started_at.slice(0, 10)}? This cannot be undone.`)) return;
    try {
      await api.planWeek.session.remove(session.id);
      await refetchSessions();
      showToast('Session deleted', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  async function clearAllSessions() {
    const list = sessions() ?? [];
    if (!list.length) return;
    if (!window.confirm(`Delete all ${list.length} planning-session logs? This cannot be undone.`)) return;
    setClearingAll(true);
    try {
      await Promise.all(list.map((s) => api.planWeek.session.remove(s.id)));
      showToast('All sessions deleted', 'success');
      setConsolidateResult(null); // its summary may reference a row that no longer exists
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      await refetchSessions(); // keeps the list truthful even on partial failure
      setClearingAll(false);
    }
  }
  const [acctUsername, setAcctUsername] = createSignal('');
  const [acctEmail, setAcctEmail] = createSignal('');
  const [acctRole, setAcctRole] = createSignal<import('../lib/api.js').OwnerRole>('member');
  const [acctBusy, setAcctBusy] = createSignal(false);
  const [acctFormOpen, setAcctFormOpen] = createSignal(false);
  // With no SMTP the server hands the invite link back instead of emailing it —
  // shown once so the operator can forward it out-of-band.
  const [inviteLink, setInviteLink] = createSignal<{ username: string; link: string } | null>(null);
  function handleInvite(username: string, invite: import('../lib/api.js').InviteResult) {
    if (invite.delivery === 'email') {
      setInviteLink(null);
      showToast(`Invite link emailed to ${invite.to}`, 'success');
    } else {
      setInviteLink({ username, link: invite.link });
      showToast('No outgoing email configured — copy the link below and send it to them', 'default');
    }
  }
  async function createAccount() {
    setAcctBusy(true);
    try {
      const r = await api.accounts.create({ username: acctUsername().trim(), email: acctEmail().trim(), role: acctRole() });
      setAcctUsername(''); setAcctEmail(''); setAcctRole('member'); setAcctFormOpen(false);
      await refetchAccounts();
      handleInvite(r.account.username ?? '', r.invite);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setAcctBusy(false);
    }
  }
  async function sendInvite(a: import('../lib/api.js').OwnerAccount) {
    setAcctBusy(true);
    try {
      const r = await api.accounts.invite(a.id);
      handleInvite(a.username ?? '', r.invite);
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      setAcctBusy(false);
    }
  }
  async function changeRole(id: string, role: import('../lib/api.js').OwnerRole) {
    try {
      await api.accounts.update(id, { role });
      await refetchAccounts();
      showToast('Role updated — the user is signed out and gets the new role on next login', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
      await refetchAccounts(); // restore the select to the server's value
    }
  }
  async function deleteAccount(a: import('../lib/api.js').OwnerAccount) {
    if (!window.confirm(`Delete the account "${a.name}" and ALL of its data? This cannot be undone.`)) return;
    try {
      await api.accounts.delete(a.id);
      await refetchAccounts();
      showToast('Account deleted', 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  const [memStatus, { refetch: refetchMem }] = createResource(() => api.memory.status());
  const [importBusy, setImportBusy] = createSignal(false);

  // WP7: live-refresh the connection health after a sync_calendar run completes.
  // Registered once at component setup (NOT inside a reactive effect) so we never
  // stack duplicate SSE subscriptions on re-render.
  on('job:run', () => refetchIntegrations());

  // After the OAuth callback redirects back to /settings?google=connected|error,
  // surface a toast once and strip the query param so it doesn't re-fire on refresh.
  // FTUE · T12 — when the onboarding wizard itself started this connect, it sets
  // FTUE_RESUME_KEY before navigating away; OnboardingWizard's own onMount owns the
  // toast/advance/strip for that case (Settings mounts first in the tree, so it can
  // safely defer here without removing the marker — the wizard claims it next).
  onMount(() => {
    const q = new URLSearchParams(window.location.search);
    const g = q.get('google');
    const wizardInitiated = g && localStorage.getItem(FTUE_RESUME_KEY);
    if (g && !wizardInitiated) {
      if (g === 'connected') { showToast('Google account connected', 'success'); refetchConnections(); refetchIntegrations(); }
      else if (g === 'error') { showToast(`Google connect failed${q.get('reason') ? `: ${q.get('reason')}` : ''}`, 'error'); }
    }
    // AA0b — the memory CI-Portal connector callback bounces back here too.
    const m = q.get('memory');
    if (m === 'connected') { showToast('Connected to Companion Memory via CI-Portal', 'success'); refetchPrefs(); refetchMem(); }
    else if (m === 'error') { showToast(`CI-Portal connect failed${q.get('reason') ? `: ${q.get('reason')}` : ''}`, 'error'); }
    if ((g && !wizardInitiated) || m) {
      q.delete('google'); q.delete('memory'); q.delete('reason');
      const qs = q.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : ''));
    }
  });

  // WP7: kick off the OAuth flow via the typed api.oauth helper (was a raw fetch()).
  async function connectGoogle() {
    if (!integrations()?.google.liveEnabled) return;
    try {
      const { url } = await api.oauth.googleStart();
      window.location.href = url;
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  // T13 (#349): disconnect one connection via the provider-agnostic api.connections
  // helper (Google also revokes server-side). Refetch BOTH resources: `connections`
  // drives the Connected-accounts card, `integrations` the WP7 health sub-line.
  async function disconnectAccount(provider: string, account: string) {
    try {
      await api.connections.disconnect(provider, account);
      showToast(`Disconnected ${account}`, 'success');
    } catch (err) {
      showToast((err as Error).message, 'error');
    } finally {
      refetchConnections();
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
  /** Effective models that aren't pulled — the difference between "Ollama is up" and
   *  "AI actually works". Empty on older servers that don't report it. */
  const missingModels = () => integrations()?.ollama.missingModels ?? [];
  /** Cautions about models the server AUTO-SELECTED (never about a deliberate choice).
   *  Empty on older servers that don't report it. */
  const modelWarnings = () => integrations()?.ollama.modelWarnings ?? [];

  // Phase AA · AA0 — connect the CI-Server memory appliance (URL + API key). The key
  // travels once and is stored KEK-encrypted server-side; the status never echoes it.
  const [memConnectOpen, setMemConnectOpen] = createSignal(false);
  const [memUrl, setMemUrl] = createSignal('');
  const [memApiKey, setMemApiKey] = createSignal('');
  const [memBusy, setMemBusy] = createSignal(false);
  async function connectMemory() {
    if (!memUrl().trim()) { showToast('Enter the CI-Server URL', 'error'); return; }
    setMemBusy(true);
    try {
      await api.memory.connect({ url: memUrl().trim(), ...(memApiKey().trim() ? { api_key: memApiKey().trim() } : {}) });
      setMemConnectOpen(false);
      setMemUrl(''); setMemApiKey('');
      refetchPrefs(); refetchMem();
      showToast('Connected to Companion Memory', 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setMemBusy(false); }
  }
  // AA0b — begin the CI-Portal SSO connect flow. GET /memory/ciportal/start returns
  // { url }; we fetch it (credentialed) then top-level-navigate to the portal. The
  // callback stores an offline_access refresh token and bounces to ?memory=connected.
  async function connectMemoryViaPortal() {
    setMemBusy(true);
    try {
      const { url } = await api.memory.ciportalStart();
      window.location.href = url;
    } catch (err) {
      showToast((err as Error).message || 'Could not start CI-Portal connect', 'error');
      setMemBusy(false);
    }
  }
  // Memory disconnects through the ONE provider-agnostic route, exactly like Google:
  // DELETE /api/connections/ci_memory/:account (which also clears the stored account
  // label, so the panel below re-renders as "Not connected"). The account is the
  // CI-Server host the connection was stored under.
  async function disconnectMemory() {
    const account = memStatus()?.account ?? memStatus()?.pull.host;
    if (!account) return;
    try {
      await api.connections.disconnect('ci_memory', account);
      refetchPrefs(); refetchMem(); refetchConnections();
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
          onClick={() => setActiveTab('profile')}
          class="px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px"
          classList={{
            'border-primary text-foreground': activeTab() === 'profile',
            'border-transparent text-muted-foreground hover:text-foreground': activeTab() !== 'profile',
          }}
        >
          Profile
        </button>
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
        <button
          type="button"
          onClick={() => setActiveTab('logs')}
          class="px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px flex items-center gap-1.5"
          classList={{
            'border-primary text-foreground': activeTab() === 'logs',
            'border-transparent text-muted-foreground hover:text-foreground': activeTab() !== 'logs',
          }}
        >
          <ScrollText size={13} /> Logs
        </button>
      </div>

      <form onSubmit={save} class="flex flex-col gap-5">

        {/* ── PROFILE TAB ─────────────────────────────────────────────────────── */}
        <Show when={activeTab() === 'profile'}>

          {/* Your Profile — the owner's own identity. Merges what used to be two cards
              ("Profile" + "Account"): the split put the display name and the login
              handle on separate cards for no reason a user could see. */}
          <Show when={me()}>
            <section class="card">
              <div
                class="section-label mb-3"
                title="Your name, sign-in handle and email. The email is where password-reset links go on local-login deployments."
              >
                Your Profile
              </div>
              <div class="flex flex-col gap-2">
                <label class="flex flex-col gap-1">
                  <span class="text-[11px] text-muted-foreground">Name</span>
                  <input
                    type="text"
                    class="input py-1 text-sm"
                    placeholder="Your name"
                    value={profileName()}
                    onInput={(e) => setProfileName(e.currentTarget.value)}
                  />
                </label>
                {/* Local-login only: an SSO owner has no username to change. */}
                <Show when={hasUsername()}>
                  <label class="flex flex-col gap-1">
                    <span class="text-[11px] text-muted-foreground">Username</span>
                    <input
                      type="text"
                      class="input py-1 text-sm font-mono"
                      autocomplete="off"
                      spellcheck={false}
                      placeholder="your-handle"
                      value={profileUsername()}
                      onInput={(e) => setProfileUsername(e.currentTarget.value)}
                    />
                    <span class="text-[10px] text-muted-foreground">
                      This is what you sign in with. Case-sensitive, and must be unique.
                    </span>
                  </label>
                </Show>
                <label class="flex flex-col gap-1">
                  <span class="text-[11px] text-muted-foreground">Email</span>
                  <input
                    type="email"
                    class="input py-1 text-sm"
                    placeholder="you@example.com"
                    value={profileEmail()}
                    onInput={(e) => setProfileEmail(e.currentTarget.value)}
                  />
                </label>
                <div class="flex justify-end">
                  <button
                    type="button"
                    class="btn-primary text-sm px-3 py-1.5"
                    onClick={saveProfile}
                    disabled={profileSaving() || !profileDirty() || !profileName().trim()}
                  >
                    {profileSaving() ? 'Saving…' : 'Save profile'}
                  </button>
                </div>

                {/* Backup reset address — a separate endpoint, so its own Save. */}
                <Show when={localAuth()}>
                  <label class="flex flex-col gap-1 pt-3 mt-1 border-t border-border">
                    <span
                      class="text-[11px] text-muted-foreground"
                      title="Password-reset links go to your account email above. A backup address is used as a fallback when the primary is unavailable."
                    >
                      Backup email
                    </span>
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
                </Show>
              </div>
            </section>
          </Show>

          {/* Phase AG — Accounts (operator-only; non-operators never see this card,
              and the server 403s them anyway). Only rendered behind the auth gate:
              test/standalone deployments have no login accounts to manage. */}
          <Show when={authCfg()?.mode === 'sso' && me()?.isOperator && accounts()}>
            <section class="card">
              <div class="flex items-center justify-between mb-3">
                <div class="section-label flex items-center gap-1.5" title="Operators manage accounts, system jobs, and the Google connection. Members plan their own days. Viewers are read-only. Role changes sign the user out everywhere."><Users size={12} /> Team</div>
                <Show when={localAuth() && !acctFormOpen()}>
                  <button type="button" onClick={() => setAcctFormOpen(true)} class="btn-secondary text-xs px-3 py-1.5">
                    <Plus size={12} /> New account
                  </button>
                </Show>
              </div>
              {/* Create form (local login only — SSO users are provisioned on first portal sign-in) */}
              <Show when={acctFormOpen()}>
                <div class="flex flex-col gap-2 p-3 mb-3 rounded-md bg-muted/40 border border-border">
                  <div class="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    <label class="flex flex-col gap-1">
                      <span class="text-[11px] text-muted-foreground">Username</span>
                      <input class="input py-1 text-sm" type="text" autocomplete="off"
                        value={acctUsername()} onInput={(e) => setAcctUsername(e.currentTarget.value)} />
                    </label>
                    <label class="flex flex-col gap-1">
                      <span class="text-[11px] text-muted-foreground">Email <span class="opacity-70">· the invite goes there</span></span>
                      <input class="input py-1 text-sm" type="email" autocomplete="off" placeholder="them@example.com"
                        value={acctEmail()} onInput={(e) => setAcctEmail(e.currentTarget.value)} />
                    </label>
                    <label class="flex flex-col gap-1">
                      <span class="text-[11px] text-muted-foreground">Role</span>
                      <select class="input py-1 text-sm" value={acctRole()}
                        onChange={(e) => setAcctRole(e.currentTarget.value as import('../lib/api.js').OwnerRole)}>
                        <option value="member">Member</option>
                        <option value="viewer">Viewer</option>
                        <option value="operator">Operator</option>
                      </select>
                    </label>
                  </div>
                  <p class="text-[11px] text-muted-foreground">
                    They get a single-use link to set their own password (valid 7 days) — you never handle it.
                  </p>
                  <div class="flex items-center gap-2 justify-end">
                    <button type="button" onClick={() => setAcctFormOpen(false)} class="btn-ghost text-xs px-2 py-1">Cancel</button>
                    <button type="button" onClick={createAccount}
                      disabled={acctBusy() || !acctUsername().trim() || !acctEmail().trim().includes('@')}
                      class="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed">
                      <Plus size={12} /> {acctBusy() ? 'Creating…' : 'Create & send invite'}
                    </button>
                  </div>
                </div>
              </Show>

              {/* SMTP-free fallback: the server handed the link back — shown once. */}
              <Show when={inviteLink()}>
                <div class="flex flex-col gap-1.5 p-3 mb-3 rounded-md border border-amber-500/40 bg-amber-500/10">
                  <div class="flex items-center justify-between gap-2">
                    <span class="text-xs text-foreground font-medium">
                      Set-password link for “{inviteLink()!.username}” — no outgoing email is configured, so send it to them yourself.
                    </span>
                    <button type="button" onClick={() => setInviteLink(null)} class="btn-ghost text-xs px-2 py-1"><X size={12} /></button>
                  </div>
                  <code class="text-[11px] font-mono break-all select-all">{inviteLink()!.link}</code>
                  <span class="text-[11px] text-muted-foreground">Single use · shown only once — it isn't stored anywhere else.</span>
                </div>
              </Show>

              <div class="flex flex-col gap-2">
                <For each={accounts() ?? []}>
                  {(a) => (
                    <div class="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2">
                      <div class="flex items-center justify-between gap-2 flex-wrap">
                        <div class="min-w-0">
                          <span class="text-xs text-foreground font-medium truncate">{a.name}</span>
                          <span class="text-[11px] text-muted-foreground ml-2">
                            {a.username ?? a.email ?? '—'}{a.id === me()!.ownerId ? ' · you' : ''}
                            {!a.username ? ' · signs in via CI-Portal' : ''}
                          </span>
                          <Show when={a.username && !a.hasPassword}>
                            <span class="text-[10px] px-1.5 py-0.5 ml-2 rounded-full bg-amber-500/15 text-amber-400">invite pending</span>
                          </Show>
                        </div>
                        <div class="flex items-center gap-1.5 shrink-0">
                          <select
                            class="input py-0.5 text-xs w-auto"
                            value={a.role}
                            disabled={a.id === me()!.ownerId}
                            title={a.id === me()!.ownerId ? 'Another operator must change your role' : 'Set this account\'s role'}
                            onChange={(e) => changeRole(a.id, e.currentTarget.value as import('../lib/api.js').OwnerRole)}
                          >
                            <option value="operator">Operator</option>
                            <option value="member">Member</option>
                            <option value="viewer">Viewer</option>
                          </select>
                          <Show when={a.username}>
                            <button type="button" class="btn-ghost text-xs px-2 py-1" disabled={acctBusy()}
                              title={a.hasPassword
                                ? 'Email them a single-use password-reset link'
                                : 'Send the set-password invite again (replaces the previous link)'}
                              onClick={() => sendInvite(a)}>
                              <KeyRound size={12} /> {a.hasPassword ? 'Send reset link' : 'Resend invite'}
                            </button>
                          </Show>
                          <Show when={a.id !== me()!.ownerId}>
                            <button type="button" class="btn-ghost text-xs px-2 py-1 text-destructive"
                              title="Delete this account and all of its data"
                              onClick={() => deleteAccount(a)}>
                              <Trash2 size={12} />
                            </button>
                          </Show>
                        </div>
                      </div>
                    </div>
                  )}
                </For>
              </div>
            </section>
          </Show>


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

        </Show>

        {/* ── PREFERENCES TAB ─────────────────────────────────────────────────── */}
        <Show when={activeTab() === 'preferences'}>

          {/* Schedule Patterns — per-direction availability windows */}
          <section class="card">
            <div class="flex items-center justify-between mb-1">
              <div class="section-label" title="Define day types, assign them to each weekday, and set per-direction availability windows. Auto places direction-tagged tasks only inside these windows. Changes save as you make them.">Schedule Patterns</div>
              <button type="button" onClick={doSave} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
            </div>
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

          {/* Planner display — appearance + configurable night-collapse boundaries.
              These write straight through (view_prefs; no migration) and apply live. */}
          <section class="card">
            <div class="section-label mb-1" title="Visual options for the Today planner. Changes apply immediately.">Planner display</div>
            {/* Direction textures (view_prefs.appearance.direction_textures) */}
            <label class="flex items-start gap-2 cursor-pointer select-none">
              <button type="button" role="switch" aria-checked={texturesEnabled()}
                onClick={() => setTexturesEnabled(!texturesEnabled())}
                class="relative w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5"
                classList={{ 'bg-primary': texturesEnabled(), 'bg-muted border border-border': !texturesEnabled() }}>
                <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-card transition-transform"
                  classList={{ 'translate-x-4': texturesEnabled() }} />
              </button>
              <div>
                <div class="text-sm text-foreground leading-tight">Direction textures</div>
                <div class="text-[11px] text-muted-foreground">Paint the subtle Home / Work / Community routine texture behind task cards and planner chips.</div>
              </div>
            </label>
            {/* Night-collapse boundaries (view_prefs.planner.topEndMin / bottomStartMin) */}
            <div class="mt-4 pt-3 border-t border-border flex flex-col gap-3">
              <label class="flex items-center justify-between gap-3">
                <div>
                  <div class="text-sm text-foreground leading-tight">Collapse night until</div>
                  <div class="text-[11px] text-muted-foreground">Morning end of the planner's collapsed midnight bar (default 7 AM).</div>
                </div>
                <select class="input py-1 text-sm w-24 flex-shrink-0"
                  value={topCollapseEnd(plannerAxisState())}
                  onChange={(e) => setPlannerCollapseBounds(Number(e.currentTarget.value), bottomCollapseStart(plannerAxisState()))}>
                  <For each={Array.from({ length: 12 }, (_, i) => (i + 1) * 60)}>
                    {(m) => <option value={m}>{m === 720 ? '12 PM' : `${m / 60} AM`}</option>}
                  </For>
                </select>
              </label>
              <label class="flex items-center justify-between gap-3">
                <div>
                  <div class="text-sm text-foreground leading-tight">Collapse night from</div>
                  <div class="text-[11px] text-muted-foreground">Evening start of the collapsed bar that runs to midnight (default 9 PM).</div>
                </div>
                <select class="input py-1 text-sm w-24 flex-shrink-0"
                  value={bottomCollapseStart(plannerAxisState())}
                  onChange={(e) => setPlannerCollapseBounds(topCollapseEnd(plannerAxisState()), Number(e.currentTarget.value))}>
                  <For each={Array.from({ length: 12 }, (_, i) => 720 + i * 60)}>
                    {(m) => <option value={m}>{m === 720 ? '12 PM' : `${(m - 720) / 60} PM`}</option>}
                  </For>
                </select>
              </label>
            </div>
          </section>

          {/* Pattern Tags — expandable rows (shape, colour, default minutes per direction tag) */}
          <section class="card">
            <div class="section-label flex items-center gap-1.5 mb-1" title="Shape, colour, and default estimate for each direction tag. The default time is used when a task has no intention tag."><Shapes size={12} /> Pattern Tags</div>
            <PatternBlockSettings />
          </section>

          {/* Time Block Categories — the kind='category' catalog (0069/0126): colour + name (duration lives on Pattern Tags) */}
          <section class="card">
            <div class="section-label flex items-center gap-1.5 mb-1" title={'Quick "types of time" for time blocks (Personal, Professional, Social + your own). Pick a colour; the defaults can be renamed and recoloured but not deleted. Group their intention tags on the Tags → Time Block Categories tab.'}><Tags size={12} /> Time Block Categories</div>
            <CategorySettings />
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

          </section>

          {/* Reminders — deliberately NOT inside Time-Block Settings. Reminders are a
              TASK concept, not a block one: engine/reminders.ts anchors on the task's
              scheduled_for+task_time OR its due_at, so a task with a due date and no
              block at all still gets one, and the offsets are unioned across every
              direction row so even an untagged task is covered. Blocks are a reminder
              target only for the three Focus-Ritual cues. */}
          <section class="card">
            <div class="flex items-center justify-between mb-3">
              <div
                class="section-label flex items-center gap-1.5"
                title="Applies to every task with a time or a due date — not just ones on the planner. Shared by Home, Community and Work. Reminders fire in-app; enable push for delivery when the app is closed."
              ><BellRing size={12} /> Reminders</div>
              <button type="button" onClick={saveReminderDefaults} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
            </div>
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
          </section>

          {/* Routine Settings — recall behaviour + Time-Sense + AI ordering */}
          <section class="card">
            <div class="flex items-center justify-between mb-3">
              <div class="section-label">Routine Settings</div>
              <button type="button" onClick={doSave} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
            </div>
            {/* Orphaned setting (see #392): NO Recall action exists anywhere in the UI
                (api.tasks.recall has zero callers), so this toggle persists but
                currently governs nothing. */}
            <Toggle field="recall_keeps_pattern" label="Recall keeps Routine membership"
              hint="When recalling a shelved (Past) task, also re-link it to its Routine. Off (default) → recall makes a clean, standalone task." />

            {/* Phase Z master flag — gates the Focus Ritual, tag-scoped estimate
                calibration, and the evening EOD Alignment while the phase ships dark. */}
            <Toggle field="time_sense_enabled" label="Time-Sense"
              hint="Focus Ritual block timers, tag-scoped estimate calibration, and the evening alignment. Experimental; off by default." />

            {/* Triality master flag (0139) — the feature ships dark; until the banner
                and metrics land, flipping this only changes the prefs payload. */}
            <Toggle field="triality_enabled" label="Triality"
              hint="Three next-action suggestions — Habitual · Contextual · Novel — as a dismissable banner on Focus, with outcome metrics on Balance. Experimental; off by default." />

            {/* Phase Z · Z5 — per-cue channel matrix. Only meaningful when Time-Sense
                is on; the individual channels are configurable per §4 (every cue
                disableable). Haptic + ambient color are seeded from the study arm on
                first enable; the arm itself is fixed and read-only (§5.2). */}
            <Show when={form().time_sense_enabled}>
              <div class="mt-3 ml-2 pl-3 border-l border-border flex flex-col gap-2.5">
                <Toggle field="focus_ritual_enabled" label="Focus screen"
                  hint="The full-screen block timer with progressive disclosure and the 'what's next' modal." />
                <Toggle field="haptic_cues_enabled" label="Haptic cues"
                  hint="Vibration pulses at the start, midpoint, 3-min warning, and end (where the device supports it)." />
                <Toggle field="ambient_color_enabled" label="Ambient color"
                  hint="Category-color depletion across the block, breathing in the final 3 minutes." />
                <Toggle field="calibration_loop_enabled" label="Calibration nudge"
                  hint="The suggest-only estimate chip based on your tag-scoped history." />
                {/* #390: the combo-suggestion confirm workflow — reads live prefs (not
                    the unsaved form) so it appears/disappears with the SAVED flags. */}
                <CalibrationPins />
                <Show when={prefs()?.z_experiment_arm}>
                  <div class="text-[11px] text-muted-foreground">
                    Study arm <span class="font-mono text-foreground">{prefs()!.z_experiment_arm}</span> — assigned once, fixed for the study.
                  </div>
                </Show>
              </div>
            </Show>

            {/* AI day ordering toggle — saved immediately, not via the Save button. Hidden
                when Ollama is unreachable (the toggle would be a no-op — the server falls
                back to basic order); the note points to the Connections tab to enable it.
                planning_mode is NOT reset, so the choice returns when Ollama does. */}
            <Show
              when={aiAvailable()}
              fallback={
                <div class="text-[11px] text-muted-foreground">
                  AI day ordering needs Ollama — start it, then re-check under Connections → Integrations.
                </div>
              }
            >
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
                    </div>
                  </div>
                </label>
              );
            })()}
            </Show>

            {/* The Suggest / Schedule toggle lives in the Day Overview header (Today view). */}
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
                  {/* Ollama running but the selected model isn't pulled: the old UI showed a
                      plain green "available" here while every AI call failed with
                      `model '…' not found`. Name the missing model and what to do. */}
                  <Show when={missingModels().length > 0}>
                    <div class="flex items-start gap-2 text-[11px] text-amber-400">
                      <AlertTriangle size={12} class="mt-0.5 flex-shrink-0" />
                      <span>
                        Ollama is running, but {missingModels().join(', ')}{' '}
                        {missingModels().length === 1 ? 'is' : 'are'} not installed — AI features stay off.
                        Pull {missingModels().length === 1 ? 'it' : 'them'} with <span class="font-mono">ollama pull</span>, or pick an
                        installed model below.
                      </span>
                    </div>
                  </Show>
                  {/* Installed and reachable, but the app had to GUESS which model to use
                      and the best it found does not advertise tool use. Distinct from the
                      missing-model case above: every call succeeds, the answers are just
                      quietly poor — which is exactly how a 1B vision model ended up
                      driving tagging and quick-add on a real install. */}
                  <For each={modelWarnings()}>
                    {(warning) => (
                      <div class="flex items-start gap-2 text-[11px] text-amber-400">
                        <AlertTriangle size={12} class="mt-0.5 flex-shrink-0" />
                        <span>{warning}</span>
                      </div>
                    )}
                  </For>
                  <ModelSelect label="Fast model" hint="extraction & triage" field="fast_model" fallback={integrations()!.ollama.fastModel} />
                  <ModelSelect label="Quality model" hint="briefings" field="quality_model" fallback={integrations()!.ollama.qualityModel} />
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

            {/* Connection (shared: AA0 pull now, AA4 push later) */}
            <div class="flex flex-col gap-2 mb-4">
              <Show
                when={memStatus()?.pull.available}
                fallback={
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-xs text-muted-foreground">Not connected</span>
                    <div class="flex items-center gap-1.5">
                      {/* AA0b — SSO path (multi-tenant): a refresh token is stored so the
                          connector self-refreshes; no key to paste. */}
                      <Show when={ssoAvailable()}>
                        <button type="button" onClick={connectMemoryViaPortal} disabled={memBusy()} class="btn-secondary text-xs px-3 py-1.5">
                          <Link2 size={12} /> {memBusy() ? 'Connecting…' : 'Sign in with CI-Portal'}
                        </button>
                      </Show>
                      <button type="button" onClick={() => setMemConnectOpen(!memConnectOpen())} class="btn-ghost text-xs px-3 py-1.5">
                        <Show when={ssoAvailable()} fallback={<><Link2 size={12} /> Connect</>}>URL + key</Show>
                      </button>
                    </div>
                  </div>
                }
              >
                {/* "available" only means the URL/key parsed and are stored — it is NOT
                    proof CI-Server actually answered. Only a completed sync/pull is that
                    proof, so the label stays honest until lastSyncedAt is real (owner
                    request 2026-07-23: the prior unconditional "Connected" read as a lie
                    when the host turned out to be unreachable). */}
                <div class="flex items-center justify-between gap-3">
                  <span class="flex items-center gap-1.5 text-xs text-foreground">
                    <Show
                      when={memStatus()!.lastSyncedAt}
                      fallback={<AlertTriangle size={13} class="text-amber-400" />}
                    >
                      <CheckCircle2 size={13} class="text-primary" />
                    </Show>
                    <Show
                      when={memStatus()!.lastSyncedAt}
                      fallback={<>Saved, not yet verified — {memStatus()!.pull.host}</>}
                    >
                      Connected to {memStatus()!.pull.host}
                    </Show>
                    <Show when={memStatus()!.pull.authKind === 'oidc'}>
                      <span class="text-muted-foreground">(via CI-Portal)</span>
                    </Show>
                    <Show when={memStatus()!.pull.source === 'env'}>
                      <span class="text-muted-foreground">(from server environment)</span>
                    </Show>
                  </span>
                  <Show when={memStatus()!.pull.source === 'settings'}>
                    <button type="button" onClick={disconnectMemory} class="btn-ghost text-xs px-2 py-1">
                      <Unlink size={12} /> Disconnect
                    </button>
                  </Show>
                </div>
                <Show when={!memStatus()!.lastSyncedAt}>
                  <p class="text-[11px] text-muted-foreground">
                    Credentials are saved, but nothing has synced yet — hit "Sync now" below to confirm CI-Server actually answers.
                  </p>
                </Show>
              </Show>

              {/* Inline connect form */}
              <Show when={memConnectOpen() && !memStatus()?.pull.available}>
                <div class="flex flex-col gap-2 p-3 rounded-md bg-muted/40 border border-border">
                  <label class="flex flex-col gap-1">
                    <span class="text-xs text-muted-foreground">CI-Server URL</span>
                    <input class="input" type="url" placeholder="http://localhost:3000"
                      value={memUrl()} onInput={(e) => setMemUrl(e.currentTarget.value)} />
                  </label>
                  <label class="flex flex-col gap-1">
                    <span class="text-xs text-muted-foreground">API key <span class="opacity-70">· stored encrypted, never shown again</span></span>
                    <input class="input" type="password" autocomplete="off"
                      value={memApiKey()} onInput={(e) => setMemApiKey(e.currentTarget.value)} />
                  </label>
                  <div class="flex items-center gap-2 justify-end">
                    <button type="button" onClick={() => setMemConnectOpen(false)} class="btn-ghost text-xs px-2 py-1">Cancel</button>
                    <button type="button" onClick={connectMemory} disabled={memBusy()} class="btn-secondary text-xs px-3 py-1.5">
                      <Link2 size={12} /> {memBusy() ? 'Connecting…' : 'Connect'}
                    </button>
                  </div>
                </div>
              </Show>
            </div>

            {/* Pull toggle (Phase AA) — memory suggestions are enriched through Ollama, so
                hide the control when AI is unavailable (the connection + push sync below
                stay, since backup doesn't depend on Ollama). */}
            <Show when={aiAvailable()}>
            <label class="flex items-start gap-3 cursor-pointer select-none mb-4">
              <button
                type="button"
                role="switch"
                aria-checked={form().memory_pull_enabled}
                onClick={() => setField('memory_pull_enabled', !form().memory_pull_enabled)}
                class="relative w-9 h-5 rounded-full transition-colors flex-shrink-0 mt-0.5"
                classList={{ 'bg-primary': form().memory_pull_enabled, 'bg-muted border border-border': !form().memory_pull_enabled }}
              >
                <span class="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-card transition-transform"
                  classList={{ 'translate-x-4': form().memory_pull_enabled }} />
              </button>
              <div class="flex-1">
                <div class="text-sm font-medium text-foreground">Use Memory for suggestions</div>
                <div class="text-xs text-muted-foreground mt-0.5">
                  Pull upcoming events from your Companion Memory directly into your task list (New Today).
                  <Show when={!memStatus()?.pull.available}> Connect Companion Memory first.</Show>
                </div>
              </div>
            </label>

            {/* How far AHEAD the pull reads. Forward, not back: suggestions mirror
                upcoming events into tasks, so a backward window would stage work for
                things that already happened. Same setting drives the daily brief. */}
            <Show when={form().memory_pull_enabled}>
              <label class="flex items-center justify-between gap-3 mb-4 -mt-2 pl-12">
                <span class="text-xs text-muted-foreground">
                  Look ahead
                  <span class="block text-[11px] opacity-70">How many days of upcoming events to pull in.</span>
                </span>
                <span class="flex items-center gap-1.5 flex-shrink-0">
                  <input type="number" class="input py-1 text-sm w-20" min={1} max={30} step={1}
                    value={form().memory_window_days}
                    onInput={(e) => setField('memory_window_days', Number(e.currentTarget.value))} />
                  <span class="text-xs text-muted-foreground">days</span>
                </span>
              </label>
            </Show>
            </Show>

            {/* Master toggle (one-way push) */}
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

            {/* Scopes (only meaningful when push sync is enabled) */}
            <Show when={form().memory_sync_enabled}>
              <div class="flex flex-col gap-3 mt-4 pt-4 border-t border-border">
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
                  </span>
                  <button type="button" onClick={syncNow} class="btn-secondary text-xs px-3 py-1.5"
                    disabled={!memStatus()?.connected}>
                    <RefreshCw size={12} /> Sync now
                  </button>
                </div>
              </div>
            </Show>
          </section>

          {/* Email suggestions — the one knob on the Gmail ingest. Sits beside Companion
              Memory because both are ingestion windows, and follows the same visibility
              rule as the rest of the Google surface (flags.ts). The ingest itself is
              review-gated, so this bounds what reaches the queue, not what becomes a task. */}
          <Show when={GOOGLE_CONNECT_ENABLED}>
            <section class="card">
              <div class="flex items-center justify-between mb-3">
                <div class="section-label flex items-center gap-1.5"><Mail size={12} /> Email suggestions</div>
                <button type="button" onClick={doSave} class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors"><Save size={11} /> Save</button>
              </div>
              <label class="flex items-center justify-between gap-3">
                <span class="text-xs text-muted-foreground">
                  Look back
                  <span class="block text-[11px] opacity-70">
                    How far back to read a connected mailbox. Applies when email is first connected
                    (or after an outage) — routine checks only pick up what has arrived since the last one.
                  </span>
                </span>
                <span class="flex items-center gap-1.5 flex-shrink-0">
                  <input type="number" class="input py-1 text-sm w-20" min={1} max={90} step={1}
                    value={form().email_lookback_days}
                    onInput={(e) => setField('email_lookback_days', Number(e.currentTarget.value))} />
                  <span class="text-xs text-muted-foreground">days</span>
                </span>
              </label>
              <p class="text-[11px] text-muted-foreground mt-3">
                Suggestions from email wait for your approval in the Tasks tab — nothing becomes a task on its own.
              </p>
            </section>
          </Show>

          {/* Integrations */}
          <section class="card">
            <div class="flex items-center justify-between mb-3">
              <div class="section-label">Integrations</div>
              {/* Ollama can come up after the app — let an operator re-check without a reload. */}
              <button type="button" onClick={() => refetchIntegrations()} disabled={integrations.loading}
                class="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1 transition-colors">
                <RefreshCw size={11} class={integrations.loading ? 'animate-spin' : undefined} /> Re-check
              </button>
            </div>
            <Show when={integrations()} fallback={<div class="text-xs text-slate-500 animate-pulse2">Checking…</div>}>
              {(i) => (
                <div class="flex flex-col gap-3">
                  {/* Three states, not two. "Reachable" and "usable" are different: Ollama
                      answering while the selected model isn't pulled used to render a plain
                      green tick over completely dead AI features. Amber is that middle state. */}
                  <div class="flex items-center gap-3">
                    <Cpu size={16} classList={{
                      'text-green-400': aiAvailable(),
                      'text-amber-400': ollamaUp() && !aiAvailable(),
                      'text-red-400': !ollamaUp(),
                    }} />
                    <div class="flex-1">
                      <div class="text-sm text-slate-200 font-medium flex items-center gap-2">
                        Ollama
                        <Show when={ollamaUp()} fallback={<XCircle size={13} class="text-red-400" />}>
                          <Show when={aiAvailable()} fallback={<AlertTriangle size={13} class="text-amber-400" />}>
                            <CheckCircle2 size={13} class="text-green-400" />
                          </Show>
                        </Show>
                      </div>
                      <div class="text-xs text-slate-500 mt-0.5">
                        {!ollamaUp()
                          ? 'Unavailable — start Ollama on localhost:11434'
                          : !aiAvailable()
                            ? `Running, but ${missingModels().join(', ')} not installed — AI features are off`
                            : `${i().ollama.models.length} models · fast: ${i().ollama.fastModel} · quality: ${i().ollama.qualityModel}`}
                      </div>
                    </div>
                  </div>
                  {/* Google connection — hidden from the live app for now (flags.ts
                      GOOGLE_CONNECT_ENABLED); Companion Memory is the only connectable
                      source at launch. Server-side Google config/routes are untouched. */}
                  <Show when={GOOGLE_CONNECT_ENABLED}>
                  <div class="flex items-center gap-3">
                    <Globe size={16} class="text-blue-400" />
                    <div class="flex-1">
                      <div class="text-sm text-slate-200 font-medium">Google MCP</div>
                      <div class="text-xs text-slate-500 mt-0.5 capitalize">
                        Mode: {i().google.mode} · Gmail + Google Calendar
                        {i().google.source === 'env' ? ' · configured via server environment' : ''}
                        {i().google.source === 'app' ? ' · configured in-app' : ''}
                      </div>
                    </div>
                  </div>

                  {/* In-app Google OAuth client setup (admin only; hidden when GOOGLE_MODE
                      is pinned by the server environment). Saving hot-applies — the
                      Connect button below goes live without a restart. */}
                  <Show when={gcfg() && !gcfg()!.envPinned}>
                    <div class="flex flex-col gap-2 pl-7">
                      <span class="section-label">Google OAuth client</span>
                      <p class="text-xs text-slate-500">
                        Paste a Google OAuth client to enable Calendar sync — create one in the
                        Google Cloud console (APIs &amp; Services → Credentials) with the redirect
                        URI below. A Desktop-type client needs no secret.
                      </p>
                      <Show when={!gcfg()!.kekAvailable}>
                        <div class="flex items-center gap-1.5 text-[11px] text-amber-400">
                          <AlertTriangle size={11} /> Set CP_KEK_B64 on the server first (openssl rand -base64 32) — it encrypts the stored secret and OAuth tokens.
                        </div>
                      </Show>
                      <label class="flex flex-col gap-1">
                        <span class="text-[11px] text-muted-foreground">Client ID</span>
                        <input
                          type="text"
                          class="input py-1 text-sm font-mono"
                          placeholder="…apps.googleusercontent.com"
                          value={gClientId()}
                          onInput={(e) => setGClientId(e.currentTarget.value)}
                        />
                      </label>
                      <label class="flex flex-col gap-1">
                        <span class="text-[11px] text-muted-foreground">Client secret (optional)</span>
                        <input
                          type="password"
                          class="input py-1 text-sm font-mono"
                          placeholder={gcfg()!.hasClientSecret ? '(unchanged — enter to replace)' : 'GOCSPX-…'}
                          value={gClientSecret()}
                          onInput={(e) => setGClientSecret(e.currentTarget.value)}
                          autocomplete="off"
                        />
                      </label>
                      <div class="text-[11px] text-slate-500">
                        Redirect URI to register: <span class="font-mono select-all">{gcfg()!.redirectUri}</span>
                      </div>
                      <div class="flex items-center justify-end gap-2">
                        <Show when={gcfg()!.enabled}>
                          <button
                            type="button"
                            class="btn-ghost text-xs px-3 py-1.5"
                            onClick={() => saveGoogleConfig(false)}
                            disabled={gSaving()}
                          >
                            Disable
                          </button>
                        </Show>
                        <button
                          type="button"
                          class="btn-secondary text-xs px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed"
                          onClick={() => saveGoogleConfig(true)}
                          disabled={gSaving() || !gClientId().trim() || !gcfg()!.kekAvailable}
                          title={gcfg()!.kekAvailable ? 'Save the client and switch Google to live mode' : 'CP_KEK_B64 must be set on the server first'}
                        >
                          {gSaving() ? 'Saving…' : gcfg()!.enabled ? 'Save changes' : 'Save & enable'}
                        </button>
                      </div>
                    </div>
                  </Show>
                  </Show>
                </div>
              )}
            </Show>
          </section>

          {/* Connected accounts (T13 #349) — the provider-agnostic connection surface.
              Backed by the `connections` resource (GET /api/connections): one row per
              stored connection_tokens record in the one ConnectionRecord shape, whatever
              the provider, mode-blind so a user whose Google is `off` still sees (and can
              drop) a stored token. Google rows are enriched from
              integrations().google.connections (same shape, but decrypted: a real expiry,
              so 'expired' is distinguishable) matched on account.
              Google is currently the only provider with a connect flow, so the whole card
              is hidden with it (flags.ts GOOGLE_CONNECT_ENABLED — owner request 2026-07-23). */}
          <Show when={GOOGLE_CONNECT_ENABLED}>
          <section class="card">
            <div class="flex items-center justify-between mb-3">
              <div class="section-label flex items-center gap-1.5"><Link2 size={12} /> Connected accounts</div>
              {/* Connect is Google-only (the sole provider with a connect flow) and shows
                  only when Google is live and no Google account is connected yet. */}
              <Show when={integrations()?.google.liveEnabled && !(connections() ?? []).some((c) => c.provider === 'google')}>
                <button type="button" onClick={connectGoogle} class="btn-secondary text-xs px-3 py-1.5">
                  <Link2 size={12} /> Connect Google
                </button>
              </Show>
            </div>

            <Show
              when={(connections() ?? []).length > 0}
              fallback={
                <div class="text-xs text-slate-500">
                  <Show when={!connections.loading} fallback="Loading connections…">
                    No accounts connected.
                    {integrations()?.google.mode === 'fixture'
                      ? ' Fixture mode serves sample data only — no real account can be connected.'
                      : integrations()?.google.mode === 'off'
                        ? ' Configure a Google OAuth client under Integrations to enable connecting.'
                        : ''}
                  </Show>
                </div>
              }
            >
              <div class="flex flex-col gap-2">
                <For each={connections()}>
                  {(c) => {
                    // One shape for every provider now; the google entry from
                    // /api/integrations adds only what a decrypt can tell us (a token
                    // that is stored but EXPIRED) plus the sync/mapped-event sub-line.
                    const health = () =>
                      c.provider === 'google'
                        ? integrations()?.google.connections.find((h) => h.account === c.account)
                        : undefined;
                    const status = () => health()?.status ?? c.status;
                    return (
                      <div class="flex flex-col gap-1 rounded-md border border-border px-3 py-2">
                        <div class="flex items-center justify-between gap-2">
                          <span class="text-xs text-slate-200 font-medium truncate">
                            <span class="text-slate-400 capitalize">{c.provider}</span>
                            <span class="text-slate-600"> · </span>
                            {c.account}
                          </span>
                          <div class="flex items-center gap-2 shrink-0">
                            <span
                              class="text-[10px] px-1.5 py-0.5 rounded-full capitalize"
                              // The three mapped states — the raw connection_tokens
                              // status ('active'/'revoked'/'error') no longer reaches
                              // the client, so there is nothing else to colour.
                              classList={{
                                'bg-green-500/15 text-green-400': status() === 'connected',
                                'bg-amber-500/15 text-amber-400': status() === 'expired',
                                'bg-slate-500/15 text-slate-400': status() === 'inactive',
                              }}
                            >
                              {status()}
                            </span>
                            {/* Never gated on liveEnabled: the DELETE route works in any
                                mode, and a user switching modes must keep an escape hatch
                                to drop a stored connection (its tokens outlive the mode). */}
                            <button
                              type="button"
                              onClick={() => disconnectAccount(c.provider, c.account)}
                              title="Disconnect this account"
                              class="btn-ghost text-xs px-2 py-1"
                            >
                              <Unlink size={12} /> Disconnect
                            </button>
                          </div>
                        </div>
                        <Show when={health()}>
                          {(h) => (
                            <>
                              <div class="flex items-center gap-3 text-[11px] text-slate-500">
                                <span>{h().lastSyncAt ? `Last sync: ${new Date(h().lastSyncAt!).toLocaleString()}` : 'Never synced'}</span>
                                <span>·</span>
                                <span>{h().mappedEventCount ?? 0} mapped event{h().mappedEventCount === 1 ? '' : 's'}</span>
                              </div>
                              <Show when={h().lastError}>
                                <div class="flex items-center gap-1.5 text-[11px] text-destructive">
                                  <AlertTriangle size={11} /> {h().lastError}
                                </div>
                              </Show>
                            </>
                          )}
                        </Show>
                        {/* 0145 — how this source's events look on the calendar. */}
                        <ConnectionAppearance provider={c.provider} account={c.account} />
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          </section>
          </Show>

          <button type="submit" class="btn-primary self-start px-5">
            <Save size={14} /> Save Settings
          </button>

        </Show>

        {/* ── LOGS TAB (T6 + T10) ─────────────────────────────────────────────── */}
        {/* Read/export/delete over T1's plan-week sessions — not part of the
            settings form submit (no fields here feed `form()`/`doSave`). */}
        <Show when={activeTab() === 'logs'}>
          <section class="card">
            <div class="flex items-center justify-between mb-1 gap-2">
              <div class="section-label flex items-center gap-1.5" title="Every Weekly-Planning-Assistant session — fill week, schedule tasks, and review — recorded for your own reference. Select sessions below to consolidate them into one summary."><ScrollText size={12} /> Planning-session logs</div>
              <div class="flex items-center gap-1.5 flex-shrink-0">
                <button
                  type="button"
                  class="btn-secondary text-xs px-3 py-1.5"
                  disabled={!selectedSessionIds().size || consolidating()}
                  onClick={consolidateSelectedSessions}
                >
                  <ScrollText size={12} /> {consolidating() ? 'Consolidating…' : `Consolidate (summarize)${selectedSessionIds().size ? ` (${selectedSessionIds().size})` : ''}`}
                </button>
                <button
                  type="button"
                  class="btn-danger text-xs px-3 py-1.5"
                  disabled={!sessions()?.length || clearingAll()}
                  onClick={clearAllSessions}
                >
                  <Trash2 size={12} /> {clearingAll() ? 'Clearing…' : 'Clear all'}
                </button>
              </div>
            </div>

            <Show when={consolidateResult()}>
              {(result) => (
                <div class="rounded-md border border-border bg-muted/40 px-3 py-2 mb-3">
                  <div class="flex items-center justify-between mb-0.5">
                    <div class="text-[11px] text-muted-foreground">
                      Consolidated summary
                      <Show when={result().source === 'model'}>
                        <span class="font-normal ml-0.5">(AI)</span>
                      </Show>
                    </div>
                    <button type="button" class="btn-icon" title="Dismiss" onClick={() => setConsolidateResult(null)}>
                      <X size={13} />
                    </button>
                  </div>
                  <p class="text-xs text-foreground whitespace-pre-wrap">{result().summary}</p>
                </div>
              )}
            </Show>

            <Show
              when={sessions()}
              fallback={<p class="text-xs text-muted-foreground py-4 text-center">Loading…</p>}
            >
              {(list) => (
                <Show
                  when={list().length > 0}
                  fallback={
                    <div class="flex flex-col items-center gap-1.5 py-8 text-muted-foreground">
                      <ScrollText size={20} class="opacity-50" />
                      <p class="text-xs">No planning sessions recorded yet.</p>
                    </div>
                  }
                >
                  <div class="flex flex-col gap-2">
                    <For each={list()}>
                      {(session) => (
                        <div class="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2">
                          <div class="flex items-center gap-2 min-w-0">
                            <input
                              type="checkbox"
                              class="accent-primary w-4 h-4 flex-shrink-0"
                              checked={selectedSessionIds().has(session.id)}
                              onChange={() => toggleSessionSelected(session.id)}
                            />
                            <div class="min-w-0">
                              <div class="text-sm text-foreground truncate">
                                {session.entry_branch.replace(/_/g, ' ')} · {session.started_at.slice(0, 10)}
                              </div>
                              <div class="text-[11px] text-muted-foreground">
                                {session.status} · {new Date(session.started_at).toLocaleString()}
                              </div>
                            </div>
                          </div>
                          <div class="flex items-center gap-1 flex-shrink-0">
                            <button type="button" class="btn-ghost text-xs px-2 py-1" title="Review" onClick={() => reviewSession(session.id)}>
                              <Eye size={13} />
                            </button>
                            <button type="button" class="btn-ghost text-xs px-2 py-1" title="Export JSON" onClick={() => downloadSession(session, 'json')}>
                              <FileJson size={13} />
                            </button>
                            <button type="button" class="btn-ghost text-xs px-2 py-1" title="Export Markdown" onClick={() => downloadSession(session, 'md')}>
                              <FileText size={13} />
                            </button>
                            <button type="button" class="btn-ghost text-xs px-2 py-1 text-destructive" title="Delete" onClick={() => deleteSession(session)}>
                              <Trash2 size={13} />
                            </button>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              )}
            </Show>
          </section>
        </Show>

      </form>

      {/* Review modal (T6) — a LOCAL signal, not the global elementModal (reserved
          for the ElementWizard). Closes on backdrop click or the X. */}
      <Show when={reviewing()}>
        {(session) => (
          <div class="modal-backdrop" onClick={() => setReviewing(null)}>
            <div class="modal max-w-lg" onClick={(e) => e.stopPropagation()}>
              <div class="px-4 py-3 border-b border-border flex items-center justify-between">
                <span class="text-sm font-semibold text-foreground">
                  {session().entry_branch.replace(/_/g, ' ')} · {session().started_at.slice(0, 10)}
                </span>
                <button class="btn-icon" onClick={() => setReviewing(null)}><X size={15} /></button>
              </div>

              <div class="p-4 flex flex-col gap-3 max-h-[60vh] overflow-y-auto">
                <div class="text-[11px] text-muted-foreground">
                  {session().status} · Started {new Date(session().started_at).toLocaleString()}
                  {session().ended_at ? ` · Ended ${new Date(session().ended_at!).toLocaleString()}` : ''}
                </div>
                <Show when={session().summary}>
                  <p class="text-xs text-foreground">{session().summary}</p>
                </Show>
                <Show
                  when={session().transcript.length > 0}
                  fallback={<p class="text-xs text-muted-foreground">No transcript entries.</p>}
                >
                  <div class="flex flex-col gap-2">
                    <For each={session().transcript}>
                      {(turn) => (
                        <div class="text-xs">
                          <span class="font-semibold text-foreground">{turn.role === 'system' ? 'System' : 'You'}</span>
                          <span class="text-muted-foreground"> · {new Date(turn.ts).toLocaleString()}</span>
                          <p class="text-foreground whitespace-pre-wrap mt-0.5">{turn.text}</p>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              <div class="px-4 py-3 border-t border-border flex items-center gap-2">
                <button type="button" class="btn-secondary text-xs px-3 py-1.5" onClick={() => downloadSession(session(), 'json')}>
                  <FileJson size={12} /> Export JSON
                </button>
                <button type="button" class="btn-secondary text-xs px-3 py-1.5" onClick={() => downloadSession(session(), 'md')}>
                  <FileText size={12} /> Export Markdown
                </button>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}
