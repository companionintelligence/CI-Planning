import { A, useNavigate } from '@solidjs/router';
import { Show, createResource } from 'solid-js';
import {
  CheckSquare, Tag, Settings, Activity,
  Sun, Cpu, CalendarDays, LogOut, Crosshair, Scale,
} from 'lucide-solid';
import { showToast } from '../stores/index.js';
import { api, authGateActive } from '../lib/api.js';
import { ThemeToggle } from './ThemeToggle.js';

const links = [
  { href: '/focus',      label: 'Focus',      Icon: Crosshair },
  { href: '/',            label: 'Today',      Icon: Sun },
  { href: '/calendar',   label: 'Calendar',   Icon: CalendarDays },
  { href: '/tasks',      label: 'Tasks',      Icon: CheckSquare },
  { href: '/balance',    label: 'Balance',    Icon: Scale },
  { href: '/tags',       label: 'Tags',       Icon: Tag },
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
          <Show when={showLink(l.href)}>
            <A
              href={l.href}
              end={l.href === '/'}
              class="nav-item"
              activeClass="nav-item-active"
            >
              <l.Icon size={15} class="flex-shrink-0" />
              <span class="flex-1">{l.label}</span>
            </A>
          </Show>
          {/* Stroke line under Calendar — separates capture (Today/Calendar) from
              planning (Tasks/Tags/…). */}
          <Show when={l.href === '/calendar'}>
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
