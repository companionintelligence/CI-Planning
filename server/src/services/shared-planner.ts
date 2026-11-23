import { store } from '../db/store.js';
import { newId } from '../lib/ids.js';

export interface SharedPlannerItemInput {
  entity_kind: 'task' | 'objective';
  entity_id: string;
}

export interface SharedPlannerInvite {
  id: string;
  email: string;
  status: 'pending' | 'active' | 'revoked';
  recipient_owner_id: string | null;
  recipient_name: string | null;
  recipient_role: string | null;
  items: Array<SharedPlannerItemInput & { title: string }>;
  created_at: string;
  updated_at: string;
}

export interface GuestSharedTask {
  id: string;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  due_at: string | null;
  scheduled_for: string | null;
  task_time: string | null;
  estimated_minutes: number | null;
  objective_id: string | null;
  objective_title: string | null;
  shared_as: Array<'shared' | 'beneficiary' | 'responsible'>;
}

export interface GuestSharedContent {
  tasks: GuestSharedTask[];
  objectives: Array<{
    id: string;
    title: string;
    description: string | null;
    target_date: string | null;
    status: string;
    priority: number;
  }>;
  blocks: Array<{
    id: string;
    task_id: string;
    title: string;
    start_at: string;
    end_at: string;
  }>;
}

/** Return a foreign task's owner only when this account has current access to it.
 *  Explicit shares, shared-objective tasks, and beneficiary access all point at the
 *  same canonical task row. */
export async function sharedTaskOwnerForRecipient(recipientOwnerId: string, taskId: string): Promise<string | null> {
  const row = await store().prepare(
    `SELECT t.owner_id
       FROM tasks t
      WHERE t.id = ? AND t.owner_id <> ? AND t.status NOT IN ('cancelled', 'archived') AND (
        EXISTS (SELECT 1 FROM shared_planner_items si JOIN shared_planner_invites i ON i.id = si.invite_id
                 WHERE i.recipient_owner_id = ? AND i.status = 'active' AND si.entity_kind = 'task' AND si.entity_id = t.id)
        OR EXISTS (SELECT 1 FROM shared_planner_items si JOIN shared_planner_invites i ON i.id = si.invite_id
                    JOIN objective_tasks ot ON si.entity_kind = 'objective' AND ot.objective_id = si.entity_id AND ot.linked = 1
                    JOIN objectives o ON o.id = ot.objective_id AND o.owner_id = t.owner_id
                   WHERE i.recipient_owner_id = ? AND i.status = 'active' AND ot.task_id = t.id)
        OR EXISTS (SELECT 1 FROM entity_people ep JOIN people p ON p.id = ep.person_id
                   WHERE ep.entity_kind = 'task' AND ep.entity_id = t.id AND ep.role = 'beneficiary'
                     AND p.owner_id = t.owner_id AND p.account_id = ?)
      ) LIMIT 1`,
  ).get<{ owner_id: string }>(taskId, recipientOwnerId, recipientOwnerId, recipientOwnerId, recipientOwnerId);
  return row?.owner_id ?? null;
}

/** Canonical task rows visible in a member's normal task list. The row is not copied:
 *  writes resolve back to `source_owner_id` and update this source record. */
