import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';
import type {
  FileRow,
  FileRowDb,
  TodoRow,
  TodoRowDb,
  FtsResult,
  TodoFilter,
  Stats,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function openDb(dbPath?: string): Database.Database {
  if (!dbPath) {
    // server/src/ → server/dist/  →  go up two levels to repo root
    const dataDir = join(__dirname, '..', '..', '.data');
    mkdirSync(dataDir, { recursive: true });
    dbPath = join(dataDir, 'index.db');
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      root TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      directory TEXT NOT NULL,
      name TEXT NOT NULL,
      mtime_ms INTEGER NOT NULL,
      size INTEGER NOT NULL,
      sha256 TEXT NOT NULL,
      frontmatter_json TEXT,
      indexed_at INTEGER NOT NULL DEFAULT (strftime('%s','now'))
    );

    CREATE TABLE IF NOT EXISTS todos (
      hash TEXT PRIMARY KEY,
      file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
      line INTEGER NOT NULL,
      indent TEXT NOT NULL,
      text TEXT NOT NULL,
      plain_text TEXT NOT NULL,
      checked INTEGER NOT NULL,
      heading TEXT,
      heading_path TEXT,
      tags_json TEXT,
      due_date TEXT,
      done_date TEXT,
      priority INTEGER
    );
    CREATE INDEX IF NOT EXISTS todos_open ON todos(checked, due_date);
    CREATE INDEX IF NOT EXISTS todos_file ON todos(file_path);
    CREATE INDEX IF NOT EXISTS todos_due ON todos(due_date) WHERE due_date IS NOT NULL;

    CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
      path UNINDEXED,
      heading,
      body,
      tokenize = 'porter unicode61'
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function upsertFile(
  db: Database.Database,
  fileRow: FileRow,
  todos: TodoRow[],
  ftsBody: { heading: string; body: string },
): void {
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO files
       (path, root, relative_path, directory, name, mtime_ms, size, sha256, frontmatter_json, indexed_at)
       VALUES (@path, @root, @relativePath, @directory, @name, @mtimeMs, @size, @sha256, @frontmatterJson, strftime('%s','now'))
       ON CONFLICT(path) DO UPDATE SET
         root=excluded.root,
         relative_path=excluded.relative_path,
         directory=excluded.directory,
         name=excluded.name,
         mtime_ms=excluded.mtime_ms,
         size=excluded.size,
         sha256=excluded.sha256,
         frontmatter_json=excluded.frontmatter_json,
         indexed_at=excluded.indexed_at`,
    ).run(fileRow as unknown as Record<string, unknown>);

    db.prepare(`DELETE FROM todos WHERE file_path = ?`).run(fileRow.path);

    const insTodo = db.prepare(
      `INSERT OR REPLACE INTO todos
       (hash, file_path, line, indent, text, plain_text, checked, heading, heading_path, tags_json, due_date, done_date, priority)
       VALUES (@hash, @filePath, @line, @indent, @text, @plainText, @checked, @heading, @headingPath, @tagsJson, @due, @done, @priority)`,
    );
    for (const t of todos) insTodo.run(t as unknown as Record<string, unknown>);

    db.prepare(`DELETE FROM notes_fts WHERE path = ?`).run(fileRow.path);
    db.prepare(`INSERT INTO notes_fts (path, heading, body) VALUES (?, ?, ?)`)
      .run(fileRow.path, ftsBody.heading, ftsBody.body);
  });
  tx();
}

export function deleteFile(db: Database.Database, path: string): void {
  db.prepare(`DELETE FROM files WHERE path = ?`).run(path);
  db.prepare(`DELETE FROM notes_fts WHERE path = ?`).run(path);
}

export function getFileRow(db: Database.Database, path: string): FileRowDb | undefined {
  return db.prepare(`SELECT * FROM files WHERE path = ?`).get(path) as FileRowDb | undefined;
}

export function getTodoByHash(db: Database.Database, hash: string): TodoRowDb | undefined {
  return db.prepare(`SELECT * FROM todos WHERE hash = ?`).get(hash) as TodoRowDb | undefined;
}

export function listFiles(db: Database.Database): FileRowDb[] {
  return db
    .prepare(
      `SELECT f.path, f.root, f.relative_path AS relativePath, f.directory, f.name,
              f.mtime_ms AS mtimeMs,
              (SELECT COUNT(*) FROM todos t WHERE t.file_path=f.path AND t.checked=0) AS open,
              (SELECT COUNT(*) FROM todos t WHERE t.file_path=f.path AND t.checked=1) AS done
       FROM files f
       ORDER BY f.directory, f.relative_path`,
    )
    .all() as FileRowDb[];
}

export function queryTodos(db: Database.Database, filter: TodoFilter = {}): TodoRowDb[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};

  if (filter.checked === 0 || filter.checked === 1) {
    where.push(`checked = @checked`);
    params['checked'] = filter.checked;
  }
  if (filter.due === 'today') {
    where.push(`due_date = date('now','localtime')`);
  } else if (filter.due === 'overdue') {
    where.push(`due_date IS NOT NULL AND due_date < date('now','localtime') AND checked = 0`);
  } else if (filter.due === 'this_week') {
    where.push(
      `due_date IS NOT NULL AND due_date >= date('now','localtime') AND due_date <= date('now','localtime','+7 days')`,
    );
  }
  if (filter.tag) {
    where.push(`tags_json LIKE @tagLike`);
    params['tagLike'] = `%"${filter.tag.toLowerCase()}"%`;
  }
  if (filter.file) {
    where.push(`file_path = @file`);
    params['file'] = filter.file;
  }
  if (filter.q) {
    where.push(`(text LIKE @qLike OR heading LIKE @qLike OR heading_path LIKE @qLike)`);
    params['qLike'] = `%${filter.q}%`;
  }

  const limit = Number(filter.limit) || 500;
  const sql = `SELECT * FROM todos ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY checked ASC,
                        CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
                        due_date ASC,
                        priority IS NULL, priority ASC,
                        file_path, line
               LIMIT ${limit}`;
  return db.prepare(sql).all(params) as TodoRowDb[];
}

export function searchFts(db: Database.Database, q: string, limit = 50): FtsResult[] {
  const safe = q
    .split(/\s+/)
    .filter(Boolean)
    .map(t => `"${t.replace(/"/g, '""')}"`)
    .join(' ');
  return db
    .prepare(
      `SELECT path, heading, snippet(notes_fts, 2, '<mark>', '</mark>', '…', 16) AS snippet,
              bm25(notes_fts) AS score
       FROM notes_fts
       WHERE notes_fts MATCH ?
       ORDER BY score
       LIMIT ?`,
    )
    .all(safe, limit) as FtsResult[];
}

export function getStats(db: Database.Database): Stats {
  return db
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM files) AS files,
        (SELECT COUNT(*) FROM todos) AS todos_total,
        (SELECT COUNT(*) FROM todos WHERE checked=0) AS todos_open,
        (SELECT COUNT(*) FROM todos WHERE checked=1) AS todos_done,
        (SELECT COUNT(*) FROM todos WHERE checked=0 AND due_date IS NOT NULL AND due_date < date('now','localtime')) AS overdue,
        (SELECT COUNT(*) FROM todos WHERE checked=0 AND due_date = date('now','localtime')) AS due_today`,
    )
    .get() as Stats;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
  ).run(key, value);
}

export function getMeta(db: Database.Database, key: string): string | null {
  const r = db.prepare(`SELECT value FROM meta WHERE key=?`).get(key) as { value: string } | undefined;
  return r?.value ?? null;
}
