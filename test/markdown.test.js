import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFile } from '../lib/markdown.js';

test('parseFile: inline (due: YYYY-MM-DD) wins', () => {
  const { todos } = parseFile('/x.md', '- [ ] file taxes (due: 2026-04-15)\n');
  assert.equal(todos.length, 1);
  assert.equal(todos[0].due, '2026-04-15');
});

test('parseFile: frontmatter due as unquoted YAML date returns a string, not a Date', () => {
  // gray-matter parses `due: 2026-04-15` (no quotes) as a Date object — that used
  // to crash better-sqlite3 on bind. The parser must coerce to YYYY-MM-DD.
  const content = `---\ndue: 2026-04-15\n---\n\n- [ ] do the thing\n`;
  const { todos } = parseFile('/x.md', content);
  assert.equal(todos.length, 1);
  assert.equal(typeof todos[0].due, 'string', 'due must be a string');
  assert.equal(todos[0].due, '2026-04-15');
});

test('parseFile: frontmatter due as quoted YAML string is preserved', () => {
  const content = `---\ndue: "2026-06-30"\n---\n\n- [ ] do the thing\n`;
  const { todos } = parseFile('/x.md', content);
  assert.equal(todos[0].due, '2026-06-30');
});

test('parseFile: inline overrides frontmatter when both present', () => {
  const content = `---\ndue: "2026-12-31"\n---\n\n- [ ] urgent (due: 2026-01-01)\n`;
  const { todos } = parseFile('/x.md', content);
  assert.equal(todos[0].due, '2026-01-01');
});

test('parseFile: no due anywhere → null', () => {
  const { todos } = parseFile('/x.md', '- [ ] no date\n');
  assert.equal(todos[0].due, null);
});
