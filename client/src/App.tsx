import { Navigate, Route, Router, useLocation, useNavigate } from '@solidjs/router';
import { Show, createEffect, createResource, createSignal, onCleanup, onMount } from 'solid-js';
import { Plus, Cpu, Loader2 } from 'lucide-solid';
import { Nav }      from './components/Nav.js';
import { Login }    from './views/Login.js';
import { ResetPassword } from './views/ResetPassword.js';
import { authGateActive } from './lib/api.js';
import { BottomNav } from './components/BottomNav.js';
import { ToastContainer } from './components/Toast.js';
import { ConflictBanner } from './components/ConflictBanner.js';
import { ElementWizard } from './components/ElementWizard.js';
import { Today }    from './views/Today.js';
import { Calendar } from './views/Calendar.js';
import { Inbox }    from './views/Inbox.js';
import { AllTasks } from './views/AllTasks.js';
import { Objectives } from './views/Objectives.js';
import { Tags }     from './views/Tags.js';
import { Settings } from './views/Settings.js';
import { Jobs }     from './views/Jobs.js';
import { setElementModal, blocks, taskOf, tags, patternPrefs, prefs, refetchPrefs, showToast } from './stores/index.js';
import { api } from './lib/api.js';
import {
  requestNotificationPermission,
  scheduleTaskReminders,
  type ReminderTask,
} from './lib/notifications.js';

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
      if (t.kind === 'pattern') patternIdByName.set(t.name, t.id);
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

function Shell(props: { children?: any }) {
  const location = useLocation();
  useTaskReminders();

  const mode = () => prefs()?.auto_mode ?? 'suggest';
  async function setMode(m: 'suggest' | 'schedule') {
    if (m === mode()) return;
    try { await api.prefs.update({ auto_mode: m }); refetchPrefs(); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    <div class="flex h-screen overflow-hidden bg-surface-950">
      <Nav />
      <main class="flex-1 flex flex-col overflow-hidden relative min-w-0">
        {/* Top bar */}
        <div class="flex-shrink-0 h-11 border-b border-surface-700/40 flex items-center px-4 md:px-6 gap-3 bg-surface-900/50">
          {/* Brand mark — hidden on desktop where the left rail shows it */}
          <div class="flex items-center gap-2 md:hidden">
            <div class="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 text-surface-950"
              style={{ background: 'linear-gradient(135deg, #58ebbf, #409b9b)' }}>
              <Cpu size={12} />
            </div>
            <span class="font-heading text-sm text-slate-100 tracking-wide">Planning</span>
          </div>
          <div class="flex-1" />
          {/* Suggest / Schedule toggle — global auto-mode; lives in the top bar */}
          <div
            class="inline-flex rounded-full border border-surface-700/60 overflow-hidden text-[11px]"
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
          <span class="text-xs font-mono" style={{ color: '#244859' }}>
            {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
        </div>

        {/* Phase L: persistent conflict banner — shown when sync ops lost a LWW race */}
        <ConflictBanner />

        {/* Bottom padding clears the mobile tab bar */}
        <div class="flex-1 overflow-auto pb-16 md:pb-0">
          {props.children}
        </div>
      </main>

      {/* Floating Create TODO button — lifted above the bottom nav on mobile.
          Only on Tasks, Calendar, Tags, and Jobs; every other view owns its own
          create affordance (e.g. Today's Day Overview + drawer, the Planner grid). */}
      <Show when={['/tasks', '/calendar', '/tags', '/jobs'].includes(location.pathname)}>
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

      <BottomNav />
      <ToastContainer />
    </div>
  );
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
            <Route path="/calendar" component={Calendar} />
            <Route path="/inbox"    component={Inbox} />
            <Route path="/tasks"       component={AllTasks} />
            <Route path="/objectives"  component={Objectives} />
            <Route path="/patterns" component={() => <Navigate href="/tasks" />} />
            <Route path="/tags"     component={Tags} />
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
      <Route path="/calendar" component={Calendar} />
      <Route path="/inbox"    component={Inbox} />
      <Route path="/tasks"       component={AllTasks} />
      <Route path="/objectives"  component={Objectives} />
      {/* Routines moved into the Tasks screen as tabs (T-TASKS-1); redirect stale deep-links. */}
      <Route path="/patterns" component={() => <Navigate href="/tasks" />} />
      <Route path="/tags"     component={Tags} />
      <Route path="/settings" component={Settings} />
      <Route path="/jobs"     component={Jobs} />
    </Router>
  );
}
