import crypto from 'crypto';
import type { RequestHandler, Response } from 'express';
import type {
  OAuthServerProvider,
  AuthorizationParams,
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
  AuthInfo,
} from './sdk';
import rateLimit from 'express-rate-limit';
import { findUserByEmail, verifyPassword } from '../services/authService';
import { FileTokenStore, type AuthCodeEntry } from './tokenStore';

// ---------------------------------------------------------------------------
// In-memory + file-persisted OAuth client registry (dynamic registration)
// ---------------------------------------------------------------------------
interface OAuthClient extends OAuthClientInformationFull {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method?: string;
}

class ClientRegistry {
  constructor(private readonly store: FileTokenStore) {}

  async getClient(clientId: string): Promise<OAuthClient | undefined> {
    this.store.ensureHydrated();
    return this.store.clients.get(clientId) as OAuthClient | undefined;
  }

  async registerClient(metadata: Omit<OAuthClient, 'client_id'>): Promise<OAuthClient> {
    this.store.ensureHydrated();
    const client: OAuthClient = {
      ...metadata,
      client_id: crypto.randomBytes(16).toString('base64url'),
    };
    this.store.clients.set(client.client_id, client as unknown as Record<string, unknown>);
    this.store.persistSoon();
    return client;
  }
}

// ---------------------------------------------------------------------------
// OAuth 2.1 Provider
// ---------------------------------------------------------------------------
class FinanceOAuthProvider implements OAuthServerProvider {
  private readonly authCodes = new Map<string, AuthCodeEntry>();
  private readonly store: FileTokenStore;
  readonly clientsStore: ClientRegistry;

  constructor() {
    this.store = new FileTokenStore(
      process.env.MCP_TOKEN_STORE_PATH ?? '.mcp-token-store.json'
    );
    this.clientsStore = new ClientRegistry(this.store);

    // Periodic cleanup every 30 minutes
    setInterval(() => this.store.flush(), 30 * 60 * 1000).unref();
  }

