import cors from 'cors';
import { Router } from 'express';
import { StreamableHTTPServerTransport, requireBearerAuth } from './sdk';
import { oauthProvider } from './oauthProvider';
import { createMcpServer } from './financeTools';

const router = Router();

router.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'mcp-session-id'],
  })
);

// Every request must carry a valid Bearer access token.
// The SDK calls oauthProvider.verifyAccessToken(token) under the hood.
router.use(requireBearerAuth({ verifier: oauthProvider }));

router.all('/', async (req, res) => {
  const transport = new StreamableHTTPServerTransport({
    // undefined = stateless mode (new server per HTTP request)
    // Simplest to run behind a load balancer.
    sessionIdGenerator: undefined,
  });

  const server = createMcpServer();
  res.on('finish', () => server.close().catch(() => {}));

  try {
    await server.connect(transport);
    await transport.handleRequest(req as any, res as any, req.body);
  } catch {
    if (!res.headersSent) res.status(500).json({ error: 'MCP handler error' });
  }
});

export default router;
