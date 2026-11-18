import { Navigate, Route, Router, useLocation, useNavigate, useSearchParams } from '@solidjs/router';
import { ErrorBoundary, Show, createEffect, createResource, createSignal, lazy, onCleanup, onMount } from 'solid-js';
import { Plus, RefreshCw, PanelLeft, LockKeyhole, Loader2 } from 'lucide-solid';
import { BootScreen } from './components/BootScreen.js';
import { BrandMark } from './components/BrandMark.js';
import { DetailsDrawer, DetailsToggle } from './components/DetailsDrawer.js';
import { navCollapsed, toggleNav, detailsOpen } from './stores/ui.js';
import { Nav }      from './components/Nav.js';
import { CloseRitual } from './components/CloseRitual.js';
import { ConnectServer } from './views/ConnectServer.js';
import { isCapacitorShell, needsServerSetup } from './lib/server-config.js';
import { nativeRemindersEnabled, syncNativeReminders } from './lib/native-reminders.js';
import { setSignedIn } from './lib/session.js';
import { authGateActive, UNAUTHENTICATED_EVENT } from './lib/api.js';
import { BottomNav } from './components/BottomNav.js';
import { ToastContainer } from './components/Toast.js';
import { ConflictBanner } from './components/ConflictBanner.js';
import { UpdateBanner } from './components/UpdateBanner.js';
import { ElementWizard } from './components/ElementWizard.js';
import { PlanWeekAssistant } from './components/PlanWeekAssistant.js';
import { OnboardingWizard } from './components/OnboardingWizard.js';
import { TrustTrigger, TrustModal, type TrustMode } from './components/TrustModal.js';
import { ErrorBoundaryFallback } from './components/ErrorBoundaryFallback.js';
import { captureException } from './lib/telemetry.js';
import { setElementModal, blocks, taskOf, tags, patternPrefs, prefs, refetchPrefs, showToast, refetchTasks, refetchBlocks, refetchFlightPlan, reminders as serverReminders, refetchReminders, closeRitualTask, closeRitualQueue, advanceCloseRitual, clearCloseRitual } from './stores/index.js';
import { api } from './lib/api.js';
import {
  requestNotificationPermission,
  scheduleTaskReminders,
  type ReminderTask,
} from './lib/notifications.js';
import { RecurringScopeDialog } from './components/RecurringScopeDialog.js';
import { GuestPlanner } from './components/GuestPlanner.js';
import { handleNativePortalCallback } from './lib/native-portal-auth.js';
import { clearDeviceLock, DEVICE_LOCK_CHANGED_EVENT, getDeviceLockVerifier, verifyDeviceLockPassword, type LockVerifier } from './lib/native-app-lock.js';

