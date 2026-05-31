#!/usr/bin/env node
/**
 * MCP smoke test — exercises the stdio transport the way Claude Cowork / Claude
 * Desktop attach. Spawns server/dist/mcp-stdio.js, runs the JSON-RPC handshake
 * (initialize → initialized → tools/list → one tool call), prints results.
 *
 * Usage: node ops/scripts/mcp-smoke.mjs
 * Exit 0 = healthy; non-zero = handshake failed.
 */
import { spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');
const ENTRY = join(REPO, 'server', 'dist', 'mcp-stdio.js');

const child = spawn('node', [ENTRY], { stdio: ['pipe', 'pipe', 'inherit'] });

let buf = '';
const pending = new Map();
let nextId = 1;

child.stdout.on('data', (chunk) => {
  buf += chunk.toString();
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout: ${method}`)); } }, 15000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'cowork-smoke', version: '1.0.0' },
  });
  console.log(`✓ initialize → ${init.result.serverInfo.name} v${init.result.serverInfo.version}`);

  notify('notifications/initialized', {});

  const tools = await rpc('tools/list', {});
  const names = tools.result.tools.map(t => t.name);
  console.log(`✓ tools/list → ${names.length} tools`);
  console.log('  ' + names.join(', '));

  // Call a read-only tool to prove round-trip works
  const stats = await rpc('tools/call', { name: 'stats', arguments: {} });
  const text = stats.result?.content?.[0]?.text ?? '(no text)';
  console.log(`✓ tools/call stats → ${text}`);

  console.log('\nMCP stdio transport is healthy — ready for Claude Cowork.');
  child.kill();
  process.exit(0);
} catch (e) {
  console.error('✗ MCP smoke failed:', e.message);
  child.kill();
  process.exit(1);
}
