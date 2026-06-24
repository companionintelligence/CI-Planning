/**
 * Google Calendar MCP server — stdio entry point.
 *
 * CP (the MCP *client*, server/src/mcp/client.ts) spawns this as a child process and
 * drives it over stdio. It exposes the 4 calendar tools CP pins and fulfils them against
 * the real Google Calendar REST API using the OAuth bearer token CP injects via the
 * GOOGLE_ACCESS_TOKEN env var — the ONLY secret in this child's env (McpGoogleSession
 * builds a minimal env of just that token + PATH; see I6).
 *
 * Wire it up by pointing CP_MCP_COMMAND at this script under tsx, mirroring the
 * Dockerfile's run model (the server has no build step):
 *
 *   CP_MCP_COMMAND="node_modules/.bin/tsx src/scripts/mcp-google-server.ts"
 *
 * Run with the `server/` directory as the working directory so node_modules/.bin/tsx and
 * the relative script path both resolve.
 *
 * Calendar-only by design: Gmail's gmail.readonly is a restricted scope (CASA) — see
 * docs/google-cloud-setup.md §7. CP's spawn() only requires the Gmail tools when
 * config.google.enableGmail is set, so this calendar-only server connects cleanly.
 *
 * This module is the executable entry and is never imported by tests (the testable logic
 * lives in ../mcp/google-server.ts), so it runs main() unconditionally.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildServer, createCalendarHandlers } from '../mcp/google-server.js';

async function main(): Promise<void> {
  const token = process.env.GOOGLE_ACCESS_TOKEN;
  if (!token) {
    process.stderr.write('mcp-google-server: GOOGLE_ACCESS_TOKEN is required (CP injects it)\n');
    process.exit(1);
  }
  const handlers = createCalendarHandlers({ fetchImpl: globalThis.fetch, token });
  const server = buildServer(handlers);
  await server.connect(new StdioServerTransport());
  // stderr only — stdout is the JSON-RPC channel and must carry nothing else.
  process.stderr.write('mcp-google-server: ready (calendar tools)\n');
}

main().catch((err) => {
  process.stderr.write(`mcp-google-server: fatal — ${(err as Error)?.message ?? String(err)}\n`);
  process.exit(1);
});
