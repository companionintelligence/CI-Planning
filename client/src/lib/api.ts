const BASE = '/api';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error((err as any).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

// ── Tasks ────────────────────────────────────────────────────────────────────
export interface Task {
  id: string;
  title: string;
  description?: string;
  notes?: string;
  due_at?: string;
  scheduled_for?: string;
  defer_until?: string;
  task_time?: string;
  estimated_minutes?: number;
  priority: number;
  status: string;
  parent_id?: string;
  owner_id: string;
  source_kind: string;
  created_at: string;
  completed_at?: string;
  tags: string[];                 // primary tags (entity_tags level 1) — incl. the home/work/community direction
  secondary_tags?: string[];      // Phase 5: secondary tags (entity_tags level>1)
  depends_on?: string[];
  blocked?: boolean;
  // Recurrence (Phase E): a template has recurrence_rule set + no parent; an
  // instance has recurrence_parent_id + occurrence_date. is_habit propagates.
  recurrence_rule?: string;
  recurrence_parent_id?: string;
  occurrence_date?: string;
  is_habit?: boolean;
  is_fast_task?: boolean; // ritual-local, hidden from the task list (Step 3)
  subtype?: 'standard' | 'habit' | 'quick'; // CON-2c canonical Task subtype (is_habit/is_fast_task kept as aliases)
  objective_id?: string | null; // §I: first linked objective — drives the 8-pointed star + its click target
}

export interface TaskInput {
  title: string;
  description?: string;
  notes?: string;
  due_at?: string;
  scheduled_for?: string;
  defer_until?: string;
  task_time?: string;
  estimated_minutes?: number;
  priority?: number;
  parent_id?: string;
  owner_id?: string;
  tags?: string[];
  secondary_tags?: string[];
  depends_on?: string[];
  recurrence_rule?: string | null;
  is_habit?: boolean;
}

export interface Streak {
  templateId: string;
  current: number;
  recent: { date: string; status: string }[];
}

export interface ParsedQuick {
  title: string;
  dueAt?: string;
  scheduledFor?: string;
  taskTime?: string;
  tags: string[];
  estimatedMinutes?: number;
  priority?: number;
}

export const api = {
  tasks: {
    list: (params?: Record<string, string>) => {
      const q = params && Object.keys(params).filter(k => params[k]).length
        ? '?' + new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([,v]) => v))).toString()
        : '';
      return request<{ tasks: Task[] }>('GET', `/tasks${q}`);
    },
    create: (body: TaskInput) => request<{ task: Task }>('POST', '/tasks', body),
    quick: (text: string) => request<{ task: Task; parsed: ParsedQuick; llm: boolean }>('POST', '/tasks/quick', { text }),
    // Best-effort LLM auto-tag for the wizard, constrained to existing tags ([] if Ollama down).
    suggestTags: (title: string) => request<{ tags: string[] }>('POST', '/tasks/suggest-tags', { title }),
    update: (
      id: string,
      body: Partial<TaskInput & { status: string; completed: boolean; completed_at?: string | null }>,
      scope?: 'instance' | 'series',
    ) => request<{ task: Task }>('PATCH', `/tasks/${id}${scope === 'series' ? '?scope=series' : ''}`, body),
    delete: (id: string) => request<{ task: Task }>('DELETE', `/tasks/${id}`),
    subtasks: (id: string) => request<{ subtasks: Task[] }>('GET', `/tasks/${id}/subtasks`),
    skip: (id: string) => request<{ task: Task; skipped: string }>('POST', `/tasks/${id}/skip`, {}),
    streak: (id: string) => request<Streak>('GET', `/tasks/${id}/streak`),
    // Make a (possibly ritual-local) task a habit — flags it + ensures its Habit pattern.
    promoteHabit: (id: string) => request<{ task: Task }>('POST', `/tasks/${id}/promote-habit`, {}),
    // Reschedule a missed/planned task `days` out from today (the +1/+3/+7 buttons).
    reschedule: (id: string, days: number) =>
      request<{ task: Task; scheduled_for: string }>('POST', `/tasks/${id}/reschedule`, { days }),
    // Clone a (shelved/Past) task to a brand-new task — cockpit-v2 Phase 6.
    recall: (id: string) => request<{ task: Task }>('POST', `/tasks/${id}/recall`, {}),
  },

  blocks: {
    list: (from?: string, to?: string) => {
      const q = new URLSearchParams();
      if (from) q.set('from', from);
      if (to)   q.set('to', to);
      return request<{ blocks: Block[] }>('GET', `/blocks?${q}`);
    },
    create: (body: Partial<Block> & { title: string; start_at: string; end_at: string }) =>
      request<{ block: Block }>('POST', '/blocks', body),
    update: (id: string, body: Partial<Block>) => request<{ block: Block }>('PATCH', `/blocks/${id}`, body),
    // Attach existing tasks to a Time-Block container: scatters them into its free time
    // as child task blocks (parent_block_id set). Used by the New/Edit Time-Block modal.
    addTasks: (id: string, task_ids: string[]) =>
      request<{ ok: boolean; blocksCreated: number; placed: number; unplaced: number; skipped: number }>('POST', `/blocks/${id}/add-tasks`, { task_ids }),
    // children:'delete' also removes a Plan's member task blocks; default keeps them (FK SET NULL).
    delete: (id: string, opts?: { children?: 'delete' }) =>
      request<{ ok: boolean }>('DELETE', `/blocks/${id}${opts?.children === 'delete' ? '?children=delete' : ''}`),
    // Shift a Plan + all its members by one minute delta, atomically (PR-C). `id` may
    // be the Plan or any member; returns the whole moved group.
    moveGroup: (id: string, delta_minutes: number) =>
      request<{ blocks: Block[] }>('POST', `/blocks/${id}/move-group`, { delta_minutes }),
    // Someday Time Blocks have no real time — fetch them all (owner-scoped) for the horizon lane.
    listConcepts: () => request<{ blocks: Block[] }>('GET', '/blocks?state=someday'),
    // Promote a Concept into a scheduled Plan at the chosen start (end ⇐ duration).
    promote: (id: string, start_at: string, opts?: { end_at?: string; all_day?: boolean }) =>
      request<{ block: Block }>('POST', `/blocks/${id}/promote`, { start_at, ...opts }),
    // Clear ONLY auto-placed task blocks for a local day (T-CORE-4). Preserves
    // user-placed, locked, calendar meetings, and habit/pattern placements.
    clearDay: (date: string) =>
      request<{ ok: boolean; cleared: number }>('POST', `/days/${date}/clear`, {}),
  },

  // ── Patterns (Phase G, G1) — typed, reusable task collections ────────────────
  patterns: {
    list: () => request<{ patterns: Pattern[] }>('GET', '/patterns'),
    get: (id: string) => request<{ pattern: Pattern }>('GET', `/patterns/${id}`),
    create: (body: PatternInput) => request<{ pattern: Pattern }>('POST', '/patterns', body),
    update: (id: string, body: Partial<PatternInput>) =>
      request<{ pattern: Pattern }>('PATCH', `/patterns/${id}`, body),
    delete: (id: string) => request<{ ok: boolean }>('DELETE', `/patterns/${id}`),
    addTask: (id: string, task_id: string, position?: number) =>
      request<{ pattern_id: string; task_ids: string[] }>('POST', `/patterns/${id}/tasks`, { task_id, position }),
    removeTask: (id: string, taskId: string) =>
      request<{ pattern_id: string; task_ids: string[] }>('DELETE', `/patterns/${id}/tasks/${taskId}`),
    // Fast tasks — ritual-local, hidden from the task list (Step 3).
    addFastTask: (id: string, body: { title: string; estimated_minutes?: number }) =>
      request<{ task: Task }>('POST', `/patterns/${id}/fast-tasks`, body),
    removeFastTask: (id: string, taskId: string) =>
      request<{ ok: boolean }>('DELETE', `/patterns/${id}/fast-tasks/${taskId}`),
    // Auto-place the pattern's tasks into today's free gaps (PR-C+, Phase C) —
    // replaces the old "stage into flight-plan" flow. `block_id` scopes to a Plan.
    placeToday: (id: string, body?: { date?: string; block_id?: string | null }) =>
      request<{ result: PlacePatternResult; blocks: Block[] }>('POST', `/patterns/${id}/place-today`, body ?? {}),
    // Three Routine-promotion endpoints (Phase E + F): same backend write path,
    // different sources (a placed Plan's members; a saved template's tasks; a
    // multi-selection of task ids).
    promoteFromPlan: (plan_block_id: string, name?: string) =>
      request<{ pattern: Pattern }>('POST', '/patterns/promote-from-plan', { plan_block_id, name }),
    promoteFromPlanTemplate: (template_id: string, name?: string) =>
      request<{ pattern: Pattern }>('POST', '/patterns/promote-from-plan-template', { template_id, name }),
    promoteFromTasks: (task_ids: string[], name?: string) =>
      request<{ pattern: Pattern }>('POST', '/patterns/promote-from-tasks', { task_ids, name }),
  },

  patternTypes: {
    list: () => request<{ pattern_types: PatternType[] }>('GET', '/pattern-types'),
    create: (body: PatternTypeInput) =>
      request<{ pattern_type: PatternType }>('POST', '/pattern-types', body),
    update: (id: string, body: Partial<PatternTypeInput>) =>
      request<{ pattern_type: PatternType }>('PATCH', `/pattern-types/${id}`, body),
    delete: (id: string) => request<{ ok: boolean }>('DELETE', `/pattern-types/${id}`),
  },

  // ── Flight-plan + two-step Auto (Phase G, G4) ────────────────────────────────
  flightPlan: {
    list: () => request<{ flight_plan: FlightPlanItem[] }>('GET', '/flight-plan'),
    addTask: (task_id: string) =>
      request<{ flight_plan: FlightPlanItem[]; added: number }>('POST', '/flight-plan', { task_id }),
    addPattern: (pattern_id: string) =>
      request<{ flight_plan: FlightPlanItem[]; added: number }>('POST', '/flight-plan', { pattern_id }),
    update: (taskId: string, body: { selected?: boolean; position?: number }) =>
      request<{ flight_plan: FlightPlanItem[] }>('PATCH', `/flight-plan/${taskId}`, body),
    remove: (taskId: string) =>
      request<{ flight_plan: FlightPlanItem[] }>('DELETE', `/flight-plan/${taskId}`),
    reset: () => request<{ ok: boolean; cleared: number }>('POST', '/flight-plan/reset', {}),
  },

  // Explicit two-path Auto: fill proposes candidates; run places them + workday fill.
  auto: {
    // Fill Flight Plan: propose open-task candidates into the staging area. Never places.
    fill: (body?: { date?: string }) =>
      request<{ result: AutoResult; flight_plan: FlightPlanItem[] }>('POST', '/auto/fill', body ?? {}),
    // Auto Schedule: place selected staged items (Plans → direction windows → workday fill).
    // horizon_days (T-SCHED-2): explicitly place across N days; omit to let the server
    // apply the Schedule-mode horizon (planning_horizon_days) in Schedule mode.
    run: (body?: { block_id?: string; date?: string; horizon_days?: number }) =>
      request<{ result: AutoResult; flight_plan: FlightPlanItem[] }>('POST', '/auto/run', body ?? {}),
    // Undo the last placement run (D2): delete its blocks, re-stage its tasks.
    undo: () =>
      request<{ result: { removed: number; restaged: number }; flight_plan: FlightPlanItem[] }>('POST', '/auto/undo', {}),
  },

  // Phase M B4 — escalation accept/dismiss. reauthor forces an AI re-author of the day
  // (the only reactive LLM path); dismiss drops the outstanding nudge.
  plan: {
    // The outstanding nudge (or null) — the ReplanBanner hydrates from this on mount
    // so a reload re-surfaces a still-open suggestion.
    suggestion: () => request<{ suggestion: ReplanSuggestion | null }>('GET', '/plan/suggestion'),
    reauthor: (date: string) => request<{ ok: boolean; date: string }>('POST', '/plan/reauthor', { date }),
    dismiss: (date: string) => request<{ ok: boolean }>('POST', '/plan/reauthor/dismiss', { date }),
    // §A4 (pins-first): parse a natural-language instruction → pinned blocks + surfaced hints.
    instruct: (text: string, date?: string) => request<InstructResponse>('POST', '/plan/instruct', { text, date }),
  },

  blockTemplates: {
    list: () => request<{ block_templates: BlockTemplate[] }>('GET', '/block-templates'),
    create: (body: { name: string; tag?: string; default_minutes?: number; tasks?: TemplateTask[] }) =>
      request<{ block_template: BlockTemplate }>('POST', '/block-templates', body),
    update: (id: string, body: { name?: string; tag?: string | null; default_minutes?: number }) =>
      request<{ block_template: BlockTemplate }>('PATCH', `/block-templates/${id}`, body),
    delete: (id: string) => request<{ ok: boolean }>('DELETE', `/block-templates/${id}`),
    instantiate: (id: string, start_at: string, end_at?: string) =>
      request<{ block: Block }>('POST', `/block-templates/${id}/instantiate`, { start_at, end_at }),
    applyToBlock: (id: string, block_id: string) =>
      request<{ ok: boolean }>('POST', `/block-templates/${id}/apply-to-block`, { block_id }),
  },

  possibles: {
    list: (status = 'pending') =>
      request<{ possibles: Possible[] }>('GET', `/possible-tasks?status=${status}`),
    promote: (id: string, overrides?: Partial<Task>) =>
      request<{ task: Task }>('POST', `/possible-tasks/${id}/promote`, overrides ?? {}),
    dismiss: (id: string) =>
      request<{ ok: boolean }>('POST', `/possible-tasks/${id}/dismiss`, {}),
  },

  tags: {
    list: () => request<{ tags: Tag[] }>('GET', '/tags'),
    create: (name: string, opts?: { kind?: 'pattern' | 'intention' | 'category'; directions?: string[]; categories?: string[] }) =>
      request<{ tag: Tag }>('POST', '/tags', { name, ...opts }),
    // PATCH: directions/categories REPLACE membership (drag-move = single target);
    // direction_toggle flips one category↔direction scope; name renames; muted toggles.
    update: (
      id: string,
      body: {
        directions?: string[];
        categories?: string[];
        direction_toggle?: { patternTagId: string; enabled: boolean };
        name?: string;
        muted?: boolean;
      },
    ) => request<{ tag: Tag }>('PATCH', `/tags/${id}`, body),
    remove: (id: string) => request<{ ok: boolean }>('DELETE', `/tags/${id}`),
  },

  prefs: {
    get: () => request<{ prefs: Prefs }>('GET', '/prefs'),
    update: (body: Partial<Prefs>) => request<{ prefs: Prefs }>('PATCH', '/prefs', body),
  },

  // ── Notifications + Web Push (Phase H) ───────────────────────────────────────
  push: {
    vapidKey: () => request<{ key: string }>('GET', '/push/vapid-key'),
    subscribe: (subscription: PushSubscriptionJSON) => request<{ ok: boolean }>('POST', '/push/subscribe', { subscription }),
    unsubscribe: (endpoint: string) => request<{ ok: boolean }>('DELETE', '/push/subscribe', { endpoint }),
  },
  reminders: {
    list: () => request<{ reminders: Reminder[] }>('GET', '/reminders'),
    create: (body: ReminderInput) => request<{ reminder: Reminder }>('POST', '/reminders', body),
    remove: (id: string) => request<{ ok: boolean }>('DELETE', `/reminders/${id}`),
    snooze: (id: string, minutes: number) => request<{ reminder: Reminder }>('POST', `/reminders/${id}/snooze`, { minutes }),
  },

  memory: {
    status: () => request<MemoryStatus>('GET', '/memory/status'),
    sync: () => request<{ ok: boolean; syncedAt?: string }>('POST', '/memory/sync', {}),
  },

  jobs: {
    list: () => request<{ jobs: Job[] }>('GET', '/jobs'),
    run: (id: string) => request<{ ok: boolean; message: string }>('POST', `/jobs/${id}/run`, {}),
  },

  schedule: { run: (date?: string) => request<unknown>('POST', '/schedule/run', { date }) },

  summary: {
    get: (date?: string) => {
      const q = date ? `?date=${date}` : '';
      return request<DaySummary>('GET', `/summary${q}`);
    },
    refresh: (date: string) => request<DaySummary>('GET', `/summary?date=${date}&refresh=1`),
  },

  review: {
    week: (anchor?: string) => {
      const q = anchor ? `?anchor=${anchor}` : '';
      return request<WeekReview>('GET', `/review/week${q}`);
    },
    calibration: () => request<Calibration>('GET', '/calibration'),
  },

  llm: {
    status: () => request<LLMStatus>('GET', '/llm/status'),
    integrations: () => request<Integrations>('GET', '/integrations'),
  },

  patternBlocks: {
    list: () => request<{ workday: PatternWindows; weekend: PatternWindows }>('GET', '/pattern-blocks'),
    forDay: (dayType: string) => request<{ windows: PatternWindows }>('GET', `/pattern-blocks/${dayType}`),
    set:  (dirTagId: string, dayType: string, ranges: Omit<PatternRange, 'id'>[]) =>
            request<{ ranges: PatternRange[] }>('PUT', `/pattern-blocks/${dirTagId}/${dayType}`, { ranges }),
  },

  // Day types (T-SCHED-3): the catalog, the weekly default map (dow→key), and
  // per-date overrides. resolveDayType picks which pattern_blocks windows Auto uses.
  dayTypes: {
    list: () => request<{ day_types: DayType[] }>('GET', '/day-types'),
    resolve: (date: string) => request<{ date: string; key: string; source: 'assignment' | 'map' | 'default' }>('GET', `/day-types/resolve/${date}`),
    create: (key: string, name: string) => request<{ day_type: DayType }>('POST', '/day-types', { key, name }),
    rename: (id: string, name: string) => request<{ day_type: DayType }>('PATCH', `/day-types/${id}`, { name }),
    remove: (id: string) => request<{ ok: boolean }>('DELETE', `/day-types/${id}`),
    weekMap: () => request<{ map: Record<number, string> }>('GET', '/day-types/week-map'),
    setWeekMap: (map: Record<number, string>) => request<{ map: Record<number, string> }>('PUT', '/day-types/week-map', { map }),
    assignments: () => request<{ assignments: Record<string, string> }>('GET', '/day-types/assignments'),
    assign: (date: string, dayTypeKey: string) =>
      request<{ date: string; day_type_key: string }>('PUT', `/day-types/assignments/${date}`, { day_type_key: dayTypeKey }),
    clearAssignment: (date: string) => request<{ ok: boolean }>('DELETE', `/day-types/assignments/${date}`),
  },

  patternPrefs: {
    list: (): Promise<PatternPrefsResponse> =>
      request<PatternPrefsResponse>('GET', '/pattern-prefs'),
    set: (patternTagId: string, patch: Partial<PatternPref>): Promise<{ pref: PatternPref }> =>
      request<{ pref: PatternPref }>('PUT', `/pattern-prefs/${patternTagId}`, patch),
  },

  categoryPrefs: {
    list: (): Promise<CategoryPrefsResponse> =>
      request<CategoryPrefsResponse>('GET', '/category-prefs'),
    set: (categoryTagId: string, patch: Partial<CategoryPref>): Promise<{ pref: CategoryPref }> =>
      request<{ pref: CategoryPref }>('PUT', `/category-prefs/${categoryTagId}`, patch),
  },

  backup: {
    import: (json: unknown) =>
      request<{ imported: Record<string, number> }>('POST', '/import', json),
  },

  // ── Phase L: field-level sync batch endpoint ────────────────────────────────
  sync: {
    apply: (ops: SyncOp[]) =>
      request<(SyncResult | SyncError)[]>('POST', '/sync', { ops }),
  },

  // ── Phase N0: daily + weekly goals (reflections table) ───────────────────────
  reflections: {
    get: (period: string) =>
      request<ReflectionsResponse>('GET', `/reflections?period=${encodeURIComponent(period)}`),
    setToday: (body: ReflectionWrite & { period_key: string }) =>
      request<{ ok: boolean }>('PUT', '/reflections/today', body),
    setWeekly: (position: 0 | 1 | 2, body: ReflectionWrite & { period_key: string }) =>
      request<{ ok: boolean }>('PUT', `/reflections/weekly/${position}`, body),
    setDone: (kind: 'today_goal' | 'weekly_goal', position: number, period_key: string, done: boolean) =>
      request<{ ok: boolean }>('POST', `/reflections/${kind}/${position}/done`, { period_key, done }),
    delete: (kind: 'today_goal' | 'weekly_goal', position: number, period_key: string) =>
      request<{ ok: boolean }>('DELETE', `/reflections/${kind}/${position}?period_key=${encodeURIComponent(period_key)}`),
  },

  // ── Phase N1: objectives ──────────────────────────────────────────────────────
  objectives: {
    list: () => request<{ objectives: Objective[] }>('GET', '/objectives'),
    create: (body: ObjectiveInput) => request<{ objective: Objective }>('POST', '/objectives', body),
    update: (id: string, body: Partial<ObjectiveInput>) => request<{ objective: Objective }>('PATCH', `/objectives/${id}`, body),
    delete: (id: string) => request<{ ok: boolean }>('DELETE', `/objectives/${id}`),
    linkTask: (id: string, task_id: string) => request<{ ok: boolean }>('POST', `/objectives/${id}/tasks`, { task_id }),
    unlinkTask: (id: string, task_id: string) => request<{ ok: boolean }>('DELETE', `/objectives/${id}/tasks/${task_id}`),
    recompute: (id: string) => request<{ ok: boolean }>('POST', `/objectives/${id}/recompute`),
  },
};

