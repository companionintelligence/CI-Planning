import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Grep gate: owner identity must come from currentOwnerId() in business logic,
 * never a hardcoded literal. Migrations/seeds/context/CLI/scripts legitimately
 * reference the literal owner and are not scanned.
 *
 * Two families of forbidden literals:
 *  - the legacy INTEGER owner literal (pre-UUID era) — never valid anywhere
 *    business logic runs, scanned across routes/engine/agents/services/jobs;
 *  - the SYSTEM_OWNER sentinel / its UUID — a legitimate binding only in the
 *    cron dispatcher (`jobs/`, until T3 fans it out per owner) and entry points
 *    (`cli/`, `scripts/`); request- and owner-scoped code must resolve the owner
 *    via currentOwnerId(), so `jobs/` is exempt from this second check.
 */
const INT_LITERAL: RegExp[] = [
  /owner_id\s*=\s*1\b/, // raw SQL: WHERE owner_id = 1
  /[oO]wnerId\s*,\s*1\b/, // drizzle: eq(x.ownerId, 1)
  /[oO]wnerId[^,\n)]*\?\?\s*1\b/, // ownerId ?? 1
];

const SYSTEM_OWNER_LITERAL: RegExp[] = [
  /\bSYSTEM_OWNER\b/, // the imported sentinel symbol (not SYSTEM_OWNER_ID)
  /00000000-0000-7000-8000-000000000001/, // its raw UUID
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (entry.endsWith('.ts')) out.push(p);
  }
  return out;
}

function scan(root: string, patterns: RegExp[]): string[] {
  const offenders: string[] = [];
  for (const file of tsFiles(join(process.cwd(), root))) {
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (patterns.some((re) => re.test(line))) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
  return offenders;
}

describe('no hardcoded owner literals in business logic', () => {
  for (const root of ['src/routes', 'src/engine', 'src/agents', 'src/services', 'src/jobs']) {
    it(`${root} uses no integer owner literal`, () => {
      expect(scan(root, INT_LITERAL)).toEqual([]);
    });
  }

  // jobs/ legitimately binds SYSTEM_OWNER for the (pre-T3) global cron dispatch,
  // so it is exempt from the sentinel check until T3 fans the runner out per owner.
  for (const root of ['src/routes', 'src/engine', 'src/agents', 'src/services']) {
    it(`${root} pins no SYSTEM_OWNER (resolve owner via currentOwnerId())`, () => {
      expect(scan(root, SYSTEM_OWNER_LITERAL)).toEqual([]);
    });
  }
});
