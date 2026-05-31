import { Route, Router } from '@solidjs/router';
import { Show } from 'solid-js';
import { Plus } from 'lucide-solid';
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
import { taskModal, setTaskModal } from './stores/index.js';

function Shell(props: { children?: any }) {
  return (
    <div class="flex h-screen overflow-hidden bg-surface-950">
      <Nav />
      <main class="flex-1 flex flex-col overflow-hidden relative">
        {/* Top bar */}
        <div class="flex-shrink-0 h-11 border-b border-surface-700/40 flex items-center px-6 gap-3 bg-surface-900/50">
          <div class="flex-1" />
          <span class="text-xs font-mono" style={{ color: '#244859' }}>
            {new Date().toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}
          </span>
        </div>

        <div class="flex-1 overflow-auto">
          {props.children}
        </div>
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

      <ToastContainer />
    </div>
  );
}

export function App() {
  return (
    <Router root={Shell}>
      <Route path="/"         component={Today} />
      <Route path="/calendar" component={Calendar} />
      <Route path="/inbox"    component={Inbox} />
      <Route path="/tasks"    component={AllTasks} />
      <Route path="/tags"     component={Tags} />
      <Route path="/settings" component={Settings} />
      <Route path="/jobs"     component={Jobs} />
    </Router>
  );
}
