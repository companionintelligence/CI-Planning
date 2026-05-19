/**
 * Todo flow tests — verifies the full checkbox toggle cycle:
 * UI click → PATCH /api/file → markdown file on disk updated.
 */
import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';

const FIXTURE_DIR = resolve(join(__dirname, 'fixtures', 'notes'));
const FIXTURE_FILE = join(FIXTURE_DIR, 'test-tasks.md');

// Reset fixture file to known state before each test
const FIXTURE_ORIGINAL = `# Test Tasks

## Inbox

- [ ] Buy test groceries #grocery
- [ ] Call the dentist

## Work

- [ ] Write the quarterly report !!!
- [x] Deploy to staging (done: 2026-01-01)
`;

test.beforeEach(async ({ request }) => {
  writeFileSync(FIXTURE_FILE, FIXTURE_ORIGINAL);
  // Rescan so DB reflects the reset content
  await request.post('/api/rescan');
});

test('PATCH /api/file marks todo done and stamps done date', async ({ request }) => {
  // Get the file to find the hash for "Buy test groceries"
  const fileRes = await request.get('/api/file', { params: { path: FIXTURE_FILE } });
  expect(fileRes.ok()).toBe(true);
  const file = await fileRes.json() as { todos: Array<{ hash: string; text: string; checked: boolean }> };
  const todo = file.todos.find(t => t.text.includes('Buy test groceries'));
  expect(todo).toBeDefined();
  expect(todo!.checked).toBe(false);

  // Toggle it done
  const patchRes = await request.patch('/api/file', {
    data: { path: FIXTURE_FILE, hash: todo!.hash, checked: true },
  });
  expect(patchRes.ok()).toBe(true);
  const patchBody = await patchRes.json() as { success: boolean; noop: boolean };
  expect(patchBody.success).toBe(true);
  expect(patchBody.noop).toBe(false);

  // Verify file on disk
  const diskContent = readFileSync(FIXTURE_FILE, 'utf-8');
  expect(diskContent).toMatch(/\[x\].*Buy test groceries/);
  expect(diskContent).toMatch(/\(done: \d{4}-\d{2}-\d{2}\)/);
});

test('PATCH /api/file is a noop when already in target state', async ({ request }) => {
  const fileRes = await request.get('/api/file', { params: { path: FIXTURE_FILE } });
  const file = await fileRes.json() as { todos: Array<{ hash: string; text: string; checked: boolean }> };
  const done = file.todos.find(t => t.checked);
  expect(done).toBeDefined();

  const patchRes = await request.patch('/api/file', {
    data: { path: FIXTURE_FILE, hash: done!.hash, checked: true },
  });
  expect(patchRes.ok()).toBe(true);
  const body = await patchRes.json() as { noop: boolean };
  expect(body.noop).toBe(true);
});

test('PUT /api/file rejects sha mismatch (optimistic concurrency)', async ({ request }) => {
  // First, get the current sha
  const fileRes = await request.get('/api/file', { params: { path: FIXTURE_FILE } });
  const file = await fileRes.json() as { sha256: string; content: string };
  const originalSha = file.sha256;

  // Simulate concurrent write — modify the file externally
  writeFileSync(FIXTURE_FILE, FIXTURE_ORIGINAL + '\n- [ ] Concurrent addition\n');

  // Now try to write with the stale sha
  const putRes = await request.put('/api/file', {
    data: { path: FIXTURE_FILE, content: '# Overwrite\n', expected_sha256: originalSha },
  });
  expect(putRes.status()).toBe(409);
  const body = await putRes.json() as { error: string; current_sha256: string };
  expect(body.error).toBe('sha256 mismatch');
  expect(body.current_sha256).toBeDefined();
});

test('POST /api/todo adds a new todo under a heading', async ({ request }) => {
  const res = await request.post('/api/todo', {
    data: {
      path: FIXTURE_FILE,
      text: 'Pick up prescription',
      heading: 'Inbox',
      tags: ['health'],
      due: '2099-06-01',
    },
  });
  expect(res.ok()).toBe(true);
  const body = await res.json() as { success: boolean; hash: string };
  expect(body.success).toBe(true);
  expect(body.hash).toHaveLength(16);

  const disk = readFileSync(FIXTURE_FILE, 'utf-8');
  expect(disk).toContain('Pick up prescription');
  expect(disk).toContain('#health');
  expect(disk).toContain('(due: 2099-06-01)');
});

test('apply_suggestion rewrites a todo text', async ({ request }) => {
  const fileRes = await request.get('/api/file', { params: { path: FIXTURE_FILE } });
  const file = await fileRes.json() as { todos: Array<{ hash: string; text: string }> };
  const todo = file.todos.find(t => t.text.includes('Call the dentist'));
  expect(todo).toBeDefined();

  const applyRes = await request.post('/api/suggestion/apply', {
    data: { hash: todo!.hash, action: 'rewrite', new_text: 'Schedule dental appointment' },
  });
  expect(applyRes.ok()).toBe(true);
  const body = await applyRes.json() as { ok: boolean };
  expect(body.ok).toBe(true);

  const disk = readFileSync(FIXTURE_FILE, 'utf-8');
  expect(disk).toContain('Schedule dental appointment');
  expect(disk).not.toContain('Call the dentist');
});
