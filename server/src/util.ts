import { resolve, sep, join } from 'path';
import { homedir } from 'os';
import { writeFileSync, renameSync } from 'fs';
import type { ToggleOutcome } from './types.js';

export function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

export function isPathInRoots(p: string, roots: string[]): boolean {
  const safe = resolve(p);
  return roots.some(root => {
    const r = resolve(root);
    return safe === r || safe.startsWith(r + sep);
  });
}

export function atomicWrite(targetPath: string, content: string): void {
  const tmp = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, content, 'utf-8');
  renameSync(tmp, targetPath);
}

export function countTodos(content: string): { unchecked: number; checked: number; total: number } {
  const unchecked = (content.match(/- \[ \]/g) ?? []).length;
  const checked = (content.match(/- \[x\]/gi) ?? []).length;
  return { unchecked, checked, total: unchecked + checked };
}

const TODO_LINE_RE = /^(\s*)- \[([ xX])\] (.*)$/;

interface ParsedTodoLine {
  indent: string;
  mark: string;
  text: string;
}

function parseTodoLine(line: string): ParsedTodoLine | null {
  const m = line.match(TODO_LINE_RE);
  if (!m) return null;
  const [, indent, mark, text] = m as [string, string, string, string];
  return { indent, mark, text };
}

/**
 * Toggle a checkbox by line hint. Searches ±window lines for matching text
 * when the file was edited externally between render and click.
 * Returns ToggleResult on success or ToggleError on failure.
 */
export function applyToggle(
  content: string,
  lineHint: number,
  expectedText: string | undefined,
  newChecked: boolean,
  window = 5,
): ToggleOutcome {
  const lines = content.split('\n');
  if (!Number.isInteger(lineHint) || lineHint < 0 || lineHint >= lines.length) {
    return { error: 'Invalid line number' };
  }

  let targetLine = -1;
  const at = parseTodoLine(lines[lineHint] ?? '');

  if (at && (expectedText === undefined || at.text === expectedText)) {
    targetLine = lineHint;
  } else if (expectedText !== undefined) {
    for (let d = 1; d <= window && targetLine === -1; d++) {
      for (const i of [lineHint - d, lineHint + d]) {
        if (i < 0 || i >= lines.length) continue;
        const parsed = parseTodoLine(lines[i] ?? '');
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

  const cur = parseTodoLine(lines[targetLine] ?? '');
  if (!cur) return { error: 'Failed to parse target line' };

  const curIsChecked = cur.mark.toLowerCase() === 'x';
  if (curIsChecked === newChecked) {
    return { content, line: targetLine, noop: true };
  }

  const newMark = newChecked ? 'x' : ' ';
  lines[targetLine] = `${cur.indent}- [${newMark}] ${cur.text}`;
  return { content: lines.join('\n'), line: targetLine };
}
