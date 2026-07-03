import { sqlite } from '../db/index.js';
import { newId, SYSTEM_OWNER_ID } from './ids.js';

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
 *                            Without pattern tags, Auto silently places nothing.
 *   - `tag_prefs`          — kind='category' rows w/ the 0069 color tokens; pattern
 *                            prefs are intentionally NOT seeded (read path folds in
 *                            DEFAULT_PREF; runtime pattern-tag creation doesn't seed
 *                            prefs either — provisioning matches runtime convention).
 *   - `day_types` + `day_of_week_map` — workday/weekend builtins + Sun/Sat→weekend
 *                            mapping (mirrors 0068); resolveDayType reads these.
 *   - `pattern_types`      — Routine/Habit/Ritual builtins (0013) + the Community
 *                            catch-all (0054).
 *
 * `pattern_blocks` (availability windows) are deliberately NOT seeded — owner #1
 * never got defaults either; tasks without pattern windows fall back to the
 * workday_start/workday_end window from scheduling_prefs. All inserts run in ONE
 * transaction: a provisioned owner either fully exists or not at all.
 */
export interface ProvisionOwnerFields {
  name: string;
  email?: string;
  username?: string;
  passwordHash?: string;
  externalSubject?: string;
}

const BASE_PATTERN_TAGS = ['home', 'work', 'community'] as const;
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
        `INSERT INTO owners (id, name, email, username, password_hash, external_subject)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        fields.name,
        fields.email ?? null,
        fields.username ?? null,
        fields.passwordHash ?? null,
        fields.externalSubject ?? null,
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
    for (const name of BASE_PATTERN_TAGS) insTag.run(newId(), id, name, 'direction');
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
