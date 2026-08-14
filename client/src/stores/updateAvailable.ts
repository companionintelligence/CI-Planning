import { createSignal } from 'solid-js';
import { onReconnect } from '../lib/sse.js';

/**
 * Piggybacks on the SSE reconnect signal (lib/sse.ts) — a container restart under
 * an open tab produces exactly one — to notice the server is now running a
 * different build than this tab loaded. Compares against the same `release` string
 * Sentry would tag events with on both sides: VITE_SENTRY_RELEASE is baked into
 * this bundle at build time, SENTRY_RELEASE is read live from GET /api/health. No
 * separate versioning scheme, and no extra polling loop.
 */

const [updateAvailable, setUpdateAvailable] = createSignal(false);
export { updateAvailable };

/** Hides the banner for this tab session; a later reconnect can re-flag it. */
export function dismissUpdateAvailable(): void {
  setUpdateAvailable(false);
}

async function checkForUpdate(): Promise<void> {
  const clientRelease = import.meta.env.VITE_SENTRY_RELEASE?.trim();
  if (!clientRelease) return; // not built with a release (local dev) — nothing to compare

  try {
    const res = await fetch('/api/health', { credentials: 'omit' }); // public + policy-only, no session needed
    if (!res.ok) return;
    const { release } = (await res.json()) as { release?: string | null };
    if (release && release !== clientRelease) setUpdateAvailable(true);
  } catch {
    // Transient network hiccup right after a reconnect — harmless, the next
    // reconnect checks again.
  }
}

onReconnect(() => void checkForUpdate());