// ── Types ────────────────────────────────────────────────────────────────────
export interface Block {
  id: string; task_id?: string; title: string; block_kind: string;
  tag?: string | null; // top-level/grouping tag (G3); set on 'timeblock' containers
  secondary_tags?: string[]; // Phase 5: diluted secondary tags (entity_tags level>1)
  // CON-4 recurring Time Blocks: a template carries recurrence_rule; rendered rows
  // are materialized instances (recurrence_parent_id + occurrence_date set).
  recurrence_rule?: string | null;
  recurrence_dtstart?: string | null;
  recurrence_parent_id?: string | null;
  occurrence_date?: string | null;
  // Plan/Concept container typing (0019). block_type is set on 'timeblock' containers.
  block_type?: 'scheduled' | 'someday' | null;
  goal_start_date?: string | null; // YYYY-MM-DD goal day for concepts (null = someday)
  duration_minutes?: number | null; // concept duration (no start/end semantics)
  note?: string | null; // optional saved note on a Plan/Concept container (0021)
  parent_block_id?: string | null; // the containing Plan for a member task block (PR-C / 0023)
  category_id?: string | null; // Time Block Category (tags.kind='category'); direction implied by the category (0069)
  color_token?: string | null; // frozen category color stamped at create-time — forward-only (0069)
  rationale?: string | null; // §A3 "why now" — joined from daily_plan via block_id (AI-authored placements only)
  start_at: string; end_at: string; is_locked: boolean; is_auto: boolean;
  all_day?: boolean; // all-day events render in a pinned header lane (0010); absent ⇒ false (pre-migration)
  source_kind: string; status: string; created_at: string;
}

