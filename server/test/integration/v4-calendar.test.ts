/**
 * V4 Phase 2: CalendarBridge — sync, schedule, find_slot.
 * Uses a stub provider so we don't depend on Google Calendar MCP.
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
import { CalendarBridge, type CalendarEvent, type CalendarProvider } from '../../src/calendar.js';
import type { Application } from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'cp-cal-test-'));
const DB_PATH = join(ROOT, 'cal.db');

// Stub provider that returns canned events from the future
class StubProvider implements CalendarProvider {
  name = 'stub';
  events: CalendarEvent[];
  constructor(events: CalendarEvent[]) { this.events = events; }
  async listEvents(startMs: number, endMs: number): Promise<CalendarEvent[]> {
    return this.events.filter(e => e.start_at >= startMs && e.start_at < endMs);
  }
  async createEvent(input: { calendar_id: string; title: string; start_at: number; end_at: number }) {
    const e: CalendarEvent = {
      calendar_id: input.calendar_id,
      event_id: `stub_${Date.now()}_${Math.floor(Math.random() * 1e6)}`,
      title: input.title,
      start_at: input.start_at,
      end_at: input.end_at,
    };
    this.events.push(e);
    return e;
  }
  async deleteEvent(): Promise<void> { /* no-op */ }
}

let app: Application;
let db: ReturnType<typeof openDb>;
let calendar: CalendarBridge;
let stub: StubProvider;

// Pick a workday in the future relative to "now"
const future = new Date(Date.now() + 5 * 86400000);
const futureDate = future.toISOString().slice(0, 10); // YYYY-MM-DD

beforeAll(() => {
  writeFileSync(
    join(ROOT, 'tasks.md'),
    `# Tasks\n\n## Inbox\n\n- [ ] Send investor update\n- [ ] Book AWE hotel\n`,
  );
  db = openDb(DB_PATH);
  fullScan(db, [ROOT], new Set());

  stub = new StubProvider([
    {
      calendar_id: 'primary',
      event_id: 'standup',
      title: 'Standup',
      start_at: new Date(`${futureDate}T10:00:00`).getTime(),
      end_at: new Date(`${futureDate}T10:30:00`).getTime(),
    },
    {
      calendar_id: 'primary',
      event_id: 'lunch',
      title: 'Lunch with Andrew',
      start_at: new Date(`${futureDate}T12:00:00`).getTime(),
      end_at: new Date(`${futureDate}T13:00:00`).getTime(),
    },
  ]);
  calendar = new CalendarBridge(db, stub);

  app = express();
  app.use(express.json({ limit: '4mb' }));
  const sseClients = new Set<Response>();
  mountRoutes(app, {
    db,
    directories: [ROOT],
    excludeDirs: new Set(),
    config: { directories: [ROOT] },
    title: 'Test',
    port: 0,
    sseClients,
    notifyClients: () => undefined,
    calendar,
  });
});

afterAll(() => {
  db.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('GET /api/calendar/status', () => {
  it('reports provider name when bridge is wired', async () => {
    const res = await request(app).get('/api/calendar/status');
    expect(res.status).toBe(200);
    expect(res.body.available).toBe(true);
    expect(res.body.provider).toBe('stub');
  });
});

describe('POST /api/calendar/sync', () => {
  it('pulls events into calendar_links', async () => {
    const res = await request(app).post('/api/calendar/sync').send({ weeks: 2 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.new_events).toBeGreaterThanOrEqual(2);

    // Verify capacity reflects the synced events
    const cap = await request(app).get('/api/capacity').query({
      start_date: futureDate,
      end_date: futureDate,
    });
    expect(cap.body.days[0].committed_minutes).toBe(90); // 30 + 60
    expect(cap.body.days[0].event_count).toBe(2);
  });
});

describe('GET /api/calendar/slots', () => {
  it('finds open slots avoiding the synced events', async () => {
    const res = await request(app).get('/api/calendar/slots').query({
      duration_minutes: 60,
      start_date: futureDate,
      end_date: futureDate,
    });
    expect(res.status).toBe(200);
    expect(res.body.slots.length).toBeGreaterThan(0);
    // None of the returned slots should overlap with 10-10:30 or 12-13
    const busyStart1 = new Date(`${futureDate}T10:00:00`).getTime();
    const busyEnd1 = new Date(`${futureDate}T10:30:00`).getTime();
    const busyStart2 = new Date(`${futureDate}T12:00:00`).getTime();
    const busyEnd2 = new Date(`${futureDate}T13:00:00`).getTime();
    for (const s of res.body.slots as Array<{ start_at: number; end_at: number }>) {
      expect(s.end_at <= busyStart1 || s.start_at >= busyEnd1).toBe(true);
      expect(s.end_at <= busyStart2 || s.start_at >= busyEnd2).toBe(true);
    }
  });

  it('rejects without duration_minutes', async () => {
    const res = await request(app).get('/api/calendar/slots').query({});
    expect(res.status).toBe(400);
  });
});

describe('POST /api/calendar/schedule', () => {
  it('creates an event and stamps calendar_event_id on the todo', async () => {
    const fileRes = await request(app).get('/api/file').query({ path: join(ROOT, 'tasks.md') });
    const todo = (fileRes.body.todos as Array<{ hash: string; text: string }>)
      .find(t => t.text.includes('investor update'));
    expect(todo).toBeDefined();

    const res = await request(app).post('/api/calendar/schedule').send({
      todo_hash: todo!.hash,
      date: futureDate,
      start_time: '14:00',
      duration_minutes: 90,
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.event_id).toBeDefined();

    // history should now show 'calendar_linked'
    const hist = await request(app).get(`/api/task/${todo!.hash}/history`);
    expect((hist.body.events as Array<{ event_type: string }>).some(e => e.event_type === 'calendar_linked')).toBe(true);

    // capacity for futureDate now includes the 90m block too
    const cap = await request(app).get('/api/capacity').query({
      start_date: futureDate,
      end_date: futureDate,
    });
    expect(cap.body.days[0].committed_minutes).toBeGreaterThanOrEqual(180);
  });

  it('rejects unknown todo hash', async () => {
    const res = await request(app).post('/api/calendar/schedule').send({
      todo_hash: 'deadbeef',
      date: futureDate,
      start_time: '15:00',
      duration_minutes: 30,
    });
    expect(res.status).toBe(404);
  });
});
