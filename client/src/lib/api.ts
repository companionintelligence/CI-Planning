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
  tags: string[];
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

  // Two-step Auto: empty/unselected flight-plan → fill candidates; selected → place.
  auto: {
    run: (body?: { block_id?: string; date?: string }) =>
      request<{ result: AutoResult; flight_plan: FlightPlanItem[] }>('POST', '/auto/run', body ?? {}),
  },

  blockTemplates: {
    list: () => request<{ block_templates: BlockTemplate[] }>('GET', '/block-templates'),
    create: (body: { name: string; tag?: string; default_minutes?: number; tasks?: TemplateTask[] }) =>
      request<{ block_template: BlockTemplate }>('POST', '/block-templates', body),
    delete: (id: string) => request<{ ok: boolean }>('DELETE', `/block-templates/${id}`),
    instantiate: (id: string, start_at: string, end_at?: string) =>
      request<{ block: Block }>('POST', `/block-templates/${id}/instantiate`, { start_at, end_at }),
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
    create: (name: string) => request<{ tag: Tag }>('POST', '/tags', { name }),
  },

  prefs: {
    get: () => request<{ prefs: Prefs }>('GET', '/prefs'),
    update: (body: Partial<Prefs>) => request<{ prefs: Prefs }>('PATCH', '/prefs', body),
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
  },

  llm: {
    status: () => request<LLMStatus>('GET', '/llm/status'),
    integrations: () => request<Integrations>('GET', '/integrations'),
  },
};

// ── Types ────────────────────────────────────────────────────────────────────
export interface Block {
  id: string; task_id?: string; title: string; block_kind: string;
  tag?: string | null; // top-level/grouping tag (G3); set on 'timeblock' containers
  secondary_tags?: string[]; // Phase 5: diluted secondary tags (entity_tags level>1)
  // Plan/Concept container typing (0019). block_type is set on 'timeblock' containers.
  block_type?: 'scheduled' | 'someday' | null;
  goal_start_date?: string | null; // YYYY-MM-DD goal day for concepts (null = someday)
  duration_minutes?: number | null; // concept duration (no start/end semantics)
  note?: string | null; // optional saved note on a Plan/Concept container (0021)
  parent_block_id?: string | null; // the containing Plan for a member task block (PR-C / 0023)
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

/** A flight-plan row: a staged task (+ its source pattern, if added via one). */
export interface FlightPlanItem {
  task_id: string; selected: boolean; position: number;
  source_pattern_id: string | null; added_at: string;
  title: string; priority: number | null; estimated_minutes: number | null; status: string;
}

/** Result of POST /api/auto/run — `fill` (step 1) proposes; `place` (step 2) schedules. */
export interface AutoResult {
  step: 'fill' | 'place';
  candidatesAdded?: number;              // step 1
  blocksCreated?: number; placed?: number; unplaced?: number; // step 2
}

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

export interface Tag { id: string; name: string; count: number; }

export interface Prefs {
  id: string; owner_id: string; workday_start: string; workday_end: string;
  auto_fill_workday?: boolean; // Auto's secondary workday fallback (0028); default true
  deep_work_windows?: { start: string; end: string }[];
  max_focus_block_minutes: number; min_break_minutes: number;
  // Time-Block container duration bounds (0017).
  max_time_block_minutes?: number; min_time_block_minutes?: number;
  // Plan/Concept Time-Block config (0018). Plan horizon = planning_horizon_days.
  plan_allday_always?: boolean; plan_daylong_for_promoted?: boolean; plan_autofill_gaps?: boolean;
  concept_default_minutes?: number; concept_autosurface?: boolean; concept_horizon_days?: number;
  concept_tags?: { name: string; minutes: number }[]; // canonical Block-Wizard concept tags (0021)
  enable_rituals?: boolean; // feature flag (0024); default false — Rituals hidden
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

export interface Job {
  id: string; name: string; kind: string; cron: string; enabled: boolean;
  last_run_at?: string; last_started?: string; last_status?: string;
  items_created?: number;
}

export interface FocusItem { taskId: string; title: string; reason: string }
export interface DaySummary {
  date: string; prose: string; llm: boolean;
  stats: { overdue: number; dueToday: number; open: number; blocks: number };
  focus: FocusItem[];
}

export interface LLMStatus {
  available: boolean; url: string; models: string[];
  smallModel: string; mediumModel: string; embedModel: string;
}

export interface Integrations {
  ollama: { available: boolean; models: string[]; smallModel: string; mediumModel: string; embedModel: string };
  google: { mode: string };
}
