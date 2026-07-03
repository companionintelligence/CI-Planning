import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from './sse.js';
import { writeAudit } from '../lib/audit.js';

// Bump whenever the export payload SHAPE changes (a table added / removed / renamed, or a
// column becomes REQUIRED on an exported table).
// History: '1' initial · '2' time-block categories · '3' daily_recap (0096) + tag_prefs
// (0097) merges · '4' the previously-omitted owner-scoped tables below — objectives,
// reflections, daily_plan, day-types, calibration, hints, optouts (gap G-EXPORT-MISSING:
// export→import silently lost them) · '5' T1 (multi-tenant): time_blocks gained a NOT NULL
// owner_id, so its exported rows now carry owner_id and a pre-T1 ('4') export can't be
// restored into the new schema — the version check rejects it cleanly. time_blocks is now
// an OWNER_TABLES entry (owner-scoped export) and its restore-wipe + the entity_tags UNION
// are owner-scoped (F-ETAGS) · '6' T2 (multi-tenant): tags gained a NOT NULL owner_id
// (UNIQUE(owner_id, name) replaces the global UNIQUE(name)); the tag axis + its junctions are
// now owner-scoped on export/restore, so the tags/junction wipe no longer cross-tenant-
// cascades another owner's entity_tags — completing the entity_tags restore-isolation T1 began.
// · '7' Phase Z / W2: the tag grouping axis reverted from kind='pattern' to kind='direction'
// (tag_patterns→tag_directions, and pattern_tag_id→direction_tag_id on tag_directions /
// pattern_blocks / category_direction_optouts). A pre-Z '6' dump is still restorable — the
// import remaps the old key + column (see the v6→v7 block below).
const EXPORT_VERSION = '7';

