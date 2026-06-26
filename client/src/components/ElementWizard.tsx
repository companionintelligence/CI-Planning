import { createSignal, createEffect, Show, For } from 'solid-js';
import { X, ChevronLeft, Plus, ListTodo, Flame, Boxes, Clock, Calendar } from 'lucide-solid';
import {
  elementModal, setElementModal, tags, blocks, concepts, tasks, categoryPrefs, showToast,
  type ElementKind,
} from '../stores/index.js';
import {
  ELEMENT_KINDS, patternTagList, patternDefaultMinutes, rankedSecondaryTags,
  nextHalfHour, saveElement, type ElementForm,
} from '../lib/element.js';
import { sortCategories, displayTag } from '../lib/tag-tax.js';
import { localISODate } from '../lib/dates.js';
import { buildRule, rulePreset, describeRule, WEEKDAYS, DAY_INITIAL, type RepeatPreset } from '../lib/recurrence.js';
import { api } from '../lib/api.js';

const TB_REPEAT: RepeatPreset[] = ['none', 'daily', 'weekly', 'custom'];
const TASK_REPEAT: RepeatPreset[] = ['none', 'daily', 'weekly', 'custom'];
const HABIT_REPEAT: RepeatPreset[] = ['daily', 'weekly', 'custom'];
const repeatLabel = (p: RepeatPreset) => (p === 'none' ? 'Once' : p[0].toUpperCase() + p.slice(1));

const KIND_ICON: Record<ElementKind, any> = { task: ListTodo, habit: Flame, routine: Boxes, timeblock: Clock };

/**
 * The unified Add/Edit Element wizard (Phase 1). Stage 0 is a four-button type
 * chooser (Add mode only, nothing preselected); Stage 1 is the per-kind form sharing
 * one flow: title → primary pattern tag → ranked secondary intention tags + a
 * new-tag input → date/type fields. Driven by the global `elementModal` signal.
 */
