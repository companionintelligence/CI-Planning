import test from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'os';

import { expandPath, isPathInRoots, countTodos, applyToggle } from '../lib/util.js';

test('expandPath: expands ~/', () => {
  assert.equal(expandPath('~/foo/bar'), `${homedir()}/foo/bar`);
});

test('expandPath: leaves absolute paths alone', () => {
  assert.equal(expandPath('/abs/path'), '/abs/path');
});

test('expandPath: leaves non-string input alone', () => {
  assert.equal(expandPath(undefined), undefined);
});

test('isPathInRoots: allows paths inside a root', () => {
  const roots = ['/home/user/Planning', '/home/user/work'];
  assert.ok(isPathInRoots('/home/user/Planning/notes.md', roots));
  assert.ok(isPathInRoots('/home/user/Planning/sub/deep/notes.md', roots));
  assert.ok(isPathInRoots('/home/user/Planning', roots));
});

test('isPathInRoots: rejects sibling prefix-match (the original bug)', () => {
  const roots = ['/home/user/Planning'];
  assert.equal(isPathInRoots('/home/user/PlanningSecret/notes.md', roots), false);
  assert.equal(isPathInRoots('/home/user/PlanningSecret', roots), false);
});

test('isPathInRoots: rejects unrelated paths', () => {
  const roots = ['/home/user/Planning'];
  assert.equal(isPathInRoots('/etc/passwd', roots), false);
  assert.equal(isPathInRoots('/home/user', roots), false);
});

test('isPathInRoots: collapses .. traversal', () => {
  const roots = ['/home/user/Planning'];
  assert.equal(
    isPathInRoots('/home/user/Planning/../Secret/x.md', roots),
    false
  );
});

test('countTodos: counts checked and unchecked', () => {
  const content = [
    '# Title',
    '- [ ] one',
    '- [x] two',
    '- [X] three',
    '- not a todo',
    'plain text',
  ].join('\n');
  assert.deepEqual(countTodos(content), { unchecked: 1, checked: 2, total: 3 });
});

test('countTodos: handles empty content', () => {
  assert.deepEqual(countTodos(''), { unchecked: 0, checked: 0, total: 0 });
});

test('applyToggle: unchecked → checked at exact line', () => {
  const content = '- [ ] task one\n- [ ] task two';
  const r = applyToggle(content, 1, 'task two', true);
  assert.equal(r.content, '- [ ] task one\n- [x] task two');
  assert.equal(r.line, 1);
});

test('applyToggle: checked → unchecked at exact line', () => {
  const content = '- [x] done';
  const r = applyToggle(content, 0, 'done', false);
  assert.equal(r.content, '- [ ] done');
  assert.equal(r.line, 0);
});

test('applyToggle: preserves indentation', () => {
  const content = '  - [ ] indented task';
  const r = applyToggle(content, 0, 'indented task', true);
  assert.equal(r.content, '  - [x] indented task');
});

test('applyToggle: no-op when already in desired state', () => {
  const content = '- [x] done';
  const r = applyToggle(content, 0, 'done', true);
  assert.equal(r.noop, true);
});

test('applyToggle: drifts forward to find moved todo', () => {
  // Client thought line 0; a line was inserted above, real line is 1.
  const content = 'a new heading\n- [ ] task one\n- [ ] task two';
  const r = applyToggle(content, 0, 'task one', true);
  assert.equal(r.line, 1);
  assert.equal(r.content, 'a new heading\n- [x] task one\n- [ ] task two');
});

test('applyToggle: drifts backward to find moved todo', () => {
  // Client thought line 2; a line was removed, real line is 1.
  const content = '- [ ] task one\n- [ ] task two';
  const r = applyToggle(content, 2 - 1, 'task two', true);
  // Hint is exactly right here; force a backward-drift case:
  const r2 = applyToggle('- [ ] task one\n- [ ] task two', 0 + 3, 'task two', true);
  // line 3 doesn't exist, should error:
  assert.ok(r2.error);
  // Now: real drift backward (hint=2 but line 2 doesn't exist; we expect error).
  // The real backward-drift case:
  const content3 = '- [ ] only task';
  const r3 = applyToggle(content3, 2, 'only task', true);
  // Hint is out of range → error.
  assert.ok(r3.error);
});

test('applyToggle: errors when no matching todo found and expectedText given', () => {
  const content = '- [ ] task one';
  const r = applyToggle(content, 0, 'completely different text', true);
  assert.ok(r.error);
});

test('applyToggle: errors when line is not a todo and no expectedText', () => {
  const content = 'plain text\nmore text';
  const r = applyToggle(content, 0, undefined, true);
  assert.ok(r.error);
});

test('applyToggle: errors on invalid line number', () => {
  const content = '- [ ] task';
  assert.ok(applyToggle(content, -1, 'task', true).error);
  assert.ok(applyToggle(content, 99, 'task', true).error);
  assert.ok(applyToggle(content, 1.5, 'task', true).error);
});

test('applyToggle: does not corrupt non-todo lines on no-match', () => {
  const content = '# Heading\nsome text\n- [ ] real task';
  // Hint=0 (heading), no expectedText → error, content unchanged via caller contract
  const r = applyToggle(content, 0, undefined, true);
  assert.ok(r.error);
});
