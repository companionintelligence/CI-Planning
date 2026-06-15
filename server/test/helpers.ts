import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildApp } from '../src/app.js';
import { sqlite } from '../src/db/index.js';
import { status } from '../src/mcp/ollama.js';

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

/** Start the Koa app on an ephemeral port. */
export async function startTestServer(): Promise<TestServer> {
  const app = buildApp();
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Clear task-related tables; keep owner / prefs / scheduled_jobs seeded by setup. */
export function resetDb(): void {
  sqlite.exec(`
    DELETE FROM task_dependencies;
    DELETE FROM task_tags;
    DELETE FROM possible_task_tags;
    DELETE FROM time_entries;
    DELETE FROM time_blocks;
    DELETE FROM possible_tasks;
    DELETE FROM tasks;
    DELETE FROM tags;
    DELETE FROM job_runs;
    DELETE FROM daily_summaries;
  `);
}

/** Convenience JSON fetch wrapper. */
export async function api<T = any>(
  base: string,
  path: string,
  init?: RequestInit & { json?: unknown }
): Promise<{ status: number; body: T }> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(`${base}${path}`, {
    ...rest,
    headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : (undefined as T) };
}

let _ollamaUp: boolean | null = null;
/** Cached Ollama readiness so LLM-dependent tests can skip when service/models are unavailable. */
export async function ollamaAvailable(): Promise<boolean> {
  if (_ollamaUp === null) {
    const s = await status();
    const models = new Set(s.models);
    _ollamaUp =
      s.available &&
      models.has(s.smallModel) &&
      models.has(s.mediumModel) &&
      models.has(s.embedModel);
  }
  return _ollamaUp;
}
