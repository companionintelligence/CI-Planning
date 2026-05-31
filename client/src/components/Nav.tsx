import { A } from '@solidjs/router';
import { Show } from 'solid-js';
import {
  CalendarDays, CheckSquare, Inbox, Tag, Settings, Activity,
  Sun, Zap,
} from 'lucide-solid';
import { possibles } from '../stores/index.js';

const links = [
  { href: '/',         label: 'Today',    Icon: Sun },
  { href: '/calendar', label: 'Calendar', Icon: CalendarDays },
  { href: '/inbox',    label: 'Inbox',    Icon: Inbox,       badge: true },
  { href: '/tasks',    label: 'Tasks',    Icon: CheckSquare },
  { href: '/tags',     label: 'Tags',     Icon: Tag },
  { href: '/jobs',     label: 'Jobs',     Icon: Activity },
  { href: '/settings', label: 'Settings', Icon: Settings },
];

export function Nav() {
  const pendingCount = () => possibles()?.length ?? 0;

  return (
    <nav class="w-52 flex-shrink-0 border-r border-surface-700/60 flex flex-col py-5 px-3 gap-0.5">
      {/* Logo */}
      <div class="flex items-center gap-2.5 px-3 mb-5">
        <div class="w-7 h-7 rounded-lg bg-accent/20 border border-accent/30 flex items-center justify-center flex-shrink-0">
          <Zap size={14} class="text-accent-light" />
        </div>
        <div>
          <div class="text-[11px] font-semibold tracking-widest text-slate-500 uppercase leading-none">Companion</div>
          <div class="text-sm text-slate-200 font-semibold leading-tight mt-0.5">Planning</div>
        </div>
      </div>

      <div class="section-label">Navigation</div>

      {links.map((l) => (
        <A
          href={l.href}
          end={l.href === '/'}
          class="nav-item"
          activeClass="nav-item-active"
        >
          <l.Icon size={15} class="flex-shrink-0 opacity-70" />
          <span class="flex-1">{l.label}</span>
          <Show when={l.badge && pendingCount() > 0}>
            <span class="badge-accent text-[10px] px-1.5 py-0 rounded-full font-bold">{pendingCount()}</span>
          </Show>
        </A>
      ))}
    </nav>
  );
}
