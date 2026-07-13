import { sqlite } from '../db/index.js';
import { newId, SYSTEM_OWNER_ID } from './ids.js';
import type { OwnerRole } from './auth/scopes.js';

/**
 * Production owner provisioning (U2, completed in U1). The app previously created
 * owners only via migrations (the sentinel) or a test-only raw-SQL helper; U2's
 * default-user seeding and U1's OIDC auto-provisioning need a real one.
 *
 * A provisioned owner must be a FUNCTIONAL tenant, i.e. hold everything the
 * migrations gave owner #1 at seed time (G-BASETAG — those seeds ran once
 * globally, so they never reach owners created after the migration):
 *
 *   - `scheduling_prefs`   — cloned from the sentinel's baseline row (schema-drift-
 *                            proof via PRAGMA table_info, same as test createOwner).
 *   - base `tags`          — home/work/community (kind='direction') + family/social/me
 *                            (kind='category'), is_base=1 (mirrors 0036 + 0069).
 *                            Without direction tags, Auto silently places nothing.
 *   - `pattern_blocks`     — default availability windows per direction × day type
 *                            (mirrors 0037's DEFAULTS). Auto's direction-window pass
 *                            (autoplan Pass 2a) is gated on the owner having windows;
 *                            without these a new owner falls through to the flat
 *                            workday fallback — a degraded experience vs owner #1,
 *                            who DID receive these from 0037.
 *   - `tag_prefs`          — kind='category' rows w/ the 0069 color tokens; pattern
 *                            prefs are intentionally NOT seeded (read path folds in
 *                            DEFAULT_PREF; runtime pattern-tag creation doesn't seed
 *                            prefs either — provisioning matches runtime convention).
 *                            Direction icons therefore render as the default circle
 *                            rather than 0039's circle/square/triangle (cosmetic only).
 *   - `day_types` + `day_of_week_map` — workday/weekend builtins + Sun/Sat→weekend
 *                            mapping (mirrors 0068); resolveDayType reads these.
 *   - `pattern_types`      — Routine/Habit/Ritual builtins (0013) + the Community
 *                            catch-all (0054).
 *
 * All inserts run in ONE transaction: a provisioned owner either fully exists or
 * not at all.
 */
export interface ProvisionOwnerFields {
  name: string;
  email?: string;
  username?: string;
  passwordHash?: string;
  externalSubject?: string;
  /** Phase AG role (operator/member/viewer). Defaults to 'member' — provisioning
   * must never mint an admin unless the caller (boot bootstrap, accounts API)
   * explicitly says so. */
  role?: OwnerRole;
}

const BASE_PATTERN_TAGS = ['home', 'work', 'community'] as const;
// Default availability windows per day type × direction — mirrors 0037's DEFAULTS.
// Duplicated (not imported) so the migration stays frozen. Times are HH:MM local.
const DEFAULT_PATTERN_BLOCKS: Record<string, Record<string, readonly (readonly [string, string])[]>> = {
  workday: {
    home: [['07:00', '08:00'], ['18:00', '23:00']],
    work: [['09:00', '18:00']],
    community: [['08:00', '09:00'], ['18:00', '21:00']],
  },
  weekend: {
    home: [['08:00', '23:00']],
    work: [['10:00', '12:00']],
    community: [['08:00', '22:00']],
  },
};
// name → 0069's per-owner category_prefs color token.
const BASE_CATEGORY_TAGS: readonly (readonly [string, string])[] = [
  ['family', 'chart-1'],
  ['social', 'chart-3'],
  ['me', 'chart-5'],
];
// name → icon_shape (0013); Community additionally carries catch_all=1 (0054).
const BUILTIN_PATTERN_TYPES: readonly (readonly [string, string, number])[] = [
  ['Routine', 'square', 0],
  ['Habit', 'circle', 0],
  ['Ritual', 'triangle', 0],
  ['Community', 'users', 1],
];

