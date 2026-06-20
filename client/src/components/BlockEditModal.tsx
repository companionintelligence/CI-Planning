import { createSignal, createEffect, Show } from 'solid-js';
import { X, Save } from 'lucide-solid';
import { api, type Block } from '../lib/api.js';
import { refetchBlocks, showToast } from '../stores/index.js';

/**
 * Edit a Plan container (PR-B): title, multi-tag, day/start, D/H/M duration, and a
 * saved note. Opened from a Plan's options menu (Edit). One PATCH on save.
 */
const pad = (n: number) => String(n).padStart(2, '0');
function toLocalDate(iso: string) { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function toLocalTime(iso: string) { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function isoAt(dateStr: string, hhmm: string) {
  const [y, mo, da] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(y, mo - 1, da, h || 0, mi || 0, 0, 0).toISOString();
}

export function BlockEditModal(props: { block: Block | null; onClose: () => void }) {
  const [name, setName] = createSignal('');
  const [tags, setTags] = createSignal('');
  const [day, setDay] = createSignal('');
  const [time, setTime] = createSignal('');
  const [pD, setPD] = createSignal(0);
  const [pH, setPH] = createSignal(1);
  const [pM, setPM] = createSignal(0);
  const [note, setNote] = createSignal('');

  createEffect(() => {
    const b = props.block;
    if (!b) return;
    setName(b.title);
    setTags((b.tag ?? '').split(',').filter(Boolean).map((t) => `#${t}`).join(' '));
    setDay(toLocalDate(b.start_at));
    setTime(toLocalTime(b.start_at));
    const min = Math.max(Math.round((Date.parse(b.end_at) - Date.parse(b.start_at)) / 60000), 0);
    setPD(Math.floor(min / 1440)); setPH(Math.floor((min % 1440) / 60)); setPM(min % 60);
    setNote(b.note ?? '');
  });

  async function save() {
    const b = props.block;
    if (!b) return;
    const tagList = tags().split(/[\s,]+/).map((t) => t.replace(/^#/, '').trim()).filter(Boolean);
    const durMin = Math.max(pD() * 1440 + pH() * 60 + pM(), 15);
    const start = isoAt(day(), time());
    const end = new Date(Date.parse(start) + durMin * 60000).toISOString();
    try {
      await api.blocks.update(b.id, {
        title: name().trim() || 'Plan', tag: tagList.join(',') || null,
        start_at: start, end_at: end, note: note().trim() || null,
      });
      refetchBlocks();
      showToast('Plan updated', 'success');
      props.onClose();
    } catch (err) { showToast((err as Error).message, 'error'); }
  }

  return (
    <Show when={props.block}>
      <div class="modal-backdrop" onClick={props.onClose}>
        <div class="modal" onClick={(e) => e.stopPropagation()}>
          <div class="flex items-center justify-between px-4 py-3 border-b border-border">
            <span class="text-sm font-semibold text-foreground">Edit Plan</span>
            <button onClick={props.onClose} class="btn-icon"><X size={16} /></button>
          </div>
          <div class="p-4 flex flex-col gap-3">
            <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Title</span>
              <input class="input" value={name()} onInput={(e) => setName(e.currentTarget.value)} /></label>
            <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Tags (space-separated)</span>
              <input class="input" placeholder="#work #focus" value={tags()} onInput={(e) => setTags(e.currentTarget.value)} /></label>
            <div class="grid grid-cols-2 gap-2">
              <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Day</span>
                <input type="date" class="input" value={day()} onInput={(e) => setDay(e.currentTarget.value)} /></label>
              <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Start</span>
                <input type="time" class="input" value={time()} onInput={(e) => setTime(e.currentTarget.value)} /></label>
            </div>
            <div>
              <span class="text-[11px] text-muted-foreground">Duration</span>
              <div class="flex gap-2 mt-1">
                <label class="flex flex-col gap-0.5 flex-1"><input type="number" min="0" max="60" class="input" value={pD()} onInput={(e) => setPD(Number(e.currentTarget.value) || 0)} /><span class="text-[10px] text-muted-foreground text-center">days</span></label>
                <label class="flex flex-col gap-0.5 flex-1"><input type="number" min="0" max="23" class="input" value={pH()} onInput={(e) => setPH(Number(e.currentTarget.value) || 0)} /><span class="text-[10px] text-muted-foreground text-center">hrs</span></label>
                <label class="flex flex-col gap-0.5 flex-1"><input type="number" min="0" max="55" step="5" class="input" value={pM()} onInput={(e) => setPM(Number(e.currentTarget.value) || 0)} /><span class="text-[10px] text-muted-foreground text-center">min</span></label>
              </div>
            </div>
            <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Note</span>
              <textarea class="textarea" rows="2" value={note()} onInput={(e) => setNote(e.currentTarget.value)} /></label>
            <div class="flex justify-end gap-2 pt-1">
              <button onClick={props.onClose} class="btn-ghost text-sm px-3 py-1.5">Cancel</button>
              <button onClick={save} class="btn-primary text-sm px-4 py-1.5"><Save size={14} /> Save</button>
            </div>
          </div>
        </div>
      </div>
    </Show>
  );
}
