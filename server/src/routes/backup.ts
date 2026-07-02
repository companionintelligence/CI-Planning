import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from './sse.js';
import { writeAudit } from '../lib/audit.js';

// Bump whenever the export payload SHAPE changes (a table added / removed / renamed).
// History: '1' initial · '2' time-block categories · '3' daily_recap (0096) + tag_prefs
// (0097) merges · '4' the previously-omitted owner-scoped tables below — objectives,
// reflections, daily_plan, day-types, calibration, hints, optouts (gap G-EXPORT-MISSING:
// export→import silently lost them). ⚠️ Phase T (multi-tenant) also edits this file and
// this constant; if both land, the later PR must reconcile to ONE next integer — not two
// parallel '4's — and re-run the owner_id audit below against any new owner-scoped tables.
const EXPORT_VERSION = '4';

// Owner-scoped tables exported/restored via a direct `WHERE owner_id = ?` query.
// (Junctions, the tag axis, and full-table dumps are handled explicitly in the payload.)
const OWNER_TABLES = [
  'scheduling_prefs',
  'daily_recap',
  'pattern_types',
  'patterns',
  'tasks',
  'block_templates',
  'pattern_blocks',
  'tag_prefs',
  'flight_plan',
  'time_entries',
  'reminders',
  'push_subscriptions',
  // Added in v4 (G-EXPORT-MISSING): owner-scoped data that resetDb() clears but the
  // export silently dropped — a round-trip lost the owner's objectives, reflections,
  // day-type calendar, plan order, calibration, and pattern opt-outs. Each carries an
  // owner_id, so a direct query is enough (objective_tasks is a junction, handled below).
  'objectives',
  'reflections',
  'daily_plan',
  'day_types',
  'day_of_week_map',
  'day_assignments',
  'pattern_day_optouts',
  'plan_hints',
  'replan_suggestions',
  'estimate_calibration',
] as const;