// Keep each page out of the startup bundle until its route is opened. The planner has
// several substantial views; importing every route here made the initial JS chunk
// nearly 1 MB even though a user sees only one page at a time.
const Login = lazy(() => import('./views/Login.js').then((m) => ({ default: m.Login })));
const Signup = lazy(() => import('./views/Signup.js').then((m) => ({ default: m.Signup })));
const ResetPassword = lazy(() => import('./views/ResetPassword.js').then((m) => ({ default: m.ResetPassword })));
const Today = lazy(() => import('./views/Today.js').then((m) => ({ default: m.Today })));
const Focus = lazy(() => import('./views/Focus.js').then((m) => ({ default: m.Focus })));
const Calendar = lazy(() => import('./views/Calendar.js').then((m) => ({ default: m.Calendar })));
const PrioritiesWizard = lazy(() => import('./views/PrioritiesWizard.js').then((m) => ({ default: m.PrioritiesWizard })));
const Balance = lazy(() => import('./views/Balance.js').then((m) => ({ default: m.Balance })));
const AllTasks = lazy(() => import('./views/AllTasks.js').then((m) => ({ default: m.AllTasks })));
const Tags = lazy(() => import('./views/Tags.js').then((m) => ({ default: m.Tags })));
const Settings = lazy(() => import('./views/Settings.js').then((m) => ({ default: m.Settings })));
const Jobs = lazy(() => import('./views/Jobs.js').then((m) => ({ default: m.Jobs })));

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
    // Capacitor shells use OS scheduled notifications below. Web Notifications and
    // JavaScript timers are foreground-only there and would duplicate reminders.
    if (isCapacitorShell()) return;
    requestNotificationPermission();
    const onVisibility = () => {
      if (document.visibilityState === 'visible') setVisibleTick((n) => n + 1);
    };
    document.addEventListener('visibilitychange', onVisibility);
    onCleanup(() => document.removeEventListener('visibilitychange', onVisibility));
  });

  createEffect(() => {
    if (isCapacitorShell()) return;
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
  const [searchParams] = useSearchParams();
  useTaskReminders();
  const hasFab = () =>
    FAB_ROUTES.includes(location.pathname)
    && !(location.pathname === '/tasks' && searchParams.tab === 'shared');

  // The trust dial (scheduling_prefs.trust_mode, 0070) — all three positions, via a
  // button that shows the one in force. The old Suggest/Schedule toggle here could only
  // express two of them and silently mislabelled 'cautious' as Suggest; see TrustModal.
  const [trustOpen, setTrustOpen] = createSignal(false);
  const [trustBusy, setTrustBusy] = createSignal(false);
  async function pickTrust(m: TrustMode) {
    if (m === prefs()?.trust_mode) { setTrustOpen(false); return; }
    setTrustBusy(true);
    try {
      await api.prefs.update({ trust_mode: m });
      refetchPrefs();
      setTrustOpen(false);
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setTrustBusy(false); }
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
            class="btn-icon btn-icon-strong flex-shrink-0 hidden md:grid"
            aria-expanded={!navCollapsed()}
            aria-label={navCollapsed() ? 'Expand navigation' : 'Collapse navigation'}
            title={navCollapsed() ? 'Expand navigation' : 'Collapse navigation'}
            onClick={toggleNav}
          >
            <PanelLeft size={13} />
          </button>
          {/* Brand mark — hidden on desktop where the left rail shows it */}
          <div class="flex items-center gap-2 md:hidden min-w-0 flex-1">
            <BrandMark size={24} />
            <span class="font-heading text-sm text-slate-100 tracking-wide truncate">Planning</span>
          </div>
          {/* Desktop-only spacer; on mobile the brand block above already takes the slack. */}
          <div class="hidden md:block flex-1" />
          {/* Trust dial — global automation level; lives in the top bar. One button
              (narrower than the two-button toggle it replaced, which helps the 360px
              crowding noted above) showing the active mode, opening the full choice. */}
          <TrustTrigger mode={prefs()?.trust_mode} onOpen={() => setTrustOpen(true)} />
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

      {/* One shared mobile/desktop Create button across the planner's primary views. */}
      <Show when={hasFab()}>
        <button
          class="fab bottom-20 md:bottom-6"
          onClick={() => setElementModal({ open: true, mode: 'add', kind: null })}
          title="Add to calendar"
        >
          <Plus size={18} />
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
            review={entry.review}
            remaining={Math.max(0, closeRitualQueue().length - 1)}
            onAdvance={advanceCloseRitual}
            onSkipAll={clearCloseRitual}
          />
        )}
      </Show>
      <PlanWeekAssistant />
      <Show when={trustOpen()}>
        <TrustModal
          mode={prefs()?.trust_mode}
          busy={trustBusy()}
          onPick={(m) => void pickTrust(m)}
          onClose={() => setTrustOpen(false)}
        />
      </Show>
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
  const [me] = createResource(() => api.auth.me().catch(() => null));

  // The account resources in stores/index.ts load once this is true (lib/session.ts).
  createEffect(() => {
    if (me.loading) return;
    setSignedIn(!!me() && me()?.role !== 'guest');
  });
  onCleanup(() => setSignedIn(false));

  createEffect(() => {
    if (me.loading) return;
    if (me() === null && location.pathname !== '/login') {
      // Keep the page they asked for, so signing in can bring them back to it (see Login.tsx).
      navigate('/login', { replace: true, state: { from: location.pathname + location.search } });
    }
  });

  createEffect(() => {
    if (me()?.role !== 'guest') return;
    if (!['/', '/calendar', '/shared'].includes(location.pathname)) navigate('/', { replace: true });
  });

  // The session can end while the app is open; a 401 from any request takes the same route.
  const onUnauthenticated = () => {
    if (location.pathname !== '/login') navigate('/login', { replace: true });
  };
  onMount(() => window.addEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated));
  onCleanup(() => window.removeEventListener(UNAUTHENTICATED_EVENT, onUnauthenticated));

  return (
    <Show when={!me.loading} fallback={<BootScreen />}>
      <Show when={me()} fallback={<BootScreen />}>
        <Show when={me()?.role === 'guest'} fallback={<Shell>{props.children}</Shell>}>
          <GuestPlanner me={me()!} />
        </Show>
      </Show>
    </Show>
  );
}

