/**
 * V4.1: period summaries + reconcile. No LLM dependency (Ollama down → template).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Response } from 'express';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb, upsertCalendarLink } from '../../src/db.js';
import { fullScan } from '../../src/indexer.js';
import { mountRoutes } from '../../src/http.js';
import { windowFor, collectSummaryData } from '../../src/summary.js';
import type { Application } from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'cp-summary-test-'));
const DB_PATH = join(ROOT, 'summary.db');

let app: Application;
let db: ReturnType<typeof openDb>;

beforeAll(() => {
  // Two completed in May, one overdue, one upcoming
  writeFileSync(
    join(ROOT, 'log.md'),
    `# Log

## Done
- [x] Shipped the prototype (done: 2026-05-15)
- [x] Sent investor update (done: 2026-05-20)

## Open
- [ ] File taxes (due: 2026-04-01)
- [ ] Prep AWE talk (due: 2026-06-15)
`,
  );
  db = openDb(DB_PATH);
  fullScan(db, [ROOT], new Set());

  app = express();
  app.use(express.json({ limit: '4mb' }));
  const sseClients = new Set<Response>();
  mountRoutes(app, {
    db, directories: [ROOT], excludeDirs: new Set(),
    config: { directories: [ROOT] }, title: 'Test', port: 0,
    sseClients, notifyClients: () => undefined,
  });
});

afterAll(() => { db.close(); rmSync(ROOT, { recursive: true, force: true }); });

describe('windowFor', () => {
  it('computes a monthly window', () => {
    const w = windowFor('monthly', '2026-05-20');
    expect(w.start).toBe('2026-05-01');
    expect(w.end).toBe('2026-05-31');
    expect(w.key).toBe('2026-05');
  });

  it('computes a weekly window (Mon–Sun)', () => {
    // 2026-05-20 is a Wednesday
    const w = windowFor('weekly', '2026-05-20');
    expect(w.start).toBe('2026-05-18'); // Monday
    expect(w.end).toBe('2026-05-24');   // Sunday
    expect(w.key).toMatch(/^2026-W\d\d$/);
  });

  it('computes a daily window', () => {
    const w = windowFor('daily', '2026-05-20');
    expect(w.start).toBe('2026-05-20');
    expect(w.end).toBe('2026-05-20');
  });
});

describe('collectSummaryData', () => {
  it('finds completed items in the May monthly window', () => {
    const w = windowFor('monthly', '2026-05-20');
    const data = collectSummaryData(db, w);
    expect(data.counts.completed).toBe(2);
    expect(data.completed.some(c => c.text.includes('prototype'))).toBe(true);
    // Taxes overdue (due 2026-04-01, before May window start)
    expect(data.counts.overdue).toBeGreaterThanOrEqual(1);
  });
});

describe('POST /api/summary/:period', () => {
  it('generates a monthly summary file (template when Ollama down)', async () => {
    const res = await request(app).post('/api/summary/monthly').send({ date: '2026-05-20' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.key).toBe('2026-05');
    expect(res.body.counts.completed).toBe(2);
    expect(existsSync(res.body.file)).toBe(true);
    // The summary file is under Summaries/Monthly/
    expect(res.body.file).toMatch(/Summaries\/Monthly\/2026-05\.md$/);
  });

  it('rejects an invalid period', async () => {
    const res = await request(app).post('/api/summary/yearly').send({});
    expect(res.status).toBe(400);
  });

  it('indexes the generated summary so it shows up in the file list', async () => {
    await request(app).post('/api/summary/daily').send({ date: '2026-05-20' });
    const files = await request(app).get('/api/files');
    expect((files.body.files as Array<{ path: string }>).some(f => f.path.includes('Summaries/Daily'))).toBe(true);
  });
});

describe('POST /api/reconcile', () => {
  it('closes past calendar blocks whose todo is done', async () => {
    // Link a past event to a completed todo
    const done = db.prepare(`SELECT hash FROM todos WHERE checked=1 LIMIT 1`).get() as { hash: string };
    upsertCalendarLink(db, {
      todo_hash: done.hash,
      calendar_id: 'primary',
      event_id: 'past-done',
      event_title: 'Shipped prototype block',
      start_at: new Date('2026-05-15T10:00:00').getTime(),
      end_at: new Date('2026-05-15T11:00:00').getTime(),
      status: 'active',
      synced_at: Date.now(),
    });
    const res = await request(app).post('/api/reconcile');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.events_completed).toBeGreaterThanOrEqual(1);
    expect(typeof res.body.overdue_now).toBe('number');
  });
});

describe('GET /api/summaries', () => {
  it('reports last-run keys', async () => {
    const res = await request(app).get('/api/summaries');
    expect(res.status).toBe(200);
    expect(res.body.last.monthly?.key).toBe('2026-05');
  });
});
