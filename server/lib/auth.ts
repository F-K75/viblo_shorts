// Server-side identity. The server NEVER trusts a client-supplied user id.
// Accepted credentials (Authorization: Bearer <token>):
//   1. Firebase ID tokens (RS256 JWT) — verified against Google's securetoken certs.
//   2. Server-signed guest tokens — HMAC-SHA256 with SESSION_SECRET.
import crypto from 'crypto';
import fs from 'fs';

export interface AuthIdentity {
  userId: string;
  kind: 'firebase' | 'guest';
  email?: string;
  isAdmin: boolean;
}

const GUEST_TTL_SECONDS = 30 * 24 * 3600;
const FIREBASE_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

const b64url = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');
const fromB64url = (s: string) => Buffer.from(s, 'base64url');
/**
 * D6: exactly one accepted spelling per token part. Node's base64url decoder is lenient (it ignores the unused bits of
 * the last character and accepts '=' padding, the standard alphabet and stray characters), so many strings decode to
 * the same bytes. A part is accepted only if it uses the URL-safe alphabet without padding and equals the canonical
 * re-encoding of its own bytes.
 */
const isCanonicalB64url = (s: string) => /^[A-Za-z0-9_-]+$/.test(s) && b64url(fromB64url(s)) === s;

export class AuthService {
  private certCache: { certs: Record<string, string>; expiresAt: number } | null = null;

  constructor(
    private readonly secret: string,
    private readonly firebaseProjectId: string | undefined,
    private readonly adminIds: Set<string> = new Set(),
    private readonly certsOverrideFile?: string,
  ) {
    if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters');
  }

  // ---------- guest tokens ----------
  issueGuestToken(now = Date.now()): { token: string; userId: string; expiresAt: string } {
    const userId = `guest_${crypto.randomBytes(16).toString('hex')}`;
    const iat = Math.floor(now / 1000);
    const payload = { sub: userId, iat, exp: iat + GUEST_TTL_SECONDS };
    const body = b64url(JSON.stringify(payload));
    const sig = b64url(crypto.createHmac('sha256', this.secret).update(`guest.${body}`).digest());
    return { token: `guest.${body}.${sig}`, userId, expiresAt: new Date(payload.exp * 1000).toISOString() };
  }

  verifyGuestToken(token: string, now = Date.now()): AuthIdentity | null {
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== 'guest') return null;
    if (!isCanonicalB64url(parts[1]) || !isCanonicalB64url(parts[2])) return null; // D6: one representation only
    const expected = crypto.createHmac('sha256', this.secret).update(`guest.${parts[1]}`).digest();
    const given = fromB64url(parts[2]);
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    try {
      const payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
      if (typeof payload.sub !== 'string' || !/^guest_[a-f0-9]{32}$/.test(payload.sub)) return null;
      if (typeof payload.exp !== 'number' || payload.exp * 1000 < now) return null;
      return { userId: payload.sub, kind: 'guest', isAdmin: false };
    } catch {
      return null;
    }
  }

  // ---------- firebase ID tokens ----------
  private async getCerts(): Promise<Record<string, string>> {
    if (this.certsOverrideFile) {
      return JSON.parse(fs.readFileSync(this.certsOverrideFile, 'utf8'));
    }
    if (this.certCache && this.certCache.expiresAt > Date.now()) return this.certCache.certs;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    try {
      const resp = await fetch(FIREBASE_CERTS_URL, { signal: ctrl.signal });
      if (!resp.ok) throw new Error(`cert fetch failed: ${resp.status}`);
      const certs = (await resp.json()) as Record<string, string>;
      const maxAge = Number(/max-age=(\d+)/.exec(resp.headers.get('cache-control') || '')?.[1] || 3600);
      this.certCache = { certs, expiresAt: Date.now() + maxAge * 1000 };
      return certs;
    } finally {
      clearTimeout(t);
    }
  }

  async verifyFirebaseToken(token: string, now = Date.now()): Promise<AuthIdentity | null> {
    if (!this.firebaseProjectId) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    let header: any;
    let payload: any;
    try {
      header = JSON.parse(fromB64url(parts[0]).toString('utf8'));
      payload = JSON.parse(fromB64url(parts[1]).toString('utf8'));
    } catch {
      return null;
    }
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
    const certs = await this.getCerts();
    const pem = certs[header.kid];
    if (!pem) return null;
    const ok = crypto
      .createVerify('RSA-SHA256')
      .update(`${parts[0]}.${parts[1]}`)
      .verify(pem, fromB64url(parts[2]));
    if (!ok) return null;
    const nowS = Math.floor(now / 1000);
    const skew = 60;
    if (payload.aud !== this.firebaseProjectId) return null;
    if (payload.iss !== `https://securetoken.google.com/${this.firebaseProjectId}`) return null;
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 128) return null;
    if (typeof payload.exp !== 'number' || payload.exp + skew < nowS) return null;
    if (typeof payload.iat !== 'number' || payload.iat - skew > nowS) return null;
    return {
      userId: payload.sub,
      kind: 'firebase',
      email: typeof payload.email === 'string' ? payload.email : undefined,
      isAdmin: this.adminIds.has(payload.sub),
    };
  }

  async authenticate(authorizationHeader: string | undefined): Promise<AuthIdentity | null> {
    if (!authorizationHeader) return null;
    const m = /^Bearer\s+(\S+)$/i.exec(authorizationHeader.trim());
    if (!m) return null;
    const token = m[1];
    if (token.startsWith('guest.')) return this.verifyGuestToken(token);
    try {
      return await this.verifyFirebaseToken(token);
    } catch (err: any) {
      console.warn('[Auth] Firebase token verification error:', err?.message || err);
      return null;
    }
  }
}

/** Resolves the HMAC secret: env in production (required), persisted random secret in dev/test. */
export function resolveSessionSecret(dataDir: string, isProduction: boolean): string {
  const fromEnv = process.env.SESSION_SECRET?.trim();
  if (fromEnv) return fromEnv;
  if (isProduction) {
    throw new Error('SESSION_SECRET environment variable is required in production (>= 32 chars).');
  }
  const file = `${dataDir}/.session_secret`;
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // create below
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}
