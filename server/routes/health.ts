import { youTubeDownloadEnabled } from './youtubeDownload.ts';
import type express from 'express';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Repo } from '../lib/repo.ts';
import type { BodyGuardStats, MemoryBudget, MemoryGuard } from '../lib/requestGuards.ts';

export interface HealthRoutesDeps {
  probeLimit: (maxPerMinute: number) => express.RequestHandler;
  probeLimitPerMin: number;
  isAdmin: (req: express.Request) => boolean;
  healthDetailsToken: string;
  getRepo: () => Repo;
  resolveGeminiApiKey: () => string | undefined;
  hasPexelsKey: () => boolean;
  memoryBudget: MemoryBudget;
  memoryGuard: Pick<MemoryGuard, 'pressured' | 'lastRssMb' | 'trips'>;
  getBodyGuardStats: () => BodyGuardStats;
  headersTimeoutMs: number;
  requestTimeoutMs: number;
  llmMetrics: {
    calls: number;
    successes: number;
    failures: number;
    fallbacksServed: number;
    totalLatencyMs: number;
    promptTokens: number;
    outputTokens: number;
  };
  getRunningRendersCount: () => number;
  instanceId: string;
  dataDir: string;
  mb: number;
  freeDiskBytes: (dir: string) => number | null;
  backupStatus: () => unknown;
  trustProxy: { ok: boolean; description: string };
  proxyDiagnostics: { untrustedForwardedRequests: number };
  guestMintStatus: () => Promise<unknown>;
  getTxRetryCount: () => number;
  readyCacheMs: number;
  checkFfmpeg: () => Promise<boolean>;
  billingMode: 'demo' | 'disabled';
  captcha: { required: boolean; siteKey: string };
}

/**
 * Registers liveness, readiness, diagnostics, and public feature-config endpoints.
 */
