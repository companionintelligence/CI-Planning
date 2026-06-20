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
  id: number;
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
  parent_id?: number;
  owner_id: number;
  source_kind: string;
  created_at: string;
  completed_at?: string;
  tags: string[];
  depends_on?: number[];
  blocked?: boolean;
  // Recurrence (Phase E): a template has recurrence_rule set + no parent; an
  // instance has recurrence_parent_id + occurrence_date. is_habit propagates.
  recurrence_rule?: string;
  recurrence_parent_id?: number;
  occurrence_date?: string;
  is_habit?: boolean;
  is_fast_task?: boolean; // ritual-local, hidden from the task list (Step 3)
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
  parent_id?: number;
  owner_id?: number;
  tags?: string[];
  depends_on?: number[];
  recurrence_rule?: string | null;
  is_habit?: boolean;
}

export interface Streak {
  templateId: number;
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
      id: number,
      body: Partial<TaskInput & { status: string; completed: boolean; completed_at?: string | null }>,
      scope?: 'instance' | 'series',
    ) => request<{ task: Task }>('PATCH', `/tasks/${id}${scope === 'series' ? '?scope=series' : ''}`, body),
    delete: (id: number) => request<{ task: Task }>('DELETE', `/tasks/${id}`),
    subtasks: (id: number) => request<{ subtasks: Task[] }>('GET', `/tasks/${id}/subtasks`),
    skip: (id: number) => request<{ task: Task; skipped: string }>('POST', `/tasks/${id}/skip`, {}),
    streak: (id: number) => request<Streak>('GET', `/tasks/${id}/streak`),
    // Make a (possibly ritual-local) task a habit — flags it + ensures its Habit pattern.
    promoteHabit: (id: number) => request<{ task: Task }>('POST', `/tasks/${id}/promote-habit`, {}),
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
    update: (id: number, body: Partial<Block>) => request<{ block: Block }>('PATCH', `/blocks/${id}`, body),
    // children:'delete' also removes a Plan's member task blocks; default keeps them (FK SET NULL).
    delete: (id: number, opts?: { children?: 'delete' }) =>
      request<{ ok: boolean }>('DELETE', `/blocks/${id}${opts?.children === 'delete' ? '?children=delete' : ''}`),
    // Shift a Plan + all its members by one minute delta, atomically (PR-C). `id` may
    // be the Plan or any member; returns the whole moved group.
    moveGroup: (id: number, delta_minutes: number) =>
      request<{ blocks: Block[] }>('POST', `/blocks/${id}/move-group`, { delta_minutes }),
    // Concepts have no real time — fetch them all (owner-scoped) for the horizon lane.
    listConcepts: () => request<{ blocks: Block[] }>('GET', '/blocks?block_type=concept'),
    // Promote a Concept into a scheduled Plan at the chosen start (end ⇐ duration).
    promote: (id: number, start_at: string, opts?: { end_at?: string; all_day?: boolean }) =>
      request<{ block: Block }>('POST', `/blocks/${id}/promote`, { start_at, ...opts }),
  },

  // ── Patterns (Phase G, G1) — typed, reusable task collections ────────────────
  patterns: {
    list: () => request<{ patterns: Pattern[] }>('GET', '/patterns'),
    get: (id: number) => request<{ pattern: Pattern }>('GET', `/patterns/${id}`),
    create: (body: PatternInput) => request<{ pattern: Pattern }>('POST', '/patterns', body),
    update: (id: number, body: Partial<PatternInput>) =>
      request<{ pattern: Pattern }>('PATCH', `/patterns/${id}`, body),
    delete: (id: number) => request<{ ok: boolean }>('DELETE', `/patterns/${id}`),
    addTask: (id: number, task_id: number, position?: number) =>
      request<{ pattern_id: number; task_ids: number[] }>('POST', `/patterns/${id}/tasks`, { task_id, position }),
    removeTask: (id: number, taskId: number) =>
      request<{ pattern_id: number; task_ids: number[] }>('DELETE', `/patterns/${id}/tasks/${taskId}`),
    // Fast tasks — ritual-local, hidden from the task list (Step 3).
    addFastTask: (id: number, body: { title: string; estimated_minutes?: number }) =>
      request<{ task: Task }>('POST', `/patterns/${id}/fast-tasks`, body),
    removeFastTask: (id: number, taskId: number) =>
      request<{ ok: boolean }>('DELETE', `/patterns/${id}/fast-tasks/${taskId}`),
  },

  patternTypes: {
    list: () => request<{ pattern_types: PatternType[] }>('GET', '/pattern-types'),
    create: (body: PatternTypeInput) =>
      request<{ pattern_type: PatternType }>('POST', '/pattern-types', body),
    update: (id: number, body: Partial<PatternTypeInput>) =>
      request<{ pattern_type: PatternType }>('PATCH', `/pattern-types/${id}`, body),
    delete: (id: number) => request<{ ok: boolean }>('DELETE', `/pattern-types/${id}`),
  },

  // ── Flight-plan + two-step Auto (Phase G, G4) ────────────────────────────────
  flightPlan: {
    list: () => request<{ flight_plan: FlightPlanItem[] }>('GET', '/flight-plan'),
    addTask: (task_id: number) =>
      request<{ flight_plan: FlightPlanItem[]; added: number }>('POST', '/flight-plan', { task_id }),
    addPattern: (pattern_id: number) =>
      request<{ flight_plan: FlightPlanItem[]; added: number }>('POST', '/flight-plan', { pattern_id }),
    update: (taskId: number, body: { selected?: boolean; position?: number }) =>
      request<{ flight_plan: FlightPlanItem[] }>('PATCH', `/flight-plan/${taskId}`, body),
    remove: (taskId: number) =>
      request<{ flight_plan: FlightPlanItem[] }>('DELETE', `/flight-plan/${taskId}`),
    reset: () => request<{ ok: boolean; cleared: number }>('POST', '/flight-plan/reset', {}),
  },

  // Two-step Auto: empty/unselected flight-plan → fill candidates; selected → place.
  auto: {
    run: (body?: { block_id?: number; date?: string }) =>
      request<{ result: AutoResult; flight_plan: FlightPlanItem[] }>('POST', '/auto/run', body ?? {}),
  },

  blockTemplates: {
    list: () => request<{ block_templates: BlockTemplate[] }>('GET', '/block-templates'),
    create: (body: { name: string; tag?: string; default_minutes?: number; tasks?: TemplateTask[] }) =>
      request<{ block_template: BlockTemplate }>('POST', '/block-templates', body),
    delete: (id: number) => request<{ ok: boolean }>('DELETE', `/block-templates/${id}`),
    instantiate: (id: number, start_at: string, end_at?: string) =>
      request<{ block: Block }>('POST', `/block-templates/${id}/instantiate`, { start_at, end_at }),
  },

  possibles: {
    list: (status = 'pending') =>
      request<{ possibles: Possible[] }>('GET', `/possible-tasks?status=${status}`),
    promote: (id: number, overrides?: Partial<Task>) =>
      request<{ task: Task }>('POST', `/possible-tasks/${id}/promote`, overrides ?? {}),
    dismiss: (id: number) =>
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
    run: (id: number) => request<{ ok: boolean; message: string }>('POST', `/jobs/${id}/run`, {}),
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
  id: number; task_id?: number; title: string; block_kind: string;
  tag?: string | null; // container/grouping tag (G3); set on 'timeblock' containers
  // Plan/Concept container typing (0019). block_type is set on 'timeblock' containers.
  block_type?: 'plan' | 'concept' | null;
  goal_start_date?: string | null; // YYYY-MM-DD goal day for concepts (null = someday)
  duration_minutes?: number | null; // concept duration (no start/end semantics)
  note?: string | null; // optional saved note on a Plan/Concept container (0021)
  parent_block_id?: number | null; // the containing Plan for a member task block (PR-C / 0023)
  start_at: string; end_at: string; is_locked: boolean; is_auto: boolean;
  all_day?: boolean; // all-day events render in a pinned header lane (0010); absent ⇒ false (pre-migration)
  source_kind: string; status: string; created_at: string;
}

