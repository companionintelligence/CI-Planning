#!/usr/bin/env node
// Detect duplicate / near-duplicate todos across the planning files.
// Reads the SQLite index directly, normalizes plain_text, groups, reports.

import Database from 'better-sqlite3';
import path from 'node:path';

const dbPath = process.argv[2] || '/Users/liam/devel/personal/companion-planning/.claude/worktrees/musing-austin-4dd678/.data/index.db';
const db = new Database(dbPath, { readonly: true });

const rows = db
  .prepare('SELECT hash, file_path, line, heading_path, plain_text, checked, due_date FROM todos WHERE checked=0')
  .all();

function normalize(s) {
  return s
    .toLowerCase()
    // strip parenthesized clarifications
    .replace(/\([^)]*\)/g, ' ')
    // strip dates like 2026-03-26, 3/24, Mar 26, etc.
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}\b/gi, ' ')
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, ' ')
    // strip emoji/non-letters
    .replace(/[^\w\s$%.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const groups = new Map();
for (const r of rows) {
  const norm = normalize(r.plain_text);
  if (norm.length < 8) continue; // skip very short
  if (!groups.has(norm)) groups.set(norm, []);
  groups.get(norm).push(r);
}

const dupes = [...groups.entries()]
  .filter(([, arr]) => arr.length > 1)
  .sort((a, b) => b[1].length - a[1].length);

console.log(`Duplicate groups: ${dupes.length}\n`);
console.log(`# | Count | Normalized text`);
console.log(`--|-------|----------------`);
for (const [norm, arr] of dupes.slice(0, 40)) {
  console.log(`  | ${String(arr.length).padStart(5)} | ${norm.slice(0, 100)}`);
  for (const r of arr) {
    const rel = r.file_path.replace('/Users/liam/Documents/Owner_Plan/', '');
    console.log(`  |       |   - ${rel}:${r.line}  "${r.plain_text.slice(0, 80)}"`);
  }
  console.log();
}

console.log(`\nTotal duplicate-impacted todos: ${dupes.reduce((n, [, a]) => n + a.length, 0)}`);
