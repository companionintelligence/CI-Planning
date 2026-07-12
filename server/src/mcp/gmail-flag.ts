import { config } from '../lib/config.js';

/**
 * Returns true when the Gmail ingest path may run.
 *
 * - off mode (GOOGLE_MODE unset): never — no Google integration at all.
 * - fixture mode: always allowed — reads emails.json, no credentials needed.
 * - live mode: allowed ONLY when CP_GOOGLE_ENABLE_GMAIL=true (the Gmail scope
 *   was requested during OAuth). Without it the MCP session would receive a
 *   403 (insufficient scope) from Google and dead-letter every message.
 */
export function gmailLiveAllowed(): boolean {
  if (config.google.mode === 'off') return false;
  return config.google.mode === 'fixture' || config.google.enableGmail;
}

/**
 * Build the OAuth scope list for a /start request.
 *
 * Calendar scopes are always included. Gmail scopes are added only when
 * `opts.gmail` is true AND `config.google.enableGmail` is set — the CASA /
 * restricted-scope gate. Callers set `opts.gmail: true` to express intent;
 * the function enforces the flag so intent alone can never bypass the gate.
 */
export function buildGoogleScopes(opts: { gmail?: boolean } = {}): string[] {
  const scopes = [...config.google.scopes.calendar];
  if (opts.gmail && config.google.enableGmail) {
    scopes.push(...config.google.scopes.gmail);
  }
  return scopes;
}