  // Called by mcpAuthRouter for GET /authorize — render the login form.
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response
  ): Promise<void> {
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'");
    res.setHeader('X-Frame-Options', 'DENY');
    res.send(
      renderLoginForm({
        clientId: (client as OAuthClient).client_id,
        redirectUri: params.redirectUri ?? '',
        state: params.state ?? '',
        codeChallenge: params.codeChallenge ?? '',
      })
    );
  }

  // SDK calls this during POST /token to verify PKCE.
  async challengeForAuthorizationCode(
    _client: OAuthClientInformationFull,
    code: string
  ): Promise<string> {
    const entry = this.authCodes.get(code);
    if (!entry) throw new Error('Invalid authorization code');
    return entry.codeChallenge;
  }

  // POST /token — authorization_code grant.
  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    code: string
  ): Promise<OAuthTokens> {
    const entry = this.authCodes.get(code);
    if (!entry) throw new Error('Invalid or already-used authorization code');
    if (Date.now() > entry.expiresAt) {
      this.authCodes.delete(code);
      throw new Error('Authorization code expired');
    }
    if (entry.clientId !== (client as OAuthClient).client_id)
      throw new Error('Client mismatch');

    this.authCodes.delete(code); // one-time use

    this.store.ensureHydrated();
    const access = FileTokenStore.randomToken();
    const refresh = FileTokenStore.randomToken();
    const nowSec = Math.floor(Date.now() / 1000);

    this.store.accessTokens.set(access, {
      userId: entry.userId,
      email: entry.email,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: nowSec + 3600, // 1 hour
    });
    this.store.refreshTokens.set(refresh, {
      userId: entry.userId,
      email: entry.email,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: nowSec + 30 * 24 * 3600, // 30 days
      pairedAccess: access,
    });
    this.store.persistSoon();

    return {
      access_token: access,
      refresh_token: refresh,
      token_type: 'bearer',
      expires_in: 3600,
      scope: entry.scopes.join(' '),
    };
  }

  // POST /token — refresh_token grant. Rotates refresh token each time.
  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    _scopes?: string[]
  ): Promise<OAuthTokens> {
    this.store.ensureHydrated();
    const entry = this.store.refreshTokens.get(refreshToken);
    const nowSec = Math.floor(Date.now() / 1000);

    if (!entry) throw new Error('Invalid refresh token');
    if (entry.expiresAt <= nowSec) {
      this.store.refreshTokens.delete(refreshToken);
      this.store.persistSoon();
      throw new Error('Refresh token expired');
    }
    if (entry.clientId !== (client as OAuthClient).client_id)
      throw new Error('Client mismatch');

    // Rotate: delete old access + refresh, issue new pair
    this.store.accessTokens.delete(entry.pairedAccess);
    this.store.refreshTokens.delete(refreshToken);

    const newAccess = FileTokenStore.randomToken();
    const newRefresh = FileTokenStore.randomToken();

    this.store.accessTokens.set(newAccess, {
      userId: entry.userId,
      email: entry.email,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: nowSec + 3600,
    });
    this.store.refreshTokens.set(newRefresh, {
      userId: entry.userId,
      email: entry.email,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: entry.expiresAt, // keep original expiry
      pairedAccess: newAccess,
    });
    this.store.persistSoon();

    return {
      access_token: newAccess,
      refresh_token: newRefresh,
      token_type: 'bearer',
      expires_in: 3600,
      scope: entry.scopes.join(' '),
    };
  }

  // Called by requireBearerAuth on every /mcp request.
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    this.store.ensureHydrated();
    const entry = this.store.accessTokens.get(token);
    if (!entry) throw new Error('Invalid access token');

    const nowSec = Math.floor(Date.now() / 1000);
    if (entry.expiresAt <= nowSec) {
      this.store.accessTokens.delete(token);
      this.store.persistSoon();
      throw new Error('Access token expired');
    }

    return {
      token,
      clientId: entry.clientId,
      scopes: entry.scopes,
      expiresAt: entry.expiresAt,
      extra: { userId: entry.userId, email: entry.email },
    };
  }

  async revokeToken(
    _client: OAuthClientInformationFull,
    req: OAuthTokenRevocationRequest
  ): Promise<void> {
    this.store.ensureHydrated();
    this.store.accessTokens.delete(req.token);
    this.store.refreshTokens.delete(req.token);
    this.store.persistSoon();
  }

  /** Mint a one-time auth code after successful password verification. */
  issueCode(params: Omit<AuthCodeEntry, 'scopes' | 'expiresAt'>): string {
    const code = FileTokenStore.randomToken();
    this.authCodes.set(code, {
      ...params,
      scopes: ['read'],
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 min
    });

    // Clean up expired auth codes
    for (const [c, e] of this.authCodes) {
      if (Date.now() > e.expiresAt) this.authCodes.delete(c);
    }

    return code;
  }

  /**
   * Mint a long-lived access token directly (no PKCE).
   * Used by the /auth manual token page.
   * Returns { accessToken, expiresAt (unix seconds) }.
   */
  mintAccessToken(userId: string, email: string): { accessToken: string; expiresAt: number } {
    this.store.ensureHydrated();
    const access = FileTokenStore.randomToken();
    const nowSec = Math.floor(Date.now() / 1000);
    const expiresAt = nowSec + 30 * 24 * 3600; // 30 days for manual tokens

    this.store.accessTokens.set(access, {
      userId,
      email,
      clientId: 'manual',
      scopes: ['read'],
      expiresAt,
    });
    this.store.persistSoon();
    return { accessToken: access, expiresAt };
  }
}

export const oauthProvider = new FinanceOAuthProvider();

