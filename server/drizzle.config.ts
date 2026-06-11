import { defineConfig } from 'drizzle-kit';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dbPath = process.env.DB_PATH ?? join(homedir(), 'Library', 'Application Support', 'CompanionPlanning', 'companion.db');

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: dbPath },
});
