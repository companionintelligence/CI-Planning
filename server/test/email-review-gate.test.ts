import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { newId } from '../src/lib/ids.js';
import { SYSTEM_OWNER, ALL_SCOPES, runWithOwner } from '../src/lib/context.js';
import { requiresReview, REVIEW_SOURCE_KINDS } from '../src/services/review-gate.js';
import { promoteAllPending } from '../src/services/possibles.js';
import { promotePossibles, dedupePossibles } from '../src/agents/groom.js';
import { runJob } from '../src/jobs/index.js';
import { resetDb } from './helpers.js';

/**
 * Email suggestions are review-gated: they must reach the owner as SUGGESTIONS and never
 * become tasks on their own. The load-bearing case is the nightly sweeper — leaving rows
 * `pending` at the producer is not enough, because promotePossibles() sweeps everything
 * unconditionally, so a naive implementation works for a day and then quietly promotes
 * the whole queue at 02:00.
 */

function seedPossible(title: string, sourceKind: string | null, ref = title): string {
  const row = sqlite
    .prepare(
      `INSERT INTO possible_tasks (id, raw_title, source_kind, source_ref, confidence, status, proposed_owner_id)
       VALUES (uuid7(), ?, ?, ?, 0.9, 'pending', ?) RETURNING id`,
    )
    .get(title, sourceKind, ref, SYSTEM_OWNER) as { id: string };
  return row.id;
}

const statusOf = (id: string) =>
  (sqlite.prepare(`SELECT status FROM possible_tasks WHERE id = ?`).get(id) as { status: string }).status;
const taskCount = () => (sqlite.prepare(`SELECT COUNT(*) AS n FROM tasks`).get() as { n: number }).n;
const run = <T>(fn: () => Promise<T>): Promise<T> => runWithOwner(SYSTEM_OWNER, ALL_SCOPES, fn);

beforeEach(() => resetDb());

describe('requiresReview', () => {
  it('gates email only', () => {
    expect(requiresReview('gmail')).toBe(true);
    expect(requiresReview('gcal')).toBe(false);
    expect(requiresReview('text')).toBe(false);
    expect(requiresReview('memory')).toBe(false);
    expect(requiresReview('agent')).toBe(false);
  });

  it('treats a missing source as NOT gated — legacy rows must keep sweeping', () => {
    // possible_tasks.source_kind is nullable and the claimLegacy sweep depends on those
    // rows still being promoted. A bare SQL `NOT IN` would drop them (NULL NOT IN → NULL).
    expect(requiresReview(null)).toBe(false);
    expect(requiresReview(undefined)).toBe(false);
  });

  it('gmail is the gated set', () => {
    expect([...REVIEW_SOURCE_KINDS]).toEqual(['gmail']);
  });
});

describe('auto-promote paths skip email', () => {
  it('promoteAllPending promotes other sources but leaves email pending', async () => {
    const mail = seedPossible('Reply to the vendor', 'gmail');
    const cal = seedPossible('Prep the review', 'gcal');
    const legacy = seedPossible('Legacy item', null);

    await run(() => promoteAllPending(SYSTEM_OWNER));

    expect(statusOf(mail)).toBe('pending');
    expect(statusOf(cal)).toBe('promoted');
    expect(statusOf(legacy)).toBe('promoted');
  });

  it('THE SWEEPER leaves email pending — promotePossibles is the 02:00 trap', async () => {
    const mail = seedPossible('Reply to the vendor', 'gmail');
    const cal = seedPossible('Prep the review', 'gcal');
    const legacy = seedPossible('Legacy item', null);

    await run(() => promotePossibles(SYSTEM_OWNER, { claimLegacy: true }));

    expect(statusOf(mail)).toBe('pending');
    expect(statusOf(cal)).toBe('promoted');
    // NULL-source legacy rows must STILL be claimed and promoted.
    expect(statusOf(legacy)).toBe('promoted');
  });

  it('nightly_grooming does not promote email either', async () => {
    const mail = seedPossible('Reply to the vendor', 'gmail');
    const cal = seedPossible('Prep the review', 'gcal');

    await run(() => runJob('nightly_grooming'));

    expect(statusOf(mail)).toBe('pending');
    expect(statusOf(cal)).toBe('promoted');
  });

  it('an all-email batch creates no tasks at all', async () => {
    seedPossible('One', 'gmail');
    seedPossible('Two', 'gmail');
    await run(() => promoteAllPending(SYSTEM_OWNER));
    expect(taskCount()).toBe(0);
  });
});

describe('dedupe partition', () => {
  // Deterministic embeddings: identical titles → identical vectors → similarity 1.
  const embedFn = async (text: string) => {
    let h = 0;
    for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
    return [((h % 1000) / 1000) + 1, 1, 1];
  };

  it("a lingering email row never marks a NEWER auto-pool row duplicate", async () => {
    // The regression an unpartitioned pass would cause: rows sort id ASC (uuid7 is
    // time-ordered), so the later gcal row would be the one dropped.
    const mail = seedPossible('Quarterly report', 'gmail', 'mail-ref');
    const cal = seedPossible('Quarterly report', 'gcal', 'cal-ref');

    await run(() => dedupePossibles({ owner: SYSTEM_OWNER, embedFn, scope: 'auto' }));

    expect(statusOf(cal)).toBe('pending');
    expect(statusOf(mail)).toBe('pending');
  });

  it("the review scope still dedupes email against email", async () => {
    const first = seedPossible('Quarterly report', 'gmail', 'a');
    const second = seedPossible('Quarterly report', 'gmail', 'b');

    const r = await run(() => dedupePossibles({ owner: SYSTEM_OWNER, embedFn, scope: 'review' }));

    // Exactly one of the identical pair survives. WHICH one is an implementation detail
    // of the vec0-vs-cosine path, so assert the property rather than the winner.
    expect(r.duplicates).toBe(1);
    const statuses = [statusOf(first), statusOf(second)].sort();
    expect(statuses).toEqual(['duplicate', 'pending']);
  });
});

describe('ingest_gmail cadence', () => {
  it('runs every 15 minutes', () => {
    const row = sqlite.prepare(`SELECT cron FROM scheduled_jobs WHERE kind = 'ingest_gmail'`).get() as { cron: string };
    expect(row.cron).toBe('*/15 * * * *');
  });

  it('leaves the sibling calendar ingest alone — the migration guard is kind-scoped', () => {
    const row = sqlite.prepare(`SELECT cron FROM scheduled_jobs WHERE kind = 'ingest_gcal'`).get() as { cron: string };
    expect(row.cron).toBe('*/30 * * * *');
  });
});