// Owner-scoped tables exported/restored via a direct `WHERE owner_id = ?` query.
// (Junctions, the tag axis, and full-table dumps are handled explicitly in the payload.)
const OWNER_TABLES = [
  'scheduling_prefs',
  'daily_recap',
  'pattern_types',
  'patterns',
  'tasks',
  'block_templates',
  'time_blocks',
  'tags',
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
  // Phase Z · Z0: user-confirmed tag-combo pins (0107). Purely additive — a new
  // table plus DEFAULT-backed scope columns on estimate_calibration; the restore
  // treats an absent payload key as empty, so an older dump lacking this table
  // still restores. (The '7' bump was for W2's direction rename, not this.)
  'calibration_combo_pins',
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

    // T1 (multi-tenant): time_blocks is now an OWNER_TABLES entry, so the loop above already
    // fetched THIS owner's blocks — CONTAINER blocks (block_kind='timeblock', task_id IS NULL,
    // incl. Time Block Category containers) and synced meetings included, since they carry
    // owner_id directly rather than relying on a task_id → tasks.owner_id path.
    const timeBlocks = ownerData['time_blocks'];
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
      // T2: tags are owner-scoped (an OWNER_TABLES entry); the 3 junctions carry no owner_id,
      // so they scope through their parent tags (tag_id IN this owner's tags).
      tags: ownerData['tags'],
      tag_directions: sqlite.prepare(`SELECT * FROM tag_directions WHERE intention_tag_id IN (SELECT id FROM tags WHERE owner_id = ?)`).all(ownerId),
      tag_categories: sqlite.prepare(`SELECT * FROM tag_categories WHERE intention_tag_id IN (SELECT id FROM tags WHERE owner_id = ?)`).all(ownerId),
      category_direction_optouts: sqlite.prepare(`SELECT * FROM category_direction_optouts WHERE category_tag_id IN (SELECT id FROM tags WHERE owner_id = ?)`).all(ownerId),
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
      calibration_combo_pins: ownerData['calibration_combo_pins'],
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
    // Accept the current version and the immediately-prior v6 (pre-Phase-Z, when the grouping
    // axis was kind='pattern'). A v6 dump is remapped to the reverted schema below.
    const SUPPORTED_VERSIONS = ['6', EXPORT_VERSION];
    if (!SUPPORTED_VERSIONS.includes(String(body['version']))) {
      ctx.status = 400;
      ctx.body = { error: `Unsupported export version '${body['version']}'; expected one of ${SUPPORTED_VERSIONS.join(', ')}` };
      return;
    }
    if (body['owner_id'] !== ownerId) {
      ctx.status = 403;
      ctx.body = { error: 'Export owner_id does not match current owner' };
      return;
    }
    // v6 → v7 back-compat (Phase Z / W2): the direction axis reverted. Rename the old payload
    // key tag_patterns → tag_directions, rewrite any row field pattern_tag_id → direction_tag_id on the
    // affected tables, and translate kind='pattern' → 'direction' on tags + tag_prefs rows.
    if (String(body['version']) === '6') {
      if (Array.isArray(body['tag_patterns']) && body['tag_directions'] === undefined) {
        body['tag_directions'] = body['tag_patterns'];
      }
      for (const key of ['tag_directions', 'pattern_blocks', 'category_direction_optouts']) {
        const rows = body[key];
        if (Array.isArray(rows)) {
          for (const row of rows as Record<string, unknown>[]) {
            if (row && Object.prototype.hasOwnProperty.call(row, 'pattern_tag_id')) {
              row['direction_tag_id'] = row['pattern_tag_id'];
              delete row['pattern_tag_id'];
            }
          }
        }
      }
      for (const key of ['tags', 'tag_prefs']) {
        const rows = body[key];
        if (Array.isArray(rows)) {
          for (const row of rows as Record<string, unknown>[]) {
            if (row && row['kind'] === 'pattern') row['kind'] = 'direction';
          }
        }
      }
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
      sqlite.prepare('DELETE FROM calibration_combo_pins WHERE owner_id = ?').run(ownerId);
      // entity_tags has no direct owner_id — delete by entity membership.
      sqlite.prepare(`DELETE FROM entity_tags WHERE entity_id IN (
        SELECT id FROM tasks WHERE owner_id = ?
        UNION SELECT id FROM patterns WHERE owner_id = ?
        UNION SELECT id FROM time_blocks WHERE owner_id = ?
      )`).run(ownerId, ownerId, ownerId);
      sqlite.prepare('DELETE FROM time_entries WHERE owner_id = ?').run(ownerId);
      sqlite.prepare(`DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE owner_id = ?)`).run(ownerId);
      sqlite.prepare(`DELETE FROM pattern_tasks WHERE task_id IN (SELECT id FROM tasks WHERE owner_id = ?)`).run(ownerId);
      sqlite.prepare('DELETE FROM time_blocks WHERE owner_id = ?').run(ownerId); // T1: owner-scoped wipe (incl. containers)
      sqlite.prepare('DELETE FROM flight_plan WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM tag_prefs WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM pattern_blocks WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM block_templates WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM tasks WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM patterns WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM pattern_types WHERE owner_id = ?').run(ownerId);
      // T2: tags are owner-scoped; the 3 junctions scope through their parent tags. Delete
      // junctions first (by parent-tag membership), then the owner's tags. This owner-scoped
      // tags DELETE is the final lock on entity_tags restore-isolation: the old global
      // `DELETE FROM tags` cascade-wiped OTHER owners' entity_tags via entity_tags.tag_id.
      sqlite.prepare(`DELETE FROM tag_categories WHERE intention_tag_id IN (SELECT id FROM tags WHERE owner_id = ?)`).run(ownerId);
      sqlite.prepare(`DELETE FROM category_direction_optouts WHERE category_tag_id IN (SELECT id FROM tags WHERE owner_id = ?)`).run(ownerId);
      sqlite.prepare(`DELETE FROM tag_directions WHERE intention_tag_id IN (SELECT id FROM tags WHERE owner_id = ?)`).run(ownerId);
      sqlite.prepare('DELETE FROM tags WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM daily_recap WHERE owner_id = ?').run(ownerId);
      sqlite.prepare('DELETE FROM scheduling_prefs WHERE owner_id = ?').run(ownerId);

      // ── Insert in FK-safe forward order ────────────────────────────────────
      const g = (key: string) => (Array.isArray(body[key]) ? (body[key] as Record<string, unknown>[]) : []);
      counts['scheduling_prefs'] = insertRows('scheduling_prefs', g('scheduling_prefs'));
      counts['daily_recap']      = insertRows('daily_recap', g('daily_recap'));
      counts['tags']             = insertRows('tags', g('tags'));
      counts['tag_directions']   = insertRows('tag_directions', g('tag_directions'));
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
      counts['calibration_combo_pins'] = insertRows('calibration_combo_pins', g('calibration_combo_pins'));
    })();

    writeAudit({ ownerId, actor: 'owner', action: 'import', entity: 'import' });
    broadcast(ownerId, 'data:imported', { counts });
    ctx.body = { imported: counts };
  });

  return router;
}
