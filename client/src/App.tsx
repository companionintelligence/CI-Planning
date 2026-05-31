import { Route, Router } from '@solidjs/router';
import { Nav } from './components/Nav.js';
import { Today }    from './views/Today.js';
import { Calendar } from './views/Calendar.js';
import { Inbox }    from './views/Inbox.js';
import { AllTasks } from './views/AllTasks.js';
import { Tags }     from './views/Tags.js';
import { Settings } from './views/Settings.js';
import { Jobs }     from './views/Jobs.js';

function Shell(props: { children?: any }) {
  return (
    <div class="flex h-screen overflow-hidden">
      <Nav />
      <main class="flex-1 flex flex-col overflow-auto">
        {props.children}
      </main>
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
