import { createResource, For, Show, onCleanup } from 'solid-js';
import { Plus, Trash2, Star } from 'lucide-solid';
import { refetchBlocks, showToast } from '../stores/index.js';
import { api, type BlockTemplate } from '../lib/api.js';
import { useDraggable } from '../lib/draggable.js';
import { on } from '../lib/sse.js';

/**
 * Saved Time Block templates (`block_templates`) — captured with "Save as template"
 * on a Plan. Each row drops onto today. Extracted verbatim from the Patterns view
 * (T-TASKS-6) so it can mount as the Tasks-screen **Time Blocks** tab; behavior is
 * unchanged (list · instantiate-onto-today · delete · drag-to-promote).
 */
export function TimeBlocksPanel() {
  const [templates, { refetch: refetchTemplates }] = createResource(() =>
    api.blockTemplates.list().then((r) => r.block_templates),
  );
  const offTplCreated = on('block_template:created', () => refetchTemplates());
  const offTplDeleted = on('block_template:deleted', () => refetchTemplates());
  onCleanup(() => { offTplCreated(); offTplDeleted(); });

  /** ISO instant for the next half-hour boundary from now (drop target for an instantiated template). */
  function nextHalfHourISO(): string {
    const d = new Date(); d.setSeconds(0, 0);
    d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
    return d.toISOString();
  }
  async function instantiateTemplate(t: BlockTemplate) {
    const start = nextHalfHourISO();
    const end = new Date(Date.parse(start) + (t.default_minutes ?? 60) * 60_000).toISOString();
    try {
      await api.blockTemplates.instantiate(t.id, start, end);
      refetchBlocks();
      showToast(`Dropped "${t.name}" onto today`, 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }
  async function deleteTemplate(t: BlockTemplate) {
    if (!confirm(`Delete the "${t.name}" Time Block? Saved tasks won't come back.`)) return;
    try { await api.blockTemplates.delete(t.id); refetchTemplates(); showToast(`Removed "${t.name}"`, 'default'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    <section class="mb-6">
      <div class="flex items-center gap-2 mb-2.5">
        <span class="text-primary"><Star size={16} class="fill-primary/30" /></span>
        <div class="flex-1">
          <h2 class="text-sm font-semibold text-foreground">Time Blocks</h2>
          <p class="text-[11px] text-muted-foreground">Saved Time Block shapes — drop one onto today</p>
        </div>
      </div>
      <Show when={(templates() ?? []).length > 0} fallback={<EmptyHint>No saved Time Blocks yet — save a Time Block as a template from the Planner ★ menu.</EmptyHint>}>
        <div class="flex flex-col gap-1.5">
          <For each={templates()}>
            {(t) => {
              const drag = useDraggable({ kind: 'time-block', id: t.id });
              return (
                <div
                  onPointerDown={drag.onPointerDown}
                  class="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 cursor-grab select-none touch-none"
                >
                  <Star size={12} class="text-primary flex-shrink-0" />
                  <span class="flex-1 text-sm text-foreground truncate">{t.name}</span>
                  <Show when={t.tag}><span class="text-primary text-xs">#{t.tag}</span></Show>
                  <span class="text-[11px] font-mono text-muted-foreground">{t.default_minutes}m</span>
                  <Show when={(t.tasks ?? []).length}><span class="text-[11px] text-muted-foreground">{(t.tasks ?? []).length}t</span></Show>
                  <button onClick={(e) => { e.stopPropagation(); instantiateTemplate(t); }} class="btn-icon" title="Drop onto today"><Plus size={14} class="text-primary" /></button>
                  <button onClick={(e) => { e.stopPropagation(); deleteTemplate(t); }} class="btn-icon" title="Delete template"><Trash2 size={13} class="text-muted-foreground" /></button>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </section>
  );
}

function EmptyHint(props: { children: any }) {
  return <p class="text-sm text-muted-foreground rounded-lg border border-dashed border-border px-3 py-4 text-center">{props.children}</p>;
}