export interface Possible {
  id: number; raw_title: string; raw_summary?: string; proposed_due_at?: string;
  proposed_priority?: number; source_kind?: string; confidence?: number;
  status: string; created_at: string;
}

// ── Phase G: patterns, flight-plan, block templates ───────────────────────────
/** A pattern type: Routine ▢ / Habit ◯ / Ritual △ (+ user-defined). icon_shape drives textures. */
export interface PatternType {
  id: number; owner_id: number; name: string;
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

/** A pattern: a typed, reusable, many-to-many collection of tasks (no own recurrence). */
export interface Pattern {
  id: number; owner_id: number; type_id: number | null;
  name: string; tag: string | null; notes: string | null;
  created_at: string; task_ids: number[];
}

export interface PatternInput {
  type_id?: number | null; name: string; tag?: string | null;
  notes?: string | null; task_ids?: number[];
}

/** A flight-plan row: a staged task (+ its source pattern, if added via one). */
export interface FlightPlanItem {
  task_id: number; selected: boolean; position: number;
  source_pattern_id: number | null; added_at: string;
  title: string; priority: number | null; estimated_minutes: number | null; status: string;
}

/** Result of POST /api/auto/run — `fill` (step 1) proposes; `place` (step 2) schedules. */
export interface AutoResult {
  step: 'fill' | 'place';
  candidatesAdded?: number;              // step 1
  blocksCreated?: number; placed?: number; unplaced?: number; // step 2
}

/** A task saved inside a Plan template — recreated at start + offset on instantiate. */
export interface TemplateTask { title: string; tag: string | null; estimated_minutes: number | null; offset_minutes: number }

/** A reusable Time-Block template (named, tagged container + default duration + saved tasks). */
export interface BlockTemplate {
  id: number; owner_id: number; name: string; tag: string | null; default_minutes: number;
  tasks?: TemplateTask[];
}

export interface Tag { id: number; name: string; count: number; }

export interface Prefs {
  id: number; owner_id: number; workday_start: string; workday_end: string;
  deep_work_windows?: { start: string; end: string }[];
  max_focus_block_minutes: number; min_break_minutes: number;
  // Time-Block container duration bounds (0017).
  max_time_block_minutes?: number; min_time_block_minutes?: number;
  // Plan/Concept Time-Block config (0018). Plan horizon = planning_horizon_days.
  plan_allday_always?: boolean; plan_daylong_for_promoted?: boolean; plan_autofill_gaps?: boolean;
  concept_default_minutes?: number; concept_autosurface?: boolean; concept_horizon_days?: number;
  concept_tags?: { name: string; minutes: number }[]; // canonical Block-Wizard concept tags (0021)
  enable_rituals?: boolean; // feature flag (0024); default false — Rituals hidden
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
  id: number; name: string; kind: string; cron: string; enabled: boolean;
  last_run_at?: string; last_started?: string; last_status?: string;
  items_created?: number;
}

export interface FocusItem { taskId: number; title: string; reason: string }
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
