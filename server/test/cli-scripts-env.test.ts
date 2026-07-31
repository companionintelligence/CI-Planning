import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/**
 * Every CLI entry point that touches the database must load `server/.env`.
 *
 * `DB_PATH` has no portable default: macOS falls back to
 * `~/Library/Application Support/CompanionPlanning/companion.db` and Docker to
 * `/data/companion.db`, so on Linux the value MUST come from the env file. A script that
 * runs bare `tsx` never loads it and silently operates on a DIFFERENT database than the
 * server — one that `openDb()` will happily CREATE on first touch, so there is no error
 * to notice.
 *
 * Observed, not hypothetical: `pnpm snapshot` on a Linux host wrote a backup of a stale
 * macOS-default database (118 seed tasks) while the real database held the owner's data,
 * and reported success. `restore` had the same gap, which is the dangerous half — it
 * would target the phantom path at recovery time, report success, and leave the real
 * database untouched.
 *
 * This asserts the whole class rather than the three scripts that happened to be wrong,
 * because the failure is silent and the next script added will be written the same way.
 */

const pkg = JSON.parse(
  readFileSync(join(dirname(new URL(import.meta.url).pathname), '..', 'package.json'), 'utf8'),
) as { scripts: Record<string, string> };

/** Scripts that boot the app or a DB-touching CLI. Excludes test/typecheck/codegen. */
const DB_TOUCHING = Object.entries(pkg.scripts).filter(
  ([, cmd]) => /(^|\s)tsx\s/.test(cmd) && !/vitest|tsc\b|drizzle-kit/.test(cmd),
);

describe('server package.json — CLI scripts load the env file', () => {
  it('finds the DB-touching scripts (guards against the filter silently matching nothing)', () => {
    expect(DB_TOUCHING.length).toBeGreaterThanOrEqual(5);
  });

  for (const [name, cmd] of DB_TOUCHING) {
    it(`\`${name}\` passes --env-file so DB_PATH resolves to the real database`, () => {
      expect(cmd, `"${name}": "${cmd}"`).toMatch(/--env-file(-if-exists)?=\.env/);
    });
  }
});
