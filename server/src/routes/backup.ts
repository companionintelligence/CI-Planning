import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from './sse.js';
import { writeAudit } from '../lib/audit.js';

const EXPORT_VERSION = '1';

// Tables that require only the owner_id for a direct export query.
const OWNER_TABLES = [
  'scheduling_prefs',
  'daily_summaries',
  'pattern_types',
  'patterns',
  'tasks',
  'block_templates',
  'pattern_blocks',
  'pattern_prefs',
  'category_prefs',
  'flight_plan',
  'time_entries',
  'reminders',
  'push_subscriptions',
] as const;

/** Insert rows using their own column names. */
function insertRows(table: string, rows: Record<string, unknown>[]): number {
  if (!rows.length) return 0;
  const cols = Object.keys(rows[0]);
  const stmt = sqlite.prepare(
    `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  );
  for (const row of rows) {
    stmt.run(cols.map((c) => row[c]));
  }
  return rows.length;
}

export function backupRouter() {
  const router = new Router({ prefix: '/api' });

  // GET /api/export — dump all owner data as a downloadable JSON file.
  router.get('/export', (ctx) => {
    const ownerId = currentOwnerId();

    // Collect owner-scoped table rows.
    const ownerData: Record<string, unknown[]> = {};
    for (const t of OWNER_TABLES) {
      ownerData[t] = sqlite.prepare(`SELECT * FROM ${t} WHERE owner_id = ?`).all(ownerId) as unknown[];
    }

    // Tables with no direct owner_id — scope via owner's task/pattern ids.
    const taskIdsRaw = sqlite
      .prepare('SELECT id FROM tasks WHERE owner_id = ?')
      .all(ownerId) as { id: string }[];
    const patternIdsRaw = sqlite
      .prepare('SELECT id FROM patterns WHERE owner_id = ?')
      .all(ownerId) as { id: string }[];

    const taskIds = taskIdsRaw.map((r) => r.id);
    const patternIds = patternIdsRaw.map((r) => r.id);

    // v0.2 single-owner: full table dump so CONTAINER blocks (block_kind='timeblock',
    // task_id IS NULL — incl. Time Block Category containers) are exported too. A
    // task_id-scoped query silently dropped them (and now their category_id/color_token).
    const timeBlocks = sqlite.prepare(`SELECT * FROM time_blocks`).all();
    const blockIds = (timeBlocks as { id: string }[]).map((b) => b.id);

    const patternTasks = patternIds.length
      ? sqlite
          .prepare(`SELECT * FROM pattern_tasks WHERE pattern_id IN (${patternIds.map(() => '?').join(',')})`)
          .all(patternIds)
      : [];

    const taskDeps = taskIds.length
      ? sqlite
          .prepare(`SELECT * FROM task_dependencies WHERE task_id IN (${taskIds.map(() => '?').join(',')})`)
          .all(taskIds)
      : [];

    const entityTagIds = [...taskIds, ...patternIds, ...blockIds];
    const entityTags = entityTagIds.length
      ? sqlite
          .prepare(`SELECT * FROM entity_tags WHERE entity_id IN (${entityTagIds.map(() => '?').join(',')})`)
          .all(entityTagIds)
      : [];

    const possibleTasks = sqlite
      .prepare('SELECT * FROM possible_tasks WHERE proposed_owner_id = ?')
      .all(ownerId) as { id: string }[];
    const ptIds = possibleTasks.map((p) => p.id);
    const possibleTaskTags = ptIds.length
      ? sqlite
          .prepare(`SELECT * FROM possible_task_tags WHERE possible_task_id IN (${ptIds.map(() => '?').join(',')})`)
          .all(ptIds)
      : [];

    const payload = {
      version: EXPORT_VERSION,
      owner_id: ownerId,
      exported_at: new Date().toISOString(),
      scheduling_prefs: ownerData['scheduling_prefs'],
      tags: sqlite.prepare('SELECT * FROM tags').all(),
      tag_patterns: sqlite.prepare('SELECT * FROM tag_patterns').all(),
      tag_categories: sqlite.prepare('SELECT * FROM tag_categories').all(),
      category_direction_optouts: sqlite.prepare('SELECT * FROM category_direction_optouts').all(),
      pattern_types: ownerData['pattern_types'],
      patterns: ownerData['patterns'],
      tasks: ownerData['tasks'],
      pattern_tasks: patternTasks,
      time_blocks: timeBlocks,
      task_dependencies: taskDeps,
      block_templates: ownerData['block_templates'],
      pattern_blocks: ownerData['pattern_blocks'],
      pattern_prefs: ownerData['pattern_prefs'],
      category_prefs: ownerData['category_prefs'],
      flight_plan: ownerData['flight_plan'],
      time_entries: ownerData['time_entries'],
      entity_tags: entityTags,
      possible_tasks: possibleTasks,
      possible_task_tags: possibleTaskTags,
      reminders: ownerData['reminders'],
      push_subscriptions: ownerData['push_subscriptions'],
      daily_summaries: ownerData['daily_summaries'],
    };

    const date = new Date().toISOString().slice(0, 10);
    ctx.set('Content-Type', 'application/json; charset=utf-8');
    ctx.set('Content-Disposition', `attachment; filename="companion-export-${date}.json"`);
    ctx.body = JSON.stringify(payload, null, 2);
  });

  // POST /api/import — replace owner partition from a JSON export.
  router.post('/import', (ctx) => {
    const ownerId = currentOwnerId();
    const body = ctx.request.body as Record<string, unknown>;

    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      ctx.status = 400;
      ctx.body = { error: 'Expected JSON body' };
      return;
    }
    if (!body['version']) {
      ctx.status = 400;
      ctx.body = { error: 'Missing export version' };
      return;
    }
    if (body['version'] !== EXPORT_VERSION) {
      ctx.status = 400;
      ctx.body = { error: `Unsupported export version '${body['version']}'; expected '${EXPORT_VERSION}'` };
      return;
    }
    if (body['owner_id'] !== ownerId) {
      ctx.status = 403;
      ctx.body = { error: 'Export owner_id does not match current owner' };
      return;
    }
    for (const key of ['scheduling_prefs', 'tags', 'tasks', 'patterns'] as const) {
      if (!Array.isArray(body[key])) {
        ctx.status = 400;
        ctx.body = { error: `Missing or invalid field: ${key}` };
        return;
      }
    }

    const counts: Record<string, number> = {};

    sqlite.transaction(() => {
      // Defer FK checks to COMMIT so a full-table restore is order-independent — e.g.
      // time_blocks containers + their child task-blocks (parent_block_id), and the new
      // category_id refs. The complete dataset is consistent at commit. Auto-resets at tx end.
      sqlite.exec('PRAGMA defer_foreign_keys=ON');
      // ── Delete in reverse FK order ─────────────────────────────────────────
      sqlite.prepare('DELETE FROM push_subscriptions WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM reminders WHERE owner_id = ?').run(ownerId);
      sqlite.prepare(`DELETE FROM possible_task_tags
        WHERE possible_task_id IN (SELECT id FROM possible_tasks WHERE proposed_owner_id = ?)`).run(ownerId);
      sqlite.prepare('DELETE FROM possible_tasks WHERE proposed_owner_id = ?').run(ownerId);
      // entity_tags has no direct owner_id — delete by entity membership.
      sqlite.prepare(`DELETE FROM entity_tags WHERE entity_id IN (
        SELECT id FROM tasks WHERE owner_id = ?
        UNION SELECT id FROM patterns WHERE owner_id = ?
        UNION SELECT id FROM time_blocks
      )`).run(ownerId, ownerId);
      sqlite.prepare('DELETE FROM time_entries WHERE owner_id = ?').run(ownerId);
      sqlite.prepare(`DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE owner_id = ?)`).run(ownerId);
      sqlite.prepare(`DELETE FROM pattern_tasks WHERE task_id IN (SELECT id FROM tasks WHERE owner_id = ?)`).run(ownerId);
      sqlite.exec('DELETE FROM time_blocks'); // v0.2 single-owner: full wipe (incl. containers)
      sqlite.prepare('DELETE FROM flight_plan WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM pattern_prefs WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM category_prefs WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM pattern_blocks WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM block_templates WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM tasks WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM patterns WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM pattern_types WHERE owner_id = ?').run(ownerId);
      // tags + junctions have no owner_id — full wipe (v0.2 single-owner).
      sqlite.exec('DELETE FROM tag_categories');
      sqlite.exec('DELETE FROM category_direction_optouts');
      sqlite.exec('DELETE FROM tag_patterns');
      sqlite.exec('DELETE FROM tags');
      sqlite.prepare('DELETE FROM daily_summaries WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM scheduling_prefs WHERE owner_id = ?').run(ownerId);

      // ── Insert in FK-safe forward order ────────────────────────────────────
      const g = (key: string) => (Array.isArray(body[key]) ? (body[key] as Record<string, unknown>[]) : []);
      counts['scheduling_prefs'] = insertRows('scheduling_prefs', g('scheduling_prefs'));
      counts['daily_summaries']  = insertRows('daily_summaries', g('daily_summaries'));
      counts['tags']             = insertRows('tags', g('tags'));
      counts['tag_patterns']     = insertRows('tag_patterns', g('tag_patterns'));
      counts['tag_categories']   = insertRows('tag_categories', g('tag_categories'));
      counts['category_direction_optouts'] = insertRows('category_direction_optouts', g('category_direction_optouts'));
      counts['pattern_types']    = insertRows('pattern_types', g('pattern_types'));
      counts['patterns']         = insertRows('patterns', g('patterns'));
      counts['tasks']            = insertRows('tasks', g('tasks'));
      counts['pattern_tasks']    = insertRows('pattern_tasks', g('pattern_tasks'));
      counts['time_blocks']      = insertRows('time_blocks', g('time_blocks'));
      counts['task_dependencies']= insertRows('task_dependencies', g('task_dependencies'));
      counts['block_templates']  = insertRows('block_templates', g('block_templates'));
      counts['pattern_blocks']   = insertRows('pattern_blocks', g('pattern_blocks'));
      counts['pattern_prefs']    = insertRows('pattern_prefs', g('pattern_prefs'));
      counts['category_prefs']   = insertRows('category_prefs', g('category_prefs'));
      counts['flight_plan']      = insertRows('flight_plan', g('flight_plan'));
      counts['time_entries']     = insertRows('time_entries', g('time_entries'));
      counts['entity_tags']      = insertRows('entity_tags', g('entity_tags'));
      counts['possible_tasks']   = insertRows('possible_tasks', g('possible_tasks'));
      counts['possible_task_tags'] = insertRows('possible_task_tags', g('possible_task_tags'));
      counts['reminders']        = insertRows('reminders', g('reminders'));
      counts['push_subscriptions'] = insertRows('push_subscriptions', g('push_subscriptions'));
    })();

    writeAudit({ ownerId, actor: 'owner', action: 'import', entity: 'import' });
    broadcast(ownerId, 'data:imported', { counts });
    ctx.body = { imported: counts };
  });

  return router;
}
