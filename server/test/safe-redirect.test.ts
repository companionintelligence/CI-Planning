import { describe, it, expect } from 'vitest';
import { safeRelativePath } from '../src/lib/auth/safeRedirect.js';

/**
 * The page a sign-in returns to. The value comes from the browser (`?redirect=` on /start), so
 * only a same-origin path may pass; everything else is the home page.
 */
describe('safeRelativePath', () => {
  it('accepts a same-origin path, with its query and fragment', () => {
    expect(safeRelativePath('/')).toBe('/');
    expect(safeRelativePath('/shared/abc123')).toBe('/shared/abc123');
    expect(safeRelativePath('/planner?day=2026-11-02#focus')).toBe('/planner?day=2026-11-02#focus');
  });

  it('refuses anything that could leave the origin, or is not a path at all', () => {
    const refused = [
      '',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      'planner',
      ' /planner',
      '/a\nb',
      '/a\tb',
      '/' + 'a'.repeat(1024),
    ];
    for (const value of refused) {
      expect(safeRelativePath(value), JSON.stringify(value)).toBeNull();
    }
  });

  it('refuses values that are not strings', () => {
    for (const value of [undefined, null, 42, ['/planner'], { path: '/planner' }]) {
      expect(safeRelativePath(value)).toBeNull();
    }
  });
});
