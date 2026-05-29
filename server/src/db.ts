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

  // ===== V4 migration: additive columns + new tables =====
  // sqlite ALTER TABLE ADD COLUMN is idempotent only if we guard, so check first.
  const todoCols = db
    .prepare(`PRAGMA table_info(todos)`)
    .all() as Array<{ name: string }>;
  const have = (col: string) => todoCols.some(c => c.name === col);

  if (!have('source_type'))         db.exec(`ALTER TABLE todos ADD COLUMN source_type TEXT DEFAULT 'checkbox'`);
  if (!have('status'))              db.exec(`ALTER TABLE todos ADD COLUMN status TEXT DEFAULT 'open'`);
  if (!have('created_at'))          db.exec(`ALTER TABLE todos ADD COLUMN created_at INTEGER`);
  if (!have('completed_at'))        db.exec(`ALTER TABLE todos ADD COLUMN completed_at INTEGER`);
  if (!have('estimated_minutes'))   db.exec(`ALTER TABLE todos ADD COLUMN estimated_minutes INTEGER`);
  if (!have('actual_minutes'))      db.exec(`ALTER TABLE todos ADD COLUMN actual_minutes INTEGER`);
  if (!have('calendar_event_id'))   db.exec(`ALTER TABLE todos ADD COLUMN calendar_event_id TEXT`);
  if (!have('confidence'))          db.exec(`ALTER TABLE todos ADD COLUMN confidence REAL`);
  if (!have('source_quote'))        db.exec(`ALTER TABLE todos ADD COLUMN source_quote TEXT`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY,
      todo_hash TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'user',
      at INTEGER NOT NULL,
      payload_json TEXT
    );
    CREATE INDEX IF NOT EXISTS task_events_hash ON task_events(todo_hash, at DESC);
    CREATE INDEX IF NOT EXISTS task_events_type ON task_events(event_type, at DESC);

    CREATE TABLE IF NOT EXISTS calendar_links (
      id INTEGER PRIMARY KEY,
      todo_hash TEXT NOT NULL,
      calendar_id TEXT NOT NULL,
      event_id TEXT NOT NULL,
      event_title TEXT NOT NULL,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      synced_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS calendar_links_event ON calendar_links(calendar_id, event_id);
    CREATE INDEX IF NOT EXISTS calendar_links_hash ON calendar_links(todo_hash);
    CREATE INDEX IF NOT EXISTS calendar_links_start ON calendar_links(start_at);

    CREATE TABLE IF NOT EXISTS memory (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS suggested_tasks (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL,
      heading TEXT,
      text TEXT NOT NULL,
      kind TEXT NOT NULL,
      source_quote TEXT,
      confidence REAL,
      maybe_done_for_hash TEXT,
      duplicate_of_hash TEXT,
      created_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE INDEX IF NOT EXISTS suggested_status ON suggested_tasks(status, created_at DESC);
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

// ===================== V4: task_events =====================

export interface TaskEvent {
  id: number;
  todo_hash: string;
  event_type: string;
  actor: string;
  at: number;
  payload_json: string | null;
}

export function logTaskEvent(
  db: Database.Database,
  todoHash: string,
  eventType: string,
  actor = 'user',
  payload?: unknown,
): void {
  db.prepare(
    `INSERT INTO task_events (todo_hash, event_type, actor, at, payload_json)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(
    todoHash,
    eventType,
    actor,
    Date.now(),
    payload === undefined ? null : JSON.stringify(payload),
  );
}

export function getTaskEvents(db: Database.Database, todoHash: string, limit = 100): TaskEvent[] {
  return db
    .prepare(`SELECT * FROM task_events WHERE todo_hash = ? ORDER BY at DESC LIMIT ?`)
    .all(todoHash, limit) as TaskEvent[];
}

// ===================== V4: calendar_links =====================

export interface CalendarLink {
  id: number;
  todo_hash: string;
  calendar_id: string;
  event_id: string;
  event_title: string;
  start_at: number;
  end_at: number;
  status: string;
  synced_at: number;
}

export function upsertCalendarLink(db: Database.Database, link: Omit<CalendarLink, 'id'>): number {
  const r = db
    .prepare(
      `INSERT INTO calendar_links (todo_hash, calendar_id, event_id, event_title, start_at, end_at, status, synced_at)
       VALUES (@todo_hash, @calendar_id, @event_id, @event_title, @start_at, @end_at, @status, @synced_at)
       ON CONFLICT(calendar_id, event_id) DO UPDATE SET
         todo_hash=excluded.todo_hash,
         event_title=excluded.event_title,
         start_at=excluded.start_at,
         end_at=excluded.end_at,
         status=excluded.status,
         synced_at=excluded.synced_at
       RETURNING id`,
    )
    .get(link as unknown as Record<string, unknown>) as { id: number };
  return r.id;
}

export function listCalendarLinksInRange(
  db: Database.Database,
  startMs: number,
  endMs: number,
): CalendarLink[] {
  return db
    .prepare(
      `SELECT * FROM calendar_links
       WHERE status = 'active' AND start_at >= ? AND start_at < ?
       ORDER BY start_at ASC`,
    )
    .all(startMs, endMs) as CalendarLink[];
}

export function calendarLinkForTodo(db: Database.Database, todoHash: string): CalendarLink | undefined {
  return db
    .prepare(
      `SELECT * FROM calendar_links WHERE todo_hash = ? AND status = 'active' ORDER BY start_at ASC LIMIT 1`,
    )
    .get(todoHash) as CalendarLink | undefined;
}

export function deleteCalendarLinkByEvent(db: Database.Database, calendarId: string, eventId: string): void {
  db.prepare(`UPDATE calendar_links SET status='deleted' WHERE calendar_id=? AND event_id=?`)
    .run(calendarId, eventId);
}

// ===================== V4: capacity =====================

export interface DayCapacity {
  date: string;             // YYYY-MM-DD
  committed_minutes: number;
  event_count: number;
  tasks_due: number;
  tasks_unscheduled: number;
  estimated_minutes: number; // sum of estimates on tasks due this day
}

export function dailyCapacity(
  db: Database.Database,
  startDate: string,
  endDate: string,
  workdayMinutes = 480,
): DayCapacity[] {
  const cal = db
    .prepare(
      `SELECT date(start_at / 1000, 'unixepoch', 'localtime') AS day,
              COALESCE(SUM((end_at - start_at) / 60000), 0) AS committed_minutes,
              COUNT(*) AS event_count
       FROM calendar_links
       WHERE status='active'
         AND date(start_at / 1000, 'unixepoch', 'localtime') BETWEEN ? AND ?
       GROUP BY day`,
    )
    .all(startDate, endDate) as Array<{ day: string; committed_minutes: number; event_count: number }>;

  const tasks = db
    .prepare(
      `SELECT due_date AS day,
              COUNT(*) AS tasks_due,
              SUM(CASE WHEN calendar_event_id IS NULL THEN 1 ELSE 0 END) AS tasks_unscheduled,
              COALESCE(SUM(COALESCE(estimated_minutes, 0)), 0) AS estimated_minutes
       FROM todos
       WHERE checked=0 AND due_date BETWEEN ? AND ?
       GROUP BY due_date`,
    )
    .all(startDate, endDate) as Array<{
      day: string;
      tasks_due: number;
      tasks_unscheduled: number;
      estimated_minutes: number;
    }>;

  // Materialise every day in the range
  const out = new Map<string, DayCapacity>();
  const start = new Date(startDate + 'T00:00:00');
  const end = new Date(endDate + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    const k = d.toISOString().slice(0, 10);
    out.set(k, {
      date: k,
      committed_minutes: 0,
      event_count: 0,
      tasks_due: 0,
      tasks_unscheduled: 0,
      estimated_minutes: 0,
    });
  }
  for (const c of cal) {
    const row = out.get(c.day);
    if (row) { row.committed_minutes = c.committed_minutes; row.event_count = c.event_count; }
  }
  for (const t of tasks) {
    const row = out.get(t.day);
    if (row) {
      row.tasks_due = t.tasks_due;
      row.tasks_unscheduled = t.tasks_unscheduled;
      row.estimated_minutes = t.estimated_minutes;
    }
  }
  void workdayMinutes; // caller may use this to compute percentage
  return Array.from(out.values());
}

// ===================== V4: memory =====================

export function memorySet(db: Database.Database, key: string, value: string, source?: string): void {
  db.prepare(
    `INSERT INTO memory (key, value, updated_at, source) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, source=excluded.source`,
  ).run(key, value, Date.now(), source ?? null);
}

export function memoryGet(db: Database.Database, key: string): string | null {
  const r = db.prepare(`SELECT value FROM memory WHERE key=?`).get(key) as { value: string } | undefined;
  return r?.value ?? null;
}

export function memoryList(db: Database.Database): Array<{ key: string; value: string; updated_at: number; source: string | null }> {
  return db.prepare(`SELECT key, value, updated_at, source FROM memory ORDER BY updated_at DESC`).all() as Array<{
    key: string; value: string; updated_at: number; source: string | null;
  }>;
}

// ===================== V4: suggested_tasks =====================

export interface SuggestedTask {
  id: number;
  file_path: string;
  heading: string | null;
  text: string;
  kind: 'suggested' | 'maybe_done' | 'duplicate';
  source_quote: string | null;
  confidence: number | null;
  maybe_done_for_hash: string | null;
  duplicate_of_hash: string | null;
  created_at: number;
  status: 'pending' | 'accepted' | 'dismissed';
}

export function insertSuggestion(db: Database.Database, s: Omit<SuggestedTask, 'id' | 'created_at' | 'status'>): number {
  const r = db.prepare(
    `INSERT INTO suggested_tasks (file_path, heading, text, kind, source_quote, confidence, maybe_done_for_hash, duplicate_of_hash, created_at, status)
     VALUES (@file_path, @heading, @text, @kind, @source_quote, @confidence, @maybe_done_for_hash, @duplicate_of_hash, @created_at, 'pending')
     RETURNING id`,
  ).get({ ...s, created_at: Date.now() }) as { id: number };
  return r.id;
}

export function listSuggestions(db: Database.Database, status: 'pending' | 'accepted' | 'dismissed' = 'pending'): SuggestedTask[] {
  return db.prepare(`SELECT * FROM suggested_tasks WHERE status=? ORDER BY created_at DESC`).all(status) as SuggestedTask[];
}

export function updateSuggestionStatus(db: Database.Database, id: number, status: 'accepted' | 'dismissed'): void {
  db.prepare(`UPDATE suggested_tasks SET status=? WHERE id=?`).run(status, id);
}

export function getSuggestion(db: Database.Database, id: number): SuggestedTask | undefined {
  return db.prepare(`SELECT * FROM suggested_tasks WHERE id=?`).get(id) as SuggestedTask | undefined;
}
