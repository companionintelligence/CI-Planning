import { type Block, api } from '../lib/api.js';

const kindColors: Record<string, string> = {
  task:    'border-l-accent-500',
  meeting: 'border-l-blue-500',
  focus:   'border-l-violet-500',
  habit:   'border-l-green-500',
  break:   'border-l-slate-600',
  buffer:  'border-l-slate-700',
};

const statusLabel: Record<string, string> = {
  planned:   '',
  completed: '✓',
  skipped:   '–',
  overrun:   '!',
};

interface Props {
  block: Block;
  onUpdated?: () => void;
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

export function BlockCard(props: Props) {
  const color = () => kindColors[props.block.block_kind] ?? 'border-l-slate-600';
  const durationMins = () =>
    Math.round((new Date(props.block.end_at).getTime() - new Date(props.block.start_at).getTime()) / 60_000);

  async function complete() {
    await api.blocks.update(props.block.id, { status: 'completed' });
    props.onUpdated?.();
  }

  async function skip() {
    await api.blocks.update(props.block.id, { status: 'skipped' });
    props.onUpdated?.();
  }

  const done = () => ['completed', 'skipped'].includes(props.block.status);

  return (
    <div class={`card border-l-4 flex gap-3 group ${color()} ${done() ? 'opacity-50' : ''}`}>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span class="text-xs font-mono text-slate-500">
            {fmtTime(props.block.start_at)} → {fmtTime(props.block.end_at)}
          </span>
          <span class="badge bg-surface-700 text-slate-400 capitalize">{props.block.block_kind}</span>
          {props.block.is_locked && <span class="text-slate-500 text-xs" title="Locked">🔒</span>}
          {statusLabel[props.block.status] && (
            <span class="text-xs text-slate-400">{statusLabel[props.block.status]}</span>
          )}
        </div>
        <div class={`text-sm mt-1 ${done() ? 'text-slate-500 line-through' : 'text-slate-200'}`}>
          {props.block.title}
        </div>
        <div class="text-xs text-slate-600 mt-0.5">{durationMins()}m</div>
      </div>

      {!done() && (
        <div class="opacity-0 group-hover:opacity-100 flex gap-1 transition-opacity self-center">
          <button onClick={complete} class="btn-ghost text-xs py-0.5 px-2 text-green-400">Done</button>
          <button onClick={skip}    class="btn-ghost text-xs py-0.5 px-2">Skip</button>
        </div>
      )}
    </div>
  );
}
