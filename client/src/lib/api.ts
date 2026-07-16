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
  objective_id?: string | null; // §I: first linked objective — drives the 8-pointed star + its click target. Invariant: === objective_ids[0] ?? null
  objective_ids?: string[]; // AF-10: ALL linked objectives (owner-scoped, created_at,id order — first element == objective_id)
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
  /** AB1: on create, place a start-anchored block at (scheduled_for, task_time) so the
   *  task lands on the Planner immediately. Server-side placeStartAnchoredTask; needs
   *  scheduled_for. Default off. */
  auto_place?: boolean;
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
      // due_at / scheduled_for / task_time accept null so a "clear" sends an explicit
      // null (JSON.stringify drops `undefined`, so undefined would no-op server-side).
      body: Partial<
        Omit<TaskInput, 'due_at' | 'scheduled_for' | 'task_time'> & {
          status: string;
          completed: boolean;
          completed_at?: string | null;
          due_at?: string | null;
          scheduled_for?: string | null;
          task_time?: string | null;
        }
      >,
      scope?: 'instance' | 'series',
    ) => request<{ task: Task }>('PATCH', `/tasks/${id}${scope === 'series' ? '?scope=series' : ''}`, body),
    delete: (id: string) => request<{ task: Task }>('DELETE', `/tasks/${id}`),
    subtasks: (id: string) => request<{ subtasks: Task[] }>('GET', `/tasks/${id}/subtasks`),
    skip: (id: string) => request<{ task: Task; skipped: string }>('POST', `/tasks/${id}/skip`, {}),
    streak: (id: string) => request<Streak>('GET', `/tasks/${id}/streak`),
    // Make a (possibly ritual-local) task a habit — flags it + ensures its Habit pattern.
    promoteHabit: (id: string) => request<{ task: Task }>('POST', `/tasks/${id}/promote-habit`, {}),
    // Surface a task in the objectives tree as its own leaf objective. Idempotent —
    // promoting twice reuses the task's objective. 422 when the task is ephemeral
    // (quick / recurrence instance) and so can't carry one.
    promoteObjective: (id: string) => request<{ objective: Objective }>('POST', `/tasks/${id}/promote-objective`, {}),
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
    // Phase Z · Z3 — "Keep working": plan (confirm omitted) or apply (confirm:true)
    // a block extension. Flag-gated server-side (rejects when Time-Sense is off).
    extend: (id: string, body?: { minutes?: number; confirm?: boolean }) =>
      request<ExtendResult>('POST', `/blocks/${id}/extend`, body ?? {}),
    // Phase Z · Z3 — "Schedule again": skip this attempt, re-stage the same task.
    reschedule: (id: string) =>
      request<{ ok: boolean; task_id: string; staged: boolean }>('POST', `/blocks/${id}/reschedule`, {}),
    // Phase Z · Z4 — arm/clear the block's background focus cues (tab-closed push).
    armFocusReminders: (id: string) =>
      request<{ ok: boolean; armed: number }>('POST', `/blocks/${id}/focus-reminders`, {}),
    clearFocusReminders: (id: string) =>
      request<{ ok: boolean }>('DELETE', `/blocks/${id}/focus-reminders`),
    // Phase Z · Z7 — the T4 "what's next" line, rendered server-side through the Voice loop.
    whatsNext: (id: string) =>
      request<{ text: string; next: { title: string; start_at: string } | null }>('GET', `/blocks/${id}/whats-next`),
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
    // §A4: parse a natural-language instruction → pinned blocks + persisted hints
    // (hints are enforced by the next autoplan run: hard tag windows in placement,
    // soft constraint line in smart-mode authoring).
    instruct: (text: string, date?: string) => request<InstructResponse>('POST', '/plan/instruct', { text, date }),
  },

  blockTemplates: {
    list: () => request<{ block_templates: BlockTemplate[] }>('GET', '/block-templates'),
    // AF-8: pass `upsert: true` to update the owner's existing template of the same
    // (case-insensitive) name instead of duplicating it; the response then carries
    // `updated` (true = refreshed an existing template, false = created new).
    create: (body: { name: string; tag?: string; default_minutes?: number; tasks?: TemplateTask[]; upsert?: boolean }) =>
      request<{ block_template: BlockTemplate; updated?: boolean }>('POST', '/block-templates', body),
    update: (id: string, body: { name?: string; tag?: string | null; default_minutes?: number }) =>
      request<{ block_template: BlockTemplate }>('PATCH', `/block-templates/${id}`, body),
    delete: (id: string) => request<{ ok: boolean }>('DELETE', `/block-templates/${id}`),
    instantiate: (id: string, start_at: string, end_at?: string) =>
      request<{ block: Block }>('POST', `/block-templates/${id}/instantiate`, { start_at, end_at }),
    applyToBlock: (id: string, block_id: string) =>
      request<{ ok: boolean }>('POST', `/block-templates/${id}/apply-to-block`, { block_id }),
  },

  tags: {
    list: () => request<{ tags: Tag[] }>('GET', '/tags'),
    create: (name: string, opts?: { kind?: 'direction' | 'intention' | 'category'; directions?: string[]; categories?: string[] }) =>
      request<{ tag: Tag }>('POST', '/tags', { name, ...opts }),
    // PATCH: directions/categories REPLACE membership (drag-move = single target);
    // direction_toggle flips one category↔direction scope; name renames; muted toggles.
    update: (
      id: string,
      body: {
        directions?: string[];
        categories?: string[];
        direction_toggle?: { directionTagId: string; enabled: boolean };
        name?: string;
        muted?: boolean;
      },
    ) => request<{ tag: Tag }>('PATCH', `/tags/${id}`, body),
    remove: (id: string) => request<{ ok: boolean }>('DELETE', `/tags/${id}`),
  },

  prefs: {
    get: () => request<{ prefs: Prefs }>('GET', '/prefs'),
    update: (body: Partial<Prefs>) => request<{ prefs: Prefs; pruned?: number }>('PATCH', '/prefs', body),
  },

  // Phase P · P2 — Clear Date Range. `dry_run:true` previews counts; otherwise applies
  // (server snapshots first). Open-ended (no end) stops repeats forever from `start`;
  // bounded skips just the window.
  planner: {
    clearRange: (body: { start: string; end?: string; dry_run?: boolean }) =>
      request<ClearRangeResult>('POST', '/planner/clear', body),
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
    // AA0 — CI-Server connection (pull). api_key travels once on connect; it is
    // stored KEK-encrypted server-side and never echoed back.
    connect: (body: { url: string; api_key?: string }) => request<MemoryStatus>('POST', '/memory/connect', body),
    // AA0b — begin the CI-Portal SSO connect flow. Returns the authorize URL for a
    // top-level browser navigation (the callback stores an offline_access refresh token).
    ciportalStart: () => request<{ url: string }>('GET', '/memory/ciportal/start'),
    disconnect: () => request<MemoryStatus>('POST', '/memory/disconnect', {}),
    // AA1 — manual "pull suggestions now" trigger.
    suggest: () => request<MemorySuggestResult>('POST', '/memory/suggest', {}),
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
    // Phase O · O0 — Today's Brief top-tasks list (non-habit, non-routine, day-ranked).
    topTasks: (date: string) => request<{ tasks: TopTask[] }>('GET', `/summary/top-tasks?date=${date}`),
  },

  calibration: {
    // Phase Z · Z6 — suggest-only estimate nudge (404s when Time-Sense is off →
    // callers treat any failure as "no suggestion").
    suggest: (taskId: string) =>
      request<{ suggestion: EstimateSuggestion | null }>('GET', `/calibration/suggest/${taskId}`),
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

  priorities: {
    list: () => request<{ priorities: Priority[] }>('GET', '/priorities'),
    save: (priorities: Priority[]) => request<{ priorities: Priority[] }>('POST', '/priorities', { priorities }),
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
    // Phase O · O1 — the one-per-day free-text note. Empty body deletes.
    setNote: (period_key: string, body: string) =>
      request<{ ok: boolean }>('PUT', '/reflections/note', { period_key, body }),
    // Phase O · O1 — dates in [from, to] that have a day note (calendar dots).
    notedDays: (from: string, to: string) =>
      request<{ dates: string[] }>('GET', `/reflections/notes?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  },

  // ── Phase O · O2/O3: the five-star day score ─────────────────────────────────
  stars: {
    // One range call backs a whole calendar month; per date: frozen row or live.
    range: (from: string, to: string) =>
      request<DayStar[]>('GET', `/stars?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
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

  // ── Auth (U1/U2/U3) ──────────────────────────────────────────────────────────
  // Session lives in an httpOnly cookie set by the server; same-origin fetch sends
  // it automatically, so these need no token handling. `config` is public (the
  // pre-login mode probe); `me` 401s when unauthenticated.
  auth: {
    config: () => request<AuthConfigResponse>('GET', '/auth/config'),
    me: () => request<AuthMe>('GET', '/auth/me'),
    login: (username: string, password: string) =>
      request<{ ok: boolean }>('POST', '/auth/login', { username, password }),
    logout: () => request<{ ok: boolean }>('POST', '/auth/logout'),
    // V — password reset (local sign-in). reset-request always resolves to a neutral 200.
    // `delivery`/`message` are config-derived only (email vs. server-log fallback when
    // SMTP is unconfigured) — never account-derived, so anti-enumeration holds.
    resetRequest: (identifier: string) =>
      request<{ ok: boolean; delivery: 'email' | 'log'; message: string }>('POST', '/auth/reset-request', { identifier }),
    reset: (token: string, newPassword: string) =>
      request<{ ok: boolean }>('POST', '/auth/reset', { token, newPassword }),
  },

  // V — the authenticated owner's own account settings (backup reset-email + profile).
  owner: {
    setBackupEmail: (backupEmail: string | null) =>
      request<{ ok: boolean; backup_email: string | null }>('PATCH', '/owner/backup-email', { backup_email: backupEmail }),
    updateProfile: (body: { name?: string; email?: string | null }) =>
      request<{ ok: boolean; name: string; email: string | null }>('PATCH', '/owner/profile', body),
  },

  // In-app Google connection setup (admin-gated; GET 403s for non-admin credentials).
  googleConfig: {
    get: () => request<GoogleConfigState>('GET', '/google-config'),
    save: (body: { client_id?: string; client_secret?: string | null; enabled: boolean }) =>
      request<GoogleConfigState>('PUT', '/google-config', body),
  },

  // Phase AG — operator account management (operator-gated; 403s for everyone else).
  // Onboarding is by email invite: create mints a password-less account and sends a
  // set-your-password link; with no SMTP the link comes back for the operator to
  // forward. `invite` (re)sends it — a fresh invite or a reset link, by state.
  accounts: {
    list: () => request<{ accounts: OwnerAccount[] }>('GET', '/accounts'),
    create: (body: { username: string; email: string; name?: string; role?: OwnerRole }) =>
      request<{ account: OwnerAccount; invite: InviteResult }>('POST', '/accounts', body),
    invite: (id: string) => request<{ ok: boolean; invite: InviteResult }>('POST', `/accounts/${id}/invite`),
    update: (id: string, body: { role?: OwnerRole; name?: string; email?: string | null }) =>
      request<{ account: OwnerAccount }>('PATCH', `/accounts/${id}`, body),
    delete: (id: string) => request<{ ok: boolean }>('DELETE', `/accounts/${id}`),
  },
};

/** How an account invite went out: emailed, or handed back as a link (no SMTP). */
export type InviteResult = { delivery: 'email'; to: string } | { delivery: 'link'; link: string };

export interface GoogleConfigState {
  source: 'env' | 'app' | 'off';
  mode: 'live' | 'fixture' | 'off';
  envPinned: boolean;
  kekAvailable: boolean;
  clientId: string | null;
  hasClientSecret: boolean;
  enabled: boolean;
  redirectUri: string;
}

export type AuthMode = 'test' | 'standalone' | 'sso';
export interface AuthConfigResponse {
  mode: AuthMode;
  disableOidc: boolean;
}
export interface AuthMe {
  ownerId: string;
  name: string;
  email: string | null;
  username: string | null;
  backupEmail: string | null; // V — fallback password-reset destination
  role: OwnerRole; // Phase AG — operator/member/viewer
  isOperator: boolean; // derived server-side: role === 'operator'
}
// Phase AG — the operator/tenant role split (docs/AG-multitenant-rbac.md).
export type OwnerRole = 'operator' | 'member' | 'viewer';
export interface OwnerAccount {
  id: string;
  name: string;
  username: string | null;
  email: string | null;
  role: OwnerRole;
  // false ⇒ either OIDC-only (no username; signs in via CI-Portal) OR a local
  // account whose invite hasn't been accepted yet ("invite pending" in the UI).
  hasPassword: boolean;
}
/** True when this deployment gates the SPA behind a login screen (U3). */
export function authGateActive(cfg: AuthConfigResponse): boolean {
  return cfg.mode === 'sso';
}
/** Where the "Sign in with CI-Portal" button sends the browser (a top-level nav, not fetch). */
export const CIPORTAL_START = `${BASE}/auth/ciportal/start`;

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
  // AF-11: `tag` is the LEGACY authored column (always null after migration 0120);
  // `directions`/`intentions` are DERIVED server-side — the union of member tasks'
  // tags, kind-classified. Multiple directions per routine are legal.
  name: string; tag: string | null; notes: string | null;
  directions: string[]; intentions: string[];
  recurrence_rule: string | null; recurrence_dtstart: string | null;
  created_at: string; task_ids: string[];
}

// AF-11: no `tag` — routines author no tags (the server accepts-and-ignores one
// from old clients; new code must not send it).
export interface PatternInput {
  type_id?: string | null; name: string;
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

/** Phase M A4: a parsed NL planning instruction. Pins are applied as locked blocks;
 *  hints persist to plan_hints and are enforced on the next autoplan run. */
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
  kind: 'direction' | 'intention' | 'category';
  muted: boolean;
  is_base: boolean;
  used: boolean;
  directions: string[];
  categories?: string[];        // intention only: member category names ([] = Unsorted on the Category tab) (0069)
  direction_optouts?: string[]; // category only: pattern (direction) names turned OFF (empty = all directions on) (0069)
}

/**
 * Cross-device UI view-state (server migration 0111, stored as one JSON blob),
 * one sibling per surface. Every key is optional — a missing/malformed blob degrades
 * to built-in defaults (filter = all shown, night hours = both collapsed) so hydration
 * can never crash. `calendar.deselected` holds hidden tag names per axis (sorted arrays
 * on the wire ↔ Sets in the store); `planner` holds the Planner's own night-hour
 * collapse flags. Both are persisted the same way.
 */
export interface ViewPrefs {
  calendar?: {
    deselected?: { direction?: string[]; intention?: string[]; category?: string[] };
    prio?: number[];
    topExpanded?: boolean;
    bottomExpanded?: boolean;
  };
  planner?: {
    topExpanded?: boolean;
    bottomExpanded?: boolean;
    /** Configurable night-collapse boundaries (minute-of-day). Absent = 07:00 / 21:00. */
    topEndMin?: number;
    bottomStartMin?: number;
  };
  /** Cross-view appearance switches. */
  appearance?: {
    /** Routine/direction background textures on cards & planner chips. Absent = on. */
    direction_textures?: boolean;
  };
}

export interface Prefs {
  id: string; owner_id: string; workday_start: string; workday_end: string;
  auto_fill_workday?: boolean; // gates the workday fallback fill (0028)
  // Trust dial (0070) — governs auto-blocking/planning. The top-bar Suggest/Schedule
  // toggle maps Schedule ⇔ 'hands_off' (auto-schedule on ingest) and Suggest ⇔
  // 'balanced'; 'cautious' also displays as Suggest. (Replaced the vestigial
  // auto_mode column, dropped in 0123.)
  trust_mode?: 'cautious' | 'balanced' | 'hands_off';
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
  time_sense_enabled?: boolean; // Phase Z master flag (0106); default false — Time-Sense surfaces hidden
  // Phase Z · Z5 per-cue prefs matrix (0108). Read only while time_sense_enabled is on.
  focus_ritual_enabled?: boolean; // master gate for the Focus screen
  haptic_cues_enabled?: boolean; // T1–T4 haptics (arm-derived on first enable)
  ambient_color_enabled?: boolean; // depletion + breathing animation (arm-derived)
  calibration_loop_enabled?: boolean; // estimate prompt + scoped nudge (§2)
  z_experiment_arm?: 'A' | 'B' | 'C' | 'D' | null; // fixed A/B bucket, server-assigned; read-only
  day_theme?: Record<string, string>; planning_mode: string;
  timezone?: string; planning_horizon_days?: number;
  recurrence_horizon_days?: number; // Phase P: how far ahead recurrence materializes (7/15/30/60/90/180)
  // Ollama model overrides (null/'' = use env default).
  fast_model?: string | null; quality_model?: string | null; embed_model?: string | null;
  // Companion Memory sync.
  memory_sync_enabled?: boolean; memory_sync_completed?: boolean;
  memory_sync_habits?: boolean; memory_sync_reflections?: boolean;
  memory_account?: string | null; memory_last_synced_at?: string | null;
  // Companion Memory pull (Phase AA): feed the CI-Server memory graph into suggestions.
  memory_pull_enabled?: boolean;
  // Onboarding Priorities Wizard (0128): weekly hours reserved for sleep (unschedulable,
  // attributed to Health). Default 63 = 9h/night × 7; schedulable pool = 168 − this.
  sleep_hours_per_week?: number;
  // Cross-device calendar view-state (0111); null/absent = use built-in defaults.
  view_prefs?: ViewPrefs | null;
}

// Phase P · P2 — result of POST /api/planner/clear (also the dry-run preview shape).
export interface ClearRangeResult {
  mode: 'open-ended' | 'bounded';
  blocksDeleted: number;
  dailyPlanDeleted: number;
  generators: { kind: 'block' | 'pattern'; id: string; label: string; action: string; daysSuppressed: number }[];
  backup?: string; // present only on a real apply (server-side snapshot path)
}

export interface MemoryStatus {
  enabled: boolean; connected: boolean; account: string | null;
  lastSyncedAt: string | null; available: boolean;
  scopes: { completed: boolean; habits: boolean; reflections: boolean };
  // Phase AA — pull-side connection state (CI-Server memory graph). `authKind` (AA0b):
  // 'oidc' = connected via CI-Portal SSO, 'manual' = pasted key/bearer, null otherwise.
  pull: {
    enabled: boolean; available: boolean;
    source: 'settings' | 'env' | null;
    authKind: 'manual' | 'oidc' | null;
    host: string | null;
  };
}

// Phase AA · AA1 — result of POST /api/memory/suggest.
export interface MemorySuggestResult {
  status: 'ran'; pulled: number; created: number; updated: number;
  skippedDismissed: number; skippedCap: number;
  /** AF-3: pending possibles auto-promoted into tasks at the end of the run. */
  promoted?: number;
  /** AF-CU1: batch-promotion outcome split (optional until that lane lands). */
  duplicates?: number;
  failed?: number;
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
  // Phase Z · Z2 — last night's EOD Alignment folded in (present only when
  // Time-Sense is on). prose null = the evening modal wasn't opened (degrade).
  evening?: {
    date: string;
    prose: string | null;
    carry_forward: { task_id: string; title: string; status: string }[];
  };
}

// Phase Z · Z3 — "Keep working" block extension result (§1.1a).
export interface ExtendMove {
  block_id: string;
  task_id: string | null;
  title: string;
  before: { start_at: string; end_at: string };
  after: { start_at: string; end_at: string };
}
export interface ExtendResult {
  fits: boolean;
  committed: boolean;
  newEndAt: string;
  movedSet: ExtendMove[];
  blockedBy: { block_id: string; title: string; start_at: string } | null;
}

// Phase Z · Z6 — suggest-only estimate nudge for one task (null = nothing to say).
export interface EstimateSuggestion {
  task_id: string;
  current_minutes: number;
  suggested_minutes: number;
  delta_minutes: number;
  bias_ratio: number;
  scope_kind: string;
  scope_ref: string;
  scope_label: string;
  confidence: 'tentative' | 'confident';
  message?: string; // Z7 — the chip line rendered through the Voice loop (server-side)
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

/** A life-priority row (life_priorities, 0127). The wizard sends the four core fields;
 *  GET returns them plus id/owner/timestamps, which the client ignores. */
export interface Priority {
  category: string;
  satisfaction: number;
  importance: number;
  target_hours_per_week: number;
}

export interface Integrations {
  ollama: { available: boolean; models: string[]; smallModel: string; mediumModel: string; embedModel: string };
  google: { mode: string; liveEnabled: boolean; source: 'env' | 'app' | 'off'; connections: ConnectionHealth[] };
  push?: { configured: boolean }; // Phase H: VAPID keys present → Web Push can deliver
}

// ── Phase L: multi-device sync ─────────────────────────────────────────────────
/** One field-scoped mutation to apply on the server. */
export interface SyncOp {
  opId: string;
  entity: 'task' | 'block' | 'objective' | 'objective_task';
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
  // Phase O · O0 — optional link to the work this focus references.
  source_kind: 'manual' | 'task' | 'objective';
  source_ref: string | null;
}

export interface WeeklyGoal extends ReflectionGoal {
  position: number;
}

// Phase O · O1 — the one free-text note per day (reflections kind='day_note').
export interface DayNote {
  body: string;
  updated_at: string;
}

export interface ReflectionsResponse {
  today: ReflectionGoal | null;
  weekly: WeeklyGoal[];
  note: DayNote | null;
}

export interface ReflectionWrite {
  body: string;
  category_id?: string | null;
  // Phase O · O0 — link a focus to a task ('task') or objective ('objective').
  source_kind?: 'manual' | 'task' | 'objective';
  source_ref?: string | null;
}

// ── Phase O · O2/O3: the five-star day score ──────────────────────────────────
/** The five derived booleans for a day (GET /api/stars). Live for today, frozen for the past. */
export interface DayStars {
  objective: boolean;
  habits: boolean;
  tasks: boolean;
  bonus: boolean;
  note: boolean;
  total: number;
}

/** One row of GET /api/stars — a date's stars plus whether it's the frozen snapshot. */
export interface DayStar extends DayStars {
  date: string;
  frozen: boolean;
}

// ── Phase O · O0: Today's Brief top-tasks row ─────────────────────────────────
export interface TopTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  planned: boolean;
  done: boolean;
}

// ── Phase N1: Objectives ───────────────────────────────────────────────────────
export interface ObjectiveNextAction {
  id: string;
  title: string;
  status: string;
  scheduled_date: string | null;
}

/** AF-2: compact linked-task rows GET /objectives attaches to every node (leaves populated, non-leaves `[]`). */
export interface ObjectiveTaskSummary {
  id: string;
  title: string;
  status: string;
  priority: number | null;
  due_at: string | null;
  scheduled_for: string | null;
  parent_id: string | null;
  completed_at: string | null;
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
  /** Set when the objective was auto-promoted from a task (mig 0086); NULL for manual ones. */
  source_task_id: string | null;
  // Server-precomputed fields returned by GET /objectives:
  next_action: ObjectiveNextAction | null;
  effective_target: string | null;
  pace_expected: number | null;
  has_tasks: boolean;
  /** AF-2: linked open/done-recent tasks — leaves populated, non-leaves always `[]`. */
  tasks: ObjectiveTaskSummary[];
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
