import { A } from '@solidjs/router';
import { Show } from 'solid-js';
import {
  CheckSquare, Inbox, Tag, Settings, Activity,
  Sun, Cpu, CalendarDays, Target,
} from 'lucide-solid';
import { possibles } from '../stores/index.js';
import { ThemeToggle } from './ThemeToggle.js';

const links = [
  { href: '/',            label: 'Today',      Icon: Sun },
  { href: '/calendar',   label: 'Calendar',   Icon: CalendarDays },
  { href: '/inbox',      label: 'Inbox',      Icon: Inbox, badge: true },
  { href: '/tasks',      label: 'Tasks',      Icon: CheckSquare },
  { href: '/objectives', label: 'Objectives', Icon: Target },
  { href: '/tags',       label: 'Tags',       Icon: Tag },
  { href: '/jobs',       label: 'Jobs',       Icon: Activity },
  { href: '/settings',   label: 'Settings',   Icon: Settings },
];

export function Nav() {
  const pendingCount = () => possibles()?.length ?? 0;

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
      <ThemeToggle />
    </nav>
  );
}
