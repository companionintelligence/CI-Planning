import crypto from 'crypto';
import matter from 'gray-matter';

const TODO_RE = /^(\s*)- \[([ xX])\] (.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const TAG_RE = /(?:^|\s)#([a-zA-Z][\w/-]*)/g;
const INLINE_DUE_RE = /\(due:\s*(\d{4}-\d{2}-\d{2})\)/i;
const INLINE_DONE_RE = /\(done:\s*(\d{4}-\d{2}-\d{2})\)/i;
const INLINE_PRIORITY_RE = /(?:^|\s)(?:!{1,3}|\bp[1-3]\b)(?=\s|$)/i;

export function hashTodo(filePath, heading, text) {
  return crypto
    .createHash('sha256')
    .update(`${filePath}\n${heading || ''}\n${text}`)
    .digest('hex')
    .slice(0, 16);
}

export function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function parseTags(text) {
  const tags = new Set();
  let m;
  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text)) !== null) tags.add(m[1].toLowerCase());
  return Array.from(tags);
}

export function parsePriority(text) {
  const m = text.match(INLINE_PRIORITY_RE);
  if (!m) return null;
  const t = m[0].trim().toLowerCase();
  if (t === '!!!' || t === 'p1') return 1;
  if (t === '!!' || t === 'p2') return 2;
  if (t === '!' || t === 'p3') return 3;
  return null;
}

export function parseFile(filePath, content) {
  const parsed = matter(content);
  const frontmatter = parsed.data || {};
  const body = parsed.content;
  const lines = body.split('\n');

  const headings = [];
  const todos = [];
  let currentHeadingStack = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const hm = line.match(HEADING_RE);
    if (hm) {
      const level = hm[1].length;
      const text = hm[2];
      while (
        currentHeadingStack.length &&
        currentHeadingStack[currentHeadingStack.length - 1].level >= level
      ) {
        currentHeadingStack.pop();
      }
      currentHeadingStack.push({ level, text });
      headings.push({ line: i, level, text });
      continue;
    }

    const tm = line.match(TODO_RE);
    if (tm) {
      const [, indent, mark, rawText] = tm;
      const heading = currentHeadingStack.length
        ? currentHeadingStack[currentHeadingStack.length - 1].text
        : null;
      const headingPath = currentHeadingStack.map(h => h.text).join(' / ');
      const dueMatch = rawText.match(INLINE_DUE_RE);
      const doneMatch = rawText.match(INLINE_DONE_RE);
      const due = dueMatch ? dueMatch[1] : frontmatter.due || null;
      const done = doneMatch ? doneMatch[1] : null;
      const tags = parseTags(rawText);
      if (Array.isArray(frontmatter.tags)) {
        for (const t of frontmatter.tags) tags.push(String(t).toLowerCase());
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
        due,
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

export function findTodoByHash(content, hash, filePath) {
  const parsed = parseFile(filePath, content);
  for (const t of parsed.todos) {
    if (t.hash === hash) return t;
  }
  return null;
}

export function toggleTodoByHash(content, hash, filePath, newChecked) {
  const parsed = parseFile(filePath, content);
  const todo = parsed.todos.find(t => t.hash === hash);
  if (!todo) return { error: 'todo not found by hash' };
  if (todo.checked === !!newChecked) {
    return { content, noop: true };
  }
  const fmOffset = matterOffset(content);
  const lines = content.split('\n');
  const realLine = todo.line + fmOffset;
  const orig = lines[realLine];
  const newMark = newChecked ? 'x' : ' ';
  let next = orig.replace(TODO_RE, (_m, indent, _mark, text) => {
    if (newChecked && !INLINE_DONE_RE.test(text)) {
      const today = new Date().toISOString().slice(0, 10);
      text = text.trim() + ` (done: ${today})`;
    } else if (!newChecked) {
      text = text.replace(INLINE_DONE_RE, '').trim();
    }
    return `${indent}- [${newMark}] ${text}`;
  });
  lines[realLine] = next;
  return { content: lines.join('\n'), line: realLine };
}

function matterOffset(content) {
  if (!content.startsWith('---')) return 0;
  const end = content.indexOf('\n---', 3);
  if (end === -1) return 0;
  const fmText = content.slice(0, end + 4);
  return fmText.split('\n').length - 1;
}

export function appendUnderHeading(content, heading, lineToAppend) {
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
    const hm = lines[i].match(HEADING_RE);
    if (hm && hm[1].length <= target.level) break;
    insertAt = i + 1;
  }
  while (insertAt > targetReal + 1 && lines[insertAt - 1].trim() === '') {
    insertAt--;
  }
  lines.splice(insertAt, 0, lineToAppend);
  return lines.join('\n');
}
