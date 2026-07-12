import Router from '@koa/router';
import type Koa from 'koa';
import { currentScopes, currentOwnerId } from '../lib/context.js';
import { hasAdminScope } from '../lib/auth/scopes.js';
import { writeAudit } from '../lib/audit.js';
import { googleConfigState, saveGoogleConfig } from '../services/google-config.js';

/**
 * In-app Google connection setup — admin-gated, server-global (like /api/jobs: the
 * OAuth client is one per deployment, not per owner). GET returns the redacted state
 * (never the secret); PUT saves + hot-applies it (services/google-config.ts mutates
 * the config singleton, so the Connect button goes live without a restart).
 */

function requireAdmin(ctx: Koa.Context): boolean {
  if (hasAdminScope(currentScopes())) return true;
  ctx.status = 403;
  ctx.body = { error: 'forbidden' };
  return false;
}

export function googleConfigRouter() {
  const router = new Router();

  // GET /api/google-config — the redacted admin state (also the client's "am I admin?" probe).
  router.get('/api/google-config', (ctx) => {
    if (!requireAdmin(ctx)) return;
    ctx.body = googleConfigState();
  });

  // PUT /api/google-config — { client_id?, client_secret? (string | null), enabled }
  router.put('/api/google-config', (ctx) => {
    if (!requireAdmin(ctx)) return;
    const body = (ctx.request.body ?? {}) as {
      client_id?: unknown;
      client_secret?: unknown;
      enabled?: unknown;
    };
    if (typeof body.enabled !== 'boolean') {
      ctx.status = 400;
      ctx.body = { error: 'enabled (boolean) is required' };
      return;
    }
    if (body.client_id !== undefined && typeof body.client_id !== 'string') {
      ctx.status = 400;
      ctx.body = { error: 'client_id must be a string' };
      return;
    }
    if (body.client_secret !== undefined && body.client_secret !== null && typeof body.client_secret !== 'string') {
      ctx.status = 400;
      ctx.body = { error: 'client_secret must be a string or null' };
      return;
    }

    const res = saveGoogleConfig({
      clientId: body.client_id as string | undefined,
      clientSecret: body.client_secret as string | null | undefined,
      enabled: body.enabled,
    });
    if (!res.ok) {
      if (res.error === 'env_pinned') {
        ctx.status = 409;
        ctx.body = { error: 'GOOGLE_MODE is set in the server environment — the in-app setup is read-only' };
        return;
      }
      if (res.error === 'kek_required') {
        ctx.status = 400;
        ctx.body = { error: 'CP_KEK_B64 must be set on the server first (generate with: openssl rand -base64 32) — it encrypts the client secret and the OAuth tokens' };
        return;
      }
      ctx.status = 400;
      ctx.body = { error: 'client_id is required to enable the Google connection' };
      return;
    }

    writeAudit({ ownerId: currentOwnerId(), actor: 'owner', action: 'update', entity: 'google-config' });
    ctx.body = res.state;
  });

  return router;
}
