import { readFileSync, statSync, readdirSync, existsSync } from 'fs';
import { join, basename, relative, extname } from 'path';
import type Database from 'better-sqlite3';
import { parseFile } from './markdown.js';
import { upsertFile, deleteFile, getFileRow } from './db.js';
import type { FileRow, TodoRow } from './types.js';

export function buildFileRow(
  filePath: string,
  root: string,
  parsed: ReturnType<typeof parseFile>,
  stat: { mtimeMs: number; size: number },
): FileRow {
  return {
    path: filePath,
    root,
    relativePath: relative(root, filePath),
    directory: basename(root),
    name: basename(filePath),
    mtimeMs: Math.floor(stat.mtimeMs),
    size: stat.size,
    sha256: parsed.contentSha,
    frontmatterJson: JSON.stringify(parsed.frontmatter ?? {}),
  };
}

export function buildTodoRows(filePath: string, parsed: ReturnType<typeof parseFile>): TodoRow[] {
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

export function buildFtsBody(parsed: ReturnType<typeof parseFile>): { heading: string; body: string } {
  return {
    heading: parsed.headings.map(h => h.text).join(' | '),
    body: parsed.body,
  };
}

export function indexFile(
  db: Database.Database,
  filePath: string,
  root: string,
): { skipped: boolean; todos: number } | null {
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(filePath);
  } catch {
    deleteFile(db, filePath);
    return null;
  }
  if (!stat.isFile()) return null;

  let content: string;
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

export interface ScanStats {
  files: number;
  todos: number;
  skipped: number;
  gc: number;
}

export function fullScan(
  db: Database.Database,
  roots: string[],
  excludeDirs: string[] | Set<string>,
): ScanStats {
  const excluded = new Set(excludeDirs);
  const stats: ScanStats = { files: 0, todos: 0, skipped: 0, gc: 0 };

  function walk(root: string, dir: string): void {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith('.')) continue;
      if (excluded.has(e)) continue;
      const full = join(dir, e);
      let st: ReturnType<typeof statSync>;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        walk(root, full);
      } else if (extname(e).toLowerCase() === '.md') {
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

  // GC: remove DB entries for files that no longer exist or are now excluded
  const dbPaths = (db.prepare(`SELECT path FROM files`).all() as Array<{ path: string }>)
    .map(r => r.path);

  for (const p of dbPaths) {
    let drop = false;
    try {
      statSync(p);
      for (const seg of p.split('/')) {
        if (excluded.has(seg)) { drop = true; break; }
      }
    } catch {
      drop = true;
    }
    if (drop) { deleteFile(db, p); stats.gc++; }
  }

  return stats;
}
