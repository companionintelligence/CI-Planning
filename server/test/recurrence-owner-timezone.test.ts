import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER, runWithOwner, ALL_SCOPES } from '../src/lib/context.js';
import { generateRecurrences } from '../src/engine/recurrence-generate.js';
import { todayInTZ } from '../src/lib/tz.js';
import { resetDb } from './helpers.js';

/**
 * Day boundaries mean the OWNER's day, never the server's.
 *
 * `generateRecurrences` fetched the owner's timezone and used it for every day WINDOW
 * (utcDayBounds, instanceStartUTC) — but anchored `today` on `localISODate()`, the
 * SERVER's calendar date. With a UTC server and a Los_Angeles owner (the documented
 * Docker shape: `TZ` unset in the container, owner tz set in Settings), any moment after
 * 17:00 local is already "tomorrow" in UTC. markMissed() sweeps
 * `occurrence_date < today`, so the owner's still-open evening habit for the CURRENT day
 * was flipped to `missed` before their day had ended.
 *
 * That is not a cosmetic mislabel. `review_day` explicitly refuses to sweep missed
 * instances back, `computeStreak` breaks on the gap, and `freeze_stars` makes the day
 * immutable on a first-freeze-wins basis — so the false record is permanent.
 *
 * These tests pin the boundary by faking the clock rather than the timezone: the process
 * runs in whatever zone the suite runs in, so asserting on a real wall clock would be
 * flaky. Freezing the instant makes "UTC has rolled over, Los_Angeles has not" exact.
 */

const OWNER = SYSTEM_OWNER;

/** A moment that is 2026-03-11 in UTC but still 2026-03-10 in America/Los_Angeles. */
const AFTER_UTC_MIDNIGHT = new Date('2026-03-11T02:30:00Z');

function setOwnerTz(tz: string) {
  sqlite.prepare('UPDATE scheduling_prefs SET timezone = ? WHERE owner_id = ?').run(tz, OWNER);
}

/** A daily habit template plus one open instance on `day`. */
function seedHabitOn(day: string): string {
  const templateId = (
    sqlite
      .prepare(
        `INSERT INTO tasks (id, title, owner_id, subtype, status, recurrence_rule, recurrence_dtstart)
         VALUES (uuid7(), 'Evening medication', ?, 'habit', 'recurring', 'FREQ=DAILY', ?)
         RETURNING id`,
      )
      .get(OWNER, `${day}T00:00:00.000Z`) as { id: string }
  ).id;
  sqlite
    .prepare(
      `INSERT INTO tasks (id, title, owner_id, subtype, status, recurrence_parent_id, occurrence_date)
       VALUES (uuid7(), 'Evening medication', ?, 'habit', 'open', ?, ?)`,
    )
    .run(OWNER, templateId, day);
  return templateId;
}

/** Add `n` calendar days to a YYYY-MM-DD (UTC date-only math). */
function addDaysISO(day: string, n: number): string {
  const d = new Date(day + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function statusOfInstanceOn(day: string): string | undefined {
  const row = sqlite
    .prepare(`SELECT status FROM tasks WHERE occurrence_date = ? AND recurrence_parent_id IS NOT NULL`)
    .get(day) as { status: string } | undefined;
  return row?.status;
}

beforeEach(() => {
  resetDb();
  vi.useFakeTimers();
  vi.setSystemTime(AFTER_UTC_MIDNIGHT);
});

afterEach(() => {
  vi.useRealTimers();
  resetDb();
});

describe('todayInTZ', () => {
  it('resolves the owner-local date, not the UTC one, across the boundary', () => {
    expect(todayInTZ('UTC')).toBe('2026-03-11');
    expect(todayInTZ('America/Los_Angeles')).toBe('2026-03-10');
    // Ahead of UTC as well — the fix must not merely subtract.
    expect(todayInTZ('Pacific/Kiritimati')).toBe('2026-03-11');
  });
});

/**
 * Parameterised over zones on BOTH sides of the frozen instant, deliberately.
 *
 * The runner's own timezone is not pinned (vitest.config.ts sets no TZ) — it is
 * America/Los_Angeles on this machine and UTC in CI. A single-zone test would therefore
 * only expose the bug in one of those environments: pre-fix, an LA owner on an LA runner
 * agrees with the server by coincidence and the test passes. At the frozen instant below,
 * Kiritimati and UTC resolve to 2026-03-11 while Los_Angeles and Midway resolve to
 * 2026-03-10, so whichever zone the runner is in, at least one case disagrees with it and
 * the server-anchored bug is caught.
 */
const OWNER_ZONES = [
  { tz: 'Pacific/Kiritimati', day: '2026-03-11' }, // UTC+14
  { tz: 'UTC', day: '2026-03-11' },
  { tz: 'America/Los_Angeles', day: '2026-03-10' }, // UTC-8
  { tz: 'Pacific/Midway', day: '2026-03-10' }, // UTC-11
];

describe('generateRecurrences — the missed sweep follows the OWNER clock', () => {
  for (const { tz, day } of OWNER_ZONES) {
    it(`${tz}: leaves the owner's current day (${day}) open`, async () => {
      setOwnerTz(tz);
      seedHabitOn(day);

      await runWithOwner(OWNER, ALL_SCOPES, async () => await generateRecurrences());

      // Anchoring on the server's date flips this to 'missed' before the owner's day ends.
      expect(statusOfInstanceOn(day)).toBe('open');
    });

    it(`${tz}: still marks the owner's previous day missed`, async () => {
      setOwnerTz(tz);
      const yesterday = addDaysISO(day, -1);
      seedHabitOn(yesterday);

      await runWithOwner(OWNER, ALL_SCOPES, async () => await generateRecurrences());

      // The guard the fix must not break: genuinely past really is past.
      expect(statusOfInstanceOn(yesterday)).toBe('missed');
    });
  }

  it('honours an explicit opts.today over the owner clock', async () => {
    // The cron passes no date, but callers and tests do; that path stays authoritative.
    setOwnerTz('America/Los_Angeles');
    seedHabitOn('2026-03-10');

    await runWithOwner(OWNER, ALL_SCOPES, async () => await generateRecurrences({ today: '2026-03-20' }));

    expect(statusOfInstanceOn('2026-03-10')).toBe('missed');
  });
});
