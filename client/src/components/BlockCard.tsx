import { Show } from 'solid-js';
import { Lock, CheckCircle, SkipForward, AlertTriangle } from 'lucide-solid';
import { type Block, api } from '../lib/api.js';
import { showToast } from '../stores/index.js';

// CI teal palette for block kinds
const kindBorderStyle: Record<string, string> = {
  task:    '#409b9b',  // ci-4
  meeting: '#244859',  // ci-10
  focus:   '#58ebbf',  // ci-3
  habit:   '#85c3b4',  // ci-2
  break:   '#152637',
  buffer:  '#0f1e2e',
};

const kindBadgeClass: Record<string, string> = {
  task:    'badge-accent',
  meeting: 'badge-blue',
  focus:   'badge-accent',
  habit:   'badge-green',
  break:   'badge-neutral',
  buffer:  'badge-neutral',
};

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

interface Props {
  block: Block;
  onUpdated?: () => void;
}

export function BlockCard(props: Props) {
  const borderColor = () => kindBorderStyle[props.block.block_kind] ?? '#152637';
  // Settled = any terminal status, matching PlannerChip.settled() and the server's
  // TERMINAL_BLOCK_STATUSES — cancelled/missed dim like other settled history.
  const done = () => ['completed', 'skipped', 'cancelled', 'missed'].includes(props.block.status);
  const durationMins = () =>
    Math.round((new Date(props.block.end_at).getTime() - new Date(props.block.start_at).getTime()) / 60_000);

  async function setStatus(s: string) {
    try {
      await api.blocks.update(props.block.id, { status: s });
      props.onUpdated?.();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    <div
      class={`card group flex gap-3 border-l-4 ${done() ? 'opacity-40' : ''}`}
      style={{ 'border-left-color': borderColor() }}
    >
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="font-mono text-xs text-slate-500 flex-shrink-0">
            {fmtTime(props.block.start_at)}–{fmtTime(props.block.end_at)}
          </span>
          <span class={`badge capitalize ${kindBadgeClass[props.block.block_kind] ?? 'badge-neutral'}`}>
            {props.block.block_kind}
          </span>
          <Show when={props.block.is_locked}>
            <Lock size={10} class="text-slate-500" />
          </Show>
          <Show when={props.block.status === 'overrun'}>
            <span class="badge-yellow"><AlertTriangle size={10} /> overrun</span>
          </Show>
          <span class="text-xs text-slate-600 ml-auto">{durationMins()}m</span>
        </div>
        <div class={`text-sm mt-1 ${done() ? 'text-slate-500' : 'text-slate-200'}`}>
          {props.block.title}
        </div>
      </div>

      <Show when={!done() && !props.block.is_locked}>
        <div class="opacity-0 group-hover:opacity-100 flex items-center gap-1 transition-opacity flex-shrink-0">
          <button
            onClick={() => setStatus('completed')}
            class="btn-ghost text-xs gap-1 text-green-400 hover:bg-green-950/30"
          >
            <CheckCircle size={13} /> Done
          </button>
          <button onClick={() => setStatus('skipped')} class="btn-ghost text-xs gap-1">
            <SkipForward size={13} /> Skip
          </button>
        </div>
      </Show>
    </div>
  );
}
