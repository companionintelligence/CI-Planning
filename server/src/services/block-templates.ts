import { sqlite } from '../db/index.js';
import { writeAudit } from '../lib/audit.js';

/**
 * Reusable Time-Block templates (Phase G, G3 + PR-B) — a named, tagged Plan container
 * with a default duration, optionally carrying the tasks that sat inside it. Owner-scoped.
 *
 * Phase W (Decision 3): the template CRUD (list/get/create/update/delete) is extracted
 * here so REST (routes/block-templates.ts) + GraphQL (block-template-resolvers.ts) share
 * ONE owner-scoped implementation — `block-templates.test.ts` is the byte-equivalence lock.
 * `writeAudit` fires INSIDE these functions (the tags/patterns-service precedent); SSE
 * `broadcast` stays transport-side (route + resolver each fire it).
 *
 * The engine-ish handlers (instantiate, apply-to-block) — which materialize real
 * time_blocks/tasks onto a day — stay in the route (GraphQL engine ops are a later
 * ticket, like flight-plan's Auto and patterns' promote). They reuse the shared
 * `parseTasks`/`serializeBlock`/`materializeTemplateTasks` helpers exported here.
 *
 * better-sqlite3 is synchronous; these are plain sync functions.
 */

export interface TemplateTask {
  title: string;
  tag?: string | null;
  estimated_minutes?: number | null;
  offset_minutes?: number;
}
export interface TemplateRow {
  id: string;
  owner_id: string;
  name: string;
  tag: string | null;
  default_minutes: number;
  tasks: string | null; // JSON TemplateTask[]
}

