import { Navigate, Route, Router, useLocation, useNavigate, useSearchParams } from '@solidjs/router';
import { ErrorBoundary, Show, createEffect, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { Plus, Cpu, Loader2, RefreshCw, PanelLeft } from 'lucide-solid';
import { DetailsDrawer, DetailsToggle } from './components/DetailsDrawer.js';
import { navCollapsed, toggleNav, detailsOpen } from './stores/ui.js';
import { Nav }      from './components/Nav.js';
import { CloseRitual } from './components/CloseRitual.js';
import { Login }    from './views/Login.js';
import { ResetPassword } from './views/ResetPassword.js';
import { authGateActive } from './lib/api.js';
import { BottomNav } from './components/BottomNav.js';
import { ToastContainer } from './components/Toast.js';
import { ConflictBanner } from './components/ConflictBanner.js';
import { UpdateBanner } from './components/UpdateBanner.js';
import { ElementWizard } from './components/ElementWizard.js';
import { PlanWeekAssistant } from './components/PlanWeekAssistant.js';
import { OnboardingWizard } from './components/OnboardingWizard.js';
import { ErrorBoundaryFallback } from './components/ErrorBoundaryFallback.js';
import { captureException } from './lib/telemetry.js';
import { Today }    from './views/Today.js';
import { Focus }    from './views/Focus.js';
import { Calendar } from './views/Calendar.js';
import { PrioritiesWizard } from './views/PrioritiesWizard.js';
import { Balance } from './views/Balance.js';
import { AllTasks } from './views/AllTasks.js';
import { Tags }     from './views/Tags.js';
import { Settings } from './views/Settings.js';
import { Jobs }     from './views/Jobs.js';
import { setElementModal, blocks, taskOf, tags, patternPrefs, prefs, refetchPrefs, showToast, refetchTasks, refetchBlocks, refetchFlightPlan, closeRitualTask, closeRitualQueue, advanceCloseRitual, clearCloseRitual } from './stores/index.js';
import { api } from './lib/api.js';
import {
  requestNotificationPermission,
  scheduleTaskReminders,
  type ReminderTask,
} from './lib/notifications.js';
import { RecurringScopeDialog } from './components/RecurringScopeDialog.js';

/**
 * T7 — wire browser reminders into the app root. Ask once for permission, then
 * (re)schedule whenever the day's scheduled blocks / pattern prefs / tag taxonomy
 * change, and again whenever the tab becomes visible (a `visibilitychange` tick the
 * effect depends on). The block→ReminderTask mapping lives here so notifications.ts
 * stays store-free: we resolve each block's task's kind='pattern' tag *names* to ids
 * via the tags() resource, keep only future starts, and feed patternPrefs to the
 * pure scheduler.
 */
function useTaskReminders() {
  // Bumped on each tab-visible event so the scheduling effect re-runs on focus.
  const [visibleTick, setVisibleTick] = createSignal(0);

  onMount(() => {
    requestNotificationPermission();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') setVisibleTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisibility);
    onCleanup(() => document.removeEventListener('visibilitychange', onVisibility));
  });

  createEffect(() => {
    visibleTick(); // re-run when the tab becomes visible

    // Pattern-tag name → id, for blocks/tasks that carry tag names rather than ids.
    const patternIdByName = new Map<string, string>();
    for (const t of tags() ?? []) {
      if (t.kind === 'direction') patternIdByName.set(t.name, t.id);
    }

    const now = Date.now();
    const reminders: ReminderTask[] = [];
    for (const b of blocks() ?? []) {
      const start = new Date(b.start_at);
      if (Number.isNaN(start.getTime()) || start.getTime() <= now) continue; // past/invalid
      const names = taskOf(b.task_id)?.tags ?? [];
      const patternTagIds: string[] = [];
      for (const name of names) {
        const id = patternIdByName.get(name);
        if (id) patternTagIds.push(id);
      }
      if (patternTagIds.length === 0) continue; // not pattern-tagged → no reminder
      reminders.push({ title: b.title, scheduledAt: start, patternTagIds });
    }

    scheduleTaskReminders(reminders, patternPrefs()?.prefs ?? {});
  });
}

/**
 * Routes that render the floating Create button. Shared by the FAB itself and by the
 * scroll container's bottom padding — they have to agree or the FAB sits on top of the
 * last row of content (it did: the button is 56px tall at `bottom-20`, i.e. its top
 * edge is 136px off the viewport floor, while the scroller reserved only `pb-16`/64px).
 */
const FAB_ROUTES = ['/', '/tasks', '/calendar', '/tags', '/focus', '/jobs'];

function Shell(props: { children?: any }) {
  const location = useLocation();
  useTaskReminders();
  const hasFab = () => FAB_ROUTES.includes(location.pathname);

  // The toggle drives the trust dial (scheduling_prefs.trust_mode, 0070): Schedule ⇔
  // 'hands_off' (new tasks auto-schedule on ingest, N-day planning horizon), Suggest ⇔
  // 'balanced'. 'cautious' (API-only today) also displays as Suggest — the same-mode
  // guard below means merely viewing never rewrites it; only an explicit Schedule →
  // Suggest round-trip lands on 'balanced'.
  const mode = () => (prefs()?.trust_mode === 'hands_off' ? 'schedule' : 'suggest');
  async function setMode(m: 'suggest' | 'schedule') {
    if (m === mode()) return;
    try { await api.prefs.update({ trust_mode: m === 'schedule' ? 'hands_off' : 'balanced' }); refetchPrefs(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  // Sweep-now (the review_day engine, on demand): auto-defer past-due tasks, revive
  // stuck 'missed' one-offs, and — in Schedule mode — place everything reopened into
  // its new day. The refetches repaint whatever the sweep touched.
  const [sweeping, setSweeping] = createSignal(false);
  async function sweepNow() {
    if (sweeping()) return;
    setSweeping(true);
    try {
      const { result: r } = await api.review.sweep();
      const moved = r.deferred + r.revived;
      const bits: string[] = [];
      if (moved) bits.push(`${moved} task${moved === 1 ? '' : 's'} rescheduled`);
      if (r.placed) bits.push(`${r.placed} placed`);
      if (r.restaged) bits.push(`${r.restaged} re-staged`);
      showToast(bits.length ? bits.join(' · ') : 'Nothing stale — all caught up', bits.length ? 'success' : 'default');
      await Promise.all([refetchTasks(), refetchBlocks(), refetchFlightPlan()]);
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setSweeping(false); }
  }

  return (
    <div class="flex h-screen overflow-hidden bg-surface-950" data-app-shell>
      <Nav />
      <main class="flex-1 flex flex-col overflow-hidden relative min-w-0">
        {/* Top bar */}
        {/* At 360px this row is over-subscribed: brand + Suggest/Schedule + sweep +
            date want ~376px of an available 328px. It used to resolve that by
            squeezing the flex items that could shrink, which are exactly the
            controls — the toggle clipped to "Sche" and the date wrapped to two
            lines, on every mobile frame. Now the BRAND absorbs the slack (it is the
            only thing here that can be shortened without losing meaning) and every
            control is pinned with flex-shrink-0. */}
        <div class="flex-shrink-0 h-11 border-b border-surface-700/40 flex items-center px-4 md:px-6 gap-2 md:gap-3 bg-surface-900/50">
          {/* Rail collapse — in the bar next to the edge it moves, not inside the rail
              that collapses, which would carry the button off with it. Desktop only:
              below md the rail is already hidden and the bottom tab bar navigates. */}
          <button
            type="button"
            class="btn-icon flex-shrink-0 hidden md:grid"
            aria-expanded={!navCollapsed()}
            aria-label={navCollapsed() ? 'Expand navigation' : 'Collapse navigation'}
            title={navCollapsed() ? 'Expand navigation' : 'Collapse navigation'}
            onClick={toggleNav}
          >
            <PanelLeft size={13} />
          </button>
          {/* Brand mark — hidden on desktop where the left rail shows it */}
          <div class="flex items-center gap-2 md:hidden min-w-0 flex-1">
            <div class="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 text-surface-950"
              style={{ background: 'linear-gradient(135deg, #58ebbf, #409b9b)' }}>
              <Cpu size={12} />
            </div>
            <span class="font-heading text-sm text-slate-100 tracking-wide truncate">Planning</span>
          </div>
          {/* Desktop-only spacer; on mobile the brand block above already takes the slack. */}
          <div class="hidden md:block flex-1" />
          {/* Suggest / Schedule toggle — global auto-mode; lives in the top bar */}
          <div
            class="inline-flex flex-shrink-0 rounded-full border border-surface-700/60 overflow-hidden text-[11px]"
            role="group"
            title="Suggest: nothing schedules until you press a button. Schedule: new tasks auto-schedule as they arrive; buttons still work for manual runs."
          >
            <button
              onClick={() => setMode('suggest')}
              class="px-2.5 py-0.5 transition-colors"
              classList={{ 'bg-primary text-primary-foreground': mode() === 'suggest', 'text-muted-foreground hover:text-foreground': mode() !== 'suggest' }}
            >Suggest</button>
            <button
              onClick={() => setMode('schedule')}
              class="px-2.5 py-0.5 transition-colors"
              classList={{ 'bg-primary text-primary-foreground': mode() === 'schedule', 'text-muted-foreground hover:text-foreground': mode() !== 'schedule' }}
            >Schedule</button>
          </div>
          {/* Sweep-now — run the review sweep on demand (the nightly review_day engine,
              owner-scoped): past-due tasks auto-defer with backoff, stuck 'missed'
              one-offs reopen, and in Schedule mode everything reopened is placed. */}
          <button
            type="button"
            onClick={sweepNow}
            disabled={sweeping()}
            title="Sweep missed & stale tasks now — reopen them (and in Schedule mode, re-place them)"
            class="btn-icon flex-shrink-0 disabled:opacity-40"
          >
            <RefreshCw size={13} classList={{ 'animate-spin': sweeping() }} />
          </button>
          <span class="text-xs font-mono text-foreground flex-shrink-0 whitespace-nowrap">
            {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
          <DetailsToggle />
        </div>

        {/* Phase L: persistent conflict banner — shown when sync ops lost a LWW race */}
        <ConflictBanner />
        {/* Shown when an SSE reconnect reveals the server redeployed under this tab */}
        <UpdateBanner />

        {/* Bottom padding clears the mobile tab bar — and, where one is rendered, the
            floating Create button that sits above it. */}
        <div
          class="flex-1 overflow-auto"
          classList={{
            'pb-16 md:pb-0': !hasFab(),
            'pb-36 md:pb-20': hasFab(),
          }}
        >
          {/* Root ErrorBoundary — the app's only one. A routed view whose render throws
              (commonly a resource read hitting a 403/500) degrades to a recoverable
              fallback here instead of white-screening the whole SPA; the shell chrome
              stays mounted. Both routers (SessionGate + UngatedRouter) render through
              Shell, so this single boundary covers every route. Per-view resource.error
              guards remain the first line of defense.

              A caught error never reaches window.onerror, so report it here or Sentry
              never sees the one class of failure that actually breaks a view for the
              user. No-op unless a VITE_SENTRY_DSN was baked in at build time. */}
          <ErrorBoundary
            fallback={(err, reset) => {
              captureException(err, { boundary: 'root', path: location.pathname });
              return <ErrorBoundaryFallback error={err} onReset={reset} />;
            }}
          >
            {props.children}
          </ErrorBoundary>
        </div>
      </main>

      {/* Docked details drawer — describes whatever entity is expanded. Mounted at the
          shell so it is one surface for every route rather than per-view panels. */}
      <DetailsDrawer />

      {/* Floating Create button — lifted above the bottom nav on mobile. On Today,
          Tasks, Calendar, Tags, Focus, and Jobs; other views own their own create
          affordance (e.g. the Planner grid's click-to-create). */}
      <Show when={hasFab()}>
        <button
          class="fab bottom-20 md:bottom-6"
          onClick={() => setElementModal({ open: true, mode: 'add', kind: null })}
          title="Add to calendar"
        >
          <Plus size={18} />
          <span class="hidden sm:inline">Add</span>
        </button>
      </Show>

      {/* Unified Add/Edit Element wizard — self-driven by the elementModal signal. */}
      <ElementWizard />
      {/* App-level like the wizard: the card that triggers it unmounts on completion.
          `keyed` so a queue advance REMOUNTS the sheet — otherwise the next task would
          inherit the previous one's faces, note and edited duration. */}
      <Show when={closeRitualTask()} keyed>
        {(entry) => (
          <CloseRitual
            task={entry.task}
            preferBlockId={entry.blockId}
            remaining={Math.max(0, closeRitualQueue().length - 1)}
            onAdvance={advanceCloseRitual}
            onSkipAll={clearCloseRitual}
          />
        )}
      </Show>
      <PlanWeekAssistant />
      <OnboardingWizard />
      {/* Mounted once so any call site can await askRecurringScope() inline. */}
      <RecurringScopeDialog />

      <BottomNav />
      <ToastContainer />
    </div>
  );
}

/**
 * AF-1 — Objectives now lives at `/tasks?tab=objectives`; stale `/objectives`
 * deep-links redirect there, FORWARDING the `?focus=<id>` param (§K task-star
 * links) so the tree still auto-expands/scrolls to the target node.
 */
function ObjectivesRedirect() {
  const [params] = useSearchParams();
  const focus = typeof params.focus === 'string' && params.focus
    ? `&focus=${encodeURIComponent(params.focus)}`
    : '';
  return <Navigate href={`/tasks?tab=objectives${focus}`} />;
}

/**
 * U3 — auth gate. Fetches `GET /api/auth/config` ONCE at boot:
 *   - test / standalone (or config unreachable) → render the app unchanged. Zero
 *     behavioral change for existing dev/Docker/api-key deployments — the guard is
 *     a pass-through and no /login route exists in their world.
 *   - sso (CI-Portal OR local) → the SPA is auth-gated: `/login` renders bare (no
 *     shell), and `SessionGate` wraps the shell to bounce unauthenticated users
 *     there. Which login UI shows is the server's call (Login.tsx reads the config).
 */
function SessionGate(props: { children?: any }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [me] = createResource(() => api.auth.me().then(() => true).catch(() => false));

  createEffect(() => {
    if (me.loading) return;
    if (me() === false && location.pathname !== '/login') {
      navigate('/login', { replace: true });
    }
  });

  return (
    <Show
      when={!me.loading}
      fallback={
        <div class="min-h-screen flex items-center justify-center bg-surface-950 text-muted-foreground">
          <Loader2 class="animate-spin" size={20} />
        </div>
      }
    >
      <Show
        when={me()}
        fallback={
          <div class="min-h-screen flex items-center justify-center bg-surface-950 text-muted-foreground">
            <Loader2 class="animate-spin" size={20} />
          </div>
        }
      >
        <Shell>{props.children}</Shell>
      </Show>
    </Show>
  );
}

export function App() {
  const [cfg] = createResource(() => api.auth.config().catch(() => ({ mode: 'test' as const, disableOidc: false })));

  return (
    <Show
      when={!cfg.loading}
      fallback={
        <div class="min-h-screen flex items-center justify-center bg-surface-950 text-muted-foreground">
          <Loader2 class="animate-spin" size={20} />
        </div>
      }
    >
      {/* Auth-gated deployments: /login is bare, everything else runs behind SessionGate.
          Ungated (test/standalone): the original Shell root, no login route — unchanged. */}
      <Show when={authGateActive(cfg()!)} fallback={<UngatedRouter />}>
        <Router>
          <Route path="/login" component={Login} />
          {/* V7 — unauthenticated reset page reached from the emailed link. Bare, like /login. */}
          <Route path="/reset-password" component={ResetPassword} />
          <Route path="/" component={SessionGate}>
            <Route path="/"         component={Today} />
            {/* FOCUS — the simple day-list + Time-Sense surface, sits before Today in the nav. */}
            <Route path="/focus"    component={Focus} />
            <Route path="/calendar" component={Calendar} />
            {/* AF-7: the Inbox is gone — created-today tasks surface in the Tasks tab's
                "New Today" section; redirect stale /inbox deep-links there. */}
            <Route path="/inbox"    component={() => <Navigate href="/tasks" />} />
            <Route path="/tasks"       component={AllTasks} />
            {/* AF-1: Objectives is a Tasks tab now; redirect preserves ?focus=. */}
            <Route path="/objectives"  component={ObjectivesRedirect} />
            <Route path="/patterns" component={() => <Navigate href="/tasks" />} />
            <Route path="/tags"     component={Tags} />
            <Route path="/priorities" component={PrioritiesWizard} />
            <Route path="/balance"    component={Balance} />
            <Route path="/settings" component={Settings} />
            <Route path="/jobs"     component={Jobs} />
          </Route>
        </Router>
      </Show>
    </Show>
  );
}

/** The pre-U3 router, unchanged — used verbatim in test/standalone (ungated) mode. */
function UngatedRouter() {
  return (
    <Router root={Shell}>
      <Route path="/"         component={Today} />
      <Route path="/focus"    component={Focus} />
      <Route path="/calendar" component={Calendar} />
      {/* AF-7: Inbox removed; /inbox redirects to the Tasks tab ("New Today"). */}
      <Route path="/inbox"    component={() => <Navigate href="/tasks" />} />
      <Route path="/tasks"       component={AllTasks} />
      {/* AF-1: Objectives is a Tasks tab now; redirect preserves ?focus=. */}
      <Route path="/objectives"  component={ObjectivesRedirect} />
      {/* Routines moved into the Tasks screen as tabs (T-TASKS-1); redirect stale deep-links. */}
      <Route path="/patterns" component={() => <Navigate href="/tasks" />} />
      <Route path="/tags"     component={Tags} />
      <Route path="/priorities" component={PrioritiesWizard} />
      <Route path="/balance"    component={Balance} />
      <Route path="/settings" component={Settings} />
      <Route path="/jobs"     component={Jobs} />
    </Router>
  );
}
