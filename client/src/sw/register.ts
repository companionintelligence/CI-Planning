import { isNativeShell } from '../lib/server-config.js';

/**
 * Register the service worker once, after the app mounts. Never throws — the app
 * must run fully even when service workers / Push are unsupported or registration
 * fails (e.g. private mode, insecure context). Push permission is requested later,
 * opt-in, from Settings (Phase H PR3) — registering the SW here does not prompt.
 */
export async function registerSW(): Promise<void> {
  // The Capacitor shell serves the bundle from the app itself, not from the user's
  // server, and web push has no route to a native app. Nothing to register.
  if (isNativeShell()) return;
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (e) {
    console.warn('Service worker registration failed', e);
  }
}
