import { sqlite } from '../db/index.js';
import { extractTasks, type ExtractedTask, type ExtractSource } from './extract.js';
import { createGoogleClient, type GoogleClient } from '../mcp/google.js';
import { type ModelTier, OllamaUnavailable } from '../mcp/ollama.js';
import { inferDirection } from './direction.js';
import { currentOwnerId } from '../lib/context.js';
import { newId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';

export interface IngestResult {
  itemsProcessed: number;
  possiblesCreated: number;
  possiblesUpdated: number;
  blocksCreated: number;
}

function emptyResult(): IngestResult {
  return { itemsProcessed: 0, possiblesCreated: 0, possiblesUpdated: 0, blocksCreated: 0 };
}

/** Normalize a tag name the same way the tasks route does. */
function normTag(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').slice(0, 32);
}

function tagId(name: string): string {
  const existing = sqlite.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: string } | undefined;
  if (existing) return existing.id;
  return (sqlite.prepare('INSERT INTO tags (id, name) VALUES (uuid7(), ?) RETURNING id').get(name) as { id: string }).id;
}

/** Resolve a direction tag id, ensuring it exists as a `pattern` tag (the kind the
 *  Auto engine matches pattern windows against). Self-heals if a reset wiped the seed. */
function directionTagId(name: string): string {
  const existing = sqlite
    .prepare(`SELECT id FROM tags WHERE name = ? AND kind = 'pattern'`)
    .get(name) as { id: string } | undefined;
  if (existing) return existing.id;
  return (
    sqlite.prepare(`INSERT INTO tags (id, name, kind) VALUES (uuid7(), ?, 'pattern') RETURNING id`).get(name) as { id: string }
  ).id;
}

/**
 * Deterministic fallback used when Ollama is down: stage the raw item as a single
 * possible-task so nothing is lost. No content tags (the LLM produced none) — the
 * source-inferred direction still tags it downstream (always-on, D4).
 */
function fallbackTask(source: ExtractSource): ExtractedTask {
  const title = (source.subject?.trim() || source.text.split('\n').map((l) => l.trim()).find(Boolean) || 'Review item').slice(0, 200);
  return { title, summary: undefined, priority: 3, dueAt: source.at ?? null, estimatedMinutes: null, tags: [], confidence: 0.3 };
}

/**
 * Upsert one extracted task into possible_tasks keyed by (source_kind, source_ref).
 * Returns 'created' | 'updated'.
 */
export function upsertPossible(
  task: ExtractedTask,
  sourceKind: string,
  sourceRef: string,
  payload: unknown
): 'created' | 'updated' {
  const existing = sqlite
    .prepare('SELECT id FROM possible_tasks WHERE source_kind = ? AND source_ref = ?')
    .get(sourceKind, sourceRef) as { id: string } | undefined;

  let possibleId: string;
  let outcome: 'created' | 'updated';

  if (existing) {
    sqlite
      .prepare(
        `UPDATE possible_tasks SET raw_title = ?, raw_summary = ?, proposed_due_at = ?,
         proposed_priority = ?, source_payload = ?, confidence = ? WHERE id = ?`
      )
      .run(
        task.title,
        task.summary ?? null,
        task.dueAt ?? null,
        task.priority,
        JSON.stringify(payload),
        task.confidence,
        existing.id
      );
    possibleId = existing.id;
    outcome = 'updated';
  } else {
    const row = sqlite
      .prepare(
        `INSERT INTO possible_tasks
         (id, raw_title, raw_summary, proposed_due_at, proposed_priority, proposed_owner_id,
          source_kind, source_ref, source_payload, confidence, status)
         VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING id`
      )
      .get(
        task.title,
        task.summary ?? null,
        task.dueAt ?? null,
        task.priority,
        currentOwnerId(), // was a stale `1` literal — broke the owners FK after CON-1 (0030)
        sourceKind,
        sourceRef,
        JSON.stringify(payload),
        task.confidence
      ) as { id: string };
    possibleId = row.id;
    outcome = 'created';
  }

  // Attach the LLM's free-form content tags (idempotent) — kept as secondary
  // intention tags on promote.
  for (const raw of task.tags) {
    const id = tagId(normTag(raw));
    sqlite
      .prepare('INSERT OR IGNORE INTO possible_task_tags (possible_task_id, tag_id) VALUES (?, ?)')
      .run(possibleId, id);
  }

  // Always attach exactly one direction (pattern) tag (D4) — source-inferred, so it
  // is present even with Ollama down (task.tags empty ⇒ source decides). This is the
  // placement-relevant tag the Auto engine matches pattern windows against.
  const from = (payload as { from?: string } | null)?.from;
  const direction = inferDirection({ sourceKind, from, contentTags: task.tags });
  sqlite
    .prepare('INSERT OR IGNORE INTO possible_task_tags (possible_task_id, tag_id) VALUES (?, ?)')
    .run(possibleId, directionTagId(direction));

  return outcome;
}

