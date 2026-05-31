import { defineConfig } from 'drizzle-kit';
import { config } from './src/lib/config.js';

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: { url: config.dbPath },
});
