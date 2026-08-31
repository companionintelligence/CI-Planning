/**
 * Issue a standalone API key (Phase I, D4). The raw key is printed ONCE — store it
 * now; only its SHA-256 hash is persisted and it can never be recovered.
 *
 *   pnpm key:issue                         # read+write, non-expiring, system owner
 *   pnpm key:issue --scopes read           # read-only
 *   pnpm key:issue --ttl-days 90           # expires in 90 days
 *   pnpm key:issue --owner <uuid>          # a specific owner
 */
// Side-effect import: opening db/index.js runs migrations and installs the store
// facade (setStore) — without it store() throws before the first statement.
import '../db/index.js';
import { issueApiKey } from '../lib/auth/apiKey.js';
import { SYSTEM_OWNER } from '../lib/context.js';
import { SCOPE_READ, SCOPE_WRITE } from '../lib/auth/types.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const owner = arg('owner') ?? SYSTEM_OWNER;
const ttlDays = arg('ttl-days') ? Number(arg('ttl-days')) : undefined;

// --scopes read | write | read,write (default: full read+write)
const scopeArg = arg('scopes');
const scopes = scopeArg
  ? scopeArg.split(',').map((s) => (s.trim() === 'write' ? SCOPE_WRITE : s.trim() === 'read' ? SCOPE_READ : s.trim()))
  : [SCOPE_READ, SCOPE_WRITE];

const key = await issueApiKey(owner, scopes, ttlDays);

console.log('\nAPI key issued (shown once — copy it now):\n');
console.log(`  ${key}\n`);
console.log(`  owner:   ${owner}`);
console.log(`  scopes:  ${scopes.join(', ')}`);
console.log(`  expires: ${ttlDays ? `in ${ttlDays} days` : 'never'}\n`);
console.log('Send it as the `x-api-key` header (or `?api_key=` for the SSE stream).\n');

process.exit(0);
