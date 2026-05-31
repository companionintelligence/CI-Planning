import { sqlite } from '../db/index.js';
import { extractTasks, type ExtractedTask, type ExtractSource } from './extract.js';
import { createGoogleClient, type GoogleClient, type CalendarEvent } from '../mcp/google.js';
import { type ModelTier } from '../mcp/ollama.js';
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

function tagId(name: string): number {
  const existing = sqlite.prepare('SELECT id FROM tags WHERE name = ?').get(name) as { id: number } | undefined;
  if (existing) return existing.id;
  return (sqlite.prepare('INSERT INTO tags (name) VALUES (?) RETURNING id').get(name) as { id: number }).id;
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
    .get(sourceKind, sourceRef) as { id: number } | undefined;

  let possibleId: number;
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
         (raw_title, raw_summary, proposed_due_at, proposed_priority, proposed_owner_id,
          source_kind, source_ref, source_payload, confidence, status)
         VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, 'pending') RETURNING id`
      )
      .get(
        task.title,
        task.summary ?? null,
        task.dueAt ?? null,
        task.priority,
        sourceKind,
        sourceRef,
        JSON.stringify(payload),
        task.confidence
      ) as { id: number };
    possibleId = row.id;
    outcome = 'created';
  }

  // Attach suggested tags (idempotent).
  for (const raw of task.tags) {
    const id = tagId(normTag(raw));
    sqlite
      .prepare('INSERT OR IGNORE INTO possible_task_tags (possible_task_id, tag_id) VALUES (?, ?)')
      .run(possibleId, id);
  }

  return outcome;
}

/** Create a read-only meeting block mirroring a calendar event (idempotent on source_ref). */
function upsertMeetingBlock(event: CalendarEvent): boolean {
  const existing = sqlite
    .prepare("SELECT id FROM time_blocks WHERE source_kind = 'gcal' AND source_ref = ?")
    .get(event.id) as { id: number } | undefined;
  if (existing) return false;
  sqlite
    .prepare(
      `INSERT INTO time_blocks (task_id, title, block_kind, start_at, end_at, is_locked, is_auto, source_kind, source_ref, status)
       VALUES (NULL, ?, 'meeting', ?, ?, 1, 0, 'gcal', ?, 'planned')`
    )
    .run(event.title, event.start, event.end, event.id);
  return true;
}

async function runExtraction(
  source: ExtractSource,
  tier: ModelTier,
  payload: unknown,
  result: IngestResult
): Promise<void> {
  const tasks = await extractTasks(source, { tier });
  result.itemsProcessed++;
  tasks.forEach((task, i) => {
    const outcome = upsertPossible(task, source.kind, `${source.ref}#${i}`, payload);
    if (outcome === 'created') result.possiblesCreated++;
    else result.possiblesUpdated++;
  });
}

/** Ingest emails → possible_tasks. Throws if Ollama is unavailable. */
export async function ingestEmails(
  client: GoogleClient = createGoogleClient(),
  opts: { since?: string; tier?: ModelTier; limit?: number } = {}
): Promise<IngestResult> {
  const result = emptyResult();
  const emails = await client.listEmails({ since: opts.since, limit: opts.limit });
  for (const email of emails) {
    await runExtraction(
      { kind: 'gmail', ref: email.id, subject: email.subject, text: email.body, at: email.receivedAt },
      opts.tier ?? 'medium',
      { from: email.from, subject: email.subject },
      result
    );
  }
  logger.info('ingestEmails done', result);
  return result;
}

/** Ingest calendar events → meeting blocks + prep possible_tasks. Throws if Ollama unavailable. */
export async function ingestEvents(
  client: GoogleClient = createGoogleClient(),
  opts: { from?: string; to?: string; tier?: ModelTier; limit?: number } = {}
): Promise<IngestResult> {
  const result = emptyResult();
  const events = await client.listEvents({ from: opts.from, to: opts.to, limit: opts.limit });
  for (const event of events) {
    if (upsertMeetingBlock(event)) result.blocksCreated++;
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