export interface Possible {
  id: string; raw_title: string; raw_summary?: string; proposed_due_at?: string;
  proposed_priority?: number; source_kind?: string; confidence?: number;
  status: string; created_at: string;
}

// ── Phase G: patterns, flight-plan, block templates ───────────────────────────
/** A pattern type: Routine ▢ / Habit ◯ / Ritual △ (+ user-defined). icon_shape drives textures. */
export interface PatternType {
  id: string; owner_id: string; name: string;
  icon_shape: string;                    // square | circle | triangle | <custom>
  reminder_config: unknown | null;       // per-type reminder defaults (Phase H reads)
  is_builtin: boolean;
  // Per-type display/config defaults (0017).
  color_token: string | null;            // CI-Hub token key (e.g. 'chart-1'); null = default
  texture: string | null;                // motif override; null = derive from tag
  default_est_minutes: number | null;    // default est for this category
  notify: boolean;                       // per-type reminder toggle (Phase H fires)
}

export interface PatternTypeInput {
  name: string; icon_shape: string;
  reminder_config?: unknown;
  color_token?: string | null; texture?: string | null;
  default_est_minutes?: number | null; notify?: boolean;
}

/**
 * A pattern: a typed, reusable, many-to-many collection of tasks. Habit + Routine
 * patterns may carry an RRULE (PR-C+ / 0025); Ritual patterns may not (flag-off
 * in V1, server returns 422 if asked). A non-null `recurrence_rule` is what the
 * 06:00 `place_patterns` cron expands daily.
 */
