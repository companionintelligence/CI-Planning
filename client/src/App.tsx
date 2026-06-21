import { Route, Router, useLocation } from '@solidjs/router';
import { Show } from 'solid-js';
import { Plus, Cpu } from 'lucide-solid';
import { Nav }      from './components/Nav.js';
import { BottomNav } from './components/BottomNav.js';
import { ToastContainer } from './components/Toast.js';
import { TaskForm } from './components/TaskForm.js';
import { Today }    from './views/Today.js';
import { Inbox }    from './views/Inbox.js';
import { AllTasks } from './views/AllTasks.js';
import { Patterns } from './views/Patterns.js';
import { Tags }     from './views/Tags.js';
import { Settings } from './views/Settings.js';
import { Jobs }     from './views/Jobs.js';
import { taskModal, setTaskModal } from './stores/index.js';

function Shell(props: { children?: any }) {
  const location = useLocation();
  return (
    <div class="flex h-screen overflow-hidden bg-surface-950">
      <Nav />
      <main class="flex-1 flex flex-col overflow-hidden relative min-w-0">
        {/* Top bar */}
        <div class="flex-shrink-0 h-11 border-b border-surface-700/40 flex items-center px-4 md:px-6 gap-3 bg-surface-900/50">
          {/* Brand mark on mobile (the left rail is hidden < md) */}
          <div class="flex items-center gap-2 md:hidden">
            <div class="w-6 h-6 rounded-lg flex items-center justify-center flex-shrink-0 text-surface-950"
              style={{ background: 'linear-gradient(135deg, #58ebbf, #409b9b)' }}>
              <Cpu size={12} />
            </div>
            <span class="font-heading text-sm text-slate-100 tracking-wide">Planning</span>
          </div>
          <div class="flex-1" />
          <span class="text-xs font-mono" style={{ color: '#244859' }}>
            {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
        </div>

        {/* Bottom padding clears the mobile tab bar */}
        <div class="flex-1 overflow-auto pb-16 md:pb-0">
          {props.children}
        </div>
      </main>

      {/* Floating Create TODO button — lifted above the bottom nav on mobile.
          Hidden on Today, where the Day Overview + drawer own the new-task entry. */}
      <Show when={location.pathname !== '/'}>
        <button
          class="fab bottom-20 md:bottom-6"
          onClick={() => setTaskModal({ open: true })}
          title="Create TODO (N)"
        >
          <Plus size={18} />
          <span class="hidden sm:inline">New Task</span>
        </button>
      </Show>

      {/* Task creation / edit modal */}
      <Show when={taskModal().open}>
        <TaskForm
          editTask={taskModal().editTask}
          parentId={taskModal().parentId}
          onClose={() => setTaskModal({ open: false })}
        />
      </Show>

      <BottomNav />
      <ToastContainer />
    </div>
  );
}

export function App() {
  return (
    <Router root={Shell}>
      <Route path="/"         component={Today} />
      <Route path="/inbox"    component={Inbox} />
      <Route path="/tasks"    component={AllTasks} />
      <Route path="/patterns" component={Patterns} />
      <Route path="/tags"     component={Tags} />
      <Route path="/settings" component={Settings} />
      <Route path="/jobs"     component={Jobs} />
    </Router>
  );
}
