/**
 * V4.1: batch calendar-event ingest (POST /api/calendar/events).
 * This is the "connect my real calendar" path — an agent with Google Calendar
 * access pushes a batch of events; the server upserts them as calendar_links.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Response } from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb } from '../../src/db.js';
import { fullScan } from '../../src/indexer.js';
import { mountRoutes } from '../../src/http.js';
import { CalendarBridge } from '../../src/calendar.js';
import type { Application } from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'cp-cal-ingest-'));
const DB_PATH = join(ROOT, 'ingest.db');

let app: Application;
let db: ReturnType<typeof openDb>;

beforeAll(() => {
  writeFileSync(join(ROOT, 'tasks.md'), `# Tasks\n\n- [ ] Something due (due: 2026-06-02)\n`);
  db = openDb(DB_PATH);
  fullScan(db, [ROOT], new Set());
  app = express();
  app.use(express.json({ limit: '4mb' }));
  mountRoutes(app, {
    db, directories: [ROOT], excludeDirs: new Set(),
    config: { directories: [ROOT] }, title: 'Test', port: 0,
    sseClients: new Set<Response>(), notifyClients: () => undefined,
    calendar: new CalendarBridge(db),
  });
});

afterAll(() => { db.close(); rmSync(ROOT, { recursive: true, force: true }); });

describe('POST /api/calendar/events', () => {
  it('ingests a batch of ISO-timestamp events into calendar_links', async () => {
    const res = await request(app).post('/api/calendar/events').send({
      events: [
        { calendar_id: 'liam@work', event_id: 'standup-1', title: 'CI Standup', start: '2026-06-02T09:00:00-07:00', end: '2026-06-02T09:30:00-07:00' },
        { calendar_id: 'liam@work', event_id: 'sync-1', title: 'Strategy Sync', start: '2026-06-02T14:00:00-07:00', end: '2026-06-02T15:30:00-07:00' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.new_events).toBe(2);

    // Capacity for 2026-06-02 should now reflect 30 + 90 = 120 minutes
    const cap = await request(app).get('/api/capacity').query({ start_date: '2026-06-02', end_date: '2026-06-02' });
    expect(cap.body.days[0].committed_minutes).toBe(120);
    expect(cap.body.days[0].event_count).toBe(2);
  });

  it('upserts (re-ingesting the same event_id updates, does not duplicate)', async () => {
    const res = await request(app).post('/api/calendar/events').send({
      events: [
        { calendar_id: 'liam@work', event_id: 'standup-1', title: 'CI Standup (moved)', start: '2026-06-02T10:00:00-07:00', end: '2026-06-02T10:30:00-07:00' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.updated_events).toBe(1);
    expect(res.body.new_events).toBe(0);
  });

  it('accepts epoch-millis timestamps too', async () => {
    const start = new Date('2026-06-05T11:00:00-07:00').getTime();
    const res = await request(app).post('/api/calendar/events').send({
      events: [{ calendar_id: 'liam@work', event_id: 'ms-1', title: 'Lunch', start, end: start + 3600000 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.new_events).toBe(1);
  });

  it('skips malformed events (missing id / bad dates)', async () => {
    const res = await request(app).post('/api/calendar/events').send({
      events: [
        { calendar_id: 'x', event_id: '', title: 'no id', start: '2026-06-02T09:00:00Z', end: '2026-06-02T10:00:00Z' },
        { calendar_id: 'x', event_id: 'bad-date', title: 'bad', start: 'not-a-date', end: 'nope' },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.new_events).toBe(0);
  });

  it('prune_missing removes vanished events in the window (but not manual blocks)', async () => {
    // Seed two events in a window, then re-ingest only one with prune_missing
    await request(app).post('/api/calendar/events').send({
      events: [
        { calendar_id: 'liam@work', event_id: 'p1', title: 'Keep', start: '2026-06-10T09:00:00-07:00', end: '2026-06-10T10:00:00-07:00' },
        { calendar_id: 'liam@work', event_id: 'p2', title: 'Drop', start: '2026-06-10T11:00:00-07:00', end: '2026-06-10T12:00:00-07:00' },
      ],
    });
    const res = await request(app).post('/api/calendar/events').send({
      events: [{ calendar_id: 'liam@work', event_id: 'p1', title: 'Keep', start: '2026-06-10T09:00:00-07:00', end: '2026-06-10T10:00:00-07:00' }],
      prune_missing: true,
      window_start: '2026-06-10T00:00:00-07:00',
      window_end: '2026-06-10T23:59:59-07:00',
    });
    expect(res.status).toBe(200);
    expect(res.body.removed_events).toBe(1);

    const cal = await request(app).get('/api/calendar').query({ start_date: '2026-06-10', end_date: '2026-06-10' });
    const titles = (cal.body.links as Array<{ event_title: string }>).map(l => l.event_title);
    expect(titles).toContain('Keep');
    expect(titles).not.toContain('Drop');
  });
});