// ---------------------------------------------------------------------------
// Login form renderer
// ---------------------------------------------------------------------------
function renderLoginForm(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const { clientId, redirectUri, state, codeChallenge } = params;
  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Finance Dashboard — MCP Login</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 50%, #0f172a 100%);
      font-family: 'Inter', system-ui, -apple-system, sans-serif;
    }
    .card {
      background: rgba(255,255,255,0.05);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 16px;
      padding: 40px;
      width: 100%;
      max-width: 420px;
      backdrop-filter: blur(20px);
      box-shadow: 0 25px 50px rgba(0,0,0,0.5);
    }
    .logo { text-align: center; margin-bottom: 8px; font-size: 32px; }
    h1 {
      color: #f1f5f9;
      font-size: 22px;
      font-weight: 600;
      text-align: center;
      margin-bottom: 6px;
    }
    .subtitle {
      color: #94a3b8;
      font-size: 13px;
      text-align: center;
      margin-bottom: 32px;
    }
    label { display: block; color: #cbd5e1; font-size: 13px; margin-bottom: 6px; }
    input[type="email"], input[type="password"] {
      width: 100%;
      padding: 11px 14px;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,0.15);
      background: rgba(255,255,255,0.07);
      color: #f1f5f9;
      font-size: 14px;
      margin-bottom: 20px;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="email"]:focus, input[type="password"]:focus {
      border-color: #6366f1;
    }
    button {
      width: 100%;
      padding: 12px;
      border-radius: 8px;
      border: none;
      background: linear-gradient(90deg, #6366f1, #8b5cf6);
      color: #fff;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      transition: opacity 0.2s;
      margin-top: 4px;
    }
    button:hover { opacity: 0.88; }
    .error-msg {
      background: rgba(239,68,68,0.15);
      border: 1px solid rgba(239,68,68,0.4);
      color: #fca5a5;
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 13px;
      margin-bottom: 20px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: rgba(99,102,241,0.15);
      border: 1px solid rgba(99,102,241,0.3);
      border-radius: 20px;
      padding: 4px 12px;
      font-size: 11px;
      color: #a5b4fc;
      margin: 0 auto 28px;
      display: table;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">📊</div>
    <h1>Finance Dashboard</h1>
    <p class="subtitle">MCP Server — Secure Login</p>
    <div class="badge">🔒 Read-only access</div>

    <form method="POST" action="/oauth/login">
      <input type="hidden" name="client_id"      value="${escape(clientId)}">
      <input type="hidden" name="redirect_uri"   value="${escape(redirectUri)}">
      <input type="hidden" name="state"          value="${escape(state)}">
      <input type="hidden" name="code_challenge" value="${escape(codeChallenge)}">

      <label for="mcp-email">Email</label>
      <input type="email"    id="mcp-email"    name="email"    required autocomplete="email"    placeholder="you@example.com">

      <label for="mcp-password">Password</label>
      <input type="password" id="mcp-password" name="password" required autocomplete="current-password" placeholder="••••••••">

      <button type="submit">Sign In →</button>
    </form>
  </div>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Login handler — POST /oauth/login
// ---------------------------------------------------------------------------
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again in 15 minutes.' },
});

function exactMatchOrLoopbackRelax(registered: string, incoming: string): boolean {
  if (registered === incoming) return true;
  try {
    const r = new URL(registered);
    const i = new URL(incoming);
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(r.hostname);
    if (isLoopback && r.hostname === i.hostname && r.pathname === i.pathname) return true;
  } catch { /* ignore parse errors */ }
  return false;
}

export const loginHandler: RequestHandler = async (req, res) => {
  const { email, password, client_id, redirect_uri, state, code_challenge } =
    req.body as Record<string, string>;

  const rerender = (errorMsg: string) => {
    res.status(400).setHeader('Content-Security-Policy', "default-src 'self'; style-src 'unsafe-inline'");
    res.send(
      renderLoginForm({ clientId: client_id ?? '', redirectUri: redirect_uri ?? '', state: state ?? '', codeChallenge: code_challenge ?? '' })
        .replace('</form>', `<div class="error-msg">${errorMsg}</div></form>`)
    );
  };

  // 1. Presence check
  if (!email || !password || !client_id || !redirect_uri || !code_challenge) {
    return rerender('All fields are required.');
  }

  // 2. Anti open-redirect: validate redirect_uri against registered client
  const client = await oauthProvider.clientsStore.getClient(client_id);
  if (!client) return res.status(400).send('Unknown client_id');

  const redirectOk = client.redirect_uris.some((r) =>
    exactMatchOrLoopbackRelax(r, redirect_uri)
  );
  if (!redirectOk) return res.status(400).send('Invalid redirect_uri');

  // 3. Verify credentials against the existing auth service (bcrypt)
  const user = await findUserByEmail(email).catch(() => null);
  if (!user || !user.password || !user.isActive) {
    return rerender('Invalid email or password.');
  }

  const isValid = await verifyPassword(password, user.password).catch(() => false);
  if (!isValid) return rerender('Invalid email or password.');

  // 4. Mint one-time auth code
  const code = oauthProvider.issueCode({
    clientId: client_id,
    redirectUri: redirect_uri,
    state,
    codeChallenge: code_challenge,
    userId: String(user.id),
    email: user.email,
  });

  // 5. Redirect back to client
  const callbackUrl = new URL(redirect_uri);
  callbackUrl.searchParams.set('code', code);
  if (state) callbackUrl.searchParams.set('state', state);
  return res.redirect(302, callbackUrl.toString());
};
