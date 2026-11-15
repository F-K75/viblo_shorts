import type express from 'express';
import type { AuthService } from '../lib/auth.ts';
import {
  CaptchaUnavailableError,
  deviceCookieHeader,
  newDeviceId,
  normalizeIp,
  readDeviceCookie,
  sha256Hex,
  subnetOf,
  type CaptchaVerifier,
} from '../lib/guestProtection.ts';
import type { Repo } from '../lib/repo.ts';

export interface AuthRoutesDeps {
  rateLimit: (group: string, maxPerMinute: number, opts?: { ai?: boolean }) => express.RequestHandler;
  getRepo: () => Repo;
  authService: AuthService;
  uid: (req: express.Request) => string;
  isAdmin: (req: express.Request) => boolean;
  clientIp: (req: express.Request) => string;
  currentHour: () => number;
  captchaMaxTokenAgeS: number;
  captchaVerifier: CaptchaVerifier | null;
  alerted: { softHour: number; captchaOutageAt: number };
  refuseGuestMint: (
    res: express.Response,
    status: number,
    code: string,
    error: string,
    extra?: Record<string, unknown>,
    retryAfterS?: number,
  ) => Promise<unknown>;
  guestMintStat: string;
  guestRejectStat: string;
  guestNetworkRefusalStat: string;
  guestMintSoftPerHour: number;
  guestMintHardPerHour: number;
  guestMintPerDevicePerDay: number;
  guestMintPerIpPerHour: number;
  guestMintPerSubnetPerHour: number;
  billingMode: 'demo' | 'disabled';
  plans: Record<string, { dailyQuotaLimit: number; monthlyRenderMinutesLimit: number }>;
  getUserSubscription: (userId: string) => Promise<unknown>;
  newSubscription: (
    plan: 'free' | 'pro' | 'studio',
    demo?: boolean,
  ) => Exclude<Awaited<ReturnType<Repo['getSubscription']>>, null>;
}

/**
 * Registers guest authentication, identity inspection, and subscription routes.
 */
