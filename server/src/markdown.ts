import crypto from 'crypto';
import matter from 'gray-matter';
import type { ParsedFile, ParsedTodo, Heading, ToggleOutcome } from './types.js';

const TODO_RE = /^(\s*)- \[([ xX])\] (.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const TAG_RE = /(?:^|\s)#([a-zA-Z][\w/-]*)/g;
const INLINE_DUE_RE = /\(due:\s*(\d{4}-\d{2}-\d{2})\)/i;
const INLINE_DONE_RE = /\(done:\s*(\d{4}-\d{2}-\d{2})\)/i;
const INLINE_PRIORITY_RE = /(?:^|\s)(?:!{1,3}|\bp[1-3]\b)(?=\s|$)/i;

export function hashTodo(filePath: string, heading: string | null, text: string): string {
  return crypto
    .createHash('sha256')
    .update(`${filePath}\n${heading ?? ''}\n${text}`)
    .digest('hex')
    .slice(0, 16);
}

export function sha256(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function parseTags(text: string): string[] {
  const tags = new Set<string>();
  let m: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) {
    if (m[1]) tags.add(m[1].toLowerCase());
  }
  return Array.from(tags);
}

export function parsePriority(text: string): 1 | 2 | 3 | null {
  const m = text.match(INLINE_PRIORITY_RE);
  if (!m) return null;
  const t = (m[0] ?? '').trim().toLowerCase();
  if (t === '!!!' || t === 'p1') return 1;
  if (t === '!!' || t === 'p2') return 2;
  if (t === '!' || t === 'p3') return 3;
  return null;
}

export function parseFile(filePath: string, content: string): ParsedFile {
  const parsed = matter(content);
  const frontmatter = (parsed.data ?? {}) as Record<string, unknown>;
  const body = parsed.content;
  const lines = body.split('\n');

  const headings: Heading[] = [];
  const todos: ParsedTodo[] = [];
  const headingStack: Array<{ level: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';

    const hm = line.match(HEADING_RE);
    if (hm) {
      const level = (hm[1] ?? '').length;
      const text = hm[2] ?? '';
      while (headingStack.length > 0 && (headingStack[headingStack.length - 1]?.level ?? 0) >= level) {
        headingStack.pop();
      }
      headingStack.push({ level, text });
      headings.push({ line: i, level, text });
      continue;
    }

    const tm = line.match(TODO_RE);
    if (tm) {
      const indent = tm[1] ?? '';
      const mark = tm[2] ?? ' ';
      const rawText = tm[3] ?? '';

      const heading = headingStack.length > 0
        ? (headingStack[headingStack.length - 1]?.text ?? null)
        : null;
      const headingPath = headingStack.map(h => h.text).join(' / ');

      const dueMatch = rawText.match(INLINE_DUE_RE);
      const doneMatch = rawText.match(INLINE_DONE_RE);

      // Inline `(due: YYYY-MM-DD)` wins over frontmatter.
      // gray-matter may parse frontmatter `due:` as a Date object when unquoted.
      const fmDue = frontmatter['due'];
      const fmDueStr =
        fmDue instanceof Date
          ? fmDue.toISOString().slice(0, 10)
          : fmDue
          ? String(fmDue).slice(0, 10)
          : null;

      const due = dueMatch?.[1] ?? fmDueStr;
      const done = doneMatch?.[1] ?? null;
      const tags = parseTags(rawText);
      const fmTags = frontmatter['tags'];
      if (Array.isArray(fmTags)) {
        for (const t of fmTags) tags.push(String(t).toLowerCase());
      }
      const priority = parsePriority(rawText);

      todos.push({
        line: i,
        indent,
        checked: mark.toLowerCase() === 'x',
        text: rawText,
        plainText: rawText
          .replace(INLINE_DUE_RE, '')
          .replace(INLINE_DONE_RE, '')
          .replace(TAG_RE, '')
          .trim(),
        heading,
        headingPath,
        tags: Array.from(new Set(tags)),
        due: due ?? null,
        done,
        priority,
        hash: hashTodo(filePath, heading, rawText),
      });
    }
  }

  return {
    frontmatter,
    body,
    headings,
    todos,
    contentSha: sha256(content),
  };
}

export function findTodoByHash(content: string, hash: string, filePath: string): ParsedTodo | null {
  const parsed = parseFile(filePath, content);
  return parsed.todos.find(t => t.hash === hash) ?? null;
}

export function toggleTodoByHash(
  content: string,
  hash: string,
  filePath: string,
  newChecked: boolean,
): ToggleOutcome {
  const parsed = parseFile(filePath, content);
  const todo = parsed.todos.find(t => t.hash === hash);
  if (!todo) return { error: 'todo not found by hash' };
  if (todo.checked === newChecked) {
    return { content, line: -1, noop: true };
  }

  const fmOffset = matterOffset(content);
  const lines = content.split('\n');
  const realLine = todo.line + fmOffset;
  const orig = lines[realLine];
  if (orig === undefined) return { error: 'line out of bounds' };

  const newMark = newChecked ? 'x' : ' ';
  const next = orig.replace(TODO_RE, (_m, indent: string, _mark: string, text: string) => {
    let t = text;
    if (newChecked && !INLINE_DONE_RE.test(t)) {
      const today = new Date().toISOString().slice(0, 10);
      t = t.trim() + ` (done: ${today})`;
    } else if (!newChecked) {
      t = t.replace(INLINE_DONE_RE, '').trim();
    }
    return `${indent}- [${newMark}] ${t}`;
  });

  lines[realLine] = next;
  return { content: lines.join('\n'), line: realLine };
}

export function rewriteTodoByHash(
  content: string,
  hash: string,
  filePath: string,
  newText: string,
): ToggleOutcome {
  const parsed = parseFile(filePath, content);
  const todo = parsed.todos.find(t => t.hash === hash);
  if (!todo) return { error: 'todo not found by hash' };
  const fmOffset = matterOffset(content);
  const lines = content.split('\n');
  const realLine = todo.line + fmOffset;
  const orig = lines[realLine];
  if (orig === undefined) return { error: 'line out of bounds' };
  const newMark = todo.checked ? 'x' : ' ';
  lines[realLine] = `${todo.indent}- [${newMark}] ${newText}`;
  return { content: lines.join('\n'), line: realLine };
}

function matterOffset(content: string): number {
  if (!content.startsWith('---')) return 0;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return 0;
  const fmText = content.slice(0, end + 4);
  return fmText.split('\n').length - 1;
}

export function appendUnderHeading(content: string, heading: string, lineToAppend: string): string {
  const parsed = parseFile('', content);
  const fmOffset = matterOffset(content);
  const lines = content.split('\n');
  const target = parsed.headings.find(h => h.text === heading);

  if (!target) {
    const sep = content.endsWith('\n') ? '' : '\n';
    return `${content}${sep}\n## ${heading}\n\n${lineToAppend}\n`;
  }

  const targetReal = target.line + fmOffset;
  let insertAt = targetReal + 1;
  for (let i = targetReal + 1; i < lines.length; i++) {
    const hm = (lines[i] ?? '').match(HEADING_RE);
    if (hm && (hm[1] ?? '').length <= target.level) break;
    insertAt = i + 1;
  }
  while (insertAt > targetReal + 1 && (lines[insertAt - 1] ?? '').trim() === '') {
    insertAt--;
  }
  lines.splice(insertAt, 0, lineToAppend);
  return lines.join('\n');
}