// ─── Gmail watermark cursor + dead-letter (sync_state, resource-keyed) ─────────

const GMAIL_PROVIDER = 'google';
const GMAIL_SINCE = 'gmail_since';
const GMAIL_DEADLETTER = 'gmail_deadletter';
/**
 * Account discriminator for the gmail cursor rows. The GoogleClient interface (mcp-owned)
 * exposes no account getter, so until a per-account ingest lands we key the watermark on a
 * single logical mailbox. Callers can override via opts.account.
 */
const GMAIL_DEFAULT_ACCOUNT = 'primary';

/** Read the persisted `since` watermark for (owner, google, account), or undefined. */
function readGmailSince(ownerId: string, account: string): string | undefined {
  const row = sqlite
    .prepare(
      `SELECT cursor FROM sync_state
       WHERE owner_id = ? AND provider = ? AND account = ? AND resource = ?`,
    )
    .get(ownerId, GMAIL_PROVIDER, account, GMAIL_SINCE) as { cursor: string | null } | undefined;
  return row?.cursor ?? undefined;
}

/**
 * Advance the `since` watermark to the newest processed receivedAt. Advance-AFTER-commit:
 * called only once the batch's possibles are committed, so a crash mid-batch re-reads the
 * OLD watermark and reprocesses (idempotent on source_ref) rather than skipping items.
 * Only moves forward (never regresses to an older timestamp).
 */
function advanceGmailSince(ownerId: string, account: string, newest: string): void {
  const prev = readGmailSince(ownerId, account);
  if (prev && newest <= prev) return;
  sqlite
    .prepare(
      `INSERT INTO sync_state (id, owner_id, provider, account, resource, cursor)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, provider, account, resource) DO UPDATE SET
         cursor = excluded.cursor,
         updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    )
    .run(newId(), ownerId, GMAIL_PROVIDER, account, GMAIL_SINCE, newest);
}

/**
 * Append a poison message id to the dead-letter list (sync_state, resource='gmail_deadletter',
 * cursor = JSON array — queryable). A poison message never wedges the pipeline and is not
 * silently lost: it's recorded here while the watermark still advances past it.
 */
function deadLetterGmail(ownerId: string, account: string, messageId: string): void {
  const row = sqlite
    .prepare(
      `SELECT cursor FROM sync_state
       WHERE owner_id = ? AND provider = ? AND account = ? AND resource = ?`,
    )
    .get(ownerId, GMAIL_PROVIDER, account, GMAIL_DEADLETTER) as { cursor: string | null } | undefined;
  let ids: string[] = [];
  if (row?.cursor) {
    try {
      const parsed = JSON.parse(row.cursor);
      if (Array.isArray(parsed)) ids = parsed.filter((x): x is string => typeof x === 'string');
    } catch {
      /* corrupt list → start fresh */
    }
  }
  if (!ids.includes(messageId)) ids.push(messageId);
  sqlite
    .prepare(
      `INSERT INTO sync_state (id, owner_id, provider, account, resource, cursor)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id, provider, account, resource) DO UPDATE SET
         cursor = excluded.cursor,
         updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
    )
    .run(newId(), ownerId, GMAIL_PROVIDER, account, GMAIL_DEADLETTER, JSON.stringify(ids));
}

async function runExtraction(
  source: ExtractSource,
  tier: ModelTier,
  payload: unknown,
  result: IngestResult
): Promise<void> {
  result.itemsProcessed++;
  let tasks: ExtractedTask[];
  try {
    tasks = await extractTasks(source, { tier });
  } catch (err) {
    // Deterministic fallback (global constraint): when Ollama is down, don't drop the
    // item — stage it raw so it still arrives, source-tagged. Re-throw anything else.
    if (!(err instanceof OllamaUnavailable)) throw err;
    logger.warn('extract fallback (Ollama unavailable)', { kind: source.kind, ref: source.ref });
    tasks = [fallbackTask(source)];
  }
  tasks.forEach((task, i) => {
    const outcome = upsertPossible(task, source.kind, `${source.ref}#${i}`, payload);
    if (outcome === 'created') result.possiblesCreated++;
    else result.possiblesUpdated++;
  });
}