export async function listTasksSharedWithOwner(recipientOwnerId: string): Promise<Array<Record<string, unknown> & { source_owner_id: string; shared_by: string }>> {
  return store().prepare(
    `SELECT DISTINCT t.*, t.owner_id AS source_owner_id, source.name AS shared_by
       FROM tasks t JOIN owners source ON source.id = t.owner_id
      WHERE t.owner_id <> ? AND t.status NOT IN ('cancelled', 'archived') AND COALESCE(t.subtype, 'standard') <> 'quick' AND (
        EXISTS (SELECT 1 FROM shared_planner_items si JOIN shared_planner_invites i ON i.id = si.invite_id
                 WHERE i.recipient_owner_id = ? AND i.status = 'active' AND si.entity_kind = 'task' AND si.entity_id = t.id)
        OR EXISTS (SELECT 1 FROM shared_planner_items si JOIN shared_planner_invites i ON i.id = si.invite_id
                    JOIN objective_tasks ot ON si.entity_kind = 'objective' AND ot.objective_id = si.entity_id AND ot.linked = 1
                    JOIN objectives o ON o.id = ot.objective_id AND o.owner_id = t.owner_id
                   WHERE i.recipient_owner_id = ? AND i.status = 'active' AND ot.task_id = t.id)
        OR EXISTS (SELECT 1 FROM entity_people ep JOIN people p ON p.id = ep.person_id
                   WHERE ep.entity_kind = 'task' AND ep.entity_id = t.id AND ep.role = 'beneficiary'
                     AND p.owner_id = t.owner_id AND p.account_id = ?)
      )
      ORDER BY COALESCE(t.priority, 3), t.due_at, t.id`,
  ).all<Record<string, unknown> & { source_owner_id: string; shared_by: string }>(recipientOwnerId, recipientOwnerId, recipientOwnerId, recipientOwnerId);
}

function uniqueItems(items: SharedPlannerItemInput[]): SharedPlannerItemInput[] {
  const map = new Map<string, SharedPlannerItemInput>();
  for (const item of items) map.set(`${item.entity_kind}:${item.entity_id}`, item);
  return [...map.values()];
}

async function assertItemsOwned(ownerId: string, items: SharedPlannerItemInput[]): Promise<void> {
  const taskIds = items.filter((x) => x.entity_kind === 'task').map((x) => x.entity_id);
  const objectiveIds = items.filter((x) => x.entity_kind === 'objective').map((x) => x.entity_id);
  if (taskIds.length) {
    const rows = await store()
      .prepare(`SELECT id FROM tasks WHERE owner_id = ? AND id IN (${taskIds.map(() => '?').join(',')})`)
      .all<{ id: string }>(ownerId, ...taskIds);
    if (rows.length !== taskIds.length) throw new Error('One or more tasks are not in your planner.');
  }
  if (objectiveIds.length) {
    const rows = await store()
      .prepare(`SELECT id FROM objectives WHERE owner_id = ? AND id IN (${objectiveIds.map(() => '?').join(',')})`)
      .all<{ id: string }>(ownerId, ...objectiveIds);
    if (rows.length !== objectiveIds.length) throw new Error('One or more objectives are not in your planner.');
  }
}

export async function validateSharedPlannerItems(ownerId: string, items: SharedPlannerItemInput[]): Promise<void> {
  await assertItemsOwned(ownerId, uniqueItems(items));
}

export async function createSharedPlannerInvite(
  ownerId: string,
  email: string,
  recipientOwnerId: string | null,
  itemsInput: SharedPlannerItemInput[],
): Promise<SharedPlannerInvite> {
  const items = uniqueItems(itemsInput);
  if (items.length === 0) throw new Error('Choose at least one task or objective to share.');
  await assertItemsOwned(ownerId, items);
  // Email is the stable invite key. It lets a pending invite become an active share
  // when the recipient signs up without colliding with UNIQUE(owner_id, email).
  const existing = await store().prepare(
    `SELECT id FROM shared_planner_invites WHERE owner_id = ? AND lower(email) = lower(?)`,
  ).get<{ id: string }>(ownerId, email);
  const id = existing?.id ?? newId();
  await store().transaction(async () => {
    if (existing) {
      await store().prepare(
        `UPDATE shared_planner_invites SET email = ?, recipient_owner_id = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?`,
      ).run(email, recipientOwnerId, recipientOwnerId ? 'active' : 'pending', id, ownerId);
      await store().prepare(`DELETE FROM shared_planner_items WHERE invite_id = ?`).run(id);
    } else {
      await store().prepare(
        `INSERT INTO shared_planner_invites (id, owner_id, recipient_owner_id, email, status) VALUES (?, ?, ?, ?, ?)`,
      ).run(id, ownerId, recipientOwnerId, email, recipientOwnerId ? 'active' : 'pending');
    }
    const ins = store().prepare(`INSERT INTO shared_planner_items (invite_id, entity_kind, entity_id) VALUES (?, ?, ?)`);
    for (const item of items) await ins.run(id, item.entity_kind, item.entity_id);
  });
  return (await getSharedPlannerInvite(ownerId, id))!;
}

