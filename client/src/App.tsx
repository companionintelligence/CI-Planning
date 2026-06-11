import { Route, Router, useLocation } from '@solidjs/router';
import { Show, createSignal, onMount, onCleanup } from 'solid-js';
import { Plus, Play, Pause, Square } from 'lucide-solid';
import { Nav }      from './components/Nav.js';
import { ToastContainer } from './components/Toast.js';
import { TaskForm } from './components/TaskForm.js';
import { Today }    from './views/Today.js';
import { Calendar } from './views/Calendar.js';
import { Inbox }    from './views/Inbox.js';
import { AllTasks } from './views/AllTasks.js';
import { Tags }     from './views/Tags.js';
import { Settings } from './views/Settings.js';
import { Jobs }     from './views/Jobs.js';
import { Balance }  from './views/Balance.js';
import { PrioritiesWizard } from './views/PrioritiesWizard.js';
import { CommandBar } from './components/CommandBar.js';
import { taskModal, setTaskModal, activeTimer, pauseTimer, resumeTimer, stopTimer } from './stores/index.js';

function Shell(props: { children?: any }) {
  const location = useLocation();
  const [isCommandBarOpen, setIsCommandBarOpen] = createSignal(false);

  onMount(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setIsCommandBarOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleGlobalKey);
    onCleanup(() => window.removeEventListener('keydown', handleGlobalKey));
  });

  const viewName = () => {
    const p = location.pathname;
    if (p === '/') return 'today';
    if (p === '/calendar') return 'calendar';
    if (p === '/inbox') return 'inbox';
    if (p === '/tasks') return 'tasks';
    if (p === '/tags') return 'tags';
    if (p === '/jobs') return 'jobs';
    if (p === '/settings') return 'settings';
    if (p === '/balance') return 'balance';
    if (p === '/priorities-wizard') return 'priorities-wizard';
    return '';
  };

  return (
    <div class="flex h-screen overflow-hidden bg-surface-950">
      <Nav />
      <main class="flex-1 flex flex-col overflow-hidden relative">
        <div class="flex-1 overflow-auto">
          {props.children}
        </div>

        {/* Active Time Tracker bar */}
        <Show when={activeTimer()}>
          {(timer) => {
            const formatTime = (totalSecs: number) => {
              const hrs = Math.floor(totalSecs / 3600);
              const mins = Math.floor((totalSecs % 3600) / 60);
              const secs = totalSecs % 60;
              const pad = (num: number) => String(num).padStart(2, '0');
              return hrs > 0 
                ? `${hrs}:${pad(mins)}:${pad(secs)}` 
                : `${pad(mins)}:${pad(secs)}`;
            };

            return (
              <div class="flex-shrink-0 h-14 bg-surface-900 border-t border-surface-700/50 flex items-center px-6 justify-between gap-4 animate-slide-up z-20">
                <div class="flex items-center gap-3 min-w-0">
                  <span class="relative flex h-2 w-2">
                    <span class="animate-ping absolute inline-flex h-full w-full rounded-full bg-accent opacity-75"></span>
                    <span class="relative inline-flex rounded-full h-2 w-2 bg-accent"></span>
                  </span>
                  <div class="min-w-0">
                    <div class="text-[10px] font-mono text-ci-1/40 uppercase tracking-wider">Tracking Time</div>
                    <div class="text-xs font-semibold text-ci-1 truncate">{timer().taskTitle}</div>
                  </div>
                </div>
                
                <div class="flex items-center gap-4">
                  <div class="text-sm font-mono font-bold text-accent-light tracking-widest bg-surface-950 px-3 py-1 rounded-lg border border-surface-800">
                    {formatTime(timer().seconds)}
                  </div>
                  <div class="flex items-center gap-1">
                    <Show when={timer().isPaused} fallback={
                      <button onClick={pauseTimer} class="btn-icon text-ci-1/75 hover:text-ci-1" title="Pause">
                        <Pause size={14} />
                      </button>
                    }>
                      <button onClick={resumeTimer} class="btn-icon text-accent-light hover:text-accent" title="Resume">
                        <Play size={14} />
                      </button>
                    </Show>
                    <button onClick={stopTimer} class="btn-icon text-red-400 hover:text-red-300 hover:bg-red-950/20" title="Stop & Save">
                      <Square size={14} fill="currentColor" />
                    </button>
                  </div>
                </div>
              </div>
            );
          }}
        </Show>
      </main>

      {/* Floating Create TODO button */}
      <button
        class="fab"
        onClick={() => setTaskModal({ open: true })}
        title="Create TODO (N)"
      >
        <Plus size={18} />
        <span>New Task</span>
      </button>

      {/* Task creation / edit modal */}
      <Show when={taskModal().open}>
        <TaskForm
          editTask={taskModal().editTask}
          parentId={taskModal().parentId}
          onClose={() => setTaskModal({ open: false })}
        />
      </Show>

      {/* Global Command Bar modal */}
      <Show when={isCommandBarOpen()}>
        <CommandBar onClose={() => setIsCommandBarOpen(false)} />
      </Show>

      <ToastContainer />
    </div>
  );
}

export function App() {
  return (
    <Router root={Shell}>
      <Route path="/"         component={Today} />
      <Route path="/calendar" component={Calendar} />
      <Route path="/balance"  component={Balance} />
      <Route path="/priorities-wizard" component={PrioritiesWizard} />
      <Route path="/inbox"    component={Inbox} />
      <Route path="/tasks"    component={AllTasks} />
      <Route path="/tags"     component={Tags} />
      <Route path="/settings" component={Settings} />
      <Route path="/jobs"     component={Jobs} />
    </Router>
  );
}
