import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

/**
 * Settings has no component test (it cannot be mounted cheaply), so the wiring of the
 * Learning tab is pinned here at the source. These are the facts the panel's own tests
 * cannot see, because they all render the panel directly:
 *
 *   - the tab exists, between Connections and Logs, in the same shape as the others;
 *   - the panel is mounted ONLY while that tab is open, so the four reads fire for an owner
 *     who looks and not on the most-visited tab;
 *   - the panel sits AFTER the closing </form>. Its buttons act at once, and an untyped
 *     button inside `<form onSubmit={save}>` would PATCH the preferences;
 *   - whether the clear buttons are offered comes from learningCanReset (tested on its own),
 *     not from an inline role comparison nobody tests.
 *
 * A source check is blunt, but it fails on exactly the mistakes this tab is exposed to: a
 * typo in the tab union, the panel moved inside the form, or the lazy mount lost.
 */

const source = readFileSync(new URL('./Settings.tsx', import.meta.url), 'utf8');
const at = (needle: string | RegExp, from = 0): number => {
  if (typeof needle === 'string') return source.indexOf(needle, from);
  const m = needle.exec(source.slice(from));
  return m ? from + m.index : -1;
};

describe('Settings: the Learning tab wiring', () => {
  it('imports the panel and the access rule', () => {
    expect(source).toContain("import { LearningPanel } from '../components/learning/LearningPanel.js';");
    expect(source).toContain("import { learningCanReset } from '../lib/learning-access.js';");
  });

  it("adds 'learning' to the tab union, in the middle", () => {
    expect(source).toContain(
      "createSignal<'profile' | 'preferences' | 'people' | 'connections' | 'learning' | 'logs'>('profile')",
    );
  });

  it('has one tab button, typed, between Connections and Logs, in the shape of the others', () => {
    const button = /<button\s+type="button"\s+onClick=\{\(\) => setActiveTab\('learning'\)\}\s+role="tab" class="view-tab"\s+aria-selected=\{activeTab\(\) === 'learning'\}\s*>\s*Learning\s*<\/button>/;
    expect(source.match(new RegExp(button.source, 'g'))).toHaveLength(1);

    const connections = at("setActiveTab('connections')");
    const learning = at("setActiveTab('learning')");
    const logs = at("setActiveTab('logs')");
    expect(connections).toBeGreaterThan(0);
    expect(connections).toBeLessThan(learning);
    expect(learning).toBeLessThan(logs);
  });

  it('mounts the panel once, only while the tab is open', () => {
    expect(source.match(/<LearningPanel\b/g)).toHaveLength(1);
    const show = at("<Show when={activeTab() === 'learning'}>");
    const panel = at('<LearningPanel');
    const showEnd = at('</Show>', panel);
    expect(show).toBeGreaterThan(0);
    expect(show).toBeLessThan(panel);
    // The panel is the Show's only child, so nothing else gates it and nothing outlives it.
    expect(source.slice(show, showEnd)).not.toMatch(/<Show\b[^>]*>[\s\S]*<Show\b/);
  });

  it('puts the panel after the settings form closes, not inside it', () => {
    const formOpen = at('<form onSubmit={save}');
    const formClose = at('</form>', formOpen);
    const panel = at('<LearningPanel');
    expect(formOpen).toBeGreaterThan(0);
    expect(formClose).toBeGreaterThan(formOpen);
    expect(panel).toBeGreaterThan(formClose);
    // And it is not inside some other form either.
    const lastOpenBefore = source.slice(0, panel).lastIndexOf('<form ');
    const lastCloseBefore = source.slice(0, panel).lastIndexOf('</form>');
    expect(lastCloseBefore).toBeGreaterThan(lastOpenBefore);
  });

  it('decides who may clear with learningCanReset, and keys the memory of clears to the account', () => {
    expect(source).toContain('canReset={learningCanReset(me.loading, me())}');
    expect(source).toContain('owner={me()?.ownerId ?? null}');
    expect(source).not.toMatch(/canReset=\{[^}]*role/);
  });

  it('still has the other four panels behind their own tabs', () => {
    for (const tab of ['profile', 'preferences', 'connections', 'logs']) {
      expect(source).toContain(`<Show when={activeTab() === '${tab}'}>`);
    }
  });
});