export async function updateSharedPlannerInvite(
  ownerId: string,
  inviteId: string,
  items: SharedPlannerItemInput[],
): Promise<SharedPlannerInvite | undefined> {
  const invite = await store().prepare(
    `SELECT recipient_owner_id FROM shared_planner_invites WHERE id = ? AND owner_id = ? AND status <> 'revoked'`,
  ).get<{ recipient_owner_id: string | null }>(inviteId, ownerId);
  if (!invite) return undefined;
  const unique = uniqueItems(items);
  if (unique.length === 0) throw new Error('Keep at least one shared task or objective, or revoke this invite.');
  await assertItemsOwned(ownerId, unique);
  await store().transaction(async () => {
    await store().prepare(`DELETE FROM shared_planner_items WHERE invite_id = ?`).run(inviteId);
    const ins = store().prepare(`INSERT INTO shared_planner_items (invite_id, entity_kind, entity_id) VALUES (?, ?, ?)`);
    for (const item of unique) await ins.run(inviteId, item.entity_kind, item.entity_id);
    await store().prepare(`UPDATE shared_planner_invites SET updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?`).run(inviteId, ownerId);
  });
  return getSharedPlannerInvite(ownerId, inviteId);
}

export async function revokeSharedPlannerInvite(ownerId: string, inviteId: string): Promise<boolean> {
  const res = await store().prepare(
    `UPDATE shared_planner_invites SET status = 'revoked', updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ? AND status <> 'revoked'`,
  ).run(inviteId, ownerId);
  return res.changes > 0;
}

export async function getSharedPlannerInvite(ownerId: string, inviteId: string): Promise<SharedPlannerInvite | undefined> {
  const invite = await store().prepare(
    `SELECT i.id, i.email, i.status, i.recipient_owner_id, r.name AS recipient_name,
            r.role AS recipient_role, i.created_at, i.updated_at
       FROM shared_planner_invites i
       LEFT JOIN owners r ON r.id = i.recipient_owner_id
      WHERE i.id = ? AND i.owner_id = ?`,
  ).get<Omit<SharedPlannerInvite, 'items'> & { created_at: string; updated_at: string }>(inviteId, ownerId);
  if (!invite) return undefined;
  const items = await store().prepare(
    `SELECT si.entity_kind, si.entity_id,
            CASE WHEN si.entity_kind = 'task' THEN t.title ELSE o.title END AS title
       FROM shared_planner_items si
       LEFT JOIN tasks t ON si.entity_kind = 'task' AND t.id = si.entity_id AND t.owner_id = ?
       LEFT JOIN objectives o ON si.entity_kind = 'objective' AND o.id = si.entity_id AND o.owner_id = ?
      WHERE si.invite_id = ? ORDER BY si.entity_kind, title COLLATE NOCASE`,
  ).all<{ entity_kind: 'task' | 'objective'; entity_id: string; title: string | null }>(ownerId, ownerId, inviteId);
  return { ...invite, items: items.map((item) => ({ ...item, title: item.title ?? 'Unavailable item' })) };
}

export async function listSharedPlannerInvites(ownerId: string): Promise<SharedPlannerInvite[]> {
  const ids = await store().prepare(`SELECT id FROM shared_planner_invites WHERE owner_id = ? ORDER BY updated_at DESC, id`).all<{ id: string }>(ownerId);
  const invites = await Promise.all(ids.map((row) => getSharedPlannerInvite(ownerId, row.id)));
  return invites.filter((row): row is SharedPlannerInvite => !!row);
}