export function parseTasks(raw: string | null): TemplateTask[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

/** The exact REST payload for a template (snake_case + parsed `tasks` array). */
export const serializeTemplate = (t: TemplateRow) => ({
  id: t.id, owner_id: t.owner_id, name: t.name, tag: t.tag, default_minutes: t.default_minutes, tasks: parseTasks(t.tasks),
});

/** Coerce a raw time_block row into the REST block payload (derived booleans). */
export const serializeBlock = (b: Record<string, unknown>) => ({
  ...b,
  is_locked: !!b.is_locked,
  is_auto: !!b.is_auto,
  all_day: !!b.all_day,
});

/**
 * Recreate a template's saved tasks near `baseMs`: for each, a real `open` task +
 * its `block_kind='task'` block at `base + offset_minutes`. `parentBlockId` parents
 * the task blocks to a container (apply-to-block) or leaves them loose (instantiate,
 * pass null — byte-identical to the pre-refactor behavior). Returns the new task ids.
 */
export function materializeTemplateTasks(owner: string, baseMs: number, templateTasks: TemplateTask[], parentBlockId: string | null): string[] {
  const insTask = sqlite.prepare(
    `INSERT INTO tasks (id, title, estimated_minutes, owner_id, status, priority, source_kind) VALUES (uuid7(), ?, ?, ?, 'open', 3, 'manual') RETURNING id`,
  );
  const insBlock = sqlite.prepare(
    `INSERT INTO time_blocks (id, task_id, owner_id, title, block_kind, tag, start_at, end_at, is_locked, is_auto, source_kind, status, parent_block_id)
     VALUES (uuid7(), ?, ?, ?, 'task', ?, ?, ?, 0, 0, 'manual', 'planned', ?)`,
  );
  const createdTaskIds: string[] = [];
  for (const tk of templateTasks) {
    const est = tk.estimated_minutes ?? 30;
    const id = (insTask.get(tk.title, tk.estimated_minutes ?? null, owner) as { id: string }).id;
    const s = new Date(baseMs + (tk.offset_minutes ?? 0) * 60_000).toISOString();
    const e = new Date(Date.parse(s) + est * 60_000).toISOString();
    insBlock.run(id, owner, tk.title, tk.tag ?? null, s, e, parentBlockId);
    createdTaskIds.push(id);
  }
  return createdTaskIds;
}

// ── CRUD (owner-scoped; shared by REST + GraphQL) ─────────────────────────────

/** The owner's saved templates, ordered by name. */
export function listBlockTemplates(owner: string): TemplateRow[] {
  return sqlite.prepare(`SELECT * FROM block_templates WHERE owner_id = ? ORDER BY name`).all(owner) as TemplateRow[];
}

/** One of the owner's templates by id, or undefined (a cross-owner id is invisible). */
export function getBlockTemplate(owner: string, id: string): TemplateRow | undefined {
  return sqlite.prepare(`SELECT * FROM block_templates WHERE id = ? AND owner_id = ?`).get(id, owner) as TemplateRow | undefined;
}

/**
 * Normalize a freeform `tag`: trim, and treat empty/whitespace-only as NULL — so a
 * meaningless "" or "   " never persists and reads back as an empty tag. Shared by create
 * + update so tag semantics are identical across both CRUD paths and both transports
 * (mirrors how `name` is trimmed above). Unifies the pre-refactor REST split where create
 * used `tag ?? null` (kept "") and update used `tag || null` (dropped "" but not "   ").
 */
const normalizeTag = (t: string | null | undefined): string | null => {
  const v = t?.trim();
  return v ? v : null;
};

export type CreateBlockTemplateInput = { name?: string | null; tag?: string | null; default_minutes?: number | null; tasks?: TemplateTask[] | null };
export type CreateResult = { ok: true; row: TemplateRow } | { ok: false; error: 'name_required' };

/** Create a template. `name` is required (422 in REST); `default_minutes` defaults to 60;
 *  an empty/absent `tasks` array stores NULL (mirrors the REST handler exactly). */
export function createBlockTemplate(owner: string, input: CreateBlockTemplateInput): CreateResult {
  if (!input.name?.trim()) return { ok: false, error: 'name_required' };
  const tasksJson = Array.isArray(input.tasks) && input.tasks.length ? JSON.stringify(input.tasks) : null;
  const row = sqlite
    .prepare(`INSERT INTO block_templates (id, owner_id, name, tag, default_minutes, tasks) VALUES (uuid7(), ?, ?, ?, ?, ?) RETURNING *`)
    .get(owner, input.name.trim(), normalizeTag(input.tag), input.default_minutes ?? 60, tasksJson) as TemplateRow;
  writeAudit({ ownerId: owner, actor: 'owner', action: 'create', entity: `block-template:${row.id}` });
  return { ok: true, row };
}

export type UpdateBlockTemplateInput = { name?: string; tag?: string | null; default_minutes?: number };
export type UpdateResult = { ok: true; row: TemplateRow } | { ok: false; error: 'not_found' | 'name_required' };

/**
 * Edit a saved template (name / tag / default duration). Owner-scoped: an unknown/cross-
 * owner id is not_found. Only the keys the caller sent are written (absent = preserve);
 * a blank name is rejected (name_required). The saved `tasks` are captured via "save as
 * template", so this never touches them — mirrors the REST PATCH exactly.
 */
export function updateBlockTemplate(owner: string, id: string, input: UpdateBlockTemplateInput): UpdateResult {
  const existing = getBlockTemplate(owner, id);
  if (!existing) return { ok: false, error: 'not_found' };
  const name = input.name !== undefined ? input.name.trim() : existing.name;
  if (!name) return { ok: false, error: 'name_required' };
  const row = sqlite
    .prepare(`UPDATE block_templates SET name = ?, tag = ?, default_minutes = ? WHERE id = ? AND owner_id = ? RETURNING *`)
    .get(
      name,
      input.tag !== undefined ? normalizeTag(input.tag) : existing.tag,
      input.default_minutes !== undefined ? input.default_minutes : existing.default_minutes,
      id, owner,
    ) as TemplateRow;
  writeAudit({ ownerId: owner, actor: 'owner', action: 'update', entity: `block-template:${row.id}` });
  return { ok: true, row };
}

export type DeleteResult = { ok: true } | { ok: false; error: 'not_found' };

/** Delete a template (owner-scoped). An unknown/cross-owner id is not_found. */
export function deleteBlockTemplate(owner: string, id: string): DeleteResult {
  const r = sqlite.prepare(`DELETE FROM block_templates WHERE id = ? AND owner_id = ?`).run(id, owner);
  if (r.changes === 0) return { ok: false, error: 'not_found' };
  writeAudit({ ownerId: owner, actor: 'owner', action: 'delete', entity: `block-template:${id}` });
  return { ok: true };
}
