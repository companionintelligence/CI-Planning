import { randomUUID } from 'node:crypto';
import { store } from '../db/store.js';

export interface ObjectiveBoardColumn {
  id: string;
  name: string;
  system_key: 'open' | 'in_work' | 'done' | null;
  position: number;
}

export interface ObjectiveBoardCard {
  id: string;
  title: string;
  search_text: string;
  status: string;
  priority: number | null;
  due_at: string | null;
  estimated_minutes: number | null;
  auto_generated: boolean;
  human_approved_at: string | null;
  objective_ids: string[];
  column_id: string;
  position: number;
}

const DEFAULT_COLUMNS = [
  { system_key: 'open', name: 'Open', position: 0 },
  { system_key: 'in_work', name: 'In work', position: 1 },
  { system_key: 'done', name: 'Done', position: 2 },
] as const;
const MAX_COLUMNS = 12;

async function ensureDefaultColumns(ownerId: string): Promise<void> {
  const db = store();
  for (const col of DEFAULT_COLUMNS) {
    await db.prepare(
      `INSERT OR IGNORE INTO objective_board_columns (id, owner_id, name, system_key, position, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), ownerId, col.name, col.system_key, col.position, new Date().toISOString());
  }
}

export async function listObjectiveBoard(ownerId: string): Promise<{
  columns: ObjectiveBoardColumn[];
  cards: ObjectiveBoardCard[];
}> {
  await ensureDefaultColumns(ownerId);
  const db = store();
  const columns = await db.prepare(
    `SELECT id, name, system_key, position
       FROM objective_board_columns WHERE owner_id = ? ORDER BY position, created_at, id`,
  ).all<ObjectiveBoardColumn>(ownerId);
  const byKey = new Map(columns.filter((c) => c.system_key).map((c) => [c.system_key!, c.id]));
  const openId = byKey.get('open')!;
  const inWorkId = byKey.get('in_work')!;
  const doneId = byKey.get('done')!;
  const rows = await db.prepare(
    `SELECT t.id, t.title, t.status, t.priority, t.due_at, t.estimated_minutes,
            t.auto_generated, t.human_approved_at,
            TRIM(
              COALESCE(t.description, '') || ' ' || COALESCE(t.notes, '') || ' ' ||
              COALESCE((SELECT GROUP_CONCAT(g.name, ' ')
                          FROM entity_tags et JOIN tags g ON g.id = et.tag_id
                         WHERE et.entity_kind = 'task' AND et.entity_id = t.id), '') || ' ' ||
              COALESCE((SELECT GROUP_CONCAT(c.name, ' ')
                          FROM entity_categories ec JOIN tags c ON c.id = ec.category_tag_id
                         WHERE ec.entity_kind = 'task' AND ec.entity_id = t.id), '')
            ) AS search_text,
            GROUP_CONCAT(DISTINCT o.id) AS objective_ids,
            bc.column_id, bc.position
       FROM tasks t
       JOIN objective_tasks ot ON ot.task_id = t.id AND ot.linked = 1
       JOIN objectives o ON o.id = ot.objective_id AND o.owner_id = t.owner_id AND o.archived_at IS NULL
       LEFT JOIN objective_board_cards bc ON bc.owner_id = t.owner_id AND bc.task_id = t.id
      WHERE t.owner_id = ? AND t.status <> 'cancelled'
      GROUP BY t.id
      ORDER BY t.created_at, t.id`,
  ).all<{
    id: string; title: string; status: string; priority: number | null; due_at: string | null;
    search_text: string | null;
    estimated_minutes: number | null; auto_generated: number | boolean; human_approved_at: string | null;
    objective_ids: string | null; column_id: string | null;
    position: number | null;
  }>(ownerId);

  const columnFor = (row: { status: string; column_id: string | null }) => row.status === 'done'
    ? doneId
    : row.column_id && row.column_id !== doneId
      ? row.column_id
      : row.status === 'in_progress' ? inWorkId : openId;
  const nextPosition = new Map<string, number>();
  for (const row of rows) {
    const id = columnFor(row);
    nextPosition.set(id, Math.max(nextPosition.get(id) ?? 0, (row.position ?? -1) + 1));
  }
  const cards = rows.map((row) => {
    const column_id = columnFor(row);
    let position = row.position;
    if (position == null) {
      position = nextPosition.get(column_id) ?? 0;
      nextPosition.set(column_id, position + 1);
    }
    return {
      id: row.id,
      title: row.title,
      search_text: row.search_text ?? '',
      status: row.status,
      priority: row.priority,
      due_at: row.due_at,
      estimated_minutes: row.estimated_minutes,
      auto_generated: Boolean(row.auto_generated),
      human_approved_at: row.human_approved_at,
      objective_ids: row.objective_ids ? row.objective_ids.split(',') : [],
      column_id,
      position,
    };
  });
  cards.sort((a, b) => a.column_id.localeCompare(b.column_id) || a.position - b.position || a.title.localeCompare(b.title));
  return { columns, cards };
}

export async function addObjectiveBoardColumn(ownerId: string, rawName: string): Promise<
  { ok: true; column: ObjectiveBoardColumn } | { ok: false; error: 'invalid_name' | 'duplicate_name' | 'too_many' }
> {
  const name = rawName.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 32) return { ok: false, error: 'invalid_name' };
  await ensureDefaultColumns(ownerId);
  const db = store();
  const count = await db.prepare(`SELECT COUNT(*) AS n FROM objective_board_columns WHERE owner_id = ?`).get<{ n: number }>(ownerId);
  if ((count?.n ?? 0) >= MAX_COLUMNS) return { ok: false, error: 'too_many' };
  const duplicate = await db.prepare(
    `SELECT id FROM objective_board_columns WHERE owner_id = ? AND lower(name) = lower(?) LIMIT 1`,
  ).get<{ id: string }>(ownerId, name);
  if (duplicate) return { ok: false, error: 'duplicate_name' };
  const position = await db.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 AS position FROM objective_board_columns WHERE owner_id = ?`,
  ).get<{ position: number }>(ownerId);
  const column = { id: randomUUID(), name, system_key: null, position: position?.position ?? 3 } as ObjectiveBoardColumn;
  await db.prepare(
    `INSERT INTO objective_board_columns (id, owner_id, name, system_key, position, created_at) VALUES (?, ?, ?, NULL, ?, ?)`,
  ).run(column.id, ownerId, column.name, column.position, new Date().toISOString());
  return { ok: true, column };
}

export async function removeObjectiveBoardColumn(ownerId: string, columnId: string): Promise<
  { ok: true } | { ok: false; error: 'not_found' | 'system_column' }
> {
  await ensureDefaultColumns(ownerId);
  const db = store();
  const column = await db.prepare(
    `SELECT id, system_key FROM objective_board_columns WHERE id = ? AND owner_id = ?`,
  ).get<{ id: string; system_key: string | null }>(columnId, ownerId);
  if (!column) return { ok: false, error: 'not_found' };
  if (column.system_key) return { ok: false, error: 'system_column' };
  const open = await db.prepare(
    `SELECT id FROM objective_board_columns WHERE owner_id = ? AND system_key = 'open'`,
  ).get<{ id: string }>(ownerId);
  if (!open) throw new Error('default Open column is missing');
  await db.transaction(async () => {
    const current = await db.prepare(
      `SELECT task_id FROM objective_board_cards WHERE owner_id = ? AND column_id = ? ORDER BY position, task_id`,
    ).all<{ task_id: string }>(ownerId, columnId);
    const last = await db.prepare(
      `SELECT COALESCE(MAX(position), -1) AS position FROM objective_board_cards WHERE owner_id = ? AND column_id = ?`,
    ).get<{ position: number }>(ownerId, open.id);
    let position = (last?.position ?? -1) + 1;
    for (const card of current) {
      await db.prepare(
        `UPDATE objective_board_cards SET column_id = ?, position = ?, updated_at = ? WHERE owner_id = ? AND task_id = ?`,
      ).run(open.id, position++, new Date().toISOString(), ownerId, card.task_id);
    }
    await db.prepare(`DELETE FROM objective_board_columns WHERE id = ? AND owner_id = ?`).run(columnId, ownerId);
  });
  return { ok: true };
}

export async function moveObjectiveBoardCard(ownerId: string, taskId: string, columnId: string, beforeTaskId?: string): Promise<
  { ok: true } | { ok: false; error: 'task_not_found' | 'column_not_found' }
> {
  const db = store();
  const task = await db.prepare(
    `SELECT t.id FROM tasks t
      WHERE t.id = ? AND t.owner_id = ? AND t.status <> 'cancelled'
        AND EXISTS (
          SELECT 1 FROM objective_tasks ot JOIN objectives o ON o.id = ot.objective_id
           WHERE ot.task_id = t.id AND ot.linked = 1 AND o.owner_id = ? AND o.archived_at IS NULL
        )`,
  ).get<{ id: string }>(taskId, ownerId, ownerId);
  if (!task) return { ok: false, error: 'task_not_found' };
  const column = await db.prepare(
    `SELECT id FROM objective_board_columns WHERE id = ? AND owner_id = ?`,
  ).get<{ id: string }>(columnId, ownerId);
  if (!column) return { ok: false, error: 'column_not_found' };

  const board = await listObjectiveBoard(ownerId);
  const ordered = board.cards
    .filter((card) => card.column_id === columnId && card.id !== taskId)
    .sort((a, b) => a.position - b.position || a.title.localeCompare(b.title));
  let index = beforeTaskId ? ordered.findIndex((card) => card.id === beforeTaskId) : -1;
  if (index < 0) index = ordered.length;
  ordered.splice(index, 0, board.cards.find((card) => card.id === taskId) ?? {
    id: taskId, title: '', search_text: '', status: 'open', priority: null, due_at: null, estimated_minutes: null,
    auto_generated: false, human_approved_at: null,
    objective_ids: [], column_id: columnId, position: 0,
  });
  const now = new Date().toISOString();
  await db.transaction(async () => {
    for (let position = 0; position < ordered.length; position++) {
      await db.prepare(
        `INSERT INTO objective_board_cards (owner_id, task_id, column_id, position, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(owner_id, task_id) DO UPDATE SET column_id = excluded.column_id, position = excluded.position, updated_at = excluded.updated_at`,
      ).run(ownerId, ordered[position].id, columnId, position, now);
    }
  });
  return { ok: true };
}
