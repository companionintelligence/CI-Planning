import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
// The canon comes from the tokens package, not a literal in this file — the previous
// version of this canary pinned the RETIRED teal after the palette had moved on.
const canon = createRequire(import.meta.url)('@companionintelligence/tokens/tokens.json') as { light: { primary: { hex: string } }; dark: { primary: { hex: string } } };
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, it, expect } from 'vitest';

// Guards the CI canon token contract: the light (`:root`) and dark (`.dark`) themes
// must resolve `--primary` to the canonical Companion Intelligence brand primary —
// phthalo #0a6358 light / sage #c5e8dc dark, per @companionintelligence/tokens v0.3.0.
//
// These were teal-600 #0f717a / teal-200 #abd4d8 before v0.3.0, and this canary kept
// asserting those after the palette moved on — so it failed against an index.css that
// was in fact correct, which is the one thing a canary must never do. The values here
// now match what scripts/lint-canon.mjs actually enforces; that lint
// (style-canon-lint.yml) remains the full contract and the authority, and this is only
// the fast local mirror of it, so the two must be updated together.
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
  it('light :root --primary is the canon light primary', () => {
    expect(primaryOf(':root')?.toLowerCase()).toBe(canon.light.primary.hex.toLowerCase());
  });

  it('dark .dark --primary is the canon dark primary', () => {
    expect(primaryOf('.dark')?.toLowerCase()).toBe(canon.dark.primary.hex.toLowerCase());
  });

  it('defines both a light (:root) and dark (.dark) theme block', () => {
    expect(css).toMatch(/:root\s*\{/);
    expect(css).toMatch(/\.dark\s*\{/);
  });
});