export interface Pattern {
  id: string; owner_id: string; type_id: string | null;
  name: string; tag: string | null; notes: string | null;
  recurrence_rule: string | null; recurrence_dtstart: string | null;
  created_at: string; task_ids: string[];
}

export interface PatternInput {
  type_id?: string | null; name: string; tag?: string | null;
  notes?: string | null; task_ids?: string[];
  recurrence_rule?: string | null; recurrence_dtstart?: string | null;
}

/** A flight-plan row: a staged task (+ its nominating source). */
export interface FlightPlanItem {
  task_id: string; selected: boolean; position: number;
  source_kind: string; source_ref: string | null; added_at: string;
  title: string; priority: number | null; estimated_minutes: number | null; status: string;
  is_recurring?: boolean;
}

/** Result of POST /api/auto/run — `fill` (step 1) proposes; `place` (step 2) schedules. */
export interface AutoResult {
  step: 'fill' | 'place';
  candidatesAdded?: number;              // step 1
  blocksCreated?: number; placed?: number; unplaced?: number; // step 2
  days?: number;                          // T-SCHED-2: Schedule-mode horizon span (>1 only)
}

/** Phase M B1/B3: one block a reactive reflow moved (its before/after windows). */
export interface BlockMove {
  block_id: string;
  task_id: string;
  before: { start_at: string; end_at: string };
  after: { start_at: string; end_at: string };
}

