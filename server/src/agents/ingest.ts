import { store } from '../db/store.js';
import { extractTasks, type ExtractedTask, type ExtractSource } from './extract.js';
import { createGoogleClient, type GoogleClient } from '../mcp/google.js';
import { type ModelTier, llmAttempt } from '../mcp/ollama.js';
import { inferDirection } from './direction.js';
import { currentOwnerId } from '../lib/context.js';
import { newId } from '../lib/ids.js';
import { logger } from '../lib/logger.js';
import { promoteAllPending } from '../services/possibles.js';
import { parseEmail, resolveByEmail, selfPersonId } from '../services/people.js';
import { dedupePossibles } from './groom.js';
import { broadcast } from '../routes/sse.js';
import { dismissalHint } from '../services/dismissal-learning.js';

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
  /** Items left UNPROCESSED because Ollama was unreachable. Nothing was written for
   *  them and no watermark advanced past them, so a later run re-reads them. Distinct
   *  from `failed`, which is a verdict; this one means "not yet". */
  deferred: number;
}

/**
 * Items one ingest run will put through the model, at most.
 *
 * Extraction is a QUALITY-tier call per item with a 60s ceiling (CALL_POLICY.extract),
 * and the scheduled callers passed no limit at all — so a freshly-connected mailbox with
 * a large backlog inside the lookback window meant one run issuing an unbounded serial
 * fan-out of the most expensive call the app makes.
 *
 * 50 an ingest, against a 15-minute gmail tick, drains ~4.8k items a day, and the batch
 * is a strict oldest-first prefix so the remainder is deferred rather than dropped. A run
 * that outlasts its own period is fine: the tick lock (jobs/index.ts) refuses the
 * overlapping tick instead of stacking a second fan-out on top.
 *
 * Callers with a real budget of their own still pass `maxExtractions` and win.
 */
const MAX_EXTRACTIONS_PER_RUN = 50;

function emptyResult(): IngestResult {
  return { itemsProcessed: 0, possiblesCreated: 0, possiblesUpdated: 0, blocksCreated: 0, promoted: 0, duplicates: 0, failed: 0, deferred: 0 };
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
 * Deterministic fallback for a model that ANSWERED but not with usable JSON: stage the
 * raw item as a single possible-task so nothing is lost. No content tags (the LLM produced
 * none) — the source-inferred direction still tags it downstream (always-on, D4).
 *
 * NOT used when Ollama is unreachable on the batch paths. A stub is a permanent record,
 * and an outage is not a verdict on the item: those defer instead (see runExtraction).
 * `ingestText` is the exception — one-shot, so it has no later run to defer to.
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

  await attachDetectedPeople(owner, possibleId, sourceKind, payload);

  return outcome;
}

/**
 * People on work (0151) — attach the RESPONSIBLE set a source states as fact.
 *
 * Scope, deliberately: only 'responsible', never 'beneficiaries'. Who is on an invite
 * or a mail header is OBSERVABLE; who the work is *for* is a judgment nothing in the
 * source states. The existing motivation classifier (services/motivation.ts) keeps
 * answering that question exactly as it does today — and seeding beneficiaries from its
 * answer would be actively wrong on a single-account install, where expanding 'us' to
 * {self} would project straight back to 'me' and silently downgrade the label.
 *
 * DOES NOT CREATE PEOPLE. Ingest reads far more mail and events than the owner ever
 * promotes; creating a directory row for every address it passed would turn the
 * directory into a mailing-list dump within a week. So:
 *   - an address ALREADY in the directory → a possible_task_people row now, so the
 *     suggestion can show who it spotted before the owner approves it;
 *   - an unknown address → stashed on source_payload for promote to resolve-or-create
 *     ({@link carryPossiblePeople}), i.e. only for items the owner actually accepted.
 */
