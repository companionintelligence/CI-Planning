import { A, useLocation } from '@solidjs/router';
import { createResource, For, Show } from 'solid-js';
import { CalendarDays, CheckSquare, Sun } from 'lucide-solid';
import { api, type AuthMe, type GuestSharedContent } from '../lib/api.js';
import { localISODate } from '../lib/dates.js';

const todayKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const dateLabel = (value: string) => new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00` : value)
  .toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

/** Restricted guest shell: only today, calendar, and explicitly shared lists. */
export function GuestPlanner(props: { me: AuthMe }) {
  const location = useLocation();
  const [content] = createResource(async () => api.guest.shared());
  const view = () => location.pathname === '/calendar' ? 'calendar' : location.pathname === '/shared' ? 'shared' : 'today';
  const current = (data: GuestSharedContent) => data.blocks.filter((block) => localISODate(new Date(block.start_at)) === todayKey());
  const taskById = (data: GuestSharedContent, id: string) => data.tasks.find((task) => task.id === id);
  const navItems = [
    { path: '/', title: 'Today', icon: Sun },
    { path: '/calendar', title: 'Calendar', icon: CalendarDays },
    { path: '/shared', title: 'Shared lists', icon: CheckSquare },
  ];

  return (
    <div class="min-h-screen bg-background text-foreground flex flex-col">
      <header class="h-12 shrink-0 border-b border-border flex items-center justify-between px-4 md:px-6">
        <span class="text-sm font-semibold">Companion Planning</span>
        <span class="text-xs text-muted-foreground">{props.me.name}</span>
      </header>
      <nav aria-label="Guest planner" class="flex gap-1 border-b border-border px-3 md:px-6 overflow-x-auto">
        <For each={navItems}>{(item) => {
          const Icon = item.icon;
          return <A href={item.path} aria-current={view() === (item.path === '/' ? 'today' : item.path.slice(1)) ? 'page' : undefined}
            class="inline-flex items-center gap-2 px-3 py-3 text-xs border-b-2 border-transparent text-muted-foreground hover:text-foreground"
            activeClass="!border-primary !text-foreground" end={item.path === '/'}>
            <Icon size={14} /> {item.title}
          </A>;
        }}</For>
      </nav>
      <main class="w-full max-w-4xl mx-auto flex-1 p-4 md:p-6 flex flex-col gap-4">
        <h1 class="text-xl font-semibold">{view() === 'today' ? 'Today' : view() === 'calendar' ? 'Calendar' : 'Shared lists'}</h1>
        <Show when={content.loading}><div class="card text-sm text-muted-foreground">Loading shared items…</div></Show>
        <Show when={content.error}><div class="card text-sm text-destructive" role="alert">Shared items could not load. Please try again later.</div></Show>
        <Show when={content()}>{(data) => <>
          <Show when={view() === 'today'}>
            <section class="flex flex-col gap-2" aria-label="Today’s shared schedule">
              <h2 class="section-label">Today’s schedule</h2>
              <For each={current(data())}>{(block) => {
                const task = taskById(data(), block.task_id);
                return <article class="card flex items-start justify-between gap-3">
                  <div class="min-w-0"><div class="text-sm font-medium break-words">{block.title}</div>
                    <div class="text-xs text-muted-foreground">{new Date(block.start_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – {new Date(block.end_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</div>
                  </div>
                  <Show when={task}>{(t) => <span class="text-[11px] text-muted-foreground capitalize shrink-0">{t().status.replaceAll('_', ' ')}</span>}</Show>
                </article>;
              }}</For>
              <Show when={current(data()).length === 0}><div class="card text-sm text-muted-foreground">Nothing is scheduled today.</div></Show>
            </section>
            <section class="flex flex-col gap-2" aria-label="Shared tasks for today">
              <h2 class="section-label">Shared tasks</h2>
              <For each={data().tasks.filter((task) => task.scheduled_for === todayKey() && !current(data()).some((block) => block.task_id === task.id))}>{(task) =>
                <article class="card flex items-center justify-between gap-3"><span class="text-sm">{task.title}</span><span class="text-xs text-muted-foreground capitalize">{task.status.replaceAll('_', ' ')}</span></article>
              }</For>
            </section>
          </Show>
          <Show when={view() === 'calendar'}>
            <section class="flex flex-col gap-2" aria-label="Shared calendar schedule">
              <For each={data().blocks}>{(block) => <article class="card flex flex-col gap-1">
                <span class="text-[11px] text-muted-foreground">{dateLabel(block.start_at)}</span>
                <div class="flex items-center justify-between gap-3"><span class="text-sm">{block.title}</span>
                  <span class="text-xs text-muted-foreground">{new Date(block.start_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })} – {new Date(block.end_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span>
                </div>
              </article>}</For>
              <Show when={data().blocks.length === 0}><div class="card text-sm text-muted-foreground">No shared events are scheduled.</div></Show>
            </section>
          </Show>
          <Show when={view() === 'shared'}>
            <section class="flex flex-col gap-2"><h2 class="section-label">Tasks</h2>
              <For each={data().tasks}>{(task) => <article class="card flex flex-col gap-1">
                <div class="flex justify-between gap-2"><span class="text-sm font-medium">{task.title}</span><span class="text-xs text-muted-foreground">P{task.priority}</span></div>
                <div class="text-xs text-muted-foreground capitalize">{task.status.replaceAll('_', ' ')}{task.objective_title ? ` · ${task.objective_title}` : ''}</div>
              </article>}</For>
              <Show when={data().tasks.length === 0}><p class="text-sm text-muted-foreground">No tasks are shared with you yet.</p></Show>
            </section>
            <section class="flex flex-col gap-2"><h2 class="section-label">Objectives</h2>
              <For each={data().objectives}>{(objective) => <article class="card flex flex-col gap-1">
                <div class="text-sm font-medium">{objective.title}</div>
                <div class="text-xs text-muted-foreground">{objective.target_date ? `Target ${dateLabel(objective.target_date)}` : 'No target date'}</div>
                <Show when={objective.description}><p class="text-sm text-muted-foreground whitespace-pre-wrap">{objective.description}</p></Show>
              </article>}</For>
              <Show when={data().objectives.length === 0}><p class="text-sm text-muted-foreground">No objectives are shared with you yet.</p></Show>
            </section>
          </Show>
        </>}</Show>
      </main>
    </div>
  );
}