/**
 * Phase M B3: the `schedule:done` SSE payload — what a reactive reflow changed.
 * Mirrors the server's ReflowDiff (auto-defense.ts) plus the trigger `reason`.
 */
export interface ReplanDiff {
  reason?: string;
  moved: BlockMove[];
  removed: { block_id: string; task_id: string }[];
  added: { block_id: string; task_id: string }[];
  unplaced: string[];
}

/** Phase M B4: an outstanding "re-plan with AI?" nudge (the `replan:suggested` payload). */
export interface ReplanSuggestion {
  date: string;
  reason?: string;
  summary?: string;
}

/** Phase M A4: a parsed NL planning instruction. Pins are applied; hints are surfaced only (MVP). */
export interface PlanPin { title: string; start_at: string; end_at: string }
export interface PlanHint { kind: 'tag_before' | 'tag_after' | 'batch'; tag: string; time?: string }
export interface InstructResponse { ok: boolean; date: string; pins: PlanPin[]; hints: PlanHint[]; created: number }

/** Result of POST /api/patterns/:id/place-today (PR-C+, Phase C). */
export interface PlacePatternResult {
  patternId: string;
  date: string;
  blocksCreated: number;
  placed: number;                        // tasks with >= 1 session placed
  unplaced: number;                      // tasks with no fit
  skippedAlreadyPlaced: boolean;         // marker query short-circuited
}

