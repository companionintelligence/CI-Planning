/**
 * "Element" — a UI-only union over the calendar-addable Entities (Task, Habit,
 * Routine, Time-Block). There is NO Element DB noun; each kind maps to an existing
 * entity + API. This module holds the type-chooser metadata, the shared primary/
 * secondary tag helpers, the title+pattern "most likely" ranking, and the single
 * `saveElement` adapter the wizard calls. See plan: luminous-waddling-nest.
 */
import { api, type TaskInput, type Tag } from './api.js';
import {
  tags, patternTypes, patternPrefs,
  refetchTasks, refetchBlocks, refetchConcepts, refetchPatterns, refetchTags,
  type ElementKind,
} from '../stores/index.js';
import { suggestTagsFromTitle } from './tag-suggest.js';
import { localISODate } from './dates.js';

export type { ElementKind };

/** The four addable kinds — drives the Stage-0 chooser. */
export const ELEMENT_KINDS: { kind: ElementKind; label: string; blurb: string }[] = [
  { kind: 'task',      label: 'Task',       blurb: 'A single to-do' },
  { kind: 'habit',     label: 'Habit',      blurb: 'A repeating action' },
  { kind: 'routine',   label: 'Routine',    blurb: 'A bundle of tasks' },
  { kind: 'timeblock', label: 'Time Block', blurb: 'A span on the calendar' },
];

// ── Shared tag helpers (single source for the wizard + drawer) ──────────────────
export const patternTagList = (): Tag[] => (tags() ?? []).filter((t) => t.kind === 'direction');

/** Intention tags associated with a primary pattern, via their `directions`. */
export const intentionTagsFor = (primaryName: string): Tag[] =>
  (tags() ?? []).filter(
    (t) => t.kind === 'intention' && t.directions.some((d) => d.toLowerCase() === primaryName.toLowerCase()),
  );

/** A pattern tag's saved default estimate (minutes), else 60. */
export function patternDefaultMinutes(name: string): number {
  const t = patternTagList().find((x) => x.name.toLowerCase() === name.toLowerCase());
  return (t && patternPrefs()?.prefs?.[t.id]?.default_minutes) || 60;
}

/**
 * The "most likely" secondary tags for a (title, primary) pair: the primary's
 * associated intention tags, ranked by title relevance. Title relevance comes from
 * the offline heuristic (`suggestTagsFromTitle`) plus any LLM suggestions passed in
 * (the wizard fetches those debounced; degrades to heuristic when Ollama is down).
 */
export function rankedSecondaryTags(title: string, primaryName: string, llm: string[] = []): Tag[] {
  const candidates = intentionTagsFor(primaryName);
  if (!candidates.length) return [];
  const heur = new Set(suggestTagsFromTitle(title, candidates.map((c) => c.name)).map((s) => s.toLowerCase()));
  const llmSet = new Set(llm.map((s) => s.toLowerCase()));
  const score = (t: Tag) => (heur.has(t.name.toLowerCase()) ? 2 : 0) + (llmSet.has(t.name.toLowerCase()) ? 1 : 0);
  return [...candidates].sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));
}

// ── AF-9: time-block tag shape helpers (pure; unit-tested) ──────────────────────

/**
 * Split a stored `time_blocks.tag` string. Legacy wizard-era rows may be
 * comma-joined ("work,deep,errand"): the FIRST segment is the primary and the
 * remaining segments become secondary chips. Normalization is write-time only —
 * a legacy row keeps its shape until the next save sends tag=primary +
 * secondary_tags (read paths elsewhere are unchanged).
 */
