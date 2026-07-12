import Router from '@koa/router';
import { sqlite } from '../db/index.js';
import { currentOwnerId } from '../lib/context.js';
import { broadcast } from './sse.js';
import { writeAudit } from '../lib/audit.js';
import { purgeOwnerData } from '../lib/owners.js';
import { httpError } from '../lib/http-error.js';

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
// · '8' G-CASCADEXPORT: three previously-omitted owner-scoped tables now exported —
// copy_history (an oversight since 0109), plus external_events + outbound_queue (calendar
// sync mirror + push queue; previously excluded as re-derivable but now round-tripped so a
// restore doesn't drop pending pushes / sync identity). Purely additive — a '6'/'7' dump
// lacks these keys and the restore treats an absent key as empty, so it still restores.
const EXPORT_VERSION = '8';

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
  // Added in v8 (G-CASCADEXPORT): three owner-scoped tables the export dropped —
  // copy_history (owner_id since 0109), and external_events + outbound_queue (both
  // carry owner_id; they also cascade off time_blocks). Direct owner_id queries.
  'copy_history',
  'external_events',
  'outbound_queue',
] as const;

// Owner-scoped tables INTENTIONALLY excluded from export/import. Audited against every
// owner_id-bearing table in server/src/db/migrations (0001–0114); each is either a
// non-portable secret, ephemeral/device-specific sync state, or the identity/audit spine:
//   • owners            — the tenant row itself; owner_id is carried at the payload top
//                         level and validated on import (a foreign owner_id → 403).
//   • api_keys          — host-issued API credentials (key_hash / scopes); re-issued per
//                         host, security-sensitive, not portable content.
//   • connection_tokens — OAuth tokens encrypted with a host-local key (key_version); the
//                         ciphertext can't decrypt elsewhere. Secrets, re-linked per host.
//   • oauth_states / auth_states — ephemeral OAuth CSRF/PKCE state (expires in minutes).
//   • sync_events       — multi-device sync change-log; re-derived, device-scoped.
//   • sync_state        — per-provider sync cursors; host/provider-specific.
//   • password_reset_tokens — single-use secret tokens; never portable.
//   • audit_log         — append-only audit trail; import writes its OWN 'import' row, and
//                         a restore must not fabricate historical actor history.
// (scheduled_jobs + job_runs have NO owner_id — a global system registry seeded by
//  migrations — so they're outside an owner-scoped export by construction.)
// NOTE: external_events + outbound_queue were previously excluded here as "re-derivable";
// as of v8 they are exported (in OWNER_TABLES above) so a restore preserves sync identity
// and pending pushes rather than depending on a fresh provider round-trip.

/**
 * Insert rows using their own column names.
 *
 * TENANT ISOLATION: import must never write another owner's data. For any table with an
 * `owner_id` column, a row carrying a DIFFERENT owner_id is a tampered payload — reject
 * the whole import (400) — and the bound owner_id is FORCED to the caller's regardless,
 * so a crafted export can neither plant rows into nor overwrite another tenant's
 * partition. (A legitimate export is owner-scoped, so its rows always carry the caller's
 * own owner_id; this is a no-op for them.)
 */
