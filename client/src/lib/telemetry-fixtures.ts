/**
 * Shared scrubber fixtures — the contract the browser and server scrubbers must both
 * satisfy, expressed once.
 *
 * The two implementations are deliberate twins (client/src/lib/telemetry-scrub.ts and
 * server/src/lib/telemetry/scrub.ts) because they live in separate packages. This file
 * is what stops them drifting: each package runs the same cases through its own copy,
 * so a rule added on one side and forgotten on the other fails CI.
 *
 * Kept as data, not tests, so the server suite can import it across the workspace
 * boundary without pulling in any browser code.
 */

export interface ScrubCase {
  name: string;
  input: string;
  /** Exact expected output, when the rule is deterministic. */
  expected?: string;
  /** Substrings that must NOT survive, when the exact shape is not the point. */
  absent?: string[];
}

export const STRING_CASES: ScrubCase[] = [
  {
    name: 'bearer token',
    input: 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc.def',
    absent: ['eyJhbGciOiJIUzI1NiJ9'],
  },
  { name: 'api_key pair', input: 'api_key=sk-live-1234567890', absent: ['sk-live-1234567890'] },
  { name: 'hyphenated api-key pair', input: 'api-key: sk-live-9876543210', absent: ['sk-live-9876543210'] },
  { name: 'password pair', input: 'password: hunter2', absent: ['hunter2'] },
  { name: 'json token', input: '{"token":"abcdef123456"}', absent: ['abcdef123456'] },
  { name: 'tailscale key', input: 'tskey-auth-abc123-def456', expected: '[Filtered]' },
  {
    name: 'connection url credentials',
    input: 'postgres://planning:pg_s3cure@postgres:5432/planning',
    absent: ['pg_s3cure'],
  },
  { name: 'macOS home', input: '/Users/liam/devel/ci/file.ts', expected: '~/devel/ci/file.ts' },
  { name: 'linux home', input: '/home/ci/data/companion.db', expected: '~/data/companion.db' },
  { name: 'windows home', input: 'C:\\Users\\liam\\app.log', expected: '~\\app.log' },
  {
    name: 'ordinary text is left alone',
    input: 'Cannot read properties of undefined (reading "id")',
    expected: 'Cannot read properties of undefined (reading "id")',
  },
];

export const URL_CASES: ScrubCase[] = [
  {
    name: 'query string',
    input: 'https://plan.example.com/tasks?q=therapy+appointment',
    expected: 'https://plan.example.com/tasks',
  },
  { name: 'hash', input: '/calendar#2026-08-02', expected: '/calendar' },
  { name: 'query and hash', input: '/tasks?q=a#b', expected: '/tasks' },
  { name: 'bare path is untouched', input: '/tasks/2026', expected: '/tasks/2026' },
  { name: 'home path inside a file url', input: 'file:///Users/liam/plan.db?x=1', expected: 'file://~/plan.db' },
  { name: 'unparseable input does not throw', input: '::not a url::?q=secret', expected: '::not a url::' },
];

/**
 * Object keys that must be redacted WHOLESALE, whatever their value.
 *
 * These matter because for them the key is the only signal there is: a bare
 * `"abc123456"` under `token` matches no secret pattern, so any walker that inspects
 * only values ships it intact. That is exactly the bug the CI-Hermes port found in
 * CI-Server's browser copy — its breadcrumb walker passed each VALUE to the
 * value-scrubber individually, so the key check never ran. Every entry point that walks
 * a key/value map must consult the key; `keyFilteringCases()` pins all of them at once,
 * in both packages.
 */
export const SENSITIVE_KEYS = [
  // Credentials
  'password',
  'secret',
  'token',
  'authorization',
  'cookie',
  'jwt',
  'apikey',
  'api_key',
  'api-key',
  'x-api-key',
  'dsn',
  'pepper',
  'private_key',
  'private-key',
  // Person identifiers. Not credentials, but the same class of data as the hostname we
  // drop from `server_name`. `x-ci-hub-user` arrives from the CI-Hub proxy even though
  // nothing in this repo reads it; `x-test-owner` the app does read.
  'x-ci-hub-user',
  'x-forwarded-user',
  'x-ci-owner',
  'x-test-owner',
  'remote-user',
  'username',
  'email',
];

/**
 * Keys that look adjacent but carry no secret — redacting them would lose real signal.
 * `user-agent` and the opaque row ids are the ones that actually constrain the pattern:
 * a naive `/user|owner/` would swallow all three.
 */
export const INNOCUOUS_KEYS = [
  'path',
  'method',
  'status_code',
  'count',
  'keyboard',
  'monkey',
  'user-agent',
  'user_id',
  'owner_id',
];

/** The entry points that walk a key/value map and must therefore consult the key. */
export type KeyWalkerName = 'scrubValue' | 'scrubHeaders' | 'scrubBreadcrumbData';

export const KEY_WALKER_NAMES: KeyWalkerName[] = ['scrubValue', 'scrubHeaders', 'scrubBreadcrumbData'];

/**
 * Deliberately matches NO secret pattern, no home path and no URL: if a key-filtering
 * assertion passes, it passed because the KEY was consulted and for no other reason.
 */
export const BARE_VALUE = 'abc123456';

/** Every (walker, key) pair both packages must agree on. */
export function keyFilteringCases(): { walker: KeyWalkerName; key: string; filtered: boolean }[] {
  return KEY_WALKER_NAMES.flatMap((walker) => [
    ...SENSITIVE_KEYS.map((key) => ({ walker, key, filtered: true })),
    ...INNOCUOUS_KEYS.map((key) => ({ walker, key, filtered: false })),
  ]);
}

export const MAX_STRING_LENGTH = 8000;
