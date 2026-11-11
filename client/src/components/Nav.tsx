import { A, useNavigate } from '@solidjs/router';
import { Show, createResource } from 'solid-js';
import {
  CheckSquare, Tag, Settings, Activity,
  Sun, CalendarDays, LogOut, Crosshair, Scale,
} from 'lucide-solid';
import { showToast } from '../stores/index.js';
import { api, authGateActive } from '../lib/api.js';
import { ThemeToggle } from './ThemeToggle.js';
import { navCollapsed } from '../stores/ui.js';
import { BrandMark } from './BrandMark.js';

const primaryLinks = [
  { href: '/focus',      label: 'Focus',      Icon: Crosshair },
  { href: '/',            label: 'Today',      Icon: Sun },
  { href: '/calendar',   label: 'Calendar',   Icon: CalendarDays },
  { href: '/tasks',      label: 'Tasks',      Icon: CheckSquare },
  { href: '/balance',    label: 'Balance',    Icon: Scale },
];
const utilityLinks = [
  { href: '/jobs',       label: 'Jobs',       Icon: Activity },
  { href: '/settings',   label: 'Settings',   Icon: Settings },
];

export function Nav() {
  const navigate = useNavigate();
  // Sign-out is only meaningful when the deployment gates on auth (sso mode);
  // test/standalone have no session to end, so the affordance stays hidden.
  const [cfg] = createResource(() => api.auth.config().catch(() => null));
  const showSignOut = () => { const c = cfg(); return !!c && authGateActive(c); };
  // Phase AG: Jobs is an operator surface (server 403s non-operators anyway) — hide
  // its nav entry for member/viewer sessions. Only applies behind the auth gate;
  // test/standalone dev deployments carry full scopes and keep the entry.
  const [me] = createResource(() => api.auth.me().catch(() => null));
  const showLink = (href: string) => {
    if (href !== '/jobs') return true;
    const c = cfg();
    return !c || !authGateActive(c) || me()?.isOperator === true;
  };
  async function signOut() {
    try {
      await api.auth.logout();
      navigate('/login', { replace: true });
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  return (
    <nav
      class="hidden md:flex flex-shrink-0 border-r border-surface-700/50 flex-col py-5 px-3 gap-0.5 bg-surface-900 overflow-hidden transition-[width] duration-150"
      classList={{ 'w-52': !navCollapsed(), 'nav-rail-collapsed': navCollapsed() }}
    >
      {/* CI logo mark */}
      <div class="flex items-center gap-2.5 px-3 mb-5" classList={{ 'justify-center px-0': navCollapsed() }}>
        <BrandMark size={32} class="flex-shrink-0" />
        <Show when={!navCollapsed()}>
          <div>
            <div class="text-[10px] font-medium tracking-[0.2em] uppercase leading-none" style={{ color: '#409b9b' }}>
              Companion
            </div>
            <div class="font-heading text-base text-slate-100 leading-tight mt-0.5 tracking-wide">
              Planning
            </div>
          </div>
        </Show>
      </div>

      <Show when={!navCollapsed()}>
        <div class="section-label">Navigation</div>
      </Show>

      {primaryLinks.map((l) => (
        <>
          <Show when={l.href === '/tasks'}>
            <div class="my-1.5 border-t border-border/60" />
          </Show>
          <Show when={showLink(l.href)}>
            <A
              href={l.href}
              end={l.href === '/'}
              class="nav-item"
              activeClass="nav-item-active"
              title={l.label}
              aria-label={l.label}
            >
              <l.Icon size={15} class="flex-shrink-0" />
              <Show when={!navCollapsed()}><span class="flex-1">{l.label}</span></Show>
            </A>
          </Show>
        </>
      ))}

      <div class="my-1.5 border-t border-border/60" />
      <A
        href="/tags"
        class="nav-item"
        activeClass="nav-item-active"
        title="Tags"
        aria-label="Tags"
      >
        <Tag size={15} class="flex-shrink-0" />
        <Show when={!navCollapsed()}><span class="flex-1">Tags</span></Show>
      </A>

      <div class="flex-1" />
      {utilityLinks.map((l) => (
        <Show when={showLink(l.href)}>
          <A
            href={l.href}
            end={l.href === '/'}
            class="nav-item"
            activeClass="nav-item-active"
            title={l.label}
            aria-label={l.label}
          >
            <l.Icon size={15} class="flex-shrink-0" />
            <Show when={!navCollapsed()}><span class="flex-1">{l.label}</span></Show>
          </A>
        </Show>
      ))}
      <ThemeToggle />
      <Show when={showSignOut()}>
        <div class="my-1.5 border-t border-border/60" />
        <button
          onClick={signOut}
          class="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-surface-800/60 transition-colors"
          title="Sign out"
        >
          <LogOut size={15} class="flex-shrink-0" />
          <Show when={!navCollapsed()}>Sign out</Show>
        </button>
      </Show>
    </nav>
  );
}
