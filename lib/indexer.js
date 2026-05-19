import { readFileSync, statSync, readdirSync, existsSync } from 'fs';
import { join, basename, relative, extname, sep } from 'path';
import { parseFile } from './markdown.js';
import { upsertFile, deleteFile, getFileRow } from './db.js';

export function buildFileRow(filePath, root, parsed, stat) {
  return {
    path: filePath,
    root,
    relativePath: relative(root, filePath),
    directory: basename(root),
    name: basename(filePath),
    mtimeMs: Math.floor(stat.mtimeMs),
    size: stat.size,
    sha256: parsed.contentSha,
    frontmatterJson: JSON.stringify(parsed.frontmatter || {}),
  };
}

export function buildTodoRows(filePath, parsed) {
  return parsed.todos.map(t => ({
    hash: t.hash,
    filePath,
    line: t.line,
    indent: t.indent,
    text: t.text,
    plainText: t.plainText,
    checked: t.checked ? 1 : 0,
    heading: t.heading,
    headingPath: t.headingPath,
    tagsJson: JSON.stringify(t.tags),
    due: t.due,
    done: t.done,
    priority: t.priority,
  }));
}

export function buildFtsBody(parsed) {
  const headingStr = parsed.headings.map(h => h.text).join(' | ');
  return { heading: headingStr, body: parsed.body };
}

export function indexFile(db, filePath, root) {
  let stat;
  try {
    stat = statSync(filePath);
  } catch {
    deleteFile(db, filePath);
    return null;
  }
  if (!stat.isFile()) return null;

  let content;
  try {
    content = readFileSync(filePath, 'utf-8');
  } catch {
    return null;
  }

  const existing = getFileRow(db, filePath);
  const parsed = parseFile(filePath, content);
  if (
    existing &&
    existing.sha256 === parsed.contentSha &&
    Math.abs(existing.mtime_ms - stat.mtimeMs) < 1500
  ) {
    return { skipped: true, todos: 0 };
  }

  const fileRow = buildFileRow(filePath, root, parsed, stat);
  const todos = buildTodoRows(filePath, parsed);
  const fts = buildFtsBody(parsed);
  upsertFile(db, fileRow, todos, fts);
  return { skipped: false, todos: todos.length };
}

export function fullScan(db, roots, excludeDirs) {
  const excluded = new Set(excludeDirs || []);
  const stats = { files: 0, todos: 0, skipped: 0 };
  function walk(root, dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      if (excluded.has(e)) continue;
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(root, full);
      else if (extname(e).toLowerCase() === '.md') {
        const r = indexFile(db, full, root);
        if (r) {
          stats.files++;
          stats.todos += r.todos;
          if (r.skipped) stats.skipped++;
        }
      }
    }
  }
  for (const root of roots) {
    if (existsSync(root)) walk(root, root);
  }
  // Garbage-collect files no longer on disk
  const dbPaths = db.prepare(`SELECT path FROM files`).all().map(r => r.path);
  for (const p of dbPaths) {
    try {
      statSync(p);
    } catch {
      deleteFile(db, p);
    }
  }
  return stats;
}
