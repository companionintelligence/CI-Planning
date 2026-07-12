import { A, useNavigate } from '@solidjs/router';
import { Show, createResource } from 'solid-js';
import {
  CheckSquare, Inbox, Tag, Settings, Activity,
  Sun, Cpu, CalendarDays, LogOut,
} from 'lucide-solid';
import { possibles, showToast } from '../stores/index.js';
import { api, authGateActive } from '../lib/api.js';
import { ThemeToggle } from './ThemeToggle.js';

const links = [
  { href: '/',            label: 'Today',      Icon: Sun },
  { href: '/calendar',   label: 'Calendar',   Icon: CalendarDays },
  { href: '/inbox',      label: 'Inbox',      Icon: Inbox, badge: true },
  { href: '/tasks',      label: 'Tasks',      Icon: CheckSquare },
  { href: '/tags',       label: 'Tags',       Icon: Tag },
  { href: '/jobs',       label: 'Jobs',       Icon: Activity },
  { href: '/settings',   label: 'Settings',   Icon: Settings },
];

export function Nav() {
  const pendingCount = () => possibles()?.length ?? 0;
  const navigate = useNavigate();
  // Sign-out is only meaningful when the deployment gates on auth (sso mode);
  // test/standalone have no session to end, so the affordance stays hidden.
  const [cfg] = createResource(() => api.auth.config().catch(() => null));
  const showSignOut = () => { const c = cfg(); return !!c && authGateActive(c); };
  async function signOut() {
    try {
      await api.auth.logout();
      navigate('/login', { replace: true });
    } catch (err) {
      showToast((err as Error).message, 'error');
    }
  }

  return (
    <nav class="hidden md:flex w-52 flex-shrink-0 border-r border-surface-700/50 flex-col py-5 px-3 gap-0.5 bg-surface-900">
      {/* CI logo mark */}
      <div class="flex items-center gap-2.5 px-3 mb-5">
        <div
          class="w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 text-surface-950 font-bold text-xs"
          style={{ background: 'linear-gradient(135deg, #58ebbf, #409b9b)' }}
        >
          <Cpu size={15} />
        </div>
        <div>
          <div class="text-[10px] font-medium tracking-[0.2em] uppercase leading-none" style={{ color: '#409b9b' }}>
            Companion
          </div>
          <div class="font-heading text-base text-slate-100 leading-tight mt-0.5 tracking-wide">
            Planning
          </div>
        </div>
      </div>

      <div class="section-label">Navigation</div>

      {links.map((l) => (
        <>
          <A
            href={l.href}
            end={l.href === '/'}
            class="nav-item"
            activeClass="nav-item-active"
          >
            <l.Icon size={15} class="flex-shrink-0" />
            <span class="flex-1">{l.label}</span>
            <Show when={l.badge && pendingCount() > 0}>
              <span
                class="text-[10px] px-1.5 py-0.5 rounded-full font-bold"
                style={{ background: 'rgba(88,235,191,.2)', color: '#58ebbf' }}
              >
                {pendingCount()}
              </span>
            </Show>
          </A>
          {/* Stroke line under Inbox — separates capture (Today/Calendar/Inbox)
              from planning (Tasks/Tags/…). */}
          <Show when={l.href === '/inbox'}>
            <div class="my-1.5 border-t border-border/60" />
          </Show>
        </>
      ))}

      <div class="flex-1" />
      <Show when={showSignOut()}>
        <button
          onClick={signOut}
          class="flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm text-muted-foreground hover:text-foreground hover:bg-surface-800/60 transition-colors"
          title="Sign out"
        >
          <LogOut size={15} class="flex-shrink-0" />
          Sign out
        </button>
      </Show>
      <ThemeToggle />
    </nav>
  );
}