export function registerHealthRoutes(app: express.Express, deps: HealthRoutesDeps): void {
  const {
    probeLimit,
    probeLimitPerMin,
    isAdmin,
    healthDetailsToken,
    getRepo,
    resolveGeminiApiKey,
    hasPexelsKey,
    memoryBudget,
    memoryGuard,
    getBodyGuardStats,
    headersTimeoutMs,
    requestTimeoutMs,
    llmMetrics,
    getRunningRendersCount,
    instanceId,
    dataDir,
    mb,
    freeDiskBytes,
    backupStatus,
    trustProxy,
    proxyDiagnostics,
    guestMintStatus,
    getTxRetryCount,
    readyCacheMs,
    checkFfmpeg,
    billingMode,
    captcha,
  } = deps;

  // Liveness: the process is up and serving. No dependencies, no internals.
  const liveness = (_req: express.Request, res: express.Response) => res.json({ status: 'ok' });
  app.get('/api/live', probeLimit(probeLimitPerMin), liveness);
  app.get('/api/health', probeLimit(probeLimitPerMin), liveness);

  function hasDiagnosticsAccess(req: express.Request): boolean {
    if (isAdmin(req)) return true;
    if (!healthDetailsToken) return false;
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    if (!m) return false;
    const a = crypto.createHash('sha256').update(m[1]).digest();
    const b = crypto.createHash('sha256').update(healthDetailsToken).digest();
    return crypto.timingSafeEqual(a, b);
  }

  let readyCache: { at: number; body: { ready: boolean; checks: Record<string, boolean> } } | null = null;
  let readyInFlight: Promise<{ ready: boolean; checks: Record<string, boolean> }> | null = null;
  let readinessComputations = 0;

  async function computeReadiness() {
    readinessComputations++;
    let storage = false;
    try {
      const probe = path.join(dataDir, `.ready-${process.pid}`);
      fs.writeFileSync(probe, 'ok');
      fs.unlinkSync(probe);
      storage = true;
    } catch {
      storage = false;
    }
    const ffmpeg = await checkFfmpeg();
    // Stores every request depends on must be usable (JSON: shared files readable; PostgreSQL: reachable).
    // A single corrupt JSON user shard does not fail readiness.
    const stores = (await getRepo().health()).ok;
    const memory = !memoryGuard.pressured; // Track C: drain this instance under memory pressure
    const ready = storage && ffmpeg && stores && memory;
    return { ready, checks: { storage, ffmpeg, stores, memory } };
  }

  app.get('/api/health/details', probeLimit(60), async (req, res) => {
    // 404, not 401/403: do not advertise that a diagnostics endpoint exists.
    if (!hasDiagnosticsAccess(req)) return res.status(404).json({ error: 'Not found' });
    const mem = process.memoryUsage();
    const repo = getRepo();
    const storeHealth = await repo.health();
    res.json({
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      services: {
        geminiLlm: resolveGeminiApiKey() ? 'ready' : 'fallback-engine',
        pexelsStock: hasPexelsKey() ? 'ready' : 'curated-library',
      },
      system: {
        heapUsedMb: Math.round((mem.heapUsed / 1024 / 1024) * 10) / 10,
        heapTotalMb: Math.round((mem.heapTotal / 1024 / 1024) * 10) / 10,
        rssMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
        memoryGuard: {
          ...memoryBudget,
          pressured: memoryGuard.pressured,
          lastRssMb: Math.round(memoryGuard.lastRssMb * 10) / 10,
          trips: memoryGuard.trips,
        },
      },
      requests: { ...getBodyGuardStats(), headersTimeoutMs, requestTimeoutMs },
      ai: {
        calls: llmMetrics.calls,
        successes: llmMetrics.successes,
        failures: llmMetrics.failures,
        fallbacksServed: llmMetrics.fallbacksServed,
        avgLatencyMs: llmMetrics.successes ? Math.round(llmMetrics.totalLatencyMs / llmMetrics.successes) : null,
        promptTokens: llmMetrics.promptTokens,
        outputTokens: llmMetrics.outputTokens,
      },
      renders: { running: getRunningRendersCount(), instance: instanceId },
      storage: {
        backend: repo.kind,
        ok: storeHealth.ok,
        ...storeHealth.detail,
        freeDiskMb: (() => {
          const f = freeDiskBytes(dataDir);
          return f === null ? null : Math.round(f / mb);
        })(),
      },
      backups:
        repo.kind === 'json'
          ? backupStatus()
          : {
              mode: 'database',
              note: 'PostgreSQL: encrypted off-site backups (scripts/db-backup.ts) and provider PITR; see docs/BACKUP_AND_RECOVERY.md',
            },
      proxy: {
        trust: trustProxy.ok ? trustProxy.description : 'invalid',
        untrustedForwardedRequests: proxyDiagnostics.untrustedForwardedRequests,
      },
      guestMints: await guestMintStatus().catch(() => null),
      database: repo.kind === 'postgres' ? { txRetries: getTxRetryCount() } : undefined,
      readinessComputations,
    });
  });

  // Readiness: storage writable + ffmpeg present. Returns 503 when the instance cannot serve renders/saves.
  app.get('/api/ready', probeLimit(probeLimitPerMin), async (_req, res) => {
    // At most one real check per READY_CACHE_MS per instance, however many probes arrive (R-12).
    if (!readyCache || Date.now() - readyCache.at > readyCacheMs) {
      readyInFlight ||= computeReadiness().finally(() => {
        readyInFlight = null;
      });
      readyCache = { at: Date.now(), body: await readyInFlight };
    }
    const body = readyCache.body;
    res.status(body.ready ? 200 : 503).json(body);
  });

  // Public feature flags only (no model names, provider fingerprints or key details).
  app.get('/api/config', probeLimit(probeLimitPerMin), (_req, res) => {
    res.json({
      features: {
        ai: Boolean(resolveGeminiApiKey()),
        stockFootage: hasPexelsKey(),
        youtubeDownload: youTubeDownloadEnabled(),
        billing: billingMode === 'demo' ? 'demo' : 'disabled',
        // Public site key only; the secret never leaves the server except to Cloudflare's siteverify.
        captcha: captcha.required ? { provider: 'turnstile', siteKey: captcha.siteKey } : null,
      },
    });
  });
}

