import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Guards the CI canon token contract that PR "adopt CI enriched palette" installs:
// the light (`:root`) and dark (`.dark`) themes must resolve `--primary` to the
// canonical Companion Intelligence teal (#0f717a light / #abd4d8 dark). The full
// contract is enforced in CI by scripts/lint-canon.mjs (style-canon-lint.yml); this
// is a fast, local unit-level canary so a stray edit to index.css fails the client
// suite immediately rather than only at lint time.
const cssPath = join(dirname(fileURLToPath(import.meta.url)), 'index.css');
const css = readFileSync(cssPath, 'utf8');

/**
 * Body of the first real `<selector> { … }` rule. Anchored on the opening brace
 * (`selector {`) so a mention of the selector inside a comment — e.g. the "dark =
 * .dark" header note — never matches. Handles arbitrary whitespace before `{`.
 */
function block(selector: string): string {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`);
  const m = re.exec(css);
  expect(m, `expected a "${selector} { … }" rule in index.css`).not.toBeNull();
  const open = css.indexOf('{', m!.index);
  const close = css.indexOf('}', open);
  return css.slice(open + 1, close);
}

/** Value of `--primary` declared in a given CSS block. */
function primaryOf(selector: string): string | null {
  const m = block(selector).match(/--primary:\s*([^;]+);/);
  return m ? m[1].trim() : null;
}

describe('CI canon theme tokens (index.css)', () => {
  it('light :root --primary is canon teal #0f717a', () => {
    expect(primaryOf(':root')?.toLowerCase()).toBe('#0f717a');
  });

  it('dark .dark --primary is canon teal #abd4d8', () => {
    expect(primaryOf('.dark')?.toLowerCase()).toBe('#abd4d8');
  });

  it('defines both a light (:root) and dark (.dark) theme block', () => {
    expect(css).toMatch(/:root\s*\{/);
    expect(css).toMatch(/\.dark\s*\{/);
  });
});