// Owner-scoped tables INTENTIONALLY excluded from export/import. Audited against every
// owner_id-bearing table in server/src/db/migrations (0001–0097); each is either a
// non-portable secret, ephemeral/re-derivable sync state, or the identity/audit spine:
//   • owners            — the tenant row itself; owner_id is carried at the payload top
//                         level and validated on import (a foreign owner_id → 403).
//   • api_keys          — host-issued API credentials (key_hash / scopes); re-issued per
//                         host, security-sensitive, not portable content.
//   • connection_tokens — OAuth tokens encrypted with a host-local key (key_version); the
//                         ciphertext can't decrypt elsewhere. Secrets, re-linked per host.
//   • oauth_states      — ephemeral OAuth CSRF/PKCE state (expires in minutes).
//   • external_events   — calendar sync mirror; re-derived from the provider on next sync.
//   • outbound_queue    — pending calendar-push queue; ephemeral sync plumbing.
//   • sync_events       — multi-device sync change-log; re-derived, device-scoped.
//   • sync_state        — per-provider sync cursors; host/provider-specific.
//   • audit_log         — append-only audit trail; import writes its OWN 'import' row, and
//                         a restore must not fabricate historical actor history.
// (scheduled_jobs + job_runs have NO owner_id — a global system registry seeded by
//  migrations — so they're outside an owner-scoped export by construction.)

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

    // objective_tasks has no owner_id — scope via the owner's objectives (both ends of a
    // link belong to the same owner). Carries tombstones (linked=0) too, via SELECT *.
    const objectiveIds = (ownerData['objectives'] as { id: string }[]).map((o) => o.id);
    const objectiveTasks = objectiveIds.length
      ? sqlite
          .prepare(`SELECT * FROM objective_tasks WHERE objective_id IN (${objectiveIds.map(() => '?').join(',')})`)
          .all(objectiveIds)
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
      tag_prefs: ownerData['tag_prefs'],
      flight_plan: ownerData['flight_plan'],
      time_entries: ownerData['time_entries'],
      entity_tags: entityTags,
      possible_tasks: possibleTasks,
      possible_task_tags: possibleTaskTags,
      reminders: ownerData['reminders'],
      push_subscriptions: ownerData['push_subscriptions'],
      daily_recap: ownerData['daily_recap'],
      // v4 owner-scoped tables (G-EXPORT-MISSING).
      objectives: ownerData['objectives'],
      objective_tasks: objectiveTasks,
      reflections: ownerData['reflections'],
      daily_plan: ownerData['daily_plan'],
      day_types: ownerData['day_types'],
      day_of_week_map: ownerData['day_of_week_map'],
      day_assignments: ownerData['day_assignments'],
      pattern_day_optouts: ownerData['pattern_day_optouts'],
      plan_hints: ownerData['plan_hints'],
      replan_suggestions: ownerData['replan_suggestions'],
      estimate_calibration: ownerData['estimate_calibration'],
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
      // ── v4 owner-scoped tables (G-EXPORT-MISSING) — children before parents ─────
      // objective_tasks & daily_plan FK tasks/objectives/time_blocks; delete them before
      // those parents. pattern_day_optouts FKs patterns (deleted further down).
      sqlite.prepare(`DELETE FROM objective_tasks
        WHERE objective_id IN (SELECT id FROM objectives WHERE owner_id = ?)`).run(ownerId);
      sqlite.prepare('DELETE FROM objectives WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM reflections WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM daily_plan WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM day_assignments WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM day_of_week_map WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM day_types WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM pattern_day_optouts WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM plan_hints WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM replan_suggestions WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM estimate_calibration WHERE owner_id = ?').run(ownerId);
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
      sqlite.prepare('DELETE FROM tag_prefs WHERE owner_id = ?').run(ownerId);
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
      sqlite.prepare('DELETE FROM daily_recap WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM scheduling_prefs WHERE owner_id = ?').run(ownerId);

      // ── Insert in FK-safe forward order ────────────────────────────────────
      const g = (key: string) => (Array.isArray(body[key]) ? (body[key] as Record<string, unknown>[]) : []);
      counts['scheduling_prefs'] = insertRows('scheduling_prefs', g('scheduling_prefs'));
      counts['daily_recap']      = insertRows('daily_recap', g('daily_recap'));
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
      counts['tag_prefs']        = insertRows('tag_prefs', g('tag_prefs'));
      counts['flight_plan']      = insertRows('flight_plan', g('flight_plan'));
      counts['time_entries']     = insertRows('time_entries', g('time_entries'));
      counts['entity_tags']      = insertRows('entity_tags', g('entity_tags'));
      counts['possible_tasks']   = insertRows('possible_tasks', g('possible_tasks'));
      counts['possible_task_tags'] = insertRows('possible_task_tags', g('possible_task_tags'));
      counts['reminders']        = insertRows('reminders', g('reminders'));
      counts['push_subscriptions'] = insertRows('push_subscriptions', g('push_subscriptions'));
      // v4 owner-scoped tables (G-EXPORT-MISSING). defer_foreign_keys=ON (above) makes the
      // intra-transaction insert order FK-safe; listed parents-before-children for clarity.
      counts['objectives']          = insertRows('objectives', g('objectives'));
      counts['objective_tasks']     = insertRows('objective_tasks', g('objective_tasks'));
      counts['reflections']         = insertRows('reflections', g('reflections'));
      counts['daily_plan']          = insertRows('daily_plan', g('daily_plan'));
      counts['day_types']           = insertRows('day_types', g('day_types'));
      counts['day_of_week_map']     = insertRows('day_of_week_map', g('day_of_week_map'));
      counts['day_assignments']     = insertRows('day_assignments', g('day_assignments'));
      counts['pattern_day_optouts'] = insertRows('pattern_day_optouts', g('pattern_day_optouts'));
      counts['plan_hints']          = insertRows('plan_hints', g('plan_hints'));
      counts['replan_suggestions']  = insertRows('replan_suggestions', g('replan_suggestions'));
      counts['estimate_calibration']= insertRows('estimate_calibration', g('estimate_calibration'));
    })();

    writeAudit({ ownerId, actor: 'owner', action: 'import', entity: 'import' });
    broadcast(ownerId, 'data:imported', { counts });
    ctx.body = { imported: counts };
  });

  return router;
}
