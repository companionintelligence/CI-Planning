const BASE = '/api';

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error((await res.json()).error ?? res.statusText);
  return res.json() as Promise<T>;
}

// ── Tasks ────────────────────────────────────────────────────────────────────
export interface Task {
  id: number; title: string; description?: string; due_at?: string;
  estimated_minutes?: number; priority: number; status: string;
  owner_id: number; source_kind: string; created_at: string;
  completed_at?: string; tags: string[];
}

export const api = {
  tasks: {
    list: (params?: Record<string, string>) => {
      const q = params ? '?' + new URLSearchParams(params).toString() : '';
      return request<{ tasks: Task[] }>('GET', `/tasks${q}`);
    },
    create: (body: Partial<Task> & { title: string }) =>
      request<{ task: Task }>('POST', '/tasks', body),
    update: (id: number, body: Partial<Task & { tags: string[]; completed: boolean }>) =>
      request<{ task: Task }>('PATCH', `/tasks/${id}`, body),
    delete: (id: number) => request<{ task: Task }>('DELETE', `/tasks/${id}`),
  },

  blocks: {
    list: (from?: string, to?: string) => {
      const q = new URLSearchParams();
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      return request<{ blocks: Block[] }>('GET', `/blocks?${q}`);
    },
    create: (body: Partial<Block> & { title: string; start_at: string; end_at: string }) =>
      request<{ block: Block }>('POST', '/blocks', body),
    update: (id: number, body: Partial<Block>) =>
      request<{ block: Block }>('PATCH', `/blocks/${id}`, body),
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

  schedule: {
    run: (date?: string) => request<unknown>('POST', '/schedule/run', { date }),
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
}

export interface Job {
  id: number; name: string; kind: string; cron: string; enabled: boolean;
  last_run_at?: string; last_started?: string; last_status?: string;
  items_created?: number;
}
