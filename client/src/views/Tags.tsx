import { createSignal, Show, For, type JSX } from 'solid-js';
import { Hash, Plus, Lock, Trash2, VolumeX, Volume2, ChevronRight, ChevronDown } from 'lucide-solid';
import { tags, refetchTags, showToast } from '../stores/index.js';
import { api, type Tag } from '../lib/api.js';
import { groupByDirection, displayTag } from '../lib/tag-tax.js';
import { useDraggable, useDropZone } from '../lib/draggable.js';

/**
 * Tags page — the direction ▸ intention taxonomy. One card per direction (brand-set
 * Home/Work/Community + user-added) plus an Unsorted card. Drag an intention chip from
 * one card to another to MOVE its direction; mute a tag to drop it into the card's
 * collapsible muted section; a used tag can't be deleted (base directions never can).
 */
export function Tags() {
  const [newDir, setNewDir] = createSignal('');

  const grouped = () => groupByDirection(tags() ?? []);

  async function run(p: Promise<unknown>, ok: string) {
    try { await p; refetchTags(); showToast(ok, 'success'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  async function addDirection(e: Event) {
    e.preventDefault();
    if (!newDir().trim()) return;
    await run(api.tags.create(newDir().trim(), { kind: 'direction' }), 'Direction added');
    setNewDir('');
  }
  const move = (tag: Tag, toDirection: string | null) =>
    run(api.tags.update(tag.id, { directions: toDirection ? [toDirection] : [] }), toDirection ? `Moved to ${displayTag(toDirection)}` : 'Moved to Unsorted');
  const toggleMute = (tag: Tag) =>
    run(api.tags.update(tag.id, { muted: !tag.muted }), tag.muted ? 'Unmuted' : 'Muted');
  const del = (tag: Tag) => run(api.tags.remove(tag.id), 'Tag deleted');

  return (
    <div class="flex-1 overflow-auto p-6 page-enter max-w-5xl mx-auto w-full">
      <h1 class="text-2xl font-bold text-foreground mb-1">Tags</h1>
      <p class="text-sm text-muted-foreground mb-5">
        Directions group your intention tags. Drag a tag between cards to re-file it.
      </p>

      <form onSubmit={addDirection} class="flex gap-2 mb-6 max-w-sm">
        <div class="relative flex-1">
          <Hash size={13} class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input class="input pl-8" placeholder="New direction…" value={newDir()} onInput={(e) => setNewDir(e.currentTarget.value)} />
        </div>
        <button type="submit" class="btn-primary"><Plus size={14} /> Direction</button>
      </form>

      <div class="grid gap-4 md:grid-cols-3">
        <For each={grouped().groups}>
          {(g) => (
            <DirectionCard
              title={displayTag(g.direction.name)}
              direction={g.direction.name}
              locked={g.direction.is_base}
              active={g.active}
              muted={g.muted}
              onDrop={(tag) => move(tag, g.direction.name)}
              onMute={toggleMute}
              onDelete={del}
              onAddTag={(name) => run(api.tags.create(name, { kind: 'intention', directions: [g.direction.name] }), 'Tag added')}
              onDeleteDirection={g.direction.is_base || g.direction.used ? undefined : () => del(g.direction)}
            />
          )}
        </For>
        <Show when={grouped().unsortedActive.length + grouped().unsortedMuted.length > 0}>
          <DirectionCard
            title="Unsorted"
            direction={null}
            locked
            active={grouped().unsortedActive}
            muted={grouped().unsortedMuted}
            onDrop={(tag) => move(tag, null)}
            onMute={toggleMute}
            onDelete={del}
          />
        </Show>
      </div>
    </div>
  );
}

function DirectionCard(props: {
  title: string;
  direction: string | null;
  locked: boolean;
  active: Tag[];
  muted: Tag[];
  onDrop: (tag: Tag) => void;
  onMute: (tag: Tag) => void;
  onDelete: (tag: Tag) => void;
  onAddTag?: (name: string) => void;
  onDeleteDirection?: () => void;
}): JSX.Element {
  const [showMuted, setShowMuted] = createSignal(false);
  const [adding, setAdding] = createSignal('');
  const drop = useDropZone((payload) => {
    if (payload.kind !== 'tag-chip') return;
    const tag = [...props.active, ...props.muted].find((t) => t.id === payload.id) // same card → no-op
      ?? (tags() ?? []).find((t) => t.id === payload.id);
    if (tag && !tag.directions.includes(props.direction ?? '')) props.onDrop(tag);
  });

  function submitAdd(e: Event) {
    e.preventDefault();
    if (adding().trim() && props.onAddTag) { props.onAddTag(adding().trim()); setAdding(''); }
  }

  return (
    <div
      class="card flex flex-col gap-3 transition-colors"
      classList={{ 'border-primary': drop.isOver() }}
      {...drop.handlers}
    >
      <div class="flex items-center justify-between">
        <div class="flex items-center gap-1.5 section-label">
          <Show when={props.locked}><Lock size={11} class="text-muted-foreground" /></Show>
          {props.title}
        </div>
        <Show when={props.onDeleteDirection}>
          <button onClick={() => props.onDeleteDirection!()} class="btn-icon" title="Delete direction"><Trash2 size={13} /></button>
        </Show>
      </div>

      <div class="flex flex-wrap gap-1.5">
        <For each={props.active} fallback={<span class="text-xs text-muted-foreground">No tags yet.</span>}>
          {(tag) => <Chip tag={tag} onMute={props.onMute} onDelete={props.onDelete} />}
        </For>
      </div>

      <Show when={props.onAddTag}>
        <form onSubmit={submitAdd} class="flex gap-1.5">
          <input class="input text-xs py-1" placeholder="+ add tag" value={adding()} onInput={(e) => setAdding(e.currentTarget.value)} />
        </form>
      </Show>

      <Show when={props.muted.length > 0}>
        <div class="border-t border-border pt-2">
          <button onClick={() => setShowMuted((v) => !v)} class="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <Show when={showMuted()} fallback={<ChevronRight size={12} />}><ChevronDown size={12} /></Show>
            Muted ({props.muted.length})
          </button>
          <Show when={showMuted()}>
            <div class="flex flex-wrap gap-1.5 mt-2 opacity-60">
              <For each={props.muted}>{(tag) => <Chip tag={tag} onMute={props.onMute} onDelete={props.onDelete} />}</For>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** A draggable intention chip. Only the label is the drag handle, so the mute/delete
 *  buttons (siblings) still receive clicks (useDraggable preventDefaults pointerdown). */
function Chip(props: { tag: Tag; onMute: (t: Tag) => void; onDelete: (t: Tag) => void }): JSX.Element {
  const drag = useDraggable(() => ({ kind: 'tag-chip' as const, id: props.tag.id }));
  return (
    <span class="badge-neutral text-[11px] flex items-center gap-1 pr-1">
      <span {...drag} class="cursor-grab select-none">#{props.tag.name}</span>
      <button onClick={() => props.onMute(props.tag)} class="opacity-60 hover:opacity-100" title={props.tag.muted ? 'Unmute' : 'Mute'}>
        <Show when={props.tag.muted} fallback={<Volume2 size={11} />}><VolumeX size={11} /></Show>
      </button>
      <button
        onClick={() => !props.tag.used && props.onDelete(props.tag)}
        disabled={props.tag.used}
        class="opacity-60 hover:opacity-100 disabled:opacity-25 disabled:cursor-not-allowed"
        title={props.tag.used ? 'In use — cannot delete' : 'Delete'}
      >
        <Trash2 size={11} />
      </button>
    </span>
  );
}
