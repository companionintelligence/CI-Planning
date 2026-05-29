/**
 * V4.1: todo editor — create with full fields + edit (PATCH /api/todo).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Response } from 'express';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { openDb } from '../../src/db.js';
import { fullScan } from '../../src/indexer.js';
import { mountRoutes } from '../../src/http.js';
import type { Application } from 'express';

const ROOT = mkdtempSync(join(tmpdir(), 'cp-editor-test-'));
const DB_PATH = join(ROOT, 'editor.db');
const FILE = join(ROOT, 'tasks.md');

let app: Application;
let db: ReturnType<typeof openDb>;

beforeAll(() => {
  writeFileSync(FILE, `# Tasks\n\n## Inbox\n\n- [ ] Existing task\n`);
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

describe('POST /api/todo with full fields', () => {
  it('creates a todo with priority, tags, estimate, and due — canonical order', async () => {
    const res = await request(app).post('/api/todo').send({
      path: FILE,
      heading: 'Inbox',
      text: 'Write the spec',
      due: '2099-01-15',
      tags: ['work', 'writing'],
      priority: 1,
      estimate_minutes: 90,
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const disk = readFileSync(FILE, 'utf-8');
    // Priority first, then body, tags, estimate, due
    expect(disk).toMatch(/- \[ \] !!! Write the spec #work #writing \(est: 90m\) \(due: 2099-01-15\)/);
  });

  it('round-trips: the parsed todo exposes the structured fields', async () => {
    const fileRes = await request(app).get('/api/file').query({ path: FILE });
    const todo = (fileRes.body.todos as Array<{ plainText: string; tags: string[]; due: string; priority: number; estimateMinutes: number }>)
      .find(t => t.plainText === 'Write the spec');
    expect(todo).toBeDefined();
    expect(todo!.tags).toEqual(expect.arrayContaining(['work', 'writing']));
    expect(todo!.due).toBe('2099-01-15');
    expect(todo!.priority).toBe(1);
    expect(todo!.estimateMinutes).toBe(90);
  });
});

describe('PATCH /api/todo (edit)', () => {
  it('edits text + due, returns a new hash', async () => {
    const todos = await request(app).get('/api/todos').query({ open: 'true' });
    const todo = (todos.body.todos as Array<{ hash: string; plain_text: string }>)
      .find(t => t.plain_text === 'Existing task');
    expect(todo).toBeDefined();

    const res = await request(app).patch('/api/todo').send({
      hash: todo!.hash,
      text: 'Existing task (revised)',
      due: '2099-03-01',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.previous_hash).toBe(todo!.hash);
    expect(res.body.hash).not.toBe(todo!.hash);

    const disk = readFileSync(FILE, 'utf-8');
    expect(disk).toContain('Existing task (revised)');
    expect(disk).toContain('(due: 2099-03-01)');
  });

  it('merges omitted fields — keeps existing tags when only text changes', async () => {
    // The "Write the spec" todo has tags work/writing
    const todos = await request(app).get('/api/todos').query({ open: 'true' });
    const todo = (todos.body.todos as Array<{ hash: string; plain_text: string; tags: string[] }>)
      .find(t => t.plain_text === 'Write the spec');
    expect(todo).toBeDefined();

    const res = await request(app).patch('/api/todo').send({
      hash: todo!.hash,
      text: 'Write the v2 spec',
    });
    expect(res.status).toBe(200);

    const disk = readFileSync(FILE, 'utf-8');
    // Tags + estimate + due preserved, priority preserved
    expect(disk).toMatch(/!!! Write the v2 spec #work #writing \(est: 90m\) \(due: 2099-01-15\)/);
  });

  it('rejects unknown hash', async () => {
    const res = await request(app).patch('/api/todo').send({ hash: 'deadbeef00', text: 'x' });
    expect(res.status).toBe(404);
  });
});
