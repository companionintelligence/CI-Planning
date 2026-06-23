import Router from '@koa/router';
import { status } from '../mcp/ollama.js';
import { createGoogleClient } from '../mcp/google.js';
import { pushEnabled } from '../lib/push.js';

export function llmRouter() {
  const router = new Router();

  // GET /api/llm/status — Ollama health + installed models
  router.get('/api/llm/status', async (ctx) => {
    ctx.body = await status();
  });

  // GET /api/integrations — connection status for Ollama + Google MCP
  router.get('/api/integrations', async (ctx) => {
    const ollama = await status();
    const google = createGoogleClient();
    ctx.body = {
      ollama: {
        available: ollama.available,
        models: ollama.models,
        smallModel: ollama.smallModel,
        mediumModel: ollama.mediumModel,
        embedModel: ollama.embedModel,
      },
      google: { mode: google.mode },
      // Phase H: whether Web Push can actually deliver (VAPID keys present). In-app
      // SSE reminders work regardless; this lets the client/diagnostics show push status.
      push: { configured: pushEnabled() },
    };
  });

  return router;
}
