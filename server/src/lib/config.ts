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
  staticDir: string;
}

const dataDir = join(homedir(), 'Library', 'Application Support', 'CompanionPlanning');
mkdirSync(dataDir, { recursive: true });

// Resolve relative to this file: server/src/lib/config.ts → server/public
const _dir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(_dir, '..', '..'); // server/src/lib → server/src → server

export const config: Config = {
  port: Number(process.env.PORT ?? 3848),
  dbPath: process.env.DB_PATH ?? join(dataDir, 'companion.db'),
  ollamaUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
  ollamaSmallModel: process.env.OLLAMA_SMALL ?? 'qwen2.5:3b',
  ollamaMediumModel: process.env.OLLAMA_MEDIUM ?? 'mistral:7b',
  staticDir: join(packageRoot, 'public'),
};