/** A task saved inside a Plan template — recreated at start + offset on instantiate. */
export interface TemplateTask { title: string; tag: string | null; estimated_minutes: number | null; offset_minutes: number }

/** A reusable Time-Block template (named, tagged container + default duration + saved tasks). */
export interface BlockTemplate {
  id: string; owner_id: string; name: string; tag: string | null; default_minutes: number;
  tasks?: TemplateTask[];
}

export interface Tag {
  id: string; name: string; count: number;
  // Tag taxonomy (0036; 'category' added 0069): 'pattern' = top-level grouping (brand-set
  // home/work/community); 'intention' = grouped under patterns; 'category' = a SECOND
  // grouping over intentions ("Time Block Category"). `used` blocks delete. `directions` =
  // member pattern names (empty intention = Unsorted).
  kind: 'pattern' | 'intention' | 'category';
  muted: boolean;
  is_base: boolean;
  used: boolean;
  directions: string[];
  categories?: string[];        // intention only: member category names ([] = Unsorted on the Category tab) (0069)
  direction_optouts?: string[]; // category only: pattern (direction) names turned OFF (empty = all directions on) (0069)
}

export interface Prefs {
  id: string; owner_id: string; workday_start: string; workday_end: string;
  auto_fill_workday?: boolean; // gates the workday fallback fill (0028)
  auto_mode?: 'suggest' | 'schedule'; // trust toggle (0052); default 'suggest'
  fill_order?: 'priority' | 'overdue'; // leftover fill ordering (0055); default 'priority'
  deep_work_windows?: { start: string; end: string }[];
  max_focus_block_minutes: number; min_break_minutes: number;
  // Time-Block container duration bounds (0017); default duration (0072).
  max_time_block_minutes?: number; min_time_block_minutes?: number; default_time_block_minutes?: number;
  // Plan/Concept Time-Block config (0018). Plan horizon = planning_horizon_days.
  plan_allday_always?: boolean; plan_daylong_for_promoted?: boolean; plan_autofill_gaps?: boolean;
  concept_default_minutes?: number; concept_autosurface?: boolean; concept_horizon_days?: number;
  concept_tags?: { name: string; minutes: number }[]; // canonical Block-Wizard concept tags (0021)
  enable_rituals?: boolean; // feature flag (0024); default false — Rituals hidden
  enable_routines?: boolean; // feature flag; default false — Routines hidden from Add dialog
  recall_keeps_pattern?: boolean; // cockpit-v2 Phase 6: recall=clone copies Routine membership (default OFF)
  day_theme?: Record<string, string>; planning_mode: string;
  timezone?: string; planning_horizon_days?: number;
  // Ollama model overrides (null/'' = use env default).
  fast_model?: string | null; quality_model?: string | null; embed_model?: string | null;
  // Companion Memory sync.
  memory_sync_enabled?: boolean; memory_sync_completed?: boolean;
  memory_sync_habits?: boolean; memory_sync_reflections?: boolean;
  memory_account?: string | null; memory_last_synced_at?: string | null;
}

