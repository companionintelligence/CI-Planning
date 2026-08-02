/**
 * Telemetry (Sentry) settings resolution — the opt-in gate.
 *
 * Error reporting is **opt-in and off by default**: with no `SENTRY_DSN` nothing is
 * initialised and the process makes no outbound connection at all. Two kill switches
 * disable reporting even when a DSN has been baked into an image (which is how a Hub
 * marketplace install would receive one), so an operator can always turn telemetry off
 * without rebuilding:
 *
 *   - `CI_TELEMETRY=off`   — explicit opt-out
 *   - `CI_LOCAL_ONLY=true` — local-only mode must mean zero phone-home
 *
 * Precedence is local-only > opt-out > no-dsn, and the losing reasons are still
 * reported via `disabledReason` so the boot log can say WHY reporting is off rather
 * than silently doing nothing.
 *
 * Pure and env-injected (never reads `process.env` itself) so the whole matrix is
 * unit-testable — see server/test/telemetry.test.ts.
 */

/** Why reporting is off. `null` when it is on. */
export type TelemetryDisabledReason = 'no-dsn' | 'opt-out' | 'local-only';

export interface TelemetrySettings {
  enabled: boolean;
  disabledReason: TelemetryDisabledReason | null;
  dsn: string | null;
  environment: string;
  release: string | undefined;
  component: string;
  deploymentVersion: string | null;
}

const FALSEY = new Set(['off', 'false', '0', 'no', 'disabled']);
const TRUTHY = new Set(['on', 'true', '1', 'yes', 'enabled']);

/** Read an env var, treating blank/whitespace-only as unset (compose writes empty strings). */
function read(env: NodeJS.ProcessEnv, key: string): string | null {
  const value = env[key]?.trim();
  return value ? value : null;
}

/** `CI_TELEMETRY=off` (any falsey spelling) opts out; anything else leaves the DSN in charge. */
export function isTelemetryOptedOut(env: NodeJS.ProcessEnv): boolean {
  const value = read(env, 'CI_TELEMETRY')?.toLowerCase();
  return value != null && FALSEY.has(value);
}

/** Local-only mode forbids all egress, telemetry included. */
export function isLocalOnly(env: NodeJS.ProcessEnv): boolean {
  const value = read(env, 'CI_LOCAL_ONLY')?.toLowerCase();
  return value != null && TRUTHY.has(value);
}

export function resolveTelemetrySettings(env: NodeJS.ProcessEnv, component: string): TelemetrySettings {
  const dsn = read(env, 'SENTRY_DSN');
  const deploymentVersion = read(env, 'CI_PLANNING_VERSION');

  const base = {
    dsn,
    component,
    deploymentVersion,
    environment:
      read(env, 'SENTRY_ENV') ?? read(env, 'CI_PLANNING_ENVIRONMENT') ?? read(env, 'NODE_ENV') ?? 'development',
    release: read(env, 'SENTRY_RELEASE') ?? (deploymentVersion ? `${component}@${deploymentVersion}` : undefined),
  };

  // Order matters: report the OPERATOR's explicit choice ahead of "no DSN" so the boot
  // log tells them which switch is the one holding reporting off.
  if (isLocalOnly(env)) return { ...base, enabled: false, disabledReason: 'local-only' };
  if (isTelemetryOptedOut(env)) return { ...base, enabled: false, disabledReason: 'opt-out' };
  if (!dsn) return { ...base, enabled: false, disabledReason: 'no-dsn' };

  return { ...base, enabled: true, disabledReason: null };
}
