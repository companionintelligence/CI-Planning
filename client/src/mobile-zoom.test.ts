import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Pinch-zoom must stay on (WCAG 1.4.4, Resize Text), in the browser and in both app shells.
 * Three independent things can switch it off, and a person who needs it cannot tell which:
 *
 *   1. the page's viewport tag (`maximum-scale`, `user-scalable=no`),
 *   2. Capacitor's own switch, `zoomEnabled`, which defaults to FALSE for each platform and
 *      is independent of the tag, so a shell that fixes only the tag still cannot zoom,
 *   3. something at runtime writing (1) after the fact. The shell used to: it appended
 *      `maximum-scale=1` to stop iOS zooming into focused fields.
 *
 * That last reason is gone because the fields are now big enough on their own: iOS only
 * zooms into a field under 16px, which the touch-device rule at the end of index.css rules
 * out. This file reads the sources and fails if any of the four comes undone. It cannot
 * pinch a real screen (that was checked by hand, see the pull request that added it), only
 * keep the settings that make it possible from being written back.
 */

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = join(here, '..', '..');
const read = (...parts: string[]) => readFileSync(join(repo, ...parts), 'utf8');

/** The `content` of `<meta name="viewport">`, from a page's HTML. */
function viewportContent(html: string): string {
  const tag = html.match(/<meta[^>]*name=["']viewport["'][^>]*>/i)?.[0] ?? '';
  return tag.match(/content=["']([^"']*)["']/i)?.[1] ?? '';
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|html|css)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('the page', () => {
  it('has a viewport tag that allows zooming', () => {
    const content = viewportContent(read('client', 'index.html'));
    expect(content).toMatch(/width=device-width/);
    expect(content).not.toMatch(/user-scalable\s*=\s*(no|0)/i);
    // axe's meta-viewport-large wants 5 or more; WCAG itself needs 2.
    const max = content.match(/maximum-scale\s*=\s*([\d.]+)/i)?.[1];
    expect(max === undefined || Number(max) >= 5).toBe(true);
  });

  it('is never rewritten to forbid it by anything in the client', () => {
    const offenders = sourceFiles(join(repo, 'client', 'src'))
      .filter((file) => /maximum-scale|user-scalable|minimum-scale/i.test(readFileSync(file, 'utf8')))
      .map((file) => file.slice(repo.length + 1));
    expect(offenders).toEqual([]);
  });
});

describe('the app shells', () => {
  it.each(['ios', 'android'] as const)('%s turns Capacitor zoom on, under its own platform key', async (platform) => {
    // The platform key wins over a top-level `zoomEnabled`, so it is the one that has to say true.
    const { default: config } = await import(`../../mobile/${platform}/capacitor.config.ts`);
    expect(config[platform]?.zoomEnabled).toBe(true);
  });
});

describe('fields on a touch device', () => {
  const css = read('client', 'src', 'index.css');

  /** The declarations of every `@media (pointer: coarse)` block, joined. */
  const coarse = [...css.matchAll(/@media\s*\(pointer:\s*coarse\)\s*\{([\s\S]*?\n\})/g)].map((m) => m[1]).join('\n');

  it('are at least 16px, so iOS never zooms the page into a focused one', () => {
    expect(coarse).toMatch(/(^|[\s,])input:not\(/);
    expect(coarse).toMatch(/(^|[\s,])select\s*[,{]/);
    expect(coarse).toMatch(/(^|[\s,])textarea\s*[,{]/);
    const sizes = [...coarse.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(16);
  });

  it('leave out the controls that have no text to zoom into', () => {
    for (const type of ['checkbox', 'radio', 'range', 'button', 'submit', 'file', 'color', 'hidden']) {
      expect(coarse).toContain(`[type="${type}"]`);
    }
  });

  it('draw date and time inputs without the native iOS appearance, which ignores width: 100% and overflows a half-width column', () => {
    // Seen in the iOS 27 simulator on the onboarding wizard's wake and bed times: the second
    // input ran off the card and over the first, at 14px as well as at 16px.
    for (const type of ['date', 'time', 'datetime-local']) {
      expect(coarse).toContain(`input[type="${type}"]`);
    }
    expect(coarse).toMatch(/(^|[\s;{])appearance:\s*none/);
  });

  it('are floored outside every @layer, where a text-sm on the element cannot win', () => {
    const code = css.replace(/\/\*[\s\S]*?\*\//g, ''); // braces in comments are not blocks
    const at = code.indexOf('@media (pointer: coarse)');
    expect(at).toBeGreaterThan(-1);
    // Count the blocks open before the rule: an unlayered rule sits at depth 0.
    let depth = 0;
    for (const ch of code.slice(0, at)) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
    expect(depth).toBe(0);
  });
});
