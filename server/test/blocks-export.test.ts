import { describe, it, expect, beforeEach, beforeAll, afterAll } from 'vitest';
import { sqlite } from '../src/db/index.js';
import { SYSTEM_OWNER } from '../src/lib/context.js';
import { resetDb, startTestServer, type TestServer } from './helpers.js';

/**
 * GET /api/blocks/export.ics — downloads the range's dated blocks as an iCalendar file.
 * Past-dated range so the lazy materializers (today-or-future only) stay no-ops and the
 * seeded rows are exactly what's exported.
 */

const OWNER = SYSTEM_OWNER;
const DAY = '2026-06-22';
const at = (hhmm: string) => `${DAY}T${hhmm}:00.000Z`;

function insertBlock(title: string, startISO: string, endISO: string): void {
  sqlite
    .prepare(
      `INSERT INTO time_blocks (id, title, block_kind, block_type, start_at, end_at, is_locked, is_auto, source_kind, status, owner_id)
       VALUES (uuid7(), ?, 'timeblock', 'scheduled', ?, ?, 0, 0, 'manual', 'planned', ?)`,
    )
    .run(title, startISO, endISO, OWNER);
}

let srv: TestServer;
beforeAll(async () => { srv = await startTestServer(); });
afterAll(async () => { await srv.close(); });
beforeEach(() => {
  resetDb();
  sqlite.prepare(`UPDATE scheduling_prefs SET timezone = 'UTC' WHERE owner_id = ?`).run(OWNER);
});

describe('GET /api/blocks/export.ics', () => {
  it('returns a calendar attachment with one VEVENT per in-range block; out-of-range excluded', async () => {
    insertBlock('Morning standup', at('09:00'), at('09:30'));
    insertBlock('Out of range', '2026-07-15T09:00:00.000Z', '2026-07-15T09:30:00.000Z');

    const res = await fetch(`${srv.url}/api/blocks/export.ics?from=${at('00:00')}&to=${at('23:59')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/calendar/);
    expect(res.headers.get('content-disposition')).toMatch(/attachment;.*\.ics/);

    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body).toContain('SUMMARY:Morning standup');
    expect(body).not.toContain('Out of range');
    expect((body.match(/BEGIN:VEVENT/g) ?? []).length).toBe(1);
    expect(body.includes('\r\n')).toBe(true); // CRLF line endings
  });

  it('defaults to today when from/to are omitted and still returns a valid calendar', async () => {
    const res = await fetch(`${srv.url}/api/blocks/export.ics`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('BEGIN:VCALENDAR');
    expect(body.trimEnd().endsWith('END:VCALENDAR')).toBe(true);
  });
});
