import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export interface AuthCodeEntry {
  clientId: string;
  redirectUri: string;
  state?: string;
  codeChallenge: string;
  userId: string;
  email: string;
  scopes: string[];
  expiresAt: number; // ms timestamp
}

export interface TokenEntry {
  userId: string;
  email: string;
  clientId: string;
  scopes: string[];
  expiresAt: number; // unix seconds
}

export interface RefreshEntry extends TokenEntry {
  /** The access token this refresh token was last paired with — rotated on each refresh. */
  pairedAccess: string;
}

interface PersistedStore {
  accessTokens: [string, TokenEntry][];
  refreshTokens: [string, RefreshEntry][];
}

export class FileTokenStore {
  private readonly filePath: string;
  private hydrated = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  readonly accessTokens = new Map<string, TokenEntry>();
  readonly refreshTokens = new Map<string, RefreshEntry>();

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  /** Load snapshot from disk on first use. */
  ensureHydrated(): void {
    if (this.hydrated) return;
    this.hydrated = true;

    if (!fs.existsSync(this.filePath)) return;

    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data: PersistedStore = JSON.parse(raw);

      const now = Math.floor(Date.now() / 1000);
      for (const [token, entry] of data.accessTokens ?? []) {
        if (entry.expiresAt > now) this.accessTokens.set(token, entry);
      }
      for (const [token, entry] of data.refreshTokens ?? []) {
        if (entry.expiresAt > now) this.refreshTokens.set(token, entry);
      }
    } catch {
      // Corrupt file — start fresh
    }
  }

  /** Schedule a debounced atomic write (500 ms). */
  persistSoon(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flush(), 500);
  }

  /** Immediately purge expired entries and write to disk atomically. */
  flush(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const [token, entry] of this.accessTokens) {
      if (entry.expiresAt <= now) this.accessTokens.delete(token);
    }
    for (const [token, entry] of this.refreshTokens) {
      if (entry.expiresAt <= now) this.refreshTokens.delete(token);
    }

    const data: PersistedStore = {
      accessTokens: [...this.accessTokens.entries()],
      refreshTokens: [...this.refreshTokens.entries()],
    };

    const tmp = this.filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
    try {
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  /** Mint a cryptographically random token string. */
  static randomToken(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  /** Purge all tokens associated with a user (logout). */
  revokeAllForUser(email: string): void {
    for (const [token, entry] of this.accessTokens) {
      if (entry.email === email) this.accessTokens.delete(token);
    }
    for (const [token, entry] of this.refreshTokens) {
      if (entry.email === email) this.refreshTokens.delete(token);
    }
    this.persistSoon();
  }
}