export interface MemoryStatus {
  enabled: boolean; connected: boolean; account: string | null;
  lastSyncedAt: string | null; available: boolean;
  scopes: { completed: boolean; habits: boolean; reflections: boolean };
}

// ── Reminders (Phase H) ────────────────────────────────────────────────────────
export interface Reminder {
  id: string; task_id: string | null; block_id: string | null;
  fire_at: string; status: string; fired_at?: string | null;
}
/** Create input: exactly one target (taskId|blockId) + `fireAt` (UTC ISO) or `date`+`time`. */
export interface ReminderInput {
  taskId?: string; blockId?: string; fireAt?: string; date?: string; time?: string;
}

export interface Job {
  id: string; name: string; kind: string; cron: string; enabled: boolean;
  last_run_at?: string; last_started?: string; last_status?: string;
  items_created?: number;
}

export interface FocusItem { taskId: string; title: string; reason: string }

export interface Capacity {
  scheduled_minutes: number;
  focus_minutes: number;
  workday_minutes: number;
}

export interface DaySummary {
  date: string; prose: string; llm: boolean;
  stats: { overdue: number; dueToday: number; open: number; blocks: number };
  focus: FocusItem[];
  capacity: Capacity;
}

export interface WeekReview {
  week_key: string;
  days: string[];
  tasks_completed: number;
  tasks_overdue: number;
  blocks_count: number;
  weekly_goals: Array<{ position: number; body: string; done_at: string | null }>;
  objectives_rotting: number;
}

export type Calibration =
  | { calibrated: false; sample_count: number }
  | { calibrated: true; sample_count: number; bias_ratio: number; p25: number; p50: number; p75: number; computed_at: string; label: string };

