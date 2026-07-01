/**
 * One-off CLI: clear the PLANNER from a cutoff local date forward and stop the two
 * lazy regeneration engines from repopulating it. This is a thin wrapper around the
 * shared `clearPlannerRange` engine (engine/clear-range.ts) — it runs an OPEN-ENDED
 * clear (from the cutoff), which caps each recurring generator's rule with `UNTIL`
 * so it stops producing occurrences on/after the cutoff while the template row is
 * kept. See engine/clear-range.ts for the full contract.
 *
 * DRY-RUN BY DEFAULT. Prints what it would do and writes nothing. Pass `--apply`
 * to snapshot the DB and execute.
 *
 * Usage:
 *   tsx src/scripts/clear-planner-from.ts <YYYY-MM-DD> [--apply]
 *   (a hard-coded default cutoff is allowed for dry-runs only)
 */
import { join } from 'node:path';
import { clearPlannerRange } from '../engine/clear-range.js';
import { snapshot, backupDir } from '../lib/backup.js';
import { SYSTEM_OWNER_ID } from '../lib/ids.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const explicitCutoff = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));
// A hard-coded default is fine for an exploratory dry-run, but must never drive a
// destructive --apply: the default drifts stale over time. Require the date be spelled out.
if (APPLY && !explicitCutoff) {
  console.error('Refusing to --apply without an explicit YYYY-MM-DD cutoff (the built-in default is dry-run only).');
  console.error('Usage: tsx src/scripts/clear-planner-from.ts <YYYY-MM-DD> --apply');
  process.exit(1);
}
const cutoff = explicitCutoff ?? '2026-07-03';

console.log(`\n=== clear-planner-from (open-ended, UNTIL-cap) ===`);
console.log(`cutoff : ${cutoff} (>= this local day is cleared)`);
console.log(`mode   : ${APPLY ? 'APPLY (writes)' : 'DRY-RUN (no writes)'}\n`);

// Preview: always compute the report without writing.
const preview = clearPlannerRange({ owner: SYSTEM_OWNER_ID, start: cutoff, suppress: 'auto', autoOnly: false, dryRun: true });
console.log(`DELETE`);
console.log(`  time_blocks (instances + non-recurring, on/after cutoff): ${preview.blocksDeleted}`);
console.log(`  daily_plan rows (date >= cutoff)                        : ${preview.dailyPlanDeleted}\n`);
console.log(`CAP recurrence rules with UNTIL (templates kept, rule trimmed to < cutoff)`);
for (const g of preview.generators) {
  const tag = g.kind === 'block' ? 'block ' : 'pattern';
  console.log(`  ${tag} ${g.label}\n            ${g.oldRule}  ->  ${g.newRule}`);
}
const blockCaps = preview.generators.filter((g) => g.kind === 'block').length;
const patternCaps = preview.generators.filter((g) => g.kind === 'pattern').length;
console.log(`  (${blockCaps} block templates + ${patternCaps} patterns)\n`);

if (!APPLY) {
  console.log(`DRY-RUN complete — nothing written. Re-run with --apply to execute.\n`);
  process.exit(0);
}

// Apply: snapshot first, then run the engine for real.
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const dest = join(backupDir, `companion-preclear-${ts}.db`);
await snapshot(dest);
console.log(`Snapshot written to ${dest}`);

const applied = clearPlannerRange({ owner: SYSTEM_OWNER_ID, start: cutoff, suppress: 'auto', autoOnly: false, dryRun: false });
console.log(`\nAPPLIED:`);
console.log(`  deleted ${applied.blocksDeleted} time_blocks, ${applied.dailyPlanDeleted} daily_plan rows`);
console.log(`  capped  ${applied.generators.length} generators to < ${cutoff}`);
console.log(`  backup: ${dest}\n`);
process.exit(0);
