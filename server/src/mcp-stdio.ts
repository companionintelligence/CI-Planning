#!/usr/bin/env node
/**
 * MCP stdio entrypoint (TypeScript).
 * Usage: `node server/dist/mcp-stdio.js`
 * In Claude Code: `claude mcp add companion-planning -- node /path/to/server/dist/mcp-stdio.js`
 */
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { expandPath } from './util.js';
import { openDb } from './db.js';
import { fullScan } from './indexer.js';
import { buildMcpServer } from './mcp.js';
import { CalendarBridge } from './calendar.js';
import { setPreferredModel } from './llm.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(
  readFileSync(join(__dirname, '..', '..', 'config.json'), 'utf-8'),
) as Record<string, unknown>;

const directories = ((config['directories'] as string[] | undefined) ?? []).map(p =>
  resolve(expandPath(p)),
);
const excludeDirs = new Set<string>((config['excludeDirs'] as string[] | undefined) ?? []);

const llmCfg = config['llm'] as { model?: string } | undefined;
if (llmCfg?.model) setPreferredModel(llmCfg.model);

const db = openDb();
fullScan(db, directories, excludeDirs);

const calendar = new CalendarBridge(db);
const server = buildMcpServer({ db, directories, excludeDirs, calendar });
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('companion-planning MCP server listening on stdio\n');
