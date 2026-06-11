import Router from '@koa/router';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { mcpServer } from '../mcp-server.js';
import { logger } from '../lib/logger.js';

const activeTransports = new Map<string, SSEServerTransport>();

export function mcpRouter() {
  const router = new Router();

  // GET /api/mcp - Establish SSE connection
  router.get('/api/mcp', async (ctx) => {
    logger.info('New MCP SSE client connection request');

    // Bypass Koa response handling to allow the SDK to manage the SSE stream
    ctx.respond = false;

    const transport = new SSEServerTransport('/api/mcp/message', ctx.res);
    activeTransports.set(transport.sessionId, transport);

    transport.onclose = () => {
      logger.info('MCP SSE client connection closed', { sessionId: transport.sessionId });
      activeTransports.delete(transport.sessionId);
    };

    try {
      // Connect the transport to the server (this calls transport.start() under the hood)
      await mcpServer.connect(transport);
      logger.info('MCP SSE transport connected', { sessionId: transport.sessionId });
    } catch (err) {
      logger.error('Failed to connect MCP SSE transport', { err: (err as Error).message });
      activeTransports.delete(transport.sessionId);
    }
  });

  // POST /api/mcp/message - Handle messages from the client
  router.post('/api/mcp/message', async (ctx) => {
    const sessionId = ctx.query.sessionId as string;
    if (!sessionId) {
      ctx.status = 400;
      ctx.body = { error: 'sessionId is required' };
      return;
    }

    const transport = activeTransports.get(sessionId);
    if (!transport) {
      ctx.status = 404;
      ctx.body = { error: 'Session not found or expired' };
      return;
    }

    try {
      // koa-bodyparser parses json and puts it in ctx.request.body
      await transport.handlePostMessage(ctx.req, ctx.res, ctx.request.body);
    } catch (err) {
      logger.error('Failed to handle MCP post message', { sessionId, err: (err as Error).message });
      ctx.status = 500;
      ctx.body = { error: 'Internal server error processing message' };
    }
  });

  return router;
}
