import { createSignal, Show, For, type JSX } from 'solid-js';
import { setActiveEntity } from '../stores/selection.js';
import { revealDetails } from '../stores/ui.js';
import { Lock, Trash2, VolumeX, Volume2, ChevronRight, ChevronDown } from 'lucide-solid';
import { tags, refetchTags, showToast } from '../stores/index.js';
import { api, type Tag } from '../lib/api.js';
import { groupByDirection, groupByCategory, sortDirections, sortCategories, displayTag } from '../lib/tag-tax.js';
import { useDraggable, useDropZone } from '../lib/draggable.js';

/**
 * Tags page — TWO grouping axes over the same intention tags, on separate tabs
 * (T-TASKS tabbed idiom, mirroring AllTasks.tsx):
 *  - **Patterns**: pattern (direction) tags group intention tags (tag_patterns).
 *  - **Time Block Categories** (0069): category tags group a subset of intention tags
 *    (tag_categories) AND carry a per-category direction SCOPE (Work/Home/Community
 *    toggles, default all-on, stored as sparse opt-outs).
 * Drag an intention chip between cards to re-file it on the active axis; mute drops it
 * into the card's collapsible muted section; a used/base tag can't be deleted.
 */
export function Tags() {
  const [view, setView] = createSignal<'patterns' | 'categories'>('patterns');

  const groupedDir = () => groupByDirection(tags() ?? []);
  const groupedCat = () => groupByCategory(tags() ?? []);
  const patternTags = () => sortDirections((tags() ?? []).filter((t) => t.kind === 'direction'));

  async function run(p: Promise<unknown>, ok: string) {
    try { await p; refetchTags(); showToast(ok, 'success'); }
    catch (err) { showToast((err as Error).message, 'error'); }
  }

  // Re-file an intention onto the active axis (single target = drag-move; null = Unsorted).
  const moveDir = (tag: Tag, to: string | null) =>
    run(api.tags.update(tag.id, { directions: to ? [to] : [] }), to ? `Moved to ${displayTag(to)}` : 'Moved to Unsorted');
  const moveCat = (tag: Tag, to: string | null) =>
    run(api.tags.update(tag.id, { categories: to ? [to] : [] }), to ? `Filed under ${displayTag(to)}` : 'Moved to Unsorted');
  const toggleMute = (tag: Tag) =>
    run(api.tags.update(tag.id, { muted: !tag.muted }), tag.muted ? 'Unmuted' : 'Muted');
  // Guard BEFORE run(): run() takes an already-constructed Promise, so building the
  // argument would fire the delete regardless of the answer.
  const del = (tag: Tag) => {
    if (!confirm(`Delete the "${displayTag(tag.name)}" tag?`)) return;
    run(api.tags.remove(tag.id), 'Tag deleted');
  };
  // Flip a direction's scope for a category (opt-out polarity; enabled=true clears the opt-out).
  const toggleDir = (cat: Tag, dir: Tag, enabled: boolean) =>
    run(api.tags.update(cat.id, { direction_toggle: { directionTagId: dir.id, enabled } }),
      `${displayTag(dir.name)} ${enabled ? 'on' : 'off'} for ${displayTag(cat.name)}`);

  return (
    <div class="flex-1 overflow-auto p-6 page-enter max-w-5xl mx-auto w-full">
      <h1 class="text-2xl font-bold text-foreground mb-1">Tags</h1>
      <p class="text-sm text-muted-foreground mb-4">
        <Show when={view() === 'patterns'} fallback="Time Block Categories group your intention tags and scope which directions they pull from. Drag a tag between cards to re-file it.">
          Directions group your intention tags. Drag a tag between cards to re-file it.
        </Show>
      </p>

      {/* Tabs (AllTasks idiom) */}
      <div class="flex gap-2 mb-5">
        <For each={[['patterns', 'Directions'], ['categories', 'Time Block Categories']] as const}>
          {([v, label]) => (
            <button
              onClick={() => setView(v)}
              class="px-3 py-1 text-sm rounded-md transition-colors"
              classList={{ 'bg-primary text-primary-foreground': view() === v, 'text-muted-foreground hover:text-foreground': view() !== v }}
            >
              {label}
            </button>
          )}
        </For>
      </div>

      {/* ── Patterns tab ── */}
      {/* `items-start` so each card is as tall as its own contents. Grid items
          default to `stretch`, which sized every direction card to the tallest
          one — a Work card with four tags left Home and Community as tall boxes
          of empty space, which reads as a broken or unfinished screen rather
          than as two directions that happen to have one tag each. */}
      <Show when={view() === 'patterns'}>
        <div class="grid gap-4 md:grid-cols-3 items-start">
          <For each={groupedDir().groups}>
            {(g) => (
              <DirectionCard
                title={displayTag(g.direction.name)}
                pattern={g.direction.name}
                locked={g.direction.is_base}
                active={g.active}
                muted={g.muted}
                membersOf={(t) => t.directions}
                onDrop={(tag) => moveDir(tag, g.direction.name)}
                onMute={toggleMute}
                onDelete={del}
                onAddTag={(name) => run(api.tags.create(name, { kind: 'intention', directions: [g.direction.name] }), 'Tag added')}
                onDeletePattern={g.direction.is_base || g.direction.used ? undefined : () => del(g.direction)}
              />
            )}
          </For>
          <Show when={groupedDir().unsortedActive.length + groupedDir().unsortedMuted.length > 0}>
            <DirectionCard
              title="Unsorted"
              pattern={null}
              locked
              active={groupedDir().unsortedActive}
              muted={groupedDir().unsortedMuted}
              membersOf={(t) => t.directions}
              onDrop={(tag) => moveDir(tag, null)}
              onMute={toggleMute}
              onDelete={del}
            />
          </Show>
        </div>
      </Show>

      {/* ── Time Block Categories tab ── */}
      <Show when={view() === 'categories'}>
        <div class="grid gap-4 md:grid-cols-3 items-start">
          <For each={groupedCat().groups}>
            {(g) => (
              <DirectionCard
                title={displayTag(g.category.name)}
                pattern={g.category.name}
                locked={g.category.is_base}
                active={g.active}
                muted={g.muted}
                membersOf={(t) => t.categories ?? []}
                toggles={{
                  directions: patternTags(),
                  isOff: (name) => (g.category.direction_optouts ?? []).includes(name),
                  onToggle: (dir, enabled) => toggleDir(g.category, dir, enabled),
                }}
                onDrop={(tag) => moveCat(tag, g.category.name)}
                onMute={toggleMute}
                onDelete={del}
                onAddTag={(name) => run(api.tags.create(name, { kind: 'intention', categories: [g.category.name] }), 'Tag added')}
                onDeletePattern={g.category.is_base ? undefined : () => del(g.category)}
              />
            )}
          </For>
          <Show when={groupedCat().unsortedActive.length + groupedCat().unsortedMuted.length > 0}>
            <DirectionCard
              title="Unsorted"
              pattern={null}
              locked
              active={groupedCat().unsortedActive}
              muted={groupedCat().unsortedMuted}
              membersOf={(t) => t.categories ?? []}
              onDrop={(tag) => moveCat(tag, null)}
              onMute={toggleMute}
              onDelete={del}
            />
          </Show>
        </div>
      </Show>
    </div>
  );
}

