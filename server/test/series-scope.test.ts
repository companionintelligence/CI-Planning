import { describe, it, expect, beforeEach } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { randomUUID } from 'node:crypto';
import { SYSTEM_OWNER, ALL_SCOPES, runWithOwner } from '../src/lib/context.js';
import { truncateSeriesFrom } from '../src/engine/series-scope.js';
import { deleteBlock } from '../src/services/blocks.js';
import { resetDb } from './helpers.js';

/**
 * "This and all following" on a recurring series. The contract that matters is
 * ASYMMETRY: everything from the clicked occurrence forward goes, and everything before
 * it is left exactly as it was — status, tags and all. A template edit would have
 * rewritten the earlier occurrences too, which is the bug this replaces.
 */

const TZ = 'America/Los_Angeles';

function setTz() {
  // owner_id carries no unique constraint, so upsert by hand: update the seeded row if
  // there is one, else insert.
  const n = sqlite.prepare(`UPDATE scheduling_prefs SET timezone = ? WHERE owner_id = ?`).run(TZ, SYSTEM_OWNER).changes;
  if (n === 0) {
    sqlite.prepare(`INSERT INTO scheduling_prefs (id, owner_id, timezone) VALUES (?, ?, ?)`).run(randomUUID(), SYSTEM_OWNER, TZ);
  }
}

/** A weekly Friday template + its materialized instances. */
function seedSeries(days: string[]): { templateId: string; instanceIds: Record<string, string> } {
  const templateId = randomUUID();
  sqlite
    .prepare(
      `INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at, status,
                                recurrence_rule, recurrence_dtstart)
       VALUES (?, ?, 'Standup', 'timeblock', '2026-08-07T16:00:00.000Z', '2026-08-07T16:30:00.000Z', 'planned',
               'FREQ=WEEKLY;BYDAY=FR', '2026-08-07T16:00:00.000Z')`,
    )
    .run(templateId, SYSTEM_OWNER);

  const instanceIds: Record<string, string> = {};
  for (const d of days) {
    const id = randomUUID();
    instanceIds[d] = id;
    sqlite
      .prepare(
        `INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at, status,
                                  recurrence_parent_id, occurrence_date)
         VALUES (?, ?, 'Standup', 'timeblock', ?, ?, 'planned', ?, ?)`,
      )
      .run(id, SYSTEM_OWNER, `${d}T16:00:00.000Z`, `${d}T16:30:00.000Z`, templateId, d);
  }
  return { templateId, instanceIds };
}

const exists = (id: string) => !!sqlite.prepare(`SELECT 1 FROM time_blocks WHERE id = ?`).get(id);
const ruleOf = (id: string) =>
  (sqlite.prepare(`SELECT recurrence_rule FROM time_blocks WHERE id = ?`).get(id) as { recurrence_rule: string } | undefined)?.recurrence_rule;
const run = <T>(fn: () => Promise<T>): Promise<T> => runWithOwner(SYSTEM_OWNER, ALL_SCOPES, fn);

beforeEach(() => { resetDb(); setTz(); });

describe('truncateSeriesFrom', () => {
  const DAYS = ['2026-08-07', '2026-08-14', '2026-08-21', '2026-08-28'];

  it('removes the split occurrence and everything after, and NOTHING before', () => {
    const { templateId, instanceIds } = seedSeries(DAYS);

    const r = truncateSeriesFrom(SYSTEM_OWNER, 'time_blocks', templateId, '2026-08-21');

    expect(r.ok).toBe(true);
    expect(r.removed).toBe(2); // 21st + 28th
    expect(exists(instanceIds['2026-08-07'])).toBe(true);
    expect(exists(instanceIds['2026-08-14'])).toBe(true);
    expect(exists(instanceIds['2026-08-21'])).toBe(false);
    expect(exists(instanceIds['2026-08-28'])).toBe(false);
  });

  it('bounds the template rule so a regenerate cannot resurrect the removed days', () => {
    const { templateId } = seedSeries(DAYS);
    truncateSeriesFrom(SYSTEM_OWNER, 'time_blocks', templateId, '2026-08-21');
    expect(ruleOf(templateId)).toMatch(/UNTIL=/i);
    expect(exists(templateId)).toBe(true); // earlier occurrences still need their template
  });

  it('removes the template entirely when the split is the FIRST occurrence', () => {
    // Nothing survives before the split, so a template that can never materialize would
    // just be an invisible orphan.
    const { templateId, instanceIds } = seedSeries(DAYS);
    const r = truncateSeriesFrom(SYSTEM_OWNER, 'time_blocks', templateId, '2026-08-07');
    expect(r.templateRemoved).toBe(true);
    expect(exists(templateId)).toBe(false);
    expect(exists(instanceIds['2026-08-07'])).toBe(false);
  });

  it('fails closed on a rule it cannot bound, rather than reporting a no-op as success', () => {
    const { templateId } = seedSeries(DAYS);
    const r = truncateSeriesFrom(SYSTEM_OWNER, 'time_blocks', templateId, 'garbage');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('bad_rule');
    expect(ruleOf(templateId)).toBe('FREQ=WEEKLY;BYDAY=FR'); // untouched
  });

  it('refuses a non-recurring row', () => {
    const id = randomUUID();
    sqlite
      .prepare(`INSERT INTO time_blocks (id, owner_id, title, block_kind, start_at, end_at, status)
                VALUES (?, ?, 'One-off', 'timeblock', '2026-08-07T16:00:00.000Z', '2026-08-07T16:30:00.000Z', 'planned')`)
      .run(id, SYSTEM_OWNER);
    expect(truncateSeriesFrom(SYSTEM_OWNER, 'time_blocks', id, '2026-08-07').reason).toBe('not_recurring');
  });
});

describe('deleteBlock scope', () => {
  const DAYS = ['2026-08-07', '2026-08-14', '2026-08-21', '2026-08-28'];

  it("default scope removes ONLY the clicked occurrence — the series continues", async () => {
    const { templateId, instanceIds } = seedSeries(DAYS);
    await run(() => deleteBlock(SYSTEM_OWNER, instanceIds['2026-08-14']));

    expect(exists(instanceIds['2026-08-14'])).toBe(false);
    expect(exists(instanceIds['2026-08-21'])).toBe(true); // later ones survive
    expect(ruleOf(templateId)).toBe('FREQ=WEEKLY;BYDAY=FR'); // rule untouched
  });

  it("scope 'following' removes it and every later occurrence", async () => {
    const { templateId, instanceIds } = seedSeries(DAYS);
    await run(() => deleteBlock(SYSTEM_OWNER, instanceIds['2026-08-14'], { scope: 'following' }));

    expect(exists(instanceIds['2026-08-07'])).toBe(true); // earlier untouched
    expect(exists(instanceIds['2026-08-14'])).toBe(false);
    expect(exists(instanceIds['2026-08-21'])).toBe(false);
    expect(exists(instanceIds['2026-08-28'])).toBe(false);
    expect(ruleOf(templateId)).toMatch(/UNTIL=/i);
  });
});