export function App() {
  useNativePortalCallback();
  return <NativeAppLockBoundary><AppContent /></NativeAppLockBoundary>;
}

function NativeAppLockBoundary(props: { children: any }) {
  const [ready, setReady] = createSignal(false);
  const [locked, setLocked] = createSignal(false);
  const [verifier, setVerifier] = createSignal<LockVerifier | null>(null);
  const [storageError, setStorageError] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [unlockBusy, setUnlockBusy] = createSignal(false);
  const [error, setError] = createSignal('');
  const [resetBusy, setResetBusy] = createSignal(false);

  onMount(() => {
    if (!isCapacitorShell()) { setReady(true); return; }
    let initialized = false;
    let disposed = false;
    let appListener: { remove: () => Promise<void> } | undefined;
    const loadVerifier = async () => {
      try {
        const value = await getDeviceLockVerifier();
        setVerifier(value);
        setStorageError('');
        if (!initialized) setLocked(!!value);
        else if (!value) setLocked(false);
        initialized = true;
      } catch (err) {
        setStorageError((err as Error).message || 'Secure device storage is unavailable');
      } finally { setReady(true); }
    };
    void loadVerifier();
    const onChanged = () => { void loadVerifier(); };
    window.addEventListener(DEVICE_LOCK_CHANGED_EVENT, onChanged);
    void import('@capacitor/app').then(async ({ App: NativeApp }) => {
      if (disposed) return;
      appListener = await NativeApp.addListener('appStateChange', ({ isActive }) => {
        if (!isActive && verifier()) {
          setLocked(true);
          setPassword('');
          setError('');
          setSignedIn(false);
        }
      });
      if (disposed) await appListener.remove();
    }).catch(() => {});
    onCleanup(() => {
      disposed = true;
      window.removeEventListener(DEVICE_LOCK_CHANGED_EVENT, onChanged);
      void appListener?.remove();
    });
  });

  async function unlock(event: Event) {
    event.preventDefault();
    const current = verifier();
    if (!current || unlockBusy()) return;
    setUnlockBusy(true);
    setError('');
    try {
      if (await verifyDeviceLockPassword(password(), current)) {
        setPassword('');
        setLocked(false);
      } else {
        setError('That password did not match. Try again.');
        setPassword('');
      }
    } catch {
      setError('Could not check the password. Try again.');
    } finally { setUnlockBusy(false); }
  }

  async function resetAppLock() {
    if (resetBusy()) return;
    setResetBusy(true);
    setError('');
    try {
      // The Hub sign-in becomes the recovery step; do not remove the lock offline.
      await api.auth.logout();
      await clearDeviceLock();
      window.location.assign('/login');
    } catch {
      setError('Connect to your Planning server to sign out and reset this app lock.');
      setResetBusy(false);
    }
  }

  return (
    <Show when={ready()} fallback={<BootScreen />}>
      <Show when={storageError()}>
        <div class="min-h-screen flex items-center justify-center p-6 bg-surface-950">
          <section class="card w-full max-w-sm flex flex-col gap-3 text-center">
            <LockKeyhole class="mx-auto text-primary" size={22} />
            <h1 class="text-base font-semibold text-foreground">App lock unavailable</h1>
            <p class="text-sm text-muted-foreground">Planning could not read the saved device lock. Your app stays locked until secure storage is available.</p>
            <p class="text-xs text-destructive">{storageError()}</p>
            <button type="button" class="btn-secondary w-full justify-center" onClick={() => { setReady(false); void getDeviceLockVerifier().then((v) => { setVerifier(v); setStorageError(''); setLocked(!!v); setReady(true); }).catch((err) => { setStorageError((err as Error).message); setReady(true); }); }}>Try again</button>
            <button type="button" class="text-xs text-muted-foreground underline" disabled={resetBusy()} onClick={resetAppLock}>Sign out and reset app lock</button>
          </section>
        </div>
      </Show>
      <Show when={!storageError()}>
        <Show when={locked()} fallback={props.children}>
          <div class="min-h-screen flex items-center justify-center p-6 bg-surface-950">
            <section class="card w-full max-w-sm flex flex-col gap-4">
              <div class="text-center">
                <LockKeyhole class="mx-auto mb-3 text-primary" size={24} />
                <h1 class="text-base font-semibold text-foreground">Unlock Companion Planning</h1>
                <p class="text-xs text-muted-foreground mt-1">Enter your device app password to continue.</p>
              </div>
              <form class="flex flex-col gap-3" onSubmit={unlock}>
                <label class="flex flex-col gap-1">
                  <span class="text-xs text-muted-foreground">App password</span>
                  <input class="input" type="password" autocomplete="current-password" maxlength="256" value={password()} onInput={(e) => setPassword(e.currentTarget.value)} autofocus />
                </label>
                <Show when={error()}><p class="text-xs text-destructive" role="alert">{error()}</p></Show>
                <button type="submit" class="btn-primary w-full justify-center" disabled={unlockBusy() || !password()}>
                  <Show when={unlockBusy()} fallback="Unlock"><Loader2 class="animate-spin" size={15} /> Checking…</Show>
                </button>
              </form>
              <button type="button" class="text-xs text-muted-foreground underline self-center" disabled={resetBusy()} onClick={resetAppLock}>
                {resetBusy() ? 'Signing out…' : 'Forgot app password? Sign out and reset'}
              </button>
            </section>
          </div>
        </Show>
      </Show>
    </Show>
  );
}