export async function hasPendingSharedInvite(email: string | null | undefined): Promise<boolean> {
  if (!email) return false;
  return !!(await store().prepare(
    `SELECT 1 FROM shared_planner_invites WHERE lower(email) = lower(?) AND recipient_owner_id IS NULL AND status = 'pending' LIMIT 1`,
  ).get(email));
}

export async function activatePendingSharedInvites(recipientOwnerId: string, email: string | null | undefined): Promise<void> {
  if (!email) return;
  await store().prepare(
    `UPDATE shared_planner_invites SET recipient_owner_id = ?, status = 'active', updated_at = CURRENT_TIMESTAMP
      WHERE lower(email) = lower(?) AND recipient_owner_id IS NULL AND status = 'pending'`,
  ).run(recipientOwnerId, email);
}

export async function listGuestSharedContent(recipientOwnerId: string): Promise<GuestSharedContent> {
  const tasks = await store().prepare(
    `SELECT DISTINCT t.id, t.owner_id AS source_owner_id, t.title, t.description, t.status,
            COALESCE(t.priority, 3) AS priority, t.due_at, t.scheduled_for, t.task_time,
            t.estimated_minutes,
            (SELECT ot.objective_id FROM objective_tasks ot
              JOIN objectives o ON o.id = ot.objective_id AND o.owner_id = t.owner_id
             WHERE ot.task_id = t.id AND ot.linked = 1 AND EXISTS (
               SELECT 1 FROM shared_planner_items si JOIN shared_planner_invites i ON i.id = si.invite_id
                WHERE i.recipient_owner_id = ? AND i.status = 'active' AND si.entity_kind = 'objective' AND si.entity_id = o.id
             ) ORDER BY ot.objective_id LIMIT 1) AS objective_id,
            (SELECT o.title FROM objective_tasks ot
              JOIN objectives o ON o.id = ot.objective_id AND o.owner_id = t.owner_id
             WHERE ot.task_id = t.id AND ot.linked = 1 AND EXISTS (
               SELECT 1 FROM shared_planner_items si JOIN shared_planner_invites i ON i.id = si.invite_id
                WHERE i.recipient_owner_id = ? AND i.status = 'active' AND si.entity_kind = 'objective' AND si.entity_id = o.id
             ) ORDER BY ot.objective_id LIMIT 1) AS objective_title,
            CASE WHEN EXISTS (
              SELECT 1 FROM shared_planner_items si JOIN shared_planner_invites i ON i.id = si.invite_id
               WHERE i.recipient_owner_id = ? AND i.status = 'active' AND si.entity_kind = 'task' AND si.entity_id = t.id
            ) OR EXISTS (
              SELECT 1 FROM shared_planner_items si JOIN shared_planner_invites i ON i.id = si.invite_id
               JOIN objective_tasks ot ON si.entity_kind = 'objective' AND ot.objective_id = si.entity_id AND ot.linked = 1
               JOIN objectives o ON o.id = ot.objective_id AND o.owner_id = t.owner_id
               WHERE i.recipient_owner_id = ? AND i.status = 'active' AND ot.task_id = t.id
            ) THEN 1 ELSE 0 END AS explicit_share,
            CASE WHEN EXISTS (
              SELECT 1 FROM entity_people ep JOIN people p ON p.id = ep.person_id
               WHERE ep.entity_kind = 'task' AND ep.entity_id = t.id AND ep.role = 'beneficiary'
                 AND p.owner_id = t.owner_id AND p.account_id = ?
            ) THEN 1 ELSE 0 END AS beneficiary,
            CASE WHEN EXISTS (
              SELECT 1 FROM entity_people ep JOIN people p ON p.id = ep.person_id
               WHERE ep.entity_kind = 'task' AND ep.entity_id = t.id AND ep.role = 'responsible'
                 AND p.owner_id = t.owner_id AND p.account_id = ?
            ) THEN 1 ELSE 0 END AS responsible
       FROM tasks t
      WHERE t.owner_id <> ? AND t.status NOT IN ('cancelled', 'archived') AND (
        EXISTS (SELECT 1 FROM shared_planner_items si JOIN shared_planner_invites i ON i.id = si.invite_id
                 WHERE i.recipient_owner_id = ? AND i.status = 'active' AND si.entity_kind = 'task' AND si.entity_id = t.id)
        OR EXISTS (SELECT 1 FROM shared_planner_items si JOIN shared_planner_invites i ON i.id = si.invite_id
                    JOIN objective_tasks ot ON si.entity_kind = 'objective' AND ot.objective_id = si.entity_id AND ot.linked = 1
                    JOIN objectives o ON o.id = ot.objective_id AND o.owner_id = t.owner_id
                   WHERE i.recipient_owner_id = ? AND i.status = 'active' AND ot.task_id = t.id)
        OR EXISTS (SELECT 1 FROM entity_people ep JOIN people p ON p.id = ep.person_id
                   WHERE ep.entity_kind = 'task' AND ep.entity_id = t.id AND ep.role = 'beneficiary'
                     AND p.owner_id = t.owner_id AND p.account_id = ?)
      )
      ORDER BY CASE WHEN t.status = 'done' THEN 1 ELSE 0 END, t.priority, t.due_at, t.id`,
  ).all<{
    id: string; source_owner_id: string; title: string; description: string | null; status: string; priority: number;
    due_at: string | null; scheduled_for: string | null; task_time: string | null; estimated_minutes: number | null;
    objective_id: string | null; objective_title: string | null; explicit_share: number; beneficiary: number; responsible: number;
  }>(recipientOwnerId, recipientOwnerId, recipientOwnerId, recipientOwnerId, recipientOwnerId, recipientOwnerId, recipientOwnerId, recipientOwnerId, recipientOwnerId, recipientOwnerId);

  const objectives = await store().prepare(
    `SELECT DISTINCT o.id, o.title, o.description, o.target_date, o.status,
            COALESCE(o.priority, 3) AS priority
       FROM shared_planner_items si JOIN shared_planner_invites i ON i.id = si.invite_id
       JOIN objectives o ON si.entity_kind = 'objective' AND o.id = si.entity_id
      WHERE i.recipient_owner_id = ? AND i.status = 'active' AND o.owner_id <> ?
      ORDER BY o.target_date, o.title COLLATE NOCASE`,
  ).all<GuestSharedContent['objectives'][number]>(recipientOwnerId, recipientOwnerId);

  const blocks = tasks.length === 0 ? [] : await store().prepare(
    `SELECT DISTINCT b.id, b.task_id, b.title, b.start_at, b.end_at
       FROM time_blocks b JOIN tasks t ON t.id = b.task_id AND t.owner_id = b.owner_id
      WHERE b.owner_id <> ? AND b.task_id IN (${tasks.map(() => '?').join(',')})
        AND b.status NOT IN ('cancelled', 'archived') ORDER BY b.start_at`,
  ).all<GuestSharedContent['blocks'][number]>(recipientOwnerId, ...tasks.map((t) => t.id));

  return {
    tasks: tasks.map((t) => ({
      id: t.id, title: t.title, description: t.description,
      status: t.status, priority: t.priority, due_at: t.due_at, scheduled_for: t.scheduled_for,
      task_time: t.task_time, estimated_minutes: t.estimated_minutes, objective_id: t.objective_id,
      objective_title: t.objective_title,
      shared_as: [
        ...(t.explicit_share ? ['shared' as const] : []),
        ...(t.beneficiary ? ['beneficiary' as const] : []),
        ...(t.responsible ? ['responsible' as const] : []),
      ],
    })),
    objectives,
    blocks,
  };
}
