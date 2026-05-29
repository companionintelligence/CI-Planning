/**
 * V4 Phase 1: capacity, task_events, memory, suggestions.
 * Uses real Express + temp SQLite. No LLM calls.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Response } from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, upsertCalendarLink, insertSuggestion, logTaskEvent } from '../../src/db.js';
import { fullScan } from '../../src/indexer.js';
import { mountRoutes } from '../../src/http.js';
import type { Application } from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'cp-v4-test-'));
const DB_PATH = join(ROOT, 'v4.db');

let app: Application;
let db: ReturnType<typeof openDb>;

beforeAll(() => {
  writeFileSync(
    join(ROOT, 'tasks.md'),
    `# Today

## Inbox

- [ ] Pay Delaware report (due: 2026-05-28)
- [ ] Send investor update (due: 2026-05-29)
- [ ] Book AWE hotel (due: 2026-05-30)
`,
  );
  db = openDb(DB_PATH);
  fullScan(db, [ROOT], new Set());

  // Seed a calendar link on 2026-05-28
  upsertCalendarLink(db, {
    todo_hash: 'aaa1',
    calendar_id: 'primary',
    event_id: 'evt1',
    event_title: 'Lita Standup',
    start_at: new Date('2026-05-28T10:00:00').getTime(),
    end_at: new Date('2026-05-28T10:30:00').getTime(),
    status: 'active',
    synced_at: Date.now(),
  });
  upsertCalendarLink(db, {
    todo_hash: 'aaa2',
    calendar_id: 'primary',
    event_id: 'evt2',
    event_title: 'Strategy Sync',
    start_at: new Date('2026-05-28T14:00:00').getTime(),
    end_at: new Date('2026-05-28T17:00:00').getTime(),
    status: 'active',
    synced_at: Date.now(),
  });

  app = express();
  app.use(express.json({ limit: '4mb' }));
  const sseClients = new Set<Response>();
  mountRoutes(app, {
    db,
    directories: [ROOT],
    excludeDirs: new Set(),
    config: { directories: [ROOT] },
    title: 'V4 Test',
    port: 0,
    sseClients,
    notifyClients: () => undefined,
  });
});

afterAll(() => {
  db.close();
  rmSync(ROOT, { recursive: true, force: true });
});

describe('GET /api/capacity', () => {
  it('returns committed minutes for days with calendar events', async () => {
    const res = await request(app).get('/api/capacity').query({
      start_date: '2026-05-28',
      end_date: '2026-05-30',
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.days)).toBe(true);
    expect(res.body.days.length).toBe(3);
    const may28 = res.body.days.find((d: { date: string }) => d.date === '2026-05-28');
    expect(may28).toBeDefined();
    // 30 + 180 = 210 minutes
    expect(may28.committed_minutes).toBe(210);
    expect(may28.event_count).toBe(2);
    expect(may28.capacity_pct).toBeGreaterThan(0);
  });

  it('zero capacity day still appears in range', async () => {
    const res = await request(app).get('/api/capacity').query({
      start_date: '2026-05-28',
      end_date: '2026-05-30',
    });
    const may30 = res.body.days.find((d: { date: string }) => d.date === '2026-05-30');
    expect(may30.committed_minutes).toBe(0);
    expect(may30.event_count).toBe(0);
  });

  it('returns tasks_due counts from the index', async () => {
    const res = await request(app).get('/api/capacity').query({
      start_date: '2026-05-28',
      end_date: '2026-05-30',
    });
    const may28 = res.body.days.find((d: { date: string }) => d.date === '2026-05-28');
    expect(may28.tasks_due).toBe(1);
    expect(may28.tasks_unscheduled).toBe(1);
  });

  it('rejects missing dates', async () => {
    const res = await request(app).get('/api/capacity').query({ start_date: '2026-05-28' });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/lookahead', () => {
  it('returns a default 3 weeks of days', async () => {
    const res = await request(app).get('/api/lookahead');
    expect(res.status).toBe(200);
    expect(res.body.weeks).toBe(3);
    expect(res.body.days.length).toBeGreaterThanOrEqual(21);
  });

  it('respects weeks param', async () => {
    const res = await request(app).get('/api/lookahead').query({ weeks: 1 });
    expect(res.body.weeks).toBe(1);
    expect(res.body.days.length).toBeGreaterThanOrEqual(7);
    expect(res.body.days.length).toBeLessThanOrEqual(8);
  });

  it('over_capacity flag flips when committed > workday (via /api/capacity)', async () => {
    // Use explicit date range covering the seeded events on 2026-05-28
    const res = await request(app).get('/api/capacity').query({
      start_date: '2026-05-28',
      end_date: '2026-05-28',
      workday_minutes: 60,
    });
    expect(res.status).toBe(200);
    const overDays = res.body.days.filter((d: { over_capacity: boolean }) => d.over_capacity);
    expect(overDays.length).toBe(1);
    expect(overDays[0].committed_minutes).toBe(210);
  });
});

describe('POST /api/task/estimate', () => {
  it('sets estimated_minutes on a todo', async () => {
    // First get a hash
    const fileRes = await request(app).get('/api/file').query({ path: join(ROOT, 'tasks.md') });
    const todo = (fileRes.body.todos as Array<{ hash: string; text: string }>)
      .find(t => t.text.includes('Pay Delaware'));
    expect(todo).toBeDefined();

    const res = await request(app).post('/api/task/estimate').send({ hash: todo!.hash, minutes: 15 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, minutes: 15 });

    // History should have an 'estimated' event
    const histRes = await request(app).get(`/api/task/${todo!.hash}/history`);
    expect(histRes.status).toBe(200);
    expect((histRes.body.events as Array<{ event_type: string }>).some(e => e.event_type === 'estimated')).toBe(true);
  });

  it('rejects unknown hash', async () => {
    const res = await request(app).post('/api/task/estimate').send({ hash: 'deadbeef', minutes: 10 });
    expect(res.status).toBe(404);
  });

  it('rejects non-positive minutes', async () => {
    const fileRes = await request(app).get('/api/file').query({ path: join(ROOT, 'tasks.md') });
    const todo = (fileRes.body.todos as Array<{ hash: string }>)[0];
    const res = await request(app).post('/api/task/estimate').send({ hash: todo!.hash, minutes: 0 });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/suggestions + POST accept/dismiss', () => {
  let suggestionId: number;

  it('lists pending suggestions', async () => {
    suggestionId = insertSuggestion(db, {
      file_path: join(ROOT, 'tasks.md'),
      heading: 'Inbox',
      text: 'Follow up with Bennett on website snapshot access',
      kind: 'suggested',
      source_quote: 'Bennett asked about access yesterday',
      confidence: 0.8,
      maybe_done_for_hash: null,
      duplicate_of_hash: null,
    });
    const res = await request(app).get('/api/suggestions');
    expect(res.status).toBe(200);
    expect(res.body.items.some((s: { id: number }) => s.id === suggestionId)).toBe(true);
  });

  it('accepts a suggestion and appends to the file', async () => {
    const before = await request(app).get('/api/file').query({ path: join(ROOT, 'tasks.md') });
    const beforeCount = (before.body.todos as unknown[]).length;

    const res = await request(app).post(`/api/suggestion/${suggestionId}/accept`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const after = await request(app).get('/api/file').query({ path: join(ROOT, 'tasks.md') });
    const afterCount = (after.body.todos as unknown[]).length;
    expect(afterCount).toBe(beforeCount + 1);

    const newTodo = (after.body.todos as Array<{ text: string }>).find(t => t.text.includes('Bennett on website snapshot'));
    expect(newTodo).toBeDefined();
  });

  it('dismiss removes from pending', async () => {
    const id = insertSuggestion(db, {
      file_path: join(ROOT, 'tasks.md'),
      heading: null,
      text: 'Probably noise, ignore me',
      kind: 'suggested',
      source_quote: null,
      confidence: 0.3,
      maybe_done_for_hash: null,
      duplicate_of_hash: null,
    });
    const res = await request(app).post(`/api/suggestion/${id}/dismiss`);
    expect(res.status).toBe(200);

    const pending = await request(app).get('/api/suggestions');
    expect(pending.body.items.some((s: { id: number }) => s.id === id)).toBe(false);

    const dismissed = await request(app).get('/api/suggestions').query({ status: 'dismissed' });
    expect(dismissed.body.items.some((s: { id: number }) => s.id === id)).toBe(true);
  });
});

describe('Memory store', () => {
  it('PUT then GET roundtrip', async () => {
    const put = await request(app).put('/api/memory/workday_hours').send({ value: '9' });
    expect(put.status).toBe(200);

    const get = await request(app).get('/api/memory/workday_hours');
    expect(get.body.value).toBe('9');
  });

  it('list returns all entries', async () => {
    const list = await request(app).get('/api/memory');
    expect(Array.isArray(list.body.items)).toBe(true);
    expect(list.body.items.some((m: { key: string }) => m.key === 'workday_hours')).toBe(true);
  });
});

describe('task_events logging', () => {
  it('logs an event and returns it via history endpoint', async () => {
    logTaskEvent(db, 'testhash123', 'created', 'system', { test: true });
    const res = await request(app).get('/api/task/testhash123/history');
    expect(res.status).toBe(200);
    expect(res.body.events.length).toBe(1);
    expect(res.body.events[0].event_type).toBe('created');
    expect(res.body.events[0].actor).toBe('system');
  });
});