function DirectionCard(props: {
  title: string;
  pattern: string | null;
  locked: boolean;
  active: Tag[];
  muted: Tag[];
  /** Membership accessor for the active axis (directions on the Patterns tab, categories on the Category tab). */
  membersOf: (tag: Tag) => string[];
  /** Category tab only: the per-category direction scope toggles. */
  toggles?: { directions: Tag[]; isOff: (dirName: string) => boolean; onToggle: (dir: Tag, enabled: boolean) => void };
  onDrop: (tag: Tag) => void;
  onMute: (tag: Tag) => void;
  onDelete: (tag: Tag) => void;
  onAddTag?: (name: string) => void;
  onDeletePattern?: () => void;
}): JSX.Element {
  const [showMuted, setShowMuted] = createSignal(false);
  const [adding, setAdding] = createSignal('');
  const drop = useDropZone((payload) => {
    if (payload.kind !== 'tag-chip') return;
    const tag = [...props.active, ...props.muted].find((t) => t.id === payload.id) // same card → no-op
      ?? (tags() ?? []).find((t) => t.id === payload.id);
    if (tag && !props.membersOf(tag).includes(props.pattern ?? '')) props.onDrop(tag);
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
          <button
            type="button"
            class="hover:text-primary transition-colors"
            title="Show details"
            onClick={() => {
              if (!props.pattern) return;
              const g = (tags() ?? []).find((t) => t.name === props.pattern);
              setActiveEntity(g?.kind === 'category' ? 'category' : 'direction', props.pattern);
              revealDetails();
            }}
          >{props.title}</button>
        </div>
        <Show when={props.onDeletePattern}>
          <button onClick={() => props.onDeletePattern!()} class="btn-icon" title="Delete"><Trash2 size={13} /></button>
        </Show>
      </div>

      {/* Category tab: direction-scope toggles (default ON; click to opt a direction out). */}
      <Show when={props.toggles}>
        <div class="flex flex-wrap gap-1.5">
          <For each={props.toggles!.directions}>
            {(dir) => {
              const off = () => props.toggles!.isOff(dir.name);
              return (
                <button
                  type="button"
                  onClick={() => props.toggles!.onToggle(dir, off())}
                  class="text-[11px] px-2 py-0.5 rounded-full border capitalize transition-colors"
                  classList={{
                    'border-primary text-primary bg-primary/10': !off(),
                    'border-border text-muted-foreground line-through opacity-60': off(),
                  }}
                  title={off() ? `${displayTag(dir.name)} excluded — click to include` : `${displayTag(dir.name)} included — click to exclude`}
                >
                  {displayTag(dir.name)}
                </button>
              );
            }}
          </For>
        </div>
      </Show>

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
 *  buttons (siblings) still receive clicks (useDraggable preventDefaults pointerdown).
 *  Phase D (batch-3): every chip carries a compact Category select on BOTH tabs, so an
 *  intention's category is pickable without dragging (drag stays the axis-refile). */
function Chip(props: { tag: Tag; onMute: (t: Tag) => void; onDelete: (t: Tag) => void }): JSX.Element {
  const drag = useDraggable(() => ({ kind: 'tag-chip' as const, id: props.tag.id }));
  const categoryOptions = () => sortCategories((tags() ?? []).filter((t) => t.kind === 'category'));
  const current = () => props.tag.categories?.[0] ?? '';
  async function setCategory(name: string) {
    try {
      await api.tags.update(props.tag.id, { categories: name ? [name] : [] });
      refetchTags();
      showToast(name ? `Filed under ${displayTag(name)}` : 'Category cleared', 'success');
    } catch (err) { showToast((err as Error).message, 'error'); }
  }
  return (
    <span class="badge-neutral text-[11px] flex items-center gap-1 pr-1">
      <span {...drag} class="cursor-grab select-none">#{props.tag.name}</span>
      {/* max-w is sized for the longest balance category ("Relationships"). At 72px a
          native select clips mid-word with no ellipsis, so the chip rendered
          "#personal Relationsl", which reads as a typo rather than a truncation. */}
      <select
        value={current()}
        onChange={(e) => void setCategory(e.currentTarget.value)}
        onPointerDown={(e) => e.stopPropagation()}
        class="bg-transparent border-0 text-[10px] text-muted-foreground max-w-[104px] cursor-pointer capitalize focus:outline-none"
        title="Category"
      >
        <option value="">—</option>
        <For each={categoryOptions()}>
          {(c) => <option value={c.name} selected={current() === c.name}>{displayTag(c.name)}</option>}
        </For>
      </select>
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
