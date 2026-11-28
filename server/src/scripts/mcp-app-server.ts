/** Local stdio MCP server for Companion Planning's owner-scoped REST API. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildAppMcpServer, createAppApi } from '../mcp/app-server.js';

async function main(): Promise<void> {
  // Read credentials from an ignored, machine-local file by default. Variables already
  // supplied by the MCP client take precedence (Node's loadEnvFile never overwrites them).
  const localEnv = fileURLToPath(new URL('../../mcp.local.env', import.meta.url));
  if (existsSync(localEnv)) process.loadEnvFile(localEnv);

  const baseUrl = process.env.CP_MCP_APP_URL ?? 'http://127.0.0.1:3848';
  let parsed: URL;
  try { parsed = new URL(baseUrl); }
  catch { throw new Error('CP_MCP_APP_URL must be an absolute HTTP(S) URL'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('CP_MCP_APP_URL must use HTTP or HTTPS');
  }

  const server = buildAppMcpServer(createAppApi({
    baseUrl: parsed.origin + parsed.pathname.replace(/\/$/, ''),
    apiKey: process.env.CP_MCP_APP_API_KEY,
    username: process.env.CP_MCP_APP_USERNAME,
    password: process.env.CP_MCP_APP_PASSWORD,
  }));
  await server.connect(new StdioServerTransport());
  process.stderr.write(`companion-planning MCP ready (${parsed.origin})\n`);
}

main().catch((error) => {
  process.stderr.write(`companion-planning MCP failed: ${(error as Error).message}\n`);
  process.exit(1);
});
