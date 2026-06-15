import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Grep gate: owner identity must come from currentOwnerId(), never a hardcoded
 * literal, in business logic. Migrations/seeds/context legitimately reference the
 * literal owner and are not scanned.
 */
const PATTERNS: RegExp[] = [
  /owner_id\s*=\s*1\b/,        // raw SQL: WHERE owner_id = 1
  /[oO]wnerId\s*,\s*1\b/,      // drizzle: eq(x.ownerId, 1)
  /[oO]wnerId[^,\n)]*\?\?\s*1\b/, // ownerId ?? 1
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

describe('no hardcoded owner literals in business logic', () => {
  for (const root of ['src/routes', 'src/engine', 'src/agents']) {
    it(`${root} resolves owner via currentOwnerId()`, () => {
      const offenders: string[] = [];
      for (const file of tsFiles(join(process.cwd(), root))) {
        readFileSync(file, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            if (PATTERNS.some((re) => re.test(line))) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
          });
      }
      expect(offenders).toEqual([]);
    });
  }
});
