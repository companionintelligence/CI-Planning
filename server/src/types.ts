// Shared domain types for the Companion Planning server.
// SQLite column names use snake_case; these interfaces mirror that for DB rows
// and use camelCase for the in-memory representations.

export type Sha256 = string;
export type ISODate = string; // YYYY-MM-DD

// ---- File / index ----

export interface FileRow {
  path: string;
  root: string;
  relativePath: string;
  directory: string;
  name: string;
  mtimeMs: number;
  size: number;
  sha256: Sha256;
  frontmatterJson: string;
}

export interface FileRowDb extends Omit<FileRow, 'mtimeMs' | 'sha256'> {
  mtime_ms: number;
  sha256: Sha256;
  frontmatter_json: string | null;
  open?: number;
  done?: number;
}

// ---- Todos ----

export interface ParsedTodo {
  line: number;
  indent: string;
  checked: boolean;
  text: string;
  plainText: string;
  heading: string | null;
  headingPath: string;
  tags: string[];
  due: ISODate | null;
  done: ISODate | null;
  priority: 1 | 2 | 3 | null;
  hash: string;
}

export interface TodoRow {
  hash: string;
  filePath: string;
  line: number;
  indent: string;
  text: string;
  plainText: string;
  checked: 0 | 1;
  heading: string | null;
  headingPath: string | null;
  tagsJson: string;
  due: ISODate | null;
  done: ISODate | null;
  priority: 1 | 2 | 3 | null;
}

export interface TodoRowDb {
  hash: string;
  file_path: string;
  line: number;
  indent: string;
  text: string;
  plain_text: string;
  checked: 0 | 1;
  heading: string | null;
  heading_path: string | null;
  tags_json: string;
  due_date: ISODate | null;
  done_date: ISODate | null;
  priority: number | null;
}

export interface Todo {
  hash: string;
  filePath: string;
  line: number;
  indent: string;
  text: string;
  plainText: string;
  checked: boolean;
  heading: string | null;
  headingPath: string | null;
  tags: string[];
  dueDate: ISODate | null;
  doneDate: ISODate | null;
  priority: 1 | 2 | 3 | null;
}

export interface TodoFilter {
  checked?: 0 | 1;
  due?: 'today' | 'overdue' | 'this_week';
  tag?: string;
  file?: string;
  q?: string;
  limit?: number;
}

// ---- Parsed file ----

export interface Heading {
  line: number;
  level: number;
  text: string;
}

export interface ParsedFile {
  frontmatter: Record<string, unknown>;
  body: string;
  headings: Heading[];
  todos: ParsedTodo[];
  contentSha: Sha256;
}

// ---- FTS ----

export interface FtsResult {
  path: string;
  heading: string;
  snippet: string;
  score: number;
}

// ---- LLM ----

export interface TriageInput {
  hash: string;
  relativePath: string;
  heading: string | null;
  plainText: string;
}

export type TriageCategory = 'keep' | 'archive' | 'duplicate' | 'rewrite' | 'move';

export interface TriageAction {
  hash: string;
  category: TriageCategory;
  reason: string;
  duplicate_of: string | null;
  suggested_text: string | null;
  suggested_heading: string | null;
}

export interface TriageResult {
  actions: TriageAction[];
  model: string;
  raw?: string;
  error?: string;
}

export interface SummaryResult {
  text: string;
  model: string;
}

// ---- DB meta ----

export interface MetaRow {
  key: string;
  value: string;
}

// ---- Stats ----

export interface Stats {
  files: number;
  todos_total: number;
  todos_open: number;
  todos_done: number;
  overdue: number;
  due_today: number;
}

// ---- Toggle result ----

export interface ToggleResult {
  content: string;
  line: number;
  noop?: boolean;
}

export interface ToggleError {
  error: string;
}

export type ToggleOutcome = ToggleResult | ToggleError;

// ---- Suggestion (v3 / apply_suggestion) ----

export type SuggestionKind =
  | 'keep'
  | 'archive'
  | 'merge'
  | 'move'
  | 'rewrite'
  | 'mark_done'
  | 'set_due'
  | 'add_tag';

export interface Suggestion {
  kind: SuggestionKind;
  todoHash: string;
  rationale: string;
  target?: { path: string; heading: string };
  newText?: string;
  due?: ISODate;
  tag?: string;
}