function AppContent() {
  useNativeReminderSync();

  // Capacitor mobile shell, first run: the bundle is served from the app itself, so there
  // is no same-origin server to ask. Get the server's address before anything else loads.
  // Never true in a browser (lib/server-config.ts), so the web app is unchanged.
  if (needsServerSetup()) return <ConnectServer />;

  const [cfg] = createResource(() =>
    api.auth.config().catch(() => ({ mode: 'test' as const, disableOidc: false, portal: false, local: false, signup: 'off' as const })),
  );

  // Ungated deployments (test, standalone) have no login, so the session exists as soon as
  // the server's mode is known. In sso, SessionGate sets it from /api/auth/me instead.
  createEffect(() => {
    if (!cfg.loading && !authGateActive(cfg()!)) setSignedIn(true);
  });

  return (
    <Show when={!cfg.loading} fallback={<BootScreen />}>
      {/* Auth-gated deployments: /login is bare, everything else runs behind SessionGate.
          Ungated (test/standalone): the original Shell root, no login route — unchanged. */}
      <Show when={authGateActive(cfg()!)} fallback={<UngatedRouter />}>
        <Router>
          <Route path="/login" component={Login} />
          {/* B2 — local self-serve sign-up (invite code or open, per AUTH_SIGNUP). Bare, like /login. */}
          <Route path="/signup" component={Signup} />
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
            <Route path="/shared" component={() => null} />
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

/** Schedule server reminders on this device and refresh them whenever the app resumes. */
function useNativeReminderSync() {
  createEffect(() => {
    const pending = serverReminders();
    if (isCapacitorShell() && nativeRemindersEnabled() && pending) {
      void syncNativeReminders(pending).catch(() => {});
    }
  });

  onMount(() => {
    if (!isCapacitorShell()) return;
    let disposed = false;
    let listener: { remove: () => Promise<void> } | undefined;
    void import('@capacitor/app').then(async ({ App: NativeApp }) => {
      if (disposed) return;
      listener = await NativeApp.addListener('appStateChange', ({ isActive }) => {
        if (isActive) refetchReminders();
      });
      if (disposed) await listener.remove();
    }).catch(() => {});
    onCleanup(() => {
      disposed = true;
      void listener?.remove();
    });
  });
}

/** Receive the fixed-scheme PKCE handoff from the system browser, including cold starts. */
function useNativePortalCallback() {
  onMount(() => {
    if (!isCapacitorShell()) return;
    let disposed = false;
    let listener: { remove: () => Promise<void> } | undefined;
    const handle = (url: string) => { void handleNativePortalCallback(url).catch(() => {}); };
    void import('@capacitor/app').then(async ({ App: NativeApp }) => {
      if (disposed) return;
      listener = await NativeApp.addListener('appUrlOpen', ({ url }) => handle(url));
      const launch = await NativeApp.getLaunchUrl();
      if (launch?.url) handle(launch.url);
      if (disposed) await listener.remove();
    }).catch(() => {});
    onCleanup(() => {
      disposed = true;
      void listener?.remove();
    });
  });
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
