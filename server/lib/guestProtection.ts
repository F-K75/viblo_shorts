// Track A (R-03): guest registration protection.
//
//  * Cloudflare Turnstile, verified server-side (siteverify) with a hard timeout. Each token is checked for success,
//    allowed hostname, action === "guest_mint" and age. The secret goes only to siteverify; it is never logged,
//    returned or exposed in diagnostics.
//  * Tokens are single-use across all instances: the server redeems sha256(token) atomically in the Repo BEFORE asking
//    the provider, so a replay is refused even if the provider would accept it.
//  * Budgets per device (cookie), per IP, per IPv4 /24 and per IPv6 /48, all-or-nothing in the Repo (cross-instance).
//  * Device cookie __Host-fs_dev: 128-bit random, opaque, Secure, HttpOnly, SameSite=Lax, Path=/, no Domain, 1 year.
//    Only sha256(value) is used as a key; nothing is derived from the IP, the user agent or the user.
//  * A provider outage pauses NEW guest registrations only (503 captcha_unavailable). Nothing else calls the provider,
//    so existing guest sessions and signed-in users are unaffected by construction.
import crypto from 'crypto';
import net from 'net';

export const DEVICE_COOKIE = '__Host-fs_dev';
export const DEVICE_COOKIE_MAX_AGE_S = 365 * 24 * 3600;
export const TURNSTILE_ACTION = 'guest_mint';
export const DEFAULT_TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

export const sha256Hex = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

// ---------------- configuration ----------------
export interface CaptchaConfig {
  required: boolean;
  secret: string;
  siteKey: string;
  hostnames: string[];
  verifyUrl: string;
  timeoutMs: number;
  maxTokenAgeS: number;
}

/**
 * CAPTCHA settings. Production requires Turnstile unless CAPTCHA_REQUIRED=false is set explicitly (loud warning).
 * Elsewhere it is on when TURNSTILE_SECRET is set (or CAPTCHA_REQUIRED=true). In production the verify URL must be
 * HTTPS, so a test stub can never be selected there.
 */
export function parseCaptchaConfig(env: NodeJS.ProcessEnv, isProd: boolean): { ok: true; config: CaptchaConfig } | { ok: false; error: string } {
  const flag = (env.CAPTCHA_REQUIRED ?? '').trim().toLowerCase();
  if (flag && !['true', 'false', '1', '0'].includes(flag)) return { ok: false, error: `CAPTCHA_REQUIRED must be "true" or "false" (got "${flag.slice(0, 20)}").` };
  const secret = (env.TURNSTILE_SECRET ?? '').trim();
  const required = flag ? flag === 'true' || flag === '1' : isProd || Boolean(secret);
  const siteKey = (env.TURNSTILE_SITE_KEY ?? '').trim();
  const hostnames = (env.TURNSTILE_HOSTNAMES ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  const verifyUrl = (env.TURNSTILE_VERIFY_URL ?? '').trim() || DEFAULT_TURNSTILE_VERIFY_URL;
  const timeoutMs = Number(env.TURNSTILE_TIMEOUT_MS || 3000);
  const maxTokenAgeS = Number(env.TURNSTILE_MAX_TOKEN_AGE_S || 300);
  const config: CaptchaConfig = { required, secret, siteKey, hostnames, verifyUrl, timeoutMs, maxTokenAgeS };
  if (!required) return { ok: true, config };
  if (!secret) return { ok: false, error: 'TURNSTILE_SECRET is required while CAPTCHA is required (production default). Set it from the Cloudflare Turnstile widget, or set CAPTCHA_REQUIRED=false to run without CAPTCHA (not recommended).' };
  if (!siteKey) return { ok: false, error: 'TURNSTILE_SITE_KEY is required while CAPTCHA is required (it is served to the browser via /api/config).' };
  if (isProd && hostnames.length === 0) return { ok: false, error: 'TURNSTILE_HOSTNAMES is required in production: the hostnames tokens must have been issued for (e.g. app.example.com).' };
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) return { ok: false, error: 'TURNSTILE_TIMEOUT_MS must be between 100 and 30000.' };
  if (!Number.isFinite(maxTokenAgeS) || maxTokenAgeS < 10 || maxTokenAgeS > 300) return { ok: false, error: 'TURNSTILE_MAX_TOKEN_AGE_S must be between 10 and 300 (Turnstile tokens are valid for 300 s).' };
  let parsed: URL;
  try {
    parsed = new URL(verifyUrl);
  } catch {
    return { ok: false, error: 'TURNSTILE_VERIFY_URL is not a valid URL.' };
  }
  if (isProd && parsed.protocol !== 'https:') return { ok: false, error: 'TURNSTILE_VERIFY_URL must be an https:// URL in production (test stubs are not allowed there).' };
  return { ok: true, config };
}

// ---------------- verification ----------------
export type CaptchaFailure = 'invalid' | 'hostname' | 'action' | 'expired';
export class CaptchaUnavailableError extends Error {
  constructor(readonly reason: string) {
    super(`captcha provider unavailable: ${reason}`);
  }
}
export interface CaptchaVerifier {
  /** ok, or a failure the user caused; throws CaptchaUnavailableError when the provider cannot give an answer. */
  verify(token: string, remoteIp: string | undefined): Promise<{ ok: true } | { ok: false; reason: CaptchaFailure }>;
}