export function splitBlockTag(tag: string | null | undefined): { primary: string; secondary: string[] } {
  const parts = (tag ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { primary: parts[0] ?? '', secondary: parts.slice(1) };
}

/** Merge tag-name lists, deduped case-insensitively (first occurrence wins). */
export function mergeTagNames(...lists: (string[] | undefined)[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const list of lists) {
    for (const raw of list ?? []) {
      const name = raw.trim();
      const key = name.toLowerCase();
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push(name);
    }
  }
  return out;
}

/**
 * AF-9 save shape for a time block: the level-1 `tag` is the SINGLE primary
 * (WORK/HOME/COMMUNITY — no more folding intentions into a comma-joined string)
 * and the authored intention chips land at level 2, deduped case-insensitively,
 * minus the primary itself and any category-name collisions (a category is
 * never an entity tag; same guard as the task path). The wizard round-trips a
 * block's existing secondary_tags INTO `intentions` on load, so chips are the
 * single level-2 source.
 */
export function timeblockTagPayload(
  form: Pick<ElementForm, 'primary' | 'intentions'>,
  categoryNames: Set<string> = new Set(),
): { tag: string | undefined; secondary_tags: string[] } {
  const primary = form.primary.trim();
  const tag = primary && !categoryNames.has(primary.toLowerCase()) ? primary : undefined;
  const secondary_tags = mergeTagNames(form.intentions).filter(
    (n) => n.toLowerCase() !== primary.toLowerCase() && !categoryNames.has(n.toLowerCase()),
  );
  return { tag, secondary_tags };
}

/**
 * AF-11 save shape for a task/habit — the array-semantics mirror of
 * `timeblockTagPayload`: `tags` (level 1) carries ONLY the single primary
 * direction, `secondary_tags` (level 2) the intention chips, deduped
 * case-insensitively, minus the primary itself and category-name collisions.
 * Both arrays are ALWAYS sent (create and edit): the server treats a present
 * array as authoritative for its level (applyTaskTagLevels), so `tags: []` on
 * an edit actively CLEARS a removed direction — the task-side equivalent of
 * the block path's `tag: null` (blocks need null because their scalar is
 * JSON-dropped when undefined; an array survives serialization as `[]`).
 */
export function taskTagPayload(
  form: Pick<ElementForm, 'primary' | 'intentions'>,
  categoryNames: Set<string> = new Set(),
): { tags: string[]; secondary_tags: string[] } {
  const primary = form.primary.trim();
  const tags = primary && !categoryNames.has(primary.toLowerCase()) ? [primary] : [];
  const secondary_tags = mergeTagNames(form.intentions).filter(
    (n) => n.toLowerCase() !== primary.toLowerCase() && !categoryNames.has(n.toLowerCase()),
  );
  return { tags, secondary_tags };
}

// ── Date helpers (client-local) ─────────────────────────────────────────────────
function isoAt(dateStr: string, hhmm: string): string {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  return new Date(y, mo - 1, d, h || 0, mi || 0, 0, 0).toISOString();
}
function isoAtMidnight(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).toISOString();
}
/** "HH:MM" at the next half-hour boundary — the default start for a new time block. */
export function nextHalfHour(): string {
  const d = new Date();
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ── The element form + save adapter ─────────────────────────────────────────────
export interface ElementForm {
  title: string;
  primary: string;            // pattern (direction) tag name
  intentions: string[];       // secondary intention tag names
  note?: string;
  // time-block / scheduling
  day?: string;               // YYYY-MM-DD (scheduled)
  start?: string;             // HH:MM (scheduled)
  durationMin?: number;
  someday?: boolean;          // time-block as a someday goal
  goalDay?: string;           // YYYY-MM-DD (someday)
  recurrenceRule?: string | null;  // time-block RRULE ('' / null clears)
  categoryId?: string;             // time-block: the Time Block Category (0069); direction implied
  // time-block membership (scheduled only): existing tasks/habits to scatter inside,
  // routines to place inside, and child blocks to detach — all applied on Save.
  attachTaskIds?: string[];
  attachRoutineIds?: string[];
  detachBlockIds?: string[];
  // task / habit
  scheduledFor?: string;
  taskTime?: string;
  estimatedMinutes?: number;
  dueAt?: string;
  priority?: number;
  deferUntil?: string;        // YYYY-MM-DD
  dependsOn?: string[];
  editScope?: 'instance' | 'series';  // recurring-task edits
  parentId?: string;          // subtask parent
}

/** Create intention tags that don't exist yet, attached to the chosen primary so
 *  they aren't orphaned to Unsorted (mirrors TaskForm's behavior). */
async function ensureIntentionTags(primary: string, names: string[]): Promise<void> {
  if (!primary) return;
  const all = tags() ?? [];
  const known = new Set(all.map((t) => t.name.toLowerCase()));
  // Never auto-create an intention that collides with a pattern OR a category name.
  const reserved = new Set(all.filter((t) => t.kind === 'direction' || t.kind === 'category').map((t) => t.name.toLowerCase()));
  for (const n of names) {
    const key = n.toLowerCase();
    if (!known.has(key) && !reserved.has(key)) {
      await api.tags.create(n, { kind: 'intention', directions: [primary] });
    }
  }
}

/**
 * Persist an element. Maps each kind to its existing API, creates any new intention
 * tags, refetches the affected stores, and returns a success message. Throws on
 * error (the wizard surfaces it).
 */
export async function saveElement(
  kind: ElementKind,
  mode: 'add' | 'edit',
  form: ElementForm,
  editId?: string,
): Promise<string> {
  // Category tags are NEVER task/direction tags — keep them out of an entity's tag list
  // (a typed intention name that collides with a category must not attach the category).
  const categoryNames = new Set((tags() ?? []).filter((t) => t.kind === 'category').map((t) => t.name.toLowerCase()));
  // (The old flat `tagList` is gone: tasks/habits use taskTagPayload's split shape,
  // routines author no tags at all — AF-11.)
  await ensureIntentionTags(form.primary, form.intentions);

  if (kind === 'task' || kind === 'habit') {
    const sd = !!form.someday;
    const rule = form.recurrenceRule || undefined;  // built by the wizard (preset+weekdays+custom)
    // A fresh, non-recurring, scheduled task should land on the Planner on Save — the
    // Planner renders time_blocks, so ask the server to place a start-anchored block at
    // (scheduled_for, task_time). Without this a calendar-clicked task saves invisibly.
    // Scoped out: habits and recurring series (their instances come from the recurrence
    // engine), someday (no time), and edits.
    const placeOnSave = mode === 'add' && kind === 'task' && !sd && !rule && !!form.scheduledFor;
    // AF-11: split shape — tags (L1) = [primary direction], secondary_tags (L2) =
    // intention chips. No more flat [primary, ...intentions] at level 1.
    const { tags: taskTags, secondary_tags } = taskTagPayload(form, categoryNames);
    const body: TaskInput = {
      title: form.title.trim() || 'Untitled',
      tags: taskTags,
      secondary_tags,
      notes: form.note || undefined,
      parent_id: form.parentId,
      // Someday = capture title/tags only (no schedule) → lands in TBD.
      scheduled_for: sd ? undefined : (form.scheduledFor || undefined),
      task_time: sd ? undefined : (form.taskTime || undefined),
      estimated_minutes: sd ? undefined : (form.estimatedMinutes || undefined),
      due_at: sd ? undefined : (form.dueAt || undefined),
      priority: sd ? undefined : (form.priority ?? 3),
      defer_until: form.deferUntil ? new Date(form.deferUntil + 'T00:00:00').toISOString() : undefined,
      depends_on: form.dependsOn ?? [],
      auto_place: placeOnSave,
    };
    if (kind === 'habit') body.is_habit = true;
    if (rule) body.recurrence_rule = rule;
    if (mode === 'add') {
      await api.tasks.create(body);
    } else if (form.editScope === 'series') {
      // Series edit → applies to the template; a rule change regenerates the window.
      await api.tasks.update(editId!, { ...body, recurrence_rule: rule ?? null, is_habit: kind === 'habit' }, 'series');
    } else {
      await api.tasks.update(editId!, body);
    }
    refetchTasks(); refetchTags(); refetchPatterns();
    if (placeOnSave) refetchBlocks(); // the placed start-anchored block shows on the Planner
    return kind === 'habit' ? 'Habit saved' : 'Task saved';
  }

  if (kind === 'routine') {
    // AF-11: routines author NO tags — their directions/intentions derive from member
    // tasks server-side, so the old comma-joined `tag` is no longer sent.
    const routineType = (patternTypes() ?? []).find((t) => t.name === 'Routine');
    if (mode === 'add') {
      await api.patterns.create({
        type_id: routineType?.id ?? null,
        name: form.title.trim() || 'Routine',
        task_ids: [],
      });
    } else {
      await api.patterns.update(editId!, { name: form.title.trim() || 'Routine' });
    }
    refetchPatterns(); refetchTags();
    return 'Routine saved';
  }

  // timeblock
  const durMin = Math.max(form.durationMin ?? 60, 15);
  // AF-9: level-1 tag = the single primary; intention chips land at level 2
  // (deduped). Always send secondary_tags on edit so chip removals actually
  // clear level 2; on create only when non-empty.
  const { tag, secondary_tags } = timeblockTagPayload(form, categoryNames);
  const extra: Record<string, unknown> = {};
  if (mode === 'edit' || secondary_tags.length) extra.secondary_tags = secondary_tags;
  // An EDIT that cleared the direction must actively clear it server-side:
  // JSON.stringify drops `tag: undefined` and the server's partial-PATCH
  // semantics preserve an omitted `tag`, so send the documented clearing value
  // (null → empties level 1 + nulls the column). Create keeps omitting.
  const tagOut = tag !== undefined ? tag : mode === 'edit' ? null : undefined;
  // AF-CU2: category has the same JSON-drop hazard as `tag` — an omitted
  // category_id is PRESERVED by the server's partial PATCH, so an EDIT that
  // cleared the category must send the documented clearing value (null →
  // clears category_id + color_token). Create keeps omitting when empty.
  const categoryOut: Record<string, unknown> =
    form.categoryId ? { category_id: form.categoryId }
    : mode === 'edit' ? { category_id: null }
    : {};
  let body: Record<string, unknown>;
  if (form.someday) {
    const goal = form.goalDay || localISODate();
    const start = isoAtMidnight(goal);
    body = {
      title: form.title.trim() || 'Time Block', block_kind: 'timeblock', block_type: 'someday',
      tag: tagOut, goal_start_date: goal, duration_minutes: durMin, all_day: true,
      note: form.note || undefined, start_at: start,
      end_at: new Date(Date.parse(start) + durMin * 60_000).toISOString(),
      ...categoryOut,
      ...extra,
    };
  } else {
    const start = isoAt(form.day || localISODate(), form.start || nextHalfHour());
    body = {
      title: form.title.trim() || 'Time Block', block_kind: 'timeblock', block_type: 'scheduled',
      tag: tagOut, note: form.note || undefined, start_at: start,
      end_at: new Date(Date.parse(start) + durMin * 60_000).toISOString(),
      ...(form.recurrenceRule !== undefined ? { recurrence_rule: form.recurrenceRule } : {}),
      ...categoryOut,
      ...extra,
    };
  }
  let blockId: string;
  if (mode === 'add') blockId = (await api.blocks.create(body as any)).block.id;
  else { await api.blocks.update(editId!, body as any); blockId = editId!; }

  // Membership changes (scheduled blocks only) — applied after we hold the block id, so
  // this works identically for New (just-created) and Edit. Detach first, then add.
  if (!form.someday) {
    for (const cid of form.detachBlockIds ?? []) await api.blocks.update(cid, { parent_block_id: null });
    if (form.attachTaskIds?.length) await api.blocks.addTasks(blockId, form.attachTaskIds);
    for (const rid of form.attachRoutineIds ?? []) await api.patterns.placeToday(rid, { block_id: blockId, date: form.day || localISODate() });
  }

  refetchBlocks(); refetchConcepts(); refetchTags();
  if (form.attachTaskIds?.length || form.attachRoutineIds?.length) { refetchTasks(); refetchPatterns(); }
  return 'Time Block saved';
}