export function provisionOwner(fields: ProvisionOwnerFields): string {
  const id = newId();
  const prefsCols = (sqlite.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map(
    (c) => c.name,
  );

  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO owners (id, name, email, username, password_hash, external_subject, role)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.name,
        fields.email ?? null,
        fields.username ?? null,
        fields.passwordHash ?? null,
        fields.externalSubject ?? null,
        fields.role ?? 'member',
      );

    // scheduling_prefs: clone the sentinel's baseline row (fresh PK, new owner_id).
    if (prefsCols.length) {
      const params: unknown[] = [];
      const sel = prefsCols
        .map((c) => {
          if (c === 'id') return 'uuid7()'; // fresh PK — copying the source id would PK-collide
          if (c === 'owner_id') {
            params.push(id);
            return '?';
          }
          return c;
        })
        .join(', ');
      params.push(SYSTEM_OWNER_ID); // WHERE owner_id = ? (the seeded baseline prefs)
      sqlite
        .prepare(
          `INSERT INTO scheduling_prefs (${prefsCols.join(', ')})
           SELECT ${sel} FROM scheduling_prefs WHERE owner_id = ? LIMIT 1`,
        )
        .run(...params);
    }

    // Base tags (G-BASETAG): 3 direction + 3 category, is_base=1.
    const insTag = sqlite.prepare(
      `INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (?, ?, ?, ?, 1)`,
    );
    const dirTagId: Record<string, string> = {};
    for (const name of BASE_PATTERN_TAGS) {
      const tagId = newId();
      insTag.run(tagId, id, name, 'direction');
      dirTagId[name] = tagId;
    }

    // Default availability windows (G-BASETAG): mirrors 0037 so Auto's direction-window
    // pass fires for a new owner exactly as it did for owner #1. Raw inserts inside this
    // transaction — do NOT call the pattern-blocks service (it opens its own transaction,
    // and better-sqlite3 forbids nesting).
    const insWindow = sqlite.prepare(
      `INSERT INTO pattern_blocks (id, owner_id, direction_tag_id, day_type, start_time, end_time)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const [dayType, dirs] of Object.entries(DEFAULT_PATTERN_BLOCKS)) {
      for (const [dirName, ranges] of Object.entries(dirs)) {
        for (const [start, end] of ranges) {
          insWindow.run(newId(), id, dirTagId[dirName], dayType, start, end);
        }
      }
    }

    const insCatPref = sqlite.prepare(
      `INSERT INTO tag_prefs (id, owner_id, tag_id, kind, color_token, default_minutes)
       VALUES (?, ?, ?, 'category', ?, 60)`,
    );
    for (const [name, colorToken] of BASE_CATEGORY_TAGS) {
      const tagId = newId();
      insTag.run(tagId, id, name, 'category');
      insCatPref.run(newId(), id, tagId, colorToken);
    }

    // day_types + day-of-week mapping (0068's per-owner builtins).
    const insDayType = sqlite.prepare(
      `INSERT INTO day_types (id, owner_id, key, name, is_builtin) VALUES (?, ?, ?, ?, 1)`,
    );
    insDayType.run(newId(), id, 'workday', 'Workday');
    insDayType.run(newId(), id, 'weekend', 'Weekend');
    const insDowMap = sqlite.prepare(
      `INSERT INTO day_of_week_map (owner_id, dow, day_type_key) VALUES (?, ?, ?)`,
    );
    for (let dow = 0; dow < 7; dow++) {
      insDowMap.run(id, dow, dow === 0 || dow === 6 ? 'weekend' : 'workday');
    }

    // Builtin pattern types (0013) + the Community catch-all (0054).
    const insPatternType = sqlite.prepare(
      `INSERT INTO pattern_types (id, owner_id, name, icon_shape, is_builtin, catch_all)
       VALUES (?, ?, ?, ?, 1, ?)`,
    );
    for (const [name, icon, catchAll] of BUILTIN_PATTERN_TYPES) {
      insPatternType.run(newId(), id, name, icon, catchAll);
    }
  });
  tx();
  return id;
}

/**
 * Delete all of one owner's PORTABLE data (the export/restore table set) in reverse
 * FK order. This is the same teardown the backup /import route runs before re-inserting
 * a dump, extracted so restore and {@link deleteOwner} share one FK-safe ordering.
 *
 * PRECONDITION: the caller must already be inside a transaction with
 * `PRAGMA defer_foreign_keys=ON` (both callers are). This function does NOT open its
 * own transaction — better-sqlite3 forbids nesting.
 *
 * Scope = the portable set only. Non-portable owner tables (sync_events, sync_state,
 * connection_tokens, oauth_states, api_keys, password_reset_tokens, audit_log) and the
 * owners row itself are NOT touched here — a restore keeps them; {@link deleteOwner}
 * removes them separately.
 */
export function purgeOwnerData(ownerId: string): void {
  const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params);
  run('DELETE FROM push_subscriptions WHERE owner_id = ?', ownerId);
  run('DELETE FROM reminders WHERE owner_id = ?', ownerId);
  run(`DELETE FROM possible_task_tags
       WHERE possible_task_id IN (SELECT id FROM possible_tasks WHERE proposed_owner_id = ?)`, ownerId);
  run('DELETE FROM possible_tasks WHERE proposed_owner_id = ?', ownerId);
  run(`DELETE FROM objective_tasks
       WHERE objective_id IN (SELECT id FROM objectives WHERE owner_id = ?)`, ownerId);
  run('DELETE FROM objectives WHERE owner_id = ?', ownerId);
  run('DELETE FROM reflections WHERE owner_id = ?', ownerId);
  run('DELETE FROM daily_plan WHERE owner_id = ?', ownerId);
  run('DELETE FROM day_assignments WHERE owner_id = ?', ownerId);
  run('DELETE FROM day_of_week_map WHERE owner_id = ?', ownerId);
  run('DELETE FROM day_types WHERE owner_id = ?', ownerId);
  run('DELETE FROM pattern_day_optouts WHERE owner_id = ?', ownerId);
  run('DELETE FROM plan_hints WHERE owner_id = ?', ownerId);
  run('DELETE FROM replan_suggestions WHERE owner_id = ?', ownerId);
  run('DELETE FROM estimate_calibration WHERE owner_id = ?', ownerId);
  run('DELETE FROM calibration_combo_pins WHERE owner_id = ?', ownerId);
  run('DELETE FROM copy_history WHERE owner_id = ?', ownerId);
  // entity_tags has no direct owner_id — delete by entity membership.
  run(`DELETE FROM entity_tags WHERE entity_id IN (
         SELECT id FROM tasks WHERE owner_id = ?
         UNION SELECT id FROM patterns WHERE owner_id = ?
         UNION SELECT id FROM time_blocks WHERE owner_id = ?
       )`, ownerId, ownerId, ownerId);
  run('DELETE FROM time_entries WHERE owner_id = ?', ownerId);
  run('DELETE FROM task_dependencies WHERE task_id IN (SELECT id FROM tasks WHERE owner_id = ?)', ownerId);
  run('DELETE FROM pattern_tasks WHERE task_id IN (SELECT id FROM tasks WHERE owner_id = ?)', ownerId);
  // Calendar-sync children of time_blocks (also cascade off it, but delete explicitly).
  run('DELETE FROM external_events WHERE owner_id = ?', ownerId);
  run('DELETE FROM outbound_queue WHERE owner_id = ?', ownerId);
  run('DELETE FROM time_blocks WHERE owner_id = ?', ownerId);
  run('DELETE FROM flight_plan WHERE owner_id = ?', ownerId);
  run('DELETE FROM tag_prefs WHERE owner_id = ?', ownerId);
  run('DELETE FROM pattern_blocks WHERE owner_id = ?', ownerId);
  run('DELETE FROM block_templates WHERE owner_id = ?', ownerId);
  run('DELETE FROM tasks WHERE owner_id = ?', ownerId);
  run('DELETE FROM patterns WHERE owner_id = ?', ownerId);
  run('DELETE FROM pattern_types WHERE owner_id = ?', ownerId);
  // tags are owner-scoped; the 3 junctions scope through their parent tags.
  run('DELETE FROM tag_categories WHERE intention_tag_id IN (SELECT id FROM tags WHERE owner_id = ?)', ownerId);
  run('DELETE FROM category_direction_optouts WHERE category_tag_id IN (SELECT id FROM tags WHERE owner_id = ?)', ownerId);
  run('DELETE FROM tag_directions WHERE intention_tag_id IN (SELECT id FROM tags WHERE owner_id = ?)', ownerId);
  run('DELETE FROM tags WHERE owner_id = ?', ownerId);
  run('DELETE FROM daily_recap WHERE owner_id = ?', ownerId);
  run('DELETE FROM scheduling_prefs WHERE owner_id = ?', ownerId);
}

// Non-portable owner-scoped tables purged only on full owner deletion (never exported /
// kept across a restore): secrets, ephemeral sync state, and the audit spine.
const NON_PORTABLE_OWNER_TABLES = [
  'sync_events',
  'sync_state',
  'connection_tokens',
  'oauth_states',
  'api_keys',
  'password_reset_tokens',
  'audit_log',
] as const;

/**
 * Permanently delete an owner and ALL their data — the account-deletion primitive.
 * Runs in one transaction with deferred FK checks: purges the portable data set
 * ({@link purgeOwnerData}), then the non-portable owner tables, then the owners row.
 * The sentinel/system owner is never deletable.
 */
export function deleteOwner(ownerId: string): void {
  if (ownerId === SYSTEM_OWNER_ID) {
    throw new Error('refusing to delete the system owner');
  }
  sqlite.transaction(() => {
    sqlite.exec('PRAGMA defer_foreign_keys=ON');
    purgeOwnerData(ownerId);
    for (const table of NON_PORTABLE_OWNER_TABLES) {
      sqlite.prepare(`DELETE FROM ${table} WHERE owner_id = ?`).run(ownerId);
    }
    sqlite.prepare('DELETE FROM owners WHERE id = ?').run(ownerId);
  })();
}

// ── Phase AG — account enumeration for the operator accounts API ─────────────

export interface OwnerAccount {
  id: string;
  name: string;
  username: string | null;
  email: string | null;
  role: string;
  /** Whether local username/password login can work for this account (vs OIDC-only). */
  hasPassword: boolean;
}

/**
 * All real owners (the SYSTEM sentinel excluded — it is auth-inert and not an
 * account). Ordered by id: owner ids are UUIDv7, so this is creation order.
 * Never exposes password_hash/external_subject — only whether a password exists.
 */
export function listOwners(): OwnerAccount[] {
  const rows = sqlite
    .prepare(
      `SELECT id, name, username, email, role, password_hash IS NOT NULL AS has_password
         FROM owners WHERE id <> ? ORDER BY id`,
    )
    .all(SYSTEM_OWNER_ID) as {
    id: string; name: string; username: string | null; email: string | null;
    role: string; has_password: number;
  }[];
  return rows.map((r) => ({
    id: r.id, name: r.name, username: r.username, email: r.email,
    role: r.role, hasPassword: r.has_password === 1,
  }));
}

/** How many operators exist — the accounts API's lockout guard (never demote or
 * delete the last one). Sentinel excluded: it can't log in, so it can't operate. */
export function operatorCount(): number {
  return (
    sqlite
      .prepare(`SELECT COUNT(*) AS n FROM owners WHERE role = 'operator' AND id <> ?`)
      .get(SYSTEM_OWNER_ID) as { n: number }
  ).n;
}
