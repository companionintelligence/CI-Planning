import { store } from '../db/store.js';
import { extractTasks, type ExtractedTask, type ExtractSource } from './extract.js';
import { createGoogleClient, type GoogleClient } from '../mcp/google.js';
import { type ModelTier, OllamaUnavailable } from '../mcp/ollama.js';
import { inferDirection } from './direction.js';
import { currentOwnerId } from '../lib/context.js';
import { newId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import { promoteAllPending } from '../services/possibles.js';
import { dedupePossibles } from './groom.js';
import { broadcast } from '../routes/sse.js';

export interface IngestResult {
  itemsProcessed: number;
  possiblesCreated: number;
  possiblesUpdated: number;
  blocksCreated: number;
  /** AF-3: possibles auto-promoted into tasks at the end of this batch. */
  promoted: number;
  /** AF-3: possibles the inline semantic dedupe marked 'duplicate' this batch. */
  duplicates: number;
  /** AF-CU1: possibles whose promote threw (poison isolation) — left pending for the
   *  nightly sweeper / manual triage. */
  failed: number;
}

function emptyResult(): IngestResult {
  return { itemsProcessed: 0, possiblesCreated: 0, possiblesUpdated: 0, blocksCreated: 0, promoted: 0, duplicates: 0, failed: 0 };
}

/**
 * AF-3 — hands-off pipeline: at the end of an AUTO-PROMOTED producer batch (calendar
 * events, pasted text), dedupe + promote the owner's pending possibles into real tasks
 * (services/possibles.ts). possible_tasks remains as the dedup/audit trail. Mutates
 * `result` with the batch counts.
 *
 * NOT used by ingestEmails — email is review-gated (services/review-gate.ts) and its
 * possibles wait for the owner. promoteAllPending would skip them anyway; ingestEmails
 * simply doesn't call this so its `promoted` count stays honestly 0.
 */
async function promoteBatch(result: IngestResult): Promise<void> {
  const r = await promoteAllPending(currentOwnerId());
  result.promoted += r.promoted;
  result.duplicates += r.duplicates;
  result.failed += r.failed;
}

/** Normalize a tag name the same way the tasks route does. */
function normTag(name: string): string {
  return name.toLowerCase().replace(/\s+/g, '-').slice(0, 32);
}

/**
 * Resolve a content tag id, creating it if absent.
 *
 * SELECT-then-INSERT is not safe here and used to break the seed: ingest runs
 * under `pool(..., 3, ...)` (scripts/seed-test-data.ts), so three workers can
 * miss the same absent name and all three INSERT, and the losers fail with
 * `UNIQUE constraint failed: tags.owner_id, tags.name`. A single upsert closes
 * the window — the no-op DO UPDATE exists only so RETURNING yields the existing
 * row on conflict, and it deliberately does NOT touch `kind`, so a name that is
 * already a direction tag keeps its kind instead of being demoted.
 */
async function tagId(name: string): Promise<string> {
  const owner = currentOwnerId();
  return (await store()
    .prepare(
      `INSERT INTO tags (id, owner_id, name) VALUES (uuid7(), ?, ?)
         ON CONFLICT(owner_id, name) DO UPDATE SET name = excluded.name
         RETURNING id`,
    )
    .get<{ id: string }>(owner, name))!.id;
}

/**
 * Resolve a direction tag id, ensuring it exists as a `direction` tag (the kind the
 * Auto engine matches pattern-block windows against). Self-heals if a reset wiped the seed.
 *
 * Same race as tagId, plus one of its own: the old lookup filtered on
 * `kind = 'direction'`, so a tag with this name and any other kind was invisible
 * to the SELECT and the INSERT then hit the (owner_id, name) unique index —
 * `tags.kind` defaults to 'intention' (migrations/0036), so an intention tag
 * sharing a direction's name was enough to wedge ingest permanently.
 *
 * The upsert resolves both: one row per (owner, name) is all the schema allows,
 * so a name used as a direction is promoted to one. That is exactly what
 * migration 0036 does with its own `promote` statement for a pre-existing tag,
 * and `is_base` is set for the same reason — a direction recreated after a reset
 * should match what the migration would have created, not a lookalike.
 */
async function directionTagId(name: string): Promise<string> {
  const owner = currentOwnerId();
  return (await store()
    .prepare(
      `INSERT INTO tags (id, owner_id, name, kind, is_base) VALUES (uuid7(), ?, ?, 'direction', 1)
         ON CONFLICT(owner_id, name) DO UPDATE SET kind = 'direction', is_base = 1
         RETURNING id`,
    )
    .get<{ id: string }>(owner, name))!.id;
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
 * Upsert one extracted task into possible_tasks keyed by (proposed_owner_id,
 * source_kind, source_ref) — owner-scoped since 0114: in fixture mode all owners see
 * the same source_refs, so an unscoped key let one owner's row absorb another's
 * content. Returns 'created' | 'updated'.
 */
export async function upsertPossible(
  task: ExtractedTask,
  sourceKind: string,
  sourceRef: string,
  payload: unknown
): Promise<'created' | 'updated'> {
  const owner = currentOwnerId();
  const existing = await store()
    .prepare('SELECT id FROM possible_tasks WHERE proposed_owner_id = ? AND source_kind = ? AND source_ref = ?')
    .get<{ id: string }>(owner, sourceKind, sourceRef);

  let possibleId: string;
  let outcome: 'created' | 'updated';

  if (existing) {
    await store()
      .prepare(
        `UPDATE possible_tasks SET raw_title = ?, raw_summary = ?, proposed_due_at = ?,
         proposed_scheduled_for = ?, proposed_task_time = ?,
         proposed_priority = ?, proposed_estimated_minutes = ?, source_payload = ?, confidence = ? WHERE id = ?`
      )
      .run(
        task.title,
        task.summary ?? null,
        task.dueAt ?? null,
        task.scheduledFor ?? null,
        task.taskTime ?? null,
        task.priority,
        task.estimatedMinutes ?? null,
        JSON.stringify(payload),
        task.confidence,
        existing.id
      );
    possibleId = existing.id;
    outcome = 'updated';
  } else {
    const row = (await store()
      .prepare(
        `INSERT INTO possible_tasks
         (id, raw_title, raw_summary, proposed_due_at, proposed_scheduled_for, proposed_task_time,
          proposed_priority, proposed_estimated_minutes,
          proposed_owner_id, source_kind, source_ref, source_payload, confidence, status)
         VALUES (uuid7(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending') RETURNING id`
      )
      .get<{ id: string }>(
        task.title,
        task.summary ?? null,
        task.dueAt ?? null,
        task.scheduledFor ?? null,
        task.taskTime ?? null,
        task.priority,
        task.estimatedMinutes ?? null,
        owner, // was a stale `1` literal — broke the owners FK after CON-1 (0030)
        sourceKind,
        sourceRef,
        JSON.stringify(payload),
        task.confidence
      ))!;
    possibleId = row.id;
    outcome = 'created';
  }

  // Attach the LLM's free-form content tags (idempotent) — kept as secondary
  // intention tags on promote.
  for (const raw of task.tags) {
    const id = await tagId(normTag(raw));
    await store()
      .prepare('INSERT OR IGNORE INTO possible_task_tags (possible_task_id, tag_id) VALUES (?, ?)')
      .run(possibleId, id);
  }

  // Always attach exactly one direction (pattern) tag (D4) — source-inferred, so it
  // is present even with Ollama down (task.tags empty ⇒ source decides). This is the
  // placement-relevant tag the Auto engine matches pattern windows against.
  const from = (payload as { from?: string } | null)?.from;
  const direction = inferDirection({ sourceKind, from, contentTags: task.tags });
  await store()
    .prepare('INSERT OR IGNORE INTO possible_task_tags (possible_task_id, tag_id) VALUES (?, ?)')
    .run(possibleId, await directionTagId(direction));

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

/** Column default (0147) for an owner with no seeded scheduling_prefs row. */
const DEFAULT_EMAIL_LOOKBACK_DAYS = 7;

/**
 * The oldest instant a Gmail ingest may reach: now − `scheduling_prefs.email_lookback_days`
 * (0147). Applied as a FLOOR on the watermark, not just a first-run seed, so reconnecting
 * after a long outage pulls the configured window rather than replaying months of mail
 * through the extraction LLM. On the normal 15-minute cadence the watermark is always
 * newer than this, so the floor never bites and the steady state is unchanged.
 *
 * A non-positive stored value is treated as unset — a bad row must not collapse the
 * window to "now" and silently stop ingesting.
 */
async function gmailLookbackFloor(ownerId: string): Promise<string> {
  const row = await store()
    .prepare(`SELECT email_lookback_days FROM scheduling_prefs WHERE owner_id = ?`)
    .get<{ email_lookback_days?: number | null }>(ownerId);
  const days = Number(row?.email_lookback_days);
  const effective = Number.isFinite(days) && days > 0 ? days : DEFAULT_EMAIL_LOOKBACK_DAYS;
  return new Date(Date.now() - effective * 86_400_000).toISOString();
}

/** Read the persisted `since` watermark for (owner, google, account), or undefined. */
async function readGmailSince(ownerId: string, account: string): Promise<string | undefined> {
  const row = await store()
    .prepare(
      `SELECT cursor FROM sync_state
       WHERE owner_id = ? AND provider = ? AND account = ? AND resource = ?`,
    )
    .get<{ cursor: string | null }>(ownerId, GMAIL_PROVIDER, account, GMAIL_SINCE);
  return row?.cursor ?? undefined;
}

/**
 * Advance the `since` watermark to the newest processed receivedAt. Advance-AFTER-commit:
 * called only once the batch's possibles are committed, so a crash mid-batch re-reads the
 * OLD watermark and reprocesses (idempotent on source_ref) rather than skipping items.
 * Only moves forward (never regresses to an older timestamp).
 *
 * The read and the write are no longer contiguous, so two overlapping ingests for one
 * (owner, account) can both pass the forward check and the older watermark can win. Left
 * as-is deliberately: the loser's effect is that the next run re-reads an older watermark
 * and reprocesses, which is idempotent on source_ref — the documented crash behaviour
 * already. Contrast blocks-recur's EXDATE, where losing the race resurrected deleted user
 * data and had to be closed. Worth folding into the ON CONFLICT clause post-cutover.
 */
async function advanceGmailSince(ownerId: string, account: string, newest: string): Promise<void> {
  const prev = await readGmailSince(ownerId, account);
  if (prev && newest <= prev) return;
  await store()
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
 *
 * Same read-modify-write-a-JSON-array shape as blocks-recur's EXDATE, and likewise no
 * longer contiguous. Not guarded, for the same reason as advanceGmailSince: a lost race
 * drops one poison message id from a diagnostic list, not user data. Post-cutover this
 * wants the append pushed into the ON CONFLICT clause.
 */
async function deadLetterGmail(ownerId: string, account: string, messageId: string): Promise<void> {
  const row = await store()
    .prepare(
      `SELECT cursor FROM sync_state
       WHERE owner_id = ? AND provider = ? AND account = ? AND resource = ?`,
    )
    .get<{ cursor: string | null }>(ownerId, GMAIL_PROVIDER, account, GMAIL_DEADLETTER);
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
  await store()
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
  // for-of, not forEach: forEach never awaits an async callback, so the counters below
  // would not run and a failed upsert would become an unhandled rejection.
  for (const [i, task] of tasks.entries()) {
    const outcome = await upsertPossible(task, source.kind, `${source.ref}#${i}`, payload);
    if (outcome === 'created') result.possiblesCreated++;
    else result.possiblesUpdated++;
  }
}

/**
 * Ingest emails → possible_tasks, advancing a persisted `since` watermark.
 *
 * Cursor: reads the (owner, google, account) `since` watermark from sync_state, floors it
 * at `scheduling_prefs.email_lookback_days` (0147 — see gmailLookbackFloor), and passes
 * the result to client.listEmails so each cycle only sees messages newer than the last
 * processed one. After the batch commits, advances the watermark to the newest receivedAt
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
  // An explicit opts.since is a manual replay and bypasses the floor deliberately — the
  // caller has named the window. Otherwise take the LATER of the watermark and the
  // lookback floor, so a first run (no watermark at all) is bounded too.
  const floor = await gmailLookbackFloor(ownerId);
  const watermark = await readGmailSince(ownerId, account);
  const since = opts.since ?? (watermark && watermark > floor ? watermark : floor);

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
      await deadLetterGmail(ownerId, account, email.id);
      logger.error('gmail message dead-lettered', { id: email.id, err: (err as Error).message });
    }
    // Watermark advances past EVERY message we've moved past, dead-lettered included.
    if (!newestProcessed || email.receivedAt > newestProcessed) newestProcessed = email.receivedAt;
  }

  // Advance-after-commit: only after the loop's possibles are committed.
  if (newestProcessed) await advanceGmailSince(ownerId, account, newestProcessed);

  // Email is REVIEW-GATED (services/review-gate.ts): unlike every other producer these
  // possibles are NOT promoted here — they stay `pending` for the owner to approve. An
  // inbox is other people's agenda, so a message that merely mentions a commitment must
  // not silently become a task. Dedupe still runs, scoped to the review pool so it can
  // neither compare against nor mark the auto-promoted producers' rows.
  const dd = await dedupePossibles({ owner: ownerId, scope: 'review' });
  result.duplicates += dd.duplicates;

  // Tell any open client that the review queue grew, so the 15-minute tick surfaces
  // live rather than waiting for a refetch.
  if (result.possiblesCreated > 0) {
    broadcast(ownerId, 'possible:suggested', { count: result.possiblesCreated });
  }

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

  // AF-3: auto-promote the batch (dedupe → promote ALL pending) before returning.
  await promoteBatch(result);

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

  // AF-3: auto-promote the batch (dedupe → promote ALL pending) before returning.
  await promoteBatch(result);

  logger.info('ingestText done', result);
  return result;
}
