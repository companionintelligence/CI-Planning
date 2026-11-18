import { Browser } from '@capacitor/browser';
import { ApiError, api } from './api.js';
import { isCapacitorShell } from './server-config.js';

const CALLBACK_SCHEME = 'com.companionintelligence.planning:';
const PENDING_KEY = 'ci-planning.native-portal-login';
const TTL_MS = 10 * 60 * 1000;
let handlingCallback = false;

interface PendingLogin { verifier: string; returnPath: string; expiresAt: number }

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function validReturnPath(value: string): string {
  if (value.length > 1024 || !value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  return value;
}

function readPending(): PendingLogin | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(PENDING_KEY) ?? 'null') as Partial<PendingLogin> | null;
    if (!parsed || typeof parsed.verifier !== 'string' || typeof parsed.returnPath !== 'string' || typeof parsed.expiresAt !== 'number') return null;
    return { verifier: parsed.verifier, returnPath: validReturnPath(parsed.returnPath), expiresAt: parsed.expiresAt };
  } catch { return null; }
}

function clearPending(): void {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* unavailable */ }
}

/** Open the Portal in the system browser; only the S256 challenge leaves the app. */
export async function beginNativePortalLogin(startUrl: string, returnPath: string): Promise<void> {
  if (!isCapacitorShell()) throw new Error('Native Portal sign-in is available only in the mobile app');
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  const pending: PendingLogin = { verifier, returnPath: validReturnPath(returnPath), expiresAt: Date.now() + TTL_MS };
  localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  const url = new URL(startUrl, window.location.origin);
  url.searchParams.set('native_code_challenge', challenge);
  try {
    await Browser.open({ url: url.toString(), presentationStyle: 'popover' });
  } catch (error) {
    clearPending();
    throw error;
  }
}

/** Consume only the app's registered callback URI and redeem its one-time ticket. */
export async function handleNativePortalCallback(rawUrl: string): Promise<boolean> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return false; }
  if (url.protocol !== CALLBACK_SCHEME || url.hostname !== 'auth' || url.pathname !== '/callback') return false;
  if (handlingCallback) return true;
  handlingCallback = true;
  const pending = readPending();
  try { await Browser.close(); } catch { /* Browser may already be closed by the OS. */ }

  if (url.searchParams.has('error')) {
    const err = url.searchParams.get('error');
    clearPending();
    const ssoError = err === 'hub_access_denied' ? 'access_denied'
      : err === 'cancelled' ? 'cancelled'
        : err === 'unknown_account' ? 'unknown_account'
          : err === 'account_unavailable' ? 'account_unavailable'
            : err === 'failed' ? 'mobile_handoff_failed'
              : 'confirmation_expired';
    window.location.assign(`/login?sso_error=${encodeURIComponent(ssoError)}`);
    return true;
  }
  const ticket = url.searchParams.get('ticket');
  if (!ticket || !pending || pending.expiresAt <= Date.now()) {
    clearPending();
    window.location.assign('/login?sso_error=confirmation_expired');
    return true;
  }
  try {
    await api.auth.mobileComplete(ticket, pending.verifier);
    clearPending();
    window.location.assign(pending.returnPath);
  } catch (error) {
    // The server may have consumed the ticket and set the native cookie even if the
    // response was interrupted. Check the cookie-backed session before giving up.
    try {
      await api.auth.me();
      clearPending();
      window.location.assign(pending.returnPath);
      return true;
    } catch { /* no established session */ }
    clearPending();
    const ssoError = error instanceof ApiError && error.status === 410 ? 'confirmation_expired' : 'mobile_handoff_failed';
    window.location.assign(`/login?sso_error=${ssoError}`);
  }
  return true;
}