function insertRows(table: string, rows: Record<string, unknown>[], ownerId: string): number {
  if (!rows.length) return 0;
  // Intersect the backup's keys with the LIVE table shape: an export taken before a
  // column was dropped (0048 is_habit, 0061, 0081, 0123 auto_mode, …) must still
  // import — retired keys are ignored, and keys absent from the backup take the
  // column default.
  const live = new Set(
    (sqlite.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name),
  );
  const ownerCol = live.has('owner_id') ? 'owner_id' : live.has('proposed_owner_id') ? 'proposed_owner_id' : null;
  if (ownerCol) {
    for (const row of rows) {
      const v = row[ownerCol];
      if (v != null && v !== ownerId) {
        throw httpError(400, `Import contains ${table} rows for a different owner`);
      }
    }
  }
  const cols = Object.keys(rows[0]).filter((c) => live.has(c));
  if (!cols.length) return 0;
  const stmt = sqlite.prepare(
    `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
  );
  for (const row of rows) {
    // Force the owner column to the caller — belt-and-suspenders behind the reject above.
    stmt.run(cols.map((c) => (c === ownerCol ? ownerId : row[c])));
  }
  return rows.length;
}

// Owner column per parent table (possible_tasks uses proposed_owner_id).
const PARENT_OWNER_COL: Record<string, string> = { possible_tasks: 'proposed_owner_id' };

/** Is `id` a row in `parent` owned by `ownerId`? A null FK is nothing to check (true). */
function ownsParent(parent: string, id: unknown, ownerId: string): boolean {
  if (id == null) return true;
  const col = PARENT_OWNER_COL[parent] ?? 'owner_id';
  return !!sqlite.prepare(`SELECT 1 FROM ${parent} WHERE id = ? AND ${col} = ?`).get(id, ownerId);
}

// FK columns → owner-scoped parent table, for the owner-LESS junction tables. entity_tags
// is polymorphic (entity_id resolves by entity_kind) and handled specially below.
const JUNCTION_FKS: Record<string, [string, string][]> = {
  tag_directions: [['intention_tag_id', 'tags'], ['direction_tag_id', 'tags']],
  tag_categories: [['intention_tag_id', 'tags'], ['category_tag_id', 'tags']],
  category_direction_optouts: [['category_tag_id', 'tags'], ['direction_tag_id', 'tags']],
  pattern_tasks: [['pattern_id', 'patterns'], ['task_id', 'tasks']],
  task_dependencies: [['task_id', 'tasks'], ['depends_on_id', 'tasks']],
  possible_task_tags: [['possible_task_id', 'possible_tasks'], ['tag_id', 'tags']],
  objective_tasks: [['objective_id', 'objectives'], ['task_id', 'tasks']],
};
const ENTITY_KIND_PARENT: Record<string, string> = { task: 'tasks', routine: 'patterns', time_block: 'time_blocks' };

/**
 * Insert owner-LESS junction rows, DROPPING any whose FK parents aren't the caller's own.
 * These tables carry no owner_id, so isolation rides on their parents — a row pointing at
 * another owner's task/tag/pattern/objective (by known id) would otherwise tag/link/depend
 * against the victim. Parents are inserted (owner-forced) earlier in the same transaction,
 * so this check sees exactly the caller's set.
 */
function insertJunctionRows(table: string, rows: Record<string, unknown>[], ownerId: string): number {
  const owned = rows.filter((row) => {
    if (table === 'entity_tags') {
      const parent = ENTITY_KIND_PARENT[String(row['entity_kind'])];
      if (!parent) return false;
      return ownsParent(parent, row['entity_id'], ownerId) && ownsParent('tags', row['tag_id'], ownerId);
    }
    return (JUNCTION_FKS[table] ?? []).every(([col, parent]) => ownsParent(parent, row[col], ownerId));
  });
  return insertRows(table, owned, ownerId);
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
      // v8 (G-CASCADEXPORT): previously-omitted owner-scoped tables.
      copy_history: ownerData['copy_history'],
      external_events: ownerData['external_events'],
      outbound_queue: ownerData['outbound_queue'],
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
    // Accept the current version plus prior v6 (pre-Phase-Z, grouping axis kind='pattern')
    // and v7 (pre-v8, before the three added tables). A v6 dump is remapped below; v7 and v8
    // dumps differ only by the additive v8 keys, which the restore treats as empty if absent.
    const SUPPORTED_VERSIONS = ['6', '7', EXPORT_VERSION];
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
      // ── Delete the owner's existing portable data in reverse FK order ──────
      // Shared with deleteOwner() so the FK-safe ordering has one source of truth.
      purgeOwnerData(ownerId);

      // ── Insert in FK-safe forward order ────────────────────────────────────
      const g = (key: string) => (Array.isArray(body[key]) ? (body[key] as Record<string, unknown>[]) : []);
      // Owner-bearing tables: owner_id force+reject inside insertRows.
      // Owner-LESS junctions (via insertJunctionRows): FK-parent ownership drop.
      counts['scheduling_prefs'] = insertRows('scheduling_prefs', g('scheduling_prefs'), ownerId);
      counts['daily_recap']      = insertRows('daily_recap', g('daily_recap'), ownerId);
      counts['tags']             = insertRows('tags', g('tags'), ownerId);
      counts['tag_directions']   = insertJunctionRows('tag_directions', g('tag_directions'), ownerId);
      counts['tag_categories']   = insertJunctionRows('tag_categories', g('tag_categories'), ownerId);
      counts['category_direction_optouts'] = insertJunctionRows('category_direction_optouts', g('category_direction_optouts'), ownerId);
      counts['pattern_types']    = insertRows('pattern_types', g('pattern_types'), ownerId);
      counts['patterns']         = insertRows('patterns', g('patterns'), ownerId);
      counts['tasks']            = insertRows('tasks', g('tasks'), ownerId);
      counts['pattern_tasks']    = insertJunctionRows('pattern_tasks', g('pattern_tasks'), ownerId);
      counts['time_blocks']      = insertRows('time_blocks', g('time_blocks'), ownerId);
      counts['task_dependencies']= insertJunctionRows('task_dependencies', g('task_dependencies'), ownerId);
      counts['block_templates']  = insertRows('block_templates', g('block_templates'), ownerId);
      counts['pattern_blocks']   = insertRows('pattern_blocks', g('pattern_blocks'), ownerId);
      counts['tag_prefs']        = insertRows('tag_prefs', g('tag_prefs'), ownerId);
      counts['flight_plan']      = insertRows('flight_plan', g('flight_plan'), ownerId);
      counts['time_entries']     = insertRows('time_entries', g('time_entries'), ownerId);
      counts['entity_tags']      = insertJunctionRows('entity_tags', g('entity_tags'), ownerId);
      counts['possible_tasks']   = insertRows('possible_tasks', g('possible_tasks'), ownerId);
      counts['possible_task_tags'] = insertJunctionRows('possible_task_tags', g('possible_task_tags'), ownerId);
      counts['reminders']        = insertRows('reminders', g('reminders'), ownerId);
      counts['push_subscriptions'] = insertRows('push_subscriptions', g('push_subscriptions'), ownerId);
      // v4 owner-scoped tables (G-EXPORT-MISSING). defer_foreign_keys=ON (above) makes the
      // intra-transaction insert order FK-safe; listed parents-before-children for clarity.
      counts['objectives']          = insertRows('objectives', g('objectives'), ownerId);
      counts['objective_tasks']     = insertJunctionRows('objective_tasks', g('objective_tasks'), ownerId);
      counts['reflections']         = insertRows('reflections', g('reflections'), ownerId);
      counts['daily_plan']          = insertRows('daily_plan', g('daily_plan'), ownerId);
      counts['day_types']           = insertRows('day_types', g('day_types'), ownerId);
      counts['day_of_week_map']     = insertRows('day_of_week_map', g('day_of_week_map'), ownerId);
      counts['day_assignments']     = insertRows('day_assignments', g('day_assignments'), ownerId);
      counts['pattern_day_optouts'] = insertRows('pattern_day_optouts', g('pattern_day_optouts'), ownerId);
      counts['plan_hints']          = insertRows('plan_hints', g('plan_hints'), ownerId);
      counts['replan_suggestions']  = insertRows('replan_suggestions', g('replan_suggestions'), ownerId);
      counts['estimate_calibration']= insertRows('estimate_calibration', g('estimate_calibration'), ownerId);
      counts['calibration_combo_pins'] = insertRows('calibration_combo_pins', g('calibration_combo_pins'), ownerId);
      // v8 (G-CASCADEXPORT). external_events/outbound_queue FK time_blocks(id); the blocks
      // above are re-inserted with original ids, and defer_foreign_keys=ON makes order moot.
      counts['copy_history']     = insertRows('copy_history', g('copy_history'), ownerId);
      counts['external_events']  = insertRows('external_events', g('external_events'), ownerId);
      counts['outbound_queue']   = insertRows('outbound_queue', g('outbound_queue'), ownerId);
    })();

    writeAudit({ ownerId, actor: 'owner', action: 'import', entity: 'import' });
    broadcast(ownerId, 'data:imported', { counts });
    ctx.body = { imported: counts };
  });

  return router;
}
