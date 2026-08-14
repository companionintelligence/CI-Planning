import Router from '@koa/router';
import { status } from '../mcp/ollama.js';
import { config } from '../lib/config.js';
import { pushEnabled } from '../lib/push.js';
import { connectionHealth } from '../lib/connections.js';
import { currentOwnerId } from '../lib/context.js';

export function llmRouter() {
  const router = new Router();

  // GET /api/llm/status — Ollama health + installed models
  router.get('/api/llm/status', async (ctx) => {
    ctx.body = await status();
  });

  // GET /api/integrations — connection status for Ollama + Google MCP
  router.get('/api/integrations', async (ctx) => {
    const ollama = await status();
    ctx.body = {
      ollama: {
        // `available` = Ollama answered. `ready` = the models that will actually be used
        // are pulled; the client gates AI surfaces on `ready`, because a reachable Ollama
        // with an un-pulled model produced a green light over dead features.
        available: ollama.available,
        ready: ollama.ready,
        models: ollama.models,
        fastModel: ollama.fastModel,
        qualityModel: ollama.qualityModel,
        embedModel: ollama.embedModel,
        missingModels: ollama.missingModels,
        // How each pick was chosen, plus cautions about the AUTO-selected ones. A model
        // the app guessed reads identically to one the operator chose without this —
        // which is how a 1B vision model drove tagging on a real install unnoticed.
        modelSources: ollama.modelSources,
        modelWarnings: ollama.modelWarnings,
      },
      // WP7: widen the google block with the live toggle + read-only connection
      // health (one entry per connected account; [] when none). connectionHealth
      // never throws on a bad token row, so this can't 500 the endpoint.
      // Mode comes from config, not a client instance — createGoogleClient() throws in
      // 'off' mode (fixture must never be handed out silently), and this endpoint must
      // keep reporting status even when the integration is off. `source` says where the
      // mode came from: 'env' (GOOGLE_MODE pinned), 'app' (in-app Settings setup), or
      // 'off' (neither) — the Settings card words its states off this.
      google: {
        mode: config.google.mode,
        liveEnabled: config.google.mode === 'live',
        source: config.pins.google ? 'env' : config.google.mode === 'live' ? 'app' : 'off',
        connections: await connectionHealth(currentOwnerId()),
      },
      // Phase H: whether Web Push can actually deliver (VAPID keys present). In-app
      // SSE reminders work regardless; this lets the client/diagnostics show push status.
      push: { configured: pushEnabled() },
    };
  });

  return router;
}
