#!/usr/bin/env node
/**
 * MCP stdio entrypoint.
 * Usage in Claude Code: `claude mcp add liam-plan -- node /path/to/mcp-stdio.js`
 */
import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

import { expandPath } from './lib/util.js';
import { openDb } from './lib/db.js';
import { fullScan } from './lib/indexer.js';
import { buildMcpServer } from './lib/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(__dirname, 'config.json'), 'utf-8'));
const directories = (config.directories || []).map(p => resolve(expandPath(p)));
const excludeDirs = new Set(config.excludeDirs || []);

const db = openDb();
// Ensure index is fresh on startup (cache-hits make this cheap on warm runs)
fullScan(db, directories, excludeDirs);

const server = buildMcpServer({ db, directories, excludeDirs });
const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only — stdout is the MCP transport
process.stderr.write('liam-plan MCP server listening on stdio\n');
