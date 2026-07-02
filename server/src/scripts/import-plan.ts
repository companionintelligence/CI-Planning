/**
 * Import a grouped, two-level plan (focused efforts + their clearing subtasks)
 * into the Companion Planning DB, tagged by direction (home | work | community).
 *
 * Usage:
 *   tsx src/scripts/import-plan.ts --file=<plan.json> [--dry-run]
 *
 * Supply your own plan JSON via --file (the default path is an example and is not
 * committed). See the Plan/Group/Effort/Subtask shape below for the expected schema.
 *
 * Idempotent: every row it creates is stamped source_kind='agent' + the plan's
 * source_ref, so a re-run first deletes the prior import (tasks + their tags) and
 * re-inserts. It never touches rows it didn't create. Importing db/index.js runs
 * migrations on open, so the home/work/community base tags are guaranteed present.
 */
import { readFileSync } from 'node:fs';
import { join, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sqlite } from '../db/index.js';
import { SYSTEM_OWNER_ID } from '../lib/ids.js';
import { normalizeTagName } from '../services/tags.js';
import { logger } from '../lib/logger.js';

interface Subtask { title: string; notes?: string; priority?: number; estimated_minutes?: number; due_at?: string; secondary?: string[]; }
interface Effort extends Subtask { subtasks?: Subtask[]; }
interface Group { group: string; tasks: Effort[]; }
interface Plan { source_ref: string; groups: Group[]; }

const _dir = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const fileArg = argv.find((a) => a.startsWith('--file='))?.split('=')[1];
const planPath = fileArg
  ? (isAbsolute(fileArg) ? fileArg : join(process.cwd(), fileArg))
  : join(_dir, '..', '..', '..', 'docs', 'liam-master-plan.json'); // server/src/scripts -> repo root/docs

const plan = JSON.parse(readFileSync(planPath, 'utf8')) as Plan;
if (!plan.source_ref) throw new Error('plan is missing source_ref');

// Resolve a tag name to its id, creating it if absent (matches routes/tasks.ts attachTags).
const tagId = (raw: string): string => {
  const name = normalizeTagName(raw);
  const existing = sqlite.prepare('SELECT id FROM tags WHERE owner_id = ? AND name = ?').get(SYSTEM_OWNER_ID, name) as { id: string } | undefined;
  return existing
    ? existing.id
    : (sqlite.prepare('INSERT INTO tags (id, owner_id, name) VALUES (uuid7(), ?, ?) RETURNING id').get(SYSTEM_OWNER_ID, name) as { id: string }).id;
};

const insTask = sqlite.prepare(
  `INSERT INTO tasks (id, title, notes, due_at, estimated_minutes, priority, status, subtype, parent_id, owner_id, source_kind, source_ref)
   VALUES (uuid7(), ?, ?, ?, ?, ?, 'open', 'standard', ?, ?, 'agent', ?) RETURNING id`
);
const insTag = sqlite.prepare(
  "INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, ?)"
);

let secondaryLinks = 0;

// Attach a task's tags: the direction (home/work/community) at level 1, plus the
// secondary intention tags at level 2. A tag already at L1 is a no-op at L2 (PK is
// entity_kind+entity_id+tag_id, so it keeps its first/highest level).
function createTask(t: Subtask, parentId: string | null, directionTagId: string, secondary: string[]): string {
  const id = (insTask.get(
    t.title.trim(),
    t.notes ?? null,
    t.due_at ?? null,
    t.estimated_minutes ?? null,
    t.priority ?? 3,
    parentId,
    SYSTEM_OWNER_ID,
    plan.source_ref
  ) as { id: string }).id;
  insTag.run(id, directionTagId, 1);
  for (const name of secondary) {
    if (insTag.run(id, tagId(name), 2).changes > 0) secondaryLinks++;
  }
  return id;
}

const run = sqlite.transaction(() => {
  // Wipe the prior import (this source_ref only), tags first.
  const prior = sqlite.prepare('SELECT id FROM tasks WHERE source_ref = ?').all(plan.source_ref) as { id: string }[];
  for (const r of prior) sqlite.prepare("DELETE FROM entity_tags WHERE entity_kind='task' AND entity_id = ?").run(r.id);
  // parent_id cascades on delete, so a single DELETE removes parents + their subtasks;
  // report the matched count (prior.length), not .changes (which omits cascaded rows).
  sqlite.prepare('DELETE FROM tasks WHERE source_ref = ?').run(plan.source_ref);
  const del = { changes: prior.length };

  let parents = 0, subs = 0;
  const perGroup: Record<string, { parents: number; subs: number }> = {};
  for (const g of plan.groups) {
    const dirTag = tagId(g.group);
    perGroup[g.group] ??= { parents: 0, subs: 0 };
    for (const effort of g.tasks) {
      // The parent's secondary tags are the UNION of its subtasks' secondary tags
      // (subtasks "provide their tags" to the top-level task), plus any on the effort itself.
      const rolledUp = [...new Set([
        ...(effort.secondary ?? []),
        ...(effort.subtasks ?? []).flatMap((s) => s.secondary ?? []),
      ])];
      const parentId = createTask(effort, null, dirTag, rolledUp);
      parents++; perGroup[g.group].parents++;
      for (const st of effort.subtasks ?? []) {
        createTask(st, parentId, dirTag, st.secondary ?? []);
        subs++; perGroup[g.group].subs++;
      }
    }
  }
  // File each secondary (intention) tag under the direction pattern(s) it co-occurs
  // with on these tasks — so the Tags view groups them under Home/Work/Community
  // instead of "Unsorted". Additive (INSERT OR IGNORE): never removes prior membership.
  const cooccur = sqlite.prepare(
    `SELECT DISTINCT l2.tag_id AS intention, l1.tag_id AS direction
       FROM entity_tags l2
       JOIN entity_tags l1
         ON l1.entity_kind = 'task' AND l1.entity_id = l2.entity_id AND l1.level = 1
       JOIN tasks t ON t.id = l2.entity_id
      WHERE l2.entity_kind = 'task' AND l2.level > 1 AND t.source_ref = ?`,
  ).all(plan.source_ref) as { intention: string; direction: string }[];
  const fileTag = sqlite.prepare(
    'INSERT OR IGNORE INTO tag_patterns (intention_tag_id, pattern_tag_id) VALUES (?, ?)',
  );
  let filed = 0;
  for (const { intention, direction } of cooccur) {
    if (fileTag.run(intention, direction).changes > 0) filed++;
  }

  return { deleted: del.changes, parents, subs, secondaryLinks, filed, perGroup };
});

if (dryRun) {
  const counts = plan.groups.map((g) => ({
    group: g.group,
    efforts: g.tasks.length,
    subtasks: g.tasks.reduce((n, t) => n + (t.subtasks?.length ?? 0), 0),
  }));
  console.log('DRY RUN — would import from', planPath);
  console.table(counts);
  process.exit(0);
}

const res = run();
logger.info('import-plan: done', { source_ref: plan.source_ref, ...res });
console.log('\n=== Plan import ===');
console.log('source_ref:      ', plan.source_ref);
console.log('owner:           ', SYSTEM_OWNER_ID);
console.log('prior rows wiped:', res.deleted);
console.log('parent efforts:  ', res.parents);
console.log('subtasks:        ', res.subs);
console.log('total tasks:     ', res.parents + res.subs);
console.log('secondary links: ', res.secondaryLinks, '(level-2 tag attachments)');
console.log('tags filed:      ', res.filed, '(intention->direction memberships)');
console.table(res.perGroup);
console.log('===================\n');
process.exit(0);
