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
export const patternTagList = (): Tag[] => (tags() ?? []).filter((t) => t.kind === 'pattern');

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
  secondaryTags?: string[];        // preserved on time-block edit (not authored here)
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
  const patternNames = new Set(all.filter((t) => t.kind === 'pattern').map((t) => t.name.toLowerCase()));
  for (const n of names) {
    const key = n.toLowerCase();
    if (!known.has(key) && !patternNames.has(key)) {
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
  const tagList = [form.primary, ...form.intentions].filter(Boolean);
  await ensureIntentionTags(form.primary, form.intentions);

  if (kind === 'task' || kind === 'habit') {
    const sd = !!form.someday;
    const rule = form.recurrenceRule || undefined;  // built by the wizard (preset+weekdays+custom)
    const body: TaskInput = {
      title: form.title.trim() || 'Untitled',
      tags: tagList,
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
    return kind === 'habit' ? 'Habit saved' : 'Task saved';
  }

  if (kind === 'routine') {
    const routineType = (patternTypes() ?? []).find((t) => t.name === 'Routine');
    if (mode === 'add') {
      await api.patterns.create({
        type_id: routineType?.id ?? null,
        name: form.title.trim() || 'Routine',
        tag: tagList.join(',') || null,
        task_ids: [],
      });
    } else {
      await api.patterns.update(editId!, { name: form.title.trim() || 'Routine', tag: tagList.join(',') || null });
    }
    refetchPatterns(); refetchTags();
    return 'Routine saved';
  }

  // timeblock
  const durMin = Math.max(form.durationMin ?? 60, 15);
  // Preserve secondary_tags (not authored in the wizard) and carry the recurrence
  // rule (null clears) when present — so edits don't drop either.
  const extra: Record<string, unknown> = {};
  if (form.secondaryTags) extra.secondary_tags = form.secondaryTags;
  let body: Record<string, unknown>;
  if (form.someday) {
    const goal = form.goalDay || localISODate();
    const start = isoAtMidnight(goal);
    body = {
      title: form.title.trim() || 'Time Block', block_kind: 'timeblock', block_type: 'someday',
      tag: tagList.join(',') || undefined, goal_start_date: goal, duration_minutes: durMin, all_day: true,
      note: form.note || undefined, start_at: start,
      end_at: new Date(Date.parse(start) + durMin * 60_000).toISOString(),
      ...extra,
    };
  } else {
    const start = isoAt(form.day || localISODate(), form.start || nextHalfHour());
    body = {
      title: form.title.trim() || 'Time Block', block_kind: 'timeblock', block_type: 'scheduled',
      tag: tagList.join(',') || undefined, note: form.note || undefined, start_at: start,
      end_at: new Date(Date.parse(start) + durMin * 60_000).toISOString(),
      ...(form.recurrenceRule !== undefined ? { recurrence_rule: form.recurrenceRule } : {}),
      ...extra,
    };
  }
  if (mode === 'add') await api.blocks.create(body as any);
  else await api.blocks.update(editId!, body as any);
  refetchBlocks(); refetchConcepts(); refetchTags();
  return 'Time Block saved';
}
