/**
 * Take a one-off DB snapshot to the backups directory.
 * Usage: pnpm --filter server snapshot
 */
import { join } from 'node:path';
import { snapshot, pruneOldSnapshots, backupDir } from '../lib/backup.js';
import { config } from '../lib/config.js';

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const dest = join(backupDir, `companion-${ts}.db`);

await snapshot(dest);
pruneOldSnapshots(backupDir, config.snapshotRetain);
console.log(`Snapshot written to ${dest}`);
