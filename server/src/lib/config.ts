import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface Config {
  port: number;
  dbPath: string;
  ollamaUrl: string;
  ollamaSmallModel: string;
  ollamaMediumModel: string;
  ollamaEmbedModel: string;
  staticDir: string;
}

// Default data dir (used only when DB_PATH is not set, e.g. local dev on macOS).
const defaultDataDir = join(homedir(), 'Library', 'Application Support', 'CompanionPlanning');

// Resolve relative to this file: server/src/lib/config.ts → server/public
const _dir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(_dir, '..', '..'); // server/src/lib → server/src → server

const dbPath = process.env.DB_PATH ?? join(defaultDataDir, 'companion.db');
// Ensure the directory containing the DB exists (better-sqlite3 won't create it).
mkdirSync(dirname(dbPath), { recursive: true });

export const config: Config = {
  port: Number(process.env.PORT ?? 3848),
  dbPath,
  ollamaUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
  // Defaults match models installed on the host. Override via env for other rigs.
  ollamaSmallModel: process.env.OLLAMA_SMALL ?? 'qwen2.5:0.5b',
  ollamaMediumModel: process.env.OLLAMA_MEDIUM ?? 'gemma4:e4b',
  ollamaEmbedModel: process.env.OLLAMA_EMBED ?? 'nomic-embed-text',
  staticDir: join(packageRoot, 'public'),
};
