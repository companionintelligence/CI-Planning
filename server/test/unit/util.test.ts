import { describe, it, expect } from 'vitest';
import { expandPath, isPathInRoots, countTodos, applyToggle } from '../../src/util.js';
import { homedir } from 'os';

describe('expandPath', () => {
  it('expands ~ to home dir', () => {
    expect(expandPath('~/foo/bar')).toBe(`${homedir()}/foo/bar`);
  });
  it('leaves absolute paths unchanged', () => {
    expect(expandPath('/usr/local/bin')).toBe('/usr/local/bin');
  });
});

describe('isPathInRoots', () => {
  it('accepts path within a root', () => {
    expect(isPathInRoots('/home/user/notes/file.md', ['/home/user/notes'])).toBe(true);
  });
  it('rejects path outside roots', () => {
    expect(isPathInRoots('/etc/passwd', ['/home/user/notes'])).toBe(false);
  });
  it('accepts the root itself', () => {
    expect(isPathInRoots('/home/user/notes', ['/home/user/notes'])).toBe(true);
  });
});

describe('countTodos', () => {
  it('counts unchecked and checked items', () => {
    const md = `
- [ ] open one
- [x] done one
- [ ] open two
- [X] done two
`.trim();
    const result = countTodos(md);
    expect(result.unchecked).toBe(2);
    expect(result.checked).toBe(2);
    expect(result.total).toBe(4);
  });
});

describe('applyToggle', () => {
  const content = `# Heading\n\n- [ ] buy milk\n- [x] done already\n`;

  it('toggles unchecked → checked', () => {
    const r = applyToggle(content, 2, 'buy milk', true);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.content).toContain('- [x] buy milk');
    }
  });

  it('returns noop when already in desired state', () => {
    const r = applyToggle(content, 3, 'done already', true);
    expect('error' in r).toBe(false);
    if (!('error' in r)) {
      expect(r.noop).toBe(true);
    }
  });

  it('finds item within ±window lines when hint drifts', () => {
    const shifted = `# Heading\n\nExtra line inserted\n- [ ] buy milk\n- [x] done already\n`;
    const r = applyToggle(shifted, 2, 'buy milk', true, 3);
    expect('error' in r).toBe(false);
  });

  it('returns error for completely wrong line hint and no match', () => {
    const r = applyToggle(content, 0, 'nonexistent task', true, 1);
    expect('error' in r).toBe(true);
  });
});
