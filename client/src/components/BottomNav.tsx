import { A, useNavigate } from '@solidjs/router';
import { createSignal, createResource, Show, For } from 'solid-js';
import { CheckSquare, Tag, Settings, Activity, Sun, MoreHorizontal, CalendarDays, LogOut, Crosshair, Scale } from 'lucide-solid';
import { showToast } from '../stores/index.js';
import { api, authGateActive } from '../lib/api.js';
import { ThemeToggle } from './ThemeToggle.js';

const primary = [
  { href: '/focus', label: 'Focus', Icon: Crosshair },
  { href: '/', label: 'Today', Icon: Sun },
  { href: '/tasks', label: 'Tasks', Icon: CheckSquare },
  { href: '/calendar', label: 'Calendar', Icon: CalendarDays },
];
const overflow = [
  { href: '/balance', label: 'Balance', Icon: Scale },
  { href: '/tags', label: 'Tags', Icon: Tag },
  { href: '/jobs', label: 'Jobs', Icon: Activity },
  { href: '/settings', label: 'Settings', Icon: Settings },
];

/** Mobile bottom tab bar (hidden ≥ md, where the left rail takes over). */
export function BottomNav() {
  const [moreOpen, setMoreOpen] = createSignal(false);
  const navigate = useNavigate();
  const [cfg] = createResource(() => api.auth.config().catch(() => null));
  const showSignOut = () => { const c = cfg(); return !!c && authGateActive(c); };
  // Phase AG parity with Nav.tsx's showLink: Jobs is an operator surface — the mobile
  // More sheet must hide it for member/viewer sessions the same way the desktop rail
  // does (the server 403s them, and Jobs.tsx would surface that as an error page).
  const [me] = createResource(() => api.auth.me().catch(() => null));
  const showLink = (href: string) => {
    if (href !== '/jobs') return true;
    const c = cfg();
    return !c || !authGateActive(c) || me()?.isOperator === true;
  };
  async function signOut() {
    setMoreOpen(false);
    try {
      await api.auth.logout();
      navigate('/login', { replace: true });
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

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
                <Show when={showLink(l.href)}>
                  <A href={l.href} class="nav-item" activeClass="nav-item-active" onClick={() => setMoreOpen(false)}>
                    <l.Icon size={16} class="flex-shrink-0" />
                    <span class="flex-1">{l.label}</span>
                  </A>
                </Show>
              )}
            </For>
            <div class="border-t border-border my-1" />
            <ThemeToggle />
            <Show when={showSignOut()}>
              <button type="button" onClick={signOut} class="nav-item w-full text-left">
                <LogOut size={16} class="flex-shrink-0" />
                <span class="flex-1">Sign out</span>
              </button>
            </Show>
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