export function registerAuthRoutes(app: express.Express, deps: AuthRoutesDeps): void {
  const {
    rateLimit,
    getRepo,
    authService,
    uid,
    isAdmin,
    clientIp,
    currentHour,
    captchaMaxTokenAgeS,
    captchaVerifier,
    alerted,
    refuseGuestMint,
    guestMintStat,
    guestRejectStat,
    guestNetworkRefusalStat,
    guestMintSoftPerHour,
    guestMintHardPerHour,
    guestMintPerDevicePerDay,
    guestMintPerIpPerHour,
    guestMintPerSubnetPerHour,
    billingMode,
    plans,
    getUserSubscription,
    newSubscription,
  } = deps;

  // Guest registration (Track A). Order: cheap per-IP pre-filter -> single-use redemption -> CAPTCHA verification ->
  // budgets (only verified requests spend them) -> mint. Nothing here touches existing sessions: an outage of the
  // CAPTCHA provider or a spent budget only ever refuses NEW guests; signed-in users never come through this route.
  app.post('/api/auth/guest', rateLimit('auth-guest', 10), async (req, res) => {
    const repo = getRepo();
    const hour = currentHour();
    const ip = normalizeIp(clientIp(req));
    let device = readDeviceCookie(req.headers.cookie);
    if (!device) {
      device = newDeviceId();
      res.setHeader('Set-Cookie', deviceCookieHeader(device));
    }

    if (captchaVerifier) {
      const token = req.body?.['cf-turnstile-response'];
      if (typeof token !== 'string' || token.length === 0 || token.length > 2048) {
        return refuseGuestMint(res, 403, 'captcha_required', 'Please complete the verification to continue as a guest.');
      }
      // Single use on every instance, decided before the provider is asked (a replay never reaches it twice).
      if (!(await repo.redeemOnce(`ts:${sha256Hex(token)}`, (captchaMaxTokenAgeS + 60) * 1000))) {
        return refuseGuestMint(res, 403, 'captcha_replayed', 'This verification was already used. Please verify again.');
      }
      let verdict: Awaited<ReturnType<CaptchaVerifier['verify']>>;
      try {
        verdict = await captchaVerifier.verify(token, ip === 'unknown' ? undefined : ip);
      } catch (err) {
        if (!(err instanceof CaptchaUnavailableError)) throw err;
        if (Date.now() - alerted.captchaOutageAt > 60000) {
          alerted.captchaOutageAt = Date.now();
          console.error(
            JSON.stringify({
              level: 'error',
              event: 'captcha_provider_unavailable',
              reason: err.reason,
              note: 'New guest registrations are paused; existing sessions and signed-in users are unaffected.',
            }),
          );
        }
        return refuseGuestMint(
          res,
          503,
          'captcha_unavailable',
          'Guest sign-up is temporarily unavailable. Please try again shortly, or sign in to continue.',
          {},
          30,
        );
      }
      if (!verdict.ok) {
        return refuseGuestMint(res, 403, 'captcha_failed', 'Verification failed. Please try again.', { reason: verdict.reason });
      }
    }

    // Budgets (all instances). Above the soft threshold, per-IP and per-subnet budgets are halved (never below 1).
    const mintedThisHour = (await repo.statSeries(guestMintStat, hour))[0]?.count ?? 0;
    const tighten = mintedThisHour >= guestMintSoftPerHour ? 2 : 1;
    const dayWindow = Math.floor(hour / 24) * 24; // hour-aligned id, so the 48 h window sweep never cuts a day short
    const entries = [
      { key: `gm:dev:${sha256Hex(device)}`, windowId: dayWindow, limit: guestMintPerDevicePerDay },
      { key: `gm:ip:${ip}`, windowId: hour, limit: Math.max(1, Math.floor(guestMintPerIpPerHour / tighten)) },
      { key: `gm:net:${subnetOf(ip)}`, windowId: hour, limit: Math.max(1, Math.floor(guestMintPerSubnetPerHour / tighten)) },
      ...(guestMintHardPerHour ? [{ key: 'gm:hard', windowId: hour, limit: guestMintHardPerHour }] : []),
    ];
    const taken = await repo.takeWindows(entries);
    if (!taken.ok) {
      const untilNextHour = 3600 - Math.floor((Date.now() % 3600000) / 1000);
      if (taken.key === 'gm:hard') {
        console.error(JSON.stringify({ level: 'error', event: 'guest_mint_hard_ceiling', perHour: guestMintHardPerHour }));
        return refuseGuestMint(
          res,
          429,
          'guest_capacity',
          'Guest sign-ups are paused because of unusually high demand. Please sign in (free) to continue.',
          {},
          untilNextHour,
        );
      }
      const scope = taken.key.startsWith('gm:dev:') ? 'device' : taken.key.startsWith('gm:ip:') ? 'ip' : 'subnet';
      const retry =
        scope === 'device' ? (dayWindow + 24 - hour) * 3600 - Math.floor((Date.now() % 3600000) / 1000) : untilNextHour;
      // Every request here already passed the CAPTCHA: an IP or subnet refusal is shared-network impact, recorded apart.
      await Promise.all([
        repo.recordStat(guestRejectStat + `guest_rate_limited:${scope}`, hour).catch(() => {}),
        scope !== 'device' ? repo.recordStat(guestNetworkRefusalStat, hour).catch(() => {}) : null,
      ]);
      res.setHeader('Retry-After', String(retry));
      return res.status(429).json({
        error: 'Too many guest sessions were started from here recently. Please try again later, or sign in to continue.',
        code: 'guest_rate_limited',
        scope,
      });
    }

    const issued = authService.issueGuestToken();
    const count = await repo.recordStat(guestMintStat, hour).catch(() => 0);
    if (count >= guestMintSoftPerHour && alerted.softHour !== hour) {
      alerted.softHour = hour;
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'guest_mint_soft_threshold',
          perHour: guestMintSoftPerHour,
          thisHour: count,
          note: 'Per-IP and per-subnet guest budgets are halved for the rest of this hour. Verified sign-ups are not rejected.',
        }),
      );
    }
    res.json({ success: true, token: issued.token, userId: issued.userId, expiresAt: issued.expiresAt });
  });

  app.get('/api/auth/me', rateLimit('auth-me', 60), (req, res) => {
    res.json({ success: true, userId: uid(req), kind: req.identity!.kind, isAdmin: isAdmin(req) });
  });

  app.get('/api/user/subscription', rateLimit('subscription', 60), async (req, res) => {
    res.json({ success: true, subscription: await getUserSubscription(uid(req)), billingMode });
  });

  app.post('/api/user/subscription/upgrade', rateLimit('subscription-upgrade', 10), async (req, res) => {
    const plan = req.body?.plan;
    if (typeof plan !== 'string' || !(plan in plans)) {
      return res.status(400).json({ error: `Unknown plan. Valid plans: ${Object.keys(plans).join(', ')}` });
    }
    if (billingMode !== 'demo') {
      // No payment provider is integrated. Granting paid plans without payment would be a revenue/abuse hole.
      return res.status(501).json({
        error: 'Online payments are not available yet. Plan changes are disabled on this server.',
        billingConfigured: false,
      });
    }
    const sub = newSubscription(plan as 'free' | 'pro' | 'studio', true);
    await getRepo().putSubscription(uid(req), {
      plan: sub.plan,
      status: 'active',
      monthlyRenderMinutesUsed: 0,
      currentPeriodEnd: sub.currentPeriodEnd,
      demo: true,
    });
    res.json({ success: true, subscription: sub, demo: true });
  });
}

