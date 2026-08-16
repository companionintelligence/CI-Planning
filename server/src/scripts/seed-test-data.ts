/**
 * Seed the database with ~100 tasks derived from test fixtures
 * (emails, calendar events, and a freeform notes file) using Ollama for extraction.
 *
 * Usage:
 *   tsx src/scripts/seed-test-data.ts [--target=100] [--tier=medium|small] [--no-reset] [--no-llm]
 *
 * Explicit todo bullets in tasks.md are parsed directly. Unstructured email and
 * calendar text is mined by the LLM (with a deterministic fallback if Ollama is down),
 * so the bulk of the seeded tasks genuinely come from model extraction. A deterministic
 * top-up guarantees the target count is met.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
// Side-effect import: opening db/index.js runs migrations and installs the store
// facade (setStore) — without it store() throws before the first statement.
import '../db/index.js';
import { store } from '../db/store.js';
import { extractTasks, type ExtractedTask } from '../agents/extract.js';
import { guessEstimateMinutes, guessPriority } from '../agents/fallback-shape.js';
import { upsertPossible } from '../agents/ingest.js';
import { promotePossibles } from '../agents/groom.js';
import { createFixtureGoogleClient, type EmailMessage, type CalendarEvent } from '../mcp/google.js';
import { isReady, type ModelTier } from '../mcp/ollama.js';
import { prepTaskTitle } from './prep-task-title.js';
import { logger } from '../lib/logger.js';
import { SYSTEM_OWNER, runWithOwner, ALL_SCOPES } from '../lib/context.js';

const _dir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(_dir, '..', '..', 'test', 'fixtures');

interface Args {
  target: number;
  tier: ModelTier;
  reset: boolean;
  useLlm: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
  return {
    target: Number(get('target') ?? 100),
    tier: (get('tier') as ModelTier) ?? 'quality',
    // OPT-IN, deliberately. This used to be `!argv.includes('--no-reset')`, i.e. a bare
    // `pnpm seed` — the exact command the README hands a new owner — silently ran
    // resetData(), which DELETEs every task, possible, block and tag in the database with
    // no owner filter and no confirmation. Seeding is additive by default now; wiping is
    // something you have to ask for by name.
    reset: argv.includes('--reset'),
    useLlm: !argv.includes('--no-llm'),
  };
}

/**
 * DESTRUCTIVE. Deletes every task, possible, block and tag in the database — for ALL
 * owners, not just the seed owner. Only ever reached via an explicit `--reset`.
 *
 * The three base direction tags are deliberately EXEMPT (`is_base = 1`, set by
 * migrations/0036_tag_directions.ts). They are schema furniture rather than seed
 * data, and deleting them took the owner's entire availability pattern with them:
 * `pattern_blocks.direction_tag_id` is `REFERENCES tags(id) ON DELETE CASCADE`
 * (migrations/0037_pattern_blocks.ts:31), so with `foreign_keys = ON` a bare
 * `DELETE FROM tags` cascaded away every default scheduling window. Migration 0037
 * seeds those windows only for an owner that has no pattern_blocks rows yet, and it
 * had already run, so nothing ever put them back — a reset left the Auto engine with
 * no windows to place anything into, silently and permanently.
 *
 * Keeping the base rows also keeps their ids stable, so anything already pointing at
 * a direction still resolves after a reset.
 */
async function resetData() {
  await store().exec(`
    DELETE FROM possible_task_tags;
    DELETE FROM entity_tags;
    DELETE FROM time_blocks;
    DELETE FROM possible_tasks;
    DELETE FROM tasks;
    DELETE FROM tags WHERE COALESCE(is_base, 0) = 0;
    DELETE FROM job_runs;
  `);
  logger.info('seed: reset existing tasks/possibles/blocks/tags (base directions kept)');
}

/** COUNT(*)-style scalar read; a SELECT COUNT always returns a row, `?? 0` is for the type. */
const count = async (sql: string, ...params: unknown[]) =>
  (await store().prepare(sql).get<{ n: number }>(...params))?.n ?? 0;

/** Run async workers over items with a bounded concurrency pool. */
async function pool<T>(items: T[], concurrency: number, worker: (item: T, i: number) => Promise<void>) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

