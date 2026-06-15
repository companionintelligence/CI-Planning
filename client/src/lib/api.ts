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
    update: (id: number, body: Partial<TaskInput & { status: string; completed: boolean; completed_at?: string }>) =>
      request<{ task: Task }>('PATCH', `/tasks/${id}`, body),
    delete: (id: number) => request<{ task: Task }>('DELETE', `/tasks/${id}`),
    subtasks: (id: number) => request<{ subtasks: Task[] }>('GET', `/tasks/${id}/subtasks`),
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
    delete: (id: number) => request<{ ok: boolean }>('DELETE', `/blocks/${id}`),
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
  start_at: string; end_at: string; is_locked: boolean; is_auto: boolean;
  source_kind: string; status: string; created_at: string;
}

export interface Possible {
  id: number; raw_title: string; raw_summary?: string; proposed_due_at?: string;
  proposed_priority?: number; source_kind?: string; confidence?: number;
  status: string; created_at: string;
}

export interface Tag { id: number; name: string; count: number; }

export interface Prefs {
  id: number; owner_id: number; workday_start: string; workday_end: string;
  deep_work_windows?: { start: string; end: string }[];
  max_focus_block_minutes: number; min_break_minutes: number;
  day_theme?: Record<string, string>; planning_mode: string;
  timezone?: string; planning_horizon_days?: number;
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
  ollama: { available: boolean; models: string[]; smallModel: string; mediumModel: string };
  google: { mode: string };
}