async function attachDetectedPeople(
  owner: string,
  possibleId: string,
  sourceKind: string,
  payload: unknown,
): Promise<void> {
  const p = (payload ?? {}) as { from?: unknown; organizer?: unknown; attendees?: unknown };
  const raw = [
    ...(typeof p.organizer === 'string' ? [p.organizer] : []),
    ...(typeof p.from === 'string' ? [p.from] : []),
    ...(Array.isArray(p.attendees) ? p.attendees.filter((a): a is string => typeof a === 'string') : []),
  ];
  // NO early return on an empty `raw`. That is precisely the case this has to handle:
  // an event whose attendees were ALL removed must lose them here too, and bailing out
  // before the replace below is what let stale people survive the re-ingest.
  const source = sourceKind === 'gmail' ? 'email' : 'calendar';
  const self = await selfPersonId(owner);
  const unresolved: string[] = [];
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const entry of raw) {
    const email = parseEmail(entry);
    if (!email || seen.has(email)) continue;
    seen.add(email);
    const personId = await resolveByEmail(owner, email);
    if (!personId) { unresolved.push(entry); continue; }
    // Your own attendance is implied — promotion adds you as the lead, so a row here
    // would only duplicate that.
    if (personId === self) continue;
    resolved.push(personId);
  }

  // REPLACE the detected set rather than adding to it. `upsertPossible` re-runs on every
  // ingest cycle, and an INSERT-only pass would keep an attendee who has since been
  // uninvited — the suggestion, and the task promoted from it, would name somebody the
  // event no longer does. Only machine-detected rows live in this table, so a wholesale
  // replace destroys no user testimony.
  await store()
    .prepare(`DELETE FROM possible_task_people WHERE possible_task_id = ? AND role = 'responsible'`)
    .run(possibleId);
  for (const personId of resolved) {
    await store()
      .prepare(
        `INSERT OR IGNORE INTO possible_task_people (possible_task_id, person_id, role, source, confidence)
         VALUES (?, ?, 'responsible', ?, 1.0)`,
      )
      .run(possibleId, personId, source);
  }

  // Same replace rule for the hints: written even when EMPTY, so an event that lost its
  // unknown attendees stops carrying them. Merged into source_payload rather than
  // replacing it — `from`/`subject` are already there and inferDirection reads them.
  const merged = { ...(p as Record<string, unknown>), people_hints: unresolved };
  await store()
    .prepare(`UPDATE possible_tasks SET source_payload = ? WHERE id = ?`)
    .run(JSON.stringify(merged), possibleId);
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

/**
 * What one item's extraction did.
 *
 * 'staged'   — possibles were written for this item (real extraction, or the raw
 *              fallback after the model answered badly). The item is DONE.
 * 'deferred' — Ollama was unreachable, so nothing was written and the item is
 *              untouched. It must be re-read by a later run; a caller holding a
 *              watermark must NOT advance past it.
 */
type ExtractionOutcome = 'staged' | 'deferred';