/**
 * Ingest emails → possible_tasks, advancing a persisted `since` watermark.
 *
 * Cursor: reads the (owner, google, account) `since` watermark from sync_state and passes
 * it to client.listEmails so each cycle only sees messages newer than the last processed
 * one. After the batch commits, advances the watermark to the newest processed receivedAt
 * (advance-AFTER-commit — a crash re-reads the old watermark and reprocesses idempotently
 * rather than skipping). NOTE: a Gmail historyId cursor is a later refinement (WP8/live);
 * the GoogleClient interface is mcp-owned, so we use its existing { since, limit } param.
 *
 * Poison isolation: each per-message runExtraction is wrapped — a non-transient error
 * dead-letters that message id (sync_state, resource='gmail_deadletter') and CONTINUES; the
 * watermark still advances past it so one bad message can never wedge the pipeline or be
 * silently lost. An explicit `opts.since` overrides the persisted watermark (manual replay).
 */
export async function ingestEmails(
  client: GoogleClient = createGoogleClient(),
  opts: { since?: string; tier?: ModelTier; limit?: number; account?: string } = {}
): Promise<IngestResult> {
  const result = emptyResult();
  const ownerId = currentOwnerId();
  const account = opts.account ?? GMAIL_DEFAULT_ACCOUNT;
  const since = opts.since ?? readGmailSince(ownerId, account);

  const emails = await client.listEmails({ since, limit: opts.limit });
  let newestProcessed: string | undefined;
  for (const email of emails) {
    try {
      await runExtraction(
        { kind: 'gmail', ref: email.id, subject: email.subject, text: email.body, at: email.receivedAt },
        opts.tier ?? 'medium',
        { from: email.from, subject: email.subject },
        result
      );
    } catch (err) {
      // Non-transient failure on this message → dead-letter and keep going. Do NOT rethrow
      // (that would wedge the whole batch). OllamaUnavailable is handled inside runExtraction
      // as a fallback, so anything reaching here is a genuine poison message.
      deadLetterGmail(ownerId, account, email.id);
      logger.error('gmail message dead-lettered', { id: email.id, err: (err as Error).message });
    }
    // Watermark advances past EVERY message we've moved past, dead-lettered included.
    if (!newestProcessed || email.receivedAt > newestProcessed) newestProcessed = email.receivedAt;
  }

  // Advance-after-commit: only after the loop's possibles are committed.
  if (newestProcessed) advanceGmailSince(ownerId, account, newestProcessed);

  logger.info('ingestEmails done', result);
  return result;
}

/**
 * Ingest calendar events → prep possible_tasks ONLY. Throws if Ollama unavailable.
 *
 * As of WP5 this no longer creates meeting blocks: the locked meeting mirror is produced
 * exclusively by sync.ts applyInbound (the single canonical inbound path), so the two
 * pipelines can never race to double-create the same block. IngestResult.blocksCreated is
 * therefore always 0; ingestEvents runs task extraction over each event's title+description.
 */
export async function ingestEvents(
  client: GoogleClient = createGoogleClient(),
  opts: { from?: string; to?: string; tier?: ModelTier; limit?: number } = {}
): Promise<IngestResult> {
  const result = emptyResult();
  const events = await client.listEvents({ from: opts.from, to: opts.to, limit: opts.limit });
  for (const event of events) {
    const text = `${event.title}\n${event.description}`.trim();
    if (text) {
      await runExtraction(
        { kind: 'gcal', ref: event.id, subject: event.title, text, at: event.start },
        opts.tier ?? 'medium',
        { title: event.title, start: event.start },
        result
      );
    }
  }
  logger.info('ingestEvents done', result);
  return result;
}

/** Ingest a freeform block of text (notes, meeting minutes) → possible_tasks. */
export async function ingestText(
  text: string,
  ref: string,
  opts: { tier?: ModelTier } = {}
): Promise<IngestResult> {
  const result = emptyResult();
  await runExtraction({ kind: 'text', ref, text }, opts.tier ?? 'medium', { ref }, result);
  logger.info('ingestText done', result);
  return result;
}
