/**
 * @modelcontextprotocol/sdk only exposes its deep subpaths through a wildcard
 * export ("./*" -> "./dist/cjs/*"), so Node's real module resolution needs
 * the literal ".js" filename — it won't guess the extension. That quirk is
 * isolated to this one file; everywhere else imports from here instead.
 */
export { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
export { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
export { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
export { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
export type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
export type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
export type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