async function runExtraction(
  source: ExtractSource,
  tier: ModelTier,
  payload: unknown,
  result: IngestResult,
  opts: { stubWhenUnavailable?: boolean } = {},
): Promise<ExtractionOutcome> {
  // Close-loop wave, ticket 5 — resolve this owner's dismissal hint once per item,
  // immediately before the extraction call (never per candidate task; see
  // README.md's "Do not retrieve more than once per item"). One edit here covers all
  // three producers (gmail, gcal, text) since they all funnel through runExtraction.
  // dismissalHint() already degrades any retrieval failure to '' internally, but the
  // resolver itself is defended too — a throw here must not dead-letter the item.
  //
  // Subject FIRST, then the body. The index holds the extractor's own renderings —
  // raw_title [+ raw_summary] — so the subject line is the part of an inbound item
  // most like what is being matched against, and retrieveDismissals caps the query at
  // QUERY_TEXT_CAP, keeping whatever leads. For gmail that is the email subject, for
  // gcal the event title; a plain text note has none and falls back to its opening.
  //
  // Resolved BEFORE the attempt because extractTasks consumes it. That costs nothing
  // on the 'unavailable' path below: an owner with no rollup returns after one indexed
  // SELECT without reaching the model, and an owner WITH one still skips the embed,
  // because embedReady() is false for the same down Ollama that is about to defer this
  // item anyway.
  let hint = '';
  try {
    const probe = source.subject ? `${source.subject} ${source.text}` : source.text;
    hint = await dismissalHint(currentOwnerId(), probe);
  } catch (err) {
    logger.warn('ingest: dismissal hint resolution failed', { err: (err as Error).message });
  }

  const attempt = await llmAttempt(`extract:${source.kind}:${source.ref}`, () =>
    extractTasks(source, { tier, hint }),
  );

  // Deterministic fallback (global constraint): when the model answers with something
  // unparseable, don't drop the item — stage it raw so it still arrives, source-tagged.
  // Anything that isn't one of the two degradable failures re-throws (`llmAttempt`).
  //
  // 'unavailable' is deliberately NOT that case, and this is the bug the split fixes.
  // A raw stub is a PERMANENT record: the callers below advance a watermark past
  // everything they stage, so an Ollama outage used to convert a whole batch into
  // title-only stubs that were never looked at again — the extraction for those
  // messages was gone for good, and nothing said so. Ollama being down is not this
  // message's answer, so we write nothing and let the caller re-read it later.
  //
  // `stubWhenUnavailable` is the exception for one-shot callers (ingestText): there is
  // no later run to defer to, so for them a stub really is better than nothing.
  if (!attempt.ok && attempt.reason === 'unavailable' && !opts.stubWhenUnavailable) {
    result.deferred++;
    return 'deferred';
  }

  result.itemsProcessed++;
  const tasks: ExtractedTask[] = attempt.ok ? attempt.value : [fallbackTask(source)];
  // for-of, not forEach: forEach never awaits an async callback, so the counters below
  // would not run and a failed upsert would become an unhandled rejection.
  for (const [i, task] of tasks.entries()) {
    const outcome = await upsertPossible(task, source.kind, `${source.ref}#${i}`, payload);
    if (outcome === 'created') result.possiblesCreated++;
    else result.possiblesUpdated++;
  }
  return 'staged';
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
 *
 * Bounded and ordered: the batch is sorted oldest-first and capped at
 * MAX_EXTRACTIONS_PER_RUN, so one run can never issue an unbounded fan-out of quality-tier
 * extractions and the watermark can never pass a message the run did not read.
 *
 * Deferral vs the watermark: an Ollama outage HALTS the batch. The old code staged a raw
 * fallback for every message and advanced the cursor past all of them, so an outage
 * silently converted a whole batch into title-only stubs nothing would ever revisit. A
 * message we could not extract now keeps its place in the queue instead.
 */
export async function ingestEmails(
  client: GoogleClient = createGoogleClient(),
  opts: {
    since?: string;
    tier?: ModelTier;
    limit?: number;
    account?: string;
    /** Override {@link MAX_EXTRACTIONS_PER_RUN} for this run. */
    maxExtractions?: number;
  } = {}
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

  const fetched = await client.listEmails({ since, limit: opts.limit });

  // OLDEST FIRST, and the cap applied after the sort — both halves matter.
  //
  // Neither client promises an order: the fixture returns file order, and the live path
  // returns whatever the MCP child hands back (Gmail's own API is newest-first). The
  // watermark is a high-water mark over `receivedAt`, so processing an unordered list
  // and taking the max means a cap could bank the NEWEST messages and then advance the
  // cursor past older ones we never read — losing them permanently. Sorting first makes
  // the batch a true prefix of the backlog, so the cap only ever defers work to the next
  // run and the watermark can never outrun what was actually processed.
  const ordered = [...fetched].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  const batch = ordered.slice(0, opts.maxExtractions ?? MAX_EXTRACTIONS_PER_RUN);

  let newestProcessed: string | undefined;
  for (const [i, email] of batch.entries()) {
    let outcome: ExtractionOutcome;
    try {
      outcome = await runExtraction(
        { kind: 'gmail', ref: email.id, subject: email.subject, text: email.body, at: email.receivedAt },
        opts.tier ?? 'quality',
        // Fixture mode (no real account connected) reads canned sample mail — marked so
        // the review-gated read (routes/possibles.ts `?review=1`) can keep it out of
        // "Suggested from email": that queue must never show a suggestion that didn't
        // come from a real inbox.
        { from: email.from, subject: email.subject, ...(client.mode === 'fixture' ? { fixture: true } : {}) },
        result
      );
    } catch (err) {
      // Non-transient failure on this message → dead-letter and keep going. Do NOT rethrow
      // (that would wedge the whole batch). A dead-lettered message counts as moved past.
      await deadLetterGmail(ownerId, account, email.id);
      logger.error('gmail message dead-lettered', { id: email.id, err: (err as Error).message });
      outcome = 'staged';
    }

    // Ollama is down. STOP — don't grind the rest of the batch against an endpoint that
    // is answering nothing, where every remaining message costs a full extract timeout
    // (60s on the quality tier) to learn what we already know. The watermark stays where
    // this message begins, so this one and everything after it are re-read next run.
    if (outcome === 'deferred') {
      result.deferred += batch.length - i - 1; // + the untried remainder (this one is already counted)
      logger.warn('ingestEmails halted — Ollama unavailable; watermark held for a later run', {
        owner: ownerId, account, processed: result.itemsProcessed, deferred: result.deferred,
      });
      break;
    }

    // Watermark advances past EVERY message we've moved past, dead-lettered included —
    // but never past a deferred one, which is why the break above comes first.
    if (!newestProcessed || email.receivedAt > newestProcessed) newestProcessed = email.receivedAt;
  }

  if (ordered.length > batch.length) {
    logger.info('ingestEmails capped this run — the remainder follows on the next tick', {
      owner: ownerId, account, taken: batch.length, waiting: ordered.length - batch.length,
    });
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
 * Ingest calendar events → prep possible_tasks ONLY. An Ollama outage halts the batch
 * (reported as `deferred`) rather than throwing — the next tick re-reads the window.
 *
 * As of WP5 this no longer creates meeting blocks: the locked meeting mirror is produced
 * exclusively by sync.ts applyInbound (the single canonical inbound path), so the two
 * pipelines can never race to double-create the same block. IngestResult.blocksCreated is
 * therefore always 0; ingestEvents runs task extraction over each event's title+description.
 */
export async function ingestEvents(
  client: GoogleClient = createGoogleClient(),
  opts: {
    from?: string;
    to?: string;
    tier?: ModelTier;
    limit?: number;
    /** Override {@link MAX_EXTRACTIONS_PER_RUN} for this run. */
    maxExtractions?: number;
  } = {}
): Promise<IngestResult> {
  const result = emptyResult();
  const fetched = await client.listEvents({ from: opts.from, to: opts.to, limit: opts.limit });

  // Same bounded, ordered batch as ingestEmails. There is no watermark on this path (the
  // window is from/to), so a cap here can't lose anything — but the ordering still earns
  // its keep by making WHICH events a capped run covers deterministic instead of a
  // function of whatever order the MCP child happened to return.
  const withText = fetched
    .map((event) => ({ event, text: `${event.title}\n${event.description}`.trim() }))
    .filter((e) => e.text)
    .sort((a, b) => a.event.start.localeCompare(b.event.start));
  const batch = withText.slice(0, opts.maxExtractions ?? MAX_EXTRACTIONS_PER_RUN);

  for (const [i, { event, text }] of batch.entries()) {
    const outcome = await runExtraction(
      { kind: 'gcal', ref: event.id, subject: event.title, text, at: event.start },
      opts.tier ?? 'quality',
      // 0151: the invite's people ride along in the payload so attachDetectedPeople
      // can resolve them. Absent on a provider (or an older MCP child) that doesn't
      // send them — detection then simply finds nobody.
      {
        title: event.title,
        start: event.start,
        ...(event.organizer ? { organizer: event.organizer } : {}),
        ...(event.attendees?.length ? { attendees: event.attendees } : {}),
      },
      result
    );
    // Ollama is down — stop rather than pay a full extract timeout per remaining event
    // to relearn it. Nothing was staged for these; the next run re-reads the window.
    if (outcome === 'deferred') {
      result.deferred += batch.length - i - 1;
      logger.warn('ingestEvents halted — Ollama unavailable', {
        processed: result.itemsProcessed, deferred: result.deferred,
      });
      break;
    }
  }

  if (withText.length > batch.length) {
    logger.info('ingestEvents capped this run — the remainder follows on the next tick', {
      taken: batch.length, waiting: withText.length - batch.length,
    });
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
  // `stubWhenUnavailable` — the one caller that keeps the old behaviour. This is a
  // one-shot, user-initiated paste with no cron behind it: there is no later run to
  // defer to, so staging the raw text really is better than returning nothing. The
  // batch callers have a next tick, which is what makes deferring the better answer
  // for them.
  await runExtraction({ kind: 'text', ref, text }, opts.tier ?? 'quality', { ref }, result, {
    stubWhenUnavailable: true,
  });

  // AF-3: auto-promote the batch (dedupe → promote ALL pending) before returning.
  await promoteBatch(result);

  logger.info('ingestText done', result);
  return result;
}