export function ElementWizard() {
  const m = elementModal;
  const open = () => m().open;
  const kind = () => m().kind;

  // ── Shared form state ──────────────────────────────────────────────────────
  const [title, setTitle] = createSignal('');
  const [primary, setPrimary] = createSignal('');
  const [intentions, setIntentions] = createSignal<string[]>([]);
  const [tagDraft, setTagDraft] = createSignal('');
  const [llm, setLlm] = createSignal<string[]>([]);
  // scheduling / type-specific
  const [day, setDay] = createSignal(localISODate());
  const [start, setStart] = createSignal(nextHalfHour());
  const [durMin, setDurMin] = createSignal(60);
  const [someday, setSomeday] = createSignal(false);
  const [goalDay, setGoalDay] = createSignal(localISODate());
  const [scheduledFor, setScheduledFor] = createSignal(localISODate());
  const [estimate, setEstimate] = createSignal(30);
  const [dueAt, setDueAt] = createSignal('');
  const [priority, setPriority] = createSignal(3);
  // task/habit recurrence + extras
  const [taskRepeat, setTaskRepeat] = createSignal<RepeatPreset>('none');
  const [taskWeekdays, setTaskWeekdays] = createSignal<string[]>([]);
  const [taskCustomRule, setTaskCustomRule] = createSignal('');
  const [taskTime, setTaskTime] = createSignal('');
  const [deferUntil, setDeferUntil] = createSignal('');
  const [dependsOn, setDependsOn] = createSignal<string[]>([]);
  const [editScope, setEditScope] = createSignal<'instance' | 'series'>('instance');
  const [wasRecurring, setWasRecurring] = createSignal(false);
  const [showMore, setShowMore] = createSignal(false);
  // time-block: note + recurrence + preserved secondary tags
  const [note, setNote] = createSignal('');
  const [tbRepeat, setTbRepeat] = createSignal<RepeatPreset>('none');
  const [tbWeekdays, setTbWeekdays] = createSignal<string[]>([]);
  const [tbCustomRule, setTbCustomRule] = createSignal('');
  const [secondaryTags, setSecondaryTags] = createSignal<string[]>([]);
  const [categoryId, setCategoryId] = createSignal('');
  const [depDraft, setDepDraft] = createSignal('');
  const [saving, setSaving] = createSignal(false);

  // Habit implies recurrence — default a freshly-chosen habit to daily.
  createEffect(() => { if (kind() === 'habit' && taskRepeat() === 'none') setTaskRepeat('daily'); });
  const currentTaskRule = () => buildRule(taskRepeat(), taskWeekdays(), taskCustomRule());
  const toggleWeekday = (d: string) => setTaskWeekdays((ws) => (ws.includes(d) ? ws.filter((x) => x !== d) : [...ws, d]));
  // T-TB-1: Time-Block weekly recurrence — its own weekday set, mirroring the task path.
  const currentTbRule = () => buildRule(tbRepeat(), tbWeekdays(), tbCustomRule());
  const toggleTbWeekday = (d: string) => setTbWeekdays((ws) => (ws.includes(d) ? ws.filter((x) => x !== d) : [...ws, d]));
  // Time Block Category picker (0069): single-select; picking one prefills the block length.
  const categoryOptions = () => sortCategories((tags() ?? []).filter((t) => t.kind === 'category'));
  function pickCategory(id: string) {
    setCategoryId(id);
    const p = id ? categoryPrefs()?.prefs?.[id] : undefined;
    if (p?.default_minutes) setDurMin(p.default_minutes);
  }
  const candidateTasks = () => (tasks() ?? []).filter((t) => t.status === 'open' && t.id !== m().editTarget?.id);

  // T-DEP-1: "Depends on" task search — typeahead over open tasks (excludes self +
  // anything already picked); selections render as removable chips.
  const taskById = (id: string) => (tasks() ?? []).find((t) => t.id === id);
  const depSuggestions = () => {
    const q = depDraft().trim().toLowerCase();
    if (!q) return [];
    const taken = new Set(dependsOn());
    return candidateTasks().filter((t) => !taken.has(t.id) && t.title.toLowerCase().includes(q)).slice(0, 6);
  };
  const addDep = (id: string) => { if (!dependsOn().includes(id)) setDependsOn([...dependsOn(), id]); setDepDraft(''); };
  const removeDep = (id: string) => setDependsOn(dependsOn().filter((x) => x !== id));

  function close() {
    setElementModal({ open: false, mode: 'add', kind: null });
  }

  // ── Seed on the closed→open edge (not on kind change, so shared fields persist
  //    when the user Backs out and re-picks a type). ───────────────────────────
  let wasOpen = false;
  createEffect(() => {
    const st = m();
    if (st.open && !wasOpen) {
      const pf = st.prefill ?? {};
      setTitle(''); setPrimary(''); setIntentions([]); setTagDraft(''); setLlm([]);
      setDay(pf.day || localISODate());
      setStart(pf.start || nextHalfHour());
      setDurMin(pf.durationMin ?? 60);
      setSomeday(false); setGoalDay(localISODate());
      setScheduledFor(localISODate()); setEstimate(30); setDueAt(''); setPriority(3);
      setTaskRepeat('none'); setTaskWeekdays([]); setTaskCustomRule(''); setTaskTime('');
      setDeferUntil(''); setDependsOn([]); setDepDraft(''); setEditScope('instance'); setWasRecurring(false); setShowMore(false);
      setNote(''); setTbRepeat('none'); setTbWeekdays([]); setTbCustomRule(''); setSecondaryTags([]); setCategoryId('');
      if (st.mode === 'edit' && st.editTarget) loadForEdit(st.editTarget.kind, st.editTarget.id);
    }
    wasOpen = st.open;
  });

  function loadForEdit(k: ElementKind, id: string) {
    if (k === 'timeblock') {
      const b = (blocks() ?? []).find((x) => x.id === id) ?? (concepts() ?? []).find((x) => x.id === id);
      if (!b) return;
      setTitle(b.title);
      const tagNames = (b.tag ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      seedTags(tagNames);
      setNote(b.note ?? '');
      setCategoryId(b.category_id ?? '');
      setSecondaryTags(b.secondary_tags ?? []);
      const ps = rulePreset(b.recurrence_rule);
      setTbRepeat(TB_REPEAT.includes(ps.preset) ? ps.preset : 'custom');
      setTbWeekdays(ps.weekdays);
      setTbCustomRule(b.recurrence_rule ?? '');
      if (b.block_type === 'someday') {
        setSomeday(true); setGoalDay(b.goal_start_date ?? localISODate());
        setDurMin(b.duration_minutes ?? 60);
      } else {
        const s = new Date(b.start_at);
        setDay(localISODate(s)); setStart(`${pad(s.getHours())}:${pad(s.getMinutes())}`);
        setDurMin(Math.max(Math.round((Date.parse(b.end_at) - Date.parse(b.start_at)) / 60000), 15));
      }
    } else if (k === 'task' || k === 'habit') {
      const t = (tasks() ?? []).find((x) => x.id === id);
      if (!t) return;
      setTitle(t.title);
      seedTags(t.tags ?? []);
      setNote(t.notes ?? '');
      setScheduledFor(t.scheduled_for ?? localISODate());
      setTaskTime(t.task_time ?? '');
      setEstimate(t.estimated_minutes ?? 30);
      setDueAt(t.due_at ? t.due_at.slice(0, 10) : '');
      setPriority(t.priority ?? 3);
      setDeferUntil(t.defer_until ? t.defer_until.slice(0, 10) : '');
      setDependsOn(t.depends_on ?? []);
      const ps = rulePreset(t.recurrence_rule);
      setTaskRepeat(ps.preset); setTaskWeekdays(ps.weekdays); setTaskCustomRule(ps.custom);
      setWasRecurring(!!(t.recurrence_rule || t.recurrence_parent_id));
      setEditScope('instance');
    }
  }
  // Split a saved tag list into primary (first pattern-kind tag) + intentions.
  function seedTags(names: string[]) {
    const patternNames = new Set(patternTagList().map((p) => p.name.toLowerCase()));
    const prim = names.find((n) => patternNames.has(n.toLowerCase()));
    setPrimary(prim ?? '');
    setIntentions(names.filter((n) => n !== prim));
  }

  // ── Tag interactions ────────────────────────────────────────────────────────
  function pickPrimary(name: string) {
    const next = primary().toLowerCase() === name.toLowerCase() ? '' : name;
    setPrimary(next);
    if (next) { setDurMin(patternDefaultMinutes(next)); setEstimate(patternDefaultMinutes(next)); }
  }
  function addIntention(name: string) {
    const n = name.replace(/^#/, '').trim();
    if (!n || n.toLowerCase() === primary().toLowerCase()) return;
    if (intentions().some((x) => x.toLowerCase() === n.toLowerCase())) return;
    setIntentions([...intentions(), n]);
    setTagDraft('');
  }
  const removeIntention = (name: string) => setIntentions(intentions().filter((x) => x !== name));

  const secondarySuggestions = () =>
    rankedSecondaryTags(title(), primary(), llm()).filter(
      (t) => !intentions().some((x) => x.toLowerCase() === t.name.toLowerCase()),
    );
  const tagSuggestions = () => {
    const q = tagDraft().trim().toLowerCase().replace(/^#/, '');
    if (!q) return [];
    const taken = new Set([primary().toLowerCase(), ...intentions().map((s) => s.toLowerCase())]);
    return (tags() ?? [])
      .filter((t) => t.kind === 'intention' && t.name.toLowerCase().includes(q) && !taken.has(t.name.toLowerCase()))
      .slice(0, 6);
  };

  // Debounced LLM tag refine — feeds the ranking; degrades to heuristic when down.
  let llmTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const t = title();
    clearTimeout(llmTimer);
    if (!t.trim() || !primary()) { setLlm([]); return; }
    llmTimer = setTimeout(async () => {
      try {
        const { tags: out } = await api.tasks.suggestTags(t);
        if (title() === t) setLlm(out);
      } catch { /* offline → heuristic only */ }
    }, 600);
  });

  async function doSave() {
    const k = kind();
    if (!k) return;
    setSaving(true);
    try {
      const form: ElementForm = {
        title: title(), primary: primary(), intentions: intentions(),
        note: note() || undefined,
        day: day(), start: start(), durationMin: durMin(), someday: someday(), goalDay: goalDay(),
        secondaryTags: secondaryTags().length ? secondaryTags() : undefined,
        categoryId: categoryId() || undefined,
        scheduledFor: scheduledFor(), taskTime: taskTime() || undefined, estimatedMinutes: estimate(),
        dueAt: dueAt() || undefined, priority: priority(),
        deferUntil: deferUntil() || undefined, dependsOn: dependsOn(),
        editScope: editScope(), parentId: m().parentId,
        recurrenceRule:
          (k === 'task' || k === 'habit') ? (currentTaskRule() || null)
          : (k === 'timeblock' && !someday()) ? (currentTbRule() || null)
          : undefined,
      };
      const msg = await saveElement(k, m().mode, form, m().editTarget?.id);
      showToast(msg, 'success');
      close();
    } catch (err) { showToast((err as Error).message, 'error'); }
    finally { setSaving(false); }
  }

  // ── Shared sub-views ──────────────────────────────────────────────────────
  const TagSection = () => (
    <>
      <div>
        <div class="text-[11px] text-muted-foreground mb-1">Pattern</div>
        <div class="flex flex-wrap gap-1.5">
          <For each={patternTagList()}>
            {(pt) => (
              <button type="button" onClick={() => pickPrimary(pt.name)}
                class="text-xs px-2 py-1 rounded-full border transition-colors capitalize"
                classList={{
                  'border-primary text-primary bg-primary/10': primary().toLowerCase() === pt.name.toLowerCase(),
                  'border-border text-muted-foreground hover:text-foreground': primary().toLowerCase() !== pt.name.toLowerCase(),
                }}>
                {pt.name}
              </button>
            )}
          </For>
          <Show when={patternTagList().length === 0}>
            <span class="text-xs text-muted-foreground">No pattern tags yet.</span>
          </Show>
        </div>
      </div>

      <Show when={primary()}>
        {/* Selected tags */}
        <div class="flex flex-wrap items-center gap-1.5 rounded-md border border-border p-2 min-h-[2.25rem]">
          <span class="text-xs px-2 py-0.5 rounded-full bg-primary/15 text-primary border border-primary/40 capitalize">{primary()}</span>
          <For each={intentions()}>
            {(name) => (
              <span class="text-xs px-2 py-0.5 rounded-full border border-border text-foreground inline-flex items-center gap-1">
                {name}
                <button type="button" onClick={() => removeIntention(name)} class="hover:text-destructive"><X size={11} /></button>
              </span>
            )}
          </For>
        </div>

        {/* Ranked "most likely" intention suggestions for this title + pattern */}
        <Show when={secondarySuggestions().length > 0}>
          <div>
            <div class="text-[11px] text-muted-foreground mb-1">Likely tags</div>
            <div class="flex flex-wrap gap-1.5">
              <For each={secondarySuggestions().slice(0, 6)}>
                {(t) => (
                  <button type="button" onClick={() => addIntention(t.name)}
                    class="text-xs px-2 py-1 rounded-full border border-border text-muted-foreground hover:text-foreground transition-colors inline-flex items-center gap-1">
                    <Plus size={11} /> {t.name}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        {/* Add a tag — autocomplete over existing intentions (no dupes) */}
        <div class="relative">
          <input class="input py-1 text-sm" placeholder="Add a tag…" value={tagDraft()}
            onInput={(e) => setTagDraft(e.currentTarget.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && tagDraft().trim()) { e.preventDefault(); addIntention(tagDraft()); } }} />
          <Show when={tagSuggestions().length > 0}>
            <div class="absolute z-50 left-0 right-0 mt-1 rounded-md border border-border bg-popover shadow-xl max-h-40 overflow-y-auto">
              <For each={tagSuggestions()}>
                {(t) => (
                  <button type="button" onClick={() => addIntention(t.name)}
                    class="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-sidebar-accent">
                    {t.name}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
    </>
  );

  return (
    <Show when={open()}>
      <div class="modal-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
        <div class="modal max-w-md">
          {/* Header */}
          <div class="flex items-center justify-between px-4 py-3 border-b border-border">
            <div class="flex items-center gap-2">
              <Show when={m().mode === 'add' && kind() !== null}>
                <button onClick={() => setElementModal({ ...m(), kind: null })} class="btn-icon" title="Back"><ChevronLeft size={16} /></button>
              </Show>
              <span class="text-sm font-semibold text-foreground">
                {kind() === null ? 'Add to calendar' : `${m().mode === 'edit' ? 'Edit' : 'New'} ${ELEMENT_KINDS.find((e) => e.kind === kind())?.label}`}
              </span>
            </div>
            <button onClick={close} class="btn-icon"><X size={16} /></button>
          </div>

          {/* Stage 0 — type chooser (nothing preselected) */}
          <Show when={kind() === null}>
            <div class="p-4 grid grid-cols-2 gap-3">
              <For each={ELEMENT_KINDS}>
                {(opt) => {
                  const Icon = KIND_ICON[opt.kind];
                  return (
                    <button type="button"
                      onClick={() => setElementModal({ ...m(), kind: opt.kind })}
                      class="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-border hover:border-primary hover:bg-primary/5 transition-colors p-4 text-center">
                      <Icon size={22} class="text-primary" />
                      <span class="text-sm font-medium text-foreground">{opt.label}</span>
                      <span class="text-[11px] text-muted-foreground">{opt.blurb}</span>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>

          {/* Stage 1 — per-kind form */}
          <Show when={kind() !== null}>
            <div class="p-4 flex flex-col gap-3 max-h-[70vh] overflow-y-auto">
              <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Title</span>
                <input autofocus class="input py-1.5 text-sm" placeholder="Title…" value={title()} onInput={(e) => setTitle(e.currentTarget.value)} /></label>

              <Show when={kind() !== 'timeblock'}><TagSection /></Show>

              {/* ── Time-Block fields ── */}
              <Show when={kind() === 'timeblock'}>
                {/* Category (0069) — replaces the direction picker for time blocks; direction is implied by the category. */}
                <div>
                  <div class="text-[11px] text-muted-foreground mb-1">Category</div>
                  <div class="flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => pickCategory('')}
                      class="text-xs px-2 py-1 rounded-full border transition-colors"
                      classList={{ 'border-primary text-primary bg-primary/10': !categoryId(), 'border-border text-muted-foreground hover:text-foreground': !!categoryId() }}>
                      None
                    </button>
                    <For each={categoryOptions()}>
                      {(c) => (
                        <button type="button" onClick={() => pickCategory(c.id)}
                          class="text-xs px-2 py-1 rounded-full border capitalize transition-colors"
                          classList={{ 'border-primary text-primary bg-primary/10': categoryId() === c.id, 'border-border text-muted-foreground hover:text-foreground': categoryId() !== c.id }}>
                          {displayTag(c.name)}
                        </button>
                      )}
                    </For>
                  </div>
                </div>
                <div class="flex gap-2">
                  <button type="button" onClick={() => setSomeday(false)} class="flex-1 py-1 rounded-md text-xs border transition-colors"
                    classList={{ 'border-primary text-primary bg-primary/10': !someday(), 'border-border text-muted-foreground': someday() }}>Scheduled</button>
                  <button type="button" onClick={() => setSomeday(true)} class="flex-1 py-1 rounded-md text-xs border transition-colors"
                    classList={{ 'border-primary text-primary bg-primary/10': someday(), 'border-border text-muted-foreground': !someday() }}>Someday</button>
                </div>
                <Show when={!someday()} fallback={
                  <div class="grid grid-cols-2 gap-2">
                    <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Goal day</span>
                      <input type="date" class="input py-1 text-sm" value={goalDay()} onInput={(e) => setGoalDay(e.currentTarget.value)} /></label>
                    <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Duration (min)</span>
                      <input type="number" min="5" step="5" class="input py-1 text-sm" value={durMin()} onInput={(e) => setDurMin(Number(e.currentTarget.value) || 0)} /></label>
                  </div>
                }>
                  <div class="grid grid-cols-3 gap-2">
                    <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Day</span>
                      <input type="date" class="input py-1 text-sm" value={day()} onInput={(e) => setDay(e.currentTarget.value)} /></label>
                    <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Start</span>
                      <input type="time" class="input py-1 text-sm" value={start()} onInput={(e) => setStart(e.currentTarget.value)} /></label>
                    <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Min</span>
                      <input type="number" min="5" step="5" class="input py-1 text-sm" value={durMin()} onInput={(e) => setDurMin(Number(e.currentTarget.value) || 0)} /></label>
                  </div>
                </Show>
                <Show when={!someday()}>
                  <div class="flex items-center gap-1.5">
                    <span class="text-[11px] text-muted-foreground w-12">Repeat</span>
                    <For each={TB_REPEAT}>
                      {(opt) => (
                        <button type="button" onClick={() => setTbRepeat(opt)}
                          class="flex-1 py-1 rounded-md text-xs border capitalize transition-colors"
                          classList={{ 'border-primary text-primary bg-primary/10': tbRepeat() === opt, 'border-border text-muted-foreground hover:text-foreground': tbRepeat() !== opt }}>
                          {opt === 'none' ? 'Once' : opt}
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={tbRepeat() === 'weekly'}>
                    <div class="flex gap-1 mt-1.5">
                      <For each={WEEKDAYS}>
                        {(d) => (
                          <button type="button" onClick={() => toggleTbWeekday(d)} title={d}
                            class="flex-1 h-7 rounded-md text-xs font-semibold border transition-colors"
                            classList={{ 'border-primary text-primary bg-primary/10': tbWeekdays().includes(d), 'border-border text-muted-foreground hover:text-foreground': !tbWeekdays().includes(d) }}>
                            {DAY_INITIAL[d]}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={tbRepeat() === 'custom'}>
                    <input class="input py-1 text-sm font-mono" placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR" value={tbCustomRule()} onInput={(e) => setTbCustomRule(e.currentTarget.value)} />
                  </Show>
                  <Show when={currentTbRule()}>
                    <span class="text-[11px] text-muted-foreground">{describeRule(currentTbRule()!)}</span>
                  </Show>
                </Show>
                <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Note</span>
                  <textarea class="textarea text-sm" rows="2" value={note()} onInput={(e) => setNote(e.currentTarget.value)} /></label>
              </Show>

              {/* ── Task / Habit fields ── */}
              <Show when={kind() === 'task' || kind() === 'habit'}>
                {/* Priority (+ Someday for tasks) */}
                <div class="flex items-center gap-1.5">
                  <span class="text-[11px] text-muted-foreground w-12">Priority</span>
                  <For each={[1, 2, 3]}>
                    {(p) => (
                      <button type="button" onClick={() => { setPriority(p); setSomeday(false); }}
                        class="flex-1 py-1 rounded-md text-xs border transition-colors"
                        classList={{ 'border-primary text-primary bg-primary/10': !someday() && priority() === p, 'border-border text-muted-foreground hover:text-foreground': someday() || priority() !== p }}>
                        P{p}
                      </button>
                    )}
                  </For>
                  <Show when={kind() === 'task'}>
                    <button type="button" onClick={() => setSomeday(true)}
                      class="flex-1 py-1 rounded-md text-xs border transition-colors"
                      classList={{ 'border-primary text-primary bg-primary/10': someday(), 'border-border text-muted-foreground hover:text-foreground': !someday() }}>
                      Someday
                    </button>
                  </Show>
                </div>

                {/* Scheduling (hidden for Someday capture) */}
                <Show when={!someday()}>
                  <label class="flex items-center gap-1.5">
                    <span class="text-[11px] text-muted-foreground w-12 shrink-0">Start</span>
                    <div class="relative flex-1">
                      <Calendar size={13} class="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
                      <input
                        type="date"
                        class="input py-1 text-sm pl-8"
                        value={scheduledFor()}
                        onInput={(e) => setScheduledFor(e.currentTarget.value)}
                      />
                    </div>
                  </label>
                  <div class="grid grid-cols-3 gap-2">
                    <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Time</span>
                      <input type="time" class="input py-1 text-sm" value={taskTime()} onInput={(e) => setTaskTime(e.currentTarget.value)} /></label>
                    <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Min</span>
                      <input type="number" min="5" step="5" class="input py-1 text-sm" value={estimate()} onInput={(e) => setEstimate(Number(e.currentTarget.value) || 0)} /></label>
                    <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Due</span>
                      <input type="date" class="input py-1 text-sm" value={dueAt()} onInput={(e) => setDueAt(e.currentTarget.value)} /></label>
                  </div>
                </Show>

                {/* Repeat */}
                <div>
                  <div class="text-[11px] text-muted-foreground mb-1">Repeat</div>
                  <div class="flex gap-1.5">
                    <For each={kind() === 'habit' ? HABIT_REPEAT : TASK_REPEAT}>
                      {(opt) => (
                        <button type="button" onClick={() => setTaskRepeat(opt)}
                          class="flex-1 py-1 rounded-md text-xs border transition-colors"
                          classList={{ 'border-primary text-primary bg-primary/10': taskRepeat() === opt, 'border-border text-muted-foreground hover:text-foreground': taskRepeat() !== opt }}>
                          {repeatLabel(opt)}
                        </button>
                      )}
                    </For>
                  </div>
                  <Show when={taskRepeat() === 'weekly'}>
                    <div class="flex gap-1 mt-1.5">
                      <For each={WEEKDAYS}>
                        {(d) => (
                          <button type="button" onClick={() => toggleWeekday(d)} title={d}
                            class="flex-1 h-7 rounded-md text-xs font-semibold border transition-colors"
                            classList={{ 'border-primary text-primary bg-primary/10': taskWeekdays().includes(d), 'border-border text-muted-foreground hover:text-foreground': !taskWeekdays().includes(d) }}>
                            {DAY_INITIAL[d]}
                          </button>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={taskRepeat() === 'custom'}>
                    <input class="input py-1 text-sm font-mono mt-1.5" placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR" value={taskCustomRule()} onInput={(e) => setTaskCustomRule(e.currentTarget.value)} />
                  </Show>
                  <Show when={currentTaskRule()}>
                    <span class="text-[11px] text-muted-foreground">{describeRule(currentTaskRule()!)}</span>
                  </Show>
                </div>

                {/* Notes */}
                <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Notes</span>
                  <textarea class="textarea text-sm" rows="2" value={note()} onInput={(e) => setNote(e.currentTarget.value)} /></label>

                {/* Edit scope — recurring task edits */}
                <Show when={m().mode === 'edit' && wasRecurring()}>
                  <div class="flex items-center gap-1.5">
                    <span class="text-[11px] text-muted-foreground w-12">Apply</span>
                    <For each={['instance', 'series'] as const}>
                      {(s) => (
                        <button type="button" onClick={() => setEditScope(s)}
                          class="flex-1 py-1 rounded-md text-xs border transition-colors"
                          classList={{ 'border-primary text-primary bg-primary/10': editScope() === s, 'border-border text-muted-foreground hover:text-foreground': editScope() !== s }}>
                          {s === 'instance' ? 'This task' : 'This & future'}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>

                {/* More: defer + dependencies */}
                <Show when={showMore()} fallback={
                  <button type="button" onClick={() => setShowMore(true)} class="text-xs text-muted-foreground hover:text-foreground self-start">+ More options</button>
                }>
                  <label class="flex flex-col gap-1"><span class="text-[11px] text-muted-foreground">Defer until</span>
                    <input type="date" class="input py-1 text-sm" value={deferUntil()} onInput={(e) => setDeferUntil(e.currentTarget.value)} /></label>
                  <div class="flex flex-col gap-1.5">
                    <span class="text-[11px] text-muted-foreground">Depends on (won't schedule until done)</span>
                    <Show when={dependsOn().length > 0}>
                      <div class="flex flex-wrap gap-1.5">
                        <For each={dependsOn()}>
                          {(id) => (
                            <span class="text-xs px-2 py-0.5 rounded-full border border-border text-foreground inline-flex items-center gap-1 max-w-full">
                              <span class="truncate">{taskById(id)?.title ?? id}</span>
                              <button type="button" onClick={() => removeDep(id)} class="hover:text-destructive flex-shrink-0"><X size={11} /></button>
                            </span>
                          )}
                        </For>
                      </div>
                    </Show>
                    <div class="relative">
                      <input class="input py-1 text-sm" placeholder="Search tasks to depend on…" value={depDraft()}
                        onInput={(e) => setDepDraft(e.currentTarget.value)} />
                      <Show when={depSuggestions().length > 0}>
                        <div class="absolute z-50 left-0 right-0 mt-1 rounded-md border border-border bg-popover shadow-xl max-h-40 overflow-y-auto">
                          <For each={depSuggestions()}>
                            {(t) => (
                              <button type="button" onClick={() => addDep(t.id)}
                                class="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-sidebar-accent truncate">
                                {t.title}
                              </button>
                            )}
                          </For>
                        </div>
                      </Show>
                    </div>
                  </div>
                </Show>
              </Show>

              {/* ── Routine (shell) ── */}
              <Show when={kind() === 'routine'}>
                <p class="text-[11px] text-muted-foreground">Creates a named, tagged Routine. Add member tasks &amp; habits on the <span class="text-primary">Routines</span> page or by multi-selecting tasks.</p>
              </Show>

              <div class="flex justify-end gap-2 pt-1">
                <button type="button" onClick={close} class="btn-ghost text-sm px-3 py-1.5">Cancel</button>
                <button type="button" onClick={doSave} disabled={saving() || !title().trim()} class="btn-primary text-sm px-4 py-1.5">
                  {saving() ? 'Saving…' : m().mode === 'edit' ? 'Save' : 'Add'}
                </button>
              </div>
            </div>
          </Show>
        </div>
      </div>
    </Show>
  );
}

const pad = (n: number) => String(n).padStart(2, '0');
