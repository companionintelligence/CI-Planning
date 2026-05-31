import { A } from '@solidjs/router';
import { possibles } from '../stores/index.js';

const links = [
  { href: '/',         label: 'Today' },
  { href: '/calendar', label: 'Calendar' },
  { href: '/inbox',    label: 'Inbox',   badge: true },
  { href: '/tasks',    label: 'Tasks' },
  { href: '/tags',     label: 'Tags' },
  { href: '/jobs',     label: 'Jobs' },
  { href: '/settings', label: 'Settings' },
];

export function Nav() {
  const pendingCount = () => possibles()?.length ?? 0;

  return (
    <nav class="w-52 flex-shrink-0 border-r border-surface-700 flex flex-col py-6 px-3 gap-1">
      <div class="px-3 mb-6">
        <div class="text-xs font-semibold tracking-widest text-slate-500 uppercase">Companion</div>
        <div class="text-sm text-slate-200 mt-0.5 font-medium">Planning</div>
      </div>

      {links.map((l) => (
        <A
          href={l.href}
          end={l.href === '/'}
          class="flex items-center justify-between px-3 py-2 rounded-md text-sm text-slate-400 hover:text-slate-100 hover:bg-surface-700 transition-colors"
          activeClass="text-slate-100 bg-surface-700"
        >
          <span>{l.label}</span>
          {l.badge && pendingCount() > 0 && (
            <span class="badge bg-accent-600 text-white">{pendingCount()}</span>
          )}
        </A>
      ))}
    </nav>
  );
}