/** Errors that mean OUR configuration is wrong, not the user's token: treated as an outage (503 + alert), never 403. */
const CONFIG_ERRORS = new Set(['missing-input-secret', 'invalid-input-secret', 'internal-error']);

export class TurnstileVerifier implements CaptchaVerifier {
  constructor(private readonly cfg: CaptchaConfig) {}
  async verify(token: string, remoteIp: string | undefined) {
    const form = new URLSearchParams({ secret: this.cfg.secret, response: token });
    if (remoteIp && remoteIp !== 'unknown') form.set('remoteip', remoteIp);
    let resp: Response;
    try {
      resp = await fetch(this.cfg.verifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
    } catch (err: any) {
      throw new CaptchaUnavailableError(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'unreachable');
    }
    if (!resp.ok) {
      await resp.body?.cancel().catch(() => {});
      throw new CaptchaUnavailableError(`http_${resp.status}`);
    }
    let body: any;
    try {
      body = await resp.json();
    } catch (err: any) {
      throw new CaptchaUnavailableError(err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'malformed');
    }
    if (!body || typeof body !== 'object' || typeof body.success !== 'boolean') throw new CaptchaUnavailableError('malformed');
    const codes: string[] = Array.isArray(body['error-codes']) ? body['error-codes'].map(String) : [];
    if (!body.success) {
      if (codes.some((c) => CONFIG_ERRORS.has(c))) throw new CaptchaUnavailableError(`provider_${codes.find((c) => CONFIG_ERRORS.has(c))}`);
      return { ok: false as const, reason: codes.includes('timeout-or-duplicate') ? ('expired' as const) : ('invalid' as const) };
    }
    if (this.cfg.hostnames.length && !this.cfg.hostnames.includes(String(body.hostname || '').toLowerCase())) return { ok: false as const, reason: 'hostname' as const };
    if (body.action !== TURNSTILE_ACTION) return { ok: false as const, reason: 'action' as const };
    const issued = Date.parse(String(body.challenge_ts || ''));
    if (!Number.isFinite(issued) || Date.now() - issued > this.cfg.maxTokenAgeS * 1000) return { ok: false as const, reason: 'expired' as const };
    return { ok: true as const };
  }
}

// ---------------- addresses ----------------
/** Canonical client address: IPv4-mapped IPv6 (::ffff:a.b.c.d) becomes plain IPv4; IPv6 is fully expanded, lower case. */
export function normalizeIp(raw: string | undefined): string {
  let ip = (raw || '').trim();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) ip = mapped[1];
  if (net.isIPv4(ip)) return ip;
  if (net.isIPv6(ip)) return expandIPv6(ip.split('%')[0]);
  return 'unknown';
}
function expandIPv6(ip: string): string {
  let s = ip;
  let tail: string[] = [];
  const embedded = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(s); // trailing dotted IPv4, e.g. 64:ff9b::1.2.3.4
  if (embedded) {
    const o = embedded[2].split('.').map(Number);
    tail = [((o[0] << 8) | o[1]).toString(16), ((o[2] << 8) | o[3]).toString(16)];
    s = embedded[1].endsWith('::') ? embedded[1] : embedded[1].slice(0, -1);
  }
  let groups: string[];
  if (s.includes('::')) {
    const [l, r] = s.split('::');
    const left = l ? l.split(':') : [];
    const right = r ? r.split(':') : [];
    groups = [...left, ...Array(8 - tail.length - left.length - right.length).fill('0'), ...right, ...tail];
  } else {
    groups = [...(s ? s.split(':') : []), ...tail];
  }
  return groups.map((g) => parseInt(g, 16).toString(16).padStart(4, '0')).join(':');
}
/** Budget key for the address's network: IPv4 /24 or IPv6 /48 (an IPv6 user typically owns a /64 or more). */
export function subnetOf(normalizedIp: string): string {
  if (net.isIPv4(normalizedIp)) return `v4:${normalizedIp.split('.').slice(0, 3).join('.')}.0/24`;
  if (normalizedIp.includes(':')) return `v6:${normalizedIp.split(':').slice(0, 3).join(':')}::/48`;
  return 'unknown';
}

// ---------------- device cookie ----------------
const DEVICE_RE = new RegExp(`(?:^|;\\s*)${DEVICE_COOKIE.replace(/[-]/g, '\\-')}=([A-Za-z0-9_-]{22})(?=;|$)`);
/** The device id from the Cookie header, or null when absent or not exactly our 22-character format. */
export function readDeviceCookie(cookieHeader: string | undefined): string | null {
  if (!cookieHeader || cookieHeader.length > 8192) return null;
  return DEVICE_RE.exec(cookieHeader)?.[1] ?? null;
}
export const newDeviceId = () => crypto.randomBytes(16).toString('base64url'); // 128 bits, 22 chars
export const deviceCookieHeader = (value: string) => `${DEVICE_COOKIE}=${value}; Max-Age=${DEVICE_COOKIE_MAX_AGE_S}; Path=/; HttpOnly; Secure; SameSite=Lax`;
