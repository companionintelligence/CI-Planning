import { A } from '@solidjs/router';
import { createSignal, Show, For } from 'solid-js';
import { CheckSquare, Inbox, Tag, Settings, Activity, Sun, MoreHorizontal, CalendarDays } from 'lucide-solid';
import { possibles } from '../stores/index.js';
import { ThemeToggle } from './ThemeToggle.js';

const primary = [
  { href: '/', label: 'Today', Icon: Sun },
  { href: '/inbox', label: 'Inbox', Icon: Inbox, badge: true },
  { href: '/tasks', label: 'Tasks', Icon: CheckSquare },
  { href: '/calendar', label: 'Calendar', Icon: CalendarDays },
];
const overflow = [
  { href: '/tags', label: 'Tags', Icon: Tag },
  { href: '/jobs', label: 'Jobs', Icon: Activity },
  { href: '/settings', label: 'Settings', Icon: Settings },
];

/** Mobile bottom tab bar (hidden ≥ md, where the left rail takes over). */
export function BottomNav() {
  const pendingCount = () => possibles()?.length ?? 0;
  const [moreOpen, setMoreOpen] = createSignal(false);

  return (
    <>
      {/* More overflow sheet */}
      <Show when={moreOpen()}>
        <div class="md:hidden fixed inset-0 z-40 bg-black/40" onClick={() => setMoreOpen(false)}>
          <div
            class="absolute bottom-16 inset-x-3 rounded-2xl border border-border bg-popover p-2 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <For each={overflow}>
              {(l) => (
                <A href={l.href} class="nav-item" activeClass="nav-item-active" onClick={() => setMoreOpen(false)}>
                  <l.Icon size={16} class="flex-shrink-0" />
                  <span class="flex-1">{l.label}</span>
                </A>
              )}
            </For>
            <div class="border-t border-border my-1" />
            <ThemeToggle />
          </div>
        </div>
      </Show>

      <nav
        class="md:hidden fixed bottom-0 inset-x-0 z-30 h-14 bg-sidebar border-t border-border flex items-stretch"
        style={{ 'padding-bottom': 'env(safe-area-inset-bottom)' }}
      >
        <For each={primary}>
          {(l) => (
            <A
              href={l.href}
              end={l.href === '/'}
              class="relative flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium text-muted-foreground"
              activeClass="!text-primary"
            >
              <l.Icon size={19} />
              <span>{l.label}</span>
              <Show when={l.badge && pendingCount() > 0}>
                <span class="absolute top-1.5 left-1/2 ml-1.5 min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-bold bg-primary text-primary-foreground flex items-center justify-center">
                  {pendingCount()}
                </span>
              </Show>
            </A>
          )}
        </For>
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          class="flex-1 flex flex-col items-center justify-center gap-0.5 text-[10px] font-medium"
          classList={{ 'text-primary': moreOpen(), 'text-muted-foreground': !moreOpen() }}
        >
          <MoreHorizontal size={19} />
          <span>More</span>
        </button>
      </nav>
    </>
  );
}
