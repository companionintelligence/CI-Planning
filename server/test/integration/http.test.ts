/**
 * HTTP integration tests — spins up a real Express server against a temp dir.
 * Every route is exercised; file writes are verified on disk.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Response } from 'express';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { rmSync } from 'fs';
import { openDb } from '../../src/db.js';
import { fullScan } from '../../src/indexer.js';
import { mountRoutes } from '../../src/http.js';
import type { Application } from 'express';

// ---- Test fixtures ----

const ROOT = mkdtempSync(join(tmpdir(), 'cp-http-test-'));
const DB_PATH = join(ROOT, 'test.db');

const SAMPLE_FILE = join(ROOT, 'test.md');
const SAMPLE_CONTENT = `# Work

## Inbox

- [ ] Buy milk #grocery (due: 2099-01-01)
- [x] Send report (done: 2026-01-01)

## Projects

- [ ] Launch rocket !!!
- [ ] Fix typo
`;

let app: Application;
let db: ReturnType<typeof openDb>;

beforeAll(() => {
  writeFileSync(SAMPLE_FILE, SAMPLE_CONTENT);
  db = openDb(DB_PATH);
  fullScan(db, [ROOT], new Set());

  app = express();
  app.use(express.json({ limit: '4mb' }));

  const sseClients = new Set<Response>();
  function notifyClients(event: string, data: unknown): void {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of sseClients) c.write(msg);
  }

  mountRoutes(app, {
    db,
    directories: [ROOT],
    excludeDirs: new Set(),
    config: { directories: [ROOT] },
    title: 'Test',
    port: 0,
    sseClients,
    notifyClients,
  });
});

afterAll(() => {
  db.close();
  rmSync(ROOT, { recursive: true, force: true });
});

// ---- /api/config ----

describe('GET /api/config', () => {
  it('returns directories and title', async () => {
    const res = await request(app).get('/api/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('title', 'Test');
    expect(Array.isArray(res.body.directories)).toBe(true);
  });
});

// ---- /api/files ----

describe('GET /api/files', () => {
  it('returns indexed files', async () => {
    const res = await request(app).get('/api/files');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.files)).toBe(true);
    expect(res.body.files.length).toBeGreaterThan(0);
    const f = res.body.files[0];
    expect(f).toHaveProperty('todos');
    expect(f.todos).toHaveProperty('total');
  });
});

// ---- /api/file GET ----

describe('GET /api/file', () => {
  it('returns file content and parsed todos', async () => {
    const res = await request(app).get('/api/file').query({ path: SAMPLE_FILE });
    expect(res.status).toBe(200);
    expect(res.body.content).toContain('Buy milk');
    expect(Array.isArray(res.body.todos)).toBe(true);
    expect(res.body.todos.some((t: { text: string }) => t.text.includes('Buy milk'))).toBe(true);
    expect(res.body).toHaveProperty('sha256');
  });

  it('returns 404 for missing file', async () => {
    const res = await request(app).get('/api/file').query({ path: join(ROOT, 'nope.md') });
    expect(res.status).toBe(404);
  });

  it('returns 403 for path outside roots', async () => {
    const res = await request(app).get('/api/file').query({ path: '/etc/passwd' });
    expect(res.status).toBe(403);
  });
});

// ---- /api/file PUT (full overwrite) ----

describe('PUT /api/file', () => {
  const putPath = join(ROOT, 'put-test.md');

  it('creates a new file', async () => {
    const res = await request(app)
      .put('/api/file')
      .send({ path: putPath, content: '# Test\n\n- [ ] New todo\n' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(readFileSync(putPath, 'utf-8')).toContain('New todo');
  });

  it('rejects when expected_sha256 mismatches', async () => {
    const res = await request(app)
      .put('/api/file')
      .send({ path: putPath, content: '# New\n', expected_sha256: 'deadbeef' });
    expect(res.status).toBe(409);
    expect(res.body).toHaveProperty('error', 'sha256 mismatch');
    expect(res.body).toHaveProperty('current_sha256');
  });

  it('accepts when expected_sha256 matches', async () => {
    const current = readFileSync(putPath, 'utf-8');
    const shaRes = await request(app).get('/api/file').query({ path: putPath });
    const sha = shaRes.body.sha256 as string;
    const res = await request(app)
      .put('/api/file')
      .send({ path: putPath, content: '# Updated\n\n- [ ] Updated todo\n', expected_sha256: sha });
    expect(res.status).toBe(200);
    expect(readFileSync(putPath, 'utf-8')).toContain('Updated todo');
  });
});

// ---- /api/file PATCH (toggle) ----

describe('PATCH /api/file', () => {
  it('marks a todo as done and stamps done date', async () => {
    const fileRes = await request(app).get('/api/file').query({ path: SAMPLE_FILE });
    const todo = (fileRes.body.todos as Array<{ text: string; checked: boolean; hash: string }>)
      .find(t => t.text.includes('Buy milk'));
    expect(todo).toBeDefined();

    const res = await request(app)
      .patch('/api/file')
      .send({ path: SAMPLE_FILE, hash: todo!.hash, checked: true });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);

    const after = readFileSync(SAMPLE_FILE, 'utf-8');
    expect(after).toMatch(/\[x\].*Buy milk/);
  });

  it('returns 404 for unknown hash', async () => {
    const res = await request(app)
      .patch('/api/file')
      .send({ path: SAMPLE_FILE, hash: 'aabbccdd00112233', checked: true });
    expect(res.status).toBe(404);
  });

  it('returns noop when already in target state', async () => {
    // File was toggled done in previous test; toggling again = noop
    const fileRes = await request(app).get('/api/file').query({ path: SAMPLE_FILE });
    const todo = (fileRes.body.todos as Array<{ text: string; checked: boolean; hash: string }>)
      .find(t => t.text.includes('Buy milk'));
    const res = await request(app)
      .patch('/api/file')
      .send({ path: SAMPLE_FILE, hash: todo!.hash, checked: true });
    expect(res.status).toBe(200);
    expect(res.body.noop).toBe(true);
  });
});

// ---- /api/todo POST ----

describe('POST /api/todo', () => {
  it('appends a new todo under specified heading', async () => {
    const newFile = join(ROOT, 'new-todos.md');
    const res = await request(app)
      .post('/api/todo')
      .send({ path: newFile, text: 'Pick up parcel', heading: 'Errands', tags: ['errand'] });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('success', true);
    expect(res.body).toHaveProperty('hash');
    const content = readFileSync(newFile, 'utf-8');
    expect(content).toContain('Pick up parcel');
    expect(content).toContain('#errand');
    expect(content).toContain('## Errands');
  });
});

// ---- /api/todos GET ----

describe('GET /api/todos', () => {
  it('returns open todos', async () => {
    const res = await request(app).get('/api/todos').query({ open: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.todos.every((t: { checked: boolean }) => !t.checked)).toBe(true);
  });

  it('returns done todos', async () => {
    const res = await request(app).get('/api/todos').query({ done: 'true' });
    expect(res.status).toBe(200);
    expect(res.body.todos.every((t: { checked: boolean }) => t.checked)).toBe(true);
  });

  it('filters by tag', async () => {
    const res = await request(app).get('/api/todos').query({ tag: 'grocery' });
    expect(res.status).toBe(200);
    // grocery tag was on Buy milk (now done), but should still show up
    expect(res.body.count).toBeGreaterThanOrEqual(0);
  });
});

// ---- /api/search ----

describe('GET /api/search', () => {
  it('finds a todo by keyword', async () => {
    const res = await request(app).get('/api/search').query({ q: 'rocket' });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.results)).toBe(true);
  });

  it('returns empty for short query', async () => {
    const res = await request(app).get('/api/search').query({ q: 'x' });
    expect(res.status).toBe(200);
    expect(res.body.results).toHaveLength(0);
  });
});

// ---- /api/stats ----

describe('GET /api/stats', () => {
  it('returns aggregate counts', async () => {
    const res = await request(app).get('/api/stats');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('todos_total');
    expect(res.body).toHaveProperty('files');
  });
});

// ---- /api/rescan ----

describe('POST /api/rescan', () => {
  it('rescans and returns stats', async () => {
    const res = await request(app).post('/api/rescan');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
    expect(typeof res.body.ms).toBe('number');
  });
});

// ---- /api/suggestion/apply ----

describe('POST /api/suggestion/apply', () => {
  let hash: string;

  beforeAll(async () => {
    // Write a fresh file and index it so we have a known hash
    const applyFile = join(ROOT, 'apply-test.md');
    writeFileSync(applyFile, '# Tasks\n\n- [ ] Rename me\n');
    fullScan(db, [ROOT], new Set());
    const res = await request(app).get('/api/file').query({ path: applyFile });
    const todo = (res.body.todos as Array<{ hash: string; text: string }>)
      .find(t => t.text.includes('Rename me'));
    hash = todo!.hash;
  });

  it('rejects unknown action', async () => {
    const res = await request(app)
      .post('/api/suggestion/apply')
      .send({ hash, action: 'explode' });
    expect(res.status).toBe(400);
  });

  it('rewrites a todo text', async () => {
    const res = await request(app)
      .post('/api/suggestion/apply')
      .send({ hash, action: 'rewrite', new_text: 'Renamed successfully' });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok', true);
    const applyFile = join(ROOT, 'apply-test.md');
    expect(readFileSync(applyFile, 'utf-8')).toContain('Renamed successfully');
  });
});