/** Deterministic fallback: turn an email/event into a single task from its subject/title. */
function fallbackTask(title: string, summary: string): ExtractedTask {
  // Both fields feed the heuristics: the subject carries the verb, the body carries
  // the deadline ("two things before Friday", "target go-live is June 5").
  const corpus = `${title}\n${summary}`;
  return {
    title: title.slice(0, 200),
    summary,
    priority: guessPriority(corpus),
    dueAt: null,
    estimatedMinutes: guessEstimateMinutes(corpus),
    tags: [],
    confidence: 0.55,
  };
}

/**
 * Titles for the count top-up in step 5.
 *
 * These used to be `Follow-up task 1..N`. The top-up exists so `--target=N` is
 * honoured whatever the fixtures happen to yield, and it is tagged `seed-filler` so
 * it is trivially deletable — but the rows are real rows in the real backlog and they
 * show up in the Tasks list, in search, and in whatever the auto-scheduler places.
 * "Follow-up task 12" on screen reads as an unfinished app. These read as a Tuesday.
 *
 * Ordinary, low-stakes admin on purpose: nothing here claims a capability, a customer
 * or a number. The list is cycled deterministically, so the same `--target` always
 * produces the same titles in the same order.
 */
const FILLER_TITLES = [
  'Reconcile the AWS invoice against the usage report',
  'Archive last quarter’s design files',
  'Update the team handbook onboarding section',
  'Renew the domain registration',
  'Clear the shared inbox down to zero',
  'Back up the demo laptop before the trip',
  'Order replacement USB-C cables for the demo kit',
  'Refresh the headshot on the website team page',
  'Rotate the staging database credentials',
  'File the mileage receipts from last month',
  'Trim the unused GitHub Actions runners',
  'Update the calendar link in the email signature',
  'Sort the hardware shelf and label the bins',
  'Cancel the duplicate analytics subscription',
  'Write the changelog entry for the last release',
  'Book the flights for the September conference',
  'Check the office smoke-alarm batteries',
  'Export the contact list for the newsletter',
  'Review the open Dependabot alerts',
  'Set up the out-of-office for the holiday week',
  'Consolidate the three note-taking apps into one',
  'Photograph the prototype for the press kit',
  'Recycle the packaging from the dev-kit shipment',
  'Move the old SD-card backups onto the NAS',
];

/** Deterministic, wraps with a pass suffix so titles stay unique past 24. */
function fillerTitle(i: number): string {
  const title = FILLER_TITLES[(i - 1) % FILLER_TITLES.length];
  const pass = Math.floor((i - 1) / FILLER_TITLES.length);
  return pass === 0 ? title : `${title} (${pass + 1})`;
}

/**
 * emails.json / calendar.json hardcode dates to the week of Monday 2026-06-01 (see
 * server/test/fixtures/*.json). Loaded verbatim on any other week, every meeting block
 * and LLM-derived due date lands there too — the seed reports creating rows, but the
 * Today view and the Calendar view's current week come up empty because nothing falls
 * in the week actually being looked at. Shift every fixture timestamp by the gap between
 * that anchor Monday and the current week's Monday so a fresh seed always lands its
 * events and due-dates in the week it's run, whatever day that is.
 *
 * Week-aligned rather than a flat "now minus original date" delta: shifting by whole
 * weeks keeps each event on the same weekday it was authored for (the Monday standup
 * stays a Monday, the Saturday holiday stays a Saturday) instead of drifting onto
 * whatever weekday the seed happens to run on.
 */
const FIXTURE_WEEK_ANCHOR_UTC = Date.UTC(2026, 5, 1); // Monday — the week the fixtures are staged for

function startOfWeekUtc(d: Date): number {
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - ((dow + 6) % 7));
}

function fixtureDateOffsetMs(now: Date): number {
  return startOfWeekUtc(now) - FIXTURE_WEEK_ANCHOR_UTC;
}

function shiftIso(iso: string, offsetMs: number): string {
  return new Date(new Date(iso).getTime() + offsetMs).toISOString();
}

