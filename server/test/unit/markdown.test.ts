import { describe, it, expect } from 'vitest';
import { parseFile, hashTodo, sha256, appendUnderHeading, toggleTodoByHash } from '../../src/markdown.js';

describe('hashTodo', () => {
  it('produces a 16-char hex string', () => {
    const h = hashTodo('/path/to/file.md', 'My Heading', 'do the thing');
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
  it('is stable across calls', () => {
    const a = hashTodo('/f.md', 'h', 't');
    const b = hashTodo('/f.md', 'h', 't');
    expect(a).toBe(b);
  });
  it('differs when any argument changes', () => {
    const h1 = hashTodo('/f.md', 'h', 'text');
    const h2 = hashTodo('/f.md', 'h2', 'text');
    const h3 = hashTodo('/g.md', 'h', 'text');
    expect(h1).not.toBe(h2);
    expect(h1).not.toBe(h3);
  });
});

describe('sha256', () => {
  it('returns a 64-char hex string', () => {
    expect(sha256('hello')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseFile', () => {
  const md = `---
title: Test
tags: [work, p1]
---

# Section One

- [ ] open task #urgent
- [x] done task (done: 2026-05-01)

## Subsection

- [ ] nested task (due: 2026-06-01)
`;

  it('extracts frontmatter', () => {
    const { frontmatter } = parseFile('/test.md', md);
    expect(frontmatter['title']).toBe('Test');
  });

  it('extracts headings', () => {
    const { headings } = parseFile('/test.md', md);
    expect(headings.map(h => h.text)).toContain('Section One');
    expect(headings.map(h => h.text)).toContain('Subsection');
  });

  it('parses open and checked todos', () => {
    const { todos } = parseFile('/test.md', md);
    const open = todos.filter(t => !t.checked);
    const done = todos.filter(t => t.checked);
    expect(open.length).toBe(2);
    expect(done.length).toBe(1);
  });

  it('extracts inline tags', () => {
    const { todos } = parseFile('/test.md', md);
    const t = todos.find(t => t.text.includes('#urgent'));
    expect(t?.tags).toContain('urgent');
  });

  it('extracts frontmatter tags', () => {
    const { todos } = parseFile('/test.md', md);
    // frontmatter tags: [work, p1] should appear on all todos
    for (const t of todos) {
      expect(t.tags).toContain('work');
    }
  });

  it('parses inline due date', () => {
    const { todos } = parseFile('/test.md', md);
    const t = todos.find(t => t.text.includes('(due: 2026-06-01)'));
    expect(t?.due).toBe('2026-06-01');
  });

  it('parses done date', () => {
    const { todos } = parseFile('/test.md', md);
    const done = todos.find(t => t.checked);
    expect(done?.done).toBe('2026-05-01');
  });

  it('records nearest heading', () => {
    const { todos } = parseFile('/test.md', md);
    const nested = todos.find(t => t.text.includes('nested'));
    expect(nested?.heading).toBe('Subsection');
  });

  it('generates stable hashes', () => {
    const { todos } = parseFile('/test.md', md);
    const hashes = todos.map(t => t.hash);
    expect(new Set(hashes).size).toBe(todos.length);
  });
});

describe('toggleTodoByHash', () => {
  const md = `# Tasks\n\n- [ ] buy milk\n- [x] done item\n`;

  it('marks a todo done', () => {
    const parsed = parseFile('/f.md', md);
    const hash = parsed.todos.find(t => t.text === 'buy milk')?.hash ?? '';
    const r = toggleTodoByHash(md, hash, '/f.md', true);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.content).toContain('- [x] buy milk');
      expect(r.content).toContain('(done:');
    }
  });

  it('returns noop when already done', () => {
    const parsed = parseFile('/f.md', md);
    const hash = parsed.todos.find(t => t.checked)?.hash ?? '';
    const r = toggleTodoByHash(md, hash, '/f.md', true);
    expect('error' in r).toBe(false);
    if (!('error' in r)) expect(r.noop).toBe(true);
  });

  it('returns error for unknown hash', () => {
    const r = toggleTodoByHash(md, 'deadbeef00000000', '/f.md', true);
    expect('error' in r).toBe(true);
  });
});

describe('appendUnderHeading', () => {
  it('appends under existing heading', () => {
    const content = `# Inbox\n\n- [ ] existing\n`;
    const result = appendUnderHeading(content, 'Inbox', '- [ ] new task');
    expect(result).toContain('- [ ] new task');
    expect(result.indexOf('# Inbox')).toBeLessThan(result.indexOf('- [ ] new task'));
  });

  it('creates heading if missing', () => {
    const content = `# Other\n\n- [ ] existing\n`;
    const result = appendUnderHeading(content, 'Inbox', '- [ ] new task');
    expect(result).toContain('## Inbox');
    expect(result).toContain('- [ ] new task');
  });
});
