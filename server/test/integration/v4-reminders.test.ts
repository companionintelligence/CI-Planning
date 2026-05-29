/**
 * V4.1: /api/reminders — feeds the client notification scheduler.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Response } from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, upsertCalendarLink } from '../../src/db.js';
import { fullScan } from '../../src/indexer.js';
import { mountRoutes } from '../../src/http.js';
import { CalendarBridge } from '../../src/calendar.js';
import type { Application } from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'cp-rem-'));
const DB_PATH = join(ROOT, 'rem.db');

let app: Application;
let db: ReturnType<typeof openDb>;

beforeAll(() => {
  const today = new Date().toLocaleDateString('en-CA');
  const yesterday = new Date(Date.now() - 86400000).toLocaleDateString('en-CA');
  writeFileSync(
    join(ROOT, 'tasks.md'),
    `# Tasks\n\n- [ ] Due today thing (due: ${today})\n- [ ] Overdue thing (due: ${yesterday})\n- [ ] Someday thing\n`,
  );
  db = openDb(DB_PATH);
  fullScan(db, [ROOT], new Set());

  // Event starting in ~20 minutes
  const soon = Date.now() + 20 * 60_000;
  upsertCalendarLink(db, {
    todo_hash: '', calendar_id: 'primary', event_id: 'soon-1', event_title: 'Standup',
    start_at: soon, end_at: soon + 30 * 60_000, status: 'active', synced_at: Date.now(),
  });
  // Event 5 hours out (outside a 60-min lead)
  const later = Date.now() + 5 * 3600_000;
  upsertCalendarLink(db, {
    todo_hash: '', calendar_id: 'primary', event_id: 'later-1', event_title: 'Dinner',
    start_at: later, end_at: later + 3600_000, status: 'active', synced_at: Date.now(),
  });

  app = express();
  app.use(express.json());
  mountRoutes(app, {
    db, directories: [ROOT], excludeDirs: new Set(),
    config: { directories: [ROOT] }, title: 'Test', port: 0,
    sseClients: new Set<Response>(), notifyClients: () => undefined,
    calendar: new CalendarBridge(db),
  });
});

afterAll(() => { db.close(); rmSync(ROOT, { recursive: true, force: true }); });

describe('GET /api/reminders', () => {
  it('returns due-today and overdue todos', async () => {
    const res = await request(app).get('/api/reminders').query({ lead_minutes: 60 });
    expect(res.status).toBe(200);
    expect(res.body.due_today.length).toBe(1);
    expect(res.body.due_today[0].text).toContain('Due today');
    expect(res.body.overdue_total).toBe(1);
  });

  it('includes events within the lead window, excludes those beyond it', async () => {
    const res = await request(app).get('/api/reminders').query({ lead_minutes: 60 });
    const titles = (res.body.events_soon as Array<{ title: string; minutes_until: number }>).map(e => e.title);
    expect(titles).toContain('Standup');     // ~20 min out
    expect(titles).not.toContain('Dinner');  // 5 h out
    const standup = (res.body.events_soon as Array<{ title: string; minutes_until: number }>).find(e => e.title === 'Standup');
    expect(standup!.minutes_until).toBeGreaterThanOrEqual(18);
    expect(standup!.minutes_until).toBeLessThanOrEqual(21);
  });

  it('a short lead window excludes the 20-min event', async () => {
    const res = await request(app).get('/api/reminders').query({ lead_minutes: 10 });
    const titles = (res.body.events_soon as Array<{ title: string }>).map(e => e.title);
    expect(titles).not.toContain('Standup');
  });
});