/** Parse "- bullet" lines from the notes file, grouping under their ## heading as a tag. */
function parseNotesBullets(md: string): { title: string; tag: string }[] {
  const out: { title: string; tag: string }[] = [];
  let tag = 'notes';
  for (const line of md.split('\n')) {
    const heading = line.match(/^##\s+(.+)/);
    if (heading) {
      tag = heading[1].toLowerCase().split(/[\s/]+/)[0].slice(0, 32);
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)/);
    if (bullet) out.push({ title: bullet[1].trim(), tag });
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  logger.info('seed: starting', args);

  if (args.reset) await resetData();

  const google = createFixtureGoogleClient();
  // `isReady`: seeding wants a model it can actually call, not merely a reachable Ollama.
  const llmUp = args.useLlm && (await isReady());
  if (args.useLlm && !llmUp) logger.warn('seed: Ollama unavailable — using deterministic fallback extraction');

  const fixtureOffsetMs = fixtureDateOffsetMs(new Date());
  if (fixtureOffsetMs !== 0) {
    logger.info(`seed: shifting fixture dates by ${Math.round(fixtureOffsetMs / 86_400_000)}d to land in the current week`);
  }

  let possiblesCreated = 0;

  // 1) Notes bullets — explicit todos, parsed directly (no LLM needed).
  const notesPath = join(fixturesDir, 'tasks.md');
  const bullets = parseNotesBullets(readFileSync(notesPath, 'utf8'));
  // for-of, not forEach: an async callback handed to forEach is never awaited — the
  // promise is dropped on the floor, so the counter below would never run and a failure
  // would surface as an unhandled rejection instead of failing the seed.
  for (const [i, b] of bullets.entries()) {
    const task: ExtractedTask = {
      title: b.title,
      priority: guessPriority(b.title),
      dueAt: null,
      estimatedMinutes: guessEstimateMinutes(b.title),
      tags: [b.tag],
      confidence: 0.8,
    };
    if ((await upsertPossible(task, 'text', `notes#${i}`, { source: 'tasks.md' })) === 'created') possiblesCreated++;
  }
  logger.info(`seed: ${bullets.length} notes bullets ingested`);

  // 2) Emails — LLM extraction (fallback to subject-as-task).
  const emails = (await google.listEmails()).map((e) => ({ ...e, receivedAt: shiftIso(e.receivedAt, fixtureOffsetMs) }));
  await pool(emails, 3, async (email: EmailMessage) => {
    let tasks: ExtractedTask[];
    try {
      tasks = llmUp
        ? await extractTasks({ kind: 'gmail', ref: email.id, subject: email.subject, text: email.body, at: email.receivedAt }, { tier: args.tier })
        : [fallbackTask(email.subject, email.body)];
    } catch (err) {
      logger.warn('seed: email extraction failed, using fallback', { id: email.id, err: (err as Error).message });
      tasks = [fallbackTask(email.subject, email.body)];
    }
    for (const [i, t] of tasks.entries()) {
      if ((await upsertPossible(t, 'gmail', `${email.id}#${i}`, { from: email.from, subject: email.subject })) === 'created') possiblesCreated++;
    }
  });
  logger.info(`seed: emails processed (${emails.length})`);

  // 3) Calendar — meeting blocks + LLM prep-task extraction.
  const events = (await google.listEvents()).map((e) => ({
    ...e,
    start: shiftIso(e.start, fixtureOffsetMs),
    end: shiftIso(e.end, fixtureOffsetMs),
  }));
  await pool(events, 3, async (event: CalendarEvent) => {
    // Mirror the event as a read-only meeting block.
    const exists = await store().prepare("SELECT id FROM time_blocks WHERE source_kind='gcal' AND source_ref=? AND owner_id=?").get(event.id, SYSTEM_OWNER);
    if (!exists) {
      await store()
        .prepare(
          `INSERT INTO time_blocks (id, task_id, owner_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, source_ref, status)
           VALUES (uuid7(), NULL, ?, ?, 'meeting', ?, ?, 1, 0, 'gcal', ?, 'planned')`
        )
        .run(SYSTEM_OWNER, event.title, event.start, event.end, event.id);
    }
    const text = `${event.title}\n${event.description}`.trim();
    // An event that implies no work produces no task — see prepTaskTitle.
    const prep = prepTaskTitle(event);
    const fallback = prep ? [fallbackTask(prep, event.description)] : [];
    let tasks: ExtractedTask[];
    try {
      tasks = llmUp
        ? await extractTasks({ kind: 'gcal', ref: event.id, subject: event.title, text, at: event.start }, { tier: args.tier })
        : fallback;
    } catch (err) {
      logger.warn('seed: event extraction failed, using fallback', { id: event.id, err: (err as Error).message });
      tasks = fallback;
    }
    for (const [i, t] of tasks.entries()) {
      if ((await upsertPossible(t, 'gcal', `${event.id}#${i}`, { title: event.title })) === 'created') possiblesCreated++;
    }
  });
  logger.info(`seed: calendar processed (${events.length})`);

  // 4) Promote — unconditional since AF-3 (every pending possible becomes a task).
  const promoted = await promotePossibles();
  logger.info('seed: promoted', promoted);

  // 5) Top up to the target with deterministic filler so the deliverable is guaranteed.
  let taskCount = await count('SELECT COUNT(*) AS n FROM tasks');
  const fillerNeeded = Math.max(0, args.target - taskCount);
  if (fillerNeeded > 0) {
    await store().prepare("INSERT OR IGNORE INTO tags (id, owner_id, name) VALUES (uuid7(), ?, 'seed-filler')").run(SYSTEM_OWNER);
    const fillerTag = await store().prepare("SELECT id FROM tags WHERE owner_id = ? AND name='seed-filler'").get<{ id: string }>(SYSTEM_OWNER);
    if (!fillerTag) throw new Error('seed-filler tag missing right after INSERT OR IGNORE');
    const fillerTagId = fillerTag.id;
    // owner_id was a hardcoded `1` from the pre-0030 integer-id era — no owner row
    // '1' exists post-uuidv7, so with foreign_keys=ON every filler insert would fail.
    const insert = store().prepare(
      `INSERT INTO tasks (id, title, priority, owner_id, source_kind, status, estimated_minutes) VALUES (uuid7(), ?, ?, ?, 'agent', 'open', ?) RETURNING id`
    );
    await store().transaction(async () => {
      for (let i = 1; i <= fillerNeeded; i++) {
        const r = await insert.get<{ id: string }>(fillerTitle(i), 3 + (i % 3), SYSTEM_OWNER, 15 + (i % 4) * 15);
        if (!r) throw new Error('filler task insert returned no row');
        // entity_tags is the sole task-tag store (CON-3 / migration 0041).
        await store().prepare("INSERT OR IGNORE INTO entity_tags (entity_kind, entity_id, tag_id, level) VALUES ('task', ?, ?, 1)").run(r.id, fillerTagId);
      }
    });
    logger.warn(`seed: added ${fillerNeeded} deterministic filler tasks to reach target ${args.target}`);
  }

  taskCount = await count('SELECT COUNT(*) AS n FROM tasks');
  const possibleCount = await count('SELECT COUNT(*) AS n FROM possible_tasks');
  const blockCount = await count('SELECT COUNT(*) AS n FROM time_blocks');
  const pendingCount = await count("SELECT COUNT(*) AS n FROM possible_tasks WHERE status='pending'");

  console.log('\n=== Seed summary ===');
  console.log(`LLM extraction:     ${llmUp ? 'ON (' + args.tier + ')' : 'OFF (fallback)'}`);
  console.log(`Possibles created:  ${possiblesCreated} (total ${possibleCount}, ${pendingCount} still pending)`);
  console.log(`Tasks promoted:     ${promoted.promoted}`);
  console.log(`Filler added:       ${fillerNeeded}`);
  console.log(`Meeting blocks:     ${blockCount}`);
  console.log(`TOTAL TASKS:        ${taskCount}`);
  console.log('====================\n');

  if (taskCount < args.target) {
    logger.error(`seed: only ${taskCount} tasks (target ${args.target})`);
    process.exit(1);
  }
}

// Owner-scoped writes (upsertPossible, promotePossibles) resolve the owner via
// currentOwnerId(), which fails loud outside a runWithOwner scope — bind the system
// owner + trusted scopes for the whole run, mirroring the cron/job dispatcher.
runWithOwner(SYSTEM_OWNER, ALL_SCOPES, () => main())
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error('seed failed', { err: (err as Error).message, stack: (err as Error).stack });
    process.exit(1);
  });
