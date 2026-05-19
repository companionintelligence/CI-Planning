import { resolve, sep, join } from 'path';
import { homedir } from 'os';

export function expandPath(p) {
  if (typeof p === 'string' && p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function isPathInRoots(p, roots) {
  const safe = resolve(p);
  return roots.some(root => {
    const r = resolve(root);
    return safe === r || safe.startsWith(r + sep);
  });
}

export function countTodos(content) {
  const unchecked = (content.match(/- \[ \]/g) || []).length;
  const checked = (content.match(/- \[x\]/gi) || []).length;
  return { unchecked, checked, total: unchecked + checked };
}

const TODO_LINE_RE = /^(\s*)- \[([ xX])\] (.*)$/;

function parseTodoLine(line) {
  const m = line.match(TODO_LINE_RE);
  if (!m) return null;
  const [, indent, mark, text] = m;
  return { indent, mark, text };
}

// Toggle a checkbox. If `expectedText` is provided, the line text after the marker
// must match — otherwise we search ±`window` lines for a matching task (handles
// the case where the file was edited externally between render and click).
// Returns { content, line } on success, { content, line, noop } if already in
// desired state, or { error } on failure. Does not write — caller persists.
export function applyToggle(content, lineHint, expectedText, newChecked, window = 5) {
  const lines = content.split('\n');
  if (!Number.isInteger(lineHint) || lineHint < 0 || lineHint >= lines.length) {
    return { error: 'Invalid line number' };
  }

  let targetLine = -1;
  const at = parseTodoLine(lines[lineHint]);

  if (at && (expectedText === undefined || at.text === expectedText)) {
    targetLine = lineHint;
  } else if (expectedText !== undefined) {
    for (let d = 1; d <= window && targetLine === -1; d++) {
      for (const i of [lineHint - d, lineHint + d]) {
        if (i < 0 || i >= lines.length) continue;
        const parsed = parseTodoLine(lines[i]);
        if (parsed && parsed.text === expectedText) {
          targetLine = i;
          break;
        }
      }
    }
  }

  if (targetLine === -1) {
    return { error: 'No matching todo found at or near requested line' };
  }

  const cur = parseTodoLine(lines[targetLine]);
  const newMark = newChecked ? 'x' : ' ';
  const curIsChecked = cur.mark.toLowerCase() === 'x';
  if (curIsChecked === !!newChecked) {
    return { content, line: targetLine, noop: true };
  }

  lines[targetLine] = `${cur.indent}- [${newMark}] ${cur.text}`;
  return { content: lines.join('\n'), line: targetLine };
}
