import webpush from 'web-push';
import { config } from './config.js';
import { logger } from './logger.js';

/** A stored Web Push subscription in the shape `web-push` expects. */
export interface PushSub {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

let configured = false;
/** Lazily wire VAPID details once; false when keys are absent (push disabled). */
function ensureConfigured(): boolean {
  if (configured) return true;
  if (!config.vapidPublicKey || !config.vapidPrivateKey) return false;
  webpush.setVapidDetails(config.vapidSubject, config.vapidPublicKey, config.vapidPrivateKey);
  configured = true;
  return true;
}

/** True when VAPID keys are present, so callers can advertise/enable push. */
export function pushEnabled(): boolean {
  return !!(config.vapidPublicKey && config.vapidPrivateKey);
}

/**
 * Send a single push. Returns:
 *  - `'ok'`   delivered to the push service;
 *  - `'gone'` the subscription is dead (404/410) — caller deletes the row;
 *  - `'fail'` transient error or push disabled — already delivered in-app via SSE.
 */
export async function sendPush(sub: PushSub, payload: object): Promise<'ok' | 'gone' | 'fail'> {
  if (!ensureConfigured()) return 'fail';
  try {
    await webpush.sendNotification(sub, JSON.stringify(payload));
    return 'ok';
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode;
    if (code === 404 || code === 410) return 'gone';
    logger.warn('Web Push send failed', { code });
    return 'fail';
  }
}
