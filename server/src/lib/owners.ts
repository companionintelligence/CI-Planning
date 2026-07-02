import { sqlite } from '../db/index.js';
import { newId, SYSTEM_OWNER_ID } from './ids.js';

/**
 * Production owner provisioning (U2). The app previously created owners only via
 * migrations (the sentinel) or a test-only raw-SQL helper; U2's default-user seeding
 * — and U1's OIDC auto-provisioning — need a real one. Creates the `owners` row and
 * clones a `scheduling_prefs` row from the sentinel so the new owner is immediately
 * functional (Auto/planner/recurrence all read scheduling_prefs and assume a row).
 *
 * Column set for the prefs clone is read from `PRAGMA table_info` (schema-drift-proof,
 * same approach as the test `createOwner` helper) rather than enumerated by hand.
 *
 * ⚠️ G-BASETAG (deferred): a new owner still gets **no** base pattern tags (Home/Work/
 * Community are seeded once globally, 0036/0069), so Auto places nothing on pattern
 * windows until per-owner base-tag provisioning lands. Tracked as the G-BASETAG gap
 * (owned by U provisioning); login and manual planning work without it.
 */
export interface ProvisionOwnerFields {
  name: string;
  username?: string;
  passwordHash?: string;
  externalSubject?: string;
}

export function provisionOwner(fields: ProvisionOwnerFields): string {
  const id = newId();
  const prefsCols = (sqlite.prepare(`PRAGMA table_info(scheduling_prefs)`).all() as { name: string }[]).map(
    (c) => c.name,
  );

  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        `INSERT INTO owners (id, name, username, password_hash, external_subject)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, fields.name, fields.username ?? null, fields.passwordHash ?? null, fields.externalSubject ?? null);

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
  });
  tx();
  return id;
}