export interface LLMStatus {
  available: boolean; url: string; models: string[];
  smallModel: string; mediumModel: string; embedModel: string;
}

// ── Connections (WP7) — read-only Google connection health ─────────────────────
// Mirrors the server's ConnectionHealth (server/src/lib/connections.ts) EXACTLY.
// Token material (accessToken/refreshToken/ciphertext/iv/auth_tag/key_version) is
// never present — by design.
export interface ConnectionHealth {
  provider: string;
  account: string;
  status: 'connected' | 'expired' | 'inactive';
  expiresAt: string | null;
  mappedEventCount: number;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface Integrations {
  ollama: { available: boolean; models: string[]; smallModel: string; mediumModel: string; embedModel: string };
  google: { mode: string; liveEnabled: boolean; connections: ConnectionHealth[] };
  push?: { configured: boolean }; // Phase H: VAPID keys present → Web Push can deliver
}

// ── Phase L: multi-device sync ─────────────────────────────────────────────────
/** One field-scoped mutation to apply on the server. */
export interface SyncOp {
  opId: string;
  entity: 'task' | 'block';
  entityId: string;
  fields: Record<string, unknown>;
  baseVersion: number;
  clientTs: string;
}

/** Server applied the op; `dropped` lists fields that lost a LWW race. */
export interface SyncResult {
  opId: string;
  entityId: string;
  version: number;
  applied: Record<string, unknown>;
  dropped: string[];
}

/** Server rejected the op entirely (404 / auth / validation). */
export interface SyncError {
  opId: string;
  error: string;
}

// ── Pattern-blocks (noun 8) ────────────────────────────────────────────────────
export interface PatternRange { id: string; start_time: string; end_time: string }
export type PatternWindows = Record<string, PatternRange[]>; // dirTagId → ranges

// ── Day types (0068, T-SCHED-3): a date resolves to one of these keys, selecting
// the pattern_blocks windows Auto places into. Builtins workday/weekend are rename-only.
export interface DayType { id: string; key: string; name: string; is_builtin: boolean }

// ── Pattern-prefs (0039): per-pattern auto_fill + reminder offsets + block display ──
export interface PatternPref {
  auto_fill: boolean;
  reminder_offsets: number[];  // minutes before scheduled start; 0 = at start time
  icon_shape: string;          // circle | square | triangle — pattern-block display
  color_token: string;         // CI-Hub token key (never hex)
  default_minutes: number;     // fallback estimate when a task has no intention tag
}

export interface PatternPrefsResponse {
  prefs: Record<string, PatternPref>;
}

// ── Category-prefs (0069): per-category color + default block length ──
export interface CategoryPref {
  color_token: string;     // CI-Hub token key (never hex)
  default_minutes: number; // prefills the wizard's block length when this category is picked
}

export interface CategoryPrefsResponse {
  prefs: Record<string, CategoryPref>;
}

// ── Phase N0: reflections (today + weekly goals) ─────────────────────────────
export interface ReflectionGoal {
  body: string;
  category_id: string | null;
  color_token: string | null;
  done_at: string | null;
}

export interface WeeklyGoal extends ReflectionGoal {
  position: number;
}

export interface ReflectionsResponse {
  today: ReflectionGoal | null;
  weekly: WeeklyGoal[];
}

export interface ReflectionWrite {
  body: string;
  category_id?: string | null;
}

// ── Phase N1: Objectives ───────────────────────────────────────────────────────
export interface ObjectiveNextAction {
  id: string;
  title: string;
  status: string;
  scheduled_date: string | null;
}

export interface Objective {
  id: string;
  owner_id: string;
  parent_id: string | null;
  level: 'goal' | 'project' | 'objective';
  horizon: 'year' | 'quarter' | 'month' | 'week' | 'none';
  title: string;
  description: string | null;
  target_date: string | null;
  status: 'active' | 'paused' | 'done' | 'dropped';
  category_id: string | null;
  progress_cache: number | null;
  cadence: 'weekly' | 'biweekly' | 'monthly' | 'none';
  last_advanced_at: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  // Server-precomputed fields returned by GET /objectives:
  next_action: ObjectiveNextAction | null;
  effective_target: string | null;
  pace_expected: number | null;
  has_tasks: boolean;
  children: Objective[];
}

export interface ObjectiveInput {
  title: string;
  parent_id?: string | null;
  horizon?: 'year' | 'quarter' | 'month' | 'week' | 'none';
  status?: 'active' | 'paused' | 'done' | 'dropped';
  cadence?: 'weekly' | 'biweekly' | 'monthly' | 'none';
  target_date?: string | null;
  category_id?: string | null;
  priority?: number;
  description?: string | null;
}
