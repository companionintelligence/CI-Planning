import { store } from '../db/store.js';

/** The deliberately small task record visible to a linked account. */
export interface SharedTask {
  id: string;
  title: string;
  status: string;
  priority: number;
  due_at: string | null;
  estimated_minutes: number | null;
  shared_as: Array<'responsible' | 'beneficiary'>;
}

interface SharedTaskRow {
  id: string;
  title: string;
  status: string;
  priority: number;
  due_at: string | null;
  estimated_minutes: number | null;
  responsible: number;
  beneficiary: number;
}

/**
 * Read only tasks another account owner explicitly attached this account to.
 * The recipient gets a list summary, not the source task's full task payload.
 */
export async function listSharedTasks(accountId: string): Promise<SharedTask[]> {
  const rows = await store()
    .prepare(
      `SELECT t.id, t.title, t.status, t.priority, t.due_at, t.estimated_minutes,
              CASE WHEN responsible_person.id IS NULL THEN 0 ELSE 1 END AS responsible,
              CASE WHEN beneficiary_person.id IS NULL THEN 0 ELSE 1 END AS beneficiary
         FROM tasks t
         LEFT JOIN entity_people responsible_link
           ON responsible_link.entity_kind = 'task'
          AND responsible_link.entity_id = t.id
          AND responsible_link.role = 'responsible'
         LEFT JOIN people responsible_person
           ON responsible_person.id = responsible_link.person_id
          AND responsible_person.owner_id = t.owner_id
          AND responsible_person.account_id = ?
         LEFT JOIN entity_people beneficiary_link
           ON beneficiary_link.entity_kind = 'task'
          AND beneficiary_link.entity_id = t.id
          AND beneficiary_link.role = 'beneficiary'
         LEFT JOIN people beneficiary_person
           ON beneficiary_person.id = beneficiary_link.person_id
          AND beneficiary_person.owner_id = t.owner_id
          AND beneficiary_person.account_id = ?
        WHERE t.owner_id <> ?
          AND t.status <> 'cancelled'
          AND (responsible_person.id IS NOT NULL OR beneficiary_person.id IS NOT NULL)
        ORDER BY CASE WHEN t.status = 'done' THEN 1 ELSE 0 END,
                 t.priority ASC,
                 CASE WHEN t.due_at IS NULL THEN 1 ELSE 0 END,
                 t.due_at ASC,
                 t.id ASC`,
    )
    .all<SharedTaskRow>(accountId, accountId, accountId);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    status: row.status,
    priority: row.priority,
    due_at: row.due_at,
    estimated_minutes: row.estimated_minutes,
    shared_as: [
      ...(row.responsible ? ['responsible' as const] : []),
      ...(row.beneficiary ? ['beneficiary' as const] : []),
    ],
  }));
}
